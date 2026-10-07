// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file context.ts
 * webview 前端 VS Code API 句柄(2026-10-03 十二轮自 ros2_webview_main.ts 拆出)。
 * acquireVsCodeApi 全生命周期只允许调用一次——所有模块统一从此 import 同一常量,
 * 严禁在他处再次调用(二次调用抛异常)。
 */

// VS Code API declarations
declare function acquireVsCodeApi(): any;

// Acquire VS Code API once and cache it
export const vscode = acquireVsCodeApi();

// ==================================================================
// 诊断日志转发(十九轮批3 自 dom-utils 迁入:日志设施属 vscode 句柄层,非 DOM 工具):
// webview 的 console 在扩展"ROS 2"输出面板不可见,统一 postMessage 回扩展侧
// (backend case 'webviewLog' 落扩展日志通道)。
// ==================================================================
export function sendLog(level: "trace" | "debug" | "info" | "warn" | "error", message: string): void {
    try {
        vscode.postMessage({ command: "webviewLog", level, message });
    } catch {
        // 转发失败(webview 已销毁等)静默
    }
}
