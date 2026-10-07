// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file lifecycle-log.ts
 * 生命周期转换回执 · 终端式日志域(十九轮批4a 拆出;二十一升级为结构化三段条目):
 * 每节点独立日志记忆(内存,封顶 200 行)+ 日志区 DOM 构建/就地追加。
 * 条目 = 时间戳(暗灰)+ 内容(按级别着色:pending 黄/success 绿/error 红/info 默认)。
 *
 * 易失语义(十八轮补九,用户裁定):记忆只覆盖当前助手世代 + 存活节点——
 * 助手重启/停止(ready 翻假/stopped)全清(resetLifecycleLogs),节点从发现清单
 * 消失(重启/退出,DDS 租约)清该节点;收起只是不渲染 DOM,**写入无条件**,展开即回放。
 */

export type LogKind = "info" | "pending" | "success" | "error";

interface LogEntry {
    ts: string;
    text: string;
    kind: LogKind;
}

/** 每节点日志列表(封顶 LIFECYCLE_LOG_CAP) */
const lifecycleLogs = new Map<string, LogEntry[]>();
const LIFECYCLE_LOG_CAP = 200;

function nowClock(): string {
    // 毫秒必留(用户裁定):01:41:31.106,转换耗时 0.x 秒级可分辨
    const d = new Date();
    return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** 清空全部节点日志(助手世代更替)并移除页面上的日志区 DOM */
export function resetLifecycleLogs(): void {
    lifecycleLogs.clear();
    document.querySelectorAll(".lifecycle-log").forEach((el) => el.remove());
}

/** 单条日志 → DOM(时间戳暗灰 span + 内容按级别着色 span) */
function renderEntry(entry: LogEntry): HTMLElement {
    const line = document.createElement("div");
    line.className = "lifecycle-log-line";
    const ts = document.createElement("span");
    ts.className = "lifecycle-log-ts";
    ts.textContent = entry.ts + " >>";
    const msg = document.createElement("span");
    msg.className = `lifecycle-log-msg log-${entry.kind}`;
    msg.textContent = entry.text;
    line.appendChild(ts);
    line.appendChild(msg);
    return line;
}

/** 追加一条日志(**无条件写内存**,收起/展开都不丢);日志区在 DOM 时就地追加并滚到底 */
export function appendLifecycleLog(nodeName: string, text: string, kind: LogKind = "info"): void {
    const list = lifecycleLogs.get(nodeName) ?? [];
    const entry: LogEntry = { ts: nowClock(), text, kind };
    list.push(entry);
    if (list.length > LIFECYCLE_LOG_CAP) {
        list.splice(0, list.length - LIFECYCLE_LOG_CAP);
    }
    lifecycleLogs.set(nodeName, list);
    const box = document.querySelector(`.lifecycle-log[data-node-name="${nodeName}"]`) as HTMLElement | null;
    if (box) {
        box.appendChild(renderEntry(entry));
        box.scrollTop = box.scrollHeight;
    }
}

/** 终端式日志区(回放该节点全部历史;等宽/深底/限高滚动)——独立块,与状态图卡片分开渲染。
 *  滚底由挂载方在入 DOM 后执行(scrollLifecycleLogToEnd;脱离文档时 scrollTop 赋值无效,
 *  二十一修复"刷新后闪烁回行头") */
export function buildLifecycleLogBox(nodeName: string): HTMLElement {
    const box = document.createElement("div");
    box.className = "lifecycle-log";
    box.dataset.nodeName = nodeName;
    for (const entry of lifecycleLogs.get(nodeName) ?? []) {
        box.appendChild(renderEntry(entry));
    }
    return box;
}

/** 日志区滚到底(挂载方在入 DOM 后调用;rAF 时机由挂载方掌握) */
export function scrollLifecycleLogToEnd(nodeName: string): void {
    const box = document.querySelector(`.lifecycle-log[data-node-name="${nodeName}"]`) as HTMLElement | null;
    if (box) {
        box.scrollTop = box.scrollHeight;
    }
}

/** 节点消失清理(易失语义:重启/退出即作废)——不在 present 集合内的节点日志删除 */
export function pruneLifecycleLogs(present: Set<string>): void {
    for (const key of [...lifecycleLogs.keys()]) {
        if (!present.has(key)) { lifecycleLogs.delete(key); }
    }
}
