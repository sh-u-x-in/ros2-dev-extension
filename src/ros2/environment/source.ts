// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file source.ts
 * 环境采集与写入(2026-09-15 环境体系重设计:"单次链式采集 + 路径剔除比较")。
 *
 * 流程:采集完整快照(系统 + 工作空间一次 source 链,见 env-collect)→ 验货 → 与上一轮比较:
 *  - 快照有变化 → 写入 env(工作空间引起的变化也写入);
 *  - 外部环境(剔除工作空间路径后)有变化,或可用性翻转(可用↔不可用边沿)→ 触发环境变化事件;
 *    本工作空间引起的变化不算外部变化、不触发(其通知由 package-core 侧负责)。
 * 失败(验货未通过):保留旧快照不写,但置快照陈旧标志(getEnvIssue 转为陈旧原因,所有环境门随之关闭)——
 * 可用→不可用的翻转边沿补发事件(修「失败不发事件 ⇒ 旧快照永久陈真」),连续失败只首轮发(无事件风暴)。
 *
 * 触发(共用同一流程,自带防重入):启动 / 配置变化 / shell 配置变化 / 60 秒轮询 / 构建信号。
 */

import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

import { getConfig } from "../host/config";
import { createFileSystemWatcher, getWorkspaceRoot } from "../host/fs";
import { collectEnvironmentSnapshot } from "./env-collect";
import { externalChanged, snapshotChanged } from "./env-compare";
import * as state from "./state";
import * as reloadPrompt from "./reload-prompt";

import { getLogger } from "../../logger";

/** 环境加载模块日志 */
const log = getLogger("source");











/** 环境采集防重入标志(全部触发源共用) */
let collectInProgress = false;

/**
 * 采集并刷新环境(唯一流程):单次链式采集(系统 + 工作空间)→ 快照变化写入 env;
 * 外部变化或可用性翻转触发事件。失败(验货未通过)保留旧快照不写,置陈旧标志(见 handleCollectionFailure)。
 */
export async function sourceRosAndWorkspace(): Promise<void> {
    if (collectInProgress) {
        log.debug("Environment collection: already collecting, skipping re-entry");
        return;
    }
    collectInProgress = true;
    const prevUsable = state.getEnvIssue() === null;
    try {
        const result = await collectEnvironmentSnapshot();
        if (!result.env) {
            handleCollectionFailure(prevUsable, result.reason ?? vscode.l10n.t("no reason given"));
            return;
        }
        state.clearStale();
        state.recordCollectionSuccess();   // 连续失败计数清零(P2:供重载提示层)
        reloadPrompt.noteSuccess();        // 清提示挂起态(静默恢复,不弹 info——用户裁定)
        const prev = state.getEnv();
        const next = result.env;
        const workspaceRoot = getWorkspaceRoot() ?? "";
        if (snapshotChanged(prev, next)) {
            state.setEnv(next);
            log.debug("Environment snapshot updated (written to env)");
        } else {
            log.trace("Environment snapshot unchanged; skipping write");
        }
        const nextUsable = state.getEnvIssue() === null;
        if (externalChanged(prev, next, workspaceRoot) || envVerdictFlipped(prevUsable, nextUsable)) {
            log.info("External environment changed; firing environment-changed event");
            state.notifyEnvChanged();          // debugger 等依赖该事件(extension.onDidChangeEnv 转发)
        } else {
            log.trace("External environment unchanged; no event fired");
        }
    } catch (err) {
        // 兜底:不向调用方抛异常,保留旧 env,按采集失败置陈旧
        log.error(vscode.l10n.t("Environment collection error: {0}", err instanceof Error ? (err.stack ?? err.message) : String(err)));
        handleCollectionFailure(prevUsable, err instanceof Error ? err.message : String(err));
    } finally {
        collectInProgress = false;
    }
}

/**
 * 采集失败统一处置(两个失败出口共用):置陈旧标志;
 * 可用→不可用翻转边沿补发事件(构建任务门/context key/配置生成等订阅方随事件翻转,零改动生效),
 * 连续失败只首轮 warn + 事件,其余降噪留痕。
 */
function handleCollectionFailure(prevUsable: boolean, reason: string): void {
    state.markStale(reason);
    // P2:连续失败计数 + 重载提示(阈值只管弹窗频率;关门已由上方 markStale 无条件生效)。
    // envEverUsable=本会话曾成功采集(env 仅成功路径写入)——从未可用不弹重载提示(2026-10-19 误报根治)
    const streak = state.recordCollectionFailure();
    reloadPrompt.noteFailure(streak, reason, state.getEnv() !== undefined);
    if (prevUsable) {
        log.warn(vscode.l10n.t("Environment collection failed; snapshot marked stale: {0}", reason));
        state.notifyEnvChanged();
    } else {
        log.debug(vscode.l10n.t("Environment collection failed, keeping old snapshot: {0}", reason));
    }
}

/** 可用性翻转边沿检测(可用↔不可用):采集流程据此决定是否补发事件 */
export function envVerdictFlipped(prevUsable: boolean, nextUsable: boolean): boolean {
    return prevUsable !== nextUsable;
}



/** shell 配置监听句柄(2026-09-28 生效时机一致化:rebuild = 按当前设置列表重建全部 watcher) */
export interface SystemEnvWatchHandle {
    rebuild(): void;
    dispose(): void;
}

/**
 * 注册 shell 配置文件监听(env.systemWatchFiles):改动即触发一轮环境采集(提前触发,60 秒轮询兜底)。
 * 在扩展组件装配阶段调用;context.subscriptions 只挂总 dispose,watcher 列表自管 ——
 * 设置列表变化经 handle.rebuild() 按新列表重建(此前仅在激活时按旧列表创建,改列表不生效)。
 * Windows 返回 undefined(无 bashrc 概念,pixi 场景)。
 */
export function registerSystemEnvWatch(
    context: vscode.ExtensionContext,
    // P2 传感器统一:刷新动作由 register.ts 注入(默认=直接采集;注入后走 refreshEnvironment 全量刷新,
    //  修「轮询/shell 路径恢复环境不重装配状态栏」缺口)。回调注入而非本模块 import activate——避免 source→activate 环。
    refresh: () => void = () => { void sourceRosAndWorkspace(); }
): SystemEnvWatchHandle | undefined {
    if (process.platform === "win32") {
        return undefined; // Windows 无 bashrc 概念(pixi 场景)
    }

    let debounceTimer: NodeJS.Timeout | undefined;
    const scheduleRefresh = (changedFile: string): void => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            log.debug(vscode.l10n.t("Shell config file changed; triggering environment collection: {0}", changedFile));
            refresh();
        }, 1500);                             // 1.5s 防抖(编辑保存连发多次 change)
    };

    let watchers: vscode.FileSystemWatcher[] = [];
    const disposeAll = (): void => {
        for (const w of watchers) {
            w.dispose();
        }
        watchers = [];
    };

    const build = (): void => {
        disposeAll();
        const watchFiles = getConfig<string[]>("env.systemWatchFiles", [
            "~/.bashrc", "~/.bash_profile", "~/.profile", "~/.zshrc",
        ]);
        const home = os.homedir();
        const absPaths = watchFiles
            .filter((f) => f && f.trim().length > 0)
            .map((f) => (f.startsWith("~/") || f === "~")
                ? path.join(home, f === "~" ? "" : f.slice(2))
                : f);

        let registeredCount = 0;
        for (const abs of absPaths) {
            const dir = path.dirname(abs);
            const base = path.basename(abs);
            if (!dir || !base) {
                log.debug(vscode.l10n.t("Invalid shell config path; skipping watch: {0}", abs));
                continue;
            }
            try {
                const watcher = createFileSystemWatcher(
                    new vscode.RelativePattern(dir, base)
                );
                watcher.onDidChange((uri) => scheduleRefresh(uri.fsPath));
                watcher.onDidCreate((uri) => scheduleRefresh(uri.fsPath));
                watcher.onDidDelete((uri) => scheduleRefresh(uri.fsPath));
                watchers.push(watcher);
                registeredCount++;
            } catch (err) {
                // 单个文件监听失败不中断整体注册,跳过并留痕
                log.warn(vscode.l10n.t("Failed to register shell config watcher; skipping: {0} ({1})", abs, err instanceof Error ? err.message : String(err)));
            }
        }
        log.debug(vscode.l10n.t("System-level shell config watchers registered: {0} ({1} in total)", absPaths.join(", "), registeredCount));
    };

    build();
    context.subscriptions.push({ dispose: disposeAll });
    return { rebuild: build, dispose: disposeAll };
}
