// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file reload-prompt.ts(2026-10-18 P2)
 * 门关/换根的「重载窗口」提示(纯 UI 策略层;门的事实归 state.ts)。
 *  - 门关提示:连续采集失败达阈值(RELOAD_PROMPT_THRESHOLD;关门本身首次失败即生效、不放松,
 *    本阈值只管弹窗打扰频率)且过冷却才弹;
 *  - 换根提示:与门关提示共用同一冷却(同一会话不连续打扰);
 *  - 非模态 [立即重载][稍后];「稍后」= 惰性兜底(所有出口有门),不写任何状态;
 *  - 恢复(noteSuccess)只清提示挂起态、不弹 info(裁定:静默恢复+日志),冷却时间戳保留——
 *    它防的是打扰频率,与环境成败无关。
 *  本模块绝不抛异常:调用方在采集失败路径内,抛错会被外层 catch 二次进入失败出口。
 */

import * as vscode from "vscode";

import { getLogger } from "../../logger";

/** 重载提示模块日志 */
const log = getLogger("reload-prompt");

/** 连续失败提示阈值(次;state.recordCollectionFailure 的返回值达到该值才允许弹窗) */
export const RELOAD_PROMPT_THRESHOLD = 2;
/** 提示冷却(门关与换根两类提示共用;弹出时写入) */
export const RELOAD_PROMPT_COOLDOWN_MS = 10 * 60 * 1000;

let lastPromptAt: number | undefined; // 上次弹窗时刻(冷却起点;弹出时写入,不随成功清除)
let promptInFlight = false;           // 通知尚未被关闭/选择,防重复弹

/** 时钟(可注入替换,便于无头测试冷却) */
let now = (): number => Date.now();

/** 【测试专用】注入时钟 */
export function _setNowForTest(fn: () => number): void {
    now = fn;
}

/** 【测试专用】重置全部提示态 */
export function _resetForTest(): void {
    lastPromptAt = undefined;
    promptInFlight = false;
    now = (): number => Date.now();
}

/** 冷却是否已过 */
function cooldownElapsed(): boolean {
    return lastPromptAt === undefined || now() - lastPromptAt >= RELOAD_PROMPT_COOLDOWN_MS;
}

/** 弹一次重载提示(共用骨架;按钮 [立即重载][稍后];稍后/关闭=仅解除挂起态) */
function promptReload(message: string): void {
    lastPromptAt = now();
    promptInFlight = true;
    const RELOAD = vscode.l10n.t("Reload Window");
    const LATER = vscode.l10n.t("Later");
    void vscode.window.showWarningMessage(message, RELOAD, LATER).then((choice) => {
        promptInFlight = false;
        if (choice === RELOAD) {
            log.info(vscode.l10n.t("User chose to reload the window"));
            void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
    }, () => {
        promptInFlight = false; // 通知被关闭(未选择)= 继续「稍后」语义
    });
}

/**
 * 采集失败上报:连续失败达阈值且冷却已过 → 弹重载提示(一次)。
 * @param streak 连续失败次数(state.recordCollectionFailure 返回值)
 * @param reason 最近一次失败原因(进消息)
 * @param envEverUsable 本窗口会话是否曾成功采集过(调用方由 state.getEnv()!==undefined 传入;
 *        2026-10-19 误报根治:从未可用=稳态(状态栏+门已表达,reload 无可清理),不弹——
 *        「此前可用」文案只对真实损坏成立。不写冷却时间戳:后续真损坏仍能即时弹)
 */
export function noteFailure(streak: number, reason: string, envEverUsable: boolean): void {
    try {
        if (!envEverUsable) {
            log.debug(vscode.l10n.t("Environment never collected successfully in this window; reload prompt suppressed (last error: {0})", reason));
            return;
        }
        if (streak < RELOAD_PROMPT_THRESHOLD || promptInFlight || !cooldownElapsed()) {
            return;
        }
        log.warn(vscode.l10n.t("ROS 2 environment refresh failed {0} times in a row; last error: {1}", String(streak), reason));
        promptReload(vscode.l10n.t(
            "The ROS 2 environment looks broken on this machine (it worked before; latest error: {0}). Reload the window to restart everything in a clean state; choosing Later keeps running with all ROS 2 features gated off.",
            reason));
    } catch (err) {
        promptInFlight = false;
        log.warn(vscode.l10n.t("Reload prompt failed: {0}", err instanceof Error ? err.message : String(err)));
    }
}

/** 采集成功上报:清提示挂起态(冷却时间戳保留) */
export function noteSuccess(): void {
    promptInFlight = false;
}

/**
 * 工作区首根变更上报:提示重载(package-core/IntelliSense/构建信号监听绑定旧根,重载才能干净重绑)。
 * 与门关提示共用冷却;「稍后」= 旧根继续惰性兜底(环境采集与侧边栏本身动态跟新根)。
 */
export function noteRootChanged(previousRoot: string | undefined, nextRoot: string | undefined): void {
    try {
        if (promptInFlight || !cooldownElapsed()) {
            return;
        }
        promptReload(vscode.l10n.t(
            "The workspace root changed from {0} to {1}. Reload the window to rebind package scanning and IntelliSense to the new root.",
            String(previousRoot ?? "(none)"), String(nextRoot ?? "(none)")));
    } catch (err) {
        promptInFlight = false;
        log.warn(vscode.l10n.t("Reload prompt failed: {0}", err instanceof Error ? err.message : String(err)));
    }
}
