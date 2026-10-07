/**
 * xacro 悬浮提供器 Hover(include 目标 / ${} 变量与形参 / $(arg name) 替换引用 / 元素·关节类型文档 / link-joint / 宏调用)
 * (2026-09-07 拆分自 providers.ts;2026-09-08:形参悬停收窄为最小身份——形参多参数堆叠无逐参注释)。
 *
 * 附:extractLeadingComment(定义上方紧邻注释)与其行偏移工具(2026-09-06 用户反馈:宏文档注释入悬浮框)。
 */
import * as vscode from "vscode";
import * as path from "path";
import { IncludeGraph, SymbolRef, Visibility } from "../core/include-graph";
import { getCursorContextFromTree } from "../parse/context-locator";
import { findElementDoc, findJointType, elementDocMarkdown, jointTypeMarkdown } from "../data/urdf-docs";
import { collectMacroParamSpans, enclosingMacroSpan } from "./diagnostic-provider";
import {
    log,
    queryAt,
    logMissReason,
    logVarMiss,
    dollarVarAt,
    dollarParenArgAt,
    attrAtDocument,
    docModelOf,
    dottedMacroNameAt,
    nsDeclHopAt,
    resolveNsQualified,
    verbatimCommentInner
} from "./provider-utils";

/**
 * xacro 悬浮提示提供器:include 目标 / 宏签名 / 变量值 / link-joint 来源链
 */
export class XacroHoverProvider implements vscode.HoverProvider {
    constructor(private graph: IncludeGraph) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const info = this.graph.getFile(document.uri);
        if (!info) {
            log.debug(`Hover 跳过:${queryAt(document, position)} — 文件不在图内`);
            return undefined;
        }
        const lineText = document.lineAt(position.line).text;
        log.debug(`Hover 查询:${queryAt(document, position)} → 行「${lineText.trim().slice(0, 100)}」`);

        // 1) include 悬停:显示目标路径
        const inc = info.includes.find(e => e.line === position.line);
        if (inc && position.character >= inc.startColumn && position.character <= inc.endColumn) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**xacro include**\n\n\`${inc.raw}\``);
            if (inc.target) {
                md.appendMarkdown(`\n\n→ \`${inc.target.fsPath}\``);
            } else {
                md.appendMarkdown(`\n\n_(目标未解析)_`);
            }
            return new vscode.Hover(md, new vscode.Range(inc.line, inc.startColumn, inc.line, inc.endColumn));
        }

        // 2) ${...} 变量/形参悬停(含属性值内嵌 ${} —— 优先于 link/joint 字面悬停;
        //    命中形参 → 只给身份(形参是 params="a b c" 多参数堆叠,无逐参注释,不展示注释/定义行,
        //    2026-09-08 用户);命中 property/arg → 定义悬浮(定义行 + 上方注释,同宏);未命中不再回落字面匹配)
        const docModel = docModelOf(this.graph, document); // XG6:缓存解析模型(hover 全程共用一次,修 X-F4)
        const dv = dollarVarAt(document, position);
        if (dv) {
            log.trace(`  光标位于 \${...} 块内:标识符=${dv.name}`);
            const spans = collectMacroParamSpans(docModel.tree, docModel.text);
            const span = enclosingMacroSpan(spans, dv.nameStart);
            const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
            if (span && span.params.has(dv.name)) {
                const macroPos = document.positionAt(span.from);
                log.trace(`xacro 变量悬停(宏形参):${dv.name} → 宏 ${span.macroName ?? "?"}`);
                const md = new vscode.MarkdownString();
                md.appendMarkdown(`**宏参数 \`${dv.name}\`(宏 \`${span.macroName ?? "?"}\` 的形参)**\n\n`);
                md.appendMarkdown(`定义于 \`${path.basename(document.uri.fsPath)}:${macroPos.line + 1}\``);
                return new vscode.Hover(md, wordRange);
            }
            const pos = document.positionAt(dv.nameStart);
            const def = this.graph.findSymbol(document.uri, pos, dv.name, "property")
                || this.graph.findSymbol(document.uri, pos, dv.name, "arg");
            if (def) {
                const vis = this.graph.isVisible(document.uri, pos, def);
                log.trace(`xacro 变量悬停:${dv.name} -> ${def.uri.fsPath}:${def.line}`);
                return new vscode.Hover(this.definitionMarkdown(`变量 \`${dv.name}\``, def, vis), wordRange);
            }
            logVarMiss(this.graph, document.uri, dv.name);
            return undefined;
        }

        // 2.5) "$(arg name)" 替换引用悬停(2026-09-08):→ xacro:arg 定义(定义行 + 上方注释,同 ${});
        //     强制 kind=arg(同名 property 桥接不遮蔽——arg 面读的是命令行参数)。
        const dpa = dollarParenArgAt(document, position);
        if (dpa) {
            log.trace(`  \$(arg) 悬停:${dpa.name}`);
            const startPos = document.positionAt(dpa.start);
            const def = this.graph.findSymbol(document.uri, startPos, dpa.name, "arg");
            if (def) {
                const vis = this.graph.isVisible(document.uri, startPos, def);
                const wordRange = new vscode.Range(startPos, document.positionAt(dpa.end));
                return new vscode.Hover(this.definitionMarkdown(`arg \`${dpa.name}\``, def, vis), wordRange);
            }
            logVarMiss(this.graph, document.uri, dpa.name);
            return undefined;
        }

        // 3) 元素文档(P1,03 §3 ②):悬停标签名 → URDF/几何/材质文档;悬停 type= 值 → 关节类型文档(05)
        const ctx = getCursorContextFromTree(docModel.tree, docModel.text, document, position);
        if (ctx.role === "tagName" && !ctx.inComment) {
            const elemDoc = findElementDoc(ctx.elementName);
            if (elemDoc) {
                log.trace(`xacro 元素文档:${ctx.elementName}`);
                return new vscode.Hover(elementDocMarkdown(elemDoc), document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/));
            }
        }
        if (ctx.role === "attrValue" && ctx.attrName === "type") {
            // 关节类型来自光标所在属性值
            const attr2 = attrAtDocument(document, position, docModel.tree);
            if (attr2 && attr2.attrName === "type") {
                const jt = findJointType(attr2.value);
                if (jt) {
                    log.trace(`xacro 关节类型文档:${attr2.value}`);
                    return new vscode.Hover(jointTypeMarkdown(jt), document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/));
                }
            }
        }

        // 4) link/joint 名悬停(P0/P1):定义位置 + 来源链(03 §3 ③)
        const attr = attrAtDocument(document, position, docModel.tree);
        if (attr && (attr.attrName === "link" || attr.attrName === "joint")) {
            log.trace(`  光标在 ${attr.attrName}=「${attr.value.slice(0, 60)}」上(字面悬停)`);
            const def = this.graph.findSymbol(document.uri, position, attr.value, attr.attrName as "link" | "joint");
            if (def) {
                const vis = this.graph.isVisible(document.uri, position, def);
                const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
                return new vscode.Hover(this.definitionMarkdown(`\`${attr.value}\``, def, vis), wordRange);
            }
            logMissReason(this.graph, document.uri, attr.value, attr.attrName as "link" | "joint");
        }

        // 5) 宏调用:<xacro:word(光标不在 ${} 内)
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
        if (!wordRange) {
            log.trace(`  光标不在词上(hover 无结果)`);
            return undefined;
        }
        const word = document.getText(wordRange);
        if (!word) {
            log.trace(`  词为空(hover 无结果)`);
            return undefined;
        }
        const wordStart = wordRange.start.character;
        const chBefore = wordStart > 0 ? lineText[wordStart - 1] : "";

        // XG12:点号名(kit.kit_plate)分段——head(chBefore=":")/中尾段(chBefore=".")都先走 ns 寻址;
        // 普通宏(无点)维持原路径
        const isXacroCallForm = chBefore === ":" && lineText.slice(Math.max(0, wordStart - 6), wordStart) === "xacro:";
        const dotted = (isXacroCallForm || chBefore === ".") ? dottedMacroNameAt(lineText, wordRange) : undefined;
        if (dotted) {
            const { segs, segIdx } = dotted;
            if (segIdx < segs.length - 1) {
                const hop = nsDeclHopAt(this.graph, docModel, document.uri, segs, segIdx);
                if (hop) {
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(`**命名空间 \`${hop.ns}\`**\n\n`);
                    md.appendMarkdown(`声明于本文件 include:\n\n\`<xacro:include … ns="${hop.ns}" />\`\n\n`);
                    md.appendMarkdown(`宏以 \`${segs.slice(0, segIdx + 1).join(".")}.<宏名>\` 调用;属性以 \`${segs.slice(0, segIdx + 1).join(".")}.<属性名>\` 取值`);
                    return new vscode.Hover(md, wordRange);
                }
                return undefined;
            }
            const hit = resolveNsQualified(this.graph, docModel, document.uri, segs, "macro");
            if (hit) {
                const vis = this.graph.isVisible(document.uri, position, hit.ref);
                log.trace(`xacro ns 宏悬浮:${segs.join(".")} → ${path.basename(hit.ref.uri.fsPath)}:${hit.ref.line + 1}`);
                return new vscode.Hover(this.definitionMarkdown(`宏 \`${hit.ref.name}\`(经 ns \`${segs.slice(0, -1).join(".")}\`)`, hit.ref, vis), wordRange);
            }
            logMissReason(this.graph, document.uri, segs.join("."), "macro");
            return undefined;
        }
        if (isXacroCallForm) {
            const def = this.graph.findSymbol(document.uri, position, word, "macro");
            if (def) {
                const vis = this.graph.isVisible(document.uri, position, def);
                return new vscode.Hover(this.definitionMarkdown(`宏 \`${word}\``, def, vis), wordRange);
            }
            logMissReason(this.graph, document.uri, word, "macro");
            return undefined;
        }
        log.trace(`  非宏调用形态(hover 无结果:chBefore=「${chBefore}」)`);
        return undefined;
    }

    /** 构造"定义于 文件:行"悬浮内容,附定义行源码与来源链(M2:经 root 展开) */
    private definitionMarkdown(label: string, def: SymbolRef, vis?: Visibility): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${label}**\n\n`);
        const defInfo = this.graph.getFile(def.uri);
        if (defInfo) {
            // 定义上方紧邻的 <!-- ... --> 注释 → 作为文档说明带进悬浮框(RE-2:verbatim 代码块)
            const docComment = extractLeadingComment(defInfo.text, def.line);
            if (docComment) {
                md.appendCodeblock(docComment);
            }
            const lineText = (defInfo.text.split(/\r?\n/)[def.line] ?? "").trim();
            if (lineText) {
                md.appendCodeblock(lineText, "xml");
            }
        }
        md.appendMarkdown(`\n定义于 \`${path.basename(def.uri.fsPath)}:${def.line + 1}\``);
        if (vis) {
            for (const c of vis.contexts) {
                md.appendMarkdown(`\n${c}`);
            }
            if (!vis.visible && vis.blocker) {
                md.appendMarkdown(`\n⚠️ ${vis.blocker}`);
            }
        }
        return md;
    }
}

/* ---------------- 文档注释提取(hover 用,测试经根 index 再导出) ---------------- */

/** 行起始偏移表(供注释结束行换算,O(n) 一次) */
function buildLineStartsForComment(text: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            starts.push(i + 1);
        }
    }
    return starts;
}

/** offset → 行号(0 基,二分) */
function commentLineAt(lineStarts: number[], offset: number): number {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

/**
 * 取定义行上方"紧挨着"的 <!-- ... --> 注释块(去掉语法外壳,去缩进)。
 * 供 hover 把宏/符号的文档注释带进悬浮框(用户反馈 2026-09-06)。
 * 规则:注释的结束行必须是 defLine-1(空行/代码行隔开都不算紧邻);无则 undefined。
 */
export function extractLeadingComment(text: string, defLine: number): string | undefined {
    if (defLine <= 0) {
        return undefined;
    }
    const lineStarts = buildLineStartsForComment(text);
    const lineTextAt = (n: number): string => {
        if (n < 0 || n >= lineStarts.length) {
            return "";
        }
        const s = lineStarts[n];
        const e = n + 1 < lineStarts.length ? lineStarts[n + 1] : text.length;
        return text.slice(s, e).replace(/\r?\n$/, "");
    };
    // 紧邻行(注释结束行上方)不能是空行
    if (lineTextAt(defLine - 1).trim() === "") {
        return undefined;
    }
    const re = /<!--([\s\S]*?)-->/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const endLine = commentLineAt(lineStarts, m.index + m[0].length - 1);
        if (endLine === defLine - 1) {
            // RE-2(2026-09-30,用户裁定):内文 verbatim——换行/缩进/空行原样(清洗在 verbatimCommentInner,
            // 与补全侧同源);渲染为代码块,缩进与源文本一一对应
            return verbatimCommentInner(m[1]);
        }
        if (endLine > defLine - 1) {
            break;
        }
    }
    return undefined;
}
