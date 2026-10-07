// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file command-ids.ts(2026-08-31 git mv 自 commands.ts:旧名与 register-commands.ts 仅差单复数,难辨"常量表"与"注册逻辑")。
 * colcon 命令 ID 常量(2026-08-31 自 extension.Commands 下沉,对齐 ros2/host/commands.ts 的
 * ShowDaemonStatusCommand 模式:注册者拥有命令 ID,组合根(extension.Commands)引用同一常量,
 * 防止 build 域反向依赖 extension)。与 package.json contributes.commands 注册一致。
 */

/** 切换 COLCON_IGNORE 忽略状态(右键文件夹) */
export const ColconToggleIgnoreCommand = "ROS2.colcon.toggleIgnore";
/** 右键单包构建 Release */
export const ColconBuildPackageReleaseCommand = "ROS2.colcon.buildPackageRelease";
/** 右键单包构建 Debug */
export const ColconBuildPackageDebugCommand = "ROS2.colcon.buildPackageDebug";
/** 智能构建(Ctrl+Shift+B / 命令面板) */
export const ColconBuildCommand = "ROS2.colcon.build";
