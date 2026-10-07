/**
 * xacro 语言提供器装配(09 定稿:PackageMap → IncludeGraph → build 三阶段 → watcher → Providers)
 *
 * 2026-09-07 拆分:本文件(ui/)只保留 registerXacroProviders 装配与对外再导出;
 * 提供器实现分别入 definition-provider / document-link-provider(已断电留档)/ hover-provider,
 * 共享工具入 provider-utils(查询日志、${} 解析、定义锚点等)。
 * 目录:core(include-graph/watcher) / parse(context-locator) / data(urdf-docs) / ui(本层)。
 * 对外唯一出口 = 模块根 index.ts。
 *
 * 交互(2026-09-07 分层终裁):
 *  - Definition(F12/Ctrl+点击):include / 宏调用 / ${} 变量 / link-joint → 精确跳转
 *    (命中名称字符串 Range → VS Code 全选,cpp 式;锚点去光标化,不受历史影响)
 *  - Hover:宏签名 / 变量值 / include 目标悬浮提示 / 元素·关节类型文档
 *  - DocumentLink:仅 include(文件级/包含跳转,点开被包含文件);宏/变量不下划线。
 */
import * as vscode from "vscode";
import { IncludeGraph } from "../core/include-graph";
import { PackageMap } from "../../shared/package-map";
import { XacroWatcher } from "../core/xacro-watcher";
import { UrdfXacroCompletionProvider } from "./completion-provider";
import { registerXacroDiagnostics } from "./diagnostic-provider";
import { XacroDefinitionProvider } from "./definition-provider";
import { XacroDocumentLinkProvider } from "./document-link-provider";
import { XacroHoverProvider } from "./hover-provider";
import { log } from "./provider-utils";

export { XacroDefinitionProvider } from "./definition-provider";
export { XacroDocumentLinkProvider } from "./document-link-provider";
export { XacroHoverProvider, extractLeadingComment } from "./hover-provider";
export { queryAt, logMissReason, logVarMiss, dollarVarAt, resolveDollarRef } from "./provider-utils";

/**
 * 注册 xacro 语言提供器(09 装配:PackageMap → IncludeGraph → build 三阶段 → watcher → Providers)
 * @param packages 可选共享 PackageMap(09:launch 复用同一实例);不传则自建
 */
export function registerXacroProviders(packages?: PackageMap): vscode.Disposable[] {
    // ① 共享 PackageMap(工作区 package.xml + 系统包列表先行,位置懒获取)
    const pkg = packages ?? new PackageMap();
    // ② IncludeGraph(展开图核心)
    const graph = new IncludeGraph(pkg);
    // ③ 动态维护 watcher(监听 + rename + 事件驱动 + 轮巡),尽早建立避免 build 期间改动丢失
    const watcher = new XacroWatcher(graph, pkg);
    watcher.start();
    // ④ 启动预热 build(三阶段:静态骨架 → ${} 迭代收敛 → 图外兜底;异步不阻塞 activate)
    void pkg.initialize().then(() => {
        void graph.build([]);
    });

    // 用 pattern 精确限定 .xacro/.urdf,不干扰其它 xml 文件
    const selector: vscode.DocumentSelector = [
        { scheme: "file", pattern: "**/*.xacro" },
        { scheme: "file", pattern: "**/*.urdf" }
    ];

    // 2026-09-07 分层终裁:include → 文件级链接(下划线,点开文件);
    // 宏/变量/link-joint → 精确跳转(F12/Ctrl+点击均走 Definition,无下划线)。
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        selector,
        new XacroDefinitionProvider(graph, pkg)
    );
    const documentLinkProvider = vscode.languages.registerDocumentLinkProvider(
        selector,
        new XacroDocumentLinkProvider(graph, pkg)
    );
    const hoverProvider = vscode.languages.registerHoverProvider(
        selector,
        new XacroHoverProvider(graph)
    );

    // URDF/xacro 结构补全 + ${} 动态补全(04)+ $(...) 替换补全(方向2)+ include filename 单层路径(⑥)
    // 触发字符:"<" 让敲标签开括号即唤起本提供器(tagStart 静态片段自动入表,2026-09-08);
    //          "{" 让 "${" 一敲完(变量名槽位形成)即弹 ${} 变量/形参表(不用 "$":敲 "$" 时名字位
    //          未出现、且误弹 "$(find pkg)");
    //          "(" 让 "$(" 后即弹 $(...) 替换候选(find/find-pkg-share/arg,2026-09-08 方向2);
    //          "/" 与 "\" 是兄弟触发(2026-09-09 用户:Windows 用户敲 "\" 也应自动弹):include
    //          filename 里路径层进时(如 "$(find iii)/"、相对 "sensors/")自动续弹该层候选
    //          (门控:仅 xacro:include filename 值内,其余位置一律不提供)。
    //          均为窄用途 trigger,非命中上下文在提供器内返回空(见 trigger 门控);
    //          词字符走 VS Code quick suggestions。
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        selector,
        new UrdfXacroCompletionProvider(graph, pkg),
        "<",
        "{",
        "(",
        "/",
        "\\"
    );

    // 诊断(D1-D7,08)
    const diagnostics = registerXacroDiagnostics(graph, pkg);

    log.info("xacro 语言提供器已注册:精确跳转(F12/Ctrl+点击)+ include 文件级链接 + 悬浮 + 补全 + 诊断(D1-D14)");
    return [
        definitionProvider,
        documentLinkProvider,
        hoverProvider,
        completionProvider,
        diagnostics,
        { dispose: () => watcher.dispose() }
    ];
}
