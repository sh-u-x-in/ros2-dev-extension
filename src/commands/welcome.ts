// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file welcome.ts
 * 欢迎演练命令注册。
 */

import { getLogger } from "../logger";
import * as vscode from "vscode";

import { Commands, ensureErrorMessageOnException } from "../extension";
import { WALKTHROUGH_ID } from "../onboarding";

/** 扩展日志薄封装(带 commands-welcome 模块前缀) */
const log = getLogger("commands-welcome");

export function registerWelcomeCommand(context: vscode.ExtensionContext): void {
    log.trace("Registering welcome walkthrough command");
    vscode.commands.registerCommand(Commands.ShowWelcome, () => {
        ensureErrorMessageOnException(() => {
            log.trace(vscode.l10n.t("Executing command: {0}", Commands.ShowWelcome));
            vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID);
        });
    });
}
