/**
 * launch.py 跳转提供器(*.launch.py)
 *
 * ⚠️ 2026-09-06 曾冻结,2026-09-08 按用户澄清**解冻恢复**(冻结对象是"可执行文件跳转",
 * 非启动文件 include 跳转)。口径:文件内静态解析(简单赋值变量可代),**解析不成功静默**
 * (无链接、不弹"目标未解析")。
 *
 * 解析逻辑在 launch-py-parser(共享),这里只负责:
 *  - DocumentLink:include 表达式 + Node 系 package/executable 值(LE-1,04 号"文件级跳转优先")
 *    可点击直达目标文件(仅解析成功者;范围=值内容,不含引号);
 *  - Hover:include 悬浮显示目标路径(仅解析成功者);
 * 语法/补全/符号跳转由 Python 扩展负责,这里只做领域跳转。
 */

import * as vscode from "vscode";
import * as path from "path";
import { getLogger } from "../../../logger";
import { PackageMap } from "../../shared/package-map";
import { fileInWorkspaceDomain } from "../../shared/workspace-domain";
import { scanLaunchIncludes, scanLaunchNodeRefs } from "../parse/launch-py-parser";
import { resolveExecTargetUri, resolvePackageTargetUri } from "./launch-definition-provider";
import type { LaunchExecSource } from "./launch-completion";

const log = getLogger("launchpy-providers");

/** launch.py 点击链接提供器 */
export class LaunchPyDocumentLinkProvider implements vscode.DocumentLinkProvider {
    constructor(
        private packages: PackageMap,
        private exec?: LaunchExecSource
    ) { }

    async provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentLink[]> {
        if (!fileInWorkspaceDomain(document.uri)) {
            return []; // LA-1:域外文档不解析
        }
        const links: vscode.DocumentLink[] = [];
        const text = document.getText();
        const includes = scanLaunchIncludes(text, document.uri, this.packages);
        for (const inc of includes) {
            if (token.isCancellationRequested) {
                break;
            }
            if (inc.target) {
                const range = new vscode.Range(
                    document.positionAt(inc.start),
                    document.positionAt(inc.end)
                );
                const link = new vscode.DocumentLink(range, inc.target);
                link.tooltip = `打开 ${path.basename(inc.target.fsPath)}`;
                links.push(link);
            }
        }
        // LE-1(04 号,文件级跳转优先):Node 系 package/executable 值的直达链接
        // ——范围=值内容(不含引号);非字面量/未命中一律不链(静默口径)
        for (const ref of scanLaunchNodeRefs(text)) {
            if (token.isCancellationRequested) {
                break;
            }
            if (ref.package && ref.packageRange) {
                const uri = await resolvePackageTargetUri(this.packages, ref.package);
                if (uri) {
                    links.push(this.makeLink(ref.packageRange, uri, document));
                }
            }
            if (this.exec && ref.executable && ref.executableRange && ref.package) {
                const uri = await resolveExecTargetUri(this.exec, ref.package, ref.executable);
                if (uri) {
                    links.push(this.makeLink(ref.executableRange, uri, document));
                }
            }
        }
        return links;
    }

    private makeLink(range: [number, number], uri: vscode.Uri, document: vscode.TextDocument): vscode.DocumentLink {
        const link = new vscode.DocumentLink(
            new vscode.Range(document.positionAt(range[0]), document.positionAt(range[1])),
            uri
        );
        link.tooltip = `打开 ${path.basename(uri.fsPath)}`;
        log.trace(vscode.l10n.t("launch py link -> {0}", uri.fsPath));
        return link;
    }
}

/** launch.py 悬浮提示提供器 */
export class LaunchPyHoverProvider implements vscode.HoverProvider {
    constructor(private packages: PackageMap) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        if (!fileInWorkspaceDomain(document.uri)) {
            return undefined; // LA-1:域外文档不解析
        }
        const offset = document.offsetAt(position);
        const includes = scanLaunchIncludes(document.getText(), document.uri, this.packages);
        const inc = includes.find(e => offset >= e.start && offset <= e.end);
        if (!inc) {
            return undefined;
        }
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**launch include**\n\n\`${inc.expr}\``);
        if (inc.target) {
            md.appendMarkdown(`\n\n→ \`${inc.target.fsPath}\``);
        } else {
            return undefined; // 2026-09-08:解析不成功 → 静默(不弹"目标未解析")
        }
        const range = new vscode.Range(document.positionAt(inc.start), document.positionAt(inc.end));
        return new vscode.Hover(md, range);
    }
}
