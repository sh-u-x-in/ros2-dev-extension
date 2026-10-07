/**
 * xacro 文件级(包含)链接提供器 DocumentLink(2026-09-07 终裁语义)
 *
 * 只给 <xacro:include filename="…"> 的值加下划线:点击 = 文件级跳转(打开被包含文件,
 * 类比"头文件有下划线")。宏调用 / ${} 变量 / link-joint 一律**不下划线**——
 * 它们走精确 Definition(F12 或 Ctrl+点击均锚定名称 Range,锚点去光标化,不受历史影响,
 * 类比"内部文件变量无下划线")。
 *
 * 历史:全量下划线版(include/宏/变量/link-joint)在 2026-09-06 批次①~③后于 2026-09-07 先断电,
 * 经用户实测 F12 精确后按分层语义恢复"仅 include(文件级)"形态;被移除的分支见 git 历史留档。
 * 本提供器不解析文本:include 边(line/startColumn/endColumn/target)直接来自 IncludeGraph。
 */
import * as vscode from "vscode";
import * as path from "path";
import { IncludeGraph } from "../core/include-graph";
import type { PackageMap } from "../../shared/package-map";
import { log, isFileTarget } from "./provider-utils";

/**
 * 文件级链接提供器:仅 include filename 值 → 可点击打开目标文件
 */
export class XacroDocumentLinkProvider implements vscode.DocumentLinkProvider {
    constructor(
        private graph: IncludeGraph,
        private packages: PackageMap
    ) {}

    async provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentLink[]> {
        const links: vscode.DocumentLink[] = [];
        const info = this.graph.getFile(document.uri);
        if (!info) {
            log.debug(`DocumentLink 跳过:${path.basename(document.uri.fsPath)} — 文件不在图内`);
            return links;
        }
        log.debug(`DocumentLink(仅 include)扫描:${path.basename(document.uri.fsPath)},include ${info.includes.length} 条`);
        for (const inc of info.includes) {
            if (token.isCancellationRequested) {
                break;
            }
            if (!inc.target) {
                log.trace(`  include 无链接:${inc.raw}(target 未解析)`);
                continue;
            }
            // 仅普通文件给下划线(目录/半路径/未落盘不给,2026-09-08:点目录 VS Code 报错)
            if (!(await isFileTarget(inc.target))) {
                log.trace(`  include 无链接(目录/未落盘):${inc.raw} → ${inc.target.fsPath}`);
                continue;
            }
            const range = new vscode.Range(inc.line, inc.startColumn, inc.line, inc.endColumn);
            const link = new vscode.DocumentLink(range, inc.target);
            link.tooltip = `打开 ${inc.raw}`;
            links.push(link);
        }
        log.debug(`DocumentLink 完成:${links.length} 条 include 文件级链接(宏/变量不下划线,走精确 F12)`);
        return links;
    }
}
