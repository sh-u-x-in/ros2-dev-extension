// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file gate.ts
 * 统一环境门(2026-10-18 P1 自"构建任务提供器门控"升格:公式全仓唯一载体)。
 *
 * package-core = package.xml 权威判定中心;门控 = 有合法工作包。
 * 本模块承载"统一门裁决 + 构建任务提供器注册管理":
 *  - 统一门裁决:门槛(环境可用)&& (门户(有合法工作包)|| 倾向(env.allowEmptyWorkspace,默认关)),
 *    与 Ctrl+Shift+B when 对齐(C7);不放行时带原因(env / packages)供消费方区分提示口径;
 *    消费方:构建任务提供器注册(本文件)、配置生成域(config/gen 经 package-core/api 注入同一服务);
 *  - 注册管理:依赖注入(门槛经 ros2/ 提供,门控经本中心快照提供,注册动作经 build-tool/tasks 提供),不 import ros2/。
 *  2026-10-18:PackageGate(包数翻转纯状态)零引用物理删除;shouldRegisterBuildTaskProvider
 *  升格为 evaluateGateDecision(布尔 → GateDecision 附原因);类型出口在 api/api.ts(接口集中范式),
 *  实现留在本文件由组合根装配。
 */

import type { Disposable } from "vscode"; // 2026-08-29:仅类型依赖(§4 问题 4,import type 隔离)

import type { GateDecision, GateService, GateServiceOptions } from "./api/api";

/** 统一门裁决(纯函数,全仓唯一公式载体):门槛 && (门户 || 倾向) */
export function evaluateGateDecision(
    envAvailable: boolean,
    hasPackages: boolean,
    allowEmptyWorkspace: boolean
): GateDecision {
    if (!envAvailable) {
        return { allowed: false, reason: "env" };
    }
    if (!hasPackages && !allowEmptyWorkspace) {
        return { allowed: false, reason: "packages" };
    }
    return { allowed: true, reason: null };
}

/** 创建统一门服务(三数据源每次实时求值,不缓存——环境/包/倾向均可运行时翻转) */
export function createGateService(opts: GateServiceOptions): GateService {
    return {
        evaluate: () => evaluateGateDecision(opts.envAvailable(), opts.hasPackages(), opts.allowEmptyWorkspace()),
    };
}

/** 构建任务提供器注册管理选项(依赖注入) */
export interface BuildTaskProviderGateOptions {
    /** 门槛:环境可用性(ros2/ environment 提供) */
    envAvailable(): boolean;
    /** 门控:是否有合法工作包(本中心快照提供;未通电过渡期可用旧壳数据) */
    hasPackages(): boolean;
    /** 倾向:允许空工作区(配置;2026-10-18 起统一为 ROS2.env.allowEmptyWorkspace,默认关) */
    allowEmptyWorkspace(): boolean;
    /** 注册动作(注入 package-service/build 实现) */
    registerBuildTaskProvider(): Disposable[];
}

/** 构建任务提供器注册管理(自 activate.ts updateBuildTaskProviderRegistration 移入) */
export interface BuildTaskProviderGate {
    /** 按 门槛&&(门户||倾向) 同步注册/注销(有包或允许空工作区时注册) */
    sync(): void;
    /** 释放已注册的提供器 */
    dispose(): void;
}

/** 创建构建任务提供器注册管理(注入依赖;未满足条件时注销) */
export function createBuildTaskProviderGate(opts: BuildTaskProviderGateOptions): BuildTaskProviderGate {
    let disposable: Disposable[] | undefined;

    return {
        sync(): void {
            const decision = evaluateGateDecision(
                opts.envAvailable(),
                opts.hasPackages(),
                opts.allowEmptyWorkspace()
            );
            if (decision.allowed && !disposable) {
                disposable = opts.registerBuildTaskProvider();
            } else if (!decision.allowed && disposable) {
                disposable.forEach((d) => d.dispose());
                disposable = undefined;
            }
        },
        dispose(): void {
            disposable?.forEach((d) => d.dispose());
            disposable = undefined;
        },
    };
}
