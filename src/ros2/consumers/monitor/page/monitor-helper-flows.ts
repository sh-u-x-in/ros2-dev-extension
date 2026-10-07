// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file monitor-helper-flows.ts
 * 常驻助手启停流程(2026-10-03 十二轮自 ros2-monitor.ts 拆出):
 * startHelper/stopHelper 消息的完整执行链——postMessage 阶段播报 → 启停命令 →
 * 等待上线/离线确认 → 结果发布 → 触发一次全量刷新。脚本路径由 launchMonitor 注入。
 */

import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { composeApi } from "../../../api";
import { describeHelperState, startParamHelper, stopParamHelper } from "../helper/param-helper-client";
import { requestRefresh } from "./monitor-refresh";

import { getLogger } from "../../../../logger";

/** 核心状态页模块日志 */
const log = getLogger("ros2-monitor");

/** 状态页消费者对象(确认窗内反复 ping 助手) */
const monitorApi = composeApi.monitorApi;

/** 助手脚本绝对路径(launchMonitor 以 extensionPath 注入;startHelperFlow 使用) */
let helperScript = "";

/** 助手脚本路径注入(launchMonitor 面板创建时调用) */
export function setHelperScriptPath(scriptPath: string): void {
    helperScript = scriptPath;
}

/** 延时工具(ms) */
function delayMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待助手达到期望在线状态(启动/停止助手后确认;ping 常驻助手进程)。
 * 窗口 15s——本机 Python 进程启动 ~1s,助手初始化 rclpy 另有 DDS 收敛抖动。
 */
async function waitForHelperState(expected: boolean, timeoutMs = 15000): Promise<boolean> {
    // 真值比较(2026-09-26 修复):ping 响应曾以真值字符串("pong")上抛,严格 === 使
    // 健康助手的确认窗永远失败(页面却经刷新链的真值判断"突然翻转");归一后双口径一致
    const t0 = Date.now();
    let running = !!(await monitorApi.helper_running());
    while (running !== expected && Date.now() - t0 < timeoutMs) {
        await delayMs(200);
        running = !!(await monitorApi.helper_running());
    }
    return running === expected;
}

export async function startHelperFlow(panel: vscode.WebviewPanel) {
    const t0 = Date.now();
    log.info(vscode.l10n.t("startHelper request received; starting the resident helper"));
    try {
        panel.webview.postMessage({
            helperAction: 'starting',
            message: vscode.l10n.t('Starting the resident helper…'),
            isRunning: false
        });

        startParamHelper(helperScript);
        log.info(vscode.l10n.t("Helper start command issued ({0} ms); waiting for the helper to come online...", Date.now() - t0));

        const online = await waitForHelperState(true);
        if (!online) {
            const snapshot = describeHelperState();
            log.warn(vscode.l10n.t("Helper start command issued but the helper did not come online within {0} ms; client state: {1}; helper-side log: {2}", Math.round(Date.now() - t0), snapshot, path.join(os.tmpdir(), "rde_param_helper.log")));
            panel.webview.postMessage({
                helperAction: 'error',
                message: vscode.l10n.t("Start command finished but the helper did not come online in time (if it comes up later the state flips automatically). Client state: {0}", snapshot),
                isRunning: false,
            });
            return;
        }
        log.info(vscode.l10n.t("Helper confirmed online ({0} ms); posting started", Date.now() - t0));
        panel.webview.postMessage({
            helperAction: 'started',
            message: vscode.l10n.t('Resident helper started'),
            isRunning: true,
        });
        requestRefresh(0);
    } catch (error) {
        log.info(vscode.l10n.t("Failed to start the helper ({0} ms): {1}", Date.now() - t0, error instanceof Error ? (error.stack ?? error.message) : String(error)));
        panel.webview.postMessage({
            helperAction: 'error',
            message: vscode.l10n.t("Failed to start the helper: {0}", error),
            isRunning: false,
        });
    }
}

export async function stopHelperFlow(panel: vscode.WebviewPanel) {
    const t0 = Date.now();
    log.info(vscode.l10n.t("stopHelper request received; stopping the resident helper"));
    try {
        panel.webview.postMessage({
            helperAction: 'stopping',
            message: vscode.l10n.t('Stopping the resident helper…'),
            isRunning: true
        });

        stopParamHelper();
        log.info(vscode.l10n.t("Helper stop command issued ({0} ms); waiting for the helper to go offline...", Date.now() - t0));

        const offline = await waitForHelperState(false);
        if (!offline) {
            log.warn(vscode.l10n.t("Helper stop command issued but the helper did not go offline within {0} ms", Math.round(Date.now() - t0)));
            panel.webview.postMessage({
                helperAction: 'error',
                message: vscode.l10n.t('Stop command finished but the helper is still responding (it may still be exiting; please wait)'),
                isRunning: true,
            });
            return;
        }
        log.info(vscode.l10n.t("Helper confirmed offline ({0} ms); posting stopped", Date.now() - t0));
        panel.webview.postMessage({
            helperAction: 'stopped',
            message: vscode.l10n.t('Resident helper stopped'),
            isRunning: false,
        });
        requestRefresh(0);
    } catch (error) {
        log.info(vscode.l10n.t("Failed to stop the helper ({0} ms): {1}", Date.now() - t0, error instanceof Error ? (error.stack ?? error.message) : String(error)));
        panel.webview.postMessage({
            helperAction: 'error',
            message: vscode.l10n.t("Failed to stop the helper: {0}", error),
            isRunning: true,
        });
    }
}
