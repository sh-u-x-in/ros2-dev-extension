// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file event-collector.ts
 * 包服务层【触发器】:构建文件变化收集器(读侧增量驱动)。
 *
 * 监听工作区 setup.py / CMakeLists.txt 的创建/修改/删除 →
 * 过滤(仅真包目录)→ 去抖合并(多文件连续变化合并为一次)→ 通知中心节点 updatePackage(dir)。
 * 与中心节点的另一触发源(cache.onDidChange,package.xml 级)互补:
 *  - cache 事件:包新增/删除/构建类型变化 → 全量重建;
 *  - 本收集器:构建文件内容变化 → 单包增量。
 *
 * 设计(2026-08-22):
 *  - 只收磁盘 glob(FileSystemWatcher),天然不受虚拟文档干扰;
 *  - 去抖:全局 800ms 窗口合并一批目录,避免连存文件反复全量;
 *  - 依赖中心节点 isPackageDir 过滤非包目录,减少无效调用。
 */

import * as vscode from "vscode";
import * as path from "path";
import { getLogger } from "../../../../logger";
import { ExecutableMap } from "./executable-map";

/** 监听 glob:setup.py / CMakeLists.txt(构建文件) */
const BUILD_FILE_GLOB = "**/{setup.py,CMakeLists.txt}";

/** 全局去抖窗口(毫秒):窗口内累积的目录合并为一次刷新 */
const GLOBAL_DEBOUNCE_MS = 800;

/** 构建文件变化收集器日志 */
const log = getLogger("event-collector");

/** 触发器:收集构建文件变化 → 过滤 + 去抖 → 驱动中心节点增量更新 */
export class ExecutableChangeCollector {
    private watcher: vscode.FileSystemWatcher | undefined;
    private dirtyDirs = new Set<string>();
    private globalTimer: NodeJS.Timeout | undefined;

    constructor(private executableMap: ExecutableMap) {
        this.watcher = vscode.workspace.createFileSystemWatcher(BUILD_FILE_GLOB);
        this.watcher.onDidCreate((uri) => this.onBuildFile(uri));
        this.watcher.onDidChange((uri) => this.onBuildFile(uri));
        this.watcher.onDidDelete((uri) => this.onBuildFile(uri));
    }

    dispose(): void {
        if (this.globalTimer) {
            clearTimeout(this.globalTimer);
            this.globalTimer = undefined;
        }
        this.dirtyDirs.clear();
        this.watcher?.dispose();
        this.watcher = undefined;
    }

    // ---- 内部 ----

    private onBuildFile(uri: vscode.Uri): void {
        const dir = path.dirname(uri.fsPath);
        // 只关心真包目录内的构建文件(其余忽略,避免无效刷新)
        if (!this.executableMap.isPackageDir(dir)) {
            return;
        }
        this.dirtyDirs.add(dir);
        if (this.globalTimer) {
            clearTimeout(this.globalTimer);
        }
        this.globalTimer = setTimeout(() => {
            void this.flush();
        }, GLOBAL_DEBOUNCE_MS);
    }

    /** 去抖窗口到期:逐目录驱动中心节点增量更新(单包独立容错) */
    private async flush(): Promise<void> {
        this.globalTimer = undefined;
        const dirs = [...this.dirtyDirs];
        this.dirtyDirs.clear();
        for (const dir of dirs) {
            try {
                await this.executableMap.updatePackage(dir);
            } catch (err) {
                log.warn(`event-collector:单包更新失败:${dir}:${String(err)}`);
            }
        }
    }
}
