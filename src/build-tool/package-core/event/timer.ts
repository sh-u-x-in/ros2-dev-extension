// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file timer.ts
 * 事件层(2026-08-29 自 driver/ 改名)：60s 定时器（强制刷新节奏的"时机权威"）。
 *
 * 到点发 timer-tick 原始事件；不决定怎么重算（那是数据层的事）。
 * 2026-09-28:新增 setIntervalMs —— 运行中重设周期(reconfigure 接线;<= 0 停用,可再启动)。
 * 纯 TS，无 vscode 依赖，可无头测试。
 */

/** 驱动层定时器接口 */
export interface DriverTimer {
    /** 订阅到点事件，返回取消订阅函数 */
    onTick(cb: () => void): () => void;
    /** 运行中重设周期(ms;与当前值相同 = 空操作;<= 0 停用,之后再设正值重新启动) */
    setIntervalMs(ms: number): void;
    /** 停止定时器并清空监听 */
    dispose(): void;
}

/** 创建定时器（默认 60s 刷新节奏；intervalMs <= 0 时初始停用，可经 setIntervalMs 启动） */
export function createTimer(intervalMs = 60000): DriverTimer {
    const listeners = new Set<() => void>();
    let current = intervalMs;
    let id: NodeJS.Timeout | undefined = undefined;

    const start = (): void => {
        if (current > 0 && id === undefined) {
            id = setInterval(() => {
                for (const l of listeners) {
                    l();
                }
            }, current);
        }
    };
    const stop = (): void => {
        if (id !== undefined) {
            clearInterval(id);
            id = undefined;
        }
    };
    start();

    return {
        onTick(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        setIntervalMs(ms) {
            if (ms === current) {
                return;
            }
            current = ms;
            stop();
            start();
        },
        dispose() {
            stop();
            listeners.clear();
        },
    };
}
