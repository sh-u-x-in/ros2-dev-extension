// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file intellisense-config.ts
 * 配置生成【编排层】(入口):引擎开关 / 事件防抖 / 有感删除(难删,2026-09-08:事件差量候选 + 类型分侧 + 预检)。
 * 分裂自 2026-09-02(接口层 ./intellisense-api,工具层 ./intellisense-utils,
 * 渲染器 ./intellisense-render)——单文件过长拆分,各层单一职责。
 *
 * 追踪机制(参照旧 build-env-utils 理念,2026-09-02;事件契约 2026-09-08 升级为 10 域新+旧):
 *  - 事件源只有**两路**:包变化(packageCore.onDidChange,事件携带变化域"新值 + 旧值(old*)")+
 *    环境变化(onEnvChanged),防抖 800ms 合并执行。
 *    (2026-09-02 10:46 曾短暂新增 include 目录级 watcher(glob `** /include/ **`,10:49 即删除——
 *    采用"无条件收录、不做存在性检测":include 根路径恒在配置里,目录不存在只是编译器无害忽略;
 *    ws src 包后加头文件无需任何事件。)
 *  - **maintain-all(2026-09-08)**:配置输入 = workspace 域(unignored + ignored,忽略包同样维护,
 *    多收无害);ignore 分类翻转不产生成员变化 → 零动作;本层只关心 workspace 域事件
 *    (含类型就绪——dir 键差量为空即无事)。
 *  - 易增(无感):新包/新环境 include 自动补入(syncCppProperties/syncClangd 存在→合并缺失条目,
 *    不重复,幂等);
 *  - 难删(有感):消失候选**取自事件差量**(oldWorkspace − workspace,条目带类型;本地不再维护
 *    上一版快照,2026-09-08)→ 复核(package.xml 仍存在/已回当前集合则不删)→ **按类型定侧**
 *    (python 只走 extraPaths,C++ 才走 cpp/clangd,不跨侧)→ **配置存在性预检**(用户已删条目则
 *    不弹)→ 弹窗确认(60s 超时默认保留,2026-09-08 由 10s 调长)→ 同意才删;
 *    黑名单机制已于 2026-09-08 移除:事件差量模型下每条消失至多被判定一次(再判定必须路径重现,
 *    而重现即进入新一轮询问),无重复骚扰可防,黑名单无独立作用;拒绝/超时 = 条目留存(残留容忍)。
 *  - 引擎开关(ROS2.ide.intellisenseEngine):cpptools / clangd 侧分别启用,不启用的侧不读不写;
 *  - 防抖:包/环境变化 800ms 合并一次执行(消失候选在事件到达时即累计,防抖窗口内多事件取并集防漏)。
 */

import * as path from "path";
import * as vscode from "vscode";

import { getLogger } from "../../../../logger";
import { getExtensionConfiguration } from "../../../../vscode-utils";
import { isPythonPackage, type PackageEntry } from "../../../package-core/api";
import { resolveDistroConfig } from "./distro-templates";
import type { IntellisenseConfig, IntellisenseConfigOptions } from "./intellisense-api";
import {
    absIncludeForPkg,
    collectPythonDirs,
    collectStaticCppIncludes,
    collectStaticClangdInstallIncludes,
    readInstallLayout,
    type InstallLayout,
    collectSystemIncludes,
    recheckPackageAbsent,
    toCppIncludeEntry,
} from "./intellisense-utils";
import {
    cppIncludeEntryExists,
    clangdIncludeExists,
    pythonPathExists,
    removeClangdIncludes,
    removeCppIncludes,
    removePythonPaths,
    syncClangd,
    syncCppProperties,
    syncPythonPaths,
} from "./intellisense-render";

/** 编排层日志(2026-09-06:补配置生成可观测性——触发源/引擎侧/候选/确认结果均留痕) */
const log = getLogger("intellisense-config");

/** 包/环境变化防抖窗口(ms):多事件合并一次写入(参照旧 build-env-utils 收口理念,轻量化为 800ms,同 event-collector) */
const CHANGE_DEBOUNCE_MS = 800;

/**
 * 删除确认超时(ms):超时默认保留(安全侧)。
 * 2026-09-08 由 10s 调长至 60s——10s 过短:实测弹出后用户尚未来得及操作即被记"超时拒绝"
 * (23:51:36 弹窗 → 23:51:46 落"用户拒绝/超时");60s 给足确认/思考时间。
 */
const DELETION_CONFIRM_TIMEOUT_MS = 60000;

/* ================================================================== */
/* 引擎开关(ROS2.ide.intellisenseEngine):决定维护 cpptools / clangd 哪些侧 */
/* ================================================================== */

type IntellisenseEngine = "auto" | "cpptools" | "clangd" | "both" | "none";

interface ActiveSides {
    cpptools: boolean;
    clangd: boolean;
}

const INTELLISENSE_ENGINES: IntellisenseEngine[] = ["auto", "cpptools", "clangd", "both", "none"];

function getIntellisenseEngine(): IntellisenseEngine {
    const v = getExtensionConfiguration().get<IntellisenseEngine>("ide.intellisenseEngine", "both");
    return INTELLISENSE_ENGINES.includes(v) ? v : "both";
}

/** 解析引擎开关 → 启用的维护侧(auto:只装一个用那个;都装/都没装 → 双侧) */
function resolveActiveSides(): ActiveSides {
    switch (getIntellisenseEngine()) {
        case "cpptools":
            return { cpptools: true, clangd: false };
        case "clangd":
            return { cpptools: false, clangd: true };
        case "none":
            return { cpptools: false, clangd: false };
        case "auto": {
            const cpp = !!vscode.extensions.getExtension("ms-vscode.cpptools");
            const cld = !!vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd");
            if (cpp && !cld) {
                return { cpptools: true, clangd: false };
            }
            if (cld && !cpp) {
                return { cpptools: false, clangd: true };
            }
            return { cpptools: true, clangd: true };
        }
        case "both":
        default:
            return { cpptools: true, clangd: true };
    }
}

/* ================================================================== */
/* 有感删除(难删):复核 + 类型分侧 + 预检 + 弹窗确认(拒绝/超时默认保留) */
/* ================================================================== */

interface RemovalCandidate {
    side: "cpp" | "clangd" | "python";
    dir: string;
    entry: string; // A: includePath 条目字符串; B: include 绝对路径
}

/**
 * 删除确认弹窗:按【包】为单位计数与措辞(2026-09-08)——同一包多侧条目(cpp+clangd)只算 1 个包,
 * 多条合并为一条通知;超时默认保留(安全侧)。
 */
function requestDeletionConfirmation(candidates: RemovalCandidate[]): Promise<boolean> {
    const dirs = Array.from(new Set(candidates.map((c) => c.dir)));
    const names = dirs.map((d) => path.basename(d)).join("、");
    const message = dirs.length === 1
        ? `检测到包"${names}"已从工作区消失,是否从配置中移除其 include/extraPaths 条目?`
        : `检测到 ${dirs.length} 个包已从工作区消失(${names}),是否从配置中移除其 include/extraPaths 条目?`;
    return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
            resolve(false); // 超时默认保留
        }, DELETION_CONFIRM_TIMEOUT_MS);
        void vscode.window.showWarningMessage(message, "删除", "保留").then((choice) => {
            clearTimeout(timeout);
            resolve(choice === "删除");
        });
    });
}

/* ================================================================== */
/* 创建配置生成器(入口) */
/* ================================================================== */

/** 创建配置生成器(依赖注入;消费 package-core 快照 + 包/环境变化双订阅,事件驱动追踪) */
export function createIntellisenseConfig(opts: IntellisenseConfigOptions): IntellisenseConfig {
    let unsub: (() => void) | undefined;
    let envSub: { dispose(): void } | undefined;
    let changeTimer: NodeJS.Timeout | undefined;
    // 有感删除候选累计(2026-09-08):key = 消失目录,value = 该目录最后一条目(带类型,供类型定侧)。
    // 来源 = 事件差量(oldWorkspace − workspace),本地不再维护上一版全量快照;
    // 防抖窗口内多事件到达时逐事件累计(并集),防"移走又移回"等中间变化漏报。
    let pendingRemoved = new Map<string, PackageEntry>();

    function workspaceEntries(): PackageEntry[] {
        const state = opts.getState();
        return [...(state.unignored ?? []), ...(state.ignored ?? [])]; // workspace 口径(ignored 也是源码);null(未刷新)视为空
    }

    /**
     * 全部 include(2026-09-06):按【来源】分 ws(工作区包 include,src)与 sys(环境前缀 include——
     * CMAKE/AMENT/COLCON 前缀拼 /include;前缀即使物理路径在工作区内(如 <ws>/install)也按来源归
     * 环境组)。**不含 /usr/include 等编译器默认搜索路径**(gcc/clang 隐式自带,再生成 = 与系统路径
     * 重复;发行版/架构差异也无法硬编码——2026-09-06 起不再收录)。all = 平铺(工作空间优先去重),
     * 供 cpp 侧;ws/sys 供 clangd 侧分组渲染(-I / -isystem)。
     * 工作区包按类型分派(2026-09-02 方案 A):只收 C++ 包(非 ament_python——ament_cmake/cmake 等)
     * 的 include,python 包无头文件不进 include 侧;buildType 三态——具体值=合法类型,
     * ""=系统包(不在工作区域),undefined=未取到(按 C++ 保守收录,cpp include 空路径无害)。
     */
    function collectAllIncludes(entries: PackageEntry[], layout: InstallLayout): { ws: string[]; install: string[]; installPrefixes: string[]; sys: string[]; all: string[] } {
        const ws = Array.from(new Set(entries.filter((pkg) => !isPythonPackage(pkg)).map((pkg) => absIncludeForPkg(pkg.dir))));
        // 源头去重(2026-09-02):环境前缀与工作区 include 可能指向同一目录;跨源同串 →
        // 工作空间优先(环境侧剔除);保证下游(includePath/-I)条目唯一;渲染层另有兜底
        const wsSet = new Set(ws);
        const pkgFacts = entries.map((p) => ({ name: p.name, isPython: isPythonPackage(p) }));
        // 工作区**安装产物** include(2026-09-15):本地模板按 .colcon_install_layout 塌缩生成,
        // 不再从 env 的 AMENT/CMAKE/COLCON_PREFIX_PATH 里取本工作区前缀(env 只供"其它工作空间 + 系统")
        //  · cpptools 吃**子层**消费根(install/<pkg>/include/<pkg>;杜绝双层包名导入)
        //  · clangd 吃**父层**前缀(install/<pkg>/include),由 clangdGroupDirs 展开成真实存在的子根
        const install = collectStaticCppIncludes(opts.workspaceRoot, pkgFacts, layout).filter((d) => !wsSet.has(d));
        const installPrefixes = collectStaticClangdInstallIncludes(opts.workspaceRoot, pkgFacts, layout).filter((d) => !wsSet.has(d));
        const sys = Array.from(new Set(collectSystemIncludes(opts.environment.getEnv(), opts.workspaceRoot))).filter((d) => !wsSet.has(d));
        return { ws, install, installPrefixes, sys, all: [...ws, ...install, ...sys] };
    }

    /** 易增(无感):新 include 自动补入(按引擎侧;幂等——存在→合并缺失条目,缺失→生成) */
    async function applyAdditions(entries: PackageEntry[], sides: ActiveSides): Promise<void> {
        // 安装布局每轮重读(单文件、极廉价):布局切换后三份配置要按新形态整块重算
        const layout = await readInstallLayout(opts.workspaceRoot, log);
        // 发行版模板分派(2026-09-28 VD-2):env.ROS_DISTRO 查表 + PYTHONPATH 观测 ABI 覆盖(观测优先,表兜底);
        // 未知发行版(rolling)/无 env 整体回落 humble 默认(与 2026-09-15 裁定一致);每轮重解析,随 onEnvChanged 自动跟随,
        // 发行版切换后旧形状条目由渲染层"旧形状残留直接删除"机制自动清替,无需额外逻辑
        const distroCfg = resolveDistroConfig(opts.environment.getEnv());
        log.debug(`发行版模板:distro=${distroCfg.distro ?? "(无 env)"} pythonAbi=${distroCfg.tpl.pythonAbi} purelib=${distroCfg.tpl.cmakePythonPurelib} 来源=${distroCfg.abiSource}`);
        const inc = collectAllIncludes(entries, layout);
        log.debug(`易增执行:布局=${layout};包 ${entries.length} 个 → include 工作空间 ${inc.ws.length}/安装 ${inc.install.length}/环境 ${inc.sys.length}(平铺 ${inc.all.length});引擎 cpptools=${sides.cpptools}/clangd=${sides.clangd}`);
        if (sides.cpptools) {
            await syncCppProperties(opts.workspaceRoot, inc.all); // 存在→合并缺失条目,缺失→生成
        }
        if (sides.clangd) {
            // 布局一并传入(安装组注释与归正都按它);install 传**父层前缀**供 clangdGroupDirs 展开子根
            await syncClangd(opts.workspaceRoot, { ws: inc.ws, install: inc.installPrefixes, sys: inc.sys }, layout); // 存在→按组分补缺失,缺失→生成
        }
        const envDirs = collectPythonDirs(opts.environment.getEnv(), opts.workspaceRoot);
        await syncPythonPaths(opts.workspaceRoot, entries, envDirs, layout, distroCfg.tpl);
    }

    /**
     * 难删(有感删除,2026-09-08 语义):消失包(带类型条目,来自事件差量)→ 复核 → 按类型定侧 →
     * 配置存在性预检 → 弹窗确认 → 同意才删。
     * 黑名单机制已移除(2026-09-08):事件差量模型下每条消失至多被判定一次(再判定必须先重现,
     * 而重现即进入新一轮询问),无重复骚扰可防;拒绝/超时 = 条目默认保留(残留容忍)。
     */
    async function applyRemovals(removedEntries: PackageEntry[], sides: ActiveSides): Promise<void> {
        const candidates: RemovalCandidate[] = [];
        for (const entry of removedEntries) {
            const dir = entry.dir;
            // 复核:package.xml 仍存在(恢复/目录被占用/移回)→ 包未消失,不删
            if (!(await recheckPackageAbsent(dir))) {
                continue;
            }
            if (isPythonPackage(entry)) {
                // python 包只走 python 侧(extraPaths 条目 = 包根,与 syncPythonPaths 收录口径一致);
                // 不依赖引擎开关;先预检配置确实存在(用户可能已自删)才构成候选
                if (await pythonPathExists(dir)) {
                    candidates.push({ side: "python", dir, entry: dir });
                }
            } else if (sides.cpptools || sides.clangd) {
                // C++ 包(含类型未知保守口径):只走 cpp/clangd 两侧;预检通过才弹
                const inc = absIncludeForPkg(dir);
                if (sides.cpptools) {
                    const cppEntry = toCppIncludeEntry(inc, opts.workspaceRoot);
                    if (await cppIncludeEntryExists(opts.workspaceRoot, cppEntry)) {
                        candidates.push({ side: "cpp", dir, entry: cppEntry });
                    }
                }
                if (sides.clangd && (await clangdIncludeExists(opts.workspaceRoot, inc))) {
                    candidates.push({ side: "clangd", dir, entry: inc });
                }
            }
        }
        if (candidates.length === 0) {
            log.debug(`难删:消失候选 ${removedEntries.length} 个均无待删条目(复核不过/类型侧从未收录/配置已无该条目),不弹窗`);
            return;
        }
        const pkgCount = new Set(candidates.map((c) => c.dir)).size; // 计数/措辞以"包"为单位(同包多侧条目 = 1 个包)
        log.debug(`难删:待弹窗确认 ${pkgCount} 个包 / ${candidates.length} 条(${candidates.map((c) => `${c.side}:${path.basename(c.dir)}`).join(",")})`);
        const confirmed = await requestDeletionConfirmation(candidates);
        if (!confirmed) {
            // 拒绝/超时 → 条目默认保留(黑名单已移除 2026-09-08;路径重现后再消失会重新询问)
            log.info(`有感删除:用户拒绝/超时,默认保留 ${pkgCount} 个包的条目(${candidates.map((c) => `${c.side}:${path.basename(c.dir)}`).join(",")})`);
            return;
        }
        // 同意 → 删除对应侧条目(弹窗前已预检存在,预期命中;命中 0 = 竞态已自删)
        const cppEntries = candidates.filter((c) => c.side === "cpp").map((c) => c.entry);
        const clangdEntries = candidates.filter((c) => c.side === "clangd").map((c) => c.entry);
        const pythonEntries = candidates.filter((c) => c.side === "python").map((c) => c.entry);
        log.info(`有感删除:用户同意 ${pkgCount} 个包(侧计数 cpp=${cppEntries.length}/clangd=${clangdEntries.length}/python=${pythonEntries.length})`);
        if (cppEntries.length > 0) {
            await removeCppIncludes(opts.workspaceRoot, cppEntries);
        }
        if (clangdEntries.length > 0) {
            await removeClangdIncludes(opts.workspaceRoot, clangdEntries);
        }
        if (pythonEntries.length > 0) {
            await removePythonPaths(opts.workspaceRoot, pythonEntries);
        }
    }

    /** 统一变化处理:易增(无感)+ 难删(有感,候选来自事件差量累计),按引擎侧执行 */
    async function handleIncludesChange(): Promise<void> {
        const entries = workspaceEntries();
        const currentDirs = new Set(entries.map((e) => e.dir));
        const sides = resolveActiveSides();
        log.debug(`配置重算入口:包 ${entries.length} 个,待确认消失候选 ${pendingRemoved.size} 个,引擎 cpptools=${sides.cpptools}/clangd=${sides.clangd}`);
        await applyAdditions(entries, sides);
        if (pendingRemoved.size > 0) {
            const pending = [...pendingRemoved.values()];
            pendingRemoved.clear();
            // 复核:事件窗口内已回到当前集合(移回)→ 撤下(条目由易增无感补回);其余走有感弹窗
            const stillGone = pending.filter((e) => !currentDirs.has(e.dir));
            if (stillGone.length > 0) {
                await applyRemovals(stillGone, sides);
            }
        }
    }

    /** 事件防抖调度:包/环境变化共用,窗口内多事件合并一次执行 */
    function scheduleChange(reason: string): void {
        if (changeTimer) {
            clearTimeout(changeTimer);
        }
        log.trace(`配置重算调度:${reason},${CHANGE_DEBOUNCE_MS}ms 防抖合并`);
        changeTimer = setTimeout(() => {
            changeTimer = undefined;
            void handleIncludesChange();
        }, CHANGE_DEBOUNCE_MS);
    }

    return {
        async sync(): Promise<void> {
            await handleIncludesChange();
        },
        subscribe(onDidChange) {
            // 包变化 → 防抖合并追踪(maintain-all:只关心 workspace 域成员变化;ignore 翻转零动作)
            unsub = onDidChange((ev) => {
                if (ev.workspace === undefined) {
                    return; // workspace 未变(仅 unignored/ignored 翻转等)→ 与配置无关
                }
                if (ev.oldWorkspace !== undefined && ev.workspace !== null) {
                    // 有感候选 = 旧 − 新(按 dir),条目带类型;事件即达即累计(防抖窗口内并集防漏)
                    const newDirs = new Set(ev.workspace.map((e) => e.dir));
                    for (const e of ev.oldWorkspace ?? []) {
                        if (!newDirs.has(e.dir)) {
                            pendingRemoved.set(e.dir, e);
                        }
                    }
                }
                // old 未知(null,冷启动首载)→ 无删除候选(等效"首次不删");新包由易增无感补入
                scheduleChange("包域变化(workspace,事件带新旧值)");
            });
            // 环境变化(source 完成/overlay 变化)→ 同一防抖追踪(只加不删,env 变化无包消失语义)
            envSub = opts.environment.onEnvChanged(() => {
                scheduleChange("环境变化(source/overlay)");
            });
            return () => {
                unsub?.();
                envSub?.dispose();
                if (changeTimer) {
                    clearTimeout(changeTimer);
                    changeTimer = undefined;
                }
            };
        },
        dispose() {
            unsub?.();
            envSub?.dispose();
            if (changeTimer) {
                clearTimeout(changeTimer);
                changeTimer = undefined;
            }
            unsub = undefined;
        },
    };
}
// 修改时间:2026-09-08 22:53(消费方改造:事件 10 域差量消费,删除本地 lastWorkspaceDirs;难删按类型分侧
// + 配置存在性预检不弹空窗;python 侧删除接线;黑名单只与拒绝/超时(记)、条目路径重现(清)相关)
// 修改时间:2026-09-08 23:09(移除黑名单机制:intellisense-blacklist.ts 删除;applyAdditions/applyRemovals
// 去黑名单读写/过滤;拒绝/超时 = 条目默认保留,路径重现后再消失会重新询问)
// 修改时间:2026-09-08 23:53(确认计数/措辞以"包"为单位(同包多侧 = 1 个包);删除确认超时 10s → 60s)
// 修改时间:2026-09-28(VD-2 接线:applyAdditions 每轮经 distro-templates.resolveDistroConfig 解析发行版模板
// (env.ROS_DISTRO 查表 + PYTHONPATH 观测 ABI,观测优先表兜底)并透传给 syncPythonPaths;零新增事件/配置键)