// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file intellisense-api.ts
 * 配置生成【接口层】(纯类型,零实现零运行时依赖;对齐 ros2/api、package-core/api 的"接口集中 api"范式)。
 * 实现:./intellisense-config.ts(createIntellisenseConfig)。外部(组合根/消费者)只 import 本文件类型。
 * 数据源形态:environment 以对象整体注入(IntellisenseEnvSource,结构化兼容 ros2/ environmentFacade),
 * 裁切(前缀拼接/PYTHONPATH 提取/增量更新)全部在实现模块内自包含,组合根零裁切。
 */

// 只 import type 状态形状(经 package-core/api 纯接口层,不 import 实现文件)
import type { PackageChangeEvent, PackageDataState } from "../../../package-core/api";

/**
 * 环境数据源窄接口(对齐 ros2/api 纯接口模式:组合根注入整个环境域门面,
 * 实现模块内部自行裁切——读 env / 订阅变化 / 提取前缀 / 拆分 PYTHONPATH,不在组合根做任何裁切)。
 * 结构化兼容:ros2/ 的 environmentFacade 满足此形状,直接传入。
 */
export interface IntellisenseEnvSource {
    /** 读当前 env(source 结果;未 source 时 undefined) */
    getEnv(): any | undefined;
    /** 环境变化订阅(source 完成后触发;返回可取消句柄——结构化兼容 vscode.Disposable) */
    onEnvChanged(cb: () => void): { dispose(): void };
}

/** 配置生成选项(依赖注入:数据源以对象形态整体注入,裁切在模块内) */
export interface IntellisenseConfigOptions {
    /** 工作区根 */
    workspaceRoot: string;
    /** 读包数据快照(本中心) */
    getState(): Readonly<PackageDataState>;
    /** 环境数据源(注入整个环境域门面,如 environmentFacade;include 前缀/PYTHONPATH 提取在实现模块内部做) */
    environment: IntellisenseEnvSource;
}

/** 配置生成器(对外接口) */
export interface IntellisenseConfig {
    /** 全量同步:生成缺失的 c_cpp_properties.json / Python extraPaths / .clangd(0→1 语义,缺失才写) */
    sync(): Promise<void>;
    /** 订阅包变化,按 diff 增量维护 include 配置;返回取消订阅函数 */
    subscribe(onDidChange: (cb: (ev: PackageChangeEvent) => void) => () => void): () => void;
    /** 释放(取消订阅) */
    dispose(): void;
}
