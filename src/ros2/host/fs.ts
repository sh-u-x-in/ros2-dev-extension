// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file fs.ts
 * VS Code 中转壳 · 文件系统绑定壳:封装 vscode.workspace.createFileSystemWatcher。
 * 薄适配,零业务逻辑;环境域 overlay / shell 配置监听经此。
 */

import * as vscode from "vscode";

/** 创建文件系统监听器(glob 或 RelativePattern;调用方自行订阅 onDidChange/Create/Delete) */
export function createFileSystemWatcher(pattern: vscode.GlobPattern): vscode.FileSystemWatcher {
    return vscode.workspace.createFileSystemWatcher(pattern);
}

/** 当前工作区根目录(未打开工作区时为 undefined) */
export function getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** 工作区文件夹变化订阅 */
export function onDidChangeWorkspaceFolders(listener: (e: vscode.WorkspaceFoldersChangeEvent) => unknown): vscode.Disposable {
    return vscode.workspace.onDidChangeWorkspaceFolders(listener);
}
