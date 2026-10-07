// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * 事件层入口（底部,2026-08-29 自 driver/ 改名）：把 定时器 + fs 监听 组装成一个工作区驱动 PackageFetcher。
 *
 * 只引用下层组件（OS / fs / 定时器），不 import 数据层 / UI 层。
 * 2026-08-28:source/(环境源)已删除,系统侧取数/环境事件归 ros2/;本模块只管工作区时机(定时器 + fs 监听)。
 * 详细设计见 DESIGN.md。
 */

import { DriverEvent, PackageFetcher } from "./contracts";
import { createTimer, DriverTimer } from "./timer";
import { createFsWatcher, FsWatcher } from "./fs-watcher";

/** 驱动层组装选项 */
export interface DriverOptions {
    /** 强制刷新周期（毫秒），缺省 60000；<= 0 禁用周期定时器 */
    refreshIntervalMs?: number;
    /** fs 监听去抖窗口（毫秒），缺省 500 */
    watchDebounceMs?: number;
    /** 工作区根（传入才创建 vscode fs 监听；undefined = 不监听） */
    workspaceRoot?: string;
}

/** 组装驱动层为一个 PackageFetcher（合并事件流：定时器 + fs 监听） */
export function createPackageFetcher(options: DriverOptions = {}): PackageFetcher {
    const timer: DriverTimer = createTimer(options.refreshIntervalMs ?? 60000);
    const watcher: FsWatcher = createFsWatcher({
        debounceMs: options.watchDebounceMs ?? 500,
        workspaceRoot: options.workspaceRoot,
    });
    const listeners = new Set<(ev: DriverEvent) => void>();

    const emit = (ev: DriverEvent): void => {
        for (const l of listeners) {
            l(ev);
        }
    };

    // 定时器到点 + fs 变化 → 合并成驱动原始事件流
    timer.onTick(() => emit({ kind: "timer-tick" }));
    watcher.onExternalChange((ev) => emit(ev));

    return {
        onExternalChange(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        setRefreshIntervalMs(ms) {
            timer.setIntervalMs(ms);
        },
        dispose() {
            timer.dispose();
            watcher.dispose();
            listeners.clear();
        },
    };
}
