// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file setup-script.ts
 * 环境域的环境脚本相关工具：读取 ROS setup 脚本路径、执行 setup 脚本、探测发行版。
 * 从 vscode-utils / ros2-utils 迁入，环境域不再通过 vscode-utils 间接依赖 build-tool。
 * 仅依赖 host/config、host/terminal、rde-common 与 vscode。
 */

import * as path from "path";
import * as vscode from "vscode";
import { promises as fsPromises } from "fs";

import { getLogger } from "../../logger";
import { getConfig } from "../host/config";
import { detectUserShell } from "../host/terminal";
import {
    getSetupScriptExtension,
    sourceSetupFile as commonSourceSetupFile,
    SourceSetupOptions,
} from "@ranchhandrobotics/rde-common";

/** 环境脚本模块日志 */
const log = getLogger("environment-setup-script");

/** 复用 rde-common 的脚本扩展名工具 */
export { getSetupScriptExtension };

/**
 * 第三方 source 输出映射规则:锚定整句正则 + 由捕获组回填的中文模板。
 * kind: whole=整句替换；prefix=只换前缀、正文原样(P2)。
 */
interface SourceOutputRule {
    pattern: RegExp;                              // 锚定整句正则,必须 /^...$/
    toTemplate: (m: RegExpMatchArray) => string;  // 由捕获组拼出中文
    kind: "whole" | "prefix";                    // whole=整句替换；prefix=只换前缀、正文原样(P2)
    hitCount?: number;                            // 命中计数,用于版本漂移监测
}

// 有序映射表:匹配顺序即数组顺序(先 prefix 前缀类,再 whole 整句类)
const sourceOutputRules: SourceOutputRule[] = [
    // P2 前缀类:只换前缀,正文(捕获组)原样回填
    { pattern: /^Shell stdout: ([\s\S]*)$/, kind: "prefix", toTemplate: m => vscode.l10n.t("Shell stdout: {0}", m[1]) },
    { pattern: /^Shell stderr: ([\s\S]*)$/, kind: "prefix", toTemplate: m => vscode.l10n.t("Shell stderr: {0}", m[1]) },
    // 整句类:按模板整体替换为中文
    { pattern: /^Sourcing Environment using (.+?): (.*)$/, kind: "whole", toTemplate: m => vscode.l10n.t("Sourcing Environment using {0}: {1}", m[1], m[2]) },
    { pattern: /^Successfully parsed (\d+) environment variables$/, kind: "whole", toTemplate: m => vscode.l10n.t("Successfully parsed {0} environment variables", m[1]) },
    { pattern: /^Shell sourcing error: ([\s\S]*)$/, kind: "whole", toTemplate: m => vscode.l10n.t("Shell sourcing error: {0}", m[1]) },
    { pattern: /^Failed to cleanup temporary files: ([\s\S]*)$/, kind: "whole", toTemplate: m => vscode.l10n.t("Failed to cleanup temporary files: {0}", m[1]) },
    { pattern: /^Created temporary batch file: ([\s\S]*)$/, kind: "whole", toTemplate: m => vscode.l10n.t("Created temporary batch file: {0}", m[1]) },
    { pattern: /^Failed to create temporary batch file: ([\s\S]*)$/, kind: "whole", toTemplate: m => vscode.l10n.t("Failed to create temporary batch file: {0}", m[1]) },
    { pattern: /^Cleaned up temporary batch file: ([\s\S]*)$/, kind: "whole", toTemplate: m => vscode.l10n.t("Cleaned up temporary batch file: {0}", m[1]) },
    { pattern: /^Cleaned up pixi temporary batch file: ([\s\S]*)$/, kind: "whole", toTemplate: m => vscode.l10n.t("Cleaned up pixi temporary batch file: {0}", m[1]) },
    { pattern: /^Failed to parse environment variables: ([\s\S]*)$/, kind: "whole", toTemplate: m => vscode.l10n.t("Failed to parse environment variables: {0}", m[1]) },
];

/**
 * 将第三方库(@ranchhandrobotics/rde-common)sourceSetupFile 的英文输出映射为中文。
 * 纯函数、无副作用；未知消息原样放行(P3)。
 */
function translateSourceOutput(message: string): string {
    if (!message || message.trim().length === 0) {
        return message;
    }
    for (const rule of sourceOutputRules) {
        const m = rule.pattern.exec(message);
        if (m) {
            if (rule.hitCount !== undefined) {
                rule.hitCount += 1;
            }
            return rule.toTemplate(m);
        }
    }
    return message;
}

/**
 * Gets the ROS setup script path from user settings with Windows default for Pixi.
 * Returns the full path to the setup script that should be sourced.
 */
export function getRosSetupScript(): string {
    const rosSetupScript = getConfig("env.setupScript", "");

    // First, handle workspace folder variable substitution if present
    const regex = /\$\{workspaceFolder\}/g;
    if (rosSetupScript.includes("${workspaceFolder}")) {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length >= 1) {
            const wsFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
            return path.normalize(rosSetupScript.replace(regex, wsFolder));
        }
        // If workspace folder variable is present but no workspace is open, return empty
        return "";
    }

    // If still empty after substitution, check for pixiRoot default
    if (!rosSetupScript) {
        // pixiRoot 平台默认:仅 Windows 空配置时回退 c:\pixi_ws；其他平台空则不做推导
        // (与 sourceSetupFile 同口径,对齐 package.json 声明文案 "Windows 上为空时默认回退 c:\pixi_ws")
        const pixiRoot = getConfig("env.pixiRoot", "")
            || (process.platform === "win32" ? "c:\\pixi_ws" : "");
        if (pixiRoot) {
            const shellInfo = detectUserShell();
            const setupFileName = `local_setup${shellInfo.scriptExtension}`;
            const pixiRosPath = process.platform === "win32"
                ? path.join(pixiRoot, "ros2-windows")
                : pixiRoot;
            return path.normalize(path.join(pixiRosPath, setupFileName));
        }
        // No pixiRoot configured - return empty string to indicate no default
        return "";
    }

    // Normalize path separators for current platform
    return path.normalize(rosSetupScript);
}

/**
 * Executes a setup file and returns the resulting env.
 * This wraps the common sourceSetupFile with ROS-specific logging.
 */
export function sourceSetupFile(filename: string, env?: any): Promise<any> {
    log.trace(vscode.l10n.t("Loading environment setup script: {0}", filename));
    // pixiRoot 平台默认:仅 Windows 空配置时回退 c:\pixi_ws；其他平台空则传空串(不做推导)
    const pixiRoot = getConfig("env.pixiRoot", "")
        || (process.platform === "win32" ? "c:\\pixi_ws" : "");

    const options: SourceSetupOptions = {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        pixiRoot,
        onOutput: (message: string) => {
            log.debug(translateSourceOutput(message));
        }
    };

    return commonSourceSetupFile(filename, env, options);
}

/**
 * Gets the names of installed distros.
 */
export async function getDistros(): Promise<string[]> {
    log.trace("Getting list of installed ROS distributions");
    try {
        const stats = await fsPromises.stat("/opt/ros");
        if (stats.isDirectory()) {
            const distros = await fsPromises.readdir("/opt/ros");
            log.debug(vscode.l10n.t("Detected distributions: {0}", distros.join(", ")));
            return distros;
        }
        // /opt/ros 存在但不是目录(非标准安装布局),返回空
        return [];
    } catch (error) {
        // /opt/ros 不存在(非 Linux/未安装),返回空
        log.debug(vscode.l10n.t("/opt/ros not accessible; returning empty list: {0}", error instanceof Error ? error.message : String(error)));
        return Promise.resolve([]);
    }
}