// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * 命令注册统一入口:按领域分发到各注册函数。
 */

import { getLogger } from "../logger";
import * as vscode from "vscode";

import { registerTerminalCommands } from "../ros2/registry/terminal";
import { registerCoreCommands } from "../ros2/registry/core";
import { registerTestCommands } from "./tests";
import { registerWelcomeCommand } from "./welcome";
// 2026-08-28:launch-tree 已废弃注释,配套命令注册(registerLaunchTreeCommands)一并移除
// 2026-08-30:create-package 命令注册收编至 package-service/create
// 2026-08-31:colcon 命令已直连(extension 直连 build/index.ts 并注入数据源,见 extension.ts)
// 2026-09-01:create 命令已直连(extension 直连 create/index.ts,与本文件脱钩,见 extension.ts)

/**
 * 注册扩展全部命令(按领域分组)。
 */
/** 扩展日志薄封装(带 commands 模块前缀) */
const log = getLogger("commands");

export function registerAllCommands(context: vscode.ExtensionContext): void {
    log.trace("Registering all extension commands");
    registerTerminalCommands(context);
    registerCoreCommands(context);
    registerTestCommands(context);
    registerWelcomeCommand(context);
    // 2026-08-28:registerLaunchTreeCommands 已移除(launch-tree 废弃)
    // 2026-08-31:registerColconCommands 已移出本文件(extension 直连注入,见 extension.ts)
    // 2026-09-01:registerCreatePackageCommands 已移出本文件(extension 直连,见 extension.ts)
}
