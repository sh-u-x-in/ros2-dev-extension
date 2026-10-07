// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * package-service/build 子域组装入口(2026-08-30 建立,commands 收编;2026-08-31 收敛为唯一对外出口;
 * 2026-08-31 改名批次:内部文件全部按"名符其实"重命名,本出口的导出符号不变——外部零改动)。
 * 职责:对外暴露本子域全部能力——命令注册(registerColconCommands)、任务提供器注册
 * (registerBuildTaskProvider,门控注入用)、安装方式决策(resolveInstallType,跨域消费用)。
 * 原则:外部一律经本文件 import(不再直连子文件);内部文件仅被本子域互用。
 */

export { registerColconCommands } from "./register-commands";
export { registerBuildTaskProvider } from "./colcon-task-provider";
export { resolveInstallType } from "./install-type";
// 2026-09-25(第五批):单包构建公共执行体(包内容侧边栏"构建此包"经此接入)
export { buildSinglePackageByName } from "./single-package";
// 命令 ID 常量(注册者拥有,extension.Commands 引用保持一致——对齐 host/commands.ts 模式)
export { ColconToggleIgnoreCommand, ColconBuildPackageReleaseCommand, ColconBuildPackageDebugCommand, ColconBuildCommand } from "./command-ids";
