/**
 * @file scan/installed.ts
 * 安装内容解算(两源之一 `install/` = **观察**)→ 三区 `lib` / `import` / `share` + `include`。
 *
 * ## 定位(2026-09-21,用户裁定;README §1/§2)
 *
 * 本域只反映**真实**,不反映**意图**;域外(`src/`)的存在性一律不判。
 * 职责 = 「在 `build/`、`install/` 当中**解算出内容,呈现出来**」,所以:
 *   · **内容以 install 侧观察为准**(`readdir` + `stat` 走一遍);
 *   · build 侧的**清单 / 安装规则**只用来**对账**(`agreement`)与**给源落点**(`sourcePath`);
 *   · truth 层给**全集 + 标记**,过滤(隐藏生成物、隐藏库)下沉到消费方(README §2.1 第 3 条);
 *   · **例外(2026-09-25 用户裁定"务必使用黑名单文件夹排除")**:`__pycache__` / `*.egg-info`
 *     在扫描层**硬排除**(见 `AREA_SKIP_DIRS`)—— 纯噪音,连标记带行一起不进真值。
 *
 * ## 为什么"遍历 install 侧"就能如实呈现"扩大"
 *
 * develop 模式下 `install/<pkg>/lib/python3.x/site-packages/<pkg>` 本身就是一条指向
 * `build/<pkg>/<pkg>`(再指向 `src/<pkg>/<pkg>`)的软链。遍历它 → 访问路径在 `install/` 下
 * → **合法**(README §2.2「域包含性」),而带出来的文件就是**事实**:源码目录里有什么,
 * import 面就有什么。`agreement === "observed"` 档记录的就是这类"记录里没有、实际存在"的东西。
 *
 * 纯 TS,零依赖,可无头测试。
 */

import { l10n } from "vscode";

import { FsLike, isDir } from "../shared/fs/primitives";
import { AreaFile, AreaName, BuildPackage, InstallRule, JumpEntry, PackageAreas } from "../shared/models";
import { pbasename, pdirname, pjoin, pnormalize, prelative } from "../shared/paths";
import { BuildContext } from "./build-root";
import { collectInstallRules } from "./install-rules";
import { readManifests } from "./manifests";

/** install 根 = build 根的兄弟目录 */
export function installRootOf(ctx: BuildContext): string {
    return pjoin(pdirname(ctx.buildRoot), "install");
}

/**
 * 读安装布局标记(`install/.colcon_install_layout`)—— 这是**只有 install/ 才有的
 * workspace-level 事实**(见 README §1.2 ①)。缺失时按目录观察判定:有 `install/<pkg>` = isolated,
 * 有 `install/lib` 或 `install/share` = merged;都没有 → `unknown`。
 */
export async function readInstallLayout(
    fs: FsLike,
    installRoot: string,
    pkg?: string
): Promise<"isolated" | "merged" | "unknown"> {
    const text = await fs.readText(pjoin(installRoot, ".colcon_install_layout"));
    const v = (text ?? "").trim();
    if (v === "isolated" || v === "merged") {
        return v;
    }
    if (pkg !== undefined) {
        if (await isDir(fs, pjoin(installRoot, pkg))) {
            return "isolated";
        }
        if ((await isDir(fs, pjoin(installRoot, "lib"))) || (await isDir(fs, pjoin(installRoot, "share")))) {
            return "merged";
        }
    }
    return "unknown";
}

/** 包的安装前缀(isolated = `install/<pkg>`;merged = `install`;unknown 按 isolated 试) */
function prefixOf(installRoot: string, pkg: string, layout: string): string {
    return layout === "merged" ? installRoot : pjoin(installRoot, pkg);
}

/**
 * 区遍历时的目录黑名单(**硬排除**,2026-09-25 用户裁定"务必使用黑名单文件夹排除"):
 * `__pycache__` / `*.egg-info` 一律不进入真值行集(此前口径是"照实列出 + 打 generated 标记",
 * 实测侧边栏里 `__pycache__/*.pyc`、egg-info 全是噪音,故改为扫描层直接排除)。
 * `isConventionGenerated` 的约定分支保留,防御 manifest-only 反向对账路径仍带回这类行。
 */
const AREA_SKIP_DIRS = [".git", "node_modules", ".cache", ".pytest_cache", "__pycache__"];

/** 目录段黑名单(按名字后缀;`*.egg-info` 是打包元数据目录,同批裁定排除) */
function isSkippedDirName(name: string): boolean {
    return AREA_SKIP_DIRS.indexOf(name) >= 0 || name.endsWith(".egg-info");
}

/** 约定性生成物的一级目录(仅 share 区) */
const GENERATED_TOP_DIRS = new Set(["hook", "environment", "cmake"]);

/** 约定性生成物的文件名(仅 share 区) */
const GENERATED_FILE_RE = /^(package\.(bash|sh|zsh|ps1|dsv|xml)|local_setup\..*)$/;

/**
 * 约定性生成物判定(**标记,不过滤**):`__pycache__` / `*.egg-info` /
 * `share/<pkg>/{hook,environment,cmake}/**` / `share/<pkg>/package.*` / `local_setup.*`。
 */
export function isConventionGenerated(area: AreaName, relPath: string): boolean {
    const segs = relPath.split("/");
    if (segs.indexOf("__pycache__") >= 0) {
        return true;
    }
    if (segs.some((s) => s.endsWith(".egg-info"))) {
        return true;
    }
    if (area !== "share") {
        return false;
    }
    if (GENERATED_TOP_DIRS.has(segs[0])) {
        return true;
    }
    return GENERATED_FILE_RE.test(segs[segs.length - 1]);
}

/** 名字形状判定为库(不依赖 +x —— `FsLike` 没有权限位) */
export function looksLikeLibrary(name: string): boolean {
    return /(\.so(\.\d+)*|\.a)$/.test(name);
}

/**
 * DIRECTORY 规则选源 —— 按 `rest` 的**首段**精确挑源(挑不到返回 `undefined`,由调用方决定兜底)。
 *
 * 真机反例(2026-09-21,p10_mix_deps_std):CMake 为 `launch` / `config` / `urdf` 各写一条
 * DIRECTORY 规则,而它们**共用同一个 dest** `share/<pkg>`。若"先匹配先赢 + 兜底",
 * 第一条(`launch`)的兜底会把 `config/`、`urdf/` 的文件全挂到 `launch/` 上 →
 * `share/p10/config/extra/deep.yaml` 被映射成 `src/p10/launch/config/extra/deep.yaml`(多一层)。
 * 故必须**先全局找首段精确匹配,再退兜底**(见 `sourceFromRules`)。
 */
export function pickDirSource(sources: string[], rest: string): string | undefined {
    if (rest === "") {
        return sources.length === 0 ? undefined : sources[0];
    }
    const head = rest.split("/")[0];
    for (const s of sources) {
        const clean = s.replace(/\/+$/, "");
        if (pbasename(clean) === head) {
            // 源本身就是要拷的那个目录 → 拿它的**父目录** + 完整相对路径
            return pjoin(pdirname(clean), rest);
        }
    }
    return undefined;
}

/**
 * 安装规则 → 源(**只做字符串匹配,不判存在性**;README §2.2)。
 *   FILES:      `<dest>/<源 basename>` 精确命中
 *   DIRECTORY:  `<dest>/<剩余路径>` 前缀命中;**两遍** —— 先找首段精确匹配,再退兜底
 */
export function sourceFromRules(rules: InstallRule[], rel: string): string | undefined {
    return sourceFromRulesRef(rules, rel)?.path;
}

/**
 * `sourceFromRules` 的**带来源版**(2026-09-25 第五批:悬浮栏"内容来源"可逆搜索):
 * 返回命中的源路径与**规则所在文件名**(`from` = `cmake_install.cmake` /
 * `ament_cmake_symlink_install.cmake`),用户可到 build/<pkg>/ 下按文件反查规则原文。
 */
export function sourceFromRulesRef(rules: InstallRule[], rel: string): { path: string; from: string } | undefined {
    let fallback: { path: string; from: string } | undefined;
    for (const r of rules) {
        const dest = r.dest.replace(/\/+$/, "");
        if (r.kind === "FILES") {
            for (const s of r.sources) {
                if (`${dest}/${pbasename(s)}` === rel) {
                    return { path: s, from: r.from };
                }
            }
            continue;
        }
        if (!(rel === dest || rel.startsWith(dest + "/"))) {
            continue;
        }
        const rest = rel === dest ? "" : rel.slice(dest.length + 1);
        const exact = pickDirSource(r.sources, rest);
        if (exact !== undefined) {
            return { path: exact, from: r.from }; // 首段精确匹配直接胜出(不被其它规则的兜底抢走)
        }
        if (fallback === undefined && r.sources.length > 0) {
            // 兜底:`install(DIRECTORY include/ DESTINATION …)` 这类"拷目录内容"的写法
            fallback = { path: pjoin(r.sources[0], rest), from: r.from };
        }
    }
    return fallback;
}

/** 前缀相对路径 → 区 + 区内相对路径(展示用) */
export function classifyPrefixRel(pkg: string, rel: string): { area: AreaName; relPath: string } | undefined {
    const segs = rel.split("/").filter((s) => s !== "");
    if (segs[0] === "lib" && segs[1] === pkg && segs.length > 2) {
        return { area: "lib", relPath: segs.slice(2).join("/") };
    }
    if (segs[0] === "bin" && segs.length > 1) {
        return { area: "lib", relPath: segs.slice(1).join("/") };
    }
    const i = segs.indexOf("site-packages") >= 0 ? segs.indexOf("site-packages") : segs.indexOf("dist-packages");
    if (i >= 0 && segs[i + 1] === pkg && segs.length > i + 2) {
        return { area: "import", relPath: segs.slice(i + 2).join("/") };
    }
    if (segs[0] === "share" && segs[1] === pkg && segs.length > 2) {
        return { area: "share", relPath: segs.slice(2).join("/") };
    }
    if (segs[0] === "include" && segs[1] === pkg && segs.length > 2) {
        return { area: "include", relPath: segs.slice(2).join("/") };
    }
    return undefined;
}

/** 该前缀下的全部 python 站点目录(**观察两种形状**:site-packages / dist-packages) */
async function pythonSiteRoots(fs: FsLike, prefix: string): Promise<string[]> {
    const out: string[] = [];
    const combos: Array<[string, string]> = [
        ["lib", "site-packages"],
        ["local/lib", "dist-packages"],
    ];
    for (const combo of combos) {
        const base = pjoin(prefix, combo[0]);
        const names = await fs.readdir(base);
        if (names === undefined) {
            continue;
        }
        for (const n of names.slice().sort()) {
            if (!/^python\d/.test(n)) {
                continue;
            }
            const site = pjoin(base, n, combo[1]);
            if (await isDir(fs, site)) {
                out.push(site);
            }
        }
    }
    return out;
}

/** 观察到的原始条目(尚未对账) */
interface RawFile {
    /** 前缀相对路径(与清单/规则对齐用) */
    relToPrefix: string;
    /** 区内相对路径(展示用) */
    relPath: string;
    /** 绝对落点 */
    installPath: string;
    area: AreaName;
    /** lstat:该落点本身是软链 */
    link: boolean;
    /** 软链目标(原样字符串) */
    linkTarget?: string;
    /** 软链目标不可访问(悬空) */
    dangling: boolean;
    /** 该落点是**经哪条上游目录软链**进来的(子文件自身不是软链) */
    viaLinkPath?: string;
    viaLinkTarget?: string;
}

/** 一次遍历的产物 */
interface Walked {
    path: string;
    relToDir: string;
    link: boolean;
    linkTarget?: string;
    dangling: boolean;
    viaLinkPath?: string;
    viaLinkTarget?: string;
}

/**
 * **软链感知**的目录遍历(甲-1 的核心,2026-09-21):
 *
 *   · 用 `lstat` 枚举 → 软链本身可见,**悬空链也能看见**
 *     (`walkFiles` 走 `stat`,悬空链会被静默跳过 → 伪装成"一切正常");
 *   · 软链指向目录时**继续深入** —— 这正是 develop 模式"扩大"的通道,README §2.2 判为**合法**
 *     (访问路径在 install 下,带出来的内容是 install 的事实);
 *   · `maxDepth` 防环。
 */
async function walkArea(fs: FsLike, root: string, maxDepth = 24): Promise<Walked[]> {
    const out: Walked[] = [];
    /** 上游目录软链(最近的;用于表达"这份内容是从哪进来的") */
    const walk = async (
        dir: string,
        base: string,
        depth: number,
        via?: { path: string; target: string }
    ): Promise<void> => {
        if (depth > maxDepth) {
            return;
        }
        const names = await fs.readdir(dir);
        if (names === undefined) {
            return;
        }
        for (const name of names.slice().sort()) {
            if (isSkippedDirName(name)) {
                continue; // 黑名单(目录级):__pycache__ / *.egg-info 等不进入行集(2026-09-25 裁定)
            }
            const p = pjoin(dir, name);
            const rel = base === "" ? name : `${base}/${name}`;
            const ls = await fs.lstat(p);
            if (ls === undefined) {
                continue;
            }
            if (ls.kind === "dir") {
                await walk(p, rel, depth + 1, via);
                continue;
            }
            if (ls.kind === "link") {
                const target = await fs.readlink(p);
                const st = await fs.stat(p); // 跟随一步
                if (st === undefined) {
                    out.push({
                        path: p,
                        relToDir: rel,
                        link: true,
                        linkTarget: target,
                        dangling: true,
                        viaLinkPath: via?.path,
                        viaLinkTarget: via?.target,
                    });
                } else if (st.kind === "dir") {
                    // 目录软链 → 深入(develop 模式"扩大"的通道);把它记成**上游**
                    await walk(p, rel, depth + 1, { path: p, target: target ?? "" });
                } else {
                    out.push({
                        path: p,
                        relToDir: rel,
                        link: true,
                        linkTarget: target,
                        dangling: false,
                        viaLinkPath: via?.path,
                        viaLinkTarget: via?.target,
                    });
                }
                continue;
            }
            if (ls.kind === "file") {
                out.push({
                    path: p,
                    relToDir: rel,
                    link: false,
                    dangling: false,
                    viaLinkPath: via?.path,
                    viaLinkTarget: via?.target,
                });
            }
        }
    };
    // 根自身就可能是那条软链(develop 模式下 `site-packages/<pkg> -> build/<pkg>/<pkg>`)
    const rootLs = await fs.lstat(root);
    const rootVia =
        rootLs !== undefined && rootLs.kind === "link"
            ? { path: root, target: (await fs.readlink(root)) ?? "" }
            : undefined;
    await walk(root, "", 0, rootVia);
    return out;
}

/** 递归收集一个目录下的全部文件(带区归属 + 形态) */
async function collectDir(fs: FsLike, dir: string, prefixRel: string, area: AreaName): Promise<RawFile[]> {
    const found = await walkArea(fs, dir);
    return found.map((w) => ({
        relToPrefix: prefixRel === "" ? w.relToDir : `${prefixRel}/${w.relToDir}`,
        relPath: w.relToDir,
        installPath: w.path,
        area,
        link: w.link,
        linkTarget: w.linkTarget,
        dangling: w.dangling,
        viaLinkPath: w.viaLinkPath,
        viaLinkTarget: w.viaLinkTarget,
    }));
}

/** 只取某目录下的**顶层文件**(不进子目录)—— 用于 `lib/` 根、`bin/` 这类扁平落点 */
async function collectFlatDir(fs: FsLike, dir: string, prefixRel: string, area: AreaName): Promise<RawFile[]> {
    const names = await fs.readdir(dir);
    if (names === undefined) {
        return [];
    }
    const out: RawFile[] = [];
    for (const n of names.slice().sort()) {
        const p = pjoin(dir, n);
        const ls = await fs.lstat(p);
        if (ls === undefined) {
            continue;
        }
        const link = ls.kind === "link";
        const linkTarget = link ? await fs.readlink(p) : undefined;
        const followed = link ? await fs.stat(p) : ls;
        if (followed === undefined) {
            // 悬空链:仍是真实落点,照实收(否则"装了但指向已消失"完全不可见)
            out.push({ relToPrefix: `${prefixRel}/${n}`, relPath: n, installPath: p, area, link, linkTarget, dangling: true });
            continue;
        }
        if (followed.kind !== "file") {
            continue; // 目录(含软链指向目录)→ `lib/cmake/**` 不属于四区
        }
        out.push({ relToPrefix: `${prefixRel}/${n}`, relPath: n, installPath: p, area, link, linkTarget, dangling: false });
    }
    return out;
}

/** 软链目标归属(由**目标前缀**判定;目标是相对路径时按链所在目录解析) */
function domainOf(ctx: BuildContext, linkPath: string, target: string): "src" | "build" | "outside" {
    const abs = target.startsWith("/") ? pnormalize(target) : pjoin(pdirname(linkPath), target);
    if (abs === ctx.buildRoot || abs.startsWith(ctx.buildRoot + "/")) {
        return "build";
    }
    if (abs === ctx.srcRoot || abs.startsWith(ctx.srcRoot + "/")) {
        return "src";
    }
    return "outside";
}

/** 区显示顺序(排序稳定用) */
const AREA_ORDER: Record<AreaName, number> = { lib: 0, import: 1, share: 2, include: 3 };

/** 解算单个包 */
async function collectPackageAreas(
    fs: FsLike,
    ctx: BuildContext,
    pkg: BuildPackage,
    installRoot: string,
    jumps: Map<string, JumpEntry[]> | undefined,
    warnings: string[]
): Promise<PackageAreas> {
    const layout = await readInstallLayout(fs, installRoot, pkg.name);
    const prefix = prefixOf(installRoot, pkg.name, layout);
    // ---- 记录侧**先读**:扁平落点(`lib/` 根、`bin/`)的归属要靠它判定 ----
    const manifests = await readManifests(fs, pkg);
    if (manifests.skipped.length > 0) {
        warnings.push(
            l10n.t("{0}: stale install records ignored ({1}, older than this build's baseline)", pkg.name, manifests.skipped.join(", "))
        );
    }
    const manifestRels = new Set<string>();
    /** rel → 来源记录文件名(2026-09-25 第五批:悬浮栏"内容来源"可逆搜索) */
    const manifestOrigin = new Map<string, string>();
    for (const p of manifests.paths) {
        const rel = prelative(p, prefix);
        if (rel !== undefined && rel !== "") {
            manifestRels.add(rel);
            const origin = manifests.origin.get(p);
            if (origin !== undefined) {
                manifestOrigin.set(rel, origin);
            }
        }
    }
    const rules = await collectInstallRules(fs, pkg);
    const hasEggInfo = await isDir(fs, pjoin(pkg.buildDir, pkg.name + ".egg-info"));
    const pkgJumps = jumps === undefined ? undefined : jumps.get(pkg.name);

    /** 扁平落点是否属于本包:isolated 下天然属于;merged 下必须被记录(清单或规则)提到 */
    const ownsFlat = (rel: string): boolean =>
        layout !== "merged" || manifestRels.has(rel) || sourceFromRules(rules, rel) !== undefined;

    const raws: RawFile[] = [];
    raws.push.apply(raws, await collectDir(fs, pjoin(prefix, "lib", pkg.name), `lib/${pkg.name}`, "lib"));
    // `lib/` **根**下的文件:纯 cmake 常把 `libX.so` 直接装在 `<prefix>/lib/`(实测 p12/p13/p15)
    for (const raw of await collectFlatDir(fs, pjoin(prefix, "lib"), "lib", "lib")) {
        if (ownsFlat(raw.relToPrefix)) {
            raws.push(raw);
        }
    }
    for (const raw of await collectFlatDir(fs, pjoin(prefix, "bin"), "bin", "lib")) {
        if (ownsFlat(raw.relToPrefix)) {
            raws.push(raw);
        }
    }
    for (const site of await pythonSiteRoots(fs, prefix)) {
        const sub = prelative(site, prefix) ?? "lib/pythonX/site-packages";
        raws.push.apply(raws, await collectDir(fs, pjoin(site, pkg.name), `${sub}/${pkg.name}`, "import"));
    }
    raws.push.apply(raws, await collectDir(fs, pjoin(prefix, "share", pkg.name), `share/${pkg.name}`, "share"));
    raws.push.apply(raws, await collectDir(fs, pjoin(prefix, "include", pkg.name), `include/${pkg.name}`, "include"));

    /** 源落点解析(顺序:跳转记录 → 安装规则 → ament_python 根映射);sourceRef 供悬浮栏可逆搜索(第五批) */
    const resolveSource = (
        area: AreaName,
        relToPrefix: string,
        relPath: string,
        installPath: string
    ): { sourcePath?: string; sourceEvidence?: AreaFile["sourceEvidence"]; sourceRef?: string } => {
        if (pkgJumps !== undefined) {
            for (const e of pkgJumps) {
                const hit = e.installPath === installPath || (e.installPaths ?? []).indexOf(installPath) >= 0;
                if (hit && e.srcPaths.length > 0) {
                    return { sourcePath: e.srcPaths[0], sourceEvidence: "jump-record", sourceRef: l10n.t("build records (link.txt/.o.d)") };
                }
            }
        }
        const fromRule = sourceFromRulesRef(rules, relToPrefix);
        if (fromRule !== undefined) {
            return { sourcePath: fromRule.path, sourceEvidence: "install-rule", sourceRef: l10n.t("install rule {0}", fromRule.from) };
        }
        if (hasEggInfo) {
            // 根映射(**纯字符串拼装,不访问 src/**):site-packages/<pkg>/ ↔ src/<pkg>/<pkg>/;share/<pkg>/ ↔ src/<pkg>/
            if (area === "import") {
                return {
                    sourcePath: pjoin(ctx.srcRoot, pkg.name, pkg.name, relPath),
                    sourceEvidence: "python-rootmap",
                    sourceRef: l10n.t("{0}.egg-info root mapping", pkg.name),
                };
            }
            if (area === "share") {
                return {
                    sourcePath: pjoin(ctx.srcRoot, pkg.name, relPath),
                    sourceEvidence: "python-rootmap",
                    sourceRef: l10n.t("{0}.egg-info root mapping", pkg.name),
                };
            }
        }
        return {};
    };

    const files: AreaFile[] = [];
    const seen = new Set<string>();
    for (const raw of raws) {
        if (seen.has(raw.relToPrefix)) {
            continue;
        }
        seen.add(raw.relToPrefix);
        const src = resolveSource(raw.area, raw.relToPrefix, raw.relPath, raw.installPath);
        const followed = await fs.stat(raw.installPath); // 权限位:软链必须看**目标**(链自身模式无意义)
        const linkDomain =
            raw.linkTarget === undefined ? undefined : domainOf(ctx, raw.installPath, raw.linkTarget);
        const viaLinkDomain =
            raw.viaLinkPath === undefined || raw.viaLinkTarget === undefined
                ? undefined
                : domainOf(ctx, raw.viaLinkPath, raw.viaLinkTarget);
        files.push({
            pkg: pkg.name,
            area: raw.area,
            relPath: raw.relPath,
            installPath: raw.installPath,
            library: looksLikeLibrary(pbasename(raw.relPath)),
            link: raw.link,
            linkTarget: raw.linkTarget,
            linkDomain,
            dangling: raw.dangling,
            viaLinkPath: raw.viaLinkPath,
            viaLinkDomain,
            executable: ((followed === undefined ? 0 : followed.mode) & 0o111) !== 0,
            // `generated` 的判据**不能用"目标在 build"** —— 那会把 C++ 可执行(软链指向 build,
            // 但源在 src)也标成生成物。真实判据是:**约定黑名单** ∪ **源落在 build 内**
            // (rosidl 生成物 / ament hook / cmake 导出 都是这一类)。
            generated:
                isConventionGenerated(raw.area, raw.relPath) ||
                (src.sourcePath !== undefined && src.sourcePath.startsWith(ctx.buildRoot + "/")),
            sourcePath: src.sourcePath,
            sourceEvidence: src.sourceEvidence,
            sourceRef: src.sourceRef,
            agreement: manifestRels.has(raw.relToPrefix) ? "confirmed" : "observed",
        });
    }

    // ---- 反向对账:记录里有、install 侧没看到(被删 / 布局不符)----
    for (const rel of Array.from(manifestRels).sort()) {
        if (seen.has(rel)) {
            continue;
        }
        const cls = classifyPrefixRel(pkg.name, rel);
        if (cls === undefined) {
            continue;
        }
        const installPath = pjoin(prefix, rel);
        const src = resolveSource(cls.area, rel, cls.relPath, installPath);
        const origin = manifestOrigin.get(rel);
        files.push({
            pkg: pkg.name,
            area: cls.area,
            relPath: cls.relPath,
            installPath,
            library: looksLikeLibrary(pbasename(cls.relPath)),
            generated: isConventionGenerated(cls.area, cls.relPath),
            sourcePath: src.sourcePath,
            sourceEvidence: src.sourceEvidence,
            // manifest-only 行的"内容来源"指向**记录文件本身**(哪份清单还留着它 —— 可逆搜索的关键)
            sourceRef: origin !== undefined ? l10n.t("install record {0}", origin) : src.sourceRef,
            agreement: "manifest-only",
        });
    }

    files.sort((a, b) =>
        a.area === b.area ? (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0) : AREA_ORDER[a.area] - AREA_ORDER[b.area]
    );
    return { pkg: pkg.name, prefix, layout, files };
}

/** 批量解算(键与 packages 一致,逐包容错) */
export async function collectAreas(
    fs: FsLike,
    ctx: BuildContext,
    packages: Map<string, BuildPackage>,
    jumps?: Map<string, JumpEntry[]>
): Promise<{ areas: Map<string, PackageAreas>; warnings: string[] }> {
    const areas = new Map<string, PackageAreas>();
    const warnings: string[] = [];
    const installRoot = installRootOf(ctx);
    for (const pkg of Array.from(packages.values())) {
        try {
            areas.set(
                pkg.name,
                await collectPackageAreas(fs, ctx, pkg, installRoot, jumps, warnings)
            );
        } catch (err) {
            warnings.push(l10n.t("{0}: install-content resolution error skipped ({1})", pkg.name, err instanceof Error ? err.message : String(err)));
            areas.set(pkg.name, { pkg: pkg.name, prefix: "", layout: "unknown", files: [] });
        }
    }
    return { areas, warnings };
}

/** 便捷:某一区的条目(消费方按区取用时不必自己 filter) */
export function areaOf(areas: PackageAreas | undefined, area: AreaName): AreaFile[] {
    return areas === undefined ? [] : areas.files.filter((f) => f.area === area);
}
