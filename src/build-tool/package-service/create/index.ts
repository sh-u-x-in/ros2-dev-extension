// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * package-service/create 子域组装入口(2026-08-30 建立,commands 收编)。
 * 职责:对外暴露本子域能力(命令注册);2026-09-01 起由 extension 直连(不再经 commands/index.ts 转发)。
 */

export { registerCreatePackageCommands } from "./command/create-command";