// Licensed under the MIT License.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { PY_TEST_NAME_RE, TestDiscoveryUtils } from "../parsing/test-discovery-utils";
import { RosTestRunner } from "../runner/ros-test-runner";
import { isPackageRunnable, packageNote } from "../semantics/result-semantics";
// B10:发现请求的合并窗 + 单写者队列(纯逻辑 + 可注入定时器)
import { DiscoverScope, DiscoveryQueue, createDiscoveryQueue } from "./discovery-queue";
// 2026-09-24:C++/launch 的**记录驱动发现** —— 名单来自 build/<pkg>/CTestTestfile.cmake
import {
    CTestRegistration,
    declarationOf,
    isGtestRegistration,
    isLaunchTestRegistration,
    launchTestSourceOf,
    parseCTestTestfile,
    sourceArgAtDeclaration
} from "../parsing/ctest-testfile-parser";
// walk 统一入口:读设置/默认排除/叠加额外排除由 walkOptions 一处装配(walk/index barrel)
import { DEFAULT_EXCLUDED_DIR_NAMES, walkOptions, walkWithTimeout } from "../../build-tool/walk";
// T11/B4.2:复用 walk 层的通用路径排除工具(纯函数、零 vscode),不再自实现一份
import { isPathExcluded, resolveExcludeFolders } from "../../build-tool/walk/base/path-exclude";
// B4.1:包来源 = package-core workspace 域(权威真名 + 包目录 + 构建类型)
import { getPackageCore } from "../../build-tool/package-core/api";
import type { PackageChangeEvent, PackageEntry } from "../../build-tool/package-core/api";
// 2026-09-24:共享 build-map 数据中心(构建产物命中 → 按包刷新;顺带把 install-truth 接电)
import { acquireSharedBuildCenter } from "../../install-truth/center/shared-center";
// C++ 记录→源文件的**回退**反查(声明行取不到时才用:install-truth 的 executable → srcPaths)
import { ExecutableResolver } from "../../install-truth/api";

import { getLogger } from "../../logger";

/** 测试发现/运行模块日志 */
const log = getLogger("test-provider");

/**
 * Represents different types of ROS 2 tests
 *
 * 2026-09-24(B6/T6):收窄到**真实存在的两类** —— `PythonUnitTest`(发现层从不产出该值,运行恒走 pytest)、
 * `LaunchTest` / `Integration`(发现层不产出、runner 显式禁用)三个枚举值已删除。
 */
export enum TestType {
    PythonPytest = "python_pytest",
    CppGtest = "cpp_gtest",
    /**
     * B14:`launch_testing` 测试(**整文件运行**,无方法级选择器)。
     * 注:B6 曾删除本枚举值(当时是死枚举);B14 给它落了真实实现,属有依据的反转。
     */
    LaunchTest = "launch_test"
}

/**
 * gtest 用例定义宏(B2):filter 拼法按它分派(见 runner.gtestFilterOf)。
 * 计划 §2.1 原表漏了 `TYPED_TEST_P` —— 它是真实入口宏(`test_gtest_entries.cpp` ⑤),故补入。
 */
export type CppMacroKind =
    | "TEST"
    | "TEST_F"
    | "TEST_P"
    | "TYPED_TEST"
    | "TYPED_TEST_F"
    | "TYPED_TEST_P"
    | "GTEST_TEST";

/** 树节点语义(B4:包 → 文件 → 用例三级) */
export type RosTestKind = "package" | "file" | "case";

/**
 * Data structure for ROS 2 test items
 */
export interface RosTestData {
    /** 节点语义(唯一判别依据;`type` 只是语言/执行器信息) */
    kind: RosTestKind;
    /** 包节点无单一类型 → 可选;文件/用例节点恒有值 */
    type?: TestType;
    filePath: string;
    packageName?: string;
    /** 包根(含 package.xml 的目录);pytest 的 cwd 必须用它(B0),gtest 兜底 cwd(B2) */
    pkgDir?: string;
    /** C++ 用例的入口宏(B2):决定 gtest filter 拼法 */
    cppMacro?: CppMacroKind;
    testClass?: string;
    testMethod?: string;
}

/** 未归类兜底节点的 label(B4:不属于任何工作区真包的散装测试) */
const UNCLASSIFIED_LABEL = vscode.l10n.t("(unclassified)");

/**
 * 可执行项的统一标签(B8)。Run profile 绑定它 ⇒ API 语义
 * ("only TestItem instances with the same tag will be eligible to execute in this profile")
 * 使**不带该标签的项不可执行**:包节点说明项(B7.4)因此没有运行按钮、也不会被 Run All 带走。
 * 约定:**所有真实可运行项(包/文件/用例/未归类)都打**——只漏掉说明项,故 Run All 不会误漏真测试。
 */
const RUNNABLE_TAG = "runnable";

/** 一次发现过程的共享上下文(B4:包归属 + 新地图,贯彻"先建后换") */
interface DiscoverCtx {
    workspaceRoot: string;
    /** 已解析的排除目录绝对路径(来源 `buildExcludeFolders`;每轮读一次,win32 已小写归一) */
    excluded: string[];
    testItemMap: Map<string, vscode.TestItem>;
    testDataMap: Map<string, RosTestData>;
    /** 文件 → 所属节点(包节点;不属于任何包时为「未归类」兜底节点) */
    ownerOf: (filePath: string) => vscode.TestItem;
    /**
     * 被 launch 注册覆盖的源文件(规范化绝对路径;记录扫描时登记)。
     * Python 走源码扫描、launch 走构建记录,两条路会在 `*_launch_test.py` 上撞车 ⇒ Python 侧据此让位。
     * 全量轮用**本轮新集**(成功才换到 provider 字段);增量轮直接用 provider 的 live 集。
     */
    launchSources: Set<string>;
}

/**
 * B11/B12:包索引条目 —— 增量路径的"归属判定 + 增删"都靠它,
 * 不再依赖全量发现期的闭包(`ownerOf` 从闭包升级为持久索引,见 `RosTestProvider.ownerOf`)。
 */
interface PkgIndexEntry {
    name: string;
    /** 规范化绝对路径(排序后按前缀命中;长目录优先 ⇒ 嵌套包先命中) */
    dir: string;
    item: vscode.TestItem;
    /** 包目录下是否有 COLCON_IGNORE(全量/单包刷新时重读) */
    colconIgnored: boolean;
    /** B9:`build/<pkg>` 是否存在(决定包节点有没有运行按钮;build watcher 落地时重读) */
    buildDirPresent: boolean;
    /** package.xml 的 build_type(用于 description;`""` 系统包、`undefined` 未取到 → 都不显示) */
    buildType?: string;
}

/**
 * B11:一条用例的构造规格(解析结果 → TestItem 的中间形态)。
 * 之所以先出"规格"再落树:diff 计划(`planCaseDiff`)需要一份纯粹的"应有哪些 id",
 * 落树则统一的走 `rebuildCases` —— 全量与增量因此共用同一段构造。
 */
interface CaseSpec {
    id: string;
    label: string;
    range: vscode.Range;
    description?: string;
    /** 覆盖文件项的标签(B14:launch_test 的方法项**不带 runnable** —— 官方无方法级选择器) */
    tags?: vscode.TestTag[];
    data: RosTestData;
}

/**
 * ROS 2 Test Provider for VS Code Test Explorer
 * Discovers and runs ROS 2 tests using existing launch mechanisms
 */
export class RosTestProvider {
    private readonly testController: vscode.TestController;
    private readonly disposables: vscode.Disposable[] = [];
    private testItemMap = new Map<string, vscode.TestItem>();
    private testDataMap = new Map<string, RosTestData>();
    private readonly testRunner: RosTestRunner;
    /** 包域(workspace)订阅退订(B4/T10③) */
    private unsubscribeCore: (() => void) | undefined;
    /** 包级差分订阅退订(2026-09-30:构建事件化 —— 中心逐包指纹差分,取代"文件命中反解包名"的 onBuildTouch) */
    private unsubscribePkgDiff: (() => void) | undefined;
    /**
     * B10:发现请求队列(合并窗 + 单写者链)。
     * **取代原 `isDiscovering` 丢弃式守卫** —— 发现进行中来的请求不再被丢掉,
     * 而是排队、由单写者链在本次落地之后补跑(照 rosmsg `workspace-index.ts:171-176`)。
     */
    private readonly queue: DiscoveryQueue;
    /** B11/B12:包索引(增量路径的归属与增删;全量发现成功时整体替换) */
    private pkgIndex: PkgIndexEntry[] = [];
    /** B11:`（未归类）` 兜底节点(首个散装测试出现时惰性创建) */
    private unclassifiedItem: vscode.TestItem | undefined;
    /** 最近一次全量发现的节点数(供手动刷新命令提示"发现 N 项") */
    private lastNodeCount = 0;
    /**
     * 2026-09-24:**被 launch 注册覆盖的源文件**(规范化绝对路径)。
     * 用途:同一文件不能既当 pytest 又当 launch 测试 —— Python 走源码扫描、launch 走构建记录,
     * 两条路径会在 `*_launch_test.py` 上撞车,故记录扫描时登记、Python 侧据此让位。
     * 全量轮用本轮新集(`ctx.launchSources`),**成功落地时**才换到这里;增量轮直接用本字段。
     */
    private launchSources = new Set<string>();

    constructor() {
        this.testController = vscode.tests.createTestController(
            'ros2-test-provider',
            'ROS 2 Tests'
        );

        // B10:所有发现入口都经队列 ⇒ 全量/增量同链串行,天然不需要"进行中就跳过"的守卫。
        this.queue = createDiscoveryQueue({
            onFlush: (scopes) => this.handleScopes(scopes)
        });

        // 根节点解析:VS Code 请求根子项时给全量(自动触发 ⇒ 超时不强制落地)
        this.testController.resolveHandler = async (item) => {
            if (!item) {
                this.queue.schedule({ kind: 'full' });
            }
        };

        // T4:`refreshHandler` 存在时 VS Code 才在视图里显示刷新按钮(手动 ⇒ 超时也强制落地)
        this.testController.refreshHandler = async () => {
            this.queue.schedule({ kind: 'full', force: true });
            await this.queue.flushNow();
        };

        this.testRunner = new RosTestRunner();

        const profile = this.testController.createRunProfile(
            'Run ROS 2 Tests',
            vscode.TestRunProfileKind.Run,
            this.runTests.bind(this),
            true,
            new vscode.TestTag(RUNNABLE_TAG),
            false
        );
        // B8:profile 绑 `runnable` 标签 ⇒ 不带该标签的项**不可执行**(说明项没有运行按钮、Run All 跳过)。
        // 旧注(A11)曾写"不传第 5 参 tag,会让 Run All 静默漏跑"——那是指**只给部分真测试打标**的过滤用法;
        // 现在约定所有真实可运行项统一带上该标签,漏掉的只有说明项,故无该副作用。
        // A11:profile 齿轮 → 直达相关设置(2026-09-24:共用 buildExcludeFolders;测试专用排除项已删除)
        profile.configureHandler = () => {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'ROS2.buildExcludeFolders');
        };

        this.disposables.push(this.testController);
        this.subscribeCoreChanges();
        this.watchTestFiles();
        this.subscribePackageChanges();

        // 初始发现(fire and forget;force = 首次没有旧状态可保留,超时也得落地部分结果)
        this.queue.schedule({ kind: 'full', force: true });
    }

    // -----------------------------------------------------------------------
    // B4:生命周期(包域订阅 / 文件 watcher / 刷新按钮)
    // -----------------------------------------------------------------------

    /** T10③/B12:订阅 package-core 的 workspace 域 —— 包增删/改名走**差量**(不再全量重扫) */
    private subscribeCoreChanges(): void {
        const core = getPackageCore();
        if (core === undefined) {
            log.warn(vscode.l10n.t('package-core not assembled; package-domain changes will not drive test discovery'));
            return;
        }
        this.unsubscribeCore = core.onDidChange((ev: PackageChangeEvent) => {
            if (ev.workspace === undefined && ev.unignored === undefined && ev.ignored === undefined) {
                return; // 只关心工作区包域(system 域与测试树无关)
            }
            log.debug('Workspace package domain changed -> per-package delta');
            this.queue.schedule({ kind: 'packages' });
        });
    }

    /**
     * T4/B11/B13:测试文件 watcher(**增量**)。
     *
     * B13:glob 只按**扩展名**粗筛(`.py` / `.cpp` 全收)—— 命名规则表达不成 glob(要看大小写穷举),
     *      真判定交给 `TestDiscoveryUtils.isTestFileName`(与 walk 正则同源),再补上与 walk
     *      同口径的产物目录过滤 ⇒ **"watcher 认的" = "walk 收的"**(过去是两份手写清单,互相对不上)。
     * B11:三类事件只登记**单文件作用域**,不再触发全量;去抖由队列的合并窗统一负责(200ms)。
     */
    private watchTestFiles(): void {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{py,cpp}');
        watcher.onDidCreate((uri) => this.onTestFileEvent(uri, 'upsert'));
        watcher.onDidChange((uri) => this.onTestFileEvent(uri, 'upsert'));
        watcher.onDidDelete((uri) => this.onTestFileEvent(uri, 'delete'));
        this.disposables.push(watcher);
    }

    /**
     * 构建后包状态重算(2026-09-24 B9 → 2026-09-30 构建事件化)。
     *
     * 2026-09-24:订阅共享数据中心的构建命中(`onBuildTouch`,文件事件反解包名);
     * 2026-09-30:数据中心改构建信号主动刷新(手工重设计/13),本域改订**逐包指纹差分**
     * `center.onPackagesChanged` —— 只有"包真的变了"(新增/变更/删除)才广播,
     * 语义从"文件被碰过"收紧为"包数据变了"(no-op 构建不再触发任何重算):
     *   · 零 watcher(9 组 `**/build/**` 监听已随构建事件化退役);
     *   · 事件**带包名**(逐包指纹对比)⇒ 少量包逐包单包重算,变更包多(>8)时
     *     一次包域差量更便宜(全量留给手动刷新)。
     */
    private subscribePackageChanges(): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root === undefined) {
            return; // 无工作区:初始发现另有守卫
        }
        const shared = acquireSharedBuildCenter(root);
        this.unsubscribePkgDiff = shared.center.onPackagesChanged((names) => {
            if (names.length > 8) {
                log.debug(vscode.l10n.t("{0} packages changed after build -> package-domain delta refresh", names.length));
                this.queue.schedule({ kind: 'packages' });
                return;
            }
            for (const name of names) {
                log.debug(vscode.l10n.t("Package changed after build ({0}) -> single-package state recompute", name));
                this.queue.schedule({ kind: 'package', name });
            }
        });
    }

    /** 单文件事件的**廉价预过滤**(rosmsg 同款分层:扩展名 → 名称规则 → 产物目录 → 用户排除) */
    private onTestFileEvent(uri: vscode.Uri, op: 'upsert' | 'delete'): void {
        const filePath = uri.fsPath;
        if (!TestDiscoveryUtils.isTestFileName(path.basename(filePath))) {
            return; // 普通 .py/.cpp(非测试名):与 walk 同源判定,直接丢弃
        }
        if (filePath.endsWith('.launch.py')) {
            return; // 功能说明 §6.4:launch_testing 资产不发现
        }
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return;
        }
        if (TestDiscoveryUtils.pathHasExcludedDir(filePath, folders[0].uri.fsPath, DEFAULT_EXCLUDED_DIR_NAMES)) {
            return; // build/install/... 下的 .py/.cpp(生成物/安装拷贝):与 walk 同口径排除
        }
        if (op === 'upsert') {
            // A5:内容改了先把旧结果标失效(别让绿勾继续骗人);重解析在队列里落地
            const existing = this.testItemMap.get(vscode.Uri.file(filePath).toString());
            if (existing !== undefined) {
                this.testController.invalidateTestResults(existing);
            }
        }
        this.queue.schedule({ kind: 'file', path: filePath, op: op });
    }

    // -----------------------------------------------------------------------
    // B4:排除(T11 —— 每轮读一次 + 复用 walk 层解析 + win32 归一)
    // -----------------------------------------------------------------------

    /**
     * 解析排除目录为绝对路径(每轮发现只读一次配置)。
     *
     * 2026-09-24:改读 **`ROS2.buildExcludeFolders`** —— 原先测试侧另设 `ROS2.testExcludeFolders`,
     * 与构建/包扫描的排除语义重复(同一个"这些目录别看"的意图两处配置);现共用一份,
     * 测试专用的那个设置已删除。解析/比对逻辑不变(复用 walk 层工具 + win32 归一)。
     */
    private resolveExcludedFolders(workspaceRoot: string): string[] {
        const configured = vscode.workspace.getConfiguration('ROS2').get<string[]>('search.excludeFolders', []);
        if (configured.length === 0) {
            return [];
        }
        const resolved = resolveExcludeFolders(workspaceRoot, configured);
        // T11②:Windows 文件系统大小写不敏感 → 归一后比较(否则用户填的盘符大小写不同就漏排除)
        return process.platform === 'win32' ? resolved.map((p) => p.toLowerCase()) : resolved;
    }

    /** 路径是否命中排除目录(目录边界由 walk 层 `isPathExcluded` 负责) */
    private isExcludedPath(filePath: string, excluded: string[]): boolean {
        if (excluded.length === 0) {
            return false;
        }
        const target = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
        return isPathExcluded(target, excluded);
    }

    // -----------------------------------------------------------------------
    // B4:发现(包树)
    // -----------------------------------------------------------------------

    /** 取工作区真包(package-core workspace 域);null=未就绪 → forceRefresh 后重读 */
    private async collectPackages(): Promise<PackageEntry[] | undefined> {
        const core = getPackageCore();
        if (core === undefined) {
            log.warn(vscode.l10n.t('package-core not assembled; cannot organize tests by package (falling back to flat + unclassified)'));
            return undefined;
        }
        let state = core.getState();
        if (state.workspace === null) {
            await core.forceRefresh();
            state = core.getState();
        }
        const ws = state.workspace;
        if (ws === null) {
            log.warn(vscode.l10n.t('package-core workspace domain still not ready; skipping package nodes in this discovery'));
            return undefined;
        }
        return ws.slice();
    }

    // -----------------------------------------------------------------------
    // B10:作用域分发(队列的落地端)
    // -----------------------------------------------------------------------

    /**
     * 队列落地端:按作用域分派(全量 / 包域差量 / 单包状态 / 单文件)。
     * 队列的单写者链保证"同一时刻只有一个作用域在落地",故这里**不需要**并发守卫
     * (原 `isDiscovering` 丢弃式守卫已随 B10 移除:进行中来的请求改为排队 + 链尾补跑)。
     */
    private async handleScopes(scopes: DiscoverScope[]): Promise<void> {
        for (const scope of scopes) {
            switch (scope.kind) {
                case 'full':
                    await this.discoverAll(scope.force === true);
                    break;
                case 'packages':
                    await this.applyPackageDiff();
                    break;
                case 'package':
                    await this.refreshPackageState(scope.name);
                    break;
                case 'file':
                    if (scope.op === 'delete') {
                        this.applyFileDelete(scope.path);
                    } else {
                        this.applyFileUpsert(scope.path);
                    }
                    break;
            }
        }
    }

    /**
     * 走一遍测试文件名规则(B10):把 `WalkResult` 的**耗时与超时**一并带出来。
     * 过去两处调用只取 `matches`,`timedOut`(注释明示"结果可能不完整")被静默忽略
     * ⇒ 大工作区超时后安静地给出不完整的树;现在至少留一条 warn,且可作为"不落地"的依据。
     */
    private async walkTests(root: string, pattern: RegExp): Promise<{ matches: string[]; timedOut: boolean; elapsedMs: number }> {
        const started = Date.now();
        try {
            const result = await walkWithTimeout(root, pattern, walkOptions('test'));
            if (result.timedOut) {
                log.warn(vscode.l10n.t("Test search truncated by timeout (root={0}, {1} dirs visited): results may be incomplete", root, result.visitedDirs));
            }
            return { matches: result.matches, timedOut: result.timedOut, elapsedMs: Date.now() - started };
        } catch (err) {
            // 扫描失败与超时同待遇:保留旧状态(照 rosmsg "扫描失败:不动表")
            log.error(vscode.l10n.t("Test search failed (root={0}): {1}", root, (err as Error).message));
            return { matches: [], timedOut: true, elapsedMs: Date.now() - started };
        }
    }

    /**
     * 全量发现(B4:包 → 文件 → 用例三级)。**只在两条路上走**:初始发现、手动刷新/兜底。
     *
     * @param force 手动触发 ⇒ 即使 walk 超时也落地(用户明确要求);
     *              自动触发 ⇒ 超时不落地,保留旧状态("允许滞后、不允许错误")。
     */
    private async discoverAll(force: boolean): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            log.debug(vscode.l10n.t("No workspace folder found - skipping test discovery"));
            return;
        }

        try {
            const workspaceRoot = folders[0].uri.fsPath;
            log.info(vscode.l10n.t("Discovering ROS 2 tests (full{0})...", force ? vscode.l10n.t("·forced") : ""));

            const packages = await this.collectPackages();
            const excluded = this.resolveExcludedFolders(workspaceRoot);

            // Build new test collections WITHOUT modifying state yet
            const newTestItemMap = new Map<string, vscode.TestItem>();
            const newTestDataMap = new Map<string, RosTestData>();
            const newRootItems: vscode.TestItem[] = [];

            // ---- 包节点(真名/包目录/构建类型全部来自 package-core 域) ----
            const newPkgIndex: PkgIndexEntry[] = [];
            for (const p of packages ?? []) {
                if (this.isExcludedPath(p.dir, excluded)) {
                    log.debug(vscode.l10n.t("  Skipping package {0} (excluded by buildExcludeFolders)", p.name));
                    continue;
                }
                const entry = this.makePackageEntry(p, workspaceRoot, { items: newTestItemMap, data: newTestDataMap });
                newPkgIndex.push(entry);
                newRootItems.push(entry.item);
            }
            // 嵌套包:长目录优先命中
            newPkgIndex.sort((a, b) => b.dir.length - a.dir.length);

            // 本轮专用的归属判定(用**新**索引;provider 的持久 `pkgIndex` 在成功后才换)
            let unclassified: vscode.TestItem | undefined;
            const ownerOf = (filePath: string): vscode.TestItem => {
                const normalized = path.normalize(filePath);
                for (const p of newPkgIndex) {
                    if (normalized === p.dir || normalized.startsWith(p.dir + path.sep)) {
                        return p.item;
                    }
                }
                if (unclassified === undefined) {
                    unclassified = this.makeUnclassifiedNode();
                    newRootItems.push(unclassified);
                    newTestItemMap.set(unclassified.id, unclassified);
                }
                return unclassified;
            };

            const ctx: DiscoverCtx = {
                workspaceRoot: workspaceRoot,
                excluded: excluded,
                testItemMap: newTestItemMap,
                testDataMap: newTestDataMap,
                ownerOf: ownerOf,
                launchSources: new Set<string>() // 本轮新集:成功落地时才换到 provider 字段
            };

            // ---- 名单来源(2026-09-24 用户裁定) ----
            //   · **C++ / launch:构建记录**(`build/<pkg>/CTestTestfile.cmake` 的注册)。
            //     未构建 ⇒ 无记录 ⇒ **不显示**(没有经过构建的 C++ 测试文件没有意义)。
            //     先扫记录:拿到"哪些源文件被 launch 注册覆盖",好让 Python 侧给它们让位。
            //   · **Python:整工作区源码扫描** —— 包外的 pytest 仍可能被直跑,故保留这次搜索。
            const recordCount = await this.scanBuildRecords(newPkgIndex, ctx);

            const py = await this.walkTests(workspaceRoot, PY_TEST_NAME_RE);
            log.info(vscode.l10n.t("Full discovery finished: {0} build records (C++/launch nodes); Python scanned {1} files ({2} ms); package index {3}", recordCount, py.matches.length, py.elapsedMs, newPkgIndex.length));
            if (py.timedOut && !force) {
                log.warn(vscode.l10n.t('Full discovery truncated by timeout -> not applied this round (old state kept; manual refresh can force-apply)'));
                return;
            }

            for (const filePath of py.matches) {
                this.createFileNode(filePath, TestType.PythonPytest, ctx);
            }

            // ---- B7.4:包节点说明项(必须在文件挂载之后判定) ----
            // 目的:让**每个包节点都可展开**,展开即见"为什么这里没有测试",不必先点运行撞报错。
            // 说明项是**纯文本叶子**:不带 testData(gatherAllTests 只收有 testData 的叶子 → 自动
            // 排除出 Run All)、不带 uri(点击不跳转);被单独运行时走 runner 的 `run.skipped`。
            // 静态提示 ≠ 运行期判定:树是发现时刻的快照,真实成因仍以 packageVerdict 为准。
            for (const p of newPkgIndex) {
                this.applyPackageAffordances(p, this.fileChildCount(p.item, newTestDataMap));
            }

            // SUCCESS: Now update state with discovered tests
            this.testItemMap = newTestItemMap;
            this.testDataMap = newTestDataMap;
            this.pkgIndex = newPkgIndex;
            this.unclassifiedItem = unclassified;
            this.launchSources = ctx.launchSources;
            this.testController.items.replace(newRootItems);

            // A5:整轮重扫后旧结果一律失效(消除"N 个较早的结果"残留)
            this.testController.invalidateTestResults();

            this.lastNodeCount = this.testItemMap.size;
            log.info(vscode.l10n.t("Discovered {0} ROS 2 test items ({1} package nodes).", this.testItemMap.size, newPkgIndex.length));
        } catch (error) {
            log.error(vscode.l10n.t("ROS 2 test discovery failed: {0}", error instanceof Error ? error.message : String(error)));
            log.debug(vscode.l10n.t("Stack trace: {0}", error instanceof Error ? error.stack : String(error)));
            // NOTE: Do NOT clear items on error - keep the previous state
        }
    }

    /** 文件项的标签:类型 + 包名(供筛选框 `@tag:` 使用,A3)+ 可执行标记(B8,见 RUNNABLE_TAG) */
    private tagsFor(packageName: string | undefined, kindTag: 'pytest' | 'gtest' | 'launch_test'): vscode.TestTag[] {
        const tags: vscode.TestTag[] = [new vscode.TestTag(kindTag), new vscode.TestTag(RUNNABLE_TAG)];
        if (packageName !== undefined && packageName !== '') {
            tags.push(new vscode.TestTag(`pkg:${packageName}`));
        }
        return tags;
    }

    /** 归属包信息(未归类 → 包名缺省;cwd 兜底到文件所在目录) */
    private packageInfoOf(filePath: string, ctx: DiscoverCtx): { packageName?: string; pkgDir: string } {
        const owner = ctx.ownerOf(filePath);
        const ownerData = ctx.testDataMap.get(owner.id);
        return {
            packageName: ownerData?.packageName,
            pkgDir: ownerData?.pkgDir ?? path.dirname(filePath)
        };
    }

    /**
     * 建一个**文件节点**(含用例子项)并挂到归属节点 —— 全量与增量共用
     * (过去这段逻辑在 Python/C++ 两处各写一遍,是"两套逻辑漂移"的温床)。
     *
     * **名单来源**(2026-09-24 用户裁定):
     *   · `PythonPytest` —— 源码扫描给名单,本方法内兜名称规则与 launch 资产排除;
     *   · `CppGtest` / `LaunchTest` —— **`build/<pkg>/CTestTestfile.cmake` 的注册记录给名单**
     *     (记录权威,故不做名称规则判定);`reg` 携带注册信息,用于描述里标注声明位置。
     *
     * @returns 建成的文件项;文件里没有用例(解析后 children 为空)→ 清理并返回 undefined
     */
    private createFileNode(
        filePath: string,
        type: TestType,
        ctx: DiscoverCtx,
        reg?: CTestRegistration
    ): vscode.TestItem | undefined {
        if (type === TestType.PythonPytest) {
            // `*.launch.py` 是普通 launch 文件里名字带 test 的那类(资产,不是测试)→ 跳过;
            // 真正的 launch_testing 测试(`*_launch_test.py`)走**记录驱动**那条路,不在此列。
            if (filePath.endsWith('.launch.py')) {
                log.debug(vscode.l10n.t("  Skipping {0} - launch asset (not a test)", path.basename(filePath)));
                return undefined;
            }
            if (!PY_TEST_NAME_RE.test(path.basename(filePath))) {
                return undefined;
            }
            if (ctx.launchSources.has(path.normalize(filePath))) {
                return undefined; // 已被 launch 注册覆盖:同一文件不能既当 pytest 又当 launch 测试
            }
        }
        if (this.isExcludedPath(filePath, ctx.excluded)) {
            log.debug(vscode.l10n.t("  Skipped {0} - path excluded by buildExcludeFolders", path.relative(ctx.workspaceRoot, filePath)));
            return undefined;
        }
        if (!fs.existsSync(filePath)) {
            // 护栏:构建记录可能指向**已删除的源文件**(删了源却没重新构建)。
            // Python 侧的 walk 不会给出不存在的路径,这条只对记录驱动那两条路生效。
            log.debug(vscode.l10n.t("  Skipping non-existent path: {0}", filePath));
            return undefined;
        }

        const info = this.packageInfoOf(filePath, ctx);
        const fileUri = vscode.Uri.file(filePath);
        const fileItem = this.testController.createTestItem(fileUri.toString(), path.basename(filePath), fileUri);
        fileItem.tags = this.tagsFor(
            info.packageName,
            type === TestType.CppGtest ? 'gtest' : (type === TestType.LaunchTest ? 'launch_test' : 'pytest')
        );

        const testData: RosTestData = {
            kind: 'file',
            type: type,
            filePath: filePath,
            packageName: info.packageName,
            pkgDir: info.pkgDir
        };
        ctx.testDataMap.set(fileItem.id, testData);
        ctx.testItemMap.set(fileItem.id, fileItem);

        this.rebuildCases(fileItem, filePath, type, ctx);

        if (fileItem.children.size === 0) {
            log.debug(vscode.l10n.t("  Skipping {0} - no tests found", path.basename(filePath)));
            // 仅当这条 testData 确为本轮所建时才删,避免误删同 id 的他人条目
            if (ctx.testDataMap.get(fileItem.id) === testData) {
                ctx.testDataMap.delete(fileItem.id);
            }
            ctx.testItemMap.delete(fileItem.id);
            return undefined;
        }

        const decl = reg !== undefined ? declarationOf(reg) : undefined;
        const declHint = decl !== undefined ? ` · 注册于 ${path.basename(decl.file)}:${decl.line}` : '';
        if (type === TestType.LaunchTest) {
            // B14:launch_test 的说明 —— 整文件粒度是官方限制(无方法级选择器);缺 mark 时提示
            const hasMark = TestDiscoveryUtils.hasLaunchMark(this.readTextQuietly(filePath));
            fileItem.description = vscode.l10n.t("launch_testing (whole-file run){0}{1}", hasMark ? '' : vscode.l10n.t(' · missing @pytest.mark.launch_test'), declHint);
        } else if (type === TestType.CppGtest) {
            fileItem.description = this.relativeToPkg(filePath, info.pkgDir) + declHint;
        } else {
            fileItem.description = this.relativeToPkg(filePath, info.pkgDir);
        }
        ctx.ownerOf(filePath).children.add(fileItem);
        const kindLabel = type === TestType.CppGtest ? 'C++' : (type === TestType.LaunchTest ? 'launch_test' : 'Python');
        log.debug(vscode.l10n.t("  Found {0} test file: {1} ({2} cases)", kindLabel, path.basename(filePath), fileItem.children.size));
        return fileItem;
    }

    /** 读文本(失败 → 空串);仅用于"缺 mark"这类说明性判定,不参与正确性 */
    private readTextQuietly(filePath: string): string {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return '';
        }
    }

    /**
     * B11:**就地**重建一个文件项的用例子项(diff 而非重建):
     *   · 消失的用例 → 摘除(连带两张 map);
     *   · 新增的用例 → 建项挂上;
     *   · 保留的用例 → **对象不动**,只更新 `range`(文件里插了行也跟得上,行内 ▷ 不跑偏)
     *     —— 保住对象就保住了 VS Code 侧的展开/结果状态。
     * 全量与增量共用(§0.3"单一构造"原则)。
     */
    private rebuildCases(fileItem: vscode.TestItem, filePath: string, type: TestType, ctx: DiscoverCtx): void {
        const specs = type === TestType.CppGtest
            ? this.cppCaseSpecs(fileItem, filePath, ctx)
            : this.pythonCaseSpecs(fileItem, filePath, ctx);
        const currentIds: string[] = [];
        fileItem.children.forEach((c) => currentIds.push(c.id));
        const plan = TestDiscoveryUtils.planCaseDiff(currentIds, specs.map((s) => s.id));

        for (const id of plan.toRemove) {
            ctx.testItemMap.delete(id);
            ctx.testDataMap.delete(id);
            fileItem.children.delete(id);
        }
        for (const spec of specs) {
            const existing = fileItem.children.get(spec.id);
            if (existing !== undefined) {
                existing.range = spec.range;
                continue;
            }
            const item = this.testController.createTestItem(spec.id, spec.label, vscode.Uri.file(filePath));
            item.range = spec.range;
            item.tags = spec.tags ?? fileItem.tags;
            if (spec.description !== undefined) {
                item.description = spec.description;
            }
            ctx.testDataMap.set(item.id, spec.data);
            ctx.testItemMap.set(item.id, item);
            fileItem.children.add(item);
        }
    }

    /** Python 用例规格(id 由 `pythonCaseId` 统一给出 —— B3:父类缺失时并入行号,防同名互踩丢用例) */
    private pythonCaseSpecs(fileItem: vscode.TestItem, filePath: string, ctx: DiscoverCtx): CaseSpec[] {
        const fileData = ctx.testDataMap.get(fileItem.id);
        const isLaunch = fileData?.type === TestType.LaunchTest;
        // B14:launch_test 的方法项**只作结果展示位**(无运行按钮)—— 结果由整文件运行产出,按方法名映射回来
        const launchTags: vscode.TestTag[] | undefined = isLaunch
            ? [
                new vscode.TestTag('launch_test'),
                ...(fileData?.packageName !== undefined && fileData.packageName !== ''
                    ? [new vscode.TestTag(`pkg:${fileData.packageName}`)]
                    : [])
            ]
            : undefined;
        const specs: CaseSpec[] = [];
        try {
            for (const element of TestDiscoveryUtils.parsePythonTestFile(filePath)) {
                if (element.type !== 'method') {
                    continue;
                }
                specs.push({
                    id: TestDiscoveryUtils.pythonCaseId(fileItem.id, element),
                    label: element.name,
                    range: new vscode.Range(element.line, 0, element.line + 1, 0),
                    description: element.parent !== undefined && element.parent !== '' ? element.parent : undefined, // A3:用例项显示所属类
                    tags: launchTags,
                    data: {
                        kind: 'case',
                        type: isLaunch ? TestType.LaunchTest : TestType.PythonPytest,
                        filePath: filePath,
                        packageName: fileData?.packageName,
                        pkgDir: fileData?.pkgDir,
                        testClass: element.parent || undefined,
                        testMethod: element.name
                    }
                });
            }
        } catch (error) {
            log.error(vscode.l10n.t("Failed to parse Python test file {0}: {1}", filePath, error instanceof Error ? error.message : String(error)));
        }
        return specs;
    }

    /** C++ 用例规格(filter 真名两段 = 套件 + 用例;`cppMacro` 决定 B2 的 filter 拼法) */
    private cppCaseSpecs(fileItem: vscode.TestItem, filePath: string, ctx: DiscoverCtx): CaseSpec[] {
        const fileData = ctx.testDataMap.get(fileItem.id);
        const specs: CaseSpec[] = [];
        try {
            for (const testCase of TestDiscoveryUtils.parseCppTestFile(filePath)) {
                specs.push({
                    id: `${fileItem.id}::${testCase.suite}::${testCase.name}`,
                    label: `${testCase.suite}.${testCase.name}`,
                    range: new vscode.Range(testCase.line, 0, testCase.line + 1, 0),
                    description: testCase.suite, // A3:用例项显示所属套件
                    data: {
                        kind: 'case',
                        type: TestType.CppGtest,
                        filePath: filePath,
                        packageName: fileData?.packageName,
                        pkgDir: fileData?.pkgDir,
                        cppMacro: testCase.macro,
                        testClass: testCase.suite,
                        testMethod: testCase.name
                    }
                });
            }
        } catch (error) {
            log.error(vscode.l10n.t("Failed to parse C++ test file {0}: {1}", filePath, error instanceof Error ? error.message : String(error)));
        }
        return specs;
    }

    // -----------------------------------------------------------------------
    // 2026-09-24:记录驱动发现(C++ / launch 的名单来自 build/<pkg>/CTestTestfile.cmake)
    // -----------------------------------------------------------------------

    /**
     * 扫**全部包**的构建记录;返回注册条数(仅用于日志)。
     * 同时把"被 launch 注册覆盖的源文件"登记进 `ctx.launchSources`(Python 侧据此让位)。
     */
    private async scanBuildRecords(pkgIndex: PkgIndexEntry[], ctx: DiscoverCtx): Promise<number> {
        let total = 0;
        for (const entry of pkgIndex) {
            total += await this.scanPackageRecords(entry, ctx, false);
        }
        return total;
    }

    /**
     * 扫**单个包**的构建记录 → 建/刷新它的 C++ 与 launch 节点。
     *
     * @param prune 增量路径传 true:记录里已消失的注册要**摘掉**对应节点
     *              (例如从 CMakeLists 删掉 `ament_add_gtest` 后重新构建);
     *              全量路径传 false(地图本来就是新的,无需剪枝)。
     * @returns 该包的注册条数
     */
    private async scanPackageRecords(entry: PkgIndexEntry, ctx: DiscoverCtx, prune: boolean): Promise<number> {
        const buildPkgDir = path.join(ctx.workspaceRoot, 'build', entry.name);
        let regs: CTestRegistration[] = [];
        try {
            regs = await parseCTestTestfile(buildPkgDir);
        } catch (err) {
            log.debug(vscode.l10n.t("Failed to read CTestTestfile of {0}: {1}", entry.name, (err as Error).message));
        }

        const covered = new Set<string>();
        let created = 0;
        for (const reg of regs) {
            // launch_testing:源文件路径**直接写在 --command 里**(记录即权威,不做内容嗅探)
            if (isLaunchTestRegistration(reg)) {
                const src = launchTestSourceOf(reg);
                if (src === undefined) {
                    log.warn(vscode.l10n.t("launch registration {0} gives no .py source file in --command; skipped", reg.name));
                    continue;
                }
                const key = path.normalize(src);
                covered.add(key);
                ctx.launchSources.add(key);
                if (ctx.testItemMap.get(vscode.Uri.file(src).toString()) === undefined) {
                    if (this.createFileNode(src, TestType.LaunchTest, ctx, reg) !== undefined) {
                        created++;
                    }
                }
                continue;
            }
            // gtest:记录给的是**可执行文件**,源文件由"声明行"反查(见 sourceOfGtestRegistration)
            if (isGtestRegistration(reg)) {
                const src = await this.sourceOfGtestRegistration(reg, entry, ctx);
                if (src === undefined) {
                    log.warn(vscode.l10n.t("gtest registration {0} resolved no source file (declaration line missing?) — skipped", reg.name));
                    continue;
                }
                covered.add(path.normalize(src));
                if (ctx.testItemMap.get(vscode.Uri.file(src).toString()) === undefined) {
                    if (this.createFileNode(src, TestType.CppGtest, ctx, reg) !== undefined) {
                        created++;
                    }
                }
            }
            // 其余 LABELS(pytest 等)不在此处理:Python 走源码扫描那条路
        }

        if (prune) {
            this.prunePackageRecords(entry, covered, ctx);
        }
        if (created > 0) {
            log.info(vscode.l10n.t("[records] {0}: created {1} build-side test items ({2} registrations)", entry.name, created, regs.length));
        }
        return regs.length;
    }

    /**
     * gtest 注册 → **源文件**:
     *   ① 声明行反查(首选):`_BACKTRACE_TRIPLES` 里最后一条 `CMakeLists.txt;<行>` → 读那一行的
     *      `ament_add_gtest(<目标> <源文件>)` 参数(记录自己告诉我们去哪儿找);
     *   ② 回退:install-truth 反查(`lookup(pkg, 注册名)` → `entry.srcPaths`)。
     */
    private async sourceOfGtestRegistration(
        reg: CTestRegistration,
        entry: PkgIndexEntry,
        ctx: DiscoverCtx
    ): Promise<string | undefined> {
        const decl = declarationOf(reg);
        if (decl !== undefined) {
            try {
                const text = await fs.promises.readFile(decl.file, 'utf8');
                const arg = sourceArgAtDeclaration(text, decl.line);
                if (arg !== undefined) {
                    const abs = path.isAbsolute(arg) ? arg : path.resolve(path.dirname(decl.file), arg);
                    if (fs.existsSync(abs)) {
                        return abs;
                    }
                    log.debug(vscode.l10n.t("Source file from declaration line does not exist: {0}", abs));
                }
            } catch (err) {
                log.debug(vscode.l10n.t("Failed to read declaration file ({0}): {1}", decl.file, (err as Error).message));
            }
        }
        // ② 回退:install-truth(共享数据中心;`srcPaths` 就是"目标 → 工作区源"的反向映射)
        try {
            const shared = acquireSharedBuildCenter(ctx.workspaceRoot);
            const lookup = await new ExecutableResolver(shared.center).lookup(entry.name, reg.name);
            const hit = (lookup?.entry?.srcPaths ?? []).find((s) => /\.(cpp|cc|cxx)$/i.test(s));
            if (hit !== undefined) {
                log.debug(vscode.l10n.t("Source file of registration {0} resolved via install-truth reverse lookup: {1}", reg.name, hit));
                return hit;
            }
        } catch (err) {
            log.debug(vscode.l10n.t("install-truth reverse lookup failed ({0}): {1}", reg.name, (err as Error).message));
        }
        return undefined;
    }

    /** 增量剪枝:本包下"C++/launch 节点"若不再被任何注册覆盖 → 摘除(改 CMakeLists 后重建的收敛) */
    private prunePackageRecords(entry: PkgIndexEntry, covered: Set<string>, ctx: DiscoverCtx): void {
        const stale: vscode.TestItem[] = [];
        entry.item.children.forEach((child) => {
            const data = ctx.testDataMap.get(child.id);
            if (data === undefined || data.kind !== 'file') {
                return;
            }
            if (data.type !== TestType.CppGtest && data.type !== TestType.LaunchTest) {
                return;
            }
            if (!covered.has(path.normalize(data.filePath))) {
                stale.push(child);
            }
        });
        for (const item of stale) {
            log.info(vscode.l10n.t("[records] Removed test item that lost its registration: {0}", item.label));
            this.removeFileNode(item, entry.item);
        }
    }

    /* 2026-09-24:原 `typeOfTestFile`(按文件名推断类型)已删除 ——
       C++/launch 的类型判定改由构建记录的 `LABELS` 给出(gtest / launch_test),不再靠文件名猜;
       Python 侧的类型恒定(pytest),只剩名称规则过滤(见 createFileNode)。 */

    /* 2026-09-24(B11):`discoverCppTests` / `discoverPythonTests` 已删除 ——
       两条 walk 与"建文件节点"的公共部分收敛为 `walkTests` + `createFileNode`(全量/增量共用),
       不再有"Python 一份、C++ 一份"的重复实现。 */

    /** 文件相对包根的路径(文件项 description;同名文件因此可辨,A3) */
    private relativeToPkg(filePath: string, pkgDir: string): string {
        const rel = path.relative(pkgDir, filePath);
        return rel === '' || rel.startsWith('..') ? path.basename(filePath) : rel.split(path.sep).join('/');
    }

    /* 2026-09-24(B11):`parsePythonTestFile` / `parseCppTestFile` 已删除 ——
       它们的职责被拆成两半并共用:解析 → `pythonCaseSpecs` / `cppCaseSpecs`(纯规格),
       落树 → `rebuildCases`(diff 就地增删)。这样增量路径与全量路径**共用同一段构造**,
       不会出现"全量认得的用例、增量漏掉"的口径漂移。 */

    // -----------------------------------------------------------------------
    // B11/B12:增量(单文件挂/摘 · 包域差量 · 包状态)
    // -----------------------------------------------------------------------

    /** 持久归属判定(增量路径用):包节点(长目录优先)/ `（未归类）` 兜底节点 */
    private ownerOf(filePath: string): vscode.TestItem {
        const normalized = path.normalize(filePath);
        for (const e of this.pkgIndex) {
            if (normalized === e.dir || normalized.startsWith(e.dir + path.sep)) {
                return e.item;
            }
        }
        if (this.unclassifiedItem === undefined) {
            const node = this.makeUnclassifiedNode();
            this.testController.items.add(node);
            this.unclassifiedItem = node;
        }
        return this.unclassifiedItem;
    }

    /** 增量路径的共享上下文(两张 **live** map + 持久归属索引;与全量的 ctx 同型 ⇒ 构造可共用) */
    private incrementalCtx(workspaceRoot: string): DiscoverCtx {
        return {
            workspaceRoot: workspaceRoot,
            excluded: this.resolveExcludedFolders(workspaceRoot),
            testItemMap: this.testItemMap,
            testDataMap: this.testDataMap,
            ownerOf: (p) => this.ownerOf(p),
            launchSources: this.launchSources // 增量轮:直接用 live 集(记录扫描会就地登记)
        };
    }

    /**
     * B11:单文件 upsert(watcher 的 create / change 都走这里)。
     * 不在树里 → 建文件节点挂上去;在树里 → **只重解析这一个文件**并 diff 用例子项。
     */
    private applyFileUpsert(filePath: string): void {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return;
        }
        const ctx = this.incrementalCtx(folders[0].uri.fsPath);
        const id = vscode.Uri.file(filePath).toString();
        const existing = this.testItemMap.get(id);
        const base = path.basename(filePath);
        const isPythonSource = PY_TEST_NAME_RE.test(base) && !filePath.endsWith('.launch.py');

        // ---- C++ / launch:记录驱动的世界,**源码事件只能刷新已有节点**(2026-09-24 裁定) ----
        //  · `.cpp`:未在 CMakeLists 注册/未构建 ⇒ 树里没有它 ⇒ 什么都不做(没有构建的 C++ 测试没有意义);
        //  · `.py`:先看它是不是被 launch 注册覆盖(`*_launch_test.py`)——是则按 launch 刷新;
        //          不是则可能仍是"普通 pytest"⇒ 落到下面的 Python 分支(包外 pytest 仍可直跑)。
        if (!isPythonSource && existing === undefined) {
            return; // 非 Python 源且树里没有:C++ 不从源码发现
        }
        if (existing !== undefined) {
            const data = this.testDataMap.get(id);
            const isRecordType = data?.type === TestType.CppGtest || data?.type === TestType.LaunchTest;
            if (isRecordType) {
                // 记录型节点:重解析用例 + 更新行号(注册本身由构建事件驱动,不在这里增删)
                this.rebuildCases(existing, filePath, data.type as TestType, ctx);
                if (existing.children.size === 0) {
                    const owner = this.ownerOf(filePath);
                    this.removeFileNode(existing, owner);
                    this.refreshPackageStateOf(owner);
                    log.info(vscode.l10n.t("[delta] Removed record-based file item (no cases): {0}", base));
                    return;
                }
                log.info(vscode.l10n.t("[delta] Reparsed {0} file item: {1} ({2} cases)", data.type, base, existing.children.size));
                return;
            }
        }

        if (!isPythonSource) {
            // 非 Python 源、树里也没有对应节点 ⇒ 不是我们的发现面
            return;
        }

        // ---- Python:源码扫描的世界(包外也保留发现) ----
        if (ctx.launchSources.has(path.normalize(filePath))) {
            return; // 已被 launch 注册覆盖:等构建事件那条路去管它
        }

        if (existing === undefined) {
            const created = this.createFileNode(filePath, TestType.PythonPytest, ctx);
            if (created !== undefined) {
                this.refreshPackageStateOf(this.ownerOf(filePath));
                log.info(vscode.l10n.t("[delta] Created file item: {0} ({1} cases)", base, created.children.size));
            }
            return;
        }

        const data = this.testDataMap.get(id);
        if (data !== undefined && data.type !== TestType.PythonPytest) {
            // 类型变了(防御性:同路径不可能两类型):先摘后建
            const owner = this.ownerOf(filePath);
            this.removeFileNode(existing, owner);
            this.createFileNode(filePath, TestType.PythonPytest, ctx);
            this.refreshPackageStateOf(owner);
            return;
        }

        this.rebuildCases(existing, filePath, TestType.PythonPytest, ctx);
        if (existing.children.size === 0) {
            // 文件里已无用例(内容改成注释等)→ 摘掉节点(与全量"跳过无用例文件"同结果)
            const owner = this.ownerOf(filePath);
            this.removeFileNode(existing, owner);
            this.refreshPackageStateOf(owner);
            log.info(vscode.l10n.t("[delta] Removed file item (no cases): {0}", base));
            return;
        }
        existing.description = this.relativeToPkg(filePath, data?.pkgDir ?? path.dirname(filePath));
        this.refreshPackageStateOf(this.ownerOf(filePath));
        log.info(vscode.l10n.t("[delta] Reparsed file item: {0} ({1} cases)", base, existing.children.size));
    }

    /** B11:单文件删除(**迟到删除 → no-op**,照 rosmsg `tables.ts:205-207`) */
    private applyFileDelete(filePath: string): void {
        const item = this.testItemMap.get(vscode.Uri.file(filePath).toString());
        if (item === undefined) {
            return;
        }
        const owner = this.ownerOf(filePath);
        this.removeFileNode(item, owner);
        this.refreshPackageStateOf(owner);
        log.info(vscode.l10n.t("[delta] Removed file item: {0}", path.basename(filePath)));
    }

    /** B11:摘除一个文件项(连带其用例子项清出两张 map);`TestItem` 无父指针 ⇒ 归属由调用方给出 */
    private removeFileNode(fileItem: vscode.TestItem, owner: vscode.TestItem): void {
        const childIds: string[] = [];
        fileItem.children.forEach((c) => childIds.push(c.id));
        for (const id of childIds) {
            this.testItemMap.delete(id);
            this.testDataMap.delete(id);
        }
        owner.children.delete(fileItem.id);
        this.testItemMap.delete(fileItem.id);
        this.testDataMap.delete(fileItem.id);
    }

    /** B12:包域**差量** —— 只增/删/改受影响的包,不再全量重扫 */
    private async applyPackageDiff(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return;
        }
        const workspaceRoot = folders[0].uri.fsPath;
        const packages = await this.collectPackages();
        if (packages === undefined) {
            log.warn(vscode.l10n.t('Package domain not ready -> falling back to full discovery'));
            this.queue.schedule({ kind: 'full' });
            return;
        }
        const excluded = this.resolveExcludedFolders(workspaceRoot);
        const next = new Map<string, PackageEntry>();
        for (const p of packages) {
            if (!this.isExcludedPath(p.dir, excluded)) {
                next.set(p.name, p);
            }
        }
        const prev = new Map(this.pkgIndex.map((e) => [e.name, e] as const));
        let added = 0;
        let removed = 0;
        let changed = 0;

        // ① 删除:名字消失,或目录变了(改名/移动 = remove + add,与 package-map 的拆碎逻辑同构)
        for (const [name, entry] of prev) {
            const p = next.get(name);
            if (p === undefined || path.normalize(p.dir) !== entry.dir) {
                this.removePackageNode(entry);
                removed++;
            }
        }
        // ② 新增 / 重建;同目录的只更新属性与包状态
        for (const [name, p] of next) {
            const entry = prev.get(name);
            if (entry !== undefined && path.normalize(p.dir) === entry.dir) {
                if ((p.buildType ?? '') !== (entry.buildType ?? '')) {
                    entry.buildType = p.buildType;
                    entry.item.description = p.buildType !== undefined && p.buildType !== '' ? p.buildType : undefined;
                    changed++;
                }
                this.refreshPackageStateOf(entry.item);
                continue;
            }
            await this.addPackageNode(p, workspaceRoot, excluded);
            added++;
        }
        if (added + removed + changed > 0) {
            log.info(vscode.l10n.t("[delta] Package domain delta: added {0} / removed {1} / changed {2}", added, removed, changed));
        } else {
            log.debug('[delta] Package domain delta: no changes');
        }
    }

    /** B12:新增包节点,并**只扫该包目录**(walk 的 root 可传任意子目录,已核实 `ts-walk.ts:174`) */
    private async addPackageNode(p: PackageEntry, workspaceRoot: string, excluded: string[]): Promise<void> {
        const entry = this.makePackageEntry(p, workspaceRoot, { items: this.testItemMap, data: this.testDataMap });
        this.pkgIndex.push(entry);
        this.pkgIndex.sort((a, b) => b.dir.length - a.dir.length);
        this.testController.items.add(entry.item);

        const ctx = this.incrementalCtx(workspaceRoot);
        ctx.excluded = excluded;
        const py = await this.walkTests(entry.dir, PY_TEST_NAME_RE);
        for (const filePath of py.matches) {
            this.createFileNode(filePath, TestType.PythonPytest, ctx);
        }
        // C++/launch 走**构建记录**(未构建 ⇒ 无记录 ⇒ 不显示),不再扫源文件
        const regCount = await this.scanPackageRecords(entry, ctx, false);
        this.refreshPackageStateOf(entry.item);
        log.info(vscode.l10n.t("[delta] Package added {0}: py {1} files / build records {2}", p.name, py.matches.length, regCount));
    }

    /** B12:摘除包节点(连带整棵子树的文件/用例/说明项清出两张 map) */
    private removePackageNode(entry: PkgIndexEntry): void {
        const fileIds: string[] = [];
        entry.item.children.forEach((c) => {
            if (this.testDataMap.get(c.id)?.kind === 'file') {
                fileIds.push(c.id);
            }
        });
        for (const id of fileIds) {
            const item = this.testItemMap.get(id);
            if (item !== undefined) {
                this.removeFileNode(item, entry.item);
            }
        }
        // 残留(说明项等)一并清掉
        const leftovers: string[] = [];
        entry.item.children.forEach((c) => leftovers.push(c.id));
        for (const id of leftovers) {
            this.testItemMap.delete(id);
            this.testDataMap.delete(id);
        }
        this.testItemMap.delete(entry.item.id);
        this.testDataMap.delete(entry.item.id);
        this.testController.items.delete(entry.item.id);
        this.pkgIndex = this.pkgIndex.filter((e) => e !== entry);
        log.info(vscode.l10n.t("[delta] Package removed {0}", entry.name));
    }

    /**
     * B12:按包名刷新包状态(`{kind:'package'}` 作用域的落地端)。
     * B9 的 build 目录 watcher 落地后接这里 —— 按 `build/<pkg>/…` 反解包名即可,不必全量重扫。
     */
    private async refreshPackageState(name: string): Promise<void> {
        const entry = this.pkgIndex.find((e) => e.name === name);
        if (entry === undefined) {
            return;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root !== undefined) {
            // 2026-09-24:构建事件除了改状态,还可能**带来新的 CTest 注册**(刚构建完的包)
            // ⇒ 顺带重扫该包记录(带剪枝:CMakeLists 里删掉的注册要收敛掉)
            await this.scanPackageRecords(entry, this.incrementalCtx(root), true);
        }
        this.refreshPackageStateOf(entry.item);
    }

    /**
     * B11/B12/B9:包状态(note / runnable)就地重算 —— **只重算门面,不重扫任何文件**。
     * 三项事实全部现读:COLCON_IGNORE、`build/<pkg>` 存在性、文件子项数
     * (B9 的 build watcher 落到这里 ⇒ 构建完成即自动恢复按钮/说明项)。
     */
    private refreshPackageStateOf(pkgItem: vscode.TestItem): void {
        const entry = this.pkgIndex.find((e) => e.item.id === pkgItem.id);
        if (entry === undefined) {
            return; // `（未归类）`:没有说明项
        }
        entry.colconIgnored = fs.existsSync(path.join(entry.dir, 'COLCON_IGNORE'));
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        entry.buildDirPresent = root !== undefined && fs.existsSync(path.join(root, 'build', entry.name));
        this.applyPackageAffordances(entry, this.fileChildCount(pkgItem));
    }

    /** 文件子项数(说明项不算:它没有 `kind === 'file'` 的 testData) */
    private fileChildCount(pkgItem: vscode.TestItem, dataMap: Map<string, RosTestData> = this.testDataMap): number {
        let count = 0;
        pkgItem.children.forEach((c) => {
            if (dataMap.get(c.id)?.kind === 'file') {
                count++;
            }
        });
        return count;
    }

    /** 说明项的**唯一入口**(增/删/改;全量与增量都走这里,B7.4/B9 的判定不重复实现) */
    private updateNoteChild(entry: PkgIndexEntry, childCount: number): void {
        const pkgItem = entry.item;
        const noteId = `${pkgItem.id}::note`;
        const existing = pkgItem.children.get(noteId);
        const text = packageNote({
            pkg: entry.name,
            colconIgnorePresent: entry.colconIgnored,
            buildDirPresent: entry.buildDirPresent,
            childCount: childCount
        });
        if (text === undefined) {
            if (existing !== undefined) {
                pkgItem.children.delete(noteId);
            }
            return;
        }
        if (existing === undefined) {
            pkgItem.children.add(this.testController.createTestItem(noteId, text));
            return;
        }
        if (existing.label !== text) {
            existing.label = text;
        }
    }

    /**
     * B9:包节点的"门面"统一重算 —— **说明项 + 可运行标签**,全量发现与增量刷新都从走这里。
     *
     * 可运行 = 三件事同时成立(`isPackageRunnable`):非 COLCON_IGNORE、已构建、有已发现的测试文件。
     * 不满足就不打 `runnable` 标签 ⇒ 该包节点**没有运行按钮**、Run All 也不会带走它
     * (与说明项同一套"静态告知";运行期真值仍由 `packagePreflight` 判定)。
     */
    private applyPackageAffordances(entry: PkgIndexEntry, childCount: number): void {
        this.updateNoteChild(entry, childCount);

        const runnable = isPackageRunnable({
            colconIgnorePresent: entry.colconIgnored,
            buildDirPresent: entry.buildDirPresent,
            testFileCount: childCount
        });
        const tags = entry.item.tags ?? [];
        const hasTag = tags.some((t) => t.id === RUNNABLE_TAG);
        if (runnable && !hasTag) {
            entry.item.tags = [...tags, new vscode.TestTag(RUNNABLE_TAG)];
        } else if (!runnable && hasTag) {
            entry.item.tags = tags.filter((t) => t.id !== RUNNABLE_TAG);
        }
    }

    /** 建包节点 + package 数据(全量与增量共用;B7.2:包节点不带 uri) */
    private makePackageEntry(p: PackageEntry, workspaceRoot: string, maps: { items: Map<string, vscode.TestItem>; data: Map<string, RosTestData> }): PkgIndexEntry {
        const item = this.testController.createTestItem(`pkg:${p.name}`, p.name);
        if (p.buildType !== undefined && p.buildType !== '') {
            // buildType 三态:"" = 系统包(本域不用)、undefined = 工作区包未取到 → 都不显示,不臆测
            item.description = p.buildType;
        }
        // B9:`runnable` 标签**不在这里打** —— 它还要看"有没有测试文件",只有全量/单包刷新
        // 在文件挂载之后才能判定(`applyPackageAffordances`)。此处只留 pkg 标签。
        item.tags = [new vscode.TestTag(`pkg:${p.name}`)];
        maps.data.set(item.id, {
            kind: 'package',
            filePath: p.dir,
            pkgDir: p.dir,
            packageName: p.name
        });
        maps.items.set(item.id, item);
        return {
            name: p.name,
            dir: path.normalize(p.dir),
            item: item,
            // B7.4:COLCON_IGNORE 只看包目录自身(与 runner 的 packageVerdict 同口径)
            colconIgnored: fs.existsSync(path.join(p.dir, 'COLCON_IGNORE')),
            // B9:构建目录存在性同批读取(colcon 的 build 基目录恒为工作区根下的 build)
            buildDirPresent: fs.existsSync(path.join(workspaceRoot, 'build', p.name)),
            buildType: p.buildType
        };
    }

    /** `（未归类）` 兜底节点(全量与增量共用;B8:兜底节点也是可运行的分组节点) */
    private makeUnclassifiedNode(): vscode.TestItem {
        const node = this.testController.createTestItem('pkg:__unclassified', UNCLASSIFIED_LABEL);
        node.description = vscode.l10n.t('Does not belong to any workspace package');
        node.tags = [new vscode.TestTag(RUNNABLE_TAG)];
        return node;
    }

    // -----------------------------------------------------------------------
    // 运行
    // -----------------------------------------------------------------------

    /**
     * Run tests using VS Code Test API
     */
    private async runTests(
        request: vscode.TestRunRequest,
        cancellation: vscode.CancellationToken
    ): Promise<void> {
        const run = this.testController.createTestRun(request);
        const completionPromises: Promise<void>[] = [];
        // A1(计划 B1.6):子进程输出逐块回灌「测试结果」面板。
        // appendOutput 要求 CRLF(换行为 LF 时 VS Code 不换行)。
        // B14-fix:**必须带第三参 `test`** —— 否则所有并发进程共灌一条流水,
        // 并行 Run All 时互相插字(实机表现为"乱序"报告:两个进程的输出粘在一行)。
        const onChunkFor = (item: vscode.TestItem | undefined) => (chunk: string): void => {
            run.appendOutput(chunk.replace(/\r?\n/g, '\r\n'), undefined, item);
        };

        try {
            // Collect tests to run - either from request or all tests
            const testItems = request.include || this.gatherAllTests();
            // A6:尊重用户在 UI 里排除的项(展开为子孙叶子后按 id 比对)
            const excludedIds = new Set<string>();
            for (const ex of request.exclude ?? []) {
                const collect = (item: vscode.TestItem): void => {
                    if (item.children.size === 0) {
                        excludedIds.add(item.id);
                        return;
                    }
                    item.children.forEach(collect);
                };
                collect(ex);
            }
            const toRun = excludedIds.size === 0 ? testItems : testItems.filter((t) => !excludedIds.has(t.id));
            log.info(vscode.l10n.t("Running {0} test items...{1}", toRun.length, excludedIds.size > 0 ? vscode.l10n.t(" ({0} excluded)", excludedIds.size) : ""));

            // B5:包节点走"包级执行器"(colcon test + 官方产物解析),串行;其余走逐个用例路径
            const packageItems: vscode.TestItem[] = [];
            const rest: vscode.TestItem[] = [];
            for (const t of toRun) {
                if (this.testDataMap.get(t.id)?.kind === 'package') {
                    packageItems.push(t);
                } else {
                    rest.push(t);
                }
            }
            for (const pkgItem of packageItems) {
                if (cancellation.isCancellationRequested) {
                    break;
                }
                const data = this.testDataMap.get(pkgItem.id);
                if (data === undefined) {
                    continue;
                }
                // 不调 `run.started(pkgItem)` —— VS Code 把"状态≥running 的项"都列进结果面板,
                // 包节点会因此留下一条**永远在跑**的空行(用户实测:面板里多出 `p10_mix_deps_std`/`iii`)。
                // 包级运行的明细在各文件项/用例项上,包节点不再作为汇报目标。
                // 包级运行:colcon 日志走**运行级**输出 —— 挂到包节点名下会让它被列进结果面板
                // (用户实测:多出一条 `p10_mix_deps_std` 空行);包级明细在各用例项上。
                await this.testRunner.runPackageTests(data, run, pkgItem, this.packageScopeOf(pkgItem),
                    (chunk: string) => run.appendOutput(chunk.replace(/\r?\n/g, '\r\n')), cancellation);
            }

            // Run tests in parallel with a single shared terminal
            for (const testItem of rest) {
                if (cancellation.isCancellationRequested) {
                    break;
                }

                const completionPromise = this.runSingleTest(testItem, run, onChunkFor(testItem), cancellation);
                completionPromises.push(completionPromise);
            }

            // Wait for all tests to complete before ending the run
            await Promise.all(completionPromises);
        } finally {
            run.end();
        }
    }

    /**
     * 包节点的运行 scope(B5):按语言分组其文件项 ——
     * junit 与 gtest 的用例→项映射规则不同,`run-report` 需要分开喂(B5.1)。
     */
    private packageScopeOf(pkgItem: vscode.TestItem): { py: vscode.TestItem[]; cpp: vscode.TestItem[]; launch: vscode.TestItem[] } {
        const py: vscode.TestItem[] = [];
        const cpp: vscode.TestItem[] = [];
        const launch: vscode.TestItem[] = [];
        pkgItem.children.forEach((f) => {
            const data = this.testDataMap.get(f.id);
            if (data === undefined) {
                return; // B7.4:包节点说明项(纯文本叶子)不是上报目标
            }
            if (data.type === TestType.CppGtest) {
                cpp.push(f);
            } else if (data.type === TestType.LaunchTest) {
                launch.push(f); // B14:launch_test 的 junit 映射与 pytest 不同,单独一组
            } else {
                py.push(f);
            }
        });
        return { py: py, cpp: cpp, launch: launch };
    }

    /**
     * 工作空间级运行(供命令 `ROS2.tests.runAll`,2026-09-29 重定义,用户裁定填空位):
     * 测试视图最高档只到包节点 —— 本命令 = 「整个工作空间的测试」:include = 全部包节点,
     * 沿 runTests 既有串行包级执行器(colcon test + 官方产物解析 + 包级 preflight)逐包跑。
     * 旧实现"全部叶子各跑一遍"(逐用例开进程)严格弱于测试视图(够不着包级 colcon test、
     * 不跑 launch 测试)且并行进程数随时例数爆炸,已废。
     */
    public async runAllWorkspace(): Promise<void> {
        const packageItems: vscode.TestItem[] = [];
        this.testController.items.forEach((p) => {
            if (this.testDataMap.get(p.id)?.kind === 'package') {
                packageItems.push(p);
            }
        });
        if (packageItems.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('ROS 2 tests: no packages found (workspace has no package.xml, or package discovery is not ready)'));
            return;
        }
        const request = new vscode.TestRunRequest(packageItems, undefined, undefined, false, true);
        const source = new vscode.CancellationTokenSource();
        try {
            await this.runTests(request, source.token);
        } finally {
            source.dispose();
        }
    }

    /**
     * Gather all runnable leaf items from the controller
     *
     * B1/T2:只收**叶子**(用例)项。原实现把"文件项 + 其子项"一起收集,而 `runSingleTest`
     * 对有子项的文件项又会递归跑一遍子项 → Run All 时每个叶子跑两遍(重复上报,部分用例二次执行)。
     * B4:包节点与无测试数据的空节点一律排除(它们不是可运行项)。
     */
    private gatherAllTests(): vscode.TestItem[] {
        const leaves: vscode.TestItem[] = [];
        const walk = (item: vscode.TestItem): void => {
            if (item.children.size === 0) {
                const data = this.testDataMap.get(item.id);
                // B14:launch_test 的方法项不是可运行单元(官方无方法级选择器)——它们只展示结果
                const isLaunchCase = data?.type === TestType.LaunchTest && data.kind === 'case';
                if (data !== undefined && data.kind !== 'package' && !isLaunchCase) {
                    leaves.push(item);
                }
                return;
            }
            item.children.forEach((child) => walk(child));
        };
        this.testController.items.forEach((item) => walk(item));
        return leaves;
    }

    /**
     * Run a single test using appropriate ROS 2 mechanisms
     */
    private async runSingleTest(
        testItem: vscode.TestItem,
        run: vscode.TestRun,
        onChunk: (chunk: string) => void,
        cancellation: vscode.CancellationToken
    ): Promise<void> {
        // If this test item has children, run all children in parallel
        if (testItem.children.size > 0) {
            log.debug(vscode.l10n.t("  Running {0} sub-tests in {1}...", testItem.children.size, testItem.label));
            const childPromises: Promise<void>[] = [];
            testItem.children.forEach(child => {
                childPromises.push(this.runSingleTest(child, run, onChunk, cancellation));
            });
            await Promise.all(childPromises);
            return;
        }

        const testData = this.testDataMap.get(testItem.id);
        if (!testData) {
            log.debug(vscode.l10n.t("  Skipping {0} - no test data found", testItem.label));
            run.skipped(testItem);
            return;
        }

        log.debug(vscode.l10n.t("  Run: {0} ({1})", testItem.label, testData.type));
        run.started(testItem);

        try {
            await this.testRunner.runTest(testData, run, testItem, onChunk, cancellation);
            // Test result is handled by the monitoring in runTest
        } catch (error) {
            // A2(B1.6):构建/环境/启动类失败记 `errored`,与"用例失败"分级
            const message = new vscode.TestMessage(error instanceof Error ? error.message : String(error));
            run.errored(testItem, message);
        }
    }

    // -----------------------------------------------------------------------
    // 释放 / 手动刷新
    // -----------------------------------------------------------------------

    /**
     * Dispose of resources
     */
    public dispose(): void {
        this.queue.dispose();
        if (this.unsubscribeCore !== undefined) {
            this.unsubscribeCore();
            this.unsubscribeCore = undefined;
        }
        if (this.unsubscribePkgDiff !== undefined) {
            this.unsubscribePkgDiff();
            this.unsubscribePkgDiff = undefined;
        }
        this.disposables.forEach(d => d.dispose());
        // B2:释放 install-truth 解析器引用(数据中心是共享的,由 shared-center 统一释放)
        this.testRunner.dispose();
    }

    /**
     * 手动全量刷新(命令 / 视图刷新按钮):**强制落地**(用户明确要求,超时也认)。
     *
     * B13:返回 Promise + 节点数 ⇒ 命令可以 `await` 之后再提示,
     * 不再是"先弹『已刷新』、其实还没干"(旧实现同步返回,提示先于结果)。
     */
    public async refresh(): Promise<number> {
        this.queue.schedule({ kind: 'full', force: true });
        await this.queue.flushNow();
        return this.lastNodeCount;
    }
}
