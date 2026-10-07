// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file build-signal.ts
 * 构建信号事件(2026-09-30):环境域对外**唯一**的构建事件出口。
 *
 * 语义(钉死):colcon 每次构建结束都会无条件重写 `install/setup.bash`(成功/失败/no-op 均写,
 * 位置 = 构建结束 —— 2026-09-14 三组实测,见 register.ts);信号在 watcher 事件回调里
 * **源处零防抖**直接发出(延迟 = watcher 事件本身,毫秒级),消费方自行幂等。
 *
 * 消费方:
 *  - 环境域自身:仍走 register.ts 的 1s 防抖 `refreshAfterBuild`(内部行为不变,不经本事件);
 *  - install-truth(2026-09-30 起):extension.ts 订阅本事件 → 共享数据中心 `refreshAfterBuildSignal()`
 *    (rc-mtime 增量门,见 手工重设计/13)。此前该消费靠 9 组 build 产物 watcher 只置脏,已退役。
 *
 * 纯 vscode 事件模块,无其它依赖。
 */

import * as vscode from "vscode";

/** 构建信号事件源(仅 build-signal 模块内部可 fire) */
const buildSignalEmitter = new vscode.EventEmitter<void>();

/** 订阅构建信号(colcon 构建结束;一次构建恰一次,防抖由消费方自理) */
export const onBuildSignal: vscode.Event<void> = buildSignalEmitter.event;

/** 发出构建信号(仅环境域 register.ts 的构建信号 watcher 回调调用) */
export function fireBuildSignal(): void {
    buildSignalEmitter.fire();
}
