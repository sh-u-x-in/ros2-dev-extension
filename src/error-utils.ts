// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file error-utils.ts
 * 共享错误处理基础设施(2026-08-28 自 extension.ts 下沉)。
 * 目的:断 ros2/registry → extension 的反向依赖(最底层依赖顶层入口);
 * 命令注册层(registry / commands)从本文件取,不再 import extension.ts。
 */

import * as vscode from "vscode";

/** 包裹命令 handler:异常统一弹窗(命令注册统一错误出口) */
export async function ensureErrorMessageOnException(callback: (...args: any[]) => any) {
    try {
        await callback();
    } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
}
