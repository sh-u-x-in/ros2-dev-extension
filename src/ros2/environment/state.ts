// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file state.ts
 * 实现 EnvironmentState 接口(api/environment-state.ts):环境状态唯一事实源
 * (需求 A2/A3/A4/A5):env / 防重入锁 / 变化事件 / 就绪门控。
 * 写路径(setEnv / notifyEnvChanged / setProcessingWorkspace / markReady)仅环境域内部调用,
 * 外部只读(getEnv / getEnvIssue / onEnvChanged / whenReady)。
 * 2026-08-31:isAvailable 重设计为 getEnvIssue(返回 string | null)——布尔判定 + 详细原因合一。
 * 取代旧 `extension.env` 公共状态与 `whenRosApiRefreshed` 门控。
 */

import * as vscode from "vscode";

import type { EnvironmentState } from "../api/environment-state";

let env: any | undefined;              // 当前 env(source 结果)
let processingWorkspace = false;       // 防重入锁(环境激活流程用)
let ready = false;                     // 是否已完成至少一次 source
let readyWaiters: Array<() => void> = [];
const envChangedEmitter = new vscode.EventEmitter<void>();

/** 已知 ROS 2 发行版名(用于可用性判定与发行版校验日志;ROS 1 发行版不在列) */
export const KNOWN_ROS2_DISTROS = new Set([
    "dashing", "eloquent", "foxy", "galactic", "humble", "iron",
    "jazzy", "kilted", "lyrical"
]);

// ── 只读(外部可用) ──

/** 当前 env(source 结果;未 source 时为 undefined) */
export function getEnv(): any | undefined {
    return env;
}

/**
 * 环境不可用的具体原因(可用 → null;不可用 → 描述性字符串)。
 * 2026-08-31:由 isAvailable() 重设计而来(改名字 + 彻底改造)——布尔判定与详细原因合一,
 * 调用方可直接把返回值拼进 UI 提示;需要布尔时用 `=== null` 判定。
 * 判定(与旧 isRosEnvAvailable 口径一致):
 * ① env 缺失(未成功 source:脚本缺失 / 执行失败 / 返回空);
 * ② ROS_DISTRO 非已知 ROS 2 发行版名(如 jazzy);
 * ③ ROS_VERSION(主版本号 1/2)为空。
 */
export function getEnvIssue(): string | null {
    if (!env) {
        return vscode.l10n.t("Environment not sourced successfully (script missing / execution failed / empty environment returned)");
    }
    if (typeof env.ROS_DISTRO !== "string" || env.ROS_DISTRO.length === 0 || !KNOWN_ROS2_DISTROS.has(env.ROS_DISTRO)) {
        return vscode.l10n.t("ROS_DISTRO is not a known ROS 2 distribution: {0}", String(env.ROS_DISTRO));
    }
    if (typeof env.ROS_VERSION !== "string" || env.ROS_VERSION.length === 0 || env.ROS_VERSION !== "2") {
        return vscode.l10n.t("ROS_VERSION is not 2: {0}", String(env.ROS_VERSION));
    }
    return null;
}

/** 订阅环境变化(source 完成后广播) */
export const onEnvChanged: vscode.Event<void> = envChangedEmitter.event;

/** 等"至少完成一次 source";已就绪立即放行(取代旧 whenRosApiRefreshed) */
export function whenReady(): Promise<void> {
    if (ready) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        readyWaiters.push(resolve);
    });
}

/**
 * 等 env 就绪并返回当前 env(旧 extension.resolvedEnv 语义,2026-08-25 收进环境域)。
 * env 已就绪立即返回;未就绪则等待下一次环境变化且 env 非 undefined 后返回。
 */
export function resolvedEnv(): Promise<any | undefined> {
    const current = getEnv();
    if (current !== undefined) {
        return Promise.resolve(current);
    }
    return new Promise((resolve) => {
        const d = onEnvChanged(() => {
            const env = getEnv();
            if (env !== undefined) {
                d.dispose();
                resolve(env);
            }
        });
    });
}

// ── 内部专用(仅环境域 source/activate 流程调用) ──

/** 设置 env(仅 source 流程写入) */
export function setEnv(newEnv: any): void {
    env = newEnv;
}

/** 环境变化通知(source 完成后广播) */
export function notifyEnvChanged(): void {
    envChangedEmitter.fire();
}

/** 防重入锁(激活流程用) */
export function isProcessing(): boolean {
    return processingWorkspace;
}

/** 设置防重入锁(仅内部) */
export function setProcessingWorkspace(v: boolean): void {
    processingWorkspace = v;
}

/** 标记"至少完成一次 source"(幂等;source 流程 finally 调用,取代旧 markRosApiRefreshed) */
export function markReady(): void {
    if (ready) {
        return;
    }
    ready = true;
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) {
        w();
    }
}

/** 【测试专用】重置到初始态 */
export function _resetForTest(): void {
    env = undefined;
    processingWorkspace = false;
    ready = false;
    readyWaiters = [];
}

/** 环境状态实现:实现 EnvironmentState 接口(getEnv/getEnvIssue/whenReady/onEnvChanged) */
export const environmentState: EnvironmentState = {
    getEnv,
    getEnvIssue,
    whenReady,
    onEnvChanged,
};
