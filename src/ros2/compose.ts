// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file compose.ts
 * 装配(组合根):各域实例的唯一出口(composition root)。
 * 消费者只依赖 api/ 接口类型,实例经本模块获取(注入点);实现分散各域。
 * 2026-08-25:接线——聚合环境/命令域实例;extension 为装配入口,
 * 调用方(消费者)从 composeApi 取实例,不再直接 import 实现。
 *
 * 依赖方向:compose → 各域(组装);消费者 → compose(取实例);各域不依赖 compose,无环。
 */

import { environmentFacade } from "./environment";
import { ros2ServiceApi } from "./commands/ros2_service_api";
import { rosTaskRunner } from "./commands/ros_task_runner";
import { terminalRun } from "./commands/terminal-run";
import { commandRunner } from "./environment/command-runner";
import { monitorApi, setRos2ServiceApi } from "./consumers/monitor/monitor-api";
import { setCommandRunner as setRos2ServiceCommandRunner } from "./commands/ros2_service_api";
import { setParamHelperCommandRunner } from "./consumers/monitor/helper/param-helper-client";

import type { EnvironmentFacade } from "./api/environment-facade";
import type { Ros2ServiceApi } from "./api/ros2-service-api";
import type { RosTaskRunner } from "./api/ros-task-runner";
import type { TerminalRun } from "./api/terminal-run";
import type { CommandRunner } from "./api/command-runner";
import type { MonitorApi } from "./api/monitor-api";

/** 各域接口实例聚合(消费者从本对象取实例,只见 api/ 类型) */
export interface ComposedApi {
    /** 环境域对外接口(门面实现) */
    environment: EnvironmentFacade;
    /** 命令域查询/状态(实现 commands/ros2_service_api) */
    ros2ServiceApi: Ros2ServiceApi;
    /** 命令域执行/任务终端(实现 commands/ros_task_runner) */
    rosTaskRunner: RosTaskRunner;
    /** 命令域执行/普通集成终端(实现 commands/terminal-run;终端常驻可改命令,与任务终端分工) */
    terminalRun: TerminalRun;
    /** 命令执行原语(实现 environment/command-runner) */
    commandRunner: CommandRunner;
    /** 状态页消费者对象(consumers/ 层专用;monitor / 命令面板 / 调试器共用 daemon/lifecycle) */
    monitorApi: MonitorApi;
}

/** 各域接口实例(装配点注入;消费者经此取实例) */
export const composeApi: ComposedApi = {
    environment: environmentFacade,
    ros2ServiceApi,
    rosTaskRunner,
    terminalRun,
    commandRunner,
    monitorApi,
};

// 注入:monitorApi 的 param/lifecycle 查询委托 Ros2ServiceApi(消除重复实现,2026-08-26)
setRos2ServiceApi(ros2ServiceApi);
// 注入:commandRunner 原语(monitor-cli / ros2_service_api 声明式依赖,2026-08-26 统一走组合根)
setRos2ServiceCommandRunner(commandRunner);
// 注入:常驻参数助手客户端(2026-09-26,spawn 需自动注入 ROS env)
setParamHelperCommandRunner(commandRunner);

// 装配入口注记(2026-08-26):REQUIREMENT-DRIVEN §4/§5 原设计组合根只被 EXT 调用;
// 旧 composeExtension(context) 为零调用方死代码,已删除。当前装配 = 模块加载时
// composeApi 立即初始化 + setRos2ServiceApi 注入;实例取用统一经 api/ 运行时出口。
