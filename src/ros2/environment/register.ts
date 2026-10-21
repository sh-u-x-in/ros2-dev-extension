// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file register.ts
 * 环境监听统一注册(2026-09-15 环境体系重设计后精简)。
 * 环境相关监听集中于此,经 EnvironmentFacade.registerEnvironmentListeners 对外暴露。
 *
 * 收录的监听:
 *  - ① shell 配置监听(env.systemWatchFiles 变化 → 触发一轮环境采集;提前触发;
 *      2026-09-28 起列表变化 → 按新列表重建 watcher,不再需要重载窗口)
 *  - ② 构建信号监听(install/setup.bash 单文件 → ①专供事件 fireBuildSignal(零防抖)
 *      + ②1s 防抖 → 构建后刷新 = 环境采集 + compile_commands 合并)
 *      2026-09-15:收窄自 install/** 整树;旧"我方构建任务抑制"机制随单文件信号一并移除(每次构建仅 1 次事件)
 *      2026-09-16:watcher 改"以文件自身为 base"(方案 2);不惧 files.watcherExclude,详见 registerBuildSignalWatch 注释
 *      2026-09-30:同源事件兼供 install-truth(build-signal.ts 专供事件,消费方自行幂等)——
 *      取代其 9 组 build 产物 watcher 只置脏的旧失效源(手工重设计/13)
 *  - ③ 工作区文件夹变化 → 刷新 context key
 *  - ④ 配置变化:env 相关字段 → 防抖刷新环境
 *  - ⑤ 60 秒轮询(环境采集主干;事件语义 = 外部变化专属,见 source.ts)
 */

import * as vscode from "vscode";

import * as activate from "./activate";
import { fireBuildSignal } from "./build-signal";
import * as reloadPrompt from "./reload-prompt";
import * as source from "./source";
import * as status from "./status";
import { createFileSystemWatcher, getWorkspaceRoot, onDidChangeWorkspaceFolders } from "../host/fs";
import { onConfigChanged } from "../host/config";
import { getLogger } from "../../logger";

/** 环境监听模块日志 */
const log = getLogger("environment-register");

/** 首个工作区根(换根比对的基准;undefined = 起宿主时无根,首次出现根不提示) */
let firstWorkspaceRoot: string | undefined;



/* ------------------------------------------------------------------ */
/* ② 构建信号监听(install/setup.bash 单文件 → 专供事件 + 1s 防抖 → 构建后刷新) */
/* ------------------------------------------------------------------ */

/** 构建信号监听句柄(P2:可按当前根重建——换根后旧根的 install/setup.bash 不再是新构建的落点) */
interface BuildSignalWatchHandle {
    rebuild(): void;
    dispose(): void;
}

/**
 * 注册构建信号监听:colcon 在构建结束时无条件重写 install/setup.bash(每次调用 1 次;
 * 成功/失败/no-op 均写,位置=构建结束——2026-09-14 三组实测),作为唯一构建完成信号。
 * 多构建并发 → 1s 防抖聚合;构建后执行 = 全量环境刷新(refreshEnvironment:source+context key+组件对账,
 * P2 传感器统一)+ compile_commands 合并(activate.refreshAfterBuild)。
 *
 * 2026-09-16(方案 2):watcher 改"以**文件自身**为 base + 模式 `*`"(官方 d.ts 的"单文件监视"范例)。
 * 为什么换掉之前以工作区根为 base 的写法:该模式含斜杠 ⇒ VS Code 判其为"递归 watcher",
 * 并自动把 files.watcherExclude 塞进 excludes —— 排除表里只要有指向 install 子树的 glob(旧版扩展曾写入,
 * 残留或用户自配均可能命中),事件会在源头被过滤而静默(2026-09-16 源码级复盘)。文件型非递归监视不走该通道:事件显式跳过
 * excludes/includes 检查("file is explicitly watched");且 install/ 尚不存在时会"挂起 + fs.watchFile 轮询(~5s)",
 * 路径出现即合成 create 事件并转入正式监视(baseWatcher 源码行为)——首次构建(onDidCreate)同样可靠。
 * P2:改可重建句柄——换根时 rebuild 到新根(旧实现根捕获一次,换根后仍盯旧根直到重载)。
 */
function registerBuildSignalWatch(context: vscode.ExtensionContext): BuildSignalWatchHandle {
    let disposables: vscode.Disposable[] = [];
    let debounceTimer: NodeJS.Timeout | undefined;

    const build = (): void => {
        for (const d of disposables) {
            d.dispose();
        }
        disposables = [];
        const wsRoot = getWorkspaceRoot();
        const watcher = wsRoot
            ? createFileSystemWatcher(new vscode.RelativePattern(
                vscode.Uri.joinPath(vscode.Uri.file(wsRoot), "install", "setup.bash"),
                "*"
            ))
            : createFileSystemWatcher("**/install/setup.bash");
        const refresh = (reason: string): void => {
            // 2026-09-30:专供事件先行,**源处零防抖**(延迟 = watcher 事件本身;消费方自行幂等)。
            // install-truth 的数据中心靠它主动增量刷新(手工重设计/13);环境域自身仍走下方 1s 防抖。
            fireBuildSignal();
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => {
                log.debug(vscode.l10n.t("Build signal received (install/setup.bash changed); triggering post-build refresh: {0}", reason));
                void activate.refreshAfterBuild(context);
            }, 1000);
        };
        disposables.push(watcher.onDidChange((uri) => refresh(uri.fsPath)));
        disposables.push(watcher.onDidCreate((uri) => refresh(uri.fsPath)));  // 首次构建
        disposables.push(watcher.onDidDelete((uri) => refresh(uri.fsPath)));  // install/ 被删
        disposables.push(watcher);
        log.debug(vscode.l10n.t("Build signal watcher rebuilt for workspace root: {0}", wsRoot ?? "(none)"));
    };
    const disposeAll = (): void => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
        }
        for (const d of disposables) {
            d.dispose();
        }
        disposables = [];
    };
    build();
    context.subscriptions.push({ dispose: disposeAll });
    return { rebuild: build, dispose: disposeAll };
}

/* ------------------------------------------------------------------ */
/* ④ 配置变化监听                                                       */
/* ------------------------------------------------------------------ */

/** 仅这些字段变化需要重新加载环境(影响采集链路的配置) */
const ENV_AFFECTING_CONFIG_KEYS = [
    "env.setupScript",
    "env.pixiRoot",
    "env.distro",
    "env.systemWatchFiles",
];

/** 注册配置变化监听:env 相关字段(防抖刷新环境;systemWatchFiles 列表变化另重建 watcher) */
function registerConfigListeners(context: vscode.ExtensionContext, envWatchHandle: source.SystemEnvWatchHandle | undefined): void {
    let configRefreshTimer: NodeJS.Timeout | undefined;

    context.subscriptions.push(onConfigChanged((e) => {
        // 2026-08-28 allowEmptyWorkspace 监听已移出(门控编排归 package-core/gate.ts,
        // 由上层编排者订阅配置变化执行任务提供器注册判定,不再经环境域 register)。
        // 环境相关字段变化 → 防抖后轻量刷新环境
        const affectsEnv = ENV_AFFECTING_CONFIG_KEYS.some((key) => e.affectsConfiguration(`ROS2.${key}`));
        if (!affectsEnv) {
            return;
        }
        if (configRefreshTimer) {
            clearTimeout(configRefreshTimer);
        }
        configRefreshTimer = setTimeout(() => {
            configRefreshTimer = undefined;
            // env.systemWatchFiles 列表变化 → 按新列表重建 shell 配置监听(2026-09-28 生效时机一致化)
            if (e.affectsConfiguration("ROS2.env.systemWatchFiles")) {
                envWatchHandle?.rebuild();
            }
            log.debug("Environment-related settings changed; refreshing environment after debounce");
            void activate.refreshEnvironment(context);
        }, 500);
    }));
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 注册全部环境监听(组合根调用一次;subscriptions 统一生命周期)。
 * 含:shell 配置监听、构建信号(install/setup.bash)、工作区文件夹变化、env 配置变化、60 秒轮询。
 * P2:①shell/轮询/构建信号三路统一走 refreshEnvironment 全量刷新(source+context key+组件对账;
 * 修「轮询路径恢复环境不重装配状态栏」缺口);②换根(首根变更)→ 提示重载+信号 watcher 重建。
 */
export function registerEnvironmentListeners(context: vscode.ExtensionContext): void {
    log.trace("Registering environment watchers");

    // ① shell 配置监听(env.systemWatchFiles;Windows 内部跳过 → 句柄 undefined)
    //    P2:刷新动作注入 refreshEnvironment(回调注入避免 source→activate 环)
    const envWatchHandle = source.registerSystemEnvWatch(context, () => {
        void activate.refreshEnvironment(context);
    });

    // ② 构建信号监听(install/setup.bash;P2 可重建句柄)
    const buildWatchHandle = registerBuildSignalWatch(context);

    // ③ 工作区文件夹变化 → 刷新 context key + 首根变更 → 提示重载(package-core/IntelliSense 绑定旧根)
    context.subscriptions.push(onDidChangeWorkspaceFolders(() => {
        const root = getWorkspaceRoot();
        void status.updateWorkspaceContextKeys();
        if (firstWorkspaceRoot === undefined) {
            // 起宿主后才打开工作区 = 首根落地,不提示
            firstWorkspaceRoot = root;
            return;
        }
        if (root === firstWorkspaceRoot) {
            return; // 加第二个文件夹等不改变首根的操作:不提示
        }
        log.info(vscode.l10n.t("Workspace root changed: {0} -> {1}", String(firstWorkspaceRoot), String(root)));
        buildWatchHandle.rebuild();                 // install/setup.bash watcher 跟新根
        void activate.refreshEnvironment(context);  // 新根重采集(env 域本身动态读根)
        reloadPrompt.noteRootChanged(firstWorkspaceRoot, root); // 提示重载(与门关提示共用冷却)
    }));

    // ④ 配置变化(env 字段;systemWatchFiles 列表变化另重建 ① 的 watcher)
    registerConfigListeners(context, envWatchHandle);

    // ⑤ 60 秒轮询(环境采集主干;P2 走全量刷新——翻转时组件自动装配/回收)
    registerEnvPollTimer(context);
}

/* ------------------------------------------------------------------ */
/* ⑤ 60 秒轮询                                                          */
/* ------------------------------------------------------------------ */

/** 环境轮询间隔(设计稿:60 秒只做 1 件事——采集 → 比较 → 写入/事件) */
const ENV_POLL_INTERVAL_MS = 60 * 1000;

/** 注册 60 秒环境轮询(P2:走全量刷新 source+context key+组件对账;翻转时状态栏等自动装配/回收) */
function registerEnvPollTimer(context: vscode.ExtensionContext): void {
    const timer = setInterval(() => {
        void activate.refreshEnvironment(context);
    }, ENV_POLL_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
