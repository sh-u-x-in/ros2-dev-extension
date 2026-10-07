/**
 * launch-hover-provider — launch 悬浮提示(LD-5,2026-09-30;此前除 py include 外全空)
 *
 * 三格式统一口径(与链接/跳转同一条解析链路,命中才显示、不命中静默):
 *  - 包名值位(pkg=/pkg:/get_package_share_directory('…))→ 包名 + 落点(package.xml/目录);
 *  - 可执行值位(exec=/exec:)→ 可执行名 + 源文件(需构建,与跳转同口径);
 *  - include 目标(file=/file:)→ 目标文件路径;
 *  - 参数引用($(var N)/LaunchConfiguration('N'))→ 声明行 + 默认值(LC-1 declLineText 首个消费方);
 *  - kwarg 名/属性名/yaml 键 → 目录条目 detail。
 * py include 表达式的悬浮仍在 launchpy-provider(LD-4 起 range 已窄化为末段字面量)。
 *
 * LA-1 域门控:域外文档早退。
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getLogger } from "../../../logger";
import type { PackageMap } from "../../shared/package-map";
import { fileInWorkspaceDomain } from "../../shared/workspace-domain";
import { decodeXmlEntities } from "../../shared/xml-utils";
import * as core from "../core/launch-completion-core";
import { declaredArgs, declaredArgsPy, LaunchArgDecl } from "../core/launch-args";
import { pyNodeCallAt } from "../parse/launch-py-parser";
import { resolveLaunchIncludePath } from "./launch-link-provider";
import { resolveExecTargetUri, resolvePackageTargetUri } from "./launch-definition-provider";
import type { LaunchExecSource } from "./launch-completion";

const log = getLogger("launch-hover");

export class LaunchHoverProvider implements vscode.HoverProvider {
    constructor(
        private packages: PackageMap | undefined,
        private exec: LaunchExecSource
    ) { }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        if (!fileInWorkspaceDomain(document.uri)) {
            return undefined; // LA-1:域外文档不解析
        }
        const text = document.getText();
        const offset = document.offsetAt(position);
        if (document.fileName.endsWith(".launch.py")) {
            return this.pyHover(text, offset);
        }        if (/\.launch\.ya?ml$/i.test(document.fileName)) {
            return this.yamlHover(document, text, offset, token);
        }
        return this.xmlHover(document, text, offset, token);
    }

    // ---------------- XML ----------------

    private async xmlHover(
        document: vscode.TextDocument,
        text: string,
        offset: number,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const cursor = core.xmlCursorAt(text, offset);
        if (!cursor) {
            return undefined;
        }
        if (cursor.kind === "attrName") {
            const c = core.xmlAttrCandidates(cursor.tag, cursor.attrPrefix).find(x => x.label === cursor.attrPrefix);
            return c ? simpleHover(vscode.l10n.t("{0} attribute `{1}`", cursor.tag, c.label), c.detail) : undefined;
        }
        if (cursor.kind !== "attrValue") {
            return undefined;
        }
        // $(var 参数引用(LD-2 尾段口径;闭合括号内悬停同样命中)
        const typed = core.varArgTypedWordAt(cursor.value);
        if (typed) {
            return this.argHover(declaredArgs(text, "xml"), typed);
        }
        // 完整值(xmlCursorAt.value 只是光标前缀;与 definition-provider 同一提取口径)
        const lastLt = text.lastIndexOf("<", offset - 1);
        const tagEnd = text.indexOf(">", lastLt);
        const tagText = text.slice(lastLt, tagEnd < 0 ? undefined : tagEnd + 1);
        const fullValue = decodeXmlEntities(new RegExp(`\\b${cursor.attr}\\s*=\\s*["']([^"']*)["']`).exec(tagText)?.[1] ?? cursor.value);
        if (cursor.tag === "node" && cursor.attr === "pkg") {
            return this.packageHover(fullValue);
        }
        if (cursor.tag === "node" && cursor.attr === "exec") {
            const pkg = core.xmlTagAttrBefore(text, offset, "pkg");
            return pkg ? this.execHover(pkg, fullValue) : undefined;
        }
        if (cursor.tag === "include" && cursor.attr === "file") {
            const target = await resolveLaunchIncludePath(fullValue, document.uri, this.packages, token);
            if (!target) {
                return undefined;
            }
            log.trace(vscode.l10n.t("launch xml include hover: {0} -> {1}", fullValue, target.fsPath));
            return simpleHover("**include 目标**", `\`${target.fsPath}\``);
        }
        return undefined;
    }

    // ---------------- Python ----------------

    private async pyHover(text: string, offset: number): Promise<vscode.Hover | undefined> {
        // ① Node 系调用:package / executable 值位
        const call = pyNodeCallAt(text, offset);
        if (call) {
            if (call.packageRange && offset >= call.packageRange[0] && offset <= call.packageRange[1] && call.package) {
                return this.packageHover(call.package);
            }
            if (call.executableRange && offset >= call.executableRange[0] && offset <= call.executableRange[1]
                && call.executable && call.package) {
                return this.execHover(call.package, call.executable);
            }
            // 不在 pkg/exec 值位:放行到 kwarg 名悬浮(光标落在 kwarg 名上时 call 仍命中)
        }
        // ② get_package_share_directory('pkg / LaunchConfiguration('arg
        const attrCtx = core.pyAttrContextAt(text, offset);
        if (attrCtx) {
            const typed = text.slice(attrCtx.valueStart, offset);
            if (attrCtx.attr === "package") {
                return this.packageHover(typed);
            }
            if (attrCtx.attr === "arg-ref") {
                return this.argHover(declaredArgsPy(text), typed);
            }
            return undefined;
        }
        // ③ kwarg 名(名位;目录条目 detail)
        const kw = core.pyKwargNameContextAt(text, offset);
        if (kw && kw.prefix) {
            const k = core.pyKwargCandidates(kw.call, kw.prefix, new Set()).find(x => x.label === kw.prefix);
            return k ? simpleHover(vscode.l10n.t("{0} argument `{1}`", kw.call, k.label), k.detail) : undefined;
        }
        return undefined;
    }

    // ---------------- YAML ----------------

    private async yamlHover(
        document: vscode.TextDocument,
        text: string,
        offset: number,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const cursor = core.yamlCursorAt(text, offset);
        if (!cursor) {
            return undefined;
        }
        if (cursor.kind === "key") {
            if (!cursor.keyPrefix) {
                return undefined;
            }
            const c = core.yamlKeyCandidates(cursor.action, cursor.keyPrefix).find(x => x.label === cursor.keyPrefix);
            return c ? simpleHover(vscode.l10n.t("{0} key `{1}`", cursor.action ?? "launch", c.label), c.detail) : undefined;
        }
        if (cursor.kind !== "value") {
            return undefined;
        }
        // $(var 参数引用
        const typed = core.varArgTypedWordAt(cursor.valuePrefix);
        if (typed) {
            return this.argHover(declaredArgs(text, "yaml"), typed);
        }
        // 整值从行文本提取(LG-1 正确语义:经 parseYamlScalarValue,值原样——引号内前导/后导空格
        // 真正参与,`" p10…"` 与定义/链接同口径不响应)
        const lineStart = offset > 0 ? text.lastIndexOf("\n", offset - 1) + 1 : 0;
        let lineEnd = text.indexOf("\n", lineStart);
        if (lineEnd < 0) {
            lineEnd = text.length;
        }
        const line = text.slice(lineStart, lineEnd);
        const colon = line.indexOf(":");
        const span = core.parseYamlScalarValue(line, colon + 1);
        if (!span || !span.value) {
            return undefined;
        }
        const keyMatch = /^\s*([A-Za-z_][\w-]*)\s*:/.exec(line);
        const key = keyMatch?.[1];
        const value = span.value;
        if (!key || !value) {
            return undefined;
        }
        if (key === "pkg") {
            return this.packageHover(value);
        }
        if (key === "exec") {
            const pkg = core.yamlSiblingKeyValue(text, lineStart, "pkg");
            return pkg ? this.execHover(pkg, value) : undefined;
        }
        if (key === "file") {
            const target = await resolveLaunchIncludePath(value, document.uri, this.packages, token);
            if (!target) {
                return undefined;
            }
            log.trace(vscode.l10n.t("launch yaml include hover: {0} -> {1}", value, target.fsPath));
            return simpleHover("**include 目标**", `\`${target.fsPath}\``);
        }
        return undefined;
    }

    // ---------------- 落点悬浮(与跳转同口径:命中才显示) ----------------

    private async packageHover(pkg: string): Promise<vscode.Hover | undefined> {
        const uri = await resolvePackageTargetUri(this.packages, pkg);
        if (!uri) {
            return undefined;
        }
        return simpleHover(`**包** \`${pkg}\``, `\`${uri.fsPath}\``);
    }

    private async execHover(pkg: string, name: string): Promise<vscode.Hover | undefined> {
        const uri = await resolveExecTargetUri(this.exec, pkg, name);
        if (!uri) {
            return undefined; // 未构建/未命中 → 静默(与跳转同口径)
        }
        return simpleHover(`**可执行** \`${pkg}/${name}\``, `\`${uri.fsPath}\``);
    }

    /** 参数引用悬浮:声明行 + 默认值(LC-1 declLineText 首个消费方) */
    private argHover(decls: ReadonlyArray<LaunchArgDecl>, name: string): vscode.Hover | undefined {
        if (!name) {
            return undefined;
        }
        const d = decls.find(x => x.name === name);
        if (!d) {
            return undefined;
        }
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**launch 参数** \`${d.name}\``);
        md.appendMarkdown(d.default !== undefined ? `\n\n默认值:\`${d.default}\`` : "\n\n必传(无默认值)");
        if (d.declLineText) {
            md.appendCodeblock(d.declLineText.trim());
        }
        return new vscode.Hover(md);
    }
}

/** 两段式悬浮(标题 + 内容行;内容可为多行 markdown) */
function simpleHover(title: string, body: string): vscode.Hover {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(title);
    if (body) {
        md.appendMarkdown(`\n\n${body}`);
    }
    return new vscode.Hover(md);
}
