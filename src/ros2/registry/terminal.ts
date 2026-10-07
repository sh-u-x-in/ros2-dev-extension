// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file terminal.ts
 * 终端与调试设置命令注册。
 * 2026-08-26:自 src/commands/terminal.ts 收进 ros2/ 域(registry 注册层);
 */

import { getLogger } from "../../logger";
import * as vscode from "vscode";

import { ensureErrorMessageOnException } from "../../error-utils";
import { CreateTerminalCommand } from "../host/commands";
import { createRosTerminal } from "../consumers/terminal/ros-terminal";

/** 扩展日志薄封装(带 commands-terminal 模块前缀) */
const log = getLogger("commands-terminal");

export function registerTerminalCommands(context: vscode.ExtensionContext): void {
    log.trace(vscode.l10n.t("Registering terminal commands"));
    vscode.commands.registerCommand(CreateTerminalCommand, () => {
        ensureErrorMessageOnException(() => {
            log.trace(vscode.l10n.t("Executing command: {0}", CreateTerminalCommand));
            createRosTerminal(context);
        });
    });

    // 2026-09-22:GetDebugSettings 及其注册已随整套调试链路删除(见 工作交接/已废弃-调试/)
}