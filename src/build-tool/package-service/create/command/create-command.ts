// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file create-command.ts
 * 右键生成功能包命令注册(C++ / Python / 混合)(2026-08-30 自 src/commands/create-package.ts 收编,git mv 保留历史)。
 * 纯注册壳:交互层在 ./create-package-command.ts(弹窗收集 → 校验 → 生成器 → 写盘)。
 * 组装:经本子域 index.ts 导出,2026-09-01 起由 extension 直连(不再经 commands/index.ts 转发)。
 */

import { getLogger } from "../../../../logger";
import * as vscode from "vscode";

import { Commands, ensureErrorMessageOnException } from "../../../../extension";
import * as create_package_commands from "./create-package-command";

/** 扩展日志薄封装(带 commands-create-package 模块前缀) */
const log = getLogger("commands-create-package");

export function registerCreatePackageCommands(context: vscode.ExtensionContext): void {
    log.trace("注册创建功能包命令");
    // 右键生成包(C++ / Python / 混合)
    vscode.commands.registerCommand(Commands.CreateCppPackage, (uri?: vscode.Uri) => {
        ensureErrorMessageOnException(() => {
            log.trace(`执行命令:${Commands.CreateCppPackage}`);
            return create_package_commands.createCppPackage(uri);
        });
    });

    vscode.commands.registerCommand(Commands.CreatePythonPackage, (uri?: vscode.Uri) => {
        ensureErrorMessageOnException(() => {
            log.trace(`执行命令:${Commands.CreatePythonPackage}`);
            return create_package_commands.createPythonPackage(uri);
        });
    });

    vscode.commands.registerCommand(Commands.CreateMixedPackage, (uri?: vscode.Uri) => {
        ensureErrorMessageOnException(() => {
            log.trace(`执行命令:${Commands.CreateMixedPackage}`);
            return create_package_commands.createMixedPackage(uri);
        });
    });
}