// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * 数据层入口(夹中间):统一状态 + 派生计算 + 权威校验 + 调度。
 *
 *  - 订阅驱动层原始事件(定时器/监听),决定"要不要重算、怎么重算";
 *  - 状态变更 → 发"分域变化"事件(仅带变化域:新值 + 对称旧值 old*,2026-09-08;差值消费方自算),UI 层订阅后 re-emit 给外部;
 *  - 2026-08-28:曾去 system 域与 EnvironmentSource(环境源已删除);
 *  - 2026-08-29:按"权威包数据中心"定位恢复 system/all 域(06 设计)——系统包列表经注入的
 *    ros2/ pkg_list 提供者获取(组装根默认接 composeApi.ros2ServiceApi,可注入 fake 无头测试),
 *    dir 懒取为空(消费方需要时直接调 ros2/ Ros2ServiceApi.pkg_prefix);package-core 零命令执行。
 *  - 2026-09-04(系统/定时解耦):system 域刷新与 60s 定时器彻底隔离——timer-tick/rebuild 只重建
 *    工作区包,不再调用系统包提供者(pkg list);系统列表改由独立入口 refreshSystem() 刷新,
 *    装配方在底层 ros2/ env 变化(onEnvChanged)时触发(只刷 system/all 域,不碰工作区缓存)。
 *
 * 不依赖 vscode(文件标记用 node fs);fetcher / cache / exeMap 由组装点注入(可注入 fake 无头测试)。
 * 对外开放三个接入口:包创建 ingestPackageCreated / 翻转 toggleIgnore / 构建快表 getBuildPackages。
 * 设计见 设计/重构/package-core重新设计/DESIGN.md。
 */

import { l10n } from "vscode";


import * as path from "path";
import * as fs from "fs";

import { getLogger } from "../../../logger";
import { DriverEvent, PackageFetcher } from "../event/contracts";
import { PackageEntry } from "../shared/types";
import { PackageCache, PackageSnapshot } from "./package-cache";
import { analyzePackageDir } from "../scan/package-xml";
import { hasColconIgnoreSameDir } from "../scan/colcon-scan";
import { classifyIgnoreReason } from "../scan/ignore-classify";
import { EventEmitter } from "../shared/emitter";
import { domainSig, emptyState, PackageChangeEvent, PackageDataState } from "./state";
import { deriveWorkspace, deriveAll, fallbackUnignoredFromWalk } from "./derive";

const log = getLogger("package-core.data");

/**
 * 契约适配器:WorkspacePackage({name,path}) → PackageEntry({name,dir})。
 * path→dir 是必需的字段名转换(colcon list 执行器契约为 {name,path});buildType 纯透传
 * (已在 cache 层合并进 WorkspacePackage,本层不取数不计算,2026-09-02)。
 */
const toEntry = (w: { name: string; path: string; buildType?: string }): PackageEntry => ({
    name: w.name,
    dir: w.path,
    buildType: w.buildType,
});

/** 按 name 去重追加(已有同名则不动) */
const dedupeAdd = (list: PackageEntry[], entry: PackageEntry): PackageEntry[] =>
    list.some((p) => p.name === entry.name) ? list : [...list, entry];

/** 简单事件发射器(共享实现,2026-08-29 自 shared/emitter 引入) */
export type DataEvent<T> = (listener: (payload: T) => void) => () => void;

/** 数据层对外接口(UI 层依赖的唯一形态) */
export interface PackageDataApi {
    /** 同步读全量便宜数据(快照) */
    getState(): Readonly<PackageDataState>;
    /** 分域变更事件:仅"发生变化的域"携带 新值 + 对称旧值(old*,2026-09-08;差值消费方自算;消费方读自己的域,非己即跳过),返回取消订阅函数 */
    onDidChange(cb: (ev: PackageChangeEvent) => void): () => void;
    /** 手动强制刷新(外部命令入口;语义=工作区懒重建,不刷系统——系统刷新走 refreshSystem) */
    forceRefresh(): Promise<void>;
    /**
     * 系统包列表刷新(独立入口,2026-09-04 与 60s 定时解耦):只刷 system 域(+派生 all),
     * 不碰工作区缓存与工作区域;由装配方在底层 ros2/ env 变化时调用。
     * 语义同 refreshSystemList:提供者失败/未注入 → 保持旧值(null 契约不变)。
     */
    refreshSystem(): Promise<void>;
    /** 包创建接入口:新建 package.xml 后直接接入(不走 watcher/循环),增量并入缓存 */
    ingestPackageCreated(packageXmlPath: string): Promise<void>;
    /** 翻转接入口:创建/删除 COLCON_IGNORE,返回翻转后是否被忽略 */
    toggleIgnore(dir: string): Promise<boolean>;
    /** 构建包列表(快速、不阻塞):命中缓存立即返回;未命中只跑 colcon list 填 unignore,不走 walk;始终返回数据 */
    getBuildPackages(): Promise<ReadonlyArray<PackageEntry>>;
    /** 释放资源(含驱动层) */
    dispose(): void;
}

/** 数据层选项(2026-09-06 §12.4:事件廉价预过滤——walk 不会进的区域直接丢弃,由装配方注入) */
export interface DataLayerOptions {
    /** 目录是否在 walk 扫描范围内(返回 false = 事件可丢弃);缺省恒 true */
    isDirRelevant?: (dir: string) => boolean;
}

/** 数据层(夹中间):统一状态 + 派生 + 权威校验 + 调度 */
export class DataLayer implements PackageDataApi {
    private state: PackageDataState = emptyState();
    private readonly emitter = new EventEmitter<PackageChangeEvent>();
    private readonly fetcher: PackageFetcher;
    private readonly cache: PackageCache;
    /** 系统包列表提供者(2026-08-29 恢复 system 域;注入,零命令执行;返回 null = 失败 → system 域保持"未刷新/未知") */
    private readonly systemPackages?: () => Promise<string[] | null>;
    /** 事件廉价预过滤(2026-09-06;缺省全部相关) */
    private readonly isDirRelevant: (dir: string) => boolean;
    private readonly unsubscribers: Array<() => void> = [];

    constructor(
        fetcher: PackageFetcher,
        cache: PackageCache,
        systemPackages?: () => Promise<string[] | null>,
        options: DataLayerOptions = {},
    ) {
        this.fetcher = fetcher;
        this.cache = cache;
        this.systemPackages = systemPackages;
        this.isDirRelevant = options.isDirRelevant ?? (() => true);
        this.unsubscribers.push(
            fetcher.onExternalChange((ev) => {
                void this.handleDriverEvent(ev);
            })
        );
        // 2026-09-02(设计 D2/D4):内部订阅 cache 内容真变化(colcon 注入/类型补齐/applyMarkerSync 等
        // 不经过 fetcher 的变化)→ 直接以最新快照重组装域(不 invalidate,避免重建循环);commit 域签名含 buildType,无扰则不发
        this.unsubscribers.push(
            cache.onContentChange(() => {
                void this.refreshFromCacheSnapshot();
            })
        );
        void this.forceRefresh(); // 首载
    }

    getState(): Readonly<PackageDataState> {
        return this.state;
    }

    onDidChange(cb: (ev: PackageChangeEvent) => void): () => void {
        return this.emitter.event(cb);
    }

    async forceRefresh(): Promise<void> {
        await this.refreshWorkspace("refresh");
    }

    /**
     * 系统包列表刷新(2026-09-04 独立入口,与 60s 定时解耦):
     * 只重取 system 域并提交(+派生 all 随之更新),不 invalidate / 不重建工作区缓存。
     * 触发方 = 装配方(extension)在 ros2/ env 变化(onEnvChanged)时调用;package-core 自身
     * 零 env 依赖(不订阅环境事件),保持"取数经执行口注入"铁律。
     * 注:提交时以当前 state 的工作区域为基底,并发刷新(如 watcher 懒重建)不会互相覆盖——
     * commit 内部逐域比对、仅发变化域。
     * 2026-09-13(手稿 §10 对齐):**env 驱动 = system 事件必发**——即使列表未变化,ev.system 也携带
     * (新值 = 旧值,差值为 0),供下游在环境变化后重推;无内容可推(从未成功,null)除外。
     */
    async refreshSystem(): Promise<void> {
        const system = await this.refreshSystemList();
        this.commit(
            { unignored: this.state.unignored, ignored: this.state.ignored, system },
            { forceDomains: ["system"] },
        );
    }

    /** 包创建接入口:权威校验后增量并入 unignore/ignore(含祖先遮蔽判定),并失效共享缓存保证最终一致 */
    async ingestPackageCreated(packageXmlPath: string): Promise<void> {
        const dir = path.normalize(path.dirname(packageXmlPath));
        // 2026-09-02(设计 D4):analyzePackageDir 一次读取即得 name+buildType——增量条目必带类型,
        // 保持"域条目无 undefined"不变量(不再 isValidPackageXml + getPackageNameFromXml 两次读取)
        const analysis = await analyzePackageDir(dir);
        if (!analysis.valid || !analysis.name) {
            return; // 非法包/读不到 <name>:不收录
        }
        const name = analysis.name;
        // 2026-09-06(§12.2/P2):同目录标记(fs 实时)+ 祖先阻挡(快照标记集 M + 合法包链)→ 决定入 ignore 还是 unignore 域
        const sameDir = await hasColconIgnoreSameDir(dir);
        const ignored = sameDir || this.hasAncestorBlocker(dir);
        log.debug(`data.ingest:${name} @${path.basename(dir)} ignored=${ignored}(sameDir=${sameDir},ancestor=${ignored && !sameDir})`);
        // 未刷新(null):不做增量(不伪造"只知道这一个"的部分已知),缓存失效交由 watcher/下次刷新全量重建
        if (this.state.unignored === null || this.state.ignored === null) {
            this.cache.invalidate();
            return;
        }
        const entry = { name, dir, buildType: analysis.buildType };
        const unignored = ignored ? this.state.unignored : dedupeAdd(this.state.unignored, entry);
        const ignoredList = ignored ? dedupeAdd(this.state.ignored, entry) : this.state.ignored;
        this.cache.invalidate(); // 共享缓存失效:下次懒重建含新包(最终分类由缓存统一裁定)
        this.commit({ unignored, ignored: ignoredList, system: this.state.system });
    }

    /** 翻转接入口:创建/删除 COLCON_IGNORE 标记 → 交缓存 applyMarkerSync 统一重分类(不 walk 不 colcon,§12.4/12.5) */
    async toggleIgnore(dir: string): Promise<boolean> {
        const normalized = path.normalize(dir);
        const ignoreFile = path.join(normalized, "COLCON_IGNORE");
        const wasIgnored = await hasColconIgnoreSameDir(normalized);
        if (wasIgnored) {
            await fs.promises.unlink(ignoreFile);
        } else {
            await fs.promises.writeFile(ignoreFile, "");
        }
        // 未刷新(null):不伪造部分已知(不做本地迁移),缓存失效交由 watcher/下次刷新全量重建
        if (this.state.unignored === null || this.state.ignored === null) {
            this.cache.invalidate();
            return !wasIgnored;
        }
        // 2026-09-06:标记翻转统一走缓存对账(池 × M 重分类 + ignore⇄unignore 迁移 + 内容事件 → commit)。
        // 删除本地单包迁移逻辑:祖先标记影响整棵子树,非单目录可裁决(避免双份状态漂移)。
        await this.cache.applyMarkerSync([normalized]);
        log.debug(l10n.t("data.toggleIgnore: {0} marker toggled (was ignored={1}, returning={2})", path.basename(normalized), wasIgnored, !wasIgnored));
        return !wasIgnored;
    }

    /**
     * 2026-09-06:快照级"祖先阻挡"判定(祖先 COLCON_IGNORE 标记 / 祖先合法包 / 自身标记)——
     * ingest 单点归属用;快照未就绪返回 false(未刷新分支会早退,不靠本判定兜底)。
     */
    private hasAncestorBlocker(dir: string): boolean {
        const snap = this.cache.getSnapshot();
        if (!snap) {
            return false;
        }
        const markers = new Set(snap.ignoreMarkers.map((p) => path.normalize(p)));
        const validDirs = new Set(snap.entries.filter((e) => e.isValid).map((e) => path.normalize(e.dir)));
        return classifyIgnoreReason(dir, markers, validDirs, this.cache.getWorkspaceRoot()) !== undefined;
    }

    /** 构建包列表(快速、不阻塞):构建服务专用。2026-09-02(设计 D2)语义:colcon 已跑(colconReady)
     *  → 域内即权威名单,立即返回;未跑 → 本路径即 colcon 触发点(只跑 colcon list,绝不走 walk;出口自带类型)。 */
    async getBuildPackages(): Promise<ReadonlyArray<PackageEntry>> {
        const snap = this.cache.getSnapshot();
        if (snap?.colconReady) {
            return this.state.unignored ?? []; // commit 已随 onContentChange/本路径更新为 colcon 权威
        }
        const unignore = await this.cache.syncUnignore();
        const entries = unignore.map(toEntry);
        // D4 类型就绪才发布(colcon 出口已带类型,此处防御;未就绪不污染域,调用方仍拿到名单)
        if (entries.every((e) => e.buildType !== undefined)) {
            this.commit({ unignored: entries, ignored: this.state.ignored, system: this.state.system });
        }
        return entries; // 契约:始终返回数据(不返回 null)
    }

    dispose(): void {
        this.fetcher.dispose();
        // 注意:共享 PackageCache 不 dispose(多消费方共用)
        for (const un of this.unsubscribers) {
            un();
        }
        this.emitter.dispose();
    }

    private async handleDriverEvent(ev: DriverEvent): Promise<void> {
        const dirsLabel = ev.kind === "timer-tick"
            ? "(定时)"
            : ev.dirs
                ? `${ev.dirs.length}[${ev.dirs.map((d) => path.basename(d)).join(",")}]`
                : "(无路径)";
        log.debug(l10n.t("data.ev: enter kind={0} dirs={1}", ev.kind, dirsLabel));
        switch (ev.kind) {
            case "workspace-package-changed": {
                // 池事件(2026-09-06 §12.3/12.4):事件带 dirs 且全部落在扫描范围外(排除/点目录)→ 丢弃;
                // 否则懒重建(只 walk + 并集,不跑 colcon)
                if (ev.dirs && ev.dirs.length > 0 && !ev.dirs.some((d) => this.isDirRelevant(d))) {
                    log.trace("package-core.data: package.xml events all outside scan scope; dropped (no rebuild)");
                    return;
                }
                log.debug("data.ev: pool event -> lazy rebuild (refresh: invalidate+ensureFresh, walk only)");
                await this.refreshWorkspace("refresh");
                break;
            }
            case "ignore-marker-changed": {
                // 标记事件(§12.1/12.4 水桶正交):只对账标记集 M + 池 × M 重分类,不 walk 不 colcon
                const dirs = ev.dirs ? ev.dirs.filter((d) => this.isDirRelevant(d)) : [];
                if (ev.dirs && ev.dirs.length > 0 && dirs.length === 0) {
                    log.trace("package-core.data: COLCON_IGNORE events all outside scan scope; dropped (no rebuild)");
                    return;
                }
                if (dirs.length === 0) {
                    // 无路径信息(旧事件形态/未知):无法定点对账 → 懒重建兜底(scan 会重收集 M)
                    log.debug("data.ev: marker event without paths -> lazy rebuild fallback (scan re-collects M)");
                    await this.refreshWorkspace("refresh");
                    break;
                }
                log.debug(l10n.t("data.ev: marker event -> cache.applyMarkerSync ({0} dirs, no walk no colcon)", dirs.length));
                await this.cache.applyMarkerSync(dirs); // 内容变化 → onContentChange → refreshFromCacheSnapshot → commit
                break;
            }
            case "timer-tick":
                // 60s 全量权威:colcon + walk(删除/漂移/M 重同步在此收敛)。
                // 2026-09-04(系统/定时解耦):不再顺带刷新系统——60s 不该调用 pkg list,
                // 系统列表随 ros2/ env 变化由 refreshSystem() 独立刷新。
                log.debug("data.ev: timer-tick -> full authoritative rebuild (colcon+walk)");
                await this.refreshWorkspace("rebuild");
                break;
        }
        log.debug(l10n.t("data.ev: exit kind={0} (handled)", ev.kind));
    }

    /** 刷新系统包域(2026-08-29 恢复;数据源 = 注入的 ros2/ pkg_list 提供者;dir 懒取为空;提供者 null(失败)→ null,抛错保持旧值,从未成功则恒 null) */
    private async refreshSystemList(): Promise<PackageEntry[] | null> {
        if (!this.systemPackages) {
            return this.state.system;
        }
        try {
            const names = await this.systemPackages();
            // 系统包 buildType 恒为 ""(ros2 pkg list 不携带 build_type;显式空值区别于工作区包的 undefined=未取到/异常)
            return names === null ? null : names.map((n) => ({ name: n, dir: "", buildType: "" }));
        } catch {
            log.warn(l10n.t("Failed to fetch system package list; keeping existing list"));
            return this.state.system;
        }
    }

    /**
     * 从快照组装工作区域并提交(2026-09-02 设计 D2/D4):
     *  - unignored = colcon 权威(colconReady)→ 名单条目;未跑 → walk 兜底(fallbackUnignoredFromWalk,
     *    兜底上移自 executable-map.isBuildable——消费方不再理解物理快照);
     *  - 类型未齐(colcon 权威路径,理论上仅防御)→ 本域不发布(保持旧值),等类型补齐事件。
     */
    private commitFromSnapshot(snap: PackageSnapshot, system: PackageEntry[] | null): void {
        const colconUnignored = snap.unignore.map(toEntry);
        const fallback = fallbackUnignoredFromWalk(snap.entries);
        const buildable = snap.colconReady ? colconUnignored : fallback;
        const unignored =
            snap.colconReady && buildable.some((e) => e.buildType === undefined)
                ? this.state.unignored
                : buildable;
        const ignored = snap.ignore.map(toEntry);
        log.debug(`commitFromSnapshot:colconReady=${snap.colconReady},colcon=${colconUnignored.length},fallback=${fallback.length},ignored=${ignored.length}`);
        this.commit({ unignored, ignored, system });
    }

    /** cache 内容真变化(cache.onContentChange)回调:直接以最新快照重组装(不 invalidate,无重建循环) */
    private async refreshFromCacheSnapshot(): Promise<void> {
        const snap = this.cache.getSnapshot();
        if (!snap) {
            return;
        }
        this.commitFromSnapshot(snap, this.state.system);
    }

    /**
     * 刷新工作区包集合(unignored / ignore):直接读 PackageCache 快照 → 派生 → 域比对 → 发事件。
     * 2026-09-04(系统/定时解耦):本方法【只刷工作区】,不再携带系统刷新——
     *   此前 "rebuild 顺带 refreshSystemList" 已移除(system 域刷新 = env 变化驱动的
     *   refreshSystem(),不再跟 60s 定时器绑定)。
     */
    private async refreshWorkspace(mode: "refresh" | "rebuild"): Promise<void> {
        log.debug(l10n.t("data.refreshWorkspace: start mode={0} (refresh=lazy walk-only / rebuild=colcon+walk authoritative)", mode));
        let snap: PackageSnapshot;
        if (mode === "rebuild") {
            snap = await this.cache.rebuild();              // 强制全量(双缓冲,单飞)
        } else {
            this.cache.invalidate();                        // 标脏 → ensureFresh 懒重建(只 walk)
            snap = await this.cache.ensureFresh();
        }
        this.commitFromSnapshot(snap, this.state.system);
        log.debug(`data.refreshWorkspace:done mode=${mode}`);
    }

    /**
     * 提交新状态:组装 5 域 → 逐域比对 → 只发"变化域"的分域事件(2026-09-08:同域附带对称旧值
     * old*,差值由消费方自算——身份键:工作区三域按 dir、system 按 name;all 弃用,不做逐条 diff)。
     * 2026-08-29 逻辑吸收:删除整快照指纹判重——"内容没变"的判定已由 package-cache
     * (contentFingerprint + onContentChange)承担,本层只做域级细分;
     * 2026-09-02(设计 D1):域签名含 buildType(domainSig),凡域内容真变(含类型)即发——删静默语义,
     * 无内容变化天然不发(不构成打扰)。
     * 2026-09-13(手稿 §10 对齐):新增 opts.forceDomains——env 驱动刷新时 system 域**强制携带**
     * (即使列表未变也发,新值 = 旧值,差值为 0;供消费方重推。null = 无内容可推,不强制)。
     */
    private commit(sources: {
        unignored: PackageEntry[] | null;
        ignored: PackageEntry[] | null;
        system: PackageEntry[] | null;
    }, opts?: {
        /** 强制携带的域(当前仅支持 "system";语义见上) */
        forceDomains?: ReadonlyArray<"system">;
    }): void {
        const workspace = deriveWorkspace(sources.unignored, sources.ignored);
        const all = deriveAll(workspace, sources.system); // 弃用域(2026-09-08,见 deriveAll 弃用标签):保留兼容发射
        const candidate: PackageDataState = {
            workspace,
            unignored: sources.unignored,
            ignored: sources.ignored,
            system: sources.system,
            all,
            generatedAt: 0,
        };
        // 逐域比对(旧 = this.state,覆盖前取值);只带变化域:新值 + 对称旧值成对,差值消费方自算
        const ev: PackageChangeEvent = {};
        const changed: string[] = [];
        if (domainSig(candidate.workspace) !== domainSig(this.state.workspace)) {
            ev.workspace = candidate.workspace;
            ev.oldWorkspace = this.state.workspace;
            changed.push("workspace");
        }
        if (domainSig(candidate.unignored) !== domainSig(this.state.unignored)) {
            ev.unignored = candidate.unignored;
            ev.oldUnignored = this.state.unignored;
            changed.push("unignored");
        }
        if (domainSig(candidate.ignored) !== domainSig(this.state.ignored)) {
            ev.ignored = candidate.ignored;
            ev.oldIgnored = this.state.ignored;
            changed.push("ignored");
        }
        const systemChanged = domainSig(candidate.system) !== domainSig(this.state.system);
        const forceSystem = opts?.forceDomains?.includes("system") ?? false;
        if (systemChanged || (forceSystem && candidate.system !== null)) {
            ev.system = candidate.system;
            ev.oldSystem = this.state.system;
            // 强制回推时标签区分:值未变(差值 0)也发,消费方自算差量为 0
            changed.push(systemChanged ? "system" : "system(force-repush)");
        }
        if (domainSig(candidate.all) !== domainSig(this.state.all)) {
            // 弃用域(2026-09-08):保留发射兼容旧订阅方,新代码勿消费
            ev.all = candidate.all;
            ev.oldAll = this.state.all;
            changed.push("all");
        }
        this.state = { ...candidate, generatedAt: Date.now() };
        // 无任何域变化 → 不打扰消费方(整快照判重由 cache 承担)
        if (changed.length === 0) {
            log.debug("data.commit: no domain changes; no event fired");
            return;
        }
        log.debug(l10n.t("data.commit: domain changes=[{0}] -> firing per-domain events (same-domain carries old*; consumers compute their own diffs)", changed.join(",")));
        this.emitter.fire(ev);
    }
}
// 修改时间:2026-09-08 22:45(commit 逐域附对称旧值 old*;域变化日志改用变化域名清单,不再被 old* 键污染;all 弃用标注保留发射)