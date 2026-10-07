// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file compose.ts
 * 组合根 + 门面实现(2026-08-30 合并自 index.ts + facade.ts,命名对齐 ros2/compose.ts)。
 * 职责:createPackageCore 工厂 + 装配 + PackageFacade 实现(函数/类);
 * 对外接口一律在 api/(纯接口层,零函数定义);本文件只被装配方(extension)直接调用,
 * 外部一律经 api/(运行时出口 re-export 本文件产物)。
 *
 * 组装:驱动层(event) + 数据层(data + cache) + 门面(facade) + 门控(gate);
 * 取数经 ros2/ 执行口注入(composeApi),本文件不 import 其它业务模块实现。
 */

import * as vscode from "vscode";

import { createColconListExecutor } from "./scan/colcon-list";
import { getSharedPackageCache, PackageCache } from "./data/package-cache";
import { isDirScanExcluded } from "./scan/package-scan";
import { resolveExcludeFolders } from "../walk";
import { isValidPackageXml } from "./scan/package-xml";
import { composeApi } from "../../ros2/api";

import { PackageEntry } from "./shared/types";
import { PackageChangeEvent, PackageDataState } from "./data/state";
import { PackageDataApi } from "./data";
import { DataLayer } from "./data";
import type { PackageFacadeApi } from "./api/api";
import { createPackageFetcher } from "./event";
import { createBuildTaskProviderGate, BuildTaskProviderGate } from "./gate";

// ── 组合根导出(2026-08-30 按 ros2/ 范式:≈ros2/compose.ts)──
// 本文件只被装配方(extension)直接调用;外部一律经 api/(运行时出口 re-export 本文件产物)。
// 工厂 + 静态能力函数(共享单例/校验/工具/常量);类型定义在 api/(纯接口层)。
// 2026-09-02(设计 D3):cache 物理出口不再对外 re-export(仅内部使用);对外运行时出口 = createPackageCore / getPackageCore / probeValidWorkspacePackages / 值谓词
export { isValidPackageXml, getPackageNameFromXml } from "./scan/package-xml";

/**
 * 探测:工作区根目录当前是否含"真包"(共享快照 entries 存在 isValid,2026-08-22 全量收紧语义)。
 * 2026-08-31:自 vscode-utils.workspaceContainsPackageXml 收编(包判定权威归位 package-core);
 * 2026-08-31 重命名 hasValidWorkspacePackages → probeValidWorkspacePackages:
 *   仅 onboarding.ts 单次决策使用——【单次探测,不考虑后续更新/事件,刻意减少复杂度】;
 *   需要反应式(订阅包变化)的消费方走 getState() + onDidChange,不用本函数。
 * 保留 ensureFresh(懒/强制扫描 + 单飞共享)时序,调用方等首载就绪即可。
 */
export async function probeValidWorkspacePackages(workspaceRoot: string): Promise<boolean> {
    const cache = getSharedPackageCache(workspaceRoot);
    if (!cache) {
        return false;
    }
    const snap = await cache.ensureFresh();
    return snap.entries.some((e) => e.isValid);
}

/**
 * 最近一次装配的 package-core 实例(2026-09-02 设计 D3:对外只剩 PackageFacadeApi——
 * 语言服务/derive 等非装配方经 getPackageCore() 取门面实例,不再 import 物理 cache;api/index 运行时出口转发)。
 * 单例语义同 getSharedPackageCache(每窗口一次 createPackageCore);未装配/装配前 → undefined(调用方防御)。
 */
let activePackageCore: PackageCore | undefined;
export function getPackageCore(): PackageCore | undefined {
    return activePackageCore;
}

/** 组装配置(2026-08-29 断环注入:组合根不再经 vscode-utils 读设置,由调用方提供) */
export interface PackageCoreConfig {
    /** 驱动层周期刷新(ms),0 = 禁用;缺省 60000 */
    packageCacheRefreshMs: number;
    /** 构建排除目录(扫描排除) */
    buildExcludeFolders: string[];
    /** 是否跟随符号链接(walk 配置) */
    followSymlinks: boolean;
    /** walk 超时/深度配置(walk 配置) */
    walkTimeouts: {
        totalTimeoutMs: number;
        branchTimeoutMs: number;
        maxDepth: number;
    };
}

/** package-core 组装选项(接入口入参) */
export interface PackageCoreOptions {
    /** 工作区根(缺省取 vscode.workspace.workspaceFolders[0];rootPath 废弃 API 已迁移,2026-08-31) */
    workspaceRoot?: string;
    /** 驱动层周期刷新(ms),显式覆盖 config.packageCacheRefreshMs;0 = 禁用 */
    refreshIntervalMs?: number;
    /** 驱动层 fs 监听去抖(ms),缺省 500 */
    watchDebounceMs?: number;
    /** 是否创建 vscode fs 监听,缺省 true */
    enableWatcher?: boolean;
    /** 组装配置(断环注入:配置读取上移调用方;未提供时用缺省值) */
    config?: PackageCoreConfig;
    /** 系统包列表提供者(2026-08-29 恢复 system 域;缺省经 ros2/ 执行口 pkg_list,可注入 fake 无头测试;失败 → null = 未刷新/未知) */
    systemPackages?: () => Promise<string[] | null>;
    /**
     * 构建任务提供器注册管理输入(门控编排,2026-08-28 自 ros2/ 移入)。
     * 注入:门槛(ros2/ environmentFacade.getEnvIssue === null)/ 门控(本中心快照)/ 倾向(配置)/ 注册动作(package-service/build)。
     * 缺省:空实现(上层编排者负责接线)。
     */
    buildTaskProviderGate?: {
        envAvailable: () => boolean;
        hasPackages: () => boolean;
        allowEmptyWorkspace: () => boolean;
        registerBuildTaskProvider: () => vscode.Disposable[];
    };
}

/** package-core 对外出口(门面 + 便捷透传) */
export interface PackageCore {
    /** 门面(唯一入口) */
    ui: PackageFacadeApi;
    getState(): Readonly<PackageDataState>;
    onDidChange(cb: (ev: PackageChangeEvent) => void): () => void;
    forceRefresh(): Promise<void>;
    /** 系统包列表刷新(独立入口;env 变化由装配方触发;列表未变也必发 system 事件——环境回推,见 api 注释) */
    refreshSystem(): Promise<void>;
    /** 包创建接入口 */
    ingestPackageCreated(packageXmlPath: string): Promise<void>;
    /** 翻转接入口 */
    toggleIgnore(dir: string): Promise<boolean>;
    /** 构建包列表(快速、不阻塞) */
    getBuildPackages(): Promise<ReadonlyArray<PackageEntry>>;
    /** 构建任务提供器注册管理(门控编排,2026-08-28 移入) */
    buildTaskProviderGate: BuildTaskProviderGate;
    /**
     * 扫描取数配置重下发(生效时机一致化,2026-09-28):组合根监听设置变化(5s 去抖)后调用。
     *  - 排除集/符号链接/超时 → cache.updateConfig(键比对+去抖标脏,键未变不重扫)+ colcon list 执行器闭包换新排除集
     *    + DataLayer isDirRelevant 的排除集(闭包捕获可变绑定,重下发后新事件按新集合预过滤);
     *  - packageCacheRefreshMs → 驱动层定时器重设周期(<= 0 停用)。
     * 不影响门控/环境采集/rosmsg 索引/共享缓存单例;断环注入不变(组合根读设置,本层只收值对象)。
     */
    reconfigure(config: PackageCoreConfig): void;
    dispose(): void;
}

/** API Facade:薄封装数据层,对外是唯一入口(实现,合并自 facade.ts) */
export class PackageFacade implements PackageFacadeApi {
    constructor(private readonly data: PackageDataApi) { }

    getState(): Readonly<PackageDataState> {
        return this.data.getState();
    }

    onDidChange(cb: (ev: PackageChangeEvent) => void): () => void {
        return this.data.onDidChange(cb);
    }

    forceRefresh(): Promise<void> {
        return this.data.forceRefresh();
    }

    refreshSystem(): Promise<void> {
        return this.data.refreshSystem();
    }

    ingestPackageCreated(packageXmlPath: string): Promise<void> {
        return this.data.ingestPackageCreated(packageXmlPath);
    }

    toggleIgnore(dir: string): Promise<boolean> {
        return this.data.toggleIgnore(dir);
    }

    getBuildPackages(): Promise<ReadonlyArray<PackageEntry>> {
        return this.data.getBuildPackages();
    }

    dispose(): void {
        this.data.dispose();
    }
}

/** 读取驱动层周期刷新设置(显式参数优先,否则 config.packageCacheRefreshMs,缺省 60s;非法值禁用) */
function readRefreshIntervalMs(configured: number | undefined, config?: PackageCoreConfig): number {
    if (typeof configured === "number") {
        return configured;
    }
    const ms = config?.packageCacheRefreshMs ?? 60000;
    return typeof ms === "number" && ms > 0 ? ms : 0;
}

/** 工作区数据(PackageCache),数据层直接注入,无 WorkspaceSource 抽象 */
interface WorkspaceData {
    cache: PackageCache;
    /** 是否已接扫描取数配置(共享缓存才接;兜底新实例不接,与 2026-08-29 原条件一致) */
    wired: boolean;
}

/** 缺省系统包提供者:经 ros2/ 执行口 pkg_list(2026-08-29 恢复 system 域,取数走执行口原则;失败 → null 透传,由数据层 null 语义表达"未刷新/未知") */
const defaultSystemPackages = async (): Promise<string[] | null> => composeApi.ros2ServiceApi.pkg_list({});

/** 扫描取数配置下发(创建时 + reconfigure 共用):执行器闭包换新排除集 + cache.updateConfig(键比对+去抖标脏) */
function applyScanConfig(
    cache: PackageCache,
    workspaceRoot: string,
    config: PackageCoreConfig | undefined,
    colconList: ReturnType<typeof createColconListExecutor>,
): void {
    const excludedFolders = config?.buildExcludeFolders ?? [];
    // 经 ros2/ 执行口注入 colcon list 执行器(scan/colcon-list,2026-08-29 归位);闭包捕获本次的排除集
    cache.setColconListExecutor(() => colconList(workspaceRoot, excludedFolders));
    const walkTimeouts = config?.walkTimeouts ?? { totalTimeoutMs: 0, branchTimeoutMs: 0, maxDepth: 0 };
    cache.updateConfig({
        excludedFolders,
        followSymlinks: config?.followSymlinks ?? false,
        totalTimeoutMs: walkTimeouts.totalTimeoutMs,
        branchTimeoutMs: walkTimeouts.branchTimeoutMs,
        maxDepth: walkTimeouts.maxDepth,
    });
}

/** 组装数据层工作区基础设施:共享 PackageCache(单一数据源)。 */
function createWorkspaceData(workspaceRoot: string | undefined): WorkspaceData {
    // 无工作区:兜底一个空根缓存(扫描空,不报错);有工作区:复用共享缓存(多消费方单一数据源)
    const cache = workspaceRoot ? getSharedPackageCache(workspaceRoot) : undefined;
    return { cache: cache ?? new PackageCache(workspaceRoot ?? ""), wired: !!(workspaceRoot && cache) };
}

/** 组装 package-core(接入口;extension.ts:activate 调用) */
export function createPackageCore(options: PackageCoreOptions = {}): PackageCore {
    const workspaceRoot = options.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const refreshIntervalMs = readRefreshIntervalMs(options.refreshIntervalMs, options.config);
    const enableWatcher = options.enableWatcher ?? true;

    // 驱动层(底部)
    const fetcher = createPackageFetcher({
        workspaceRoot: enableWatcher ? workspaceRoot : undefined,
        refreshIntervalMs,
        watchDebounceMs: options.watchDebounceMs ?? 500,
    });

    // colcon list 执行器(执行口注入:经 ros2/ CommandRunner;实现归位 scan/colcon-list,2026-08-29)
    const colconList = createColconListExecutor({ exec: (cmd) => composeApi.commandRunner.exec(cmd) });

    // 数据层(夹中间):工作区基础设施(PackageCache)直接注入(无 WorkspaceSource 抽象)
    const { cache, wired } = createWorkspaceData(workspaceRoot);
    if (wired) {
        applyScanConfig(cache, workspaceRoot!, options.config, colconList);
    }
    // 事件廉价预过滤(2026-09-06 §12.4):walk 不会进的区域(排除目录名/点目录/buildExcludeFolders)直接丢弃事件
    // 2026-09-13:显式守卫——无工作区 → 排除集为空(原直接传 undefined 依赖 strictNullChecks 关闭;
    // 运行时在"无工作区 + 配置排除项"时会 path.join(undefined) 抛错;下游 isDirRelevant 本就有同款守卫)
    // 2026-09-28:let 化——reconfigure 重下发时更新,下方 isDirRelevant 闭包捕获可变绑定
    let excludedAbs = workspaceRoot
        ? resolveExcludeFolders(workspaceRoot, options.config?.buildExcludeFolders ?? [])
        : [];
    const data = new DataLayer(
        fetcher,
        cache,
        options.systemPackages ?? defaultSystemPackages,
        {
            isDirRelevant: workspaceRoot
                ? (dir: string) => !isDirScanExcluded(workspaceRoot, dir, excludedAbs)
                : undefined,
        }
    );

    // 门面(上,薄)
    const ui = new PackageFacade(data);

    // 门控编排(自 ros2/ 移入,2026-08-28):任务提供器注册管理,输入经注入;缺省空实现由上层接线
    const buildTaskProviderGate = options.buildTaskProviderGate
        ? createBuildTaskProviderGate(options.buildTaskProviderGate)
        : { sync: () => undefined, dispose: () => undefined };

    const core: PackageCore = {
        ui,
        getState: () => ui.getState(),
        onDidChange: (cb) => ui.onDidChange(cb),
        forceRefresh: () => ui.forceRefresh(),
        refreshSystem: () => ui.refreshSystem(),
        ingestPackageCreated: (p) => ui.ingestPackageCreated(p),
        toggleIgnore: (dir) => ui.toggleIgnore(dir),
        getBuildPackages: () => ui.getBuildPackages(),
        buildTaskProviderGate,
        reconfigure: (config) => {
            if (wired) {
                applyScanConfig(cache, workspaceRoot!, config, colconList);
            }
            excludedAbs = workspaceRoot
                ? resolveExcludeFolders(workspaceRoot, config?.buildExcludeFolders ?? [])
                : [];
            fetcher.setRefreshIntervalMs(readRefreshIntervalMs(undefined, config));
        },
        dispose: () => {
            ui.dispose();
            buildTaskProviderGate.dispose();
        },
    };
    activePackageCore = core;
    return core;
}
