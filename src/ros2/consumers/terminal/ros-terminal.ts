// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros-terminal.ts
 * ROS 环境终端创建(命令 ROS2.createTerminal 的行为实现)。
 * 2026-08-26:自 src/ros2/utils.ts 的 createTerminal 迁入(utils.ts 整体废弃,见 utils.ts 头部说明)。
 * 依赖:Commands 常量 + composeApi.environment.getEnv() + host/terminal 薄壳(vscode 仅类型引用)。
 */

// 2026-08-26:仅类型引用(ExtensionContext/Terminal)—— 与文件头"不直接 import vscode"一致,零运行时依赖
import type * as vscode from "vscode";
// eslint-disable-next-line @typescript-eslint/no-var-requires -- l10n 值导入(2026-10-04 i18n 期2);类型引用仍走上一行 type-only
import { l10n } from "vscode";

// 2026-08-26:统一经 api/ 取实例(composeApi.environment.getEnv),不再直连环境域实现
import { composeApi } from "../../api";
import { createTerminal } from "../../host/terminal";

import { getLogger } from "../../../logger";

/** ROS 环境终端模块日志 */
const log = getLogger("ros-terminal");

/**
 * 创建并显示 ROS 环境终端(命令 ROS2.createTerminal)。
 * 行为与原 utils.createTerminal 等价:注入当前 env(source 结果)。
 * @param context 扩展上下文(原签名保留;实现不依赖它)
 */
export function createRosTerminal(context: vscode.ExtensionContext): vscode.Terminal {
    log.trace(l10n.t("Creating and showing ROS environment terminal"));

    const terminal = createTerminal({ name: "ros2", env: composeApi.environment.getEnv() });
    terminal.show();

    return terminal;
}
