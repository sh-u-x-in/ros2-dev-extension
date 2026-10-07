// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * config/write 写侧出口(01 一键配置 + 02 工作包重命名,2026-09-03)。
 * 纯动作层(configure-actions / rename-actions,可无头测)与编排层(configure-file / package-rename,vscode)分离导出。
 */

export {
    planConfigure,
    detectRole,
} from "./configure-actions";
export type {
    ConfigurePlan,
    PlannedWrite,
    ConfigurePackage,
    ConsoleScriptTarget,
    BuildTypeName,
    Role,
    BuildTexts,
} from "./configure-actions";
export {
    configureFile,
    registerConfigureFileCommand,
    ConfigureFileCommand,
} from "./configure-file";
export {
    planRenameByFolder,
    validatePackageName,
} from "./rename-actions";
export type {
    RenamePlan,
    RenamePlanFile,
    RenameTargets,
} from "./rename-actions";
export {
    registerNameMismatchHandler,
    _resetRenameState,
} from "./package-rename";
export type { NameMismatchSource } from "./package-rename";

