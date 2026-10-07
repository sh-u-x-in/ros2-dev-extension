// Licensed under the MIT License.

import { getLogger } from "../../../logger";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { PackageMap } from "../../shared/package-map";
import { fileInWorkspaceDomain } from "../../shared/workspace-domain";
import { parseXml, forEachElement, decodeXmlEntities, type ElementInfo } from "../../shared/xml-utils";
import { resolveExecTargetUri, resolvePackageTargetUri } from "./launch-definition-provider";
import type { LaunchExecSource } from "./launch-completion";

/** 扩展日志薄封装(带 launch-link 模块前缀) */
const log = getLogger("launch-link");

/**
 * Provides clickable links for include statements in XML launch files
 */
export class LaunchLinkProvider implements vscode.DocumentLinkProvider {
    /**
     * @param packages 共享 PackageMap(2026-09-03 05 task3 落地:系统包目录经 resolvePackageDir 懒取;
     *   package:// / 相对 / 绝对经 resolveFileRef;未注入时仅解析相对/绝对,find-pkg-share 跳过)
     * @param exec 可执行落点解析(LE-2:node exec= 值的文件级直达链接;缺省不提供 exec 链接)
     */
    constructor(
        private packages?: PackageMap,
        private exec?: LaunchExecSource
    ) { }

    /**
     * Regular expression to match include file attributes in XML launch files
     * Matches patterns like: <include file="$(find-pkg-share package)/launch/file.launch.xml"/> or
     * <include ns="my_namespace" file="$(find-pkg-share package)/launch/file.launch.xml"/>
     * Handles attributes in any order
     */
    private readonly includeRegex = /<include\b[^>]*\bfile="([^"]+)"[^>]*\/?>/g;

    async provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentLink[]> {
        if (!fileInWorkspaceDomain(document.uri)) {
            return []; // LA-1:域外文档不解析
        }
        const links: vscode.DocumentLink[] = [];
        const text = document.getText();
        log.trace(vscode.l10n.t("Resolving launch file links: {0}", document.uri.fsPath));

        // Reset regex state
        this.includeRegex.lastIndex = 0;

        // 循环:逐个匹配 include 标签并解析
        let match: RegExpExecArray | null;
        while ((match = this.includeRegex.exec(text)) !== null) {
            // Check for cancellation before processing each match
            if (token.isCancellationRequested) {
                return links;
            }

            const fullMatch = match[0];
            const filePath = match[1];
            const matchIndex = match.index;

            // Find the position of the file path within the match (after file=")
            const fileAttrStart = fullMatch.indexOf('file="') + 'file="'.length;
            // LG-3:多行属性值按行分段(剔首尾空白,空白行/行首缩进不入线)——
            // 单一连续 Range 会把换行与缩进画进下划线(用户截图 18-19 行)
            for (const [segStart, segEnd] of valueSegmentRanges(text, matchIndex + fileAttrStart, filePath)) {
                if (token.isCancellationRequested) {
                    return links;
                }
                const range = new vscode.Range(
                    document.positionAt(segStart),
                    document.positionAt(segEnd)
                );

                // Try to resolve the file path(LF-2:实体解码)
                const resolvedPath = await resolveLaunchIncludePath(decodeXmlEntities(filePath), document.uri, this.packages, token);

                if (resolvedPath) {
                    const link = new vscode.DocumentLink(range, resolvedPath);
                    link.tooltip = `Open ${path.basename(resolvedPath.fsPath)}`;
                    links.push(link);
                    log.debug(vscode.l10n.t("Resolved to link: {0} -> {1}", filePath, resolvedPath.fsPath));
                }
            }
        }

        // LE-2(04 号,文件级跳转优先):<node pkg=/exec=> 值的直达链接
        // ——lezer 解析(属性序无关,注释内不产生 Element),范围=值内容(valueFrom..valueTo,不含引号);
        //    非字面量/未命中一律不链(静默口径)
        for (const info of xmlNodeInfos(text)) {
            if (token.isCancellationRequested) {
                return links;
            }
            const pkgAttr = info.attrs.find(a => a.name === "pkg");
            const execAttr = info.attrs.find(a => a.name === "exec");
            const pkg = pkgAttr?.value === undefined ? undefined : decodeXmlEntities(pkgAttr.value);
            const exec = execAttr?.value === undefined ? undefined : decodeXmlEntities(execAttr.value);
            if (pkg && pkgAttr.valueFrom >= 0) {
                const uri = await resolvePackageTargetUri(this.packages, pkg);
                if (uri) {
                    for (const [s, e] of valueSegmentRanges(text, pkgAttr.valueFrom, pkgAttr.value)) {
                        links.push(this.makeLink(document, s, e, uri));
                    }
                }
            }
            if (this.exec && exec && pkg && execAttr.valueFrom >= 0) {
                const uri = await resolveExecTargetUri(this.exec, pkg, exec);
                if (uri) {
                    for (const [s, e] of valueSegmentRanges(text, execAttr.valueFrom, execAttr.value)) {
                        links.push(this.makeLink(document, s, e, uri));
                    }
                }
            }
        }

        return links;
    }

    private makeLink(document: vscode.TextDocument, from: number, to: number, uri: vscode.Uri): vscode.DocumentLink {
        const link = new vscode.DocumentLink(
            new vscode.Range(document.positionAt(from), document.positionAt(to)),
            uri
        );
        link.tooltip = `打开 ${path.basename(uri.fsPath)}`;
        return link;
    }
}

/** 文本中全部 <node> 元素(lezer 恢复式解析,畸形文档返回空;注释内不产生 Element) */
function xmlNodeInfos(text: string): ElementInfo[] {
    const out: ElementInfo[] = [];
    try {
        forEachElement(parseXml(text).topNode, text, (_elem, info) => {
            if (info.tag === "node") {
                out.push(info);
            }
        });
    } catch {
        // 恢复式解析不抛错,此 catch 仅防御
    }
    return out;
}

/**
 * LG-3(2026-10-01,用户截图:多行 include 属性值下划线包含换行与缩进空白):
 * 把 value(起于 valueAbs、长 value.length)按 `\n` 分行,每行剔首尾空白、空白行跳过,
 * 返回非空片段的 [start, end) 区间表——供按段生成多条同目标 DocumentLink(空白不入线)。
 */
function valueSegmentRanges(text: string, valueAbs: number, value: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let segStart = valueAbs;
    for (const raw of value.split("\n")) {
        const trimmed = raw.trim();
        const lead = raw.length - raw.trimStart().length;
        if (trimmed) {
            out.push([segStart + lead, segStart + lead + trimmed.length]);
        }
        segStart += raw.length + 1; // + 换行符
    }
    return out;
}

/**
 * 解析 launch include 目标(2026-09-03 05 task3 落地,替代逐 include spawn ros2 CLI;
 * 2026-09-06 提升为模块级共享导出——XML 链接与 launch.yaml include 链接(yaml-link-provider)共用):
 *  - $(find-pkg-share pkg)/rest:经共享 PackageMap.resolvePackageDir(触发懒取并等待,单飞 + 缓存);
 *  - 其余(package://、$(find pkg)、相对/绝对):经 PackageMap.resolveFileRef(统一入口);
 *  - 未注入共享实例(独立/测试):仅相对/绝对路径。
 */
export async function resolveLaunchIncludePath(
    filePath: string,
    documentUri: vscode.Uri,
    packages: PackageMap | undefined,
    token: vscode.CancellationToken
): Promise<vscode.Uri | null> {
    const rel = filePath.trim();
    if (!rel) {
        return null;
    }
    // $(find-pkg-share pkg)/rest → 包目录(工作区源码目录或系统 share,两级统一)
    const fm = /^\$\(\s*find-pkg-share\s+([a-zA-Z0-9_-]+)\s*\)\s*\/?(.*)$/.exec(rel);
    if (fm) {
        if (token.isCancellationRequested) {
            return null;
        }
        if (!packages) {
            log.debug(vscode.l10n.t('launch-link: shared PackageMap not injected; skipping find-pkg-share resolution:') + ' ' + rel);
            return null;
        }
        const pkgDir = await packages.resolvePackageDir(fm[1]);
        if (!pkgDir) {
            log.debug(vscode.l10n.t('find-pkg-share resolution failed (package miss / environment not ready):') + ' ' + fm[1]);
            return null;
        }
        const rest = fm[2].trim();
        const abs = rest ? path.join(pkgDir.fsPath, ...rest.split(/[/\\]/)) : pkgDir.fsPath;
        if (fs.existsSync(abs)) {
            log.debug(vscode.l10n.t('find-pkg-share resolved:') + ' ' + abs);
            return vscode.Uri.file(abs);
        }
        return null;
    }
    if (packages) {
        // package:// / $(find pkg) / 相对 / 绝对 → 统一解析入口
        const via = packages.resolveFileRef(rel, documentUri);
        if (via && fs.existsSync(via.fsPath)) {
            return via;
        }
        return null;
    }
    // 无共享实例:仅相对/绝对(与旧实现一致)
    const p = path.isAbsolute(rel) ? rel : path.join(path.dirname(documentUri.fsPath), rel);
    return fs.existsSync(p) ? vscode.Uri.file(p) : null;
}

/**
 * Registers the launch file link provider for XML launch files
 */
export function registerLaunchLinkProvider(packages?: PackageMap, exec?: LaunchExecSource): vscode.Disposable {
    // Register for both .launch and .launch.xml files
    // LD-3(2026-09-30)改纯 pattern;RE-3 勘误:裸 .launch 的 xml 语言绑定其实一直有效
    // (package.json languages 贡献无点扩展名 "launch" 经 VS Code languagesAssociations
    // endsWithIgnoreCase 匹配命中),当日"双条件下链接永不出现"的归因有误——纯 pattern 保留
    // (对无语言绑定场景更稳,与补全/跳转口径一致),但归因记录以 RE-3 为准
    const selector: vscode.DocumentSelector = [
        { scheme: 'file', pattern: '**/*.launch' },
        { scheme: 'file', pattern: '**/*.launch.xml' }
    ];

    return vscode.languages.registerDocumentLinkProvider(
        selector,
        new LaunchLinkProvider(packages, exec)
    );
}
