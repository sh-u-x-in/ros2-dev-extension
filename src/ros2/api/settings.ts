// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file settings.ts
 * SettingsProvider 接口定义 + ExtensionSettings 强类型快照(需求 F:设置交接)。
 * 接口定义占位(接口集中 api/,2026-08-25);实现后续接入:
 *   - 实现:src/ros2/config/settings.ts(与 VS Code 交接,类型化 + 默认值 + 变化订阅)
 * ExtensionSettings 字段按 package.json contributes.configuration 补齐(TODO)。
 * 2026-09-22:colcon.build 快照去掉拆轴前的三选一 `installMode: "merge" | "symlink" | "isolated"`
 *   (把两个正交维度压成一个枚举)与 package.json 里并不存在的 `parallel` / `verbose`,
 *   改为两个轴各自对应真实设置键:`installMethod`(轴 1,2026-09-29 三值化)·`installLayout`(轴 2)。
 */

// 2026-08-26:仅类型引用 —— api/ 层零 vscode 运行时依赖(类型擦除后可纯 Node 单测)
import type * as vscode from "vscode";

// 安装布局枚举的唯一来源(与 ColconInstallType 同词;2026-09-22 起快照不再自造枚举)
import type { ColconInstallLayout } from "./ros-task-runner";

/** walk 超时覆盖项(形状权威来源 = build-tool/walk/base/walk-config.ts 的同名类型;此处仅类型镜像) */
export interface WalkTimeoutOverride {
    type: "default" | "message" | "test" | "xacro" | "package";
    totalTimeoutMs?: number;
    branchTimeoutMs?: number;
    maxDepth?: number;
}

/** 强类型设置快照(字段与 package.json contributes.configuration 对齐;未全列字段待补齐) */
export interface ExtensionSettings {
    pixiRoot: string;
    colcon: {
        build: {
            allowEmptyWorkspace: boolean;
            followSymlinks: boolean;
            walkTimeouts: WalkTimeoutOverride[];
            packageCacheRefreshMs: number;
            /** 轴 1 · 安装形态(键:ROS2.build.installMethod):auto=平台默认(Windows 拷贝/其余符号)/ symlink / copy(显式优先于平台) */
            installMethod: "auto" | "symlink" | "copy";
            /** 轴 2 · 安装布局(键:ROS2.build.installLayout):auto=平台默认(Windows 合并/其余分包)/ merged / isolated */
            installLayout: "auto" | ColconInstallLayout;
        };
    };
    cpp: {
        intellisenseEngine: "auto" | "cpptools" | "clangd" | "both" | "none";
    };
    buildExcludeFolders: string[];
    // ...(按 package.json 实际配置补齐)
}

/** 与 VS Code 交接:读取扩展设置(ROS2.* 前缀),类型化 + 默认值 + 变化订阅 */
export interface SettingsProvider {
    /** 类型化读取单键,带默认值(推荐) */
    get<T>(key: string, defaultValue: T): T;
    /** 类型化读取单键,无默认(可能 undefined) */
    get<T>(key: string): T | undefined;
    /** 强类型快照:一次读取全量设置(避免分散 get;字段缺失用默认值兜底) */
    snapshot(): ExtensionSettings;
    /** 设置变化订阅(用户改设置 → 触发;key 为变化项) */
    onDidChange(listener: (key: string) => void): vscode.Disposable;
}
