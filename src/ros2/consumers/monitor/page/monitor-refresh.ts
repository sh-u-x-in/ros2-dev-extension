// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file monitor-refresh.ts
 * 核心状态页 · 投影器(2026-10-06 纯推送架构终态)。
 *
 * 职责收缩为三件事:①登记面板;②订阅仓库变更(monitor-api 入库后 markDirty);
 * ③把 projectFrame() 的投影帧 postMessage 给 webview(可去抖,无任何取数)。
 * 旧"刷新编排"(refreshNow/去抖合并/防重叠/尾随补跑/快慢帧/批量错峰)随纯推送
 * 架构整体退役——数据真相在服务端,本地仓库是投影,投影是纯函数,没有状态机。
 */

import * as vscode from "vscode";

import { composeApi } from "../../../api";
import { onStoresChanged } from "../monitor-api";

import { getLogger } from "../../../../logger";

/** 核心状态页模块日志 */
const log = getLogger("ros2-monitor");

/** 投影去抖(仓库事件风暴合并;纯内存投影本身亚毫秒,去抖只为减少 postMessage) */
const PROJECT_DEBOUNCE_MS = 100;

// Global variable to track the existing panel
let existingPanel: vscode.WebviewPanel | undefined;

/** 投影合并定时器 */
let projectTimer: NodeJS.Timeout | undefined;

/** 面板单例写入(launchMonitor 创建面板后登记;投影域以此为准) */
export function setActivePanel(panel: vscode.WebviewPanel): void {
    existingPanel = panel;
}

/** 面板单例读取(launchMonitor 前置复用判断) */
export function getActivePanel(): vscode.WebviewPanel | undefined {
    return existingPanel;
}

/** 面板关闭清理(onDidDispose:单例与未决定时器一并撤销) */
export function clearActivePanel(): void {
    existingPanel = undefined;
    if (projectTimer) {
        clearTimeout(projectTimer);
        projectTimer = undefined;
    }
}

/** 仓库变更 → 投影(去抖;监听在模块加载时注册,投影器与面板解耦) */
onStoresChanged(() => {
    if (!existingPanel || projectTimer) {
        return;
    }
    projectTimer = setTimeout(() => {
        projectTimer = undefined;
        projectNow();
    }, PROJECT_DEBOUNCE_MS);
});

/**
 * 投影(原 refreshNow 整体退役):把 monitor-api 的仓库状态 postMessage 给 webview。
 * 仓库未就绪(助手未连接/快照未到)由 projectFrame 自行表达(ready:false 或空帧)。
 */
function projectNow(): void {
    const panel = existingPanel;
    if (!panel) {
        return;
    }
    try {
        const frame = composeApi.monitorApi.projectFrame();
        void panel.webview.postMessage(frame);
    } catch (err) {
        log.error(`projection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * 刷新请求入口(语义=立即投影一次;保留旧名以减少调用方改动:
 * webviewReady/启停流程/转换回执等"数据面变了"的时刻都会走到这里)。
 */
export function requestRefresh(_delayMs = 0): void {
    if (!existingPanel) {
        return;
    }
    if (projectTimer) {
        clearTimeout(projectTimer);
        projectTimer = undefined;
    }
    projectNow();
}
