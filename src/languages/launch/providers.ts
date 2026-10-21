/**
 * launch 语言提供器统一注册
 *
 * 收拢 launch 语言层处理:
 *  - .launch.py include 跳转(DocumentLink + Hover):2026-09-08 解冻恢复(用户澄清:冻结对象是
 *    可执行文件跳转,非启动文件 include;口径=文件内静态解析、简单赋值变量可代、解析失败静默)
 *  - XML launch include 链接(DocumentLink):兼容 .launch / .launch.xml
 *  - YAML launch include 链接(DocumentLink):.launch.yaml/.launch.yml(2026-09-06 新增,yaml 格式支持 include)
 *  - 三格式(py/XML/yaml)补全:结构 + 包名值
 * 共享 PackageMap(工作区 package.xml + 环境包惰性补充)解析包定位表达式
 */

import * as vscode from "vscode";
import { getLogger } from "../../logger";
import { PackageMap } from "../shared/package-map";
import { LaunchPyDocumentLinkProvider, LaunchPyHoverProvider } from "./ui/launchpy-provider";
import { registerLaunchLinkProvider } from "./ui/launch-link-provider";
import { registerLaunchYamlLinkProvider } from "./ui/yaml-link-provider";
import { registerLaunchCompletionProviders } from "./ui/launch-completion";
import { LaunchDefinitionProvider, readYamlDefinitionEnabled } from "./ui/launch-definition-provider";
import { registerLaunchDiagnostics } from "./ui/launch-diagnostic-provider";
import { LaunchHoverProvider } from "./ui/launch-hover-provider";
import { InstallTruthExecSource } from "./ui/launch-completion";

const log = getLogger("launch-providers");

/**
 * 注册 launch 语言提供器
 * @param packages 可选共享 PackageMap(09:与 xacro 复用同一实例,消除重复扫描);不传则自建
 * @param enabled 环境门谓词(P2 start 化:门关时 start() 空转;门开由编排层显式 start 补建)
 * @returns disposables + start()(幂等;编排层在门开后调用;门关时空转)
 */
export function registerLaunchProviders(
    packages?: PackageMap,
    enabled?: () => boolean
): { disposables: vscode.Disposable[]; start(): Promise<void> } {
    const pkg = packages ?? new PackageMap();
    const execSource = new InstallTruthExecSource(pkg); // LA-2/LA-3:补全与跳转共用;LJ-5:注入 packages 供系统包 CLI 兜底

    // P2 start 化:构造/注册零后台活动(旧实现在此立即两次 pkg.initialize)。
    // start = 共享 PackageMap 初始化(幂等单飞,与 xacro/rosmsg 共享)→ 诊断全量重算。
    // 门关(enabled()=false)空转返回;入口=编排层 reconcile + 首次打开 launch 文件。
    let startPromise: Promise<void> | undefined;
    const isStarted = (): boolean => startPromise !== undefined;
    const start = (): Promise<void> => {
        if (startPromise) {
            return startPromise;
        }
        if (enabled && !enabled()) {
            return Promise.resolve(); // 门关:不启动,下次入口(reconcile/打开文件)再判
        }
        startPromise = pkg.ensureInitialized().then(() => launchDiagnostics.reanalyzeAll());
        return startPromise;
    };

    // LH(2026-10-01):launch 语义诊断(下波浪线)——名单/构建就绪与刷新事件触发重算
    const launchDiagnostics = registerLaunchDiagnostics(pkg, execSource, isStarted);
    let diagReanalyzeTimer: NodeJS.Timeout | undefined;
    const scheduleDiagReanalyze = (): void => {
        if (!isStarted()) {
            return; // P2:未启动不重算
        }
        if (diagReanalyzeTimer) {
            clearTimeout(diagReanalyzeTimer);
        }
        diagReanalyzeTimer = setTimeout(() => launchDiagnostics.reanalyzeAll(), 1000);
    };
    pkg.onSystemListChanged(scheduleDiagReanalyze);
    pkg.onPackageAtom(scheduleDiagReanalyze);

    // 打开 launch 文件即触发惰性启动(门开时;与编排层 reconcile 双入口)
    const openDocListener = vscode.workspace.onDidOpenTextDocument((doc) => {
        if (/\.launch(\.(py|xml|yaml|yml))?$/i.test(doc.uri.fsPath)) {
            void start();
        }
    });

    // .launch.py include 跳转(2026-09-08 解冻恢复;文件内静态解析,解析失败静默 → 不给假链接)
    const pySelector: vscode.DocumentSelector = [
        { scheme: "file", pattern: "**/*.launch.py" }
    ];
    const pyDocumentLink = vscode.languages.registerDocumentLinkProvider(
        pySelector,
        new LaunchPyDocumentLinkProvider(pkg, execSource)
    );
    const pyHover = vscode.languages.registerHoverProvider(
        pySelector,
        new LaunchPyHoverProvider(pkg)
    );
    const pyDefinition = vscode.languages.registerDefinitionProvider(
        pySelector,
        new LaunchDefinitionProvider(pkg, execSource)
    );

    // XML launch include 链接(兼容老项目;2026-09-03 05 task3:复用共享 PackageMap,替代逐 include spawn ros2 CLI)
    const xmlLink = registerLaunchLinkProvider(pkg, execSource);

    // YAML launch include 链接(2026-09-06:yaml 格式支持 include,结构化低误报;解析与 XML 共用 resolveLaunchIncludePath)
    const yamlLink = registerLaunchYamlLinkProvider(pkg, execSource);

    // 三格式补全(py/XML/yaml;2026-09-05:结构 + 包名值,见 launch-completion.ts)
    const completion = registerLaunchCompletionProviders(pkg);

    // XML launch 解析跳转(LA-3:node pkg/exec + include file 的 F12)
    const xmlDefinition = vscode.languages.registerDefinitionProvider(
        [
            { scheme: "file", pattern: "**/*.launch" },
            { scheme: "file", pattern: "**/*.launch.xml" }
        ],
        new LaunchDefinitionProvider(pkg, execSource)
    );

    // YAML launch 解析跳转(LD-3:pkg:/exec:/file: 三值位 F12;落点与 XML 同一函数)
    // LG-2(用户裁定):ROS2.tool.launch.yamlDefinitionEnabled=false → 跳过 yaml 定义注册
    // (规避字符串引号下方的定义指示线;重启生效,仅影响 yaml;链接/悬浮/补全不受影响)
    const yamlDefinitionEnabled = readYamlDefinitionEnabled();
    const yamlDefinition = yamlDefinitionEnabled
        ? vscode.languages.registerDefinitionProvider(
            [
                { scheme: "file", pattern: "**/*.launch.yaml" },
                { scheme: "file", pattern: "**/*.launch.yml" }
            ],
            new LaunchDefinitionProvider(pkg, execSource)
        )
        : undefined;

    // 三格式悬浮(LD-5:pkg/exec/include/$(var) 参数/kwarg·attr·键;py include 悬浮仍在 launchpy-provider)
    const launchHover = vscode.languages.registerHoverProvider(
        [
            ...pySelector,
            { scheme: "file", pattern: "**/*.launch" },
            { scheme: "file", pattern: "**/*.launch.xml" },
            { scheme: "file", pattern: "**/*.launch.yaml" },
            { scheme: "file", pattern: "**/*.launch.yml" }
        ],
        new LaunchHoverProvider(pkg, execSource)
    );

    log.info(`launch 语言提供器已注册:launch.py/XML/YAML include 跳转 + py/XML/yaml 补全 + py/XML/yaml 解析跳转 + 三格式悬浮(LA-3/LD-3/LD-5)${yamlDefinitionEnabled ? "" : vscode.l10n.t("; yaml definition registration disabled by setting (LG-2, effective after reload)")}`);
    return {
        disposables: [pyDocumentLink, pyHover, pyDefinition, xmlLink, yamlLink, xmlDefinition, yamlDefinition, launchHover, openDocListener, ...launchDiagnostics.disposables, ...completion].filter((d): d is vscode.Disposable => d !== undefined),
        start,
    };
}
