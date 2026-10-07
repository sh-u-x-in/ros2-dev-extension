// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file environment-facade.ts
 * EnvironmentFacade 接口定义:环境域对外唯一接口(收编环境全部对外能力,2026-08-25)。
 * 背景:环境模块移入 ros2/ 晚于 API 设计,对外编排/生命周期函数无 API 对应——
 * 本接口收编,门面 environment/index.ts 实现,外部(组合根/消费者)只依赖本接口类型。
 * 数据读/就绪/事件对齐 EnvironmentState;可用性判定为完整口径(见 getEnvIssue,2026-08-31 由 isAvailable 重设计)。
 */

// 2026-08-26:仅类型引用 —— api/ 层零 vscode 运行时依赖(类型擦除后可纯 Node 单测)
import type * as vscode from "vscode";

/** 环境域对外唯一接口(门面 environment/index.ts 实现;外部只 import 本接口类型) */
export interface EnvironmentFacade {
    // ── 数据读 / 就绪 / 事件(对齐 EnvironmentState)──
    /** 当前 env(source 结果;未 source 时为 undefined) */
    getEnv(): any | undefined;
    /** 环境不可用的具体原因(可用 → null;不可用 → 描述性字符串;2026-08-31 由 isAvailable 重设计,布尔判定 = === null) */
    getEnvIssue(): string | null;
    /** 等"至少完成一次 source";已就绪立即放行 */
    whenReady(): Promise<void>;
    /** 等 env 就绪并返回当前 env(env 已就绪立即返回;未就绪等下一次环境变化后返回) */
    resolvedEnv(): Promise<any | undefined>;
    /** 环境变化订阅(source 完成后触发) */
    onEnvChanged(listener: () => void): vscode.Disposable;
    /**
     * 构建信号订阅(colcon 构建结束;install/setup.bash 重写,成功/失败/no-op 均发;
     * 源处零防抖,消费方自行幂等。2026-09-30:对外唯一构建事件出口 ——
     * 现 install-truth 数据中心经它主动增量刷新,取代其 9 组 build/** watcher,见 手工重设计/13)
     */
    onBuildSignal(listener: () => void): vscode.Disposable;

    // ── 编排 ──
    /** 完整激活(启动):刷新 env + 无条件组件重装配 */
    activateEnvironment(context: vscode.ExtensionContext): Promise<void>;
    /** 轻量刷新:source + context key + 门控 + 可用性/包数翻转检测(true=已触发重装配) */
    refreshEnvironment(context: vscode.ExtensionContext): Promise<boolean>;
    /** 构建后刷新(环境采集流水线 + compile_commands 合并;2026-09-15 语义升级) */
    refreshAfterBuild(): void;
    // 2026-08-28 门控编排已移入 package-core/gate.ts:
    //   syncPackagesState(包变化同步)与 syncBuildTaskProvider(任务提供器注册)不再属于环境域,
    //   由上层编排者订阅 package-core.onDidChange 门控事件执行。

    // ── 监听注册(回收进环境域,不散落 listeners)──
    /** 注册全部环境监听(系统 shell / overlay install/** / 工作区文件夹 / 配置变化) */
    registerEnvironmentListeners(context: vscode.ExtensionContext): void;

    // ── 生命周期 ──
    /** 登记一条环境组件订阅(重装配/deactivate 时统一 dispose) */
    addEnvSubscription(d: vscode.Disposable): void;
    /** 清空释放全部环境组件订阅 */
    disposeEnvSubscriptions(): void;
}
