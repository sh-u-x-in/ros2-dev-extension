// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * walk 层统一导出口(2026-08-30)。
 * 结构:walk/base/ = 原封装(零 vscode:walk-utils / ts-walk / walk-config / excluded-paths / path-exclude);
 *       walk-options.ts = 二次封装(依赖 vscode,自动读设置 + 默认排除 + 叠加额外排除)。
 * 调用方只需 import 本文件一个入口:
 *  - walkWithTimeout         :原封装(既有,逻辑不动)
 *  - walkOptions             :统一入口(二次封装)
 *  - path-exclude/excluded-paths:排除工具(由 walk 暴露,依赖方向 上层 → walk)
 *  - walk-config             :超时/深度配置
 */

// 原封装(./base/,零 vscode:既有转接层,native 优先/纯 TS 降级)
export { walkWithTimeout, WALK_FOLLOW_SYMLINKS_DEFAULT } from "./base/walk-utils";
export type { WalkOptions, WalkResult, FilePattern } from "./base/ts-walk";

// 配置(walk-config 既有导出)
export { getWalkTimeoutConfig, WALK_TIMEOUT_PROFILES } from "./base/walk-config";
export type { WalkSearchType, WalkTimeoutConfig, WalkTimeoutOverride } from "./base/walk-config";

// 排除工具(由 walk 暴露)
export { DEFAULT_EXCLUDED_DIR_NAMES, EXCLUDE_GLOB } from "./base/excluded-paths";
export { resolveExcludeFolders, isPathExcluded } from "./base/path-exclude";

// 统一入口(封装之上的封装:自动读设置 + 默认排除 + 叠加额外排除;二次封装,直接依赖 vscode)
export { walkOptions } from "./walk-options";
export type { WalkOptionsExtra } from "./walk-options";
