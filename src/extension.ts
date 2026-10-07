// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file extension.ts
 * 扩展主入口:状态与生命周期骨架。
 * 公共状态(outputChannel / onDidChangeEnv / resolvedEnv / getEnv / Commands 枚举)
 * 在此导出供各模块复用;env 等环境状态已收进 environment/ 门面,activate 只做初始化与模块组装。
 * 已拆分模块:
 *  - src/environment/  环境判定 / source / 激活
 *  - src/commands/     按领域命令注册
 *  - src/listeners.ts  工作区 / 配置 / package.xml 监听
 *  - src/onboarding.ts 欢迎演练
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
// 2026-09-04:config 除 gen 外断电——exe-map/write(01 一键配置/02 重命名)接线移除,命令不注册(详见 package-service/README)
// 2026-08-28:build-env-utils 已废弃注释(配置生成迁 package-core/data/config-gen)

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
import { acquireSharedBuildCenter, disposeSharedBuildCenter } from "./install-truth/center/shared-center";
// 2026-08-28:launch-tree 已废弃注释(用户确认废弃模块,接线移除)

import * as environment from "./ros2/environment";
import { environmentFacade } from "./ros2/environment";
import { ShowDaemonStatusCommand } from "./ros2/host/commands";
import * as rosTerminalProfile from "./ros2/consumers/terminal/terminal-profile";
import * as onboarding from "./onboarding";
import * as commands from "./commands";
import { createPackageCore, PackageCore, PackageCoreConfig } from "./build-tool/package-core/compose";
// 2026-09-04:config 除 gen 外断电——exe-map(可执行映射)接线移除,代码留档不参与编译(tsconfig exclude)
import { createIntellisenseConfig } from "./build-tool/package-service/config/gen/intellisense-config";
import { registerInstallLayoutWatch } from "./build-tool/package-service/config/gen/install-layout-watch";
// 接口类型走独立接口层(对齐 ros2/api 范式)
import type { IntellisenseConfig } from "./build-tool/package-service/config/gen/intellisense-api";
import { StatusBarItem } from "./ros2/consumers/monitor/status-bar";

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
 * 生效时机一致化(2026-09-28 批次 4):ROS2.search.excludeFolders / search.followSymlinks / search.walkTimeouts / packages.refreshMs。
 */
function readPackageCoreScanConfig(): PackageCoreConfig {
    const cfg = vscode_utils.getExtensionConfiguration();
    const walk = vscode_utils.readWalkTimeoutConfig("package");
    return {
        packageCacheRefreshMs: cfg.get<number>("packages.refreshMs", 60000),
        buildExcludeFolders: cfg.get<string[]>("search.excludeFolders", []),
        followSymlinks: vscode_utils.readFollowSymlinksSetting(),
        walkTimeouts: { totalTimeoutMs: walk.totalTimeoutMs, branchTimeoutMs: walk.branchTimeoutMs, maxDepth: walk.maxDepth },
    };
}

export async function activate(context: vscode.ExtensionContext) {
    try {
        extPath = context.extensionPath;
        outputChannel = vscode_utils.createOutputChannel();
        // 日志通道注入:outputChannel 就绪后交给 logger(注入式,避免 logger 依赖本模块导致纯逻辑模块无法纯 Node 测试)
        setLogChannelGetter(() => outputChannel);
        extensionContext = context; // Store the context for later use
        context.subscriptions.push(outputChannel);

        // Set workspace context keys used by view visibility.
        await environment.refreshContextKeys();

        // 2026-08-28(阶段 3):旧壳 10s 后台刷新停用(防与 package-core 双扫共享缓存),
        // 由 package-core 驱动层(60s timer + fs 监听)接管;setPackagesChangedListener 随旧壳退役,
        // 包变化信号切换为 packageCore.onDidChange(见下方上层编排者)。

        // package-core 组装(composition root;见 设计/重构/package-core重新设计/DESIGN.md)。
        // 2026-08-28(阶段 3):驱动层通电(60s timer + fs 监听);gate/configGen 注入接线。
        packageCore = createPackageCore({
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            enableWatcher: true,
            // 断环注入(2026-08-29):组装根不再经 vscode-utils 读配置,由组合根读设置后传入
            // 2026-09-28:周期不再硬编码——ROS2.packages.refreshMs 生效(生效时机一致化批次 4)
            config: readPackageCoreScanConfig(),
            // 门控编排(自 ros2/ 移入 package-core/gate):门槛经环境域,门控经本中心快照,
            // 倾向经配置,注册动作经 package-service/build
            buildTaskProviderGate: {
                envAvailable: () => environmentFacade.getEnvIssue() === null,
                hasPackages: () => (packageCore?.getState().workspace?.length ?? 0) > 0,
                allowEmptyWorkspace: () =>
                    vscode_utils.getExtensionConfiguration().get<boolean>("build.allowEmptyWorkspace", true),
                registerBuildTaskProvider: () => registerBuildTaskProvider(),
            },
        });
        context.subscriptions.push({ dispose: () => packageCore?.dispose() });

        // ── 2026-09-04:config 除 gen 外断电——可执行映射(exe-map)接线整体移除,不实例化、不刷新(代码留档,tsconfig exclude)──

        // ── 上层编排者(2026-08-28,门控编排自 ros2/ 移出后的接线点)──
        // 包变化(门控)→ 任务提供器注册同步 + 包 context key 反应式更新
        // (2026-08-31:ros2.hasPackageXml 不再由 ros2/environment status.ts 查询式设置——包判定归 package-core,
        //  UI 状态走事件驱动:首载/刷新完成 → onDidChange → setContext,VS Code 自动重估 when 条件)
        const syncHasPackageXmlContext = (): void => {
            const hasPackages = (packageCore?.getState().workspace?.length ?? 0) > 0;
            void vscode.commands.executeCommand("setContext", "ros2.hasPackageXml", hasPackages);
        };
        packageCore.onDidChange(() => {
            packageCore?.buildTaskProviderGate.sync();
            syncHasPackageXmlContext();
        });
        syncHasPackageXmlContext(); // 启动初始设置(首载扫描完成前为 false,完成后 onDidChange 翻转)

        // ── intellisense-config 直连装配(2026-08-29 自 package-core 迁出,2026-08-30 迁 package-service/config/gen)──
        // 数据消费者:读本中心快照 + 注入系统 include;系统 include 经 ros2/ 环境 env 注入
        intellisenseConfig = createIntellisenseConfig({
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
            getState: () => packageCore!.getState(), // packageCore 已在上面赋值(同一激活流程),箭头函数闭包捕获不 narrowing,非空断言
            // 2026-09-02:注入整个环境域门面(environmentFacade 结构化兼容 IntellisenseEnvSource),
            // 裁切(前缀拼接/PYTHONPATH 提取/增量更新)全部在 intellisense-config 模块内自包含,组合根零裁切
            environment: environmentFacade,
        });
        intellisenseConfig?.subscribe(packageCore.onDidChange);
        context.subscriptions.push({ dispose: () => intellisenseConfig?.dispose() });

        // 安装布局信号 → 配置重算(实现收在 gen/install-layout-watch.ts;组合根只组装,2026-09-16)
        {
            const layoutWsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (layoutWsRoot) {
                context.subscriptions.push(registerInstallLayoutWatch({
                    workspaceRoot: layoutWsRoot,
                    logger: log,
                    pollIntervalMs: 0, // 2026-09-16 验证期:先禁用 60s 内容比对兜底(方案 2 后只留 watcher 通道);验证完成后删本行即恢复默认
                    onLayoutSignal: (reason: string) => {
                        log.info(vscode.l10n.t("Config recompute signal: {0} -> regenerating IntelliSense configuration", reason));
                        void intellisenseConfig?.sync();
                    },
                }));
            }
        }

        // 用户可调用的"重新生成"(补写缺失条目,非强行覆盖;布局按当前 .colcon_install_layout 内容)
        context.subscriptions.push(vscode.commands.registerCommand("ROS2.regenerateIntellisenseConfig", async () => {
            if (!intellisenseConfig) {
                // 未装配(工作区未就绪/激活尚未走到装配段):如实告知,不谎报成功
                void vscode.window.showWarningMessage(vscode.l10n.t(
                    "ROS 2 IntelliSense configuration is not initialized yet; cannot regenerate (make sure a ROS 2 workspace is open)."));
                return;
            }
            await intellisenseConfig.sync();
            void vscode.window.showInformationMessage(vscode.l10n.t(
                "ROS 2 IntelliSense configuration regenerated: missing entries have been filled into c_cpp_properties.json / .clangd / settings.json (python)."
            ));
        }));
        // 环境变化(门槛)→ 注册判定同步(有环境才可能注册)
        // 2026-09-04(系统/定时解耦):环境变化同时触发 package-core 系统包列表刷新——
        // system 域只随底层 ros2/ env 变化刷新(refreshSystem),60s 定时器不再调用 pkg list;
        // 2026-09-13(手稿 §10 对齐):env 驱动 = system 事件必发——列表未变也回推(见 api 注释);
        // env 不可用时跳过(避免无意义执行:失败只会保持旧值 + 刷错误日志)。
        onDidChangeEnv(() => {
            packageCore?.buildTaskProviderGate.sync();
            if (environmentFacade.getEnvIssue() === null) {
                void packageCore?.refreshSystem();
            }
        });
        // 空构建倾向配置变化 → 注册判定同步(原 register.ts allowEmptyWorkspace 监听,移入上层编排)
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("ROS2.build.allowEmptyWorkspace")) {
                packageCore?.buildTaskProviderGate.sync();
            }
        }));
        // 扫描取数配置变化(search.followSymlinks / search.walkTimeouts / search.excludeFolders / packages.refreshMs)
        // → 5s 去抖 → packageCore.reconfigure 重下发(生效时机一致化,2026-09-28 批次 4;
        // 注入值对象、断环不变;cache.updateConfig 键未变不标脏,驱动层定时器按新周期重设)
        let scanConfigDebounceTimer: NodeJS.Timeout | undefined;
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            const affectsScan = ["ROS2.search.followSymlinks", "ROS2.search.walkTimeouts", "ROS2.search.excludeFolders", "ROS2.packages.refreshMs"]
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

        // Set explicit platform context keys for walkthrough visibility.
        const isLinuxHost = process.platform === "linux";
        const isWindowsHost = process.platform === "win32";
        const isMacHost = process.platform === "darwin";
        await Promise.all([
            vscode.commands.executeCommand("setContext", "ros2.isLinuxHost", isLinuxHost),
            vscode.commands.executeCommand("setContext", "ros2.isWindowsHost", isWindowsHost),
            vscode.commands.executeCommand("setContext", "ros2.isMacHost", isMacHost),
        ]);

        // Log extension activation
        log.info("ROS 2 extension is activating...");
        log.debug(vscode.l10n.t("Platform context: linux={0}, windows={1}, mac={2}", isLinuxHost, isWindowsHost, isMacHost));

    } catch (error) {
        log.error(vscode.l10n.t("Extension activation failed: {0}", error instanceof Error ? (error.stack ?? error.message) : String(error)));
        throw error;
    }

    // Keep workspace visibility context updated.
    // (2026-09-28 批次 4:listeners.ts 已整体退役删除——其数据层监听 2026-08-28 即移交 package-core 驱动层)
    // 系统层 shell 配置监听(P3-3)与全部环境监听(overlay/工作区文件夹/配置变化):环境域内部统一注册
    environment.registerEnvironmentListeners(context);

    // Activate components which don't require the ROS env.
    context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
        "cpp", new cpp_formatter.CppFormatter()
    ));

    // 共享 PackageMap 实例(语言域共用:xacro 持有 / launch 复用 / rosmsg 定义查找复用;
    // 事件驱动刷新见下方两大方向,06 §0.3)
    const xacroPackages = new PackageMap();

    // Register ROS message language providers (Definition and Hover)
    context.subscriptions.push(...registerRosMessageProviders(context, xacroPackages));

    // Register xacro structure providers (go-to-definition)
    context.subscriptions.push(...registerXacroProviders(xacroPackages));

    // 事件链(2026-09-04 定稿,ros2 → core → PackageMap → rosmsg):
    // ① 方向①(系统包名单):env 变化 → core.refreshSystem()(:195,独立入口只刷 system 域;列表未变也必发)
    //    → core 发 ev.system(环境回推) → 此处喂入共享 PackageMap(acceptSystem,名单 = core.system 域,不再自调 pkg list)
    //    → PackageMap fire onSystemListChanged(含未变回推) → rosmsg 重建系统消息索引;
    // ② 方向②(工作区包表):core.onDidChange ev.workspace → refreshWorkspace(2026-09-03 G2/X-F1 修复)。
    packageCore.onDidChange(ev => {
        if (ev.workspace !== undefined) {
            void xacroPackages.refreshWorkspace();
        }
        if (ev.system !== undefined) {
            xacroPackages.acceptSystem(ev.system);
        }
    });
    // 种子:若 core.system 域已就绪(如激活前已 source 过),立即喂入,避免等下一次环境事件
    const seedSystem = packageCore.getState().system;
    if (seedSystem) {
        xacroPackages.acceptSystem(seedSystem);
    }

    // Register launch language providers (launch.py include + XML link)
    context.subscriptions.push(...registerLaunchProviders(xacroPackages));

    // 2026-09-07:ROS 2 Python 节点片段动态注入(替代退役的静态 snippets/python.json;排除 *.launch.py;ROS 工作区门槛)
    context.subscriptions.push(registerRosPythonCompletion());
    // 2026-09-07:ROS 2 C++ 节点片段动态注入(替代退役的静态 snippets/cpp.json;ROS 工作区门槛)
    context.subscriptions.push(registerRosCppCompletion());

    // Initialize ROS 2 test provider (once during extension activation, not on environment changes)
    rosTestProvider = new RosTestProvider();
    context.subscriptions.push(rosTestProvider);

    // 2026-09-21:侧边栏(install-truth 三区 lib/import/share/include;简易版 —— 展开时惰性刷新 + 一个刷新命令)
    // 2026-09-25(第五批):注入 packageCore 数据源 —— 包节点右键"构建此包"复用 build 域单包构建
    context.subscriptions.push(...registerInstallTruthSidebar(context, packageCore));

    // 2026-09-30:构建事件化(手工重设计/13)—— 环境域专供信号 → 数据中心主动刷新。
    // 幂等由 center 保证(单飞+合并);已就绪走 rc-mtime 增量门(单包构建只重扫 1 包,实测 ≈69ms/包)。
    // 激活后台首扫:有工作区即触发一次(未就绪 → 全量首扫,真实规模 ≈1s 后台无感;
    // 与"首个取用方查询兜底"双路 —— 超大工作区首扫期间查询端 ensureFresh 照常可用)。
    context.subscriptions.push(environmentFacade.onBuildSignal(() => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root !== undefined) {
            void acquireSharedBuildCenter(root).center.refreshAfterBuildSignal();
        }
    }));
    {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root !== undefined) {
            void acquireSharedBuildCenter(root).center.refreshAfterBuildSignal();
        }
    }

    // 2026-08-28:Launch Tree Provider 已废弃注释(launch-tree 废弃模块),注册移除。

    // 命令注册已拆分至 src/commands(registerAllCommands 统一入口)
    commands.registerAllCommands(context);

    // 2026-08-31(#4 方案 B):colcon 命令直连注入数据源(packageCore 实例 activate 上方已创建;不再经 commands 转发/反取全局)
    registerColconCommands(context, packageCore);

    // 2026-09-25:run/launch 命令(ROS2.run / ROS2.launch,注册者自 registry/core 换为 run 域;
    // 数据源 = install-truth 共享数据中心,与侧边栏/测试侧同实例)
    context.subscriptions.push(...registerRosRunCommands(context, createInstallTruthRunDataSource()));

    // 2026-09-01:create 命令直连(右键生成功能包,经 create/index.ts 出口;不再经 commands/index.ts 转发)
    registerCreatePackageCommands(context);

    // 2026-09-04:config 除 gen 外断电——01 一键配置命令(ROS2.configureFile)不再注册(package.json 贡献同步移除)

    // 注册"ROS 2 环境"终端配置文件(新建终端下拉框可选,复用 getEnv() 注入环境)
    rosTerminalProfile.registerRosTerminalProfileProvider(context);

    // 2026-08-31:setActivationDeps(isROSBuildTask)注入已移除——onDidEndTask 链废弃,
    // overlay 刷新与 compile_commands 合并均由 install/** watcher 驱动(见 ros2/environment/README.md)

    // RosApiDeps 注入:environment 通过接口使用状态栏监控能力,不静态依赖实现
    environment.setRosApiDeps({
        activateCoreMonitor: () => {
            const item = new StatusBarItem();
            item.activate();
            return item;
        },
    });

    // Activate the workspace environment if possible.
    await environmentFacade.activateEnvironment(context);

    // 启动后:门控编排执行一次(门槛 && (门户 || 倾向)→ 注册/注销任务提供器)+ 配置生成(0→1)
    packageCore?.buildTaskProviderGate.sync();
    await intellisenseConfig?.sync();

    // Show welcome walkthrough on first install or if ROS is not detected
    await onboarding.showWelcomeIfNeeded(context);

    return {
        getEnv: environment.getEnv,
        onDidChangeEnv: environment.onEnvChanged,
    };
}







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



/**
 * 加载 ROS 与工作区环境。已拆分至 src/environment/source.ts(environmentSource.sourceRosAndWorkspace)。
 */

