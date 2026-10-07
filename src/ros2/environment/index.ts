// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * 环境域对外唯一门面(对外窄接口)。
 * 外部组件只能经此访问环境域;禁止直接 import 子模块(ESLint no-restricted-imports 兜底)。
 * 内部模块(source / activate / status / state)之间自由互调,不反向依赖本文件。
 *
 * 说明(2026-08-25):DESIGN.md 原规划 registerEnvironment 合并 terminal-profile 注册,
 * 但 terminal-profile 已按 REQUIREMENT-DRIVEN 演进为 consumers 纯消费者(非环境域成员),
 * 本门面不反向依赖 consumers(避免环境域依赖上层),registerSystemEnvWatch 单独暴露。
 */

import * as activate from "./activate";
import * as build_env from "./build-env";
import { onBuildSignal } from "./build-signal";
import * as command_runner from "./command-runner";
import * as register from "./register";
import * as source from "./source";
import * as status from "./status";
import * as state from "./state";

import type { EnvironmentFacade } from "../api/environment-facade";

/**
 * 环境域对外唯一接口实现(接口定义 api/environment-facade.ts)。
 * 外部(组合根/消费者)只依赖 EnvironmentFacade 类型;子模块具体实现全部隐藏。
 */
export const environmentFacade: EnvironmentFacade = {
    getEnv: state.getEnv,
    getEnvIssue: state.getEnvIssue,
    whenReady: state.whenReady,
    resolvedEnv: state.resolvedEnv,
    onEnvChanged: state.onEnvChanged,
    // 2026-09-30:构建信号专供事件(colcon 结束;零防抖,消费方自行幂等)——
    // 现 install-truth 数据中心经它主动增量刷新(手工重设计/13)
    onBuildSignal: onBuildSignal,
    activateEnvironment: activate.activateEnvironment,
    refreshEnvironment: activate.refreshEnvironment,
    refreshAfterBuild: activate.refreshAfterBuild,
    // 2026-08-28 syncPackagesState / syncBuildTaskProvider(门控编排)已移入 package-core/gate.ts,
    // 不再经环境域门面暴露;由上层编排者订阅 package-core.onDidChange 执行。
    registerEnvironmentListeners: register.registerEnvironmentListeners,
    addEnvSubscription: activate.addEnvSubscription,
    disposeEnvSubscriptions: activate.disposeEnvSubscriptions,
};

// ── 生命周期 ──
export const activateEnvironment = activate.activateEnvironment;
export const refreshEnvironment = activate.refreshEnvironment;
// 2026-08-31:setActivationDeps 已随 onDidEndTask 链移除(ActivationDeps 注入机制废弃,见 README 触发链定稿)
export { setRosApiDeps } from "../api/ros-api-deps";
// 2026-08-28 syncPackagesState / syncBuildTaskProvider 已移入 package-core/gate.ts(门控编排)
/** 清空并释放环境组件订阅(extension.deactivate 收尾用;取代旧 extension.subscriptions) */
export const disposeEnvSubscriptions = activate.disposeEnvSubscriptions;
/** 注册一条环境组件订阅(环境重装配/deactivate 时 dispose;非环境域组件挂环境生命周期用) */
export const addEnvSubscription = activate.addEnvSubscription;

// ── 注册 ──
/** 注册系统 shell 配置文件监听(bashrc 变化 → 失效缓存刷新) */
export const registerSystemEnvWatch = source.registerSystemEnvWatch;
/** 注册全部环境监听(系统 shell / overlay / 工作区文件夹 / 配置变化;回收自 listeners.ts) */
export const registerEnvironmentListeners = register.registerEnvironmentListeners;

// ── 刷新 ──
/** 构建后刷新(环境采集流水线 + compile_commands 合并;触发源:install/setup.bash 构建信号) */
export const refreshAfterBuild = activate.refreshAfterBuild;
/** 刷新工作区 context key(原 updateWorkspaceContextKeys) */
export const refreshContextKeys = status.updateWorkspaceContextKeys;

// ── 命令执行(需求 A6)──
/** 统一命令执行原语:exec/spawn(自动注入 env;统一超时 + UTF-8/GBK 解码 + 日志) */
export const commandRunner = command_runner.commandRunner;
export { exec, spawn } from "./command-runner";

// ── 只读状态 ──
/** 当前 env(source 结果;未 source 时为 undefined) */
export const getEnv = state.getEnv;
/**
 * **构建专用 env**(2026-09-22):由当前快照剔除"本工作区自身条目"派生,供 `colcon build` 使用——
 * 避免 colcon-override-check 的自我覆盖警告、避免旧 install 参与 include/依赖解析;
 * 运行/调试仍用 `getEnv()`(需要 overlay)。纯函数实现在 build-env.ts。
 */
export const getBuildEnv = build_env.getBuildEnv;
/** 纯函数:把快照过滤成构建专用 env(可无头单测;`isWorkspaceEntry` 口径与外部环境判定一致) */
export const stripWorkspaceEntries = build_env.stripWorkspaceEntries;
/** 等 env 就绪并返回当前 env(旧 extension.resolvedEnv 语义,收进环境域) */
export const resolvedEnv = state.resolvedEnv;
/** 环境变化事件(source 完成后触发) */
export const onEnvChanged = state.onEnvChanged;
/** EnvironmentState 接口实现对象(getEnv/getEnvIssue/whenReady/onEnvChanged;接口定义在 api/environment-state.ts) */
export const environmentState = state.environmentState;
