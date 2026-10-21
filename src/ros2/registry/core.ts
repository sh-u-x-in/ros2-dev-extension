// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file core.ts
 * 核心命令注册(daemon 状态 / rosdep / doctor)。
 * 2026-08-26:自 src/commands/core.ts 收进 ros2/ 域(registry 注册层;命令注册归所属域)。
 * 2026-09-25:Run/Launch 注册摘除 —— 重做落地为 build-tool/package-service/run 域
 *   (模板机制 + 按目标分槽记忆 + 侧边栏 ▶),注册者换成 run 域,命令 id 不变;
 *   旧编排 registry/ros-cli.ts 已整体删除。
 */

import { getLogger } from "../../logger";
import * as vscode from "vscode";

import { ensureErrorMessageOnException } from "../../error-utils";
import { GATE_REFUSALS, registerGatedCommand } from "../../commands/gated-command";
import { ShowDaemonStatusCommand, RosdepCommand, DoctorCommand } from "../host/commands";
import { composeApi } from "../api";
import type { Ros2ServiceApi, RosTaskRunner } from "../api";
import { launchMonitor } from "../consumers/monitor/page/ros2-monitor";
import { splitShellArgs } from "../../build-tool/package-service/share/expand";

/** 扩展日志薄封装(带 commands-core 模块前缀) */
const log = getLogger("commands-core");

/** 命令域实例(经组合根注入;只依赖 api/ 接口类型) */
const ros2ServiceApi: Ros2ServiceApi = composeApi.ros2ServiceApi;
const rosTaskRunner: RosTaskRunner = composeApi.rosTaskRunner;

export function registerCoreCommands(context: vscode.ExtensionContext): void {
    log.trace(vscode.l10n.t("Registering core commands"));
    vscode.commands.registerCommand(ShowDaemonStatusCommand, () => {
        ensureErrorMessageOnException(() => {
            log.trace(vscode.l10n.t("Executing command: {0}", ShowDaemonStatusCommand));
            launchMonitor(context);
        });
    });

    // 2026-08-26:ROS2.startDaemon/ROS2.stopDaemon 已移除(命令面板入口砍掉)。
    // 启停能力保留在 monitorApi.daemon():状态页按钮(webview 消息)与调试器 launch 前自动启动直连,不走命令。

    // 2026-09-25:Run/Launch 注册已摘除(重做落地 build-tool/package-service/run 域,注册在 extension.ts;
    // 旧 ros-cli.ts 编排已删除)。
    /* 2026-09-24(T8/B6.3):`ROS2.test`(rostest)整条命令已删除 ——
       它名义是"运行 ROS 2 测试文件",实际做的是"选包 → 选 *launch.py → rosTaskRunner.launch",
       与 Test Explorer 无关联、易误导(旧注释自陈 findPackageTestFiles 未实现恒为空)。
       测试入口统一为测试视图 + `ROS2.tests.refresh` / `ROS2.tests.runAll`。 */

    // 2026-09-29:doctor/rosdep 命令串设置化(ROS2.tool.doctorCommand / rosdepCommand,2026-10-18 键族迁
    // `tool.` 层;注册层读设置经 splitShellArgs 切词成 argv 下发;ros2/ 本体零设置读取,依赖方向不破;
    // 缺省串由设置 default 提供)
    // 2026-10-18(P1):rosdep 入统一命令围栏(门关一句拒绝,与执行层 rosdep 门同键);
    // doctor 设计豁免(无环境时恰恰需要它诊断)
    registerGatedCommand(RosdepCommand, { getIssue: () => composeApi.environment.getEnvIssue(), refuse: GATE_REFUSALS.rosdep }, () => {
        log.trace(vscode.l10n.t("Executing command: {0}", RosdepCommand));
        const setting = vscode.workspace.getConfiguration("ROS2").get<string>("tool.rosdepCommand");
        const argv = setting ? splitShellArgs(setting) : undefined;
        return rosTaskRunner.rosdep(argv ? { argv } : {});
    });

    vscode.commands.registerCommand(DoctorCommand, () => {
        ensureErrorMessageOnException(() => {
            log.trace(vscode.l10n.t("Executing command: {0}", DoctorCommand));
            const setting = vscode.workspace.getConfiguration("ROS2").get<string>("tool.doctorCommand");
            const argv = setting ? splitShellArgs(setting) : undefined;
            return rosTaskRunner.doctor(argv ? { argv } : {});
        });
    });
}
