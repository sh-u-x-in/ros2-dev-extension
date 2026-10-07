// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from "path";
import * as fs from "fs";
import { promises as fsPromises } from "fs";
import * as child_process from "child_process";
import * as vscode from "vscode";
import * as net from 'net';

import { getLogger } from "./logger";

// walk 层统一导入口(2026-08-30:排除工具/常量/配置归 walk,经 index barrel 对外;统一入口 walkOptions 读设置在 walk-options.ts)
import {
    WALK_FOLLOW_SYMLINKS_DEFAULT,
    getWalkTimeoutConfig,
    WalkSearchType,
    WalkTimeoutConfig,
    WalkTimeoutOverride,
} from "./build-tool/walk";
import {
    checkExternallyManagedEnvironment,
    getPackageInfo as commonGetPackageInfo,
    isLldbExtensionInstalled as commonIsLldbInstalled,
    isCppToolsExtensionInstalled as commonIsCppToolsInstalled,
    isPythonExtensionInstalled as commonIsPythonInstalled,
    isCursorEditor as commonIsCursorEditor,
    showOutputPanelIfConfigured,
    IPackageInfo as CommonIPackageInfo
} from "@ranchhandrobotics/rde-common";

export type IPackageInfo = CommonIPackageInfo;

/** 工具模块日志 */
const log = getLogger("vscode-utils");

export function getExtensionConfiguration(): vscode.WorkspaceConfiguration {
    const rosConfigurationName: string = "ROS2";
    return vscode.workspace.getConfiguration(rosConfigurationName);
}

/**
 * 读取统一搜索符号跟随设置(ROS2.search.followSymlinks,默认见 WALK_FOLLOW_SYMLINKS_DEFAULT)。
 * 所有走自定义 walk 的搜索点共用此单一出处(替代各点内联 cfg.get),避免默认值漂移。
 */
export function readFollowSymlinksSetting(): boolean {
    return getExtensionConfiguration().get<boolean>("search.followSymlinks", WALK_FOLLOW_SYMLINKS_DEFAULT) === true;
}

/**
 * 读取统一搜索超时/深度配置(ROS2.search.walkTimeouts 数组覆盖;未配置项用内置默认)。
 * 设置优先于内置默认(walk-config.ts),各搜索点按类型取最终配置(每次现读,设置变化即时生效,无需失效缓存)。
 */
export function readWalkTimeoutConfig(type: WalkSearchType): WalkTimeoutConfig {
    const userOverrides = getExtensionConfiguration().get<WalkTimeoutOverride[]>("search.walkTimeouts", []);
    return getWalkTimeoutConfig(type, userOverrides);
}

export function createOutputChannel(): vscode.LogOutputChannel {
    return vscode.window.createOutputChannel("ROS 2", { log: true });
}

/**
 * Shows the output panel if ui.autoShowOutput is enabled (default: true).
 * @param outputChannel The output channel to show
 */
export function showOutputPanel(outputChannel: vscode.OutputChannel): void {
    showOutputPanelIfConfigured(outputChannel, "ROS2", "ui.autoShowOutput");
}

/**
 * Checks if the Python environment is externally managed (PEP 668).
 * This is common in Ubuntu 24.04+ and other modern Linux distributions.
 */
export async function checkExternallyManagedEnvironmentInternal(env: any): Promise<boolean> {
    return checkExternallyManagedEnvironment(env);
}

/**
 * Check if a file or directory exists.
 */
async function exists(filePath: string): Promise<boolean> {
    try {
        await fsPromises.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// (2026-08-30)路径排除工具已归位 walk 层并经上方 import 使用;外部消费方请直接 import "./build-tool/walk"。
// (2026-08-31)workspaceContainsPackageXml 已删——包判定收编 package-core/api 的 probeValidWorkspacePackages
// (onboarding 改用之;context key 改组合根反应式),本工具模块不再耦合 package-core 缓存内部。

/**
 * Extracts package metadata from an extension's package.json
 */
export function getPackageInfo(extensionId: string): IPackageInfo | undefined {
    return commonGetPackageInfo(extensionId);
}

/**
 * Detects if the vadimcn.vscode-lldb extension is installed
 * @returns true if the LLDB extension is installed, false otherwise
 */
export function isLldbExtensionInstalled(): boolean {
    return commonIsLldbInstalled();
}

/**
 * Detects if the Microsoft C/C++ extension is installed
 * @returns true if the C/C++ extension is installed, false otherwise
 */
export function isCppToolsExtensionInstalled(): boolean {
    return commonIsCppToolsInstalled();
}

/**
 * Detects if the Microsoft Python extension is installed
 * @returns true if the Python extension is installed, false otherwise
 */
export function isPythonExtensionInstalled(): boolean {
    return commonIsPythonInstalled();
}

/**
 * 检测 ms-python.debugpy(现代 ms-python 的调试器载体)。
 *
 * 2026-09-13(扩展 API 核查):`ms-python.python` 已**不再自带** debugpy,其
 * `debug.getDebuggerPackagePath()` 是转发给本扩展的(缺失时返回空串);即 Python 调试器
 * 实际由 `ms-python.debugpy` 提供,package.json 的 extensionDependencies 已声明它。
 * 本函数只用于**软性提示**(旧版 ms-python 自带 debugpy,硬失败会误伤)。
 */
export function isDebugpyExtensionInstalled(): boolean {
    return vscode.extensions.getExtension("ms-python.debugpy") !== undefined;
}

/**
 * Detects if running in Cursor editor
 * @returns true if running in Cursor, false otherwise
 */
export function isCursorEditor(): boolean {
    return commonIsCursorEditor();
}

export async function findAvailablePort(startPort: number = 3005, maxAttempts: number = 100): Promise<number> {
    for (let port = startPort; port < startPort + maxAttempts; port++) {
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    throw new Error(vscode.l10n.t("No free port found in range {0}-{1}", startPort, startPort + maxAttempts - 1));
}

/**
 * Check if a port is available
 * @param port Port number to check
 * @returns Promise that resolves to true if port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();

        server.once('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false); // Port is in use
            } else {
                resolve(false); // Other error, assume not available
            }
        });

        server.once('listening', () => {
            server.close();
            resolve(true); // Port is available
        });

        server.listen(port, '127.0.0.1');
    });
}

/**
 * Compare two semantic versions
 * @param ignorePatch If true, compare only major/minor components and ignore patch differences.
 * @returns -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string, ignorePatch: boolean = false): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    const maxParts = ignorePatch
        ? 2
        : Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxParts; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;

        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
    }

    return 0;
}