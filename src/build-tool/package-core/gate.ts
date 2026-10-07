// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file gate.ts
 * 门控编排(自 ros2/environment/activate.ts 移入,2026-08-28,第一阶段移动语义)。
 *
 * package-core = package.xml 权威判定中心;门控 = 有合法工作包。
 * 本模块承载"门户判定 + 包数翻转检测 + 构建任务提供器注册管理":
 *  - 门户判定:门槛(环境可用)&& (门户(有合法工作包)|| 倾向(allowEmptyWorkspace)),与 Ctrl+Shift+B when 对齐(C7);
 *  - 包数翻转:0↔N 翻转检测(纯状态);
 *  - 注册管理:依赖注入(门槛经 ros2/ 提供,门控经本中心快照提供,注册动作经 build-tool/tasks 提供),不 import ros2/。
 */

import type { Disposable } from "vscode"; // 2026-08-29:仅类型依赖(§4 问题 4,import type 隔离)

/** 门户判定(纯函数):门槛 && (门户 || 倾向) */
export function shouldRegisterBuildTaskProvider(
    envAvailable: boolean,
    hasPackages: boolean,
    allowEmptyWorkspace: boolean
): boolean {
    return envAvailable && (hasPackages || allowEmptyWorkspace);
}

/** 包数 0↔N 翻转检测(纯状态;输入 = 当前是否有合法工作包) */
export class PackageGate {
    private lastHasPackages = false;

    /** 更新包数状态,返回是否发生 0↔N 翻转 */
    update(hasPackages: boolean): boolean {
        const flipped = hasPackages !== this.lastHasPackages;
        this.lastHasPackages = hasPackages;
        return flipped;
    }

    /** 当前是否持有合法工作包 */
    get hasPackages(): boolean {
        return this.lastHasPackages;
    }
}

/** 构建任务提供器注册管理选项(依赖注入) */
export interface BuildTaskProviderGateOptions {
    /** 门槛:环境可用性(ros2/ environment 提供) */
    envAvailable(): boolean;
    /** 门控:是否有合法工作包(本中心快照提供;未通电过渡期可用旧壳数据) */
    hasPackages(): boolean;
    /** 倾向:允许空工作空间构建(配置) */
    allowEmptyWorkspace(): boolean;
    /** 注册动作(注入 package-service/build 实现) */
    registerBuildTaskProvider(): Disposable[];
}

/** 构建任务提供器注册管理(自 activate.ts updateBuildTaskProviderRegistration 移入) */
export interface BuildTaskProviderGate {
    /** 按 门槛&&(门户||倾向) 同步注册/注销(有包或允许空构建时注册) */
    sync(): void;
    /** 释放已注册的提供器 */
    dispose(): void;
}

/** 创建构建任务提供器注册管理(注入依赖;未满足条件时注销) */
export function createBuildTaskProviderGate(opts: BuildTaskProviderGateOptions): BuildTaskProviderGate {
    let disposable: Disposable[] | undefined;

    return {
        sync(): void {
            const should = shouldRegisterBuildTaskProvider(
                opts.envAvailable(),
                opts.hasPackages(),
                opts.allowEmptyWorkspace()
            );
            if (should && !disposable) {
                disposable = opts.registerBuildTaskProvider();
            } else if (!should && disposable) {
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
