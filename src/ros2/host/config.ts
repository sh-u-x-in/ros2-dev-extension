// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file config.ts
 * VS Code 中转壳 · 设置读取绑定壳:封装 vscode.workspace.getConfiguration("ROS2")。
 * 薄适配,零业务逻辑;业务层经此读设置,不直接 import vscode(可 mock 测试)。
 */

import * as vscode from "vscode";

/** 读取设置(带默认值)——类型化 */
export function getConfig<T>(key: string, defaultValue: T): T;
/** 读取设置(无默认)——可能 undefined */
export function getConfig<T>(key: string): T | undefined;
export function getConfig<T>(key: string, defaultValue?: T): T | undefined {
    const config = vscode.workspace.getConfiguration("ROS2");
    return defaultValue === undefined
        ? config.get<T>(key)
        : config.get<T>(key, defaultValue);
}

/** 更新设置(默认写入工作区配置；透传 VS Code update 返回值) */
export function updateConfig(key: string, value: any, configurationTarget?: vscode.ConfigurationTarget, overrideInLanguage?: boolean): Thenable<void> {
    return vscode.workspace.getConfiguration("ROS2").update(key, value, configurationTarget, overrideInLanguage);
}


/** 设置变化订阅(用户改设置时触发) */
export function onConfigChanged(listener: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(listener);
}
