// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file extension.ts
 * 扩展主入口:状态与生命周期骨架。
 * 公共状态(outputChannel / onDidChangeEnv / resolvedEnv / getEnv / Commands 枚举)
 * 在此导出供各模块复用;env 等环境状态已收进 environment/ 门面,activate 只做初始化与模块组装。
 * 2026-10-18(P2 启动顺序倒换):activate 重排为「壳注册段 → await 环境检测 → 构造/reconcile 段」——
 *  - 壳注册段:命令/视图/语言提供器全部注册但零后台活动(注册≠启动;await 期间外部命令调用排队不丢);
 *  - 环境检测:await activateEnvironment(有环境机器典型 1-3s,无环境毫秒级快速失败);
 *  - 构造/reconcile 段:package-core 等门内组件构造后按环境门显式 start(门关不启动,门开热启动)。
 * 已拆分模块:
 *  - src/ros2/environment/  环境判定 / source / 激活
 *  - src/commands/          按领域命令注册(统一围栏见 commands/gated-command.ts)
 *  - src/onboarding.ts      欢迎演练
 */

import * as vscode from "vscode";

import { getLogger, setLogChannelGetter } from "./logger";

import * as cpp_formatter from "./cpp-formatter";
import * as vscode_utils from "./vscode-utils";

// 2026-08-28:colconUtils import 移除(旧壳退役,包数据/翻转/监听已切 package-core)
// 2026-08-31:build 子域能力统一经 index 出口导入(registerColconCommands + registerBuildTaskProvider),不再直连子文件
import { ColconBuildCommand, ColconBuildPackageDebugCommand, ColconBuildPackageReleaseCommand, ColconToggleIgnoreCommand, registerBuildTaskProvider, registerColconCommands } from "./build-tool/package-service/build";
// 2026-09-25:run 子域(ros2 run / ros2 launch 重做:模板机制 + 按目标分槽记忆 + 侧边栏 ▶ 委托)
import { createInstallTruthRunDataSource, registerRosRunCommands } from "./build-tool/package-service/run";
// 2026-09-01:create 命令直连(与 colcon 同模式,经 create/index.ts 出口,不再经 commands/index.ts 转发)
import { registerCreatePackageCommands } from "./build-tool/package-service/create";

// 2026-09-04:rosmsg 域唯一出口(languages/rosmsg/index),不再直连内部文件
import { registerRosMessageProviders } from "./languages/rosmsg";
import { registerXacroProviders } from "./languages/xacro";
import { PackageMap } from "./languages/shared/package-map";
import { registerLaunchProviders } from "./languages/launch/providers";
import { registerRosPythonCompletion } from "./languages/python/py-ros-snippets";
import { registerRosCppCompletion } from "./languages/cpp/cpp-ros-snippets";
import { RosTestProvider } from "./test-provider/provider/ros-test-provider";
// 2026-09-21:侧边栏(install-truth 三区;简易版)
import { registerInstallTruthSidebar } from "./sidebar/install-truth-sidebar";
// 2026-09-24:共享 build-map 数据中心(侧边栏与测试侧共用;停用时释放)
// 2026-09-30:接构建信号主动刷新(手工重设计/13;取代 9 组 build/** watcher 只置脏)
// 2026-10-18(P2/P3):首扫挂环境门+pendingBuildScan 补扫,见 activate 内 onBuildSignal/reconcile
import { acquireSharedBuildCenter, disposeSharedBuildCenter } from "./install-truth/center/shared-center";
import { setEnsureFreshGate } from "./install-truth/center/build-map-center";
// 2026-08-28:launch-tree 已废弃注释(用户确认废弃模块,接线移除)

import * as environment from "./ros2/environment";
import { environmentFacade } from "./ros2/environment";
import { ShowDaemonStatusCommand } from "./ros2/host/commands";
import * as rosTerminalProfile from "./ros2/consumers/terminal/terminal-profile";
import { setParamHelperExtensionVersion } from "./ros2/consumers/monitor/helper/param-helper-client";
import * as onboarding from "./onboarding";
import * as commands from "./commands";
import { createPackageCore, PackageCore, PackageCoreConfig } from "./build-tool/package-core/compose";
// 2026-10-18(P1):统一环境门服务(公式唯一载体,构建任务门与配置生成域共用)
import { createGateService } from "./build-tool/package-core/gate";
import { createIntellisenseConfig } from "./build-tool/package-service/config/gen/intellisense-config";
import { registerInstallLayoutWatch } from "./build-tool/package-service/config/gen/install-layout-watch";
import { renderSyncReportMessage } from "./build-tool/package-service/config/gen/intellisense-report";
import { migrateLegacyStateFile, setStateStorageRoot } from "./build-tool/package-service/share/state-file";
// 接口类型走独立接口层(对齐 ros2/api 范式)
import type { IntellisenseConfig } from "./build-tool/package-service/config/gen/intellisense-api";
import { StatusBarItem } from "./ros2/consumers/monitor/status-bar";
// 2026-10-18 平铺批:walk 超时 12 键读取统一入口(自 vscode-utils 迁入,兑现 walk-options"读设置仅此处一处")
import { readWalkTimeoutConfig } from "./build-tool/walk/walk-options";

export let extPath: string;
export let outputChannel: vscode.LogOutputChannel;

/** 扩展日志薄封装(带 extension 模块前缀) */
const log = getLogger("extension");
export let extensionContext: vscode.ExtensionContext | null = null;
export let rosTestProvider: RosTestProvider | null = null;
/** 三层 package-core(composition root 产物,UI Facade 出口;见 设计/重构/package-core重新设计/DESIGN.md) */
export let packageCore: PackageCore | null = null;
/** intellisense-config(2026-08-29 迁 package-service,2026-08-30 迁 config/gen;组合根直连;模块级:try 块外 activate 尾部仍要 sync) */
export let intellisenseConfig: IntellisenseConfig | null = null;

/**
 * 读取当前 env(source 结果;未 source 时为 undefined)。环境域门面转发。
 * 取代旧 `export let env` 全局可变状态(写路径已收进 environment/state.ts)。
 */
export function getEnv(): any | undefined {
    return environmentFacade.getEnv();
}

/**
 * 环境变化事件(source 完成后触发)。环境域门面转发,保留旧 onDidChangeEnv 语义。
 */
export const onDidChangeEnv: vscode.Event<void> = environmentFacade.onEnvChanged;

/** 等 env 就绪并返回当前 env(委托环境门面;旧实现逻辑已收进 state.resolvedEnv) */
export async function resolvedEnv() {
    return environmentFacade.resolvedEnv();
}

export enum Commands {
    CreateTerminal = "ROS2.createTerminal",
    Run = "ROS2.run",
    Launch = "ROS2.launch",
    // 2026-09-24(T8/B6.3):Test = "ROS2.test" 已删除(与 Test Explorer 无关的旧马甲,详见 ros2/registry/core.ts)
    Rosdep = "ROS2.rosdep",
    // 2026-08-26:命令 ID 单一事实源移至 host/commands.ts(ShowDaemonStatusCommand),此处引用保持一致
    ShowDaemonStatus = ShowDaemonStatusCommand,
    TestsRefresh = "ROS2.tests.refresh",
    TestsRunAll = "ROS2.tests.runAll",
    // 2026-08-26:ROS2.startDaemon/ROS2.stopDaemon 已停止暴露(命令面板入口移除);状态页按钮与调试器
    // 自动启动直连 monitorApi.daemon(),不受影响
    // 2026-08-31:UpdateCppProperties 死命令已删(无注册无实现,原实现随 build-env-utils 废弃)
    PreviewURDF = "ROS2.previewUrdf",
    Doctor = "ROS2.doctor",
    // 2026-08-26:生命周期命令已停止暴露(命令面板入口移除),枚举成员一并删除
    // 2026-08-31:LaunchTree 枚举成员已删(launch-tree 废弃,UI 贡献清理见 package.json)
    ShowWelcome = "ROS2.showWelcome",
    // 2026-08-31:colcon 命令 ID 单一事实源移至 build/command-ids.ts(注册者拥有;23:10 改名批次自 build/commands.ts git mv),此处引用保持一致(对齐 host/commands.ts ShowDaemonStatusCommand 模式)
    ColconToggleIgnore = ColconToggleIgnoreCommand,
    ColconBuildPackageRelease = ColconBuildPackageReleaseCommand,
    ColconBuildPackageDebug = ColconBuildPackageDebugCommand,
    ColconBuild = ColconBuildCommand,
    CreateCppPackage = "ROS2.createCppPackage",
    CreatePythonPackage = "ROS2.createPythonPackage",
    CreateMixedPackage = "ROS2.createMixedPackage"
}

/**
 * 组合根读「扫描取数」四键(断环注入:package-core 不读 vscode 配置,创建时与设置变化重下发共用)。
 * 生效时机一致化(2026-09-28 批次 4):ROS2.search.excludeFolders / search.followSymlinks / search.walkTimeout.*(12 键,点分段前缀监听)/ packages.refreshMs。
 */
function readPackageCoreScanConfig(): PackageCoreConfig {
    const cfg = vscode_utils.getExtensionConfiguration();
    const walk = readWalkTimeoutConfig("package");
    return {
        packageCacheRefreshMs: cfg.get<number>("packages.refreshMs", 60000),
        buildExcludeFolders: cfg.get<string[]>("search.excludeFolders", []),
        followSymlinks: vscode_utils.readFollowSymlinksSetting(),
        walkTimeouts: { totalTimeoutMs: walk.totalTimeoutMs, branchTimeoutMs: walk.branchTimeoutMs, maxDepth: walk.maxDepth },
    };
}

export async function activate(context: vscode.ExtensionContext) {
    try {
        /* ════════ P2 阶段 A:壳注册段(环境检测之前;注册≠启动,零后台活动)════════ */

        // A1 基座
        extPath = context.extensionPath;
        outputChannel = vscode_utils.createOutputChannel();
        // 日志通道注入:outputChannel 就绪后交给 logger(注入式,避免 logger 依赖本模块导致纯逻辑模块无法纯 Node 测试)
        setLogChannelGetter(() => outputChannel);
        extensionContext = context; // Store the context for later use
        // 状态文件「转入地下」(2026-10-21 用户裁定):装配扩展私有存储根 + 一次性迁移旧 .vscode/ 文件
        setStateStorageRoot(context.storageUri?.fsPath);
        await migrateLegacyStateFile(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        context.subscriptions.push(outputChannel);

        // A2 工作区 context key 初推(检测中 hasRosEnvironment=false,fail-closed;检测后 activate.ts:80 会再刷)
        await environment.refreshContextKeys();

        // A3 平台 context key + 激活日志(纯 process.platform,无 env 依赖)
        const isLinuxHost = process.platform === "linux";
        const isWindowsHost = process.platform === "win32";
        const isMacHost = process.platform === "darwin";
        await Promise.all([
            vscode.commands.executeCommand("setContext", "ros2.isLinuxHost", isLinuxHost),
            vscode.commands.executeCommand("setContext", "ros2.isWindowsHost", isWindowsHost),
            vscode.commands.executeCommand("setContext", "ros2.isMacHost", isMacHost),
        ]);
        log.info("ROS 2 extension is activating...");
        log.debug(vscode.l10n.t("Platform context: linux={0}, windows={1}, mac={2}", isLinuxHost, isWindowsHost, isMacHost));

        // A4 RosApiDeps 注入(硬约束:必须先于环境检测——检测内 assemble/reconcile 调 activateCoreMonitor,
        // 后置会让首次装配拿到 no-op,状态栏静默不启动)
        environment.setRosApiDeps({
            activateCoreMonitor: () => {
                const item = new StatusBarItem();
                item.activate();
                return item;
            },
        });
        // 助手版本治理注入(2026-10-20,规范=helper/VERSION-CONTROL.md):本扩展版本
        // 进锁文件第 4 字段,客户端据此裁杀旧拉新。不注入=治理禁用(安全态)。
        setParamHelperExtensionVersion(String(context.extension?.packageJSON?.version ?? ""));

        // A5 环境监听(门铃;P2:三路传感器统一走 refreshEnvironment 全量刷新,翻转时组件自动装配/回收)
        environment.registerEnvironmentListeners(context);

        // A6 C++ 格式化 provider(不依赖 env)
        context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
            "cpp", new cpp_formatter.CppFormatter()
        ));

        // A7 语言三域注册(P2 start 化:构造/注册零后台;门开由 B 段 reconcile / 首次打开文档触发 start)
        const envGate = (): boolean => environmentFacade.getEnvIssue() === null;
        const xacroPackages = new PackageMap();
        const rosmsgDomain = registerRosMessageProviders(context, xacroPackages, envGate);
        const xacroDomain = registerXacroProviders(xacroPackages, envGate);
        const launchDomain = registerLaunchProviders(xacroPackages, envGate);
        context.subscriptions.push(
            ...rosmsgDomain.disposables,
            ...xacroDomain.disposables,
            ...launchDomain.disposables,
        );
        // 2026-09-07:ROS 2 Python/C++ 节点片段动态注入(每次补全才判定 ROS 工作区,惰性无后台)
        context.subscriptions.push(registerRosPythonCompletion());
        context.subscriptions.push(registerRosCppCompletion());

        // A8 测试域(P2 start 化:构造只建 controller,发现/订阅在显式 start)
        rosTestProvider = new RosTestProvider();
        context.subscriptions.push(rosTestProvider);

        // A9 侧边栏(P2:data getter 注入——壳先注册,packageCore 后构造;可见性=views.when,数据根门=getChildren)
        context.subscriptions.push(...registerInstallTruthSidebar(context, () => packageCore));

        // A10 命令壳(handler 调用时自查门/数据活读;await 期间被调用会排队到 activate 返回后执行)
        // 命令注册已拆分至 src/commands(registerAllCommands 统一入口)
        commands.registerAllCommands(context);
        // 2026-08-31(#4 方案 B):colcon 命令直连注入数据源(P2 getter 化)
        registerColconCommands(context, () => packageCore);
        // 2026-09-25:run/launch 命令(数据源自惰性)
        context.subscriptions.push(...registerRosRunCommands(context, createInstallTruthRunDataSource()));
        // 2026-09-01:create 命令直连(右键生成功能包;handler 活读 packageCore 可选链)
        registerCreatePackageCommands(context);
        // 注册"ROS 2 环境"终端配置文件(新建终端下拉框可选;profile 请求时才构建)
        rosTerminalProfile.registerRosTerminalProfileProvider(context);

        // 用户可调用的"重新生成"(补写缺失条目,非强行覆盖;布局按当前 .colcon_install_layout 内容)
        // 2026-10-17:域门控后 sync 可能被拦(skipped),按结果如实反馈"为什么没生成",不谎报成功
        // 2026-10-20:applied 携带逐文件明细,动态文案渲染"改了哪些部分+没改的原因"(intellisense-report),不再固定一句话
        context.subscriptions.push(vscode.commands.registerCommand("ROS2.regenerateIntellisenseConfig", async () => {
            if (!intellisenseConfig) {
                // 未装配(工作区未就绪/激活尚未走到装配段):如实告知,不谎报成功
                void vscode.window.showWarningMessage(vscode.l10n.t(
                    "ROS 2 IntelliSense configuration is not initialized yet; cannot regenerate (make sure a ROS 2 workspace is open)."));
                return;
            }
            const outcome = await intellisenseConfig.sync();
            if (outcome.outcome === "applied") {
                void vscode.window.showInformationMessage(renderSyncReportMessage(outcome.report));
            } else if (outcome.reason === "env") {
                void vscode.window.showWarningMessage(vscode.l10n.t(
                    "No usable ROS 2 environment detected; IntelliSense configuration generation skipped."));
            } else {
                void vscode.window.showWarningMessage(vscode.l10n.t(
                    "No ROS 2 packages in the workspace and empty-workspace generation is off (ROS2.env.allowEmptyWorkspace); IntelliSense configuration generation skipped."));
            }
        }));

        // A11 事件接线(先于检测注册,门开/关事件不漏;reconcileGated 在 B 段定义,闭包活绑定)
        // 环境变化(门槛)→ 任务提供器注册同步 + context key 刷新 + 门开热启动(reconcile)
        // 2026-09-04(系统/定时解耦):env 驱动 = system 事件必发(env 不可用时跳过 refreshSystem)。
        context.subscriptions.push(onDidChangeEnv(() => {
            packageCore?.buildTaskProviderGate.sync();
            // 2026-10-17:ros2.hasRosEnvironment 随 env 翻转即时刷新
            void environment.refreshContextKeys();
            if (environmentFacade.getEnvIssue() === null) {
                void packageCore?.refreshSystem();
                void reconcileGated(); // P2:门开(含恢复)热启动门内组件 + 补扫
            }
        }));
        // 空工作区倾向配置变化 → 注册判定同步(P1:键合一为 ROS2.env.allowEmptyWorkspace)
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("ROS2.env.allowEmptyWorkspace")) {
                packageCore?.buildTaskProviderGate.sync();
                void environment.refreshContextKeys();
            }
        }));
        // 扫描取数配置变化 → 5s 去抖 → packageCore.reconfigure(2026-09-28 批次 4;
        // 2026-10-18:监听键修为现行单数前缀 walkTimeout,旧复数键点分段匹配不命中)
        let scanConfigDebounceTimer: NodeJS.Timeout | undefined;
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            const affectsScan = ["ROS2.search.followSymlinks", "ROS2.search.walkTimeout", "ROS2.search.excludeFolders", "ROS2.packages.refreshMs"]
                .some((key) => e.affectsConfiguration(key));
            if (!affectsScan) {
                return;
            }
            if (scanConfigDebounceTimer) {
                clearTimeout(scanConfigDebounceTimer);
            }
            scanConfigDebounceTimer = setTimeout(() => {
                scanConfigDebounceTimer = undefined;
                log.info("Scan-related settings changed; re-dispatching package-core (exclusions/symlinks/timeouts/interval)");
                packageCore?.reconfigure(readPackageCoreScanConfig());
            }, 5000);
        }));
        // 构建信号 → 共享 build-map 中心刷新(P2/P3:门关置旗待 reconcile 补扫,不扫描)
        let pendingBuildScan = false;
        context.subscriptions.push(environmentFacade.onBuildSignal(() => {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root === undefined) {
                return;
            }
            if (environmentFacade.getEnvIssue() !== null) {
                pendingBuildScan = true; // 门关:不扫描,记待办(门开 reconcile 补一次)
                return;
            }
            void acquireSharedBuildCenter(root).center.refreshAfterBuildSignal();
        }));

        /* ════════ P2 环境检测(此前一切为壳;有环境机器典型 1-3s,无环境毫秒级快速失败)════════ */
        await environmentFacade.activateEnvironment(context);

        /* ════════ P2 阶段 B:构造 + reconcile 段(环境真相已知)════════ */

        // B1 统一门 + package-core(构造零副作用;门开才显式 start:timer/watcher/首扫)
        const gateGetters = {
            envAvailable: () => environmentFacade.getEnvIssue() === null,
            hasPackages: () => (packageCore?.getState().workspace?.length ?? 0) > 0,
            allowEmptyWorkspace: () =>
                vscode_utils.getExtensionConfiguration().get<boolean>("env.allowEmptyWorkspace", false),
        };
        const sharedGate = createGateService(gateGetters);
        packageCore = createPackageCore({
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            enableWatcher: true,
            config: readPackageCoreScanConfig(),
            buildTaskProviderGate: {
                ...gateGetters,
                registerBuildTaskProvider: () => registerBuildTaskProvider(),
            },
        });
        context.subscriptions.push({ dispose: () => packageCore?.dispose() });
        if (envGate()) {
            packageCore.start(); // 门开:驱动层通电 + 首扫;门关待 reconcile(环境事件)再启
        }
        // P2/P3:build 中心查询兜底的环境门(ensureFresh 入口;组合根注入,install-truth 零 ros2 依赖)
        setEnsureFreshGate(envGate);

        // B2 包变化(门控)→ 任务提供器注册同步 + 包 context key 反应式更新
        const syncHasPackageXmlContext = (): void => {
            const hasPackages = (packageCore?.getState().workspace?.length ?? 0) > 0;
            void vscode.commands.executeCommand("setContext", "ros2.hasPackageXml", hasPackages);
        };
        packageCore.onDidChange(() => {
            packageCore?.buildTaskProviderGate.sync();
            syncHasPackageXmlContext();
        });
        syncHasPackageXmlContext(); // 启动初始设置(首载扫描完成前为 false,完成后 onDidChange 翻转)

        // B3 intellisense-config 直连装配(数据消费者;P1:注入统一门 sharedGate)
        intellisenseConfig = createIntellisenseConfig({
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
            getState: () => packageCore!.getState(), // packageCore 已在上面赋值(同一激活流程),箭头函数闭包捕获不 narrowing,非空断言
            environment: environmentFacade,
            gate: sharedGate,
        });
        intellisenseConfig?.subscribe(packageCore.onDidChange);
        context.subscriptions.push({ dispose: () => intellisenseConfig?.dispose() });

        // B4 安装布局信号 → 配置重算(回调内 sync 自有环境门,门关零写盘)
        {
            const layoutWsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (layoutWsRoot) {
                context.subscriptions.push(registerInstallLayoutWatch({
                    workspaceRoot: layoutWsRoot,
                    logger: log,
                    pollIntervalMs: 0,
                    onLayoutSignal: (reason: string) => {
                        log.info(vscode.l10n.t("Config recompute signal: {0} -> regenerating IntelliSense configuration", reason));
                        void intellisenseConfig?.sync();
                    },
                }));
            }
        }

        // B5 reconcileGated(P2 核心):门开才执行的组件启动/补扫;onDidChangeEnv 与激活尾部共用。
        // 顺序=环境门→core.start→refreshSystem→seed→PackageMap 链→ensureInitialized→语言三域/测试 start→build 中心首扫/补扫。
        let gatedChainWired = false;
        let buildScanDone = false;
        const reconcileGated = async (): Promise<void> => {
            packageCore?.buildTaskProviderGate.sync();
            void environment.refreshContextKeys();
            if (!envGate()) {
                return; // 门关:不启动任何门内组件(reload-prompt 会建议重载;暂不=惰性兜底)
            }
            if (packageCore && !gatedChainWired) {
                gatedChainWired = true;
                // core → PackageMap 事件链(工作区/系统域变化喂入共享 PackageMap;仅启动后接线,防未初始化扫描)
                packageCore.onDidChange(ev => {
                    if (ev.workspace !== undefined) {
                        void xacroPackages.refreshWorkspace();
                    }
                    if (ev.system !== undefined) {
                        xacroPackages.acceptSystem(ev.system);
                    }
                });
            }
            if (packageCore) {
                await packageCore.refreshSystem();
                const seedSystem = packageCore.getState().system;
                if (seedSystem) {
                    xacroPackages.acceptSystem(seedSystem);
                }
            }
            await xacroPackages.ensureInitialized(); // 共享 PackageMap(幂等单飞;内部可能等 core 首扫)
            void rosmsgDomain.start();
            void xacroDomain.start();
            void launchDomain.start();
            rosTestProvider?.start();
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root !== undefined && (!buildScanDone || pendingBuildScan)) {
                buildScanDone = true;
                pendingBuildScan = false;
                void acquireSharedBuildCenter(root).center.refreshAfterBuildSignal();
            }
        };

        // B6 激活尾部 reconcile(环境门开:热启动一切门内组件;门关:仅 task provider 同步,等待环境事件)
        await reconcileGated();

        // B7 配置生成首算(内部自有环境门:门关 skipped 零写盘)
        await intellisenseConfig?.sync();

        // B8 欢迎演练(不依赖 env 结果;包探测为已知豁免)
        await onboarding.showWelcomeIfNeeded(context);

        return {
            getEnv: environment.getEnv,
            onDidChangeEnv: environment.onEnvChanged,
        };

    } catch (error) {
        log.error(vscode.l10n.t("Extension activation failed: {0}", error instanceof Error ? (error.stack ?? error.message) : String(error)));
        throw error;
    }
}


/* ════════ P2 前置说明(阶段 A/B 的依赖依据)════════
 * - setRosApiDeps 必须先于检测:检测内 reconcile 调 activateCoreMonitor,后置=首次装配拿 no-op。
 * - 命令壳/语言域/测试域注册零后台:start 化后构造即注册点,门开才显式 start。
 * - 仅两处闭包捕获需 getter(colcon 命令 data / 侧边栏 data),其余皆调用时活读(考据 2026-10-18)。
 * - onDidChangeEnv 在 A 段注册:检测期间 packageCore 为 null,回调可空跑;B 段 reconcile 显式补偿首轮。
 * ═══════════════════════════════════════════════ */




export async function deactivate() {
    environmentFacade.disposeEnvSubscriptions();

    // Clean up test provider
    if (rosTestProvider) {
        rosTestProvider.dispose();
        rosTestProvider = null;
    }

    // 2026-09-24:共享 build-map 数据中心(侧边栏与测试侧共用;含构建 watcher 接线)统一在此释放
    disposeSharedBuildCenter();
}

// 2026-08-28:ensureErrorMessageOnException 下沉至 error-utils(断 registry → extension 反向依赖),此处 re-export 兼容既有消费方
export { ensureErrorMessageOnException } from "./error-utils";
