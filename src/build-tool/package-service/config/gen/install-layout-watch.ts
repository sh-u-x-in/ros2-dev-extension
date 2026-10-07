// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file install-layout-watch.ts
 * 安装布局信号监听(2026-09-16 从 extension.ts 收编;组合根只组装,不写实现细节)。
 *
 * 用途:给"配置生成"提供**安装结构变化**的信号 —— 布局事实来源是
 * `<ws>/install/.colcon_install_layout` 的**内容**(isolated/merged,由
 * `intellisense-utils.readInstallLayout` 在重算时读),本模块只负责"什么时候该重算"。
 *
 * ── 两个 watcher(互补),2026-09-16 "方案 2" 改版 ────────────────────
 *  ② 标记文件:`RelativePattern(<ws>/install/.colcon_install_layout, "*")` —— **以文件自身为 base**:
 *     · 官方 d.ts 的"单文件监视"范例写法(base 指向文件 + 模式 `*`);
 *     · 模式不含斜杠与双星号 ⇒ 走"非递归"通道(官方文档:该通道忽略 files.watcherExclude);
 *     · 目标是文件 ⇒ VS Code 先试"复用递归总网",复用有排除检查(被排除即拒绝),于是落回
 *       **独立 fs.watch 单文件监视**;文件型监视的事件**显式跳过 excludes/includes 检查**
 *       ("file is explicitly watched")—— 所以即使 watcherExclude 里排除了 install 子树,
 *       本 watcher 照样收事件;
 *     · 文件尚不存在(未构建)也无妨:VS Code 会把请求**挂起**并用 fs.watchFile 轮询(~5s),
 *       路径出现即**合成一条 create 事件**并转入正式监视(baseWatcher 源码行为);
 *     · 只订阅 create;change/delete 交给轮询兜底(用户裁定)。
 *  ① `RelativePattern(<ws>, "*")` —— 盯 **install 目录条目**本身:create/delete(回调里按名字过滤)。
 *     这是"更早的补充信号",不是正确性依赖:它的非递归请求在工作区内会被"把 files.watcherExclude 键
 *     反转成 includes"的补丁处理,而该反转对含双星号的排除键匹配不到真实路径(2026-09-16 实测),
 *     因此排除表存在时它可能收不到事件 —— 收得到算赚,收不到由 ② 与轮询兜底。
 *
 * ── 背景勘误(2026-09-16,按 VS Code 1.124.2 源码逐条核实) ──────────
 *  · "注册时 install/ 不存在 ⇒ watcher 死"是误诊:监听目标永远是 base(pattern 只是扩展侧过滤器);
 *    真正闸门是"模式含斜杠 ⇒ 递归 watcher ⇒ 自动吃 files.watcherExclude" —— 凡被排除目录,
 *    其事件在源头被过滤,这才是当时 install 相关 watcher 集体静默的真因(排除项由本扩展自己写入)。
 *  · 早期"锚在目标自身 / 目标删除即死且不重挂"等表述同样不成立(锚点恒为 base)。
 *  · 兜底轮询(默认 60s)仍保留:不押注 watch 通道,内容变了才发信号。
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** 目录条目名与标记文件相对路径(写死:默认打开的工作区即 colcon 根) */
const INSTALL_DIR = "install";
const LAYOUT_FILE = "install/.colcon_install_layout";

export interface InstallLayoutWatchOptions {
    /** 工作区根(colcon 根) */
    workspaceRoot: string;
    /** 布局信号回调(已完成防抖/补查聚合;调用方只需重算配置) */
    onLayoutSignal(reason: string): void;
    /** 日志(可选) */
    logger?: { debug(msg: string): void };
    /** 防抖窗口,默认 1000ms */
    debounceMs?: number;
    /** "install/ 出现"后的补查延迟,默认 6000ms */
    dirRetryMs?: number;
    /** 兜底轮询间隔,默认 60000ms(**0 = 关闭**);内容变了才发信号 */
    pollIntervalMs?: number;
    /** 注入:读标记内容(默认 fs.readFileSync;缺失/不可读 → undefined;测试用) */
    readMarkerContent?(): string | undefined;
    /** 注入:watcher 工厂(默认 vscode.RelativePattern + createFileSystemWatcher;测试用) */
    createWatcher?(base: string, pattern: string): vscode.FileSystemWatcher;
}

/** 注册句柄(挂 context.subscriptions 即可) */
export interface InstallLayoutWatch extends vscode.Disposable {
    // 结构:仅 dispose
}

/**
 * 注册安装布局信号监听。返回句柄,dispose 时清理全部 watcher 与待发定时器。
 */
export function registerInstallLayoutWatch(opts: InstallLayoutWatchOptions): InstallLayoutWatch {
    const debounceMs = opts.debounceMs ?? 1000;
    const dirRetryMs = opts.dirRetryMs ?? 6000;
    const pollIntervalMs = opts.pollIntervalMs ?? 60000;
    const readMarker = opts.readMarkerContent ?? ((): string | undefined => {
        try {
            return fs.readFileSync(path.join(opts.workspaceRoot, LAYOUT_FILE), "utf8");
        } catch {
            return undefined; // 缺失/不可读 → undefined
        }
    });
    const createWatcher = opts.createWatcher ?? ((base: string, pattern: string): vscode.FileSystemWatcher =>
        vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern)));

    const disposables: vscode.Disposable[] = [];
    const retryTimers = new Set<NodeJS.Timeout>();
    let debounceTimer: NodeJS.Timeout | undefined;

    /** 防抖合并后发信号(目录/文件多事件只重算一次) */
    const signalSoon = (reason: string): void => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            opts.onLayoutSignal(reason);
        }, debounceMs);
    };

    /** 独立补查(不参与防抖;有界) */
    const signalLater = (delayMs: number, reason: string): void => {
        const t = setTimeout(() => {
            retryTimers.delete(t);
            opts.onLayoutSignal(reason);
        }, delayMs);
        retryTimers.add(t);
    };

    // ① install 目录条目(锚点 = 工作区根 + 松匹配 `*`,按名字过滤)—— 补充信号,非正确性依赖:
    //   能收到就比标记更早(构建开始);收不到(排除表压制"非递归 + includes 反转"通道)由 ② 与轮询兜底。
    const dirWatcher = createWatcher(opts.workspaceRoot, "*");
    const onRootEntry = (uri: vscode.Uri | undefined, kind: "create" | "delete"): void => {
        const name = uri?.fsPath ? path.basename(uri.fsPath) : "";
        if (name !== INSTALL_DIR) {
            return; // 根目录里其它条目的增删与本域无关
        }
        if (kind === "create") {
            signalSoon("install/ 目录出现");
            signalLater(dirRetryMs, "install/ 出现后补查(标记可能稍晚落盘)");
        } else {
            signalSoon("install/ 目录被删");
        }
    };
    disposables.push(dirWatcher.onDidCreate((uri) => onRootEntry(uri, "create")));
    disposables.push(dirWatcher.onDidDelete((uri) => onRootEntry(uri, "delete")));
    disposables.push(dirWatcher);
    opts.logger?.debug(`已注册目录条目监听:${opts.workspaceRoot}/${INSTALL_DIR}`);

    // ② 标记文件 watcher(方案 2:base = 文件自身,2026-09-16):
    //   文件型非递归监视 —— 事件显式跳过 excludes/includes 检查,不受 files.watcherExclude 影响;
    //   文件不存在(未构建)时 VS Code 会"挂起 + fs.watchFile 轮询(~5s)",路径出现即合成 create 事件并转入正式监视。
    //   因此无需任何"install/ 已存在才挂 / 出现后补挂"的逻辑,注册即常驻。
    const markerPath = path.join(opts.workspaceRoot, LAYOUT_FILE);
    const markerWatcher = createWatcher(markerPath, "*");
    disposables.push(markerWatcher.onDidCreate(() => signalSoon(`安装布局标记 创建(${LAYOUT_FILE})`)));
    disposables.push(markerWatcher);
    opts.logger?.debug(`已注册安装布局标记监听(文件型):${markerPath}`);

    // ③ 确定性兜底:低频内容比对(不押注 watch 通道;0 = 关闭)
    let pollTimer: NodeJS.Timeout | undefined;
    if (pollIntervalMs > 0) {
        let lastSeen = readMarker(); // 注册时先取基线,避免启动即报一次
        pollTimer = setInterval(() => {
            const cur = readMarker();
            if (cur === lastSeen) {
                return;
            }
            const prev = lastSeen;
            lastSeen = cur;
            const reason = prev === undefined
                ? "安装布局标记出现(轮询兜底)"
                : cur === undefined
                    ? "安装布局标记消失(轮询兜底)"
                    : "安装布局标记内容变化(轮询兜底)";
            opts.logger?.debug(`${reason}:${(cur ?? "(缺失)").trim()}`);
            signalSoon(reason);
        }, pollIntervalMs);
    }

    return {
        dispose(): void {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = undefined;
            }
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = undefined;
            }
            for (const t of retryTimers) {
                clearTimeout(t);
            }
            retryTimers.clear();
            for (const d of disposables) {
                d.dispose();
            }
            disposables.length = 0;
        },
    };
}
