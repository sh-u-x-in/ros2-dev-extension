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
 *  - needsReassemble / recordAssemblyState 的包数部分
 *  - assembleRosComponents 的包数据部分(getPackages 扫描 / hasCachedPackages 门户 / createConfigFiles / maintainIncludeConfigs)
 * 门控(有合法工作包)由 package-core 判定;本模块只保留门槛(环境可用性)相关编排。
 * 2026-08-31:onDidEndTask 编译后刷新监听已移除;
 * 2026-09-15:构建后刷新(refreshAfterBuild)由 register.ts 的 install/setup.bash 构建信号监听单独驱动;
 *  refreshOverlayAfterBuild 更名并升级语义为“环境采集流水线 + compile_commands 合并”。
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

/** 最近一次组件装配时的环境可用性(用于检测可用/不可用翻转,门槛域) */
let lastEnvAvailable = false;

/** 记录当前组件装配状态快照(仅环境可用性;包数翻转已移入 package-core/gate.ts) */
function recordAssemblyState(): void {
    lastEnvAvailable = state.getEnvIssue() === null;
}

/** 是否需要重装配环境组件:仅环境可用性翻转(门槛翻转;包数翻转归 package-core 门控) */
function needsReassemble(): boolean {
    return (state.getEnvIssue() === null) !== lastEnvAvailable;
}

/** 环境组件订阅(activate 专属,重装配时清空重建;取代旧 extension.subscriptions) */
let envSubscriptions: vscode.Disposable[] = [];

/** 清空并释放环境组件订阅(供 extension.deactivate 收尾调用) */
export function disposeEnvSubscriptions(): void {
    while (envSubscriptions.length > 0) {
        envSubscriptions.pop()?.dispose();
    }
}

/** 注册一条环境组件订阅(环境重装配/deactivate 时 dispose;取代旧 extension.subscriptions.push) */
export function addEnvSubscription(d: vscode.Disposable): void {
    envSubscriptions.push(d);
}

/**
 * 轻量环境刷新(环境域):source + context key + 门槛翻转检测。
 * 不清空 subscriptions、不重注册组件;环境可用性翻转时自动触发环境组件重装配。
 * 返回 true 表示本次已触发环境组件重装配。
 * (包数翻转检测与任务提供器注册已移入 package-core/gate.ts,由上层编排者订阅门控事件执行。)
 * 入口:启动 / 配置变化(C1) / bashrc 变化(P3-3)。
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

        if (state.getEnvIssue() !== null) {
            log.debug("Environment refresh: ROS environment unavailable");
            status.logRosEnvironmentStatus();
            // 环境从可用→不可用:需要清空组件
            if (lastEnvAvailable) {
                log.debug("Environment availability available->unavailable; clearing components");
                await assembleRosComponents(context);
                return true;
            }
            return false;
        }

        status.logRosEnvironmentStatus();

        // 环境可用性翻转 → 环境组件重装配(门槛域;包数翻转由上层订阅 package-core 门控处理)
        if (needsReassemble()) {
            log.debug("Environment availability flipped; re-assembling environment components");
            // 先释放本函数持有的 processingWorkspace 锁,否则 assembleRosComponents
            // 被自身锁门控直接"跳过重入",组件永远不装配(refreshEnvironment 的 finally 兜底释放)
            state.setProcessingWorkspace(false);
            await assembleRosComponents(context);
            return true;
        }
        log.debug("Environment refresh completed (no availability flip)");
        return false;
    } catch (err) {
        log.error(vscode.l10n.t("Environment refresh failed: {0}", err instanceof Error ? (err.stack ?? err.message) : String(err)));
        return false;
    } finally {
        state.setProcessingWorkspace(false);
        // 至少完成一次环境刷新(无论成败):此后 rosApi 才可用(未 source 时拿不到真实现)。
        // 开闸让等待 whenRosApiRefreshed 的调用方(如 package-map 系统包列表)放行。
        state.markReady();
    }
}

/**
 * 构建后刷新(触发源:register.ts 的 install/setup.bash 构建信号监听,1s 防抖):
 * 环境采集流水线(系统 + 工作空间单次链式采集与比较,source.ts)+ compile_commands 合并。
 */
export function refreshAfterBuild(): void {
    void (async () => {
        await source.sourceRosAndWorkspace();
        mergeCompileCommands(getWorkspaceRoot() ?? "");
    })();
}

/**
 * 环境组件重装配:清空旧的环境相关订阅并重建。
 * 仅在启动 / 环境可用性翻转时调用(包数 0↔N 翻转由上层订阅 package-core 门控处理)。
 * 仅装配环境组件(状态栏监控 / 编译后刷新监听);任务提供器注册与配置生成归 package-core 门控与上层编排。
 */
export async function assembleRosComponents(context: vscode.ExtensionContext): Promise<void> {
    log.trace("Environment component assembly: entering assembleRosComponents");
    if (state.isProcessing()) {
        log.debug("Environment component assembly: already in progress, skipping re-entry");
        return;
    }
    state.setProcessingWorkspace(true);
    try {
        // 清空旧的环境相关订阅
        while (envSubscriptions.length > 0) {
            envSubscriptions.pop()?.dispose();
        }

        // 环境不可用:无组件可装
        if (state.getEnvIssue() !== null) {
            recordAssemblyState();
            log.debug("Environment component assembly: ROS environment unavailable, nothing to assemble");
            return;
        }

        log.info(vscode.l10n.t("Activating ROS 2 workspace: {0}", getWorkspaceRoot()));
        envSubscriptions.push(getRosApiDeps().activateCoreMonitor());

        // 编译后刷新(overlay + compile_commands 合并)由 register.ts 的 install/** watcher 驱动,
        // 不在环境组件装配内注册(onDidEndTask 链已于 2026-08-31 移除,见 README 触发链定稿)。
        recordAssemblyState();
        log.info("Environment activation completed");
    } catch (err) {
        log.error(vscode.l10n.t("Environment component assembly failed: {0}", err instanceof Error ? (err.stack ?? err.message) : String(err)));
        void showErrorMessage(vscode.l10n.t("ROS 2 environment activation failed; see the output log for details."));
    } finally {
        state.setProcessingWorkspace(false);
    }
}

/**
 * 完整激活(启动):刷新环境 + 必要时环境组件重装配。
 * (任务提供器注册等门控编排由上层在 activateEnvironment 完成后调用 package-core/gate 执行。)
 */
export async function activateEnvironment(context: vscode.ExtensionContext): Promise<void> {
    log.trace("Full activation: entering activateEnvironment");
    const assembled = await refreshEnvironment(context);
    // 启动语义:无论翻转与否都要确保环境组件装配(首次刷新返回 false 时无条件装配)
    if (!assembled) {
        await assembleRosComponents(context);
    }
}