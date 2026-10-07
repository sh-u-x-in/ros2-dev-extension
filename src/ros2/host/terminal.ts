// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file terminal.ts
 * VS Code 中转壳 · 终端创建绑定壳:封装 vscode.window.createTerminal。
 * 薄适配,零业务逻辑;A8 终端 profile / 交互终端(A7 废弃)经此。
 */

import * as vscode from "vscode";

export { detectUserShell, ShellInfo } from "@ranchhandrobotics/rde-common";


export interface CreateTerminalOptions {
    name?: string;
    /** shell 可执行文件(2026-09-27 注入终端用:配合 shellArgs 指定 bash);缺省用默认 profile */
    shellPath?: string;
    cwd?: string;
    env?: Record<string, string>;
    /** shell 启动参数(2026-09-27 终端注入用:如 bash --rcfile 预载命令);缺省用默认 profile 参数 */
    shellArgs?: string[];
}

/** 创建带指定 env 的终端(默认名 "ros2") */
export function createTerminal(options?: CreateTerminalOptions): vscode.Terminal {
    return vscode.window.createTerminal({
        name: options?.name ?? "ros2",
        shellPath: options?.shellPath,
        cwd: options?.cwd,
        env: options?.env,
        shellArgs: options?.shellArgs,
    });
}
