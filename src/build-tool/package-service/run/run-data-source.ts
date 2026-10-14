// Licensed under the MIT License.

/**
 * @file run-data-source.ts(2026-09-25 新增)
 * run 域的**数据源窄接口**(仿 build 域 BuildDataSource:参数注入,零循环依赖)
 * + 默认实现(**install-truth 共享数据中心** —— 文件系统扫描,无需 ROS 环境)。
 *
 * 数据口径 = install 侧真相:
 *  · 包/可执行 ← 快照 jumps(构建目标;与侧边栏 lib 区、launch 语言域的可执行校验同源);
 *  · launch 文件 ← share 区中名字命中 launch 扩展名的行(与侧边栏 launch 区同一判定 `launch-detect.ts`)。
 * 未就绪/无工作区一律返回空数组(调用方给"未发现构建产物"的提示,不区分原因)。
 */

import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { ExecutableResolver } from "../../../install-truth/api";
import type { SidebarPackageView } from "../../../install-truth/api";
import { acquireSharedBuildCenter } from "../../../install-truth/center/shared-center";
import { getLogger } from "../../../logger";
import { isLaunchFileName, trimLaunchDisplayPrefix } from "./launch-detect";

/** run-data-source 模块日志 */
const log = getLogger("run-data-source");

/** 一条可运行目标(ros2 run) */
export interface RunTarget {
    pkg: string;
    executable: string;
    /** 安装侧入口绝对路径(2026-10-13 陈旧警告富集;lookup 未命中 = undefined) */
    installPath?: string;
    /** 主源码候选(2026-10-13 陈旧警告富集;同上) */
    srcPath?: string;
}

/**
 * 一键运行的属主裁决结果(2026-10-13 方案甲,用户裁定):
 * 跳转表全部来自 build 侧(有编译无安装也放行,而侧边栏 = install 侧观察、什么都不显示——两套证据矛盾),
 * 故属主按**安装侧就绪性**分层,由上层给出两种不同警告(未编译 / 已编译未安装)。
 */
export interface OwnersOfSourceResult {
    /** 安装侧就绪(lib 区 installed 可执行行命中)——可放行运行 */
    runnable: RunTarget[];
    /** 跳转记录在、安装侧未就绪(编译了没装/装失败/压根无安装规则)——不放行,给"已编译未安装"警告 */
    compiledNotInstalled: RunTarget[];
}

/** 一条可启动目标(ros2 launch) */
export interface LaunchTarget {
    pkg: string;
    /** 包内相对安装路径(展示名;嵌套目录保留子路径)——`ros2 launch <pkg> <file>` 的 file 口径 */
    name: string;
    /** 安装侧绝对路径(${launch_path};记忆退化键) */
    installPath: string;
    /** 源文件绝对路径(记忆分槽键;源未解析 → undefined) */
    sourcePath?: string;
}

/** run 域数据源(面板流程注入;侧边栏树入口不需要它 —— 目标已知,直接展开执行) */
export interface RunDataSource {
    /** 已构建安装的包名(升序) */
    listPackages(): Promise<string[]>;
    /** 包 → 可执行名(升序;包未构建/无目标 → 空数组) */
    executablesOf(pkg: string): Promise<string[]>;
    /** 全部 launch 文件(按包序;仅 status=installed 的行) */
    launchFiles(): Promise<LaunchTarget[]>;
    /** 源文件 → 所属可执行(2026-09-29 一键运行;未构建/无跳转记录 → 空;2026-10-13 方案甲:按安装侧就绪性分层) */
    ownersOfSource(srcPath: string): Promise<OwnersOfSourceResult>;
    /** 源文件 → launch 目标(2026-09-29 一键运行;launchFiles 快照按 sourcePath 匹配;未命中 → undefined) */
    launchFileOfSource(srcPath: string): Promise<LaunchTarget | undefined>;
}

/**
 * 共享中心的轻量门面(2026-09-30 改**模块级缓存**):
 * resolver 门面对象虽轻,但索引缓存(ExecIndexCache/areaIndex)按实例持有 ——
 * 每次弹窗都 new 会让每次下拉都重建一遍索引;缓存后索引按快照引用自动失效,换根重建门面。
 */
let cachedResolver: { root: string; resolver: ExecutableResolver } | undefined;
function resolverOf(): ExecutableResolver | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root === undefined) {
        return undefined;
    }
    if (cachedResolver === undefined || cachedResolver.root !== root) {
        cachedResolver = { root, resolver: new ExecutableResolver(acquireSharedBuildCenter(root).center) };
    }
    return cachedResolver.resolver;
}

/**
 * 安装侧就绪性拆分(纯函数,2026-10-13 方案甲;可无头测试):
 * 就绪口径 = **侧边栏同一行** —— lib 区 `status === "installed"` 的可执行行命中(`pkg/executable`)。
 * 三种"未就绪"子 case 全部落坑:①编译了但压根无安装规则(侧边栏无行)②有安装规则但 install 侧没看到
 * (行 status="missing")③软链悬空等(非 installed)。
 * `views === null`(中心未就绪)→ 保守全部视为可运行(不因"判不了"而拦截;对齐域纪律"未就绪 ≠ 空")。
 * 泛型:属主可携带额外字段(如 2026-10-13 陈旧警告的 installPath/srcPath)原样透传到结果侧。
 */
export function splitOwnerReadiness<T extends { pkg: string; name: string }>(owners: T[], views: SidebarPackageView[] | null): { runnable: T[]; compiledNotInstalled: T[] } {
    const out: { runnable: T[]; compiledNotInstalled: T[] } = { runnable: [], compiledNotInstalled: [] };
    const ready = new Set<string>();
    if (views !== null) {
        for (const view of views) {
            for (const row of view.rows) {
                if (row.area === "lib" && row.status === "installed" && row.executable === true) {
                    ready.add(`${view.pkg}/${row.name}`);
                }
            }
        }
    }
    for (const o of owners) {
        if (views === null || ready.has(`${o.pkg}/${o.name}`)) {
            out.runnable.push(o); // 中心未就绪 → 保守放行(判不了不拦,对齐"未就绪 ≠ 空")
        } else {
            out.compiledNotInstalled.push(o);
        }
    }
    return out;
}

/** 陈旧警告设置键(ROS2.run.staleWarning;默认开——刻意测试旧安装的用户可关闭,照 preflight 键常量先例) */
export const RUN_STALE_WARNING_SETTING = "run.staleWarning";
/** 同目标冷却窗口(2026-10-13 用户裁定:30 秒) */
export const STALE_NOTIFY_COOLDOWN_MS = 30_000;
/**
 * 「不再显示」按钮文案(2026-10-14 用户裁定:警告面从状态栏改非模态警告气泡,按钮写本设置键永久静默)。
 * 按钮+返回值比较双角色,常量同源 t()(照 preflight PREFLIGHT_MUTE_LABEL 先例)。
 * 原状态栏选型依据"带按钮 toast 会钉住"经用户实机观察推翻:非模态气泡不点按钮也会宿主自动收起(实测约 12 秒)。
 */
export const STALE_MUTE_LABEL = vscode.l10n.t("Don't show again");

/** 陈旧判定(纯函数):源与安装双侧都拿到 mtime,且**源严格更新**才算陈旧 */
export function isStale(srcMtimeMs: number | undefined, installMtimeMs: number | undefined): boolean {
    return srcMtimeMs !== undefined && installMtimeMs !== undefined && srcMtimeMs > installMtimeMs;
}

/** 冷却判定(纯函数):无记录 = 可弹;窗口内 = 不弹 */
export function shouldNotifyStale(last: number | undefined, now: number, cooldownMs: number = STALE_NOTIFY_COOLDOWN_MS): boolean {
    return last === undefined || now - last >= cooldownMs;
}

/** 同目标冷却表(kind 前缀 + pkg/name;会话级,重载清零——跨会话记忆不值得) */
const staleNotifyLast = new Map<string, number>();

/**
 * 陈旧**附加**警告(非阻塞,2026-10-13 用户裁定「附加不阻碍」):
 * 源比安装产物新时,弹**非模态警告气泡**(2026-10-14 用户裁定由状态栏改来:原"状态栏 4 秒"存在感弱,
 * 气泡实测约 12 秒自动收起、不积累,且可带「不再显示」按钮);运行/启动**照常执行**——本函数只附加信息,
 * 不等待、不拦截。点「不再显示」→ 写 `ROS2.run.staleWarning = false` 永久静默(有工作区写工作区层,
 * 否则用户层,照 preflight setPreflightMode 先例)。statSync 跟随软链,symlink/develop 安装两侧 mtime
 * 天然相等 → 零误报;源缺失 → 不警(装好的那份即唯一真相)。30 秒同目标冷却防刷屏。
 */
export function notifyStaleIfNeeded(kind: "run" | "launch", pkg: string, name: string, srcPath: string | undefined, installPath: string | undefined): void {
    const enabled = vscode.workspace.getConfiguration("ROS2").get<boolean>(RUN_STALE_WARNING_SETTING, true);
    if (!enabled) {
        return;
    }
    let srcMtimeMs: number | undefined;
    let installMtimeMs: number | undefined;
    try {
        if (srcPath !== undefined && srcPath !== "") {
            srcMtimeMs = fs.statSync(srcPath).mtimeMs;
        }
    } catch {
        srcMtimeMs = undefined;
    }
    try {
        if (installPath !== undefined && installPath !== "") {
            installMtimeMs = fs.statSync(installPath).mtimeMs;
        }
    } catch {
        installMtimeMs = undefined;
    }
    if (!isStale(srcMtimeMs, installMtimeMs)) {
        return;
    }
    const key = `${kind}:${pkg}/${name}`;
    const now = Date.now();
    if (!shouldNotifyStale(staleNotifyLast.get(key), now)) {
        return;
    }
    staleNotifyLast.set(key, now);
    const installTime = installMtimeMs !== undefined ? new Date(installMtimeMs).toLocaleString() : "";
    const srcTime = srcMtimeMs !== undefined ? new Date(srcMtimeMs).toLocaleString() : "";
    void vscode.window.showWarningMessage(
        vscode.l10n.t(
            "⚠ Installed {0} is older than its source (installed {1} / source {2}) - this run may not include your latest edits",
            `${pkg}/${name}`, installTime, srcTime),
        STALE_MUTE_LABEL,
    ).then((selected) => {
        if (selected === STALE_MUTE_LABEL) {
            void disableStaleWarning().catch((err) => {
                log.warn(vscode.l10n.t("Failed to write stale warning setting: {0}", err instanceof Error ? err.message : String(err)));
            });
        }
    });
}

/** 「不再显示」写回:关陈旧警告(有工作区写工作区设置,否则用户设置;照 preflight setPreflightMode 先例) */
async function disableStaleWarning(): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration("ROS2").update(RUN_STALE_WARNING_SETTING, false, target);
    log.info(vscode.l10n.t("Stale warning disabled via notification button (written to {0} settings)", target === vscode.ConfigurationTarget.Workspace ? vscode.l10n.t("workspace") : vscode.l10n.t("user")));
}

/** 默认实现:install-truth 共享数据中心(与侧边栏/测试 runner 同一实例,无重复扫描) */
export function createInstallTruthRunDataSource(): RunDataSource {
    return {
        async listPackages(): Promise<string[]> {
            const resolver = resolverOf();
            if (resolver === undefined) {
                return [];
            }
            await resolver.ensureFresh("run.listPackages");
            return resolver.installedPackages() ?? [];
        },
        async executablesOf(pkg: string): Promise<string[]> {
            const resolver = resolverOf();
            if (resolver === undefined) {
                return [];
            }
            return (await resolver.namesOf(pkg)) ?? [];
        },
        async launchFiles(): Promise<LaunchTarget[]> {
            const resolver = resolverOf();
            if (resolver === undefined) {
                return [];
            }
            await resolver.ensureFresh("run.launchFiles");
            const out: LaunchTarget[] = [];
            for (const view of resolver.sidebarSnapshot() ?? []) {
                for (const row of view.rows) {
                    if (row.area !== "share" || row.status !== "installed" || !isLaunchFileName(row.name)) {
                        continue;
                    }
                    out.push({
                        pkg: view.pkg,
                        name: trimLaunchDisplayPrefix(row.name),
                        installPath: row.installPath,
                        sourcePath: row.sourcePath,
                    });
                }
            }
            log.debug(vscode.l10n.t("Launch file inventory: {0} entries", out.length));
            return out;
        },
        async ownersOfSource(srcPath: string): Promise<OwnersOfSourceResult> {
            const resolver = resolverOf();
            if (resolver === undefined) {
                return { runnable: [], compiledNotInstalled: [] };
            }
            await resolver.ensureFresh("run.ownersOfSource");
            const owners = (await resolver.ownersOfSource(srcPath)) ?? [];
            // 路径富集(2026-10-13 陈旧警告):lookup 走 O(1) 缓存索引,取安装侧入口与主源码候选
            const enriched: Array<RunTarget & { name: string }> = [];
            for (const o of owners) {
                const t: RunTarget & { name: string } = { pkg: o.pkg, executable: o.name, name: o.name };
                const lookup = await resolver.lookup(o.pkg, o.name);
                if (lookup?.entry !== undefined) {
                    t.installPath = lookup.entry.installPath !== "" ? lookup.entry.installPath : lookup.entry.installPaths?.[0];
                    t.srcPath = lookup.entry.srcPaths[0];
                }
                enriched.push(t);
            }
            // 方案甲(2026-10-13):按侧边栏同口径(lib 区 installed 可执行行)拆分就绪性
            return splitOwnerReadiness(enriched, resolver.sidebarSnapshot());
        },
        async launchFileOfSource(srcPath: string): Promise<LaunchTarget | undefined> {
            const key = normalizeSourceKey(srcPath);
            for (const t of await this.launchFiles()) {
                if (t.sourcePath !== undefined && normalizeSourceKey(t.sourcePath) === key) {
                    return t;
                }
            }
            return undefined;
        },
    };
}

/** 源路径匹配键:分隔符统一 + Windows 大小写不敏感(跳转记录按原样绝对串记录,编辑器 fsPath 形态可能略异) */
function normalizeSourceKey(p: string): string {
    return path.normalize(p).replace(/\\/g, "/").toLowerCase();
}
