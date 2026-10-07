// Licensed under the MIT License.

/**
 * @file index.ts(2026-09-25 新增)
 * package-service/run 子域唯一对外出口(对齐 build/index.ts:外部一律经本文件 import,不再直连子文件)。
 * 职责:命令注册(registerRosRunCommands)、数据源工厂(createInstallTruthRunDataSource)、
 * 侧边栏树入口(runExecutableFromTree / launchFileFromTree)、命令 ID 常量。
 */

export { LaunchCommand, RunCommand } from "./command-ids";
export { isLaunchFileName, trimLaunchDisplayPrefix } from "./launch-detect";
export { createInstallTruthRunDataSource } from "./run-data-source";
export type { LaunchTarget, RunDataSource, RunTarget } from "./run-data-source";
export { registerRosRunCommands } from "./register-commands";
export { launchFileFromTree } from "./smart-launch";
export { runExecutableFromTree } from "./smart-run";
