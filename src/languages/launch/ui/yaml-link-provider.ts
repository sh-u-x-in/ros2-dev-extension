/**
 * launch.yaml 链接(DocumentLink)(2026-09-06 include 新增;LE-2 增 node 块 pkg/exec 直达)
 *
 * 依据:yaml launch 格式支持 include/node(官方样例 ros2_documentation humble
 *  Developer-Tools/Launch/launch/different_formats_launch.yaml):
 *     - include:
 *         file: "$(find-pkg-share <pkg>)/launch/x.launch.py"
 *     - node:
 *         pkg: "<pkg>"
 *         exec: "<executable>"
 *
 * 结构化检测(`- include:` / `- node:` 块下缩进的值行)→ 复用 XML 链接同一解析
 * (resolveLaunchIncludePath / resolvePackageTargetUri / resolveExecTargetUri)——声明式、低误报。
 * LE-2:范围一律值内容(不含引号);lineStarts 按原文 `\n` 累计(计入 `\r`,修 CRLF 漂移盲区);
 * 非字面量/未命中一律不链(静默口径)。
 */

import * as vscode from "vscode";
import * as path from "path";
import * as core from "../core/launch-completion-core";
import { getLogger } from "../../../logger";
import type { PackageMap } from "../../shared/package-map";
import { resolveLaunchIncludePath } from "./launch-link-provider";
import { resolveExecTargetUri, resolvePackageTargetUri } from "./launch-definition-provider";
import { fileInWorkspaceDomain } from "../../shared/workspace-domain";
import { yamlSiblingKeyValue, parseYamlScalarValue } from "../core/launch-completion-core";
import type { LaunchExecSource } from "./launch-completion";

const log = getLogger("launch-yaml-link");

/** include 动作行:`- include:`(允许尾注注释) */
const INCLUDE_DASH_RE = /^(\s*)-\s*include\s*:\s*(?:#.*)?$/;
/** node 动作行:`- node:`(LE-2;允许尾注注释) */
const NODE_DASH_RE = /^(\s*)-\s*node\s*:\s*(?:#.*)?$/;

/**
 * Provides clickable links for include / node(pkg/exec) values in YAML launch files
 */
export class LaunchYamlLinkProvider implements vscode.DocumentLinkProvider {
    /**
     * @param packages 共享 PackageMap(与 XML 链接同源);未注入时仅相对/绝对可解
     * @param exec 可执行落点解析(LE-2;缺省不提供 exec 链接)
     */
    constructor(
        private packages?: PackageMap,
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
        const lines = text.split(/\r?\n/);
        // 行起始偏移(LE-2 修复:按原文 `\n` 累计,自然计入 `\r`——split 行长累加在 CRLF 下逐行漂移 1 字符)
        const lineStarts: number[] = [0];
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 10) {
                lineStarts.push(i + 1);
            }
        }

        for (let i = 0; i < lines.length; i++) {
            if (token.isCancellationRequested) {
                return links;
            }
            const isInclude = INCLUDE_DASH_RE.test(lines[i]);
            const isNode = !isInclude && NODE_DASH_RE.test(lines[i]);
            if (!isInclude && !isNode) {
                continue;
            }
            const dashIndent = (lines[i].match(/^[ \t]*/)?.[0] ?? "").length;
            // 向后扫动作块的子行(缩进须大于动作行;直到同级/更浅或块结束)
            for (let j = i + 1; j < lines.length; j++) {
                const ln = lines[j];
                if (ln.trim() === "") {
                    continue;
                }
                const indent = (ln.match(/^[ \t]*/) || [""])[0].length;
                if (indent <= dashIndent) {
                    break; // 离开动作块
                }
                const vm = ln.match(/^(\s+)(file|pkg|exec)\s*:/);
                if (!vm) {
                    continue; // 其它子键:继续
                }
                const key = vm[2];
                if (isInclude && key !== "file") {
                    continue; // include 块只链 file
                }
                // LG-1 正确语义:值经 parseYamlScalarValue 扫描器(引号单/双+转义+裸三路完备),
                // 值原样(引号内前导/后导空格真正参与;裸值由扫描器剔首尾空格、中间空格保留)
                const colonIdx = ln.indexOf(":");
                const span = core.parseYamlScalarValue(ln, colonIdx + 1);
                if (!span || !span.value) {
                    continue;
                }
                const target = span.value;
                // 下划线恒 = 值内容(不含引号——与 xml/py 美术统一;LF-1 用户裁定)
                const range = new vscode.Range(
                    document.positionAt(lineStarts[j] + span.contentStart),
                    document.positionAt(lineStarts[j] + span.contentEnd)
                );

                if (isInclude) {
                    const resolved = await resolveLaunchIncludePath(target, document.uri, this.packages, token);
                    if (resolved) {
                        const link = new vscode.DocumentLink(range, resolved);
                        link.tooltip = `Open ${path.basename(resolved.fsPath)}`;
                        links.push(link);
                        log.debug(vscode.l10n.t("launch.yaml resolved to link: {0} -> {1}", target, resolved.fsPath));
                    }
                    break; // file 值至多一条
                }
                // LE-2:node 块 pkg/exec 直达
                if (key === "pkg") {
                    const uri = await resolvePackageTargetUri(this.packages, target);
                    if (uri) {
                        links.push(this.makeLink(range, uri));
                    }
                } else if (this.exec) {
                    const pkg = yamlSiblingKeyValue(text, lineStarts[j], "pkg");
                    if (pkg) {
                        const uri = await resolveExecTargetUri(this.exec, pkg, target);
                        if (uri) {
                            links.push(this.makeLink(range, uri));
                        }
                    }
                }
            }
        }
        return links;
    }

    private makeLink(range: vscode.Range, uri: vscode.Uri): vscode.DocumentLink {
        const link = new vscode.DocumentLink(range, uri);
        link.tooltip = `打开 ${path.basename(uri.fsPath)}`;
        return link;
    }
}

/**
 * Registers the launch file link provider for YAML launch files
 * (.launch.yaml / .launch.yml;与 XML 链接 selector 分开,纯 pattern 免语言绑定盲区)
 */
export function registerLaunchYamlLinkProvider(packages?: PackageMap, exec?: LaunchExecSource): vscode.Disposable {
    const selector: vscode.DocumentSelector = [
        { scheme: "file", pattern: "**/*.launch.yaml" },
        { scheme: "file", pattern: "**/*.launch.yml" }
    ];
    return vscode.languages.registerDocumentLinkProvider(
        selector,
        new LaunchYamlLinkProvider(packages, exec)
    );
}
