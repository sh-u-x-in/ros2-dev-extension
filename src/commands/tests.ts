// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file tests.ts
 * 测试命令注册(发现刷新 / 运行全部 / 调试全部)。
 */

import { getLogger } from "../logger";
import * as vscode from "vscode";

import { GATE_REFUSALS, registerGatedCommand } from "./gated-command";
import { Commands, rosTestProvider } from "../extension";
import { composeApi } from "../ros2/api";

/** 扩展日志薄封装(带 commands-tests 模块前缀) */
const log = getLogger("commands-tests");

export function registerTestCommands(context: vscode.ExtensionContext): void {
    log.trace("Registering test commands");
    // 2026-10-18(P1):两条测试命令入统一围栏(门关一句拒绝,与执行层 rejectIfNoEnv 同键;
    // 执行层保留——Test Explorer Run profile 直连 runTests 不经命令注册,是纵深);
    // 效果:无环境从"逐包 N 条 errored"变"入口一句拒绝"。
    const gate = { getIssue: () => composeApi.environment.getEnvIssue(), refuse: GATE_REFUSALS.tests };
    registerGatedCommand(Commands.TestsRefresh, gate, async () => {
        log.trace(vscode.l10n.t("Executing command: {0}", Commands.TestsRefresh));
        if (rosTestProvider) {
            // B13:refresh() 现在是"强制落地的全量刷新",返回节点数 ⇒ **await 之后再提示**。
            // 旧实现同步返回、提示先于结果,且被并发守卫丢弃时也照样弹"已刷新"(假确认)。
            const count = await rosTestProvider.refresh();
            log.info(vscode.l10n.t("ROS 2 test discovery refreshed ({0} items)", count));
            vscode.window.showInformationMessage(vscode.l10n.t("ROS 2 test discovery refreshed ({0} items in total)", count));
        } else {
            const NOT_INITIALIZED = vscode.l10n.t("ROS 2 test provider is not initialized yet");
            log.warn(NOT_INITIALIZED);
            vscode.window.showWarningMessage(NOT_INITIALIZED);
        }
    });

    registerGatedCommand(Commands.TestsRunAll, gate, async () => {
        log.trace(vscode.l10n.t("Executing command: {0}", Commands.TestsRunAll));
        if (rosTestProvider) {
            // 2026-09-29 重定义:工作空间级运行 = 全部包节点逐包 colcon test(串行)+ 官方产物解析;
            // 旧"全部叶子各跑一遍"严格弱于测试视图(够不着包级 colcon),已废。
            await rosTestProvider.runAllWorkspace();
        } else {
            const NOT_INITIALIZED = vscode.l10n.t("ROS 2 test provider is not initialized yet");
            log.warn(NOT_INITIALIZED);
            vscode.window.showWarningMessage(NOT_INITIALIZED);
        }
    });
}
