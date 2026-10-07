/**
 * xacro 跳转提供器 Definition(F12/Go to Definition)(2026-09-07 拆分自 providers.ts)。
 *
 * 交互顺序(与 03 设计一致 + 2026-09-06 用户反馈修正):
 *  1) include filename → 目标文件;
 *  2) ${...} 表达式内(含属性值内嵌)→ 变量语义:宏形参遮蔽优先 → property/arg(绝不回落原文符号匹配);
 *  2.5) "$(arg name)" 替换引用 → xacro:arg(强制 kind=arg,同名 property 桥接不遮蔽,2026-09-08);
 *  3) 属性值(光标不在 ${}):filename → 文件;link/joint 纯字面名 → 符号(复合模板字面片段仍可原文匹配);
 *  4) 宏调用 <xacro:word。
 * 命中返回 Range(名称字符串,VS Code 全选,cpp 式);定位失败回退 Position/明确日志。
 */
import * as vscode from "vscode";
import * as path from "path";
import { IncludeGraph } from "../core/include-graph";
import type { PackageMap } from "../../shared/package-map";
import { collectMacroParamSpans } from "./diagnostic-provider";
import { getCursorContextFromTree } from "../parse/context-locator";
import {
    log,
    queryAt,
    logMissReason,
    logVarMiss,
    rangeLine,
    rangeChar,
    isFileTarget,
    dollarVarAt,
    dollarParenArgAt,
    resolveDollarRef,
    resolveDollarDottedRef,
    resolveInsertBlockRef,
    dottedMacroNameAt,
    nsDeclHopAt,
    resolveNsQualified,
    attrAtDocument,
    attrWithOffsetsAt,
    symbolAnchorColumn,
    symbolNameRange,
    docModelOf
} from "./provider-utils";

export class XacroDefinitionProvider implements vscode.DefinitionProvider {
    constructor(
        private graph: IncludeGraph,
        private packages: PackageMap
    ) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        const info = this.graph.getFile(document.uri);
        if (!info) {
            log.debug(`Definition 跳过:${queryAt(document, position)} — 文件不在图内(激活扫描/监听未覆盖?)`);
            return undefined;
        }
        const lineText = document.lineAt(position.line).text;
        log.debug(`Definition 查询:${queryAt(document, position)} → 行「${lineText.trim().slice(0, 100)}」`);

        // 1) include 跳转:光标位于 filename 值内;目标未解析 → fire-and-forget 兜底(S1-A)
        const inc = info.includes.find(e => e.line === position.line);
        if (inc) {
            log.trace(`  include 候选 @${inc.line + 1}:${inc.startColumn + 1}-${inc.endColumn} 光标 ${position.character + 1} 在内? ${position.character >= inc.startColumn && position.character <= inc.endColumn}`);
        }
        if (
            inc &&
            position.character >= inc.startColumn &&
            position.character <= inc.endColumn
        ) {
            if (inc.target) {
                // 目录/未落盘/半路径不跳(2026-09-08:避免 VS Code 打开目录报"是目录")
                if (await isFileTarget(inc.target)) {
                    log.trace(`xacro include 跳转:${inc.raw}`);
                    return new vscode.Location(inc.target, new vscode.Position(0, 0));
                }
                log.trace(`include 目标非普通文件(目录/未落盘),不跳:${inc.target.fsPath}`);
                return undefined;
            }
            log.debug(`include 目标未解析:${inc.raw}(触发兜底)`);
            void this.graph.fallback(document.uri);
            return undefined;
        }

        // 2) ${...} 表达式内(含 link/joint/filename 属性值里嵌的 ${}):
        //    一律按变量解析——形参遮蔽 > property/arg;命中即返回,绝不回落到
        //    "以 ${name} 原文匹配 link/joint 定义"的字面正匹配(宏体模板非真定义,用户反馈 2026-09-06)
        const docModel = docModelOf(this.graph, document); // XG6:缓存解析模型(definition 全程共用一次,修 X-F4)
        const offset = document.offsetAt(position);
        const ctx = getCursorContextFromTree(docModel.tree, docModel.text, document, position);
        const dv = dollarVarAt(document, position);
        if (dv && ctx.elementName !== "xacro:call") {
            // XG8:xacro:call 的 macro="${dyn}" 由 2.7 处理——此处不吞,否则动态调用永远跳不到宏
            log.trace(`  光标位于 \${...} 块内:标识符=${dv.name}(offset ${dv.nameStart})`);
            const spans = collectMacroParamSpans(docModel.tree, docModel.text);
            // 2.0) 点链形态(XG8):${ns.prop} / ${props.a} → ns 目标属性 / 头属性;链头是 ns → ns= 声明
            const dotted = resolveDollarDottedRef(this.graph, docModel, document, dv);
            if (dotted) {
                const tl = rangeLine(dotted.range);
                const tc = rangeChar(dotted.range);
                log.debug(`  → 点链 ${dv.name} 解析命中:${path.basename(dotted.uri.fsPath)}:${tl + 1}:${tc + 1}`);
                return new vscode.Location(dotted.uri, dotted.range);
            }
            const target = resolveDollarRef(this.graph, document, spans, dv.name, dv.nameStart);
            if (target) {
                const tl = rangeLine(target.range);
                const tc = rangeChar(target.range);
                log.debug(`  → ${dv.name} 解析命中:${path.basename(target.uri.fsPath)}:${tl + 1}:${tc + 1}`);
                return new vscode.Location(target.uri, target.range);
            }
            logVarMiss(this.graph, document.uri, dv.name);
            return undefined;
        }

        // 2.5) "$(arg name)" 替换引用(2026-09-08):arg 名 → xacro:arg 定义。
        //     与 ${} 不同,$(arg) 面强制走 kind=arg——即使存在同名 property 桥接也不遮蔽
        //     (<xacro:property name="x" value="$(arg x)"> 里点 "$(arg x)" 的 x 应跳命令行 arg 定义)。
        const dpa = dollarParenArgAt(document, position);
        if (dpa) {
            const startPos = document.positionAt(dpa.start);
            log.trace(`  \$(arg) 引用跳转:${dpa.name}(${startPos.line + 1}:${startPos.character + 1})`);
            const def = this.graph.findSymbol(document.uri, startPos, dpa.name, "arg");
            if (def) {
                log.debug(`  → arg ${dpa.name} 命中:${path.basename(def.uri.fsPath)}:${def.line + 1}`);
                const r = symbolNameRange(this.graph, def)
                    ?? new vscode.Position(def.line, symbolAnchorColumn(this.graph, def));
                return new vscode.Location(def.uri, r);
            }
            logMissReason(this.graph, document.uri, dpa.name, "arg");
            return undefined;
        }

        // 2.6) xacro:insert_block name(XG8):宏定义 * / ** 参数优先(官方查表序),无所在宏落块属性
        if (ctx.elementName === "xacro:insert_block") {
            const attr = attrAtDocument(document, position, docModel.tree);
            if (attr?.attrName === "name" && attr.value) {
                log.trace(`  insert_block name:${attr.value}`);
                const hit = resolveInsertBlockRef(this.graph, docModel, document, attr.value, attrWithOffsetsAt(document, position, docModel.tree)?.valueFrom ?? offset);
                if (hit) {
                    const tl = rangeLine(hit.range);
                    log.debug(`  → ${attr.value} 命中:${path.basename(hit.uri.fsPath)}:${tl + 1}`);
                    return new vscode.Location(hit.uri, hit.range);
                }
                logMissReason(this.graph, document.uri, attr.value, "property");
                return undefined;
            }
        }

        // 2.7) xacro:call macro=(XG8):字面宏名或 ${宏名} → 宏定义
        if (ctx.elementName === "xacro:call") {
            const attr = attrAtDocument(document, position, docModel.tree);
            if (attr?.attrName === "macro" && attr.value) {
                const trimmed = attr.value.trim();
                const em = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
                const name = em ? em[1] : (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : undefined);
                if (name) {
                    log.trace(`  xacro:call macro:${name}`);
                    const def = this.graph.findSymbol(document.uri, position, name, "macro");
                    if (def) {
                        const r = symbolNameRange(this.graph, def)
                            ?? new vscode.Position(def.line, symbolAnchorColumn(this.graph, def));
                        return new vscode.Location(def.uri, r);
                    }
                    logMissReason(this.graph, document.uri, name, "macro");
                }
                return undefined; // 动态表达式(call macro="${复杂}")静态不可解析,不误跳
            }
        }

        // 3) 属性值内(光标不在 ${} 里):filename → 文件跳转;link/joint 纯字面名 → 符号跳转。
        //    复合模板(如 ${prefix}_base_link)光标点在字面片段上仍可走原文符号匹配(样例内联跳转)。
        const attr = attrAtDocument(document, position, docModel.tree);
        if (attr) {
            log.trace(`  光标在属性 ${attr.attrName}=「${attr.value.slice(0, 60)}」上`);
            if (attr.attrName === "filename") {
                const target = this.packages.resolveFileRef(attr.value, document.uri);
                // 仅普通文件可跳(目录/未落盘不跳,2026-09-08)
                if (target && (await isFileTarget(target))) {
                    log.trace(`xacro 文件跳转:${attr.value}`);
                    return new vscode.Location(target, new vscode.Position(0, 0));
                }
                log.debug(`  filename ${attr.value} 非可跳文件($(find)/package:// 未命中或目标为目录/未落盘)`);
                return undefined;
            }
            if (attr.attrName === "link" || attr.attrName === "joint") {
                const kind = attr.attrName as "link" | "joint";
                // 可见性判定锚点 = 属性值起点(光标无关):同一引用无论光标落在值内哪个字符、
                // 或先前光标在何处,跳转结果恒定(2026-09-07 用户反馈:光标叠加影响结果)
                const off = attrWithOffsetsAt(document, position, docModel.tree);
                const anchorPos = off && off.valueFrom >= 0
                    ? document.positionAt(off.valueFrom)
                    : position;
                const def = this.graph.findSymbol(document.uri, anchorPos, attr.value, kind);
                if (def) {
                    log.trace(`xacro ${attr.attrName} 跳转:${attr.value} -> ${def.uri.fsPath}:${def.line}`);
                    // Range 返回 → 跳转后 VS Code 全选被定义名(cpp 式)
                    const r = symbolNameRange(this.graph, def)
                        ?? new vscode.Position(def.line, symbolAnchorColumn(this.graph, def));
                    return new vscode.Location(def.uri, r);
                }
                logMissReason(this.graph, document.uri, attr.value, kind);
                return undefined;
            }
        }

        // 4) 宏调用:<xacro:word(光标不在 ${} 内)。
        //    XG12:点号名(kit.kit_plate)先于普通宏路径分段处理——head/中段 → 该级 ns= 声明,
        //    尾段 → N 级寻址宏定义(含无 ns 嵌套传染);不再误把 ns 名当宏查表(消兜底误触发)。
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
        if (!wordRange) {
            log.trace(`  光标不在词上(非宏/变量可命中位置)`);
            return undefined;
        }
        const word = document.getText(wordRange);
        if (!word) {
            log.trace(`  词为空`);
            return undefined;
        }
        const wordStart = wordRange.start.character;
        const chBefore = wordStart > 0 ? lineText[wordStart - 1] : "";
        log.trace(`  词=「${word}」 chBefore=「${chBefore}」 slice6=「${lineText.slice(Math.max(0, wordStart - 6), wordStart)}」`);

        const dotted = (chBefore === ":" || chBefore === ".")
            && dottedMacroNameAt(lineText, wordRange);
        if (dotted) {
            const { segs, segIdx } = dotted;
            if (segIdx < segs.length - 1) {
                // head/中段:跳该级 ns= 声明(include 标签的 ns 属性值)
                const hop = nsDeclHopAt(this.graph, docModel, document.uri, segs, segIdx);
                if (hop) {
                    log.trace(`xacro ns 声明跳转:${segs.slice(0, segIdx + 1).join(".")} → ${path.basename(hop.uri.fsPath)} include ns="${hop.ns}"`);
                    return new vscode.Location(
                        hop.uri,
                        new vscode.Range(document.positionAt(hop.valueFrom), document.positionAt(hop.valueTo))
                    );
                }
                logMissReason(this.graph, document.uri, segs[segIdx], "macro");
                return undefined;
            }
            // 尾段:N 级寻址宏定义(含传染)
            const hit = resolveNsQualified(this.graph, docModel, document.uri, segs, "macro");
            if (hit) {
                log.trace(`xacro ns 宏跳转:${segs.join(".")} → ${path.basename(hit.ref.uri.fsPath)}:${hit.ref.line + 1}`);
                const r = symbolNameRange(this.graph, hit.ref)
                    ?? new vscode.Position(hit.ref.line, symbolAnchorColumn(this.graph, hit.ref));
                return new vscode.Location(hit.ref.uri, r);
            }
            logMissReason(this.graph, document.uri, segs.join("."), "macro");
            return undefined;
        }

        if (chBefore === ":" && lineText.slice(Math.max(0, wordStart - 6), wordStart) === "xacro:") {
            // 锚点 = 宏名词首(而非光标行内任意子位置),保证同文件"定义在前"判定与光标无关
            const wordPos = new vscode.Position(wordRange.start.line, wordRange.start.character);
            const def = this.graph.findSymbol(document.uri, wordPos, word, "macro");
            if (def) {
                log.trace(`xacro 宏跳转:${word} -> ${def.uri.fsPath}:${def.line}`);
                // Range 返回 → 跳转后 VS Code 全选宏名(cpp 式,光标落在宏名前方)
                const r = symbolNameRange(this.graph, def)
                    ?? new vscode.Position(def.line, symbolAnchorColumn(this.graph, def));
                return new vscode.Location(def.uri, r);
            }
            logMissReason(this.graph, document.uri, word, "macro");
            return undefined;
        }
        log.trace(`  非宏调用形态(前面不是 xacro:)`);
        return undefined;
    }
}
