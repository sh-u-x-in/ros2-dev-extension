// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file terminal-run.ts
 * 普通集成终端执行接口(2026-09-26,状态页话题订阅/服务调用引入)。
 * 与 RosTaskRunner(A9 任务终端)的分工:任务终端随任务进程生死——用户 Ctrl+C 终止后
 * 整个终端被清除、无法改造命令;普通集成终端常驻,提示符可继续输入,命令历史可改参重跑。
 * 适用:用户要"看着输出、顺手改参数重跑"的交互型命令(topic echo / service call /
 * action send_goal);一次性工具命令(构建/doctor/rosdep)仍走任务终端。
 */

/** 普通集成终端执行选项 */
export interface RunNormalTerminalOptions {
    /** 终端名(同时是复用判定的键,建议带目标全名,如「ROS 2 话题回显 /chatter」) */
    name: string;
    /** 完整命令行(经 shell 解析;引号/转义由调用方负责) */
    command: string;
    /** 工作目录(缺省 = 工作区根) */
    cwd?: string;
    /** 复用同名终端时是否重发命令:重复调用类=true;常驻订阅类=false 只聚焦(防同终端叠加) */
    resendOnReuse?: boolean;
}

/** 执行结果(ok=false 时 error 给出原因;reused=true 表示聚焦了既有同名终端) */
export interface RunNormalTerminalResult {
    ok: boolean;
    reused?: boolean;
    error?: string;
}

/** 普通集成终端执行接口(实现 commands/terminal-run.ts) */
export type TerminalRun = (opts: RunNormalTerminalOptions) => Promise<RunNormalTerminalResult>;
