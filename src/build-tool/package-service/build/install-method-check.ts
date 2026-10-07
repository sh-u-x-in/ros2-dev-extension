// Licensed under the MIT License.

/**
 * @file install-method-check.ts(2026-09-22 新增;同日按用户裁定两次简化后定稿)
 * 构建前【安装形态(实体 copy / 符号 symlink)检查】:读磁盘事实 → 查表 → 产出
 *  ① 是否要自动加 `--cmake-clean-cache`(`cleanCache`)
 *  ② 需要提示用户的文案(`warning`,含"该删哪个目录")
 * **只产出结论,不弹窗、不阻塞、零 vscode 依赖**(可无头单测);弹窗由 `preflight-warnings.ts` 负责。
 *
 * ── 判据分工:**每个方向只用它的权威信号** ──────────────────────────
 * | 本次方向 | 权威信号 | 判什么 |
 * |:--|:--|:--|
 * | **符号** | **build 落点 lstat** | 落点是实体目录 → `create_symlink` 删不掉目录 → **退出码 2**(失败发生在 build 侧) |
 * | **实体** | **install 侧:ament_index 探针(唯一一条)** | 探针是软链 → `file(INSTALL)` 判 Up-to-date 跳过 → **静默无效**(无效发生在 install 侧) |
 * | (两向) 配置换向 | `CMakeCache.txt` 的 `AMENT_CMAKE_SYMLINK_INSTALL` | ≠ 本次形态 → 自动 `--cmake-clean-cache`(option 粘性,不删缓存翻不过来) |
 *
 * ⚠️ **不要把 CMakeCache 当"install 的现状"**:cache 只代表 **build 侧配置**,而 build 先于 install——
 * 实测可以稳定构造「cache=`OFF`(说实体)+ build 落点=实体目录 + install 侧仍是 65 条软链」
 * (符号构建 → 实体+clean-cache → 删落点再实体构建),拿 cache 判"一致/无事"会漏掉正在发生的静默无效。
 *
 * ── install 侧探针:**只有一条**(用户裁定,2026-09-22) ─────────────────
 * ```
 * <prefix>/share/ament_index/resource_index/packages/<pkg>
 *   软链      → symlink(本次实体 ⇒ 会静默无效)
 *   常规文件  → copy(本次实体 ⇒ 正常)
 *   不存在    → unknown(放行,宁漏不错;不做任何扫描,也不试其它资源项)
 * ```
 * `<prefix>`:isolated = `install/<pkg>`,merged = `install`(文件名带包名,两种布局都精确,**merged 不再是盲区**)。
 * 成本:1 次 `lstat` ≈ 0.0025 ms(VM 实测),与构建(1.4–6 s)差 6 个数量级。
 *
 * **为什么只留这一条**(证据见 `知识/安装形态切换六格矩阵-实测-2026-09-22.md` §2.5):
 *  · `packages` 是**唯一普适**项:ament_cmake 系(含 rosidl)由 `ament_package()` 的扩展钩子
 *    `ament_cmake_core/cmake/index/ament_cmake_index_package_hook.cmake:16` → `ament_index_register_package()`
 *    写入(先写 `build/<pkg>/ament_cmake_index/…` 再 `install()` 落盘,符号模式下被覆写成软链);
 *    ament_python 系由**包自己的 `setup.py` 的 `data_files`** 写入(实测 `iii/setup.py:83`,标准模板自带);
 *  · `package_run_dependencies` / `parent_prefix_path` 与它**同源**、且彼此**同生共死**(8 包 × 2 形态实测:
 *    ament_cmake 系三个都在,ament_python / 纯 CMake 三个都无),自由度相同 ⇒ 挂第二条永远不可能被命中,去掉;
 *  · **不保留"兜底扫描"**:其前提是"install 侧内容未被人工改动",而这前提一旦不成立,连软链都可以被全删——
 *    任何基于残留痕迹的判断都会失效。故明确采用假设:**install/ 不由人工局部篡改**(用户裁定)。
 *
 * **残留漏判(明确接受)**:探针缺失时不提示。会走到这里的只有两类**设计使然**的缺失(非篡改):
 *  ① 纯 CMake 包(不调 `ament_package()` → 无 ament 索引;且 `--symlink-install` 对它本来就不起作用,形态概念不适用);
 *  ② 手写/裁剪过的 `setup.py` 未注册 `packages` 的 ament_python 包(极罕见,标准模板自带)。
 */

import { l10n } from "vscode";

import * as fs from "fs";
import * as path from "path";

import { getLogger } from "../../../logger";
import type { ColconInstallLayout, ColconInstallMethod, ColconInstallType } from "../../../ros2/api";

/** install-method-check 模块日志 */
const log = getLogger("install-method-check");

/** CMakeCache 里的形态键 */
const SYMLINK_CACHE_KEY = "AMENT_CMAKE_SYMLINK_INSTALL:";

/** build 落点候选(ament_cmake_python 包 / ament_python 包) */
function landingCandidates(workspaceRoot: string, pkg: string): string[] {
    return [
        path.join(workspaceRoot, "build", pkg, "ament_cmake_python", pkg, pkg),
        path.join(workspaceRoot, "build", pkg, pkg),
    ];
}

/** 一个包的形态事实(读不到就是 undefined,绝不猜) */
export interface InstallMethodFacts {
    package: string;
    /** 配置形态(CMakeCache;无文件/无该行 → undefined),**只用于决定是否自动清缓存** */
    configured?: ColconInstallMethod;
    /** build 落点现状(符号方向:是否硬冲突) */
    landing: "link" | "directory" | "missing";
    /** install 侧形态(**本次要实体时**才探测;探针缺失 → unknown) */
    payload?: "symlink" | "copy" | "unknown";
}

/** 检查结论 */
export interface InstallMethodPlan {
    /** 是否需要给本次构建加 `--cmake-clean-cache` */
    cleanCache: boolean;
    /** 会硬失败(退出码 2)的包 */
    conflicts: string[];
    /** 会静默无效(退出码 0 但产物不变)的包 */
    silentNoop: string[];
    /** 文案所属类别(供通知层做类别级开关/静音);无文案 → null */
    warningKind: "conflict" | "silent-noop" | null;
    /** 给用户看的文案(无事 → null) */
    warning: string | null;
}

/** 解析 CMakeCache 的布尔值(ON/1/TRUE/YES = 符号;OFF/0/FALSE/NO = 实体;其它/缺行 → undefined) */
function parseCacheBool(text: string): ColconInstallMethod | undefined {
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(SYMLINK_CACHE_KEY)) {
            continue;
        }
        const value = (line.slice(line.indexOf("=") + 1) || "").trim().toUpperCase();
        if (["1", "ON", "TRUE", "YES", "Y"].includes(value)) {
            return "symlink";
        }
        if (["0", "OFF", "FALSE", "NO", "N", ""].includes(value)) {
            return "copy";
        }
        return undefined;
    }
    return undefined;
}

/**
 * 读配置形态(CMakeCache.txt 的 `AMENT_CMAKE_SYMLINK_INSTALL`)。
 * 文件不存在 / 无该行 / 值非法 → undefined(不参与判定;只影响"要不要清缓存")。
 */
export async function readConfiguredMethod(workspaceRoot: string, pkg: string): Promise<ColconInstallMethod | undefined> {
    const cachePath = path.join(workspaceRoot, "build", pkg, "CMakeCache.txt");
    try {
        const parsed = parseCacheBool(await fs.promises.readFile(cachePath, "utf8"));
        if (parsed === undefined) {
            log.trace(l10n.t("CMakeCache has no {0} line (not an ament package?) -> excluded from checks: {1}", SYMLINK_CACHE_KEY, cachePath));
        }
        return parsed;
    } catch {
        log.trace(l10n.t("CMakeCache missing/unreadable -> excluded from checks: {0}", cachePath));
        return undefined;
    }
}

/** build 落点现状(任一候选是实体目录 → directory;否则任一为链接 → link;都没有 → missing) */
export async function inspectLanding(workspaceRoot: string, pkg: string): Promise<InstallMethodFacts["landing"]> {
    let sawLink = false;
    for (const candidate of landingCandidates(workspaceRoot, pkg)) {
        try {
            const st = await fs.promises.lstat(candidate);
            if (st.isSymbolicLink()) {
                sawLink = true;
            } else if (st.isDirectory()) {
                return "directory";
            }
        } catch {
            // 该候选不存在,继续看下一个
        }
    }
    return sawLink ? "link" : "missing";
}

/** install 侧前缀(布局决定:isolated = `install/<pkg>`;merged = `install`) */
export function installPrefix(workspaceRoot: string, pkg: string, layout: ColconInstallLayout): string {
    return layout === "merged" ? path.join(workspaceRoot, "install") : path.join(workspaceRoot, "install", pkg);
}

/**
 * install 侧形态(唯一探针):`<prefix>/share/ament_index/resource_index/packages/<pkg>`
 *  · 软链 ⇒ `symlink`(本次实体 ⇒ 会静默无效)
 *  · 常规文件 ⇒ `copy`
 *  · 不存在 ⇒ `unknown`(放行;见文件头"残留漏判")
 */
export async function inspectInstallPayload(
    workspaceRoot: string,
    pkg: string,
    layout: ColconInstallLayout,
): Promise<InstallMethodFacts["payload"]> {
    const marker = path.join(
        installPrefix(workspaceRoot, pkg, layout), "share", "ament_index", "resource_index", "packages", pkg);
    try {
        const st = await fs.promises.lstat(marker);
        const mode = st.isSymbolicLink() ? "symlink" : "copy";
        log.trace(l10n.t("ament_index probe resolved install method as {0}: {1}", mode, marker));
        return mode;
    } catch {
        log.debug(l10n.t("No ament_index probe (pure CMake package / setup.py not registered / install not built) -> unknown (allowed): {0}", marker));
        return "unknown";
    }
}

/** 收集一个包的事实:配置形态 + build 落点;**仅本次要实体时**再探测 install 侧 */
export async function inspectPackage(
    workspaceRoot: string,
    pkg: string,
    installType: ColconInstallType,
): Promise<InstallMethodFacts> {
    const configured = await readConfiguredMethod(workspaceRoot, pkg);
    const landing = await inspectLanding(workspaceRoot, pkg);
    const payload = installType.method === "copy"
        ? await inspectInstallPayload(workspaceRoot, pkg, installType.layout)
        : undefined;
    return { package: pkg, configured, landing, payload };
}

/**
 * 查表(纯函数):**每个方向只用它的权威信号**
 *  · conflicts(本次符号,必失败):build 落点是实体目录;
 *  · silentNoop(本次实体,静默无效):install 侧探针为软链;
 *  · cleanCache:CMakeCache 形态 ≠ 本次形态。
 */
export function decideInstallMethod(
    facts: readonly InstallMethodFacts[],
    method: ColconInstallMethod,
): Pick<InstallMethodPlan, "cleanCache" | "conflicts" | "silentNoop"> {
    const conflicts: string[] = [];
    const silentNoop: string[] = [];
    let cleanCache = false;

    for (const f of facts) {
        if (f.configured !== undefined && f.configured !== method) {
            cleanCache = true;
        }
        if (method === "symlink") {
            if (f.landing === "directory") {
                conflicts.push(f.package);   // 与 cache 是否一致无关
            }
        } else if (f.payload === "symlink") {
            silentNoop.push(f.package);      // 探针缺失/unknown → 放行(宁漏不错)
        }
    }
    return { cleanCache, conflicts, silentNoop };
}

/** 把结论拼成给用户的一段话(纯函数;无事 → null) */
export function buildInstallMethodWarning(
    plan: Pick<InstallMethodPlan, "cleanCache" | "conflicts" | "silentNoop">,
    method: ColconInstallMethod,
): string | null {
    const parts: string[] = [];
    if (plan.conflicts.length > 0) {
        parts.push(
            l10n.t("⚠️ Install method conflict (this build will fail): you selected {0}, but these packages' build outputs are already real directories: {1}. colcon will fail with exit code 2 while linking. Delete the corresponding build/<package> directories first, or set ROS2.build.installMethod to match the current state.",
                method === "symlink" ? l10n.t("symlink install") : l10n.t("copy install"),
                plan.conflicts.join(","))
        );
    }
    if (plan.silentNoop.length > 0) {
        parts.push(
            l10n.t("⚠️ Install method switch will not take effect (build not blocked): this is a copy install, but these packages are currently symlinks: {0}. The build succeeds, but install/ stays symlinked (copy follows links; CMake sees Up-to-date and skips). To really switch to copy install, delete install/<package> and rebuild (build/ need not be deleted: with install/ gone the copy writes real files; if a config flip is needed, --cmake-clean-cache is added automatically this time).",
                plan.silentNoop.join(","))
        );
    }
    if (parts.length === 0) {
        return null;
    }
    if (plan.cleanCache) {
        parts.push(l10n.t("(this run automatically appends --cmake-clean-cache: some packages' CMake config method differs from this run)"));
    }
    return parts.join("\n");
}

/**
 * 构建前形态检查(唯一入口):读磁盘 → 查表 → 返回 `{ cleanCache, warning }`。
 * 调用方:① 用 `cleanCache` 作为 `ColconBuildOptions.clean`;② 把 `warning` 交给 `showPreflightWarning`。
 * 任何异常都不抛出(调用方必须能照常构建)。
 */
export async function checkInstallMethod(
    workspaceRoot: string,
    packages: readonly string[],
    installType: ColconInstallType,
): Promise<InstallMethodPlan> {
    const empty: InstallMethodPlan = {
        cleanCache: false, conflicts: [], silentNoop: [], warningKind: null, warning: null,
    };
    if (packages.length === 0) {
        return empty;
    }
    try {
        const facts = await Promise.all(packages.map((p) => inspectPackage(workspaceRoot, p, installType)));
        const decided = decideInstallMethod(facts, installType.method);
        const warning = buildInstallMethodWarning(decided, installType.method);
        // 两条互斥(同一 method 只会填一组),故文案类别唯一
        const warningKind: InstallMethodPlan["warningKind"] =
            warning === null ? null : (decided.conflicts.length > 0 ? "conflict" : "silent-noop");
        if (decided.cleanCache || warning) {
            log.info(
                l10n.t("Install method check (this run={0})", installType.method === "symlink" ? l10n.t("symlink install") : l10n.t("copy install"))
                + l10n.t(":{0}", decided.cleanCache ? l10n.t("will append --cmake-clean-cache automatically") : l10n.t("no cache clear needed"))
                + l10n.t("; hard conflicts={0}; silent no-ops={1}", decided.conflicts.join(",") || l10n.t("none"), decided.silentNoop.join(",") || l10n.t("none")),
            );
        } else {
            log.trace(l10n.t("Method check (this run={0}): no conflicts, no cache clear needed ({1} packages)", installType.method, packages.length));
        }
        return { ...decided, warningKind, warning };
    } catch (err) {
        log.warn(l10n.t("Method check error (ignored, build not blocked): {0}", err instanceof Error ? err.message : String(err)));
        return empty;
    }
}
