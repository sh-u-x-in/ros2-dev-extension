// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file window.ts
 * VS Code 中转壳 · 弹窗绑定壳:封装 showQuickPick / showInputBox / showInformationMessage /
 * showErrorMessage / setStatusBarMessage。
 * 薄适配,零业务逻辑;交互编排(命令注册/环境域)经此弹窗。
 */

import * as vscode from "vscode";

/** 快速选择(下拉;兼容 QuickPickItem[] 与 string[],与 vscode 原生重载一致) */
export function showQuickPick<T extends vscode.QuickPickItem | string>(
    items: T[] | Thenable<T[]>,
    options?: vscode.QuickPickOptions
): Thenable<T | undefined> {
    return vscode.window.showQuickPick(items as any, options) as Thenable<T | undefined>;
}

/** 输入框 */
export function showInputBox(options?: vscode.InputBoxOptions): Thenable<string | undefined> {
    return vscode.window.showInputBox(options);
}

/** 信息提示 */
export function showInformationMessage(
    message: string,
    ...items: string[]
): Thenable<string | undefined> {
    return vscode.window.showInformationMessage(message, ...items);
}

/** 错误提示 */
export function showErrorMessage(
    message: string,
    ...items: string[]
): Thenable<string | undefined> {
    return vscode.window.showErrorMessage(message, ...items);
}

/** 状态栏消息(可带超时;环境域 source 流程用) */
export function setStatusBarMessage(
    message: string,
    timeout?: number
): Thenable<void> {
    // 2026-09-13:setStatusBarMessage 重载不接受 undefined 第二参——未给超时走单参重载(语义同:不自动隐藏)
    const result = typeof timeout === "number"
        ? vscode.window.setStatusBarMessage(message, timeout)
        : vscode.window.setStatusBarMessage(message);
    return result as unknown as Thenable<void>;
}
