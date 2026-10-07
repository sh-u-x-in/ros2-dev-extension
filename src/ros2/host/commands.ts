// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file commands.ts
 * VS Code 中转壳 · 命令绑定壳:封装 vscode.commands.executeCommand。
 * 薄适配,零业务逻辑;环境域 status 的 context key 设置等经此。
 *
 * 2026-08-26:命令 ID 常量定义收进 host/(vscode 交接面)。
 * status-bar 等消费者从本文件取命令 ID,不再硬编码/依赖顶层 extension.ts。
 */

import * as vscode from "vscode";

/* ================================================================== */
/* 命令 ID 常量(与 package.json contributes.commands 注册一致)          */
/* 2026-08-26 收进 host/(vscode 交接面):consumers/registry 取命令 ID   */
/* 从本文件,不再依赖顶层 extension.ts;extension.Commands 引用同一常量。 */
/* ================================================================== */

/** 显示 daemon 状态页 */
export const ShowDaemonStatusCommand = "ROS2.showDaemonStatus";
/** 创建 ROS 终端 */
export const CreateTerminalCommand = "ROS2.createTerminal";
/** ros2 run(上游遗留,deprecated) */
export const RunCommand = "ROS2.run";
/** ros2 launch(上游遗留,deprecated) */
export const LaunchCommand = "ROS2.launch";
/** rosdep(依赖安装) */
export const RosdepCommand = "ROS2.rosdep";
/** doctor(环境诊断) */
export const DoctorCommand = "ROS2.doctor";
/** 设置工作区/全局 context key(UI 可见性条件) */
export function setContext(key: string, value: unknown): Thenable<void> {
    return vscode.commands.executeCommand("setContext", key, value) as Thenable<void>;
}
