// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file emitter.ts
 * 通用简单事件发射器(2026-08-29 逻辑吸收提取)。
 * 原 data/index.ts 与 data/package-cache.ts 各一份逐字同构拷贝(连同 executable-map 共三份),
 * 现收拢为共享实现:listeners Set + event 订阅返回取消 + fire + dispose。
 * 纯 TS,无 vscode 依赖,可无头测试。
 */

export class EventEmitter<T> {
    private listeners = new Set<(payload: T) => void>();

    readonly event: (listener: (payload: T) => void) => () => void = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    fire(payload: T): void {
        for (const l of this.listeners) {
            l(payload);
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}
