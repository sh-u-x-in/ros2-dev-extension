// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file batcher.ts
 * 去抖 + 路径聚合(2026-09-06 §12.3):fs 监听原始事件 → 窗口内按 dir 去重聚合 → path-level changed。
 * 纯 TS 零 vscode 依赖,可无头测试。
 *
 * op 折叠(用户模型):create/modify/delete 对消费方等价 = "该路径派生状态需重推",
 * 聚合只保留 (kind, dir) 集合,不带 op。
 */

/** 事件 kind(与 contracts.ts 对齐) */
export type BatcherKind = "workspace-package-changed" | "ignore-marker-changed";

/** 聚合输出:单 kind 一次,带窗口内去重后的受影响目录(绝对路径) */
export interface BatchedEvent {
    kind: BatcherKind;
    dirs: string[];
}

/** 聚合器:调度原始 (kind, dir) → 去抖窗口结束后 flush 成 BatchedEvent */
export interface DirBatcher {
    /** 原始事件入口(每次收到一个变化文件目录) */
    schedule(kind: BatcherKind, dir: string): void;
    /** 立即清空窗口(测试用/释放前),返回是否曾有待发事件 */
    dispose(): void;
}

/**
 * 创建去抖聚合器:窗口内同类多路径合并为一次 BatchedEvent(带 dirs);窗口随每次 schedule 滑动。
 * flush 由 debounceMs 定时触发;窗口为空时不发。
 */
export function createDebouncedDirBatcher(
    debounceMs: number,
    onFlush: (ev: BatchedEvent) => void,
): DirBatcher {
    const pending = new Map<BatcherKind, Set<string>>();
    let timer: NodeJS.Timeout | undefined;

    const flush = (): void => {
        timer = undefined;
        for (const [kind, dirSet] of pending) {
            pending.delete(kind);
            if (dirSet.size === 0) {
                continue;
            }
            onFlush({ kind, dirs: [...dirSet] });
        }
    };
    const arm = (): void => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(flush, debounceMs);
    };

    return {
        schedule(kind, dir) {
            let set = pending.get(kind);
            if (!set) {
                set = new Set<string>();
                pending.set(kind, set);
            }
            set.add(dir);
            arm();
        },
        dispose() {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            pending.clear();
        },
    };
}
