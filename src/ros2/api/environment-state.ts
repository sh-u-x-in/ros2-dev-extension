// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file environment-state.ts
 * EnvironmentState 接口定义(环境能力:读 + 订阅 + 就绪)。
 * 接口定义占位(接口集中 api/,2026-08-25);实现后续接入:
 *   - 实现:src/ros2/environment/state.ts(当前为函数导出,后续标注为实现本接口)
 * 对外只读;写路径(setEnv / notifyEnvChanged / setProcessingWorkspace)不在接口内。
 */

// 2026-08-26:仅类型引用 —— api/ 层零 vscode 运行时依赖(类型擦除后可纯 Node 单测)
import type * as vscode from "vscode";

/** 环境能力接口:读当前 env / 可用性判定 / 就绪门控 / 变化订阅(需求 A2-A5) */
export interface EnvironmentState {
    /** 当前 env(source 结果;未 source 时为 undefined) */
    getEnv(): any | undefined;
    /** 环境不可用的具体原因(可用 → null;不可用 → 描述性字符串;2026-08-31 由 isAvailable 重设计) */
    getEnvIssue(): string | null;
    /** 等"至少完成一次 source";已就绪立即放行(取代旧 whenRosApiRefreshed) */
    whenReady(): Promise<void>;
    /** 环境变化订阅(source 完成后触发) */
    onEnvChanged(listener: () => void): vscode.Disposable;
    // 内部专用(不对消费者开放):setEnv / notifyEnvChanged / setProcessingWorkspace
}
