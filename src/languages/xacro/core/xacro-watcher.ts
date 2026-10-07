/**
 * xacro 展开图动态维护(设计 07)
 *
 * 增量监听(FileSystemWatcher + 按 uri 防抖 pending Map)+ 移动处理(rename)+
 * 事件驱动(系统包位置就绪)+ 分布式轮巡兜底(60s÷N,<0.1s 合并批量)。
 *
 * 继承 msg 诊断教训(rosmsg-diag-debounce-lesson):
 *  - 防抖用按 uri 的 pending Map 批量 flush,绝不用单 timer 全局单例
 *  - FileSystemWatcher 只收磁盘 glob,天然不受虚拟文档干扰;幽灵 change 由 upsert 内容比对过滤
 */

import * as vscode from "vscode";
import { getLogger } from "../../../logger";
import { IncludeGraph } from "./include-graph";
import { PackageMap, SystemDirLoadedEvent } from "../../shared/package-map";

const log = getLogger("xacro-watcher");

const WATCHER_GLOB = "**/*.{xacro,urdf}";
const WATCHER_DEBOUNCE_MS = 300;
const FALLBACK_POLL_PERIOD_MS = 60_000;
const POLL_BATCH_THRESHOLD_MS = 100; // 时间片 < 0.1s → 合并批量

export class XacroWatcher {
    private watcher: vscode.FileSystemWatcher | undefined;
    private liveSub: vscode.Disposable | undefined;
    private renameSub: vscode.Disposable | undefined;
    private dirLoadedSub: vscode.Disposable | undefined;
    private pending = new Map<string, { op: "upsert" | "remove"; text?: string }>();
    private flushTimer: NodeJS.Timeout | undefined;
    private pollTimer: NodeJS.Timeout | undefined;
    private disposed = false;

    constructor(
        private graph: IncludeGraph,
        private packages: PackageMap
    ) {}

    start(): void {
        if (this.watcher) {
            return;
        }
        // 增量监听(07 §1.1)
        this.watcher = vscode.workspace.createFileSystemWatcher(WATCHER_GLOB);
        this.watcher.onDidCreate(uri => this.scheduleUpsert(uri));
        this.watcher.onDidChange(uri => this.scheduleUpsert(uri));
        this.watcher.onDidDelete(uri => this.scheduleRemove(uri));

        // 活文本监听(2026-09-09):FileSystemWatcher 只收磁盘事件 → 图/诊断必须保存才更新;
        // 现订阅 onDidChangeTextDocument,把**未保存编辑的 live 文本**经同一防抖队列 upsert 入图,
        // 警告/跳转即时跟随(消除"须保存+切文件才产生/消除警告")。
        this.liveSub = vscode.workspace.onDidChangeTextDocument(e => {
            if (this.disposed) {
                return;
            }
            if (!this.isXacro(e.document.uri)) {
                return;
            }
            this.scheduleUpsert(e.document.uri, e.document.getText());
        });

        // 显式 rename(VS Code 内拖拽 / F2 / WorkspaceEdit,07 §2.1)
        this.renameSub = vscode.workspace.onDidRenameFiles(ev => {
            for (const file of ev.files) {
                if (this.isXacro(file.oldUri) || this.isXacro(file.newUri)) {
                    log.debug(`xacro rename:${file.oldUri.fsPath} -> ${file.newUri.fsPath}`);
                    this.graph.rename(file.oldUri, file.newUri);
                }
            }
        });

        // 系统包位置就绪 → 重解析引用该包的 pending 边(事件驱动,06 §0.3)
        this.dirLoadedSub = this.packages.onDirLoaded(ev => this.onSystemDirLoaded(ev));

        // 低频分布式轮巡兜底(06 §0.4)
        this.startPolling();
        log.debug(vscode.l10n.t("xacro watcher started: disk watch + live documents + rename + event-driven + polling"));
    }

    dispose(): void {
        this.disposed = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.liveSub?.dispose();
        this.renameSub?.dispose();
        this.dirLoadedSub?.dispose();
        this.watcher?.dispose();
        this.watcher = undefined;
    }

    // ---------- 防抖调度(07 §1.2) ----------

    private scheduleUpsert(uri: vscode.Uri, text?: string): void {
        this.pending.set(uri.toString(), { op: "upsert", text });
        this.resetTimer();
    }

    private scheduleRemove(uri: vscode.Uri): void {
        this.pending.set(uri.toString(), { op: "remove" });
        this.resetTimer();
    }

    private resetTimer(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
        }
        this.flushTimer = setTimeout(() => this.flush(), WATCHER_DEBOUNCE_MS);
    }

    private flush(): void {
        this.flushTimer = undefined;
        const items = Array.from(this.pending.entries());
        this.pending.clear();
        log.debug(vscode.l10n.t("xacro watcher flush: {0} items", items.length));
        for (const [key, item] of items) {
            if (this.disposed) {
                return;
            }
            const uri = vscode.Uri.parse(key);
            if (item.op === "upsert") {
                // 幽灵事件由 graph.upsert 内容比对过滤(07 §1.3);item.text = 活文本(未保存)
                this.graph.upsert(uri, item.text);
                // 自身 ${} 边重解 + property 变化传播依赖者(07 §1.4)
                this.graph.reparseDollarEdges(uri);
                this.graph.propagate(uri);
            } else {
                this.graph.remove(uri);
                this.graph.propagate(uri);
            }
        }
    }

    // ---------- 事件驱动(06 §0.3) ----------

    /** 系统包位置懒获取完成:重解析引用该包的所有 pending 边 */
    private onSystemDirLoaded(ev: SystemDirLoadedEvent): void {
        log.trace(vscode.l10n.t("System package location ready: {0}", ev.pkg));
        for (const node of this.graph.allNodes()) {
            const hit = node.includes.some(e => e.status === "pending" && e.raw.indexOf(ev.pkg) >= 0);
            if (hit) {
                this.graph.reparsePending(node.uri);
            }
        }
    }

    // ---------- 分布式轮巡(06 §0.4) ----------

    private startPolling(): void {
        const tick = (): void => {
            if (this.disposed) {
                return;
            }
            const pkgs = Array.from(this.collectPendingPackages());
            if (pkgs.length > 0) {
                const slice = FALLBACK_POLL_PERIOD_MS / pkgs.length;
                if (slice < POLL_BATCH_THRESHOLD_MS) {
                    // 分片收益 < IO 开销 → 合并批量一次查
                    for (const p of pkgs) {
                        this.packages.get(p);
                    }
                    log.debug(vscode.l10n.t("Poll: merged batch check of {0} pending packages", pkgs.length));
                } else {
                    // 时间平铺:每个包到点才查(懒获取,命中后事件驱动重解析)
                    pkgs.forEach((p, i) => {
                        setTimeout(() => {
                            if (!this.disposed) {
                                this.packages.get(p);
                            }
                        }, i * slice);
                    });
                    log.debug(vscode.l10n.t("Poll: {0} pending packages spread over time slices ({1} ms)", pkgs.length, Math.round(slice)));
                }
            }
            this.pollTimer = setTimeout(tick, FALLBACK_POLL_PERIOD_MS);
        };
        this.pollTimer = setTimeout(tick, FALLBACK_POLL_PERIOD_MS);
    }

    /** 收集图中所有 pending 包名(包路径类,含 $(find) / package://) */
    private collectPendingPackages(): Set<string> {
        const pkgs = new Set<string>();
        for (const node of this.graph.allNodes()) {
            for (const e of node.includes) {
                if (e.status !== "pending") {
                    continue;
                }
                const raw = e.raw;
                const findM = raw.match(/\$\(\s*find(?:\s*-\s*pkg-share)?\s+([a-zA-Z0-9_-]+)\s*\)/);
                if (findM) {
                    pkgs.add(findM[1]);
                    continue;
                }
                const pkgM = raw.match(/^package:\/\/([^/]+)/);
                if (pkgM) {
                    pkgs.add(pkgM[1]);
                }
            }
        }
        return pkgs;
    }

    private isXacro(uri: vscode.Uri): boolean {
        const ext = uri.fsPath.toLowerCase();
        return ext.endsWith(".xacro") || ext.endsWith(".urdf");
    }
}
