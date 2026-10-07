// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file contracts.ts
 * 事件层契约(2026-08-29 自 driver/ 改名):工作区事件 + 驱动端口。
 * 数据层从 event/ 导入 → 数据 → 驱动 单向向下依赖,无环。
 *
 * 2026-09-06(四项修复 §12.3):两事件补 `dirs`(窗口内受影响目录,绝对路径,去重);
 * op 折叠——create/modify/delete 统一为 path-level changed(消费方"重推该路径"即可,
 * 判据永远是磁盘终态,op 不携带);kind 名保留以减少波及,语义注释按"池/标记"两通道更新。
 */

/** 驱动层对外原始事件(数据层订阅;path-level changed,带 dirs) */
export type DriverEvent =
    /** 池事件:工作区 package.xml 变化(新建/修改/删除),dirs = 受影响目录(可能为空 = 未知全量) */
    | { kind: "workspace-package-changed"; dirs?: string[] }
    /** 标记事件:COLCON_IGNORE 变化,dirs = 标记文件所在目录(可能为空 = 未知全量) */
    | { kind: "ignore-marker-changed"; dirs?: string[] }
    /** 定时器到点(60s 工作区全量权威;2026-09-04 起不携带系统刷新——系统列表随 ros2/ env 变化,见 data.refreshSystem) */
    | { kind: "timer-tick" };

/**
 * 工作区驱动端口(驱动层实现,数据层注入使用)——只管工作区事件时机。
 *  - 事件:驱动层是"时机权威"(定时器/监听),只发原始事件,不知道谁消费;
 *  - 系统侧取数/环境事件已随 source/ 删除(2026-08-28),归 ros2/(Ros2ServiceApi / EnvironmentFacade)。
 */
export interface PackageFetcher {
    /** 订阅驱动原始事件,返回取消订阅函数 */
    onExternalChange(cb: (ev: DriverEvent) => void): () => void;
    /** 运行中重设强制刷新周期(ms;<= 0 停用周期事件;2026-09-28 reconfigure 接线) */
    setRefreshIntervalMs(ms: number): void;
    /** 释放驱动层资源(定时器/监听) */
    dispose(): void;
}
