// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros-api-deps.ts
 * RosApiDeps 接口定义：环境域需要使用上层 UI 能力时的注入边界。
 * 由组合根（extension.ts）注入实现；environment 只依赖本接口 type。
 *
 * 2026-08-25 收尾：ROSApi 已废弃删除，原 selectRosApi（实现选型）与
 * setContext（env 快照注入）随之移除——命令域 Ros2ServiceApi 无占位/真实之分，
 * env 由 CommandRunner 从 state 实时取，均不再需要注入。仅保留 activateCoreMonitor
 * （状态栏监控，环境重装配时挂生命周期）。
 */

// 2026-08-26:仅类型引用 —— api/ 层零 vscode 运行时依赖(类型擦除后可纯 Node 单测)
import type * as vscode from "vscode";

/** 环境域所需的注入能力（注入实现；未注入时 no-op 兜底） */
export interface RosApiDeps {
    /** 启动状态栏监控，返回 Disposable 归环境订阅生命周期管理 */
    activateCoreMonitor(): vscode.Disposable;
}

let deps: RosApiDeps = {
    activateCoreMonitor: () => ({ dispose: () => undefined }),
};

/** 注入 RosApiDeps 实现（extension 激活前调用；替换 no-op 兜底） */
export function setRosApiDeps(d: RosApiDeps): void {
    deps = d;
}

/** 读取 RosApiDeps 实现（environment 内部使用） */
export function getRosApiDeps(): RosApiDeps {
    return deps;
}
