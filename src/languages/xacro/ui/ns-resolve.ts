/**
 * ns-resolve — xacro 命名空间点号链的 N 级静态寻址(XG12,2026-09-25)。
 *
 * 官方语义镜像(13 号 §3.5/§6.2,ros/xacro resolve_macro/process_include):
 *  - 点号调用 `xacro:kit.kit_plate` 按段切分,逐级经 **ns= include** 进入子命名空间表;
 *  - **无 ns 嵌套 include 向下传染**(官方 func(include, ns_macros) 递归传表):
 *    末段符号在当前表 = 目标文件自身 + 其传递无 ns 嵌套;
 *  - 定义侧名字不得含点,点号只用于寻址;链上任一跳 include 悬空 → 解析失败(两态模型)。
 *
 * 消费方:definition/hover(点名分段导航)、diagnostic(D4/D14 ns 感知)、completion(ns 链候选)。
 * 独立成模块的原因:diagnostic 与 provider-utils 之间不得新增循环依赖
 * (provider-utils 已引用 diagnostic 的宏跨度工具);本模块只依赖 core/parse。
 */
import * as vscode from "vscode";
import * as path from "path";
import { getLogger } from "../../../logger";
import type { IncludeGraph, SymbolRef } from "../core/include-graph";
import { parseXacroDocument } from "../parse/xacro-document";
import type { XacroDocument } from "../parse/xacro-document";

const log = getLogger("xacro-ns");

/** offset → 行号(0 基,二分;lineStarts 来自 FileNode) */
function lineAtOffset(lineStarts: number[], offset: number): number {
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

/** FileNode 的文档模型(惰性解析并回填 doc 字段,与图共享同一次解析) */
function nodeDoc(graph: IncludeGraph, fn: NonNullable<ReturnType<IncludeGraph["getFile"]>>): XacroDocument {
    if (!fn.doc) {
        fn.doc = parseXacroDocument(fn.text, fn.uri);
    }
    return fn.doc;
}

/** ns 链的第 i 跳声明(include 标签的 ns= 属性值);head 段/中段导航落点 */
export interface NsHop {
    ns: string;
    uri: vscode.Uri;          // 声明所在文件(include 标签在此)
    valueFrom: number;        // ns 属性值起点
    valueTo: number;
    target: vscode.Uri;       // 该 include 的目标文件
}

export interface NsResolved {
    kind: "macro" | "property";
    name: string;             // 末段裸名(符号表口径)
    ref: SymbolRef;           // 命中符号(含 params/value)
    hops: NsHop[];            // 逐级声明(hops[i] 对应 segs[i])
}

/**
 * 点号链寻址:`kit.plate` / `kit.sub.nut`。
 *  - 每级经 ns= include 下钻;segs[i] 必须匹配当前表里 ns= 恰为该名的 include;
 *  - 末段符号在"当前表"(目标文件自身 + 无 ns 嵌套传染,传递)里查;
 *  - visited 双重防环(链路径 + 传染展开)。
 */
export function resolveNsQualified(
    graph: IncludeGraph,
    docModel: XacroDocument,
    entryUri: vscode.Uri,
    segs: string[],
    kind: "macro" | "property"
): NsResolved | undefined {
    if (segs.length === 0) {
        return undefined;
    }
    const hops: NsHop[] = [];

    const lookupInTable = (fileUri: vscode.Uri, name: string, visited: Set<string>): SymbolRef | undefined => {
        const key = fileUri.toString();
        if (visited.has(key)) {
            return undefined;
        }
        visited.add(key);
        const fn = graph.getFile(fileUri);
        if (!fn) {
            return undefined;
        }
        graph.collectSymbols(fn);
        const own = fn.symbols.get(kind)?.get(name);
        if (own) {
            return own;
        }
        const doc = nodeDoc(graph, fn);
        for (const inst of doc.tags.get("include") ?? []) {
            if (inst.attrs.get("ns")?.value !== undefined) {
                continue; // ns= 嵌套是子表,不在本表
            }
            const edge = fn.includes.find(e => e.line === lineAtOffset(fn.lineStarts, inst.info.spanFrom));
            if (!edge?.target) {
                continue;
            }
            const hit = lookupInTable(edge.target, name, visited);
            if (hit) {
                return hit;
            }
        }
        return undefined;
    };

    const walk = (fileUri: vscode.Uri, rest: string[], visited: Set<string>): SymbolRef | undefined => {
        const key = fileUri.toString() + "::" + rest.join(".");
        if (visited.has(key)) {
            return undefined;
        }
        visited.add(key);
        const fn = graph.getFile(fileUri);
        if (!fn) {
            return undefined;
        }
        if (rest.length === 1) {
            return lookupInTable(fileUri, rest[0], new Set());
        }
        const doc = nodeDoc(graph, fn);
        for (const inst of doc.tags.get("include") ?? []) {
            const ns = inst.attrs.get("ns")?.value;
            if (ns !== rest[0]) {
                continue;
            }
            const edge = fn.includes.find(e => e.line === lineAtOffset(fn.lineStarts, inst.info.spanFrom));
            if (!edge?.target) {
                continue; // 悬空边:链断,不猜
            }
            const nsAttr = inst.attrs.get("ns")!;
            hops.push({ ns, uri: fileUri, valueFrom: nsAttr.valueFrom, valueTo: nsAttr.valueTo, target: edge.target });
            const hit = walk(edge.target, rest.slice(1), visited);
            if (hit) {
                return hit;
            }
            hops.pop();
        }
        return undefined;
    };

    const ref = walk(entryUri, segs, new Set());
    if (!ref) {
        return undefined;
    }
    log.trace(`ns 寻址:${segs.join(".")}(${kind}) → ${path.basename(ref.uri.fsPath)}:${ref.line + 1}`);
    return { kind, name: segs[segs.length - 1], ref, hops };
}

/**
 * 第 idx 段的 ns 声明跳(不要求链走通——head/中段导航只依赖已落地的 include 边)。
 * idx 必须 < segs.length-1(末段是符号不是声明);未命中返回 undefined。
 */
export function nsDeclHopAt(
    graph: IncludeGraph,
    docModel: XacroDocument,
    entryUri: vscode.Uri,
    segs: string[],
    idx: number
): NsHop | undefined {
    if (idx >= segs.length - 1) {
        return undefined;
    }
    let fileUri = entryUri;
    for (let i = 0; i <= idx; i++) {
        const fn = graph.getFile(fileUri);
        if (!fn) {
            return undefined;
        }
        const doc = nodeDoc(graph, fn);
        const inst = (doc.tags.get("include") ?? []).find(x => x.attrs.get("ns")?.value === segs[i]);
        if (!inst) {
            return undefined;
        }
        const edge = fn.includes.find(e => e.line === lineAtOffset(fn.lineStarts, inst.info.spanFrom));
        const nsAttr = inst.attrs.get("ns")!;
        if (i === idx) {
            return edge
                ? { ns: segs[i], uri: fileUri, valueFrom: nsAttr.valueFrom, valueTo: nsAttr.valueTo, target: edge.target }
                : { ns: segs[i], uri: fileUri, valueFrom: nsAttr.valueFrom, valueTo: nsAttr.valueTo, target: fileUri };
        }
        if (!edge?.target) {
            return undefined;
        }
        fileUri = edge.target;
    }
    return undefined;
}

export interface NsTable {
    macros: SymbolRef[];
    props: SymbolRef[];
    namespaces: string[];     // 该表下可直接点进去的子命名空间(ns= 名)
}

/**
 * 收集 ns 链终点"表"的全部可见名(补全数据源):
 * 宏/属性含无 ns 嵌套传染(全量合并),namespaces 为该文件 ns= include 名。链走不通 → undefined。
 */
export function collectNsTable(
    graph: IncludeGraph,
    docModel: XacroDocument,
    entryUri: vscode.Uri,
    segs: string[]
): NsTable | undefined {
    let cur = entryUri;
    for (let i = 0; i < segs.length; i++) {
        const fn = graph.getFile(cur);
        if (!fn) {
            return undefined;
        }
        const doc = nodeDoc(graph, fn);
        const inst = (doc.tags.get("include") ?? []).find(x => x.attrs.get("ns")?.value === segs[i]);
        if (!inst) {
            return undefined;
        }
        const edge = fn.includes.find(e => e.line === lineAtOffset(fn.lineStarts, inst.info.spanFrom));
        if (!edge?.target) {
            return undefined;
        }
        cur = edge.target;
    }
    const fn = graph.getFile(cur);
    if (!fn) {
        return undefined;
    }
    const macros: SymbolRef[] = [];
    const props: SymbolRef[] = [];
    const seen = new Set<string>();
    const gather = (uri: vscode.Uri, visited: Set<string>): void => {
        const key = uri.toString();
        if (visited.has(key)) {
            return;
        }
        visited.add(key);
        const f = graph.getFile(uri);
        if (!f) {
            return;
        }
        graph.collectSymbols(f);
        for (const s of f.symbols.get("macro")?.values() ?? []) {
            const k = "m:" + s.name;
            if (!seen.has(k)) { seen.add(k); macros.push(s); }
        }
        for (const s of f.symbols.get("property")?.values() ?? []) {
            const k = "p:" + s.name;
            if (!seen.has(k)) { seen.add(k); props.push(s); }
        }
        const doc = nodeDoc(graph, f);
        for (const inst of doc.tags.get("include") ?? []) {
            if (inst.attrs.get("ns")?.value !== undefined) {
                continue;
            }
            const edge = f.includes.find(e => e.line === lineAtOffset(f.lineStarts, inst.info.spanFrom));
            if (edge?.target) {
                gather(edge.target, visited);
            }
        }
    };
    gather(cur, new Set());
    const doc = nodeDoc(graph, fn);
    const namespaces = Array.from(new Set(
        (doc.tags.get("include") ?? []).map(x => x.attrs.get("ns")?.value).filter((v): v is string => !!v)
    ));
    return { macros, props, namespaces };
}

/**
 * 开标签内点号宏名分段:光标词必须落在 `<xacro:a.b.c` 的某一段上。
 * 匹配约束:tag 名必须紧跟 "<"(排除属性值里的 xacro: 字样);undefined = 光标不在点名内。
 */
export function dottedMacroNameAt(
    lineText: string,
    wordRange: vscode.Range
): { segs: string[]; segIdx: number } | undefined {
    const re = /xacro:[A-Za-z_][A-Za-z0-9_.]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
        if (lineText[m.index - 1] !== "<") {
            continue; // 仅开标签名位(紧跟 <)
        }
        const nameStart = m.index + 6;
        const nameEnd = m.index + m[0].length;
        if (wordRange.start.character < nameStart || wordRange.end.character > nameEnd) {
            continue;
        }
        const name = m[0].slice(6);
        const segs = name.split(".");
        if (segs.length < 2) {
            return undefined; // 无点 → 普通宏,交回原路径
        }
        const dotsBefore = lineText.slice(nameStart, wordRange.start.character).split(".").length - 1;
        if (segs[dotsBefore] !== lineText.slice(wordRange.start.character, wordRange.end.character)) {
            return undefined;
        }
        return { segs, segIdx: dotsBefore };
    }
    return undefined;
}
