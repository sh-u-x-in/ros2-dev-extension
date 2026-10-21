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
import {
    describeHelperState, helperFailureSignal, startParamHelper, stopParamHelper,
} from "../helper/param-helper-client";
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

/** 确认窗三态(2026-10-18):ok=达成期望;timeout=超时;tripped=熔断(带首因);
 *  superseded=已被更新的启动/停止接管(调用方必须静默退出,不得再向页面发任何文案)。 */
export type HelperWaitStatus = "ok" | "timeout" | "tripped" | "superseded";
export interface HelperWaitResult {
    status: HelperWaitStatus;
    reason?: string;
}
/** 失败探针形态(=client.helperFailureSignal 的返回) */
export type HelperFailureProbe = () => ReturnType<typeof helperFailureSignal>;

/**
 * 等待助手达到期望在线状态(启动/停止助手后确认;ping 常驻助手进程)。
 * 窗口 15s——本机 Python 进程启动 ~1s,助手初始化 rclpy 另有 DDS 收敛抖动。
 *
 * 三态与探针(2026-10-18,事故「熔断后傻等 15s 报误导性超时」根治):
 *  - failureProbe 每轮轮询后判定,熔断/接管即刻返回,不陪跑满 15s;
 *  - 达成期望后再复查一次(熔断恰在成功判定后落地的窄窗);
 *  - timeoutMs 与 runningProbe 参数化=测试缝(无头注入假探针/假 ping)。
 */
export async function waitForHelperState(
    expected: boolean,
    timeoutMs = 15000,
    failureProbe?: HelperFailureProbe,
    runningProbe: () => Promise<boolean> = () => monitorApi.helper_running()
): Promise<HelperWaitResult> {
    // 真值比较(2026-09-26 修复):ping 响应曾以真值字符串("pong")上抛,严格 === 使
    // 健康助手的确认窗永远失败(页面却经刷新链的真值判断"突然翻转");归一后双口径一致
    const tripCheck = (): HelperWaitResult | undefined => {
        const sig = failureProbe?.();
        if (!sig) {
            return undefined;
        }
        return sig.kind === "tripped" ? { status: "tripped", reason: sig.reason } : { status: "superseded" };
    };
    const pre = tripCheck();
    if (pre) {
        return pre;
    }
    const t0 = Date.now();
    let running = !!(await runningProbe());
    while (running !== expected && Date.now() - t0 < timeoutMs) {
        await delayMs(200);
        const tripped = tripCheck();
        if (tripped) {
            return tripped;
        }
        running = !!(await runningProbe());
    }
    if (running !== expected) {
        return { status: "timeout" };
    }
    const late = tripCheck();
    if (late) {
        return late;
    }
    return { status: "ok" };
}

export async function startHelperFlow(panel: vscode.WebviewPanel) {
    const t0 = Date.now();
    log.info(vscode.l10n.t("startHelper request received; starting the resident helper"));
    // P4 平台白名单门(2026-10-18 用户裁定):linux/darwin 放行,其余(一切 Windows——
    // process.platform 对任何 Windows 版本/分支/架构均返回 win32——及 freebsd/aix/未来
    // 新平台值)一律拒绝;WSL 判 linux 不误伤。文案平台中性+「未来可能支持」口径。
    // 助手 POSIX 绑定(/tmp socket/fcntl/AF_UNIX),任何 Windows 原生环境物理不可用。
    if (process.platform !== "linux" && process.platform !== "darwin") {
        log.warn(vscode.l10n.t("Helper start refused: platform {0} is not supported yet", process.platform));
        panel.webview.postMessage({
            helperAction: 'error',
            message: vscode.l10n.t("The resident helper is not supported on this platform yet (Linux/macOS only); it may be supported in a future release."),
            isRunning: false,
        });
        return;
    }
    // P4 环境门(入口):门关一句拒绝(带原因),不进入 starting 播报与 15s 在线等待——
    // 此前的路径是无环境时"点了没反应+15s 空转+后台重试风暴"的源头
    const envIssue = composeApi.environment.getEnvIssue();
    if (envIssue !== null) {
        log.warn(vscode.l10n.t("Helper start refused at entry: {0}", envIssue));
        panel.webview.postMessage({
            helperAction: 'error',
            message: vscode.l10n.t("No usable ROS 2 environment detected; cannot start the helper. Reason: {0}", envIssue),
            isRunning: false,
        });
        return;
    }
    try {
        panel.webview.postMessage({
            helperAction: 'starting',
            message: vscode.l10n.t('Starting the resident helper…'),
            isRunning: false
        });

        const generation = startParamHelper(helperScript);
        log.info(vscode.l10n.t("Helper start command issued ({0} ms); waiting for the helper to come online...", Date.now() - t0));

        const result = await waitForHelperState(true, 15000, () => helperFailureSignal(generation));
        if (result.status === "tripped") {
            // 熔断原因已由 failureCallback 直达页面(ros2-monitor 装配),此处只终结流程——
            // 再发"未在预期时间内上线"会把真原因覆盖成误导文案(2026-10-18 事故现场)
            log.warn(vscode.l10n.t("Helper start aborted (failure breaker): {0}", result.reason ?? ""));
            return;
        }
        if (result.status === "superseded") {
            log.info(vscode.l10n.t("Helper start flow superseded by a newer start/stop request"));
            return;
        }
        if (result.status === "timeout") {
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

        const result = await waitForHelperState(false);
        if (result.status !== "ok") {
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
