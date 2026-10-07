// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * VS Code 中转壳聚合出口:所有 vscode 专有 API 绑定集中于此。
 * 业务层经此访问 VS Code,不直接 import vscode;host 整层可 mock。
 */

export * from "./commands";
export * from "./config";
export * from "./fs";
export * from "./tasks";
export * from "./terminal";
export * from "./window";
