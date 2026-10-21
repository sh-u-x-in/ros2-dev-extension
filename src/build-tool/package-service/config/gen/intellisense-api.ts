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
import type { GateService, PackageChangeEvent, PackageDataState } from "../../../package-core/api";

/**
 * 环境数据源窄接口(对齐 ros2/api 纯接口模式:组合根注入整个环境域门面,
 * 实现模块内部自行裁切——读 env / 订阅变化 / 提取前缀 / 拆分 PYTHONPATH,不在组合根做任何裁切)。
 * 结构化兼容:ros2/ 的 environmentFacade 满足此形状,直接传入。
 */
export interface IntellisenseEnvSource {
    /** 读当前 env(source 结果;未 source 时 undefined) */
    getEnv(): any | undefined;
    /**
     * 环境可用性判定(2026-10-17 域门控接入):返回不可用原因,可用 → null。
     * 与 buildTaskProviderGate.envAvailable 同口径(ros2/ environment 的 state.getEnvIssue);
     * 门控判据 = 本方法 === null(门槛),环境不可用时配置生成绝不写盘。
     */
    getEnvIssue(): string | null;
    /** 环境变化订阅(source 完成后触发;返回可取消句柄——结构化兼容 vscode.Disposable) */
    onEnvChanged(cb: () => void): { dispose(): void };
}

/**
 * 单配置文件的同步明细(2026-10-20 动态反馈,用户裁定"改了哪些部分+没改的原因,不用固定文本涵盖所有"):
 * 渲染层每笔写盘/不写盘分支顺手记录,命令层经 intellisense-report 查表译成多行通知。
 */
export interface SyncFileReport {
    /** 配置侧 */
    file: "cpp" | "clangd" | "python";
    /** 本轮是否落盘 */
    written: boolean;
    /**
     * 变更事实(键=事实种类,值=条数;渲染层查表出话术,未知键忽略)。键封闭清单:
     *  · cpp:`generated` 从零生成条数 / `surgical` includePath 键缺失外科补条数 / `claimed` 认领段变更(=1)
     *    / `dedup` 清理重复 ros2 成员数 / `reorder` 规范重排(=1,与 `managed` 管辖条数 `leftover` 保留条数成组)
     *    / `usrClean` 清 /usr/include 残留 / `staleClean` 清构建产物残留 / `ovClean` 清替换表旧形态
     *  · clangd:`generated` 新建(=1,与 `genFlags`/`genWs`/`genInstall`/`genSys` 四组条数成组)
     *    / `dbMigrated` CompilationDatabase 收编(=1) / `removed` 管辖归正移除行数 / `ovReplaced` 替换表原位收敛行数
     *    / `orphan` 孤儿分组注释清理行数 / `tidy` 接管排序重排(=1)
     *    / `addFlags`/`addWs`/`addInstall`/`addSys` 组内补缺失四组 / `addFlat` 无注释旧文件列表头补缺 / `flowAdded` flow 保守补缺
     *  · python:`rewritten` 写盘键数(0-2) / `added` 补充条数 / `ovClean` 清替换表旧形态条数(与 cpp 同键共用话术)
     */
    facts: Record<string, number>;
    /** 未写盘原因(written=false 时有值;渲染层查表) */
    idle?: "no-change" | "disabled" | "conservative" | "empty";
}

/**
 * 单次同步的结果(2026-10-17 域门控接入;2026-10-20 applied 携带逐文件明细):
 * 门开执行完 = applied 附报表;被域门拦下 = skipped 附原因,
 * 供手动命令(ROS2.regenerateIntellisenseConfig)向用户如实反馈"改了什么/为什么没改"。
 * 事件防抖路径照旧丢弃返回值(无 UI 语境,零行为变化)。
 */
export type SyncOutcome =
    | { outcome: "applied"; report: SyncFileReport[] }
    | { outcome: "skipped"; reason: "env" | "packages" };

/** 配置生成选项(依赖注入:数据源以对象形态整体注入,裁切在模块内) */
export interface IntellisenseConfigOptions {
    /** 工作区根 */
    workspaceRoot: string;
    /** 读包数据快照(本中心) */
    getState(): Readonly<PackageDataState>;
    /** 环境数据源(注入整个环境域门面,如 environmentFacade;include 前缀/PYTHONPATH 提取在实现模块内部做) */
    environment: IntellisenseEnvSource;
    /**
     * 统一环境门(2026-10-18 P1:公式唯一载体,与构建任务提供器门同源)。
     * 缺省未注入时(无头测试)走实现内本地兜底公式(与 GateService 同式,倾向读 ROS2.env.allowEmptyWorkspace)。
     */
    gate?: GateService;
}

/** 配置生成器(对外接口) */
export interface IntellisenseConfig {
    /** 全量同步:生成缺失的 c_cpp_properties.json / Python extraPaths / .clangd(0→1 语义,缺失才写);被域门拦下时返回 skipped 附原因 */
    sync(): Promise<SyncOutcome>;
    /** 订阅包变化,按 diff 增量维护 include 配置;返回取消订阅函数 */
    subscribe(onDidChange: (cb: (ev: PackageChangeEvent) => void) => () => void): () => void;
    /** 释放(取消订阅) */
    dispose(): void;
}
