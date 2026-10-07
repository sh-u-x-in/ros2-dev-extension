// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file monitor-html.ts
 * 核心状态页 HTML 模板(2026-10-03 十二轮自 ros2-monitor.ts 拆出):
 * <head> 引入外部 stylesheet 与 webview 打包脚本,内联 <style> 由
 * monitor-css-base.ts + monitor-css-forms.ts 两段拼接(行序与拆分前一致)。
 * HTML 以经典 <script src> 加载经典脚本(webpack 产物 ros2_webview_main.js,无顶层导出)。
 *
 * i18n(2026-10-04 期4,用户裁定方案 B):静态文案在宿主侧经 vscode.l10n.t 取串
 * (英文源+中文册);动态串由前端 t() 查 window.__I18N(宿主按 VS Code 显示语言
 * 注入 zh-cn 册或空表,见 ros2-monitor.ts buildWebviewI18nScript)。
 */

import * as vscode from "vscode";

import { MONITOR_CSS_BASE } from "./monitor-css-base";
import { MONITOR_CSS_FORMS } from "./monitor-css-forms";

/** 状态页完整 HTML(stylesheet/script 由 launchMonitor 经 asWebviewUri 注入;i18nScript 为 window.__I18N 注入段,可为空串) */
export function getCoreStatusWebviewContent(stylesheet: vscode.Uri, script: vscode.Uri, i18nScript: string): string {
    return `
<!DOCTYPE html>
<html lang="en">

<head>
    <link rel="stylesheet" href="${stylesheet.toString()}" />
    <script>${i18nScript}</script>
    <script src="${script.toString()}"></script>
    <style>
${MONITOR_CSS_BASE}
${MONITOR_CSS_FORMS}
    </style>
</head>

<body>
    <div class="menu-bar">
        <button id="helper-toggle-btn" class="menu-button">${vscode.l10n.t("Start Helper")}</button>
        <span class="info-icon">ⓘ<span class="info-tip">${vscode.l10n.t("How to open: click the ROS distribution tag on the bottom status bar, or the Command Palette (Ctrl+Shift+P) -> \"ROS2: Show Status\".\nTop button: start / stop the resident helper (the extension's own rclpy resident process that talks to node services directly, without the ros2 daemon). It must be started before this page can fetch data.\nIf startup fails or the helper keeps exiting, check the diagnostics in the \"ROS 2\" output channel.")}</span></span>
        <span id="helper-status-message" class="status-message"></span>
        <span id="helper-status-badge"></span>
    </div>

        <!-- 2026-09-26:生命周期子区原并入系统信息 section(两态模型);
             2026-10-03 十七轮:独立生命周期区块取消,生命周期内容并入节点区
             (节点行尾 ▸/▾ 展开),由前端 renderNodesSection 动态构建,静态模板仅保留数据容器 -->
        <div class="section">
            <h3>${vscode.l10n.t("System info")}<span class="info-icon">ⓘ<span class="info-tip">${vscode.l10n.t("Lists the currently running lifecycle nodes, nodes, topics, services and parameters in real time (event-driven refresh).\nNodes: running nodes and their namespaces; lifecycle node rows expand (▸/▾) into a state graph. Topics / services: communication topic and service names with their types. Parameters: node name -> typed parameter values.\nNo data? Click the button above to start the helper first.")}</span></span></h3>
            <div id="topics"><p class="offline-hint">${vscode.l10n.t("Connecting to the helper… (when the helper is not running, click the button above to start it; nodes / topics / services / parameters appear here)")}</p></div>
            <div id="services"></div>
            <div id="parameters"></div>
        </div>
</body>

</html>
`;
}
