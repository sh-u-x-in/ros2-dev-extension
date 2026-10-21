// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file activate.ts
 * 环境激活(2026-08-28 第一阶段移动语义后:只留环境逻辑)。
 * source 环境 → 刷新 context(环境部分)→ 环境校验日志 → 环境组件订阅管理。
 *
 * 已移出(→ package-core/gate.ts 门控编排):
 *  - updateBuildTaskProviderRegistration(任务提供器注册,门槛&&(门户||倾向)判定)
 *  - syncPackagesState(包变化同步,包数 0↔N 翻转重装配)
 *  - assembleRosComponents 的包数据部分(包数翻转归 package-core 判定)
 * 门控(有合法工作包)由 package-core 判定;本模块只保留门槛(环境可用性)相关编排。
 * 2026-09-15:构建后刷新(refreshAfterBuild)由 register.ts 的 install/setup.bash 构建信号监听驱动。
 * 2026-10-18(P2):assembleRosComponents 重写为 **reconcileRosComponents 幂等 desired-state**——
 *  可用且已装配 / 不可用且已清空 → 跳过(修「可用期外部变化反复重建状态栏」),翻转才动手;
 *  传感器三路统一走 refreshEnvironment(修「轮询/shell 路径恢复环境不重装配」缺口);
 *  refreshAfterBuild 改签名(context;refreshEnvironment 后 merge,锁跳过也 merge——merge 自有环境门)。
 */

import * as vscode from "vscode";

import * as state from "./state";
import { getRosApiDeps } from "../api/ros-api-deps";
import { showErrorMessage } from "../host/window";
import { getWorkspaceRoot } from "../host/fs";
import { mergeCompileCommands } from "./compile-commands";

import { getLogger } from "../../logger";

import * as source from "./source";
import * as status from "./status";

/** 环境激活模块日志 */
const log = getLogger("activate");

/**
 * 最近一次 reconcile 结果(P2 幂等 desired-state):
 * null = 尚未对账;true = 已按"可用"装配;false = 已按"不可用"清空。
 */
let assembledUsable: boolean | null = null;

/** 环境组件订阅(reconcile 时清空重建;deactivate 收尾清空) */
let envSubscriptions: vscode.Disposable[] = [];

/** 清空并释放环境组件订阅(供 extension.deactivate 收尾调用) */
export function disposeEnvSubscriptions(): void {
    while (envSubscriptions.length > 0) {
        envSubscriptions.pop()?.dispose();
    }
    assembledUsable = null; // P2:清快照态,否则再激活会误判"已对账"而跳过装配
}

/** 注册一条环境组件订阅(reconcile/deactivate 时 dispose) */
export function addEnvSubscription(d: vscode.Disposable): void {
    envSubscriptions.push(d);
}

/**
 * 轻量环境刷新(环境域):source + context key + 组件对账。
 * P2:可用性翻转不再是重装配的必要条件——交给幂等 reconcile 按期望状态差量动手;
 * 传感器三路统一走本函数(轮询/shell/构建信号),翻转时状态栏等组件自动装配/回收。
 * 返回 true 表示本次 reconcile 实际动手(装配或回收)。
 */
export async function refreshEnvironment(context: vscode.ExtensionContext): Promise<boolean> {
    log.trace("Environment refresh: entering refreshEnvironment");
    if (state.isProcessing()) {
        log.debug("Environment refresh: already in progress, skipping re-entry");
        return false;
    }
    state.setProcessingWorkspace(true);
    try {
        await source.sourceRosAndWorkspace();
        await status.updateWorkspaceContextKeys();
        status.logRosEnvironmentStatus();
        // 幂等对账:可用→装配(已装则跳过);不可用→清空(已清则跳过)。
        // lockHeld=true:本函数已持 processingWorkspace 锁,reconcile 不再自行加解锁
        // (取代旧实现"先放锁再装配"的 hack)。
        return await reconcileRosComponents(context, { lockHeld: true });
    } catch (err) {
        log.error(vscode.l10n.t("Environment refresh failed: {0}", err instanceof Error ? (err.stack ?? err.message) : String(err)));
        return false;
    } finally {
        state.setProcessingWorkspace(false);
        // 至少完成一次环境刷新(无论成败):此后 rosApi 才可用(未 source 时拿不到真实现)。
        state.markReady();
    }
}

/**
 * 构建后刷新(触发源:register.ts 的 install/setup.bash 构建信号监听,1s 防抖):
 * 环境采集流水线(refreshEnvironment:source + context key + 组件对账)+ compile_commands 合并。
 * P2:改走全量刷新(修轮询类路径恢复环境不重装配的缺口);refreshEnvironment 因重入锁跳过时
 * 仍继续 merge——merge 自有环境门(compile-commands.ts),不会越门写盘。
 */
export async function refreshAfterBuild(context: vscode.ExtensionContext, workspaceRoot?: string): Promise<void> {
    await refreshEnvironment(context);
    mergeCompileCommands(workspaceRoot ?? getWorkspaceRoot() ?? "");
}

/**
 * 环境组件对账(P2 幂等 desired-state):按"当前环境可用性"把环境组件调到期望状态。
 *  - 可用且未装配 → 装配;不可用且未清空 → 回收;
 *  - 可用且已装配 / 不可用且已清空 → 跳过(可用期每次外部变化不再重建状态栏)。
 * 仅装配环境组件(状态栏监控);任务提供器注册与配置生成归 package-core 门控与上层编排。
 * @param opts.lockHeld 调用方已持 processingWorkspace 锁(refreshEnvironment 路径)时不再自行加解锁
 * @returns true = 本次实际动手(装配或回收)
 */
export async function reconcileRosComponents(
    context: vscode.ExtensionContext,
    opts?: { lockHeld?: boolean }
): Promise<boolean> {
    const usable = state.getEnvIssue() === null;
    // 幂等:已处于期望状态 → 跳过
    if (usable && assembledUsable === true) {
        log.trace("Environment reconcile: already in desired state (usable=true); skipped");
        return false;
    }
    if (!usable && assembledUsable === false) {
        log.trace("Environment reconcile: already in desired state (usable=false); skipped");
        return false;
    }
    const lockHeld = opts?.lockHeld === true;
    if (!lockHeld) {
        if (state.isProcessing()) {
            log.debug("Environment reconcile: already in progress, skipping re-entry");
            return false;
        }
        state.setProcessingWorkspace(true);
    }
    try {
        // 回收旧订阅(不可用分支这一步就是"清空")
        while (envSubscriptions.length > 0) {
            envSubscriptions.pop()?.dispose();
        }
        if (usable) {
            log.info(vscode.l10n.t("Activating ROS 2 workspace: {0}", getWorkspaceRoot()));
            envSubscriptions.push(getRosApiDeps().activateCoreMonitor());
            log.info("Environment activation completed");
        } else {
            log.debug(vscode.l10n.t("Environment reconcile: environment unavailable; disposed environment components"));
        }
        assembledUsable = usable;
        return true;
    } catch (err) {
        log.error(vscode.l10n.t("Environment component assembly failed: {0}", err instanceof Error ? (err.stack ?? err.message) : String(err)));
        void showErrorMessage(vscode.l10n.t("ROS 2 environment activation failed; see the output log for details."));
        return false;
    } finally {
        if (!lockHeld) {
            state.setProcessingWorkspace(false);
        }
    }
}

/**
 * 完整激活(启动):刷新环境 + 幂等组件对账。
 * P2:reconcile 已幂等——首次可用装配、首次不可用置"已清空"态,无需旧的"未翻转也强制装配"特判。
 */
export async function activateEnvironment(context: vscode.ExtensionContext): Promise<void> {
    log.trace("Full activation: entering activateEnvironment");
    await refreshEnvironment(context);
}
