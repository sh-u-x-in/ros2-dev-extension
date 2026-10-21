// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file gated-command.ts(2026-10-18 P1)
 * 统一命令围栏包装器:门内命令注册的唯一入口。
 *  - 门在**每次调用时**查(命令注册先于环境检测完成,注册时求值会误判);
 *  - 门关 → 按域文案键一句拒绝并返回;门开才进 handler;
 *  - 转发全部实参(ensureErrorMessageOnException 不转发参数的先例教训);
 *  - 内联异常兜底(侧边栏 8 个注册点此前无统一错误出口,顺带补齐)。
 * 与执行层早退(ros_task_runner / smart-* / rejectIfNoEnv)的关系:本层是命令面板/键位/侧边栏
 * 入口的第一道,执行层是 webview/Test Explorer 等非命令路径的纵深;wrapper 命中即 return,
 * 不会双重弹窗。依赖经注入 getIssue(组合根传 environmentFacade / composeApi.environment),
 * 本文件不 import 任何 ros2/ 实现。
 */

import * as vscode from "vscode";

/** 门内命令选项 */
export interface GatedCommandOptions {
    /** 环境不可用原因(可用 → null);调用方注入(如 () => composeApi.environment.getEnvIssue()) */
    getIssue(): string | null;
    /** 拒绝文案(按域选定;见 GATE_REFUSALS,键为既有执行层同键字面量) */
    refuse(issue: string): string;
}

/**
 * 注册门内命令:门关一句拒绝,门开进 handler;实参透传;异常统一弹窗。
 */
export function registerGatedCommand(
    commandId: string,
    opts: GatedCommandOptions,
    handler: (...args: any[]) => unknown
): vscode.Disposable {
    return vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
        try {
            const issue = opts.getIssue();
            if (issue !== null) {
                vscode.window.showErrorMessage(opts.refuse(issue));
                return;
            }
            await handler(...(args as any[]));
        } catch (err) {
            vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
    });
}

/**
 * 各域拒绝文案(键 = 既有执行层同键,双语已在册,l10n 期0 对账过;字面量集中此处保证 i18n 审计可见——
 * 变量首参 l10n.t 的键审计认不出表源,曾因此误删出厂键,教训见 factory-l10n)。
 */
export const GATE_REFUSALS = {
    /** 构建(colcon.build / 单包构建 ×3)——与 ros_task_runner.colcon_build / smart-build 入口同键 */
    build: (issue: string): string =>
        vscode.l10n.t("No usable ROS 2 environment detected; cannot build. Reason: {0}. Configure and activate a ROS environment (ROS2.rosSetupScript / ROS2.pixiRoot) first, then retry.", issue),
    /** 运行/启动(run / launch / 侧边栏 ▶ ×2)——与 ros_task_runner.executeRunArgv 同键 */
    execute: (issue: string): string =>
        vscode.l10n.t("No usable ROS 2 environment detected; cannot execute. Reason: {0}. Configure and activate a ROS environment (ROS2.rosSetupScript / ROS2.pixiRoot) first, then retry.", issue),
    /** 依赖安装(rosdep)——与 ros_task_runner.rosdep 同键 */
    rosdep: (issue: string): string =>
        vscode.l10n.t("No usable ROS 2 environment detected; cannot install dependencies (rosdep needs ROS_DISTRO). Reason: {0}. Configure and activate a ROS environment first, then retry.", issue),
    /** 测试(tests.refresh / tests.runAll)——与 ros-test-runner.rejectIfNoEnv 同键 */
    tests: (issue: string): string =>
        vscode.l10n.t("No usable ROS 2 environment detected; cannot run tests. Reason: {0}. Configure and activate a ROS environment (ROS2.rosSetupScript / ROS2.pixiRoot) first, then retry.", issue),
    /** 终端(createTerminal)——与 terminal-run 同键 */
    terminal: (issue: string): string =>
        vscode.l10n.t("No usable ROS 2 environment detected. Reason: {0}", issue),
};
