// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-cache.ts
 * 共享 package.xml 扫描缓存层(问题5 合并优化的"单一数据源"承载)。
 *
 * 设计(2026-08-21 建立共享缓存层;2026-08-29 cache/ 吸收进 data/,2026-09-03 复核内部专用):
 *  - 底层统一 scanWorkspacePackages(walk 原语,双超时 + maxDepth + 不跟随符号链接);
 *  - **双集合**:`unignore` = colcon 权威/并集名单(2026-09-06 V3:加 + 仅交集证据可删);
 *    `ignore` = 分类派生(2026-09-06:同目录/祖先遮蔽/嵌套重叠,见 §12.2);
 *  - **colconReady**:快照记录 colcon 是否成功注入,域层据此选 colcon 权威 或 walk 兜底;
 *  - **单飞重建**:同一时刻最多一个重建在跑,重复请求复用同一 Promise;
 *  - **双缓冲**:重建期间旧快照仍可读;完成原子替换;
 *  - **失效标记**:package.xml / COLCON_IGNORE / buildExcludeFolders 变化 → invalidate(),
 *    下次访问触发重建(懒重建);
 *  - **事件通知**:替换触发 onDidChange;内容指纹变化才 onContentChange(2026-09-03 复核:仅 data 订阅)。
 *
 * 2026-09-06(四项修复 §12 + §12.12 V3,见 package-core/数据源与事件链路现状详解-2026-09-06.md §12):
 *  - **重建分档**:doRebuild("full") = colcon list + walk(60s/首建/手动;删除与漂移在此收敛);
 *    doRebuild("lazy") = **只 walk** + V3 增量(并集加、交集证据删、白/黑名单实时转移);
 *  - **COLCON_IGNORE 事件不重建**:applyMarkerSync(dirs) 以 fs 事实幂等对账标记集 M → 池 × M 重分类
 *    (不 walk 不 colcon;成员在 ignore ⇄ unignore 间迁移);
 *  - **V3 pair 认证**:full 内 colcon→walk 紧邻(同 fs 代),list\walk → 白名单(onlylist 铁证,保留在 unignore;
 *    lazy 永不裁决),walk\list → 黑名单(walk-only 铁证,不进并集);定义域 = 未忽略子集(ignore 域不入名单);
 *  - **门控**:timedOut 的 walk 禁止 pair 认证与任何删/补/名单裁决;名单内存态、不落盘。
 *
 * 对外(compose/data)仍只暴露既有方法 + applyMarkerSync;细节变化不破坏外部形态。
 */

import { l10n } from "vscode";

import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "../shared/emitter";
import { getLogger } from "../../../logger";
import {
    scanWorkspacePackages,
    PackageScanEntry,
    PackageScanOptions,
    PackageScanResult,
} from "../scan/package-scan";
import { classifyEntries, isVisibleEntry } from "../scan/ignore-classify";

/** 共享缓存模块日志 */
const log = getLogger("package-cache");

/** 配置变化去抖窗口(毫秒):连续修改排除列表/followSymlinks 合并,避免反复触发全量重建 */
const CONFIG_DEBOUNCE_MS = 5000;

/** 路径归一化比较键 */
const normDir = (p: string): string => path.normalize(p);

/** 日志摘要:包名列表 */
const namesOf = (list: readonly { name: string }[]): string => list.map((w) => w.name).join(",");

/** 日志摘要:目录名列表(末段) */
const tailsOf = (list: readonly string[]): string => list.map((d) => path.basename(d)).join(",");

/** 工作区包(与 colcon-utils 的 Package 同构:{name, path});buildType 由本层从 walk 画像合并(2026-09-02) */
export interface WorkspacePackage {
    name: string;
    path: string;
    /** 构建类型(从 entries(walk 画像)按 path 合并;colcon list 快路径未 walk 时为 undefined) */
    buildType?: string;
}

/** colcon list 执行器(由调用方注入,如 colcon-utils 的真实 colcon list;保持本模块无 child_process 依赖) */
export type ColconListExecutor = () => Promise<WorkspacePackage[]>;

/**
 * 按 path 从 walk 画像(entries)补 buildType——colcon list / walk 的 WorkspacePackage 本身无类型字段,
 * 类型信息由本层(物理数据源)合并后随快照下传,data 层直接继承,不再跨层取数(2026-09-02)。
 */
function attachBuildType(list: WorkspacePackage[], entries: PackageScanEntry[]): WorkspacePackage[] {
    if (entries.length === 0) {
        return list;
    }
    const byDir = new Map(entries.map((e) => [e.dir, e.buildType]));
    return list.map((w) => ({ ...w, buildType: w.buildType ?? byDir.get(w.path) }));
}

/** 由分类后的 entries 派生 ignore 物化名单(合法 && name && ignoredBy 非空) */
function deriveIgnore(entries: PackageScanEntry[]): WorkspacePackage[] {
    return entries
        .filter((e) => e.isValid && !!e.name && !!e.ignoredBy)
        .map((e) => ({ name: e.name!, path: e.dir, buildType: e.buildType }));
}

/** 由分类后的 entries 派生 walk 侧 visible(池)目录集 */
function visibleDirSet(entries: PackageScanEntry[]): Set<string> {
    return new Set(entries.filter(isVisibleEntry).map((e) => normDir(e.dir)));
}

/**
 * 共享包清单快照:
 *  - `unignore`:参与构建名单(2026-09-06 V3 = colcon 权威 ∪ lazy 并集补入,白名单成员常驻;交集证据可删);
 *  - `ignore`:分类派生的被忽略包(同目录/祖先遮蔽/嵌套重叠,§12.2);
 *  - `entries`:walk 全量画像(含 ignoredBy 分类,isValid=false 的孤立 package.xml 亦在内);
 *  - `ignoreMarkers`:标记集 M(2026-09-06 P2:哪些目录含 COLCON_IGNORE,含非包目录;事件增量 + walk 全量重同步);
 *  - `whitelist`/`blacklist`:V3 pair 认证结果(onlylist 白名单 / walk-only 黑名单;仅未忽略子集内);
 *  - `colconReady`:colcon 是否成功注入过(2026-09-02 设计 D2;"成功但空"≠"没跑")。
 */
export interface PackageSnapshot {
    unignore: WorkspacePackage[];
    ignore: WorkspacePackage[];
    entries: PackageScanEntry[];
    ignoreMarkers: string[];
    whitelist: string[];
    blacklist: string[];
    timedOut: boolean;
    elapsedMs: number;
    generatedAt: number;
    contentFingerprint: string;
    colconReady: boolean;
}

/** 缓存配置(与 scanWorkspacePackages 对齐) */
export interface PackageCacheConfig {
    /** buildExcludeFolders 配置 */
    excludedFolders?: string[];
    /** 分支时长限制(毫秒),默认 = WALK_TIMEOUT_PROFILES.package.branchTimeoutMs(2000,独立且小于总超时) */
    branchTimeoutMs?: number;
    /** 总超时时长(毫秒),默认 = WALK_TIMEOUT_PROFILES.package.totalTimeoutMs(10000) */
    totalTimeoutMs?: number;
    /** 最大递归深度,默认 = WALK_TIMEOUT_PROFILES.package.maxDepth(8) */
    maxDepth?: number;
    /** 是否跟随符号链接,默认 = WALK_FOLLOW_SYMLINKS_DEFAULT(false) */
    followSymlinks?: boolean;
    /** 配置变化去抖窗口(毫秒),默认 5000;测试可调小 */
    configDebounceMs?: number;
}

/** 简单事件发射器事件类型(对外;实现见 shared/emitter,2026-08-29 共享化) */
export type CacheEvent<T> = (listener: (payload: T) => void) => () => void;

/** 快照构造辅助(统一缺省新字段,防漏) */
function buildSnapshot(partial: Partial<PackageSnapshot> & {
    unignore: WorkspacePackage[]; ignore: WorkspacePackage[]; entries: PackageScanEntry[];
    timedOut: boolean; elapsedMs: number; generatedAt: number; contentFingerprint: string; colconReady: boolean;
}): PackageSnapshot {
    return {
        ignoreMarkers: partial.ignoreMarkers ?? [],
        whitelist: partial.whitelist ?? [],
        blacklist: partial.blacklist ?? [],
        ...partial,
    };
}

/**
 * 共享 package.xml 扫描缓存(单飞重建 + 双缓冲 + 失效 + 事件 + V3 状态机)。
 * 线程安全:所有读走同步 getter;重建走单飞 Promise;替换在 finally 原子完成。
 * 纯 TS 实现,不依赖 vscode(可在无头环境单独测试;workspace 相关注入由外部/工厂层负责)。
 */
export class PackageCache {
    private config: PackageCacheConfig;
    private workspaceRoot: string;

    /** 当前快照(双缓冲:重建期间保持旧值可读) */
    private snapshot: PackageSnapshot | undefined;
    /** 重建中的 Promise(单飞:并发请求复用同一 Promise) */
    private rebuildPromise: Promise<PackageSnapshot> | undefined;
    /** 失效标记:置脏后下次 ensureFresh 触发重建 */
    private dirty = false;
    /** walk 快照是否已生成(syncUnignore 只注入 unignore,不置此标志 → ensureFresh 仍会触发 walk 补齐) */
    private walkReady = false;
    /** 快照替换事件发射器 */
    private changedEmitter = new EventEmitter<PackageSnapshot>();
    /** 快照内容变化事件发射器(内容指纹不同才 fire) */
    private contentChangedEmitter = new EventEmitter<PackageSnapshot>();
    /** colcon list 执行器(由调用方注入;未注入时无 colcon 权威,名单退 walk 侧) */
    private colconListExecutor: ColconListExecutor | undefined;
    /** 配置变化去抖定时器(updateConfig 检测到 key 变化后启动/重置,到期才标脏) */
    private configDebounceTimer: NodeJS.Timeout | undefined;

    constructor(workspaceRoot: string, config: PackageCacheConfig = {}) {
        this.workspaceRoot = workspaceRoot;
        this.config = config;
    }

    /** 快照替换完成事件(替换即 fire,内容未必变;供消费者按需再判) */
    readonly onDidChange: CacheEvent<PackageSnapshot> = (listener) => this.changedEmitter.event(listener);

    /** 快照【内容变化】事件:仅当内容指纹变化才 fire(重建但内容没变 → 不 fire) */
    readonly onContentChange: CacheEvent<PackageSnapshot> = (listener) => this.contentChangedEmitter.event(listener);

    /** 缓存键(用于外部比对,如配置变化时判断是否需失效) */
    get key(): string {
        return this.buildKey();
    }

    /** 工作区根(2026-09-06 起对数据层只读暴露:ingest/toggle 的祖先遮蔽判定需锚定根) */
    getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    /** 注入 colcon list 执行器(接入时经 ros2/ 执行口提供) */
    setColconListExecutor(executor: ColconListExecutor): void {
        this.colconListExecutor = executor;
    }

    /** 当前快照(同步读,未生成/重建中返回旧值或 undefined,不阻塞) */
    getSnapshot(): PackageSnapshot | undefined {
        return this.snapshot;
    }

    /** 是否已有快照 */
    hasSnapshot(): boolean {
        return this.snapshot !== undefined;
    }

    /** 当前快照的 unignore(未就绪返回空数组,不阻塞) */
    getUnignore(): WorkspacePackage[] {
        return this.snapshot ? this.snapshot.unignore : [];
    }

    /** 当前快照的 ignore(未就绪返回空数组,不阻塞) */
    getIgnore(): WorkspacePackage[] {
        return this.snapshot ? this.snapshot.ignore : [];
    }

    /**
     * 偏置接口(用户设计,2026-08-21):内部执行 colcon list,返回 unignore,同时内部保留一份。
     * 构建链路/未就绪路径调用:快速获得权威 unignore(colcon list 快),不等 walk 全量。
     * 2026-09-02(语义修正):执行器抛错 → 不标记 colconReady、不替换快照(失败 ≠ "跑了但空")。
     * 2026-09-06(V3):colcon-only 观测不写白/黑名单(pair 才能认证),名单原样保留。
     */
    async syncUnignore(): Promise<WorkspacePackage[]> {
        if (!this.colconListExecutor) {
            log.warn(l10n.t("Package list executor not injected; skipping authoritative list refresh"));
            return [];
        }
        let unignore: WorkspacePackage[];
        try {
            unignore = await this.colconListExecutor();
        } catch (err) {
            log.warn(l10n.t("colcon list failed; package list stays not-ready: {0}", err instanceof Error ? err.message : String(err)));
            return this.snapshot ? this.snapshot.unignore : [];
        }
        // 从已有 walk 画像(entries,若已就绪)补 buildType
        const prev = this.snapshot;
        const merged = attachBuildType(unignore, prev ? prev.entries : []);
        const snap = buildSnapshot({
            unignore: merged,
            // 2026-09-13:原 `deriveIgnore(prev ? prev.entries : [])` 在外层三目 false 分支内层三目恒假
            // (prev 已收窄为 undefined)→ never;语义等价写法 = 无快照时从空画像派生
            ignore: prev ? prev.ignore : deriveIgnore([]),
            entries: prev ? prev.entries : [],
            ignoreMarkers: prev ? prev.ignoreMarkers : [],
            whitelist: prev ? prev.whitelist : [],
            blacklist: prev ? prev.blacklist : [],
            timedOut: prev ? prev.timedOut : false,
            elapsedMs: prev ? prev.elapsedMs : 0,
            generatedAt: Date.now(),
            contentFingerprint: "",
            colconReady: true, // colcon list 已成功执行(即使空名单也是权威事实)
        });
        snap.contentFingerprint = this.computeContentFingerprint(snap);
        const oldFp = prev?.contentFingerprint;
        this.snapshot = snap;
        if (oldFp !== snap.contentFingerprint) {
            this.contentChangedEmitter.fire(snap);
        }
        log.debug(l10n.t("package-cache: colcon list injected; unignore={0}", merged.length));
        return merged;
    }

    /** 标记失效:下次 ensureFresh 触发重建(懒重建,事件驱动调用) */
    invalidate(): void {
        this.dirty = true;
        log.trace("package-cache: marked dirty; rebuilding on next access");
    }

    /**
     * 确保快照最新(懒重建,2026-09-06 分档):
     *  - 已有完整快照且未脏 → 直接返回;
     *  - 已有完整快照且脏 → **lazy**(只 walk + V3 增量,不跑 colcon);
     *  - 无完整快照(冷启动/仅 colcon 注入过)→ **full**(colcon + walk 全量权威)。
     * 并发调用共享同一重建 Promise(单飞)。
     */
    async ensureFresh(): Promise<PackageSnapshot> {
        if (this.snapshot && this.walkReady && !this.dirty) {
            log.trace("package-cache: ensureFresh snapshot fresh; returning as-is (no rebuild)");
            return this.snapshot;
        }
        if (this.snapshot && this.walkReady) {
            log.debug("package-cache: ensureFresh dirty -> lazy rebuild (walk + incremental only, no colcon)");
            return this.rebuild("lazy");
        }
        log.debug("package-cache: ensureFresh no full snapshot (cold start / colcon-only) -> full rebuild (colcon+walk authoritative)");
        return this.rebuild("full");
    }

    /**
     * 强制重建(单飞)。
     * @param mode "full"(默认)= colcon + walk 全量权威(pair 认证;60s 定时 / 手动 / 首建);
     *             "lazy" = 只 walk + V3 增量(不跑 colcon;watcher/懒路径)
     */
    async rebuild(mode: "full" | "lazy" = "full"): Promise<PackageSnapshot> {
        if (this.rebuildPromise) {
            return this.rebuildPromise;
        }
        log.debug(l10n.t("package-cache: rebuilding shared package snapshot (mode={0})", mode));
        this.rebuildPromise = this.doRebuild(mode).finally(() => {
            this.rebuildPromise = undefined;
        });
        return this.rebuildPromise;
    }

    /**
     * COLCON_IGNORE 事件路径(2026-09-06 §12.5):以 **fs 事实**幂等对账标记集 M(存在 dir/COLCON_IGNORE
     * → M ∪ {dir},否则 M \ {dir};不信任 op,契合"重推而非事件算术"),然后池 × M 重分类:
     * 新被忽略成员移出 unignore(ignore 域接管);解除忽略成员**优先进交集区(unignore)**静待下次 pair。
     * **不 walk、不 colcon**。无快照/标记未变 → 直接返回(不 fire)。
     */
    async applyMarkerSync(dirs: string[]): Promise<void> {
        if (dirs.length === 0) {
            return;
        }
        // 与进行中的重建串行:先等重建落定,再基于最新快照对账(避免丢更新)
        if (this.rebuildPromise) {
            await this.rebuildPromise.catch(() => undefined);
        }
        const prev = this.snapshot;
        if (!prev) {
            log.trace("package-cache: applyMarkerSync no snapshot; skipping (reconcile after first build)");
            return;
        }
        log.debug(`cache:applyMarkerSync:start dirs=${tailsOf(dirs)} M(prev)=${prev.ignoreMarkers.length}`);
        const markerSet = new Set(prev.ignoreMarkers.map(normDir));
        const markerOps: string[] = [];
        let changed = false;
        for (const raw of dirs) {
            const d = normDir(raw);
            let exists = false;
            try {
                await fs.promises.access(path.join(d, "COLCON_IGNORE"));
                exists = true;
            } catch {
                exists = false;
            }
            if (exists !== markerSet.has(d)) {
                if (exists) {
                    markerSet.add(d);
                } else {
                    markerSet.delete(d);
                }
                markerOps.push(`${path.basename(d)}:${exists ? "add" : "remove"}`);
                changed = true;
            }
        }
        if (!changed) {
            log.trace(l10n.t("cache: applyMarkerSync no marker changes; returning (dirs={0})", tailsOf(dirs)));
            return;
        }
        log.debug(l10n.t("cache: applyMarkerSync marker changes {0}: {1}", markerOps.length, markerOps.join(",")));
        const markers = [...markerSet].sort();
        const classified = classifyEntries(prev.entries, markers, this.workspaceRoot);
        const prevIgnoredDirs = new Set(prev.entries.filter((e) => !!e.ignoredBy).map((e) => normDir(e.dir)));
        const blSet = new Set(prev.blacklist.map(normDir)); // 黑名单(walk-only)抑制并集补入,applyMarkerSync 同样遵守
        const unignoreMap = new Map(prev.unignore.map((w) => [normDir(w.path), w]));
        const movedIn: string[] = [];   // ignore → unignore(解除忽略,优先进交集)
        const movedOut: string[] = [];  // unignore → ignore(新被忽略)
        for (const e of classified) {
            const d = normDir(e.dir);
            if (!e.ignoredBy && prevIgnoredDirs.has(d) && !!e.name) {
                // 解除忽略 → 入 unignore(交集乐观,静待 pair);黑名单成员除外(pair 专属裁决)
                if (!unignoreMap.has(d) && !blSet.has(d)) {
                    unignoreMap.set(d, { name: e.name, path: e.dir, buildType: e.buildType });
                    movedIn.push(e.name!);
                }
            } else if (e.ignoredBy && unignoreMap.has(d)) {
                // 新被忽略 → 移出 unignore(ignore 域接管;白/黑名单由 pair 专属,不在此动)
                unignoreMap.delete(d);
                movedOut.push(e.name!);
            }
        }
        if (movedIn.length > 0) {
            log.debug(l10n.t("cache: applyMarkerSync un-ignored -> into intersection (unignore) {0}: {1}", movedIn.length, movedIn.join(",")));
        }
        if (movedOut.length > 0) {
            log.debug(l10n.t("cache: applyMarkerSync newly ignored -> removed from unignore (ignore domain takes over) {0}: {1}", movedOut.length, movedOut.join(",")));
        }
        const snap = buildSnapshot({
            unignore: [...unignoreMap.values()],
            ignore: deriveIgnore(classified),
            entries: classified,
            ignoreMarkers: markers,
            whitelist: prev.whitelist,
            blacklist: prev.blacklist,
            timedOut: prev.timedOut,
            elapsedMs: prev.elapsedMs,
            generatedAt: Date.now(),
            contentFingerprint: "",
            colconReady: prev.colconReady,
        });
        snap.contentFingerprint = this.computeContentFingerprint(snap);
        const oldFp = prev.contentFingerprint;
        const fpChanged = oldFp !== snap.contentFingerprint;
        this.snapshot = snap;
        log.debug(
            `cache: applyMarkerSync done M=${markers.length} u=${snap.unignore.length} (prev=${prev.unignore.length}) ` +
            `i=${snap.ignore.length} w=${snap.whitelist.length} b=${snap.blacklist.length} fingerprintChanged=${fpChanged}`
        );
        if (fpChanged) {
            this.contentChangedEmitter.fire(snap);
        }
    }

    /** 实际重建(内部:colcon 权威(仅 full)→ walk 扫描 → 分类 → V3 增量/全量 → 物化 → 原子替换 → 通知) */
    private async doRebuild(mode: "full" | "lazy"): Promise<PackageSnapshot> {
        try {
            const prev = this.snapshot;
            const prevColconReady = prev ? prev.colconReady : false;
            const prevUnignore = prev ? prev.unignore : [];
            log.debug(
                `cache:doRebuild:start mode=${mode} prev(u=${prevUnignore.length},` +
                `w=${prev?.whitelist.length ?? 0},b=${prev?.blacklist.length ?? 0},c=${prevColconReady})`
            );

            // ①(full)colcon 权威刷新:成功 → 新名单 + colconReady=true;失败/未注入 → colconReady 不变,
            //    名单退 prev(或空),后续走 lazy 增量(V3 门控:失败 = 看不出,不认证)。
            let colconOk = false;
            let colconList: WorkspacePackage[] | null = null;
            if (mode === "full" && this.colconListExecutor) {
                try {
                    colconList = await this.colconListExecutor();
                    colconOk = true;
                } catch (err) {
                    log.warn(l10n.t("colcon list failed; skipping reconcile this round: {0}", err instanceof Error ? err.message : String(err)));
                }
            }
            if (mode === "full") {
                log.debug(`cache: colcon authoritative ${colconOk ? l10n.t("succeeded, {0} collected", String((colconList ?? []).length)) : l10n.t("failed/not injected; not authenticated this round (list falls back to incremental)")}`);
            }

            // ②walk 扫描 + 分类(池 × M)
            const scanOptions: PackageScanOptions = {
                workspaceRoot: this.workspaceRoot,
                excludedFolders: this.config.excludedFolders ?? [],
                branchTimeoutMs: this.config.branchTimeoutMs,
                totalTimeoutMs: this.config.totalTimeoutMs,
                maxDepth: this.config.maxDepth,
                followSymlinks: this.config.followSymlinks,
            };
            const result: PackageScanResult = await scanWorkspacePackages(scanOptions);
            const classified = classifyEntries(result.entries, result.ignoreMarkers, this.workspaceRoot);
            const markers = [...new Set(result.ignoreMarkers.map(normDir))].sort();
            const timedOut = result.timedOut;
            const walkVisible = visibleDirSet(classified);

            // ③ 名单计算(full + colcon 成功 = 权威名单 + pair 认证;其余 = V3 增量)
            let unignore: WorkspacePackage[];
            let whitelist: string[];
            let blacklist: string[];
            let colconReady = prevColconReady;

            if (mode === "full" && colconOk) {
                // ③a 权威名单恒应用(colcon list 成功即可信,删除在此收敛);pair 认证仅在同代完整 walk 时进行
                const fresh = colconList ?? [];
                const listDirs = new Set(fresh.map((w) => normDir(w.path)));
                const walkDirs = walkVisible;
                if (!timedOut) {
                    // pair 认证(同 fs 代,铁证):list\walk → 白名单;walk\list → 黑名单;整体重算
                    whitelist = [...listDirs].filter((d) => !walkDirs.has(d)).sort();
                    blacklist = [...walkDirs].filter((d) => !listDirs.has(d)).sort();
                } else {
                    // walk 超时:不认证(V3 门控),白/黑名单保留旧值待下轮;名单本身仍按 colcon 更新
                    whitelist = prev?.whitelist ?? [];
                    blacklist = prev?.blacklist ?? [];
                    log.warn(l10n.t("Directory walk timed out: package list updated per colcon; trusted diff list keeps old values until next reconcile"));
                }
                unignore = attachBuildType(fresh, classified);
                colconReady = true;
                if (!timedOut) {
                    const prevW = new Set((prev?.whitelist ?? []).map(normDir));
                    const prevB = new Set((prev?.blacklist ?? []).map(normDir));
                    log.debug(
                        `cache(full):pair 认证 list=${fresh.length} walk=${walkDirs.size} | ` +
                        `白名单=${whitelist.length}[${tailsOf(whitelist)}]` +
                        `(Δ+${whitelist.filter((d) => !prevW.has(d)).length}/−${[...prevW].filter((d) => !whitelist.includes(d)).length}) | ` +
                        `黑名单=${blacklist.length}[${tailsOf(blacklist)}]` +
                        `(Δ+${blacklist.filter((d) => !prevB.has(d)).length}/−${[...prevB].filter((d) => !blacklist.includes(d)).length})`
                    );
                }
            } else {
                // ③b 增量路径(lazy;或 full 但 colcon 失败/未注入):
                //     base = prev unignore(colcon 权威或上轮并集);在其上做 V3 增量。
                const prevWhitelist = new Set((prev?.whitelist ?? []).map(normDir));
                const prevBlacklist = new Set((prev?.blacklist ?? []).map(normDir));
                const prevVisible = prev ? visibleDirSet(prev.entries) : new Set<string>();
                const nowIgnoredDirs = new Set(
                    classified.filter((e) => !!e.ignoredBy && e.isValid).map((e) => normDir(e.dir)),
                );

                // V3 门控:timedOut 的 walk 禁止一切删/补/名单裁决 → 只刷新画像,名单原样保留并保持脏(下轮重试)
                if (timedOut) {
                    log.warn(l10n.t("Directory walk timed out ({0}): refreshing package details only this round; package list keeps old values", mode));
                    const snap = buildSnapshot({
                        unignore: prevUnignore,
                        ignore: deriveIgnore(classified),
                        entries: classified,
                        ignoreMarkers: markers,
                        whitelist: prev?.whitelist ?? [],
                        blacklist: prev?.blacklist ?? [],
                        timedOut,
                        elapsedMs: result.elapsedMs,
                        generatedAt: Date.now(),
                        contentFingerprint: "",
                        colconReady: prevColconReady,
                    });
                    this.publish(snap, prev);
                    this.dirty = true; // 部分结果不干净:下次访问再重建
                    return snap;
                }

                // 快删(交集证据):prev 成员 ∈ prevVisible(上轮完整 walk 见过)且本轮 walkVisible 无它 → 直接删;
                // whitelist 成员(无 walk 证据)→ 永不因 walk 丢失被删;本轮新被忽略成员移出(unignore 与 ignore 不相交)
                const entryMap = new Map(classified.map((e) => [normDir(e.dir), e]));
                const drop = new Set<string>();
                for (const w of prevUnignore) {
                    const d = normDir(w.path);
                    if (prevVisible.has(d) && !walkVisible.has(d)) {
                        drop.add(d);
                    }
                }
                const keep = prevUnignore.filter((w) => !drop.has(normDir(w.path)) && !nowIgnoredDirs.has(normDir(w.path)));

                // 白名单实时降级:walk 本轮看见 → 移出(已是 unignore 常规成员,含于 keep)
                whitelist = [...prevWhitelist].filter((d) => !walkVisible.has(d)).sort();
                // 黑名单实时除名:walk 本轮不再见 → 移出(黑名单成员仅在仍 walk 可见时保留)
                blacklist = [...prevBlacklist].filter((d) => walkVisible.has(d)).sort();

                // 并集补入(walk 侧"加",V3):walk 新见 && 不在 keep && 不在黑名单 → 入 unignore(交集乐观)
                const keepDirs = new Set(keep.map((w) => normDir(w.path)));
                const blSet = new Set(blacklist.map(normDir));
                const added: WorkspacePackage[] = [];
                for (const d of walkVisible) {
                    if (keepDirs.has(d) || blSet.has(d)) {
                        continue;
                    }
                    const e = entryMap.get(d);
                    if (e && e.name) {
                        const w = { name: e.name, path: e.dir, buildType: e.buildType };
                        keep.push(w);
                        added.push(w);
                        keepDirs.add(d);
                    }
                }
                unignore = keep;

                // 转移打点(进出状态一目了然)
                if (drop.size > 0) {
                    log.debug(l10n.t("cache(lazy): fast-drop (intersection evidence lost, no longer seen by walk) {0}: {1}", drop.size, tailsOf([...drop])));
                }
                const wlRemoved = [...prevWhitelist].filter((d) => walkVisible.has(d));
                const blRemoved = [...prevBlacklist].filter((d) => !walkVisible.has(d));
                if (wlRemoved.length > 0) {
                    log.debug(l10n.t("cache(lazy): whitelist demoted (seen by walk this round) -> regular members {0}: {1}", wlRemoved.length, tailsOf(wlRemoved)));
                }
                if (blRemoved.length > 0) {
                    log.debug(l10n.t("cache(lazy): blacklist removed (no longer seen by walk) {0}: {1}", blRemoved.length, tailsOf(blRemoved)));
                }
                if (added.length > 0) {
                    log.debug(l10n.t("cache(lazy): union additions (newly visible/unshadowed) {0}: {1}", added.length, namesOf(added)));
                }
                log.debug(`cache(lazy):增量完成 u=${unignore.length}(prev=${prevUnignore.length}) w=${whitelist.length} b=${blacklist.length}`);
            }

            // ④ 差异诊断(full 认证成功时):残余差异已由 V3 分类收敛为白/黑名单(§12.10 归因),报数即可
            if (mode === "full" && colconOk && !timedOut && (whitelist.length > 0 || blacklist.length > 0)) {
                log.info(
                    `Package list reconciled (colcon {0} / dir-visible {1})` +
                    `; colcon-only (trusted) {0}: {1}; dir-only (pending authoritative confirm) {2}: {3}`
                );
            }

            const snap = buildSnapshot({
                unignore,
                ignore: deriveIgnore(classified),
                entries: classified,
                ignoreMarkers: markers,
                whitelist,
                blacklist,
                timedOut,
                elapsedMs: result.elapsedMs,
                generatedAt: Date.now(),
                contentFingerprint: "",
                colconReady,
            });
            return this.publish(snap, prev);
        } catch (e) {
            // 重建失败:保留旧快照(双缓冲),标记脏以便下次重试,不向调用方抛异常
            const msg = e instanceof Error ? e.message : String(e);
            log.warn(l10n.t("Package data rebuild failed; keeping old snapshot: {0}", msg));
            this.dirty = true;
            if (this.snapshot) {
                return this.snapshot;
            }
            const empty: PackageSnapshot = buildSnapshot({
                unignore: [],
                ignore: [],
                entries: [],
                timedOut: true,
                elapsedMs: 0,
                generatedAt: Date.now(),
                contentFingerprint: "",
                colconReady: false,
            });
            empty.contentFingerprint = this.computeContentFingerprint(empty);
            this.snapshot = empty;
            this.dirty = true;
            return empty;
        }
    }

    /** 原子替换 + 通知(替换即 onDidChange;指纹变才 onContentChange) */
    private publish(snap: PackageSnapshot, old: PackageSnapshot | undefined): PackageSnapshot {
        snap.contentFingerprint = this.computeContentFingerprint(snap);
        const oldFp = old?.contentFingerprint;
        const fpChanged = oldFp !== snap.contentFingerprint;
        this.snapshot = snap;
        this.walkReady = true;
        this.dirty = false;
        const summary =
            `u=${snap.unignore.length} i=${snap.ignore.length} w=${snap.whitelist.length} b=${snap.blacklist.length}` +
            ` m=${snap.ignoreMarkers.length} c=${snap.colconReady} timedOut=${snap.timedOut}`;
        if (old) {
            log.debug(l10n.t("package-cache: publish replaced {{{0}}} in {1} ms; fingerprintChanged={2}", summary, snap.elapsedMs, fpChanged));
        } else {
            log.debug(l10n.t("package-cache: publish generated {{{0}}} in {1} ms", summary, snap.elapsedMs));
        }
        this.changedEmitter.fire(snap);
        if (fpChanged) {
            this.contentChangedEmitter.fire(snap);
        }
        return snap;
    }

    /**
     * 快照内容指纹:覆盖消费方关心的全部内容(entries 画像(含 ignoredBy)+ unignore/ignore 名单 +
     * whitelist/blacklist + colconReady),排序拼接保证顺序无关。ignoreMarkers 本身不入指纹
     * (标记变而分类不变 → 不 fire,避免打扰)。
     */
    private computeContentFingerprint(snap: PackageSnapshot): string {
        const entries = snap.entries
            .map((e) => `${e.dir}|${e.name ?? ""}|${e.buildType ?? ""}|${e.isValid}|${e.hasColconIgnore}|${e.ignoredBy ?? ""}|${e.parentIsSrc}`)
            .sort()
            .join("\n");
        const unignore = snap.unignore.map((w) => `${w.path}|${w.name}|${w.buildType ?? ""}`).sort().join("\n");
        const ignore = snap.ignore.map((w) => `${w.path}|${w.name}|${w.buildType ?? ""}`).sort().join("\n");
        const whitelist = [...snap.whitelist].sort().join("\n");
        const blacklist = [...snap.blacklist].sort().join("\n");
        return `${entries}\n==U==\n${unignore}\n==I==\n${ignore}\n==W==\n${whitelist}\n==B==\n${blacklist}\n==C==\n${snap.colconReady}`;
    }

    /** 构建缓存键(工作区根 + 排除目录 + 符号链接策略,任一变化 → 缓存失效) */
    private buildKey(): string {
        const excluded = this.config.excludedFolders ?? [];
        const follow = this.config.followSymlinks ?? false;
        return `${this.workspaceRoot}|${excluded.join(",")}|follow=${follow}`;
    }

    /**
     * 配置变化检测:与当前 key 比对,不同则更新配置并【去抖后】失效(供外部配置监听调用)。
     * 去抖:不立即标脏,启动/重置 5s 定时器——用户在设置里连续修改排除列表/followSymlinks 时
     * 合并为一次重建,避免过于灵敏反复触发全量重扫描。
     */
    updateConfig(config: PackageCacheConfig): void {
        const oldKey = this.buildKey();
        this.config = config;
        const newKey = this.buildKey();
        if (oldKey !== newKey) {
            if (this.configDebounceTimer) {
                clearTimeout(this.configDebounceTimer);
            }
            const debounceMs = this.config.configDebounceMs ?? CONFIG_DEBOUNCE_MS;
            this.configDebounceTimer = setTimeout(() => {
                this.configDebounceTimer = undefined;
                log.debug(l10n.t("package-cache: config-change debounce elapsed ({0} ms); invalidated", debounceMs));
                this.dirty = true;
            }, debounceMs);
        }
    }

    /** 释放资源(移除事件监听与去抖定时器) */
    dispose(): void {
        this.changedEmitter.dispose();
        this.contentChangedEmitter.dispose();
        if (this.configDebounceTimer) {
            clearTimeout(this.configDebounceTimer);
            this.configDebounceTimer = undefined;
        }
    }
}

/**
 * 便捷:按工作区根创建/获取共享缓存实例(2026-09-03 复核:仅供组合根 compose.ts 内部
 * 装配复用,非对外 API——api/ 已不导出本函数)。
 */
let sharedCache: PackageCache | undefined;
export function getSharedPackageCache(workspaceRoot: string): PackageCache | undefined {
    if (!workspaceRoot) {
        return undefined;
    }
    if (!sharedCache || sharedCache.key.split("|")[0] !== normalizeRoot(workspaceRoot)) {
        const oldRoot = sharedCache ? sharedCache.key.split("|")[0] : undefined;
        sharedCache = new PackageCache(workspaceRoot);
        log.debug(`package-cache: new shared cache instance: ${workspaceRoot}${oldRoot ? l10n.t(" (replacing old root: {0})", oldRoot) : ""}`);
    }
    return sharedCache;
}

/** 路径归一化(避免引入 vscode 依赖;仅作 key 前缀比对用) */
function normalizeRoot(p: string): string {
    // 去除尾部分隔符,统一为正斜杠风格比对
    return p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}
