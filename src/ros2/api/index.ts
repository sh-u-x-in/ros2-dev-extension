// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * API 接口定义唯一集中地的聚合出口(接口集中 api/,2026-08-25)。
 * 消费者只从这里 import 接口类型;实现由组合根注入,不 import 实现。
 *
 * 2026-08-26 扩展(组合根回归原设计):
 *   - 新增 MonitorApi 类型聚合(consumers/monitor 消费者对象契约);
 *   - 新增运行时出口:re-export composeApi(统一取对象入口)。
 *     外部域/消费者取实例一律从 api/ import composeApi,
 *     不再直接 import 实现文件 compose.ts(组合根只被 EXT/装配方调用)。
 */

export type { EnvironmentState } from "./environment-state";
export type { EnvironmentFacade } from "./environment-facade";
export type { CommandRunner, CommandExecError, ExecResult } from "./command-runner";
export type { Ros2ServiceApi, PackageEntry, LifecycleState } from "./ros2-service-api";
export type { RosTaskRunner, ColconBuildOptions, ColconInstallType, ColconInstallMethod, ColconInstallLayout, Ros2RunOptions, Ros2LaunchOptions } from "./ros-task-runner";
export type { SettingsProvider, ExtensionSettings, WalkTimeoutOverride } from "./settings";
// 2026-08-26:RosTerminal(A7 交互终端)已废弃注释,export 一并移除(见 ros-terminal.ts 头部说明)
// 2026-09-25:RunOrchestration 占位接口已删除(run/launch 重做落地 build-tool/package-service/run 域,无需占位)
// 2026-08-31:ActivationDeps 已随 onDidEndTask 链移除(接口唯一成员 isROSBuildTask 删除,文件废弃注释化)
export type { RosApiDeps } from "./ros-api-deps";
export type {
    MonitorApi,
    QueryResult,
    NodeInfo,
    TopicInfo,
    ServiceInfo,
    ActionInfo,
    ParamValue,
    ParamValueKind,
    ParamTypedValue,
    ParamTree,
    LifecycleStateLabel,
    LifecycleTransitionLabel,
    LifecycleNode,
    LifecycleGraphState,
    LifecycleGraphEdge,
    LifecycleGraph,
} from "./monitor-api";

/* ================================================================== */
/* 运行时出口(2026-08-26):统一取对象入口,见文件头说明                   */
/* ================================================================== */

export { composeApi } from "../compose";
