// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file fs-watcher.ts
 * 事件层(2026-08-29 自 driver/ 改名)：fs 监听(package.xml / COLCON_IGNORE)+ 去抖 + 路径聚合。
 *
 * 已接线:vscode.workspace.createFileSystemWatcher 监听工作区根下任意层级的 package.xml 与
 *   COLCON_IGNORE(create/change/delete),去抖后**带 dirs 下发**(2026-09-06 §12.3)。
 * 2026-09-08(文件服务层补盲):另订阅 vscode.workspace.onDidRenameFiles——**整目录移动/拖拽/F2 重命名**
 *   对 package.xml 内容型 watcher 不可见(无内容变化;Remote/轮询下目录 rename 常被合并漏报),此前只能
 *   等定时权威重建(≤30s);rename 命中(目录 / package.xml / COLCON_IGNORE)即转同构原始事件触发懒刷新,
 *   移动延迟降至秒级。终端 `mv` 无通知机制,仍由定时权威重建兜底(收敛结果一致)。
 * 只做"廉价预过滤"(监听范围限定在工作区根 RelativePattern)+ 路径收集;权威校验归数据层。
 * 聚合逻辑在 event/batcher.ts(纯 TS,可无头测)。
 */

import * as path from "path";
import { promises as fsPromises } from "fs";
import * as vscode from "vscode";
import { DriverEvent } from "./contracts";
import { createDebouncedDirBatcher } from "./batcher";
import { getLogger } from "../../../logger";

/** fs 监听模块日志(转换打点:原始事件收集 / 去抖 flush 下发) */
const log = getLogger("fs-watcher");

/** 驱动层 fs 监听接口 */
export interface FsWatcher {
    /** 订阅原始事件,返回取消订阅函数 */
    onExternalChange(cb: (ev: DriverEvent) => void): () => void;
    /** 释放监听与去抖定时器 */
    dispose(): void;
}

/** fs 监听选项 */
export interface FsWatcherOptions {
    /** 去抖窗口(毫秒),缺省 500 */
    debounceMs?: number;
    /** 工作区根(传入才创建 vscode 监听;undefined = 空实现,供无头测试) */
    workspaceRoot?: string;
    /**
     * 事件源注入(测试用,可无头):替代 vscode watcher 回调,收到 (kind, dir) 原始事件。
     * 不传则使用 vscode.workspace.createFileSystemWatcher(需 workspaceRoot)。
     */
    eventSource?: (onEvent: (kind: "workspace-package-changed" | "ignore-marker-changed", dir: string) => void) => () => void;
}

/** 创建 fs 监听:package.xml / COLCON_IGNORE 变化 → 路径聚合 → 去抖 → path-level changed(带 dirs) */
export function createFsWatcher(options: FsWatcherOptions = {}): FsWatcher {
    const listeners = new Set<(ev: DriverEvent) => void>();
    const debounceMs = options.debounceMs ?? 500;
    const root = options.workspaceRoot;
    const disposables: vscode.Disposable[] = [];

    const batcher = createDebouncedDirBatcher(debounceMs, (batch) => {
        log.debug(vscode.l10n.t("fs-watcher: flush dispatch kind={0} dirs={1}[{2}]", batch.kind, batch.dirs.length, batch.dirs.map((d) => path.basename(d)).join(",")));
        for (const l of listeners) {
            l({ kind: batch.kind, dirs: batch.dirs });
        }
    });

    const onEvent = (kind: "workspace-package-changed" | "ignore-marker-changed", fileFsPath: string): void => {
        // op 折叠:create/modify/delete 统一为"该路径需重推"(§12.3)
        const dir = path.normalize(path.dirname(fileFsPath));
        log.trace(vscode.l10n.t("fs-watcher: raw event kind={0} file={1} dir={2}", kind, path.basename(fileFsPath), path.basename(dir)));
        batcher.schedule(kind, dir);
    };

    if (options.eventSource) {
        disposables.push({ dispose: options.eventSource(onEvent) });
    } else if (root) {
        // 廉价预过滤 = 监听范围限定在工作区根(RelativePattern),不做重校验
        const pkgWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, "**/package.xml")
        );
        const ignoreWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, "**/COLCON_IGNORE")
        );
        const onPkg = (uri: vscode.Uri): void => onEvent("workspace-package-changed", uri.fsPath);
        const onIgnore = (uri: vscode.Uri): void => onEvent("ignore-marker-changed", uri.fsPath);
        disposables.push(
            pkgWatcher.onDidCreate(onPkg),
            pkgWatcher.onDidChange(onPkg),
            pkgWatcher.onDidDelete(onPkg),
            ignoreWatcher.onDidCreate(onIgnore),
            ignoreWatcher.onDidChange(onIgnore),
            ignoreWatcher.onDidDelete(onIgnore),
            pkgWatcher,
            ignoreWatcher
        );
        // ---- 2026-09-08:文件服务层 rename 补盲(Explorer 拖拽/移动/F2)----
        // 目录级移动对 package.xml 内容型 watcher 不可见(无内容变化;Remote/轮询下目录 rename 常漏报),
        // 此前只能等定时权威重建(≤30s)——此处把可探测的 rename 转成同构原始事件触发懒刷新(秒级);
        // 终端 mv 无通知机制,仍由定时权威重建兜底(收敛结果一致)。判定只做廉价预过滤(范围/形态),
        // 权威校验归数据层(路径事实原则,不改语义;数据层 isDirRelevant 会丢弃扫描范围外事件)。
        const baseName = (p: string): string => path.basename(path.normalize(p));
        const insideRoot = (p: string): boolean => {
            const rel = path.relative(root, path.normalize(p));
            return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
        };
        disposables.push(vscode.workspace.onDidRenameFiles((ev) => {
            for (const f of ev.files) {
                const oldP = f.oldUri.fsPath;
                const newP = f.newUri.fsPath;
                const oldIn = insideRoot(oldP);
                const newIn = insideRoot(newP);
                if (!oldIn && !newIn) {
                    continue;
                }
                const oName = oldIn ? baseName(oldP) : "";
                const nName = newIn ? baseName(newP) : "";
                if (oName === "COLCON_IGNORE" || nName === "COLCON_IGNORE") {
                    // 忽略标记被重命名/移动:按仍在工作区的一侧对账(目标位置优先)
                    log.trace(vscode.l10n.t("fs-watcher: rename COLCON_IGNORE ({0}) -> marker event", (oName || nName)));
                    onEvent("ignore-marker-changed", newIn ? newP : oldP);
                    continue;
                }
                if (oName === "package.xml" || nName === "package.xml") {
                    onEvent("workspace-package-changed", newIn ? newP : oldP);
                    continue;
                }
                // 整目录移动(包目录或其祖先):须确认目标侧是目录才当候选——单文件重命名与包无关,不触发
                const probe = newIn ? newP : oldP;
                void fsPromises.stat(path.normalize(probe)).then((st) => {
                    if (st.isDirectory()) {
                        log.trace(vscode.l10n.t("fs-watcher: directory rename triggers lazy refresh (dir={0})", path.basename(probe)));
                        onEvent("workspace-package-changed", path.join(probe, "package.xml")); // dir = probe;refresh 全量重扫
                    }
                }).catch(() => { /* 目标不可 stat(已移出/删除)→ 非目录候选,静默(定时兜底) */ });
            }
        }));
    }

    return {
        onExternalChange(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        dispose() {
            batcher.dispose();
            for (const d of disposables) {
                d.dispose();
            }
            listeners.clear();
        },
    };
}
// 修改时间:2026-09-09 00:08(文件服务层 rename 补盲:订阅 onDidRenameFiles——目录移动/package.xml/COLCON_IGNORE
// rename 转同构原始事件触发懒刷新,移动延迟 ≤30s → 秒级;终端 mv 仍由定时权威重建兜底)
