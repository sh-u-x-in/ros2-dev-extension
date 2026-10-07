/**
 * xacro UI 提供器共享工具(definition/document-link/hover 三提供器共用,2026-09-07 拆分自 providers.ts)。
 *
 * 内容:统一日志(log)、查询级调试助手(queryAt/logMissReason/logVarMiss/rangeLine/rangeChar)、
 *      ${...} 块定位(dollarVarAt)、变量引用解析(resolveDollarRef,形参遮蔽优先)、
 *      定义锚点定位(nameAttrColumn/symbolAnchorColumn/symbolNameRange/macroParamRange)、
 *      光标属性定位(attrAtDocument)。
 * 依赖方向:→ core/include-graph(类型) / ui/diagnostic-provider(宏形参跨度) / ../../shared/xml-utils;
 * 被 ui 三个提供器文件引用。定位:纯工具层,禁止 import extension/注册逻辑;不持有任何状态。
 */
import * as vscode from "vscode";
import * as path from "path";
import { promises as fsp } from "fs";
import type { Tree } from "@lezer/common";
import { getLogger } from "../../../logger";
import type { IncludeGraph, SymbolRef } from "../core/include-graph";
import type { SymbolKind } from "../core/include-graph";
import { parseXml, attrAtCursor } from "../../shared/xml-utils";
import { XACRO_KEYWORDS as XACRO_KEYWORDS_OFFICIAL } from "../parse/xacro-tags";
import { parseXacroDocument } from "../parse/xacro-document";
import type { XacroDocument } from "../parse/xacro-document";
import { enclosingMacroSpan } from "./diagnostic-provider";import type { MacroParamSpan } from "./diagnostic-provider";

/** 三个 UI 提供器共用日志前缀(xacro-providers,输出面板同通道) */
export const log = getLogger("xacro-providers");

/** xacro 内建标签(非宏调用)——XG5(2026-09-24)收敛到 parse/xacro-tags 单一来源(修 X-F3:
 *  原 8 词条含非官方 element_inject;现 10 官方固定标签,见 设计/xacro/13 §3) */
export const XACRO_KEYWORDS: ReadonlySet<string> = XACRO_KEYWORDS_OFFICIAL;

/** 标识符字符(变量名/属性名) */
const WORD_RE = /[A-Za-z0-9_]/;

/**
 * 取文档的缓存解析模型(XG6,2026-09-24):优先 IncludeGraph.getDocument(uri+version 缓存,
 * 与 scanIncludes/collectSymbols 共享同一次解析,修 X-F4 每查询重解析);
 * graph 缺 getDocument(测试 mock)时回退现场解析——行为与旧实现一致。
 */
export function docModelOf(graph: IncludeGraph | undefined, document: vscode.TextDocument): XacroDocument {
    const g = graph as { getDocument?: (d: vscode.TextDocument) => XacroDocument } | undefined;
    if (g && typeof g.getDocument === "function") {
        return g.getDocument(document);
    }
    return parseXacroDocument(document.getText(), document.uri);
}

/* ---------------- 查询级调试日志(2026-09-06:模块复杂度上升,补决策链可见性) ---------------- */

/**
 * 原因线索去重键(每 文件+名+类 只后台探测一次,防交互路径反复全图扫描)。
 * 2026-09-07 用户确认:日志保留(诊断必需),但"原因线索"的全图 findSymbolAny
 * 不得阻塞交互查询——改异步(250ms 后)计算并照常打日志。
 */
const missHintSeen = new Set<string>();
const MISS_HINT_DELAY_MS = 250;

function scheduleMissHint(dedupeKey: string, run: () => void): void {
    if (missHintSeen.has(dedupeKey)) {
        return;
    }
    missHintSeen.add(dedupeKey);
    setTimeout(() => {
        try {
            run();
        } catch (err) {
            log.trace(`原因线索计算失败:${(err as Error).message}`);
        }
    }, MISS_HINT_DELAY_MS);
}

/** 查询位置短名:file:行:列(1 基,便于输出面板对照) */
export function queryAt(document: vscode.TextDocument, position: vscode.Position): string {
    return `${path.basename(document.uri.fsPath)}:${position.line + 1}:${position.character + 1}`;
}

/**
 * 目标是否"已存在的普通文件"(目录/不存在 → false)。
 * include 跳转 / 文件级链接护栏(2026-09-08):半路径(写到一半的目录)、已解析成目录的目标
 * 若照跳会被 VS Code 报"是目录,不给显示";只在目标是真实文件时才放行。
 */
export async function isFileTarget(uri: vscode.Uri): Promise<boolean> {
    try {
        const st = await fsp.stat(uri.fsPath);
        return st.isFile();
    } catch {
        return false;
    }
}

/** 符号"未命中"的原因线索(异步后台探测,不阻塞交互;日志保留):存在但不可见 vs 全图无 vs 同名异型 */
export function logMissReason(graph: IncludeGraph, file: vscode.Uri, name: string, kind: SymbolKind): void {
    log.debug(`  ⤷ ${name}(${kind}) 未命中(原因线索后台探测中…)`);
    scheduleMissHint(`miss|${file.toString()}|${name}|${kind}`, () => {
        const any = graph.findSymbolAny(file, name, kind);
        if (any) {
            log.debug(`  ⤷ ${name}(${kind}) 存在但当前上下文不可见:${path.basename(any.uri.fsPath)}:${any.line + 1}(定义在前/展开序问题?)`);
            return;
        }
        const kinds: SymbolKind[] = ["macro", "property", "arg", "link", "joint"];
        for (const k of kinds) {
            if (k === kind) {
                continue;
            }
            const alt = graph.findSymbolAny(file, name, k);
            if (alt) {
                log.debug(`  ⤷ ${name}(${kind}) 全图无定义;存在同名 ${alt.kind}@${path.basename(alt.uri.fsPath)}:${alt.line + 1}(类型不符)`);
                return;
            }
        }
        log.debug(`  ⤷ ${name}(${kind}) 全图均无该名定义`);
    });
}

/** 变量(property/arg)未命中原因线索(异步后台探测) */
export function logVarMiss(graph: IncludeGraph, file: vscode.Uri, name: string): void {
    log.debug(`  ⤷ 变量 ${name} 未命中(原因线索后台探测中…)`);
    scheduleMissHint(`var|${file.toString()}|${name}`, () => {
        const p = graph.findSymbolAny(file, name, "property");
        const a = p ? undefined : graph.findSymbolAny(file, name, "arg");
        if (p || a) {
            const hit = p ?? a!;
            log.debug(`  ⤷ 变量 ${name} 当前不可见;存在 ${hit.kind}@${path.basename(hit.uri.fsPath)}:${hit.line + 1}(同文件定义在前/展开序?)`);
            return;
        }
        log.debug(`  ⤷ 变量 ${name} 全图无同名 property/arg`);
    });
}

/** Range | Position 统一取行/列(供日志) */
export function rangeLine(r: vscode.Range | vscode.Position): number {
    return (r as vscode.Range).start ? (r as vscode.Range).start.line : (r as vscode.Position).line;
}
export function rangeChar(r: vscode.Range | vscode.Position): number {
    return (r as vscode.Range).start ? (r as vscode.Range).start.character : (r as vscode.Position).character;
}

/**
 * 光标是否位于某个 ${...} 块内;是则返回块内光标所在的标识符及其绝对偏移。
 * 块内容可为纯标识符或表达式(如 ${-chassis_hei/2.0}、${prefix}wheel_rr 中的 ${prefix})。
 * 替代旧 isInDollarBraces 的"行内有无未闭合 ${"粗判(光标已越过闭合 } 仍误判在块内)。
 */
export function dollarVarAt(document: vscode.TextDocument, position: vscode.Position): { name: string; nameStart: number; nameEnd: number } | undefined {
    const text = document.getText();
    const off = document.offsetAt(position);
    const open = text.lastIndexOf("${", off);
    if (open < 0) {
        return undefined;
    }
    const close = text.indexOf("}", open + 2);
    if (close < 0 || off > close) {
        return undefined;
    }
    let s = off;
    while (s > open + 2 && WORD_RE.test(text[s - 1])) {
        s--;
    }
    let e = off;
    while (e < close && WORD_RE.test(text[e])) {
        e++;
    }
    if (s === e) {
        return undefined; // 光标在非标识符字符上($ / { / } / 运算符)
    }
    return { name: text.slice(s, e), nameStart: s, nameEnd: e };
}

/**
 * 光标是否落在 "$(arg name)" 的 arg 名标识符上(全文 offset 扫描,支持跨行——与 dollarVarAt 同法,
 * 不再限定单行;命中返回名字与起止 offset)。
 * 规则:光标前的**最近一个未闭合 "$(…)"**(无 ")" 或 ")" 在光标后)内,从 "$(" 到名字之间必须为
 * `[可选空白(含换行)] + arg + [空白(含换行)]`;名字 = 光标处词字符(与符号表同口径 [A-Za-z0-9_]+);
 * 光标落在 "arg" 关键字/空白上 → undefined(无名字可跳)。
 * 说明:$(arg) 面强制走 kind=arg——即使文件里存在同名 property 桥接(<xacro:property value="$(arg x)">),
 * 它读的仍是命令行参数,不被 property 遮蔽。
 */
export function dollarParenArgAt(
    document: vscode.TextDocument,
    position: vscode.Position
): { name: string; start: number; end: number } | undefined {
    const text = document.getText();
    const off = document.offsetAt(position);
    // 向前找光标前最近的、尚未闭合(或闭合在光标后)的 "$("
    const re = /\$\(/g;
    let m: RegExpExecArray | null;
    let open = -1;
    while ((m = re.exec(text)) !== null) {
        if (m.index >= off) {
            break;
        }
        const close = text.indexOf(")", m.index + 2);
        if (close < 0 || close >= off) {
            open = m.index; // 扫描向后推进,最终留下的 = 最近的未闭合 "$("
        }
    }
    if (open < 0) {
        return undefined;
    }
    // 光标处词字符(名字;词边界判断与符号名同口径)
    const isWord = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
    let s = off;
    while (s > open + 2 && isWord(text[s - 1])) {
        s--;
    }
    let e = off;
    while (e < text.length && isWord(text[e])) {
        e++;
    }
    if (s === e) {
        return undefined; // 光标不在名字字符上(arg 关键字/空白)
    }
    // "$(" 到名字之间必须是 [空白]* + arg + [空白]+(空白含换行)
    const head = text.slice(open + 2, s);
    if (!/^\s*arg\s+$/.test(head)) {
        return undefined; // 非 $(arg …) 形态($(find / $(env …)
    }
    return { name: text.slice(s, e), start: s, end: e };
}

/**
 * 解析 ${name} 变量引用的目标(形参遮蔽优先,2026-09-06 用户反馈):
 *  1) 引用处于某宏体内且 name 是该宏的形参 → 定位到该形参(优先 params 列表里的 token,
 *     折行/带默认值亦可;取不到再落宏 name 值)——宏形参是"传入参数"定义处;
 *  2) 否则按 property → arg 解析(同文件优先/可见集,内部含兜底)。
 * 注意:不落入"以 ${name} 原文匹配 link/joint 定义元素"的字面路径——宏体模板字面量不是真定义。
 * 返回 range 统一为 Range | Position(定义处优先 Range:跳转后 VS Code 全选名称字符串)。
 */
export function resolveDollarRef(
    graph: IncludeGraph,
    document: vscode.TextDocument,
    spans: MacroParamSpan[],
    name: string,
    nameStart: number
): { uri: vscode.Uri; range: vscode.Range | vscode.Position } | undefined {
    const span = enclosingMacroSpan(spans, nameStart);
    if (span && span.params.has(name)) {
        log.trace(`xacro 变量跳转(宏形参遮蔽):${name} → 宏 ${span.macroName ?? "?"} 形参`);
        const docText = document.getText();
        // ① params 列表里该参数的 token(可跨行开标签;如 kind:=box 只选 kind)
        const paramR = macroParamRange(document, span, name);
        if (paramR) {
            return { uri: document.uri, range: paramR };
        }
        // ② 回退:宏 name 值(整选宏名)
        const macroPos = document.positionAt(span.from);
        const nameCol = nameAttrColumn(docText, macroPos.line);
        if (span.macroName && nameCol !== undefined) {
            const lineLen = (docText.split(/\r?\n/)[macroPos.line] ?? "").length;
            return {
                uri: document.uri,
                range: new vscode.Range(
                    new vscode.Position(macroPos.line, nameCol),
                    new vscode.Position(macroPos.line, Math.min(nameCol + span.macroName.length, lineLen))
                )
            };
        }
        return { uri: document.uri, range: new vscode.Position(macroPos.line, nameCol ?? macroPos.character) };
    }
    const pos = document.positionAt(nameStart);
    const def = graph.findSymbol(document.uri, pos, name, "property")
        || graph.findSymbol(document.uri, pos, name, "arg");
    if (def) {
        log.trace(`xacro 变量跳转:${name} -> ${def.uri.fsPath}:${def.line}`);
        return {
            uri: def.uri,
            range: symbolNameRange(graph, def)
                ?? new vscode.Position(def.line, symbolAnchorColumn(graph, def))
        };
    }
    return undefined;
}

/**
 * 定义行上 name 属性值的起始列(UTF-16 code-unit 列,与 VS Code 一致)。
 * 形如 <xacro:macro name="bracket_mount" ...> → 返回 'b' 所在列。
 * 取行内最后一个 '<' 与最近 '>' 之间的开标签区,在其中找 name=。
 * 找不到(如属性折行等)→ undefined,调用方回退原锚点。
 */
export function nameAttrColumn(text: string, defLine: number): number | undefined {
    const line = (text.split(/\r?\n/)[defLine] ?? "");
    const lt = line.lastIndexOf("<");
    const gt = line.indexOf(">", lt + 1);
    const base = lt >= 0 ? lt + 1 : 0;
    const inner = gt > lt ? line.slice(lt + 1, gt) : line.slice(base);
    const m = /\bname\s*=\s*["']/.exec(inner);
    if (!m) {
        return undefined;
    }
    // value 首字符 = 引号后一列
    return base + m.index + m[0].length;
}

/** 符号定义跳转的锚点列:优先 name 值列;无则退回符号记录列(标签起始) */
export function symbolAnchorColumn(graph: IncludeGraph, def: SymbolRef): number {
    const node = graph.getFile(def.uri);
    if (node) {
        const col = nameAttrColumn(node.text, def.line);
        if (col !== undefined) {
            return col;
        }
    }
    return def.column;
}

/**
 * 符号定义处"名称字符串"的 Range(跳转后 VS Code 会全选名称,光标落在名称前,对齐 cpp 体验)。
 * 名称 = name 属性值(def.name 可能与文件文本有出入,越界自动截断到行尾);取不到返回 undefined。
 */
export function symbolNameRange(graph: IncludeGraph, def: SymbolRef): vscode.Range | undefined {
    const node = graph.getFile(def.uri);
    if (!node) {
        return undefined;
    }
    const col = nameAttrColumn(node.text, def.line);
    if (col === undefined) {
        return undefined;
    }
    const lines = node.text.split(/\r?\n/);
    const lineText = lines[def.line] ?? "";
    const endCol = Math.min(col + def.name.length, lineText.length);
    return new vscode.Range(new vscode.Position(def.line, col), new vscode.Position(def.line, endCol));
}

/** 宏形参在 params 属性值里的 token Range(如 params="density kind:=box …" 里的 density/kind)。
 *  宏开标签可能跨行(过长折行);返回 undefined 时调用方回退宏名 Range / 宏起始位置。 */
export function macroParamRange(
    document: vscode.TextDocument,
    span: MacroParamSpan,
    name: string
): vscode.Range | undefined {
    const text = document.getText();
    const gt = text.indexOf(">", span.from);
    if (gt < 0 || gt > span.to) {
        return undefined;
    }
    const open = text.slice(span.from, gt + 1);
    const qm = /\bparams\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(open);
    if (!qm) {
        return undefined;
    }
    const content = qm[1] ?? qm[2];
    const contentAt = qm[0].indexOf(content);
    if (contentAt < 0) {
        return undefined;
    }
    const valBase = span.from + qm.index + contentAt;
    const tokRe = /[A-Za-z0-9_]+/g;
    let tm: RegExpExecArray | null;
    while ((tm = tokRe.exec(content)) !== null) {
        if (tm[0] === name) {
            const s = valBase + tm.index;
            return new vscode.Range(document.positionAt(s), document.positionAt(s + name.length));
        }
    }
    return undefined;
}

/** 定位光标所在属性(lezer cursorAt;跨行/单引号原生支持,替代旧 attrValueAt 单行正则)。
 *  XG6:传入缓存树(graph.getDocument(...).tree)免重复解析;缺省自解析(向后兼容)。 */
export function attrAtDocument(document: vscode.TextDocument, position: vscode.Position, tree?: Tree): { attrName: string; value: string } | undefined {
    const text = document.getText();
    return attrAtCursor(tree ?? parseXml(text), text, document.offsetAt(position));
}

// ===================== ns 命名空间与点链导航(XG8/XG12,2026-09-25;设计 14 §3) =====================
// XG12:N 级寻址核心迁至 ui/ns-resolve.ts(diagnostic 需引用且不得与 provider-utils 成环);
// 此处保留转发导出,既有消费方 import 路径不变。

import {
    resolveNsQualified,
    nsDeclHopAt,
    collectNsTable,
    dottedMacroNameAt
} from "./ns-resolve";
export { resolveNsQualified, nsDeclHopAt, collectNsTable, dottedMacroNameAt };
export type { NsHop, NsResolved, NsTable } from "./ns-resolve";

/**
 * ns 名 → include 目标文件(XG7 自 completion-provider 上移共享)。
 * 对齐图内 include 边:同文档序实例 ↔ 同行边;无 ns= 属性 / 目标未入图 → undefined。
 */
export function nsIncludeTarget(
    graph: IncludeGraph | undefined,
    docModel: XacroDocument,
    docUri: vscode.Uri,
    ns: string
): vscode.Uri | undefined {
    const fileNode = graph?.getFile(docUri);
    if (!fileNode) {
        return undefined;
    }
    const inst = (docModel.tags.get("include") ?? []).find(i => i.attrs.get("ns")?.value === ns);
    if (!inst) {
        return undefined;
    }
    const line = fileNode.lineStarts.length > 0
        ? offsetToLine(fileNode.lineStarts, inst.info.spanFrom)
        : 0;
    const edge = fileNode.includes.find(e => e.line === line);
    return edge?.target;
}

/** offset → 行号(0 基,二分;lineStarts 来自 FileNode) */
function offsetToLine(lineStarts: number[], offset: number): number {
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

/** XG8 旧口径属性点链(保留导出;内部已升级走 N 级寻址) */
export function resolveDollarDottedRef(
    graph: IncludeGraph,
    docModel: XacroDocument,
    document: vscode.TextDocument,
    dv: { name: string; nameStart: number; nameEnd: number }
): { uri: vscode.Uri; range: vscode.Range | vscode.Position } | undefined {
    const text = docModel.text;
    const isW = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
    const chBefore = dv.nameStart > 0 ? text[dv.nameStart - 1] : "";
    const chAfter = dv.nameEnd < text.length ? text[dv.nameEnd] : "";
    if (chBefore !== "." && chAfter !== ".") {
        return undefined;
    }
    // 向两侧扩展完整链 ident(.ident)*
    let start = dv.nameStart;
    let end = dv.nameEnd;
    while (start > 2 && text[start - 1] === "." && isW(text[start - 2])) {
        let s = start - 2;
        while (s > 0 && isW(text[s - 1])) {
            s--;
        }
        start = s;
    }
    while (end < text.length - 1 && text[end] === "." && isW(text[end + 1])) {
        let e = end + 1;
        while (e < text.length && isW(text[e])) {
            e++;
        }
        end = e;
    }
    const chain = text.slice(start, end).split(".");
    let segIdx = 0;
    let acc = start;
    for (let i = 0; i < chain.length; i++) {
        if (dv.nameStart >= acc && dv.nameStart < acc + chain[i].length) {
            segIdx = i;
            break;
        }
        acc += chain[i].length + 1;
    }
    const pos = document.positionAt(dv.nameStart);
    const head = chain[0];
    // 非末段(head/中段)→ 该级 ns= 声明
    if (segIdx < chain.length - 1) {
        const hop = nsDeclHopAt(graph, docModel, document.uri, chain, segIdx);
        if (hop) {
            return {
                uri: hop.uri,
                range: new vscode.Range(document.positionAt(hop.valueFrom), document.positionAt(hop.valueTo))
            };
        }
        return undefined;
    }
    // 末段 → N 级寻址属性
    const hit = resolveNsQualified(graph, docModel, document.uri, chain, "property");
    if (hit) {
        log.trace(`xacro 点链跳转(ns):${chain.join(".")} → ${path.basename(hit.ref.uri.fsPath)}:${hit.ref.line + 1}`);
        return {
            uri: hit.ref.uri,
            range: symbolNameRange(graph, hit.ref) ?? new vscode.Position(hit.ref.line, symbolAnchorColumn(graph, hit.ref))
        };
    }
    // 头是普通属性(props.a 形态,非 ns):跳头属性定义
    const def = graph.findSymbol(document.uri, pos, head, "property");
    if (def) {
        log.trace(`xacro 点链跳转(属性头):${head} → ${path.basename(def.uri.fsPath)}:${def.line + 1}`);
        return {
            uri: def.uri,
            range: symbolNameRange(graph, def) ?? new vscode.Position(def.line, symbolAnchorColumn(graph, def))
        };
    }
    return undefined;
}

/**
 * xacro:insert_block name 引用解析(XG8):宏定义 `*`/`**` 参数优先(官方查表序),
 * 无所在宏时落块属性(官方块属性存 **name,符号表按 nameAttr 原名)。
 */
export function resolveInsertBlockRef(
    graph: IncludeGraph,
    docModel: XacroDocument,
    document: vscode.TextDocument,
    name: string,
    nameStart: number
): { uri: vscode.Uri; range: vscode.Range | vscode.Position } | undefined {
    const inst = (docModel.tags.get("insert_block") ?? [])
        .find(i => i.info.spanFrom <= nameStart && nameStart < i.info.spanTo);
    if (inst) {
        const macroDef = docModel.symbols.macros
            .find(mm => mm.info.spanFrom <= inst.info.spanFrom && inst.info.spanFrom < mm.info.spanTo);
        const param = macroDef?.params.find(p => p.name === "*" + name || p.name === "**" + name);
        if (param) {
            log.trace(`xacro insert_block:${name} → 宏 ${macroDef!.name} 参数 ${param.name}`);
            return {
                uri: document.uri,
                range: new vscode.Range(document.positionAt(param.nameFrom), document.positionAt(param.nameTo))
            };
        }
    }
    const pos = document.positionAt(nameStart);
    const def = graph.findSymbol(document.uri, pos, name, "property");
    if (def) {
        log.trace(`xacro insert_block:${name} → 块属性 ${path.basename(def.uri.fsPath)}:${def.line + 1}`);
        return {
            uri: def.uri,
            range: symbolNameRange(graph, def) ?? new vscode.Position(def.line, symbolAnchorColumn(graph, def))
        };
    }
    return undefined;
}

/**
 * 光标所在属性 + 属性值绝对偏移(值起点 valueFrom / 值末 valueTo)。
 * 用途:跳转可见性判定锚定"值起点"而非光标子位置——避免同一引用因光标落在值内不同字符
 * (或落点受先前光标影响)得到不同判定结果(2026-09-07 用户反馈)。
 * 光标在属性名上时 valueFrom=-1(无值可锚),调用方回退光标位。
 * XG6:传入缓存树(graph.getDocument(...).tree)免重复解析;缺省自解析(向后兼容)。
 */
export function attrWithOffsetsAt(
    document: vscode.TextDocument,
    position: vscode.Position,
    tree?: Tree
): { attrName: string; value: string; valueFrom: number; valueTo: number } | undefined {
    const text = document.getText();
    const offset = document.offsetAt(position);
    let node = (tree ?? parseXml(text)).cursorAt(offset).node;
    while (node) {
        if (node.name === "Attribute") {
            const an = node.getChild("AttributeName");
            if (!an) {
                return undefined;
            }
            const av = node.getChild("AttributeValue");
            if (av) {
                return {
                    attrName: text.slice(an.from, an.to),
                    value: text.slice(av.from + 1, av.to - 1),
                    valueFrom: av.from + 1,
                    valueTo: av.to - 1
                };
            }
            return { attrName: text.slice(an.from, an.to), value: "", valueFrom: -1, valueTo: -1 };
        }
        // 2026-09-13:parent 可达 null——循环以 while(node) 判空收尾;断言仅类型收窄,运行时不变
        node = node.parent!;
    }
    return undefined;
}

// ===================== 文档注释内文清洗(RE-2,2026-09-30;用户裁定 verbatim) =====================

/**
 * <!-- ... --> 内文 verbatim 清洗(hover extractLeadingComment / 补全 adjacentCommentAbove 共用,
 * 消除双实现):仅去 \r 与外壳放置痕迹(紧跟 <!-- 的一个换行、--> 前的一个换行);
 * 换行、行首缩进、块内空行全部原样保留——悬浮框以代码块渲染,缩进与源文本一一对应。
 * 纯空白内容 → undefined(不渲染)。
 */
export function verbatimCommentInner(raw: string): string | undefined {
    let inner = raw.replace(/\r/g, "");
    if (inner.startsWith("\n")) {
        inner = inner.slice(1);
    }
    if (inner.endsWith("\n")) {
        inner = inner.slice(0, -1);
    }
    return inner.trim().length > 0 ? inner : undefined;
}
