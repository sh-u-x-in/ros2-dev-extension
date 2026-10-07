// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file executable-map.ts
 * 包服务层【中心节点】:可执行映射(读侧)。
 *
 * 2026-09-02 改版(设计:package-core出口简化与buildType事件化 D2/D3/D4):
 *  - 数据源从 package-cache 物理快照切换为 **package-core 门面 PackageFacadeApi**:
 *    收录名单 = 门面 unignored 域(「参与构建最佳名单」,colcon 权威 / walk 兜底已由域层承诺,
 *    条目必带权威 buildType——D4 域层类型就绪才发布,undefined 不出现);
 *  - 原 isBuildable 退回逻辑(hasColconIgnore walk 视角)已上移域层,本模块删除;
 *  - 双触发:
 *      · 全量 refresh() ← 订阅门面 onDidChange(仅 unignored 域变化时重建;
 *        buildType 翻转 = 域签名变 = 域事件 → 自动换解析器,设计 D1);
 *      · 单包 updatePackage(dir) ← 触发器(event-collector,构建文件 setup.py/CMakeLists 变化)驱动;
 *  - 单飞 + 合并(2026-09-02,50 包全量纯解析实测 ~1-2ms、磁盘读数 ms~数十 ms 量级;治理突发多事件):
 *      · 任一时刻最多一个全量重建;进行中又来事件 → 标脏,链尾以最新状态补刷(串行,无并发无乱序覆盖);
 *      · 全量重建先构建 next 再原子替换(双缓冲):重建期间读旧值、替换后才 fireChanged——无"map 真空期";
 *      · map 视图 null 就绪契约:getAll() 未就绪返回 null(域未刷新/首建未完成),就绪返回 Map(可能空);
 *        替换时 null→Map(空) 也是一次变化 → 通知一次 = 「就绪宣布」——与 core 5 域 null 契约同构,
 *        下游可区分「已就绪但无包」与「未就绪」(不再需要 everBuilt 特判);
 *  - 收录口径:**参与构建的包**才有可执行映射(unignored 域);被 COLCON_IGNORE 的包不在域内 → 不收录;
 *  - 解析失败降级:单包解析异常 → 移除该包映射,不污染其它包(逐包独立 try/catch);
 *  - onNameMismatch 事件出口:三方校验(目录名 / package.xml / 配置内名)不一致时触发,重命名模块订阅
 *    (本模块只出口不消费);
 *  - 无可用域(unignored = null,未刷新)时 refresh/updatePackage 为空操作(等域事件再刷)。
 *
 * 历史(2026-08-22 建档):消费 package-cache(entries/unignore 画像)按 buildType 分派两解析器;
 * 2026-09-02 按出口简化设计改版(物理层内部化,消费方只依赖门面)。
 */

import * as path from "path";
import * as fs from "fs";
import { getLogger } from "../../../../logger";
import type { PackageChangeEvent, PackageDataState } from "../../../package-core/api";
import { parseSetupPy, SetupPyParseResult } from "./parse/setup-parser";
import { parseCMakeLists, CMakeListsParseResult } from "./parse/cmake-parser";
import {
    ExecutableEntry,
    PackageExecutables,
    NameMismatchEvent,
} from "./types";

/** 可执行映射模块日志 */
const log = getLogger("executable-map");

/** 简单事件发射器(纯 TS,便于无头测试;与 package-cache 的 EventEmitter 同构) */
interface EventLike<T> {
    (listener: (payload: T) => void): () => void;
}

class EventEmitter<T> {
    private listeners = new Set<(payload: T) => void>();

    readonly event: EventLike<T> = (listener) => {
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

/** 映射整体变化事件载荷(订阅方可直接读只读视图) */
export interface ExecutableMapChangeEvent {
    map: ReadonlyMap<string, PackageExecutables>;
}

/** 解析单个构建文件需要的读/判存在能力(注入,便于无头测试) */
export interface ExecutableMapFs {
    readText(file: string): Promise<string | undefined>;
}

/** 默认 node fs 实现 */
export const nodeExecutableMapFs: ExecutableMapFs = {
    async readText(file) {
        try {
            return await fs.promises.readFile(file, "utf8");
        } catch {
            return undefined;
        }
    },
};

/**
 * 可执行映射数据源(2026-09-02:窄化为门面子集,结构化兼容 package-core PackageFacadeApi——直接传 ui)。
 * 对外状态类型 PackageDataState / PackageChangeEvent 经 package-core/api 纯接口层。
 */
export interface ExecutableMapDataSource {
    /** 同步读 5 域状态(unignored 域 = 参与构建最佳名单,条目含权威 buildType) */
    getState(): Readonly<PackageDataState>;
    /** 分域变化事件(仅"发生变化的域"携带新值) */
    onDidChange(cb: (ev: PackageChangeEvent) => void): () => void;
}

/** 中心节点:可执行映射(根键 = package.xml name) */
export class ExecutableMap {
    /** 就绪后的只读承载;null = 未就绪(域未刷新 / 首建未完成)——见 getAll() null 契约 */
    private map: Map<string, PackageExecutables> | null = null;
    private changedEmitter = new EventEmitter<ExecutableMapChangeEvent>();
    private nameMismatchEmitter = new EventEmitter<NameMismatchEvent>();
    private unsubscribeSource: (() => void) | undefined;
    /** 单飞合并:任一时刻最多一个全量重建链;进行中又来事件 → 标脏,链尾以最新状态补刷 */
    private pendingRefresh: Promise<void> | undefined;
    private refreshDirty = false;
    /** map 内容指纹(no-op 抑制:就绪后全量/增量内容未变则不通知下游;null 未就绪期恒 "") */
    private mapFingerprint = "";

    constructor(
        private source: ExecutableMapDataSource,
        private f: ExecutableMapFs = nodeExecutableMapFs,
    ) {
        // 全量源:门面域事件——unignored 域变化(名单增删/ignore 翻转/类型就绪/类型翻转)才重建;
        // 域签名含 buildType(cache 层判重口径),无内容变化不发(不打扰)
        this.unsubscribeSource = source.onDidChange((ev) => {
            if (ev.unignored !== undefined) {
                // 单飞合并:并入当前重建链(标脏),由链尾以最新状态补刷,不并发
                this.scheduleRefresh();
            }
        });
    }

    /** 订阅映射整体变化,返回取消函数 */
    readonly onDidChange: EventLike<ExecutableMapChangeEvent> = (listener) =>
        this.changedEmitter.event(listener);

    /** 订阅名称三方不一致事件(重命名模块用),返回取消函数 */
    readonly onNameMismatch: EventLike<NameMismatchEvent> = (listener) =>
        this.nameMismatchEmitter.event(listener);

    /**
     * 查询单包映射(未就绪 / 无该包 → undefined)。
     * ⚠️ 就绪前(getAll() === null)的 undefined 不代表"包不存在"——请先经 getAll()/onDidChange 判就绪。
     */
    get(name: string): PackageExecutables | undefined {
        return this.map?.get(name);
    }

    /**
     * map 视图(null 就绪契约,2026-09-02,与 core 5 域 null 语义同构):
     * null = 未就绪(域未刷新 / 首建未完成);Map(可能为空)= 已就绪——空 Map 表示「确实无包」,
     * 与「未就绪」可区分。首次就绪(含空)会经 onDidChange 通知一次(就绪宣布)。
     */
    getAll(): ReadonlyMap<string, PackageExecutables> | null {
        return this.map;
    }

    /** 查询单包可执行入口列表(未就绪或无包 → 空数组) */
    executablesOf(name: string): ExecutableEntry[] {
        return this.map?.get(name)?.executables ?? [];
    }

    /**
     * 该目录是否为【参与构建的包目录】(触发器过滤用)。
     * 2026-09-02:域成员判定(unignored 域 = 参与构建最佳名单);域未刷新(null)时用轻量本地探针
     * (package.xml 存在 + 同目录无 COLCON_IGNORE),不 import package-core 物理层。
     */
    isPackageDir(dir: string): boolean {
        const list = this.source.getState().unignored;
        if (list === null) {
            return (
                fs.existsSync(path.join(dir, "package.xml")) &&
                !fs.existsSync(path.join(dir, "COLCON_IGNORE"))
            );
        }
        const norm = path.normalize(dir);
        return list.some((e) => path.normalize(e.dir) === norm);
    }

    /**
     * 显式全量重建(主动更新入口,2026-09-02 单飞合并语义):请求一次全量;
     * 若已有重建链在跑则并入链尾(标脏),await 至本轮(含期间合并的尾巴)完成。
     * unignored 域未就绪时 doRefresh 为空操作(等域事件再刷)。
     */
    async refresh(): Promise<void> {
        this.refreshDirty = true;
        if (!this.pendingRefresh) {
            this.startChain();
        }
        await this.pendingRefresh;
        // 兜底:极端时序(链刚收尾清引用与标脏之间)残留 dirty → 补刷一次
        while (this.refreshDirty && !this.pendingRefresh) {
            this.startChain();
            await this.pendingRefresh;
        }
    }

    /** 事件/调用入口:标脏 + 保证有链在跑(单飞:已有链则只标脏,由链尾补刷) */
    private scheduleRefresh(): void {
        this.refreshDirty = true;
        if (!this.pendingRefresh) {
            this.startChain();
        }
    }

    private startChain(): void {
        this.pendingRefresh = this.runRefreshChain()
            .catch((err) => log.warn("executable-map:全量重建失败:" + String(err)))
            .finally(() => {
                this.pendingRefresh = undefined;
            });
    }

    /** 串行重建链:一次 doRefresh 一轮;期间标脏(又来事件)→ 继续补刷(每轮都取最新状态),直至安静 */
    private async runRefreshChain(): Promise<void> {
        do {
            this.refreshDirty = false;
            await this.doRefresh();
        } while (this.refreshDirty);
    }

    /**
     * 单包更新(触发器监听 setup.py / CMakeLists 变化后调用;不参与构建/解析失败 → 移除该包)。
     * 2026-09-02:全量重建在跑或 map 未就绪(首建前)时并入全量链(标脏 → 链尾全量以最新磁盘状态覆盖),
     * 避免部分/全量交错或「半就绪视图」;否则走增量(就地改 map),结束经 notifyIfChanged 做 no-op 抑制。
     */
    async updatePackage(dir: string): Promise<void> {
        if (this.pendingRefresh || this.map === null) {
            // 全量链在跑(标脏并入链尾)或 map 未就绪(起一次全量):不做部分增量
            this.scheduleRefresh();
            log.trace("executable-map:全量进行中/未就绪,updatePackage 并入全量:" + dir);
            return;
        }
        const list = this.source.getState().unignored;
        if (list === null) {
            // 域未就绪:不动现有映射(等全量刷新),避免误删
            log.trace("executable-map:unignored 域未就绪,updatePackage 空操作:" + dir);
            return;
        }
        const norm = path.normalize(dir);
        const entry = list.find((e) => path.normalize(e.dir) === norm);
        if (!entry || !entry.name || !entry.buildType) {
            // 包不存在 / 不合法 / 不参与构建(不在 unignored 域)→ 按目录反向移除(覆盖 name 变化的旧键)
            this.removeByDir(dir);
            this.notifyIfChanged();
            return;
        }
        const pkg = await this.buildForEntry(entry);
        if (pkg) {
            this.map.set(pkg.name, pkg);
        } else {
            this.removeByDir(dir);
        }
        this.notifyIfChanged();
    }

    /** 释放门面订阅(纯 TS 无其它资源) */
    dispose(): void {
        this.unsubscribeSource?.();
        this.changedEmitter.dispose();
        this.nameMismatchEmitter.dispose();
    }

    // ---- 内部 ----

    /** 一轮全量重建:执行时取最新门面状态;收录名单 = unignored 域(域层已承诺类型就绪才发布) */
    private async doRefresh(): Promise<void> {
        const list = this.source.getState().unignored;
        if (list === null) {
            log.trace("executable-map:unignored 域未就绪,doRefresh 空操作(等域事件)");
            return;
        }
        const next = new Map<string, PackageExecutables>();
        for (const entry of list) {
            if (!entry.name || !entry.buildType) {
                continue; // 防御:域发布规则下不应出现
            }
            try {
                const pkg = await this.buildForEntry(entry);
                if (pkg) {
                    next.set(pkg.name, pkg);
                }
            } catch (err) {
                // 单包解析异常 → 降级跳过,不拖垮全量重建
                log.warn("executable-map:解析失败降级:" + entry.dir + ":" + String(err));
            }
        }
        // 原子替换 + no-op 抑制(双缓冲:替换前旧 map 仍可读;内容相同不发)
        this.replaceMap(next);
    }

    /** 按 buildType 分派 setup / cmake 解析,归一为 ExecutableEntry[] */
    private async buildForEntry(entry: { dir: string; name: string; buildType?: string }): Promise<PackageExecutables | undefined> {
        const { dir, name, buildType } = entry;
        if (!name || !buildType) {
            return undefined; // 防御:域发布规则下不应出现(buildType 未就绪不解析)
        }
        const executables: ExecutableEntry[] = [];
        let hasIssues = false;

        if (buildType === "ament_python") {
            const text = await this.f.readText(path.join(dir, "setup.py"));
            if (text === undefined) {
                // 无 setup.py:不合法包(analyzePackageDir 已拦),此处防御性移除
                return undefined;
            }
            const r: SetupPyParseResult = parseSetupPy(text);
            if (r.issues.length > 0) {
                hasIssues = true;
            }
            for (const cs of r.consoleScripts) {
                executables.push({ name: cs.name, kind: "consoleScript" });
            }
            this.checkNameMismatch(entry, r.name);
        } else if (buildType === "ament_cmake" || buildType === "cmake") {
            const text = await this.f.readText(path.join(dir, "CMakeLists.txt"));
            if (text === undefined) {
                return undefined;
            }
            const r: CMakeListsParseResult = parseCMakeLists(text);
            for (const ex of r.executables) {
                if (ex.dynamic) {
                    hasIssues = true;
                }
                executables.push({ name: ex.name, kind: "cmakeTarget", dynamic: ex.dynamic });
            }
            // ament_export_executables 中未出现在 add_executable 的名字补充登记(避免重复)
            for (const en of r.exportExecutables) {
                if (!executables.some((x) => x.name === en)) {
                    executables.push({ name: en, kind: "exportExecutable" });
                }
            }
            this.checkNameMismatch(entry, r.projectName);
        } else {
            return undefined;
        }

        return { name, buildType, dir, executables, hasIssues };
    }

    /** 三方校验:目录名 / package.xml / 配置内名 任一不一致 → 触发 onNameMismatch(只出口) */
    private checkNameMismatch(entry: { dir: string; name: string; buildType?: string }, declaredName: string | undefined): void {
        const { dir, name, buildType } = entry;
        if (!name) {
            return;
        }
        const directoryName = path.basename(dir);
        if (declaredName !== undefined && declaredName !== name) {
            this.nameMismatchEmitter.fire({ dir, packageName: name, directoryName, declaredName, buildType: buildType ?? "" });
        } else if (directoryName !== name) {
            this.nameMismatchEmitter.fire({ dir, packageName: name, directoryName, buildType: buildType ?? "" });
        }
    }

    /** 按目录反向移除(覆盖 name 变化 / 包被删除的场景) */
    private removeByDir(dir: string): void {
        if (!this.map) {
            return; // 未就绪:无可移除(增量路径前置已并入全量)
        }
        for (const [k, v] of this.map) {
            if (v.dir === dir) {
                this.map.delete(k);
            }
        }
    }

    /** map 内容指纹(no-op 抑制用;覆盖 key/buildType/dir/executables 名·来源·dynamic/hasIssues,顺序无关) */
    private computeFingerprint(map: ReadonlyMap<string, PackageExecutables>): string {
        return [...map.keys()]
            .sort()
            .map((k) => {
                const p = map.get(k)!;
                return (
                    k + "|" + p.buildType + "|" + p.dir + "|" + p.hasIssues + "|" +
                    p.executables.map((e) => e.name + ":" + e.kind + (e.dynamic ? "?" : "")).join(",")
                );
            })
            .join("\n");
    }

    /**
     * 原子全量替换(null 就绪契约 + no-op 抑制):null → Map(含空)视为变化 → 通知(「就绪宣布」);
     * 就绪后内容未变不通知(双缓冲:替换前旧视图仍可读)。
     */
    private replaceMap(next: Map<string, PackageExecutables>): void {
        const fp = this.computeFingerprint(next);
        const readyTransition = this.map === null; // 未就绪 → 就绪:即使结果为空也是一次变化
        const contentSame = !readyTransition && fp === this.mapFingerprint;
        this.map = next;
        this.mapFingerprint = fp;
        if (!contentSame) {
            this.fireChanged(next);
        }
    }

    /** 增量修改(updatePackage/removeByDir)后调用:内容真变才通知(no-op 抑制;map 未就绪不走到此) */
    private notifyIfChanged(): void {
        if (this.map === null) {
            return; // 防御:增量路径前置已把未就绪并入全量链
        }
        const fp = this.computeFingerprint(this.map);
        if (fp === this.mapFingerprint) {
            return;
        }
        this.mapFingerprint = fp;
        this.fireChanged(this.map);
    }

    /** 通知映射整体变化(仅就绪后调用,payload.map 恒为完整新视图) */
    private fireChanged(map: ReadonlyMap<string, PackageExecutables>): void {
        this.changedEmitter.fire({ map });
    }
}
