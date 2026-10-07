/**
 * xacro-document — xacro 单遍文档模型 + 按 uri+version 缓存(XG4,2026-09-24)。
 *
 * 设计:设计/xacro/14 §1.5/§2;消费方:core/include-graph(XG5)、ui/* providers(XG6)。
 * 目标:每文档版本**一次**解析(lezer 树 + `$` 词法 + 符号),五类 provider 共享
 * ——修审计 X-F4(hover 至多 3 次解析)、X-F3(表达式正则三处重复)。
 *
 * 语义对齐(13 号):
 *  - 固定标签 10 个,`xacro:` 前缀精确匹配;无前缀=普通元素(2.0.8 起);
 *  - 属性值逐个做 `$` 层词法(lexDollar);文本节点含 `$` 才词法(CDATA/注释不求值,官方语义);
 *  - 宏定义顺带 parseMacroParams;属性符号记录 value/default/scope/remove/lazy_eval/块属性;
 *  - 符号按文档序全量记录(不做"先定义后使用"裁剪——可见性仍归 IncludeGraph);
 *  - lezer 恢复式解析不抛错:无 OpenTag/SelfClosingTag 的伪 Element(tag=null)跳过(00 §7-3)。
 */
import * as vscode from "vscode";
import type { SyntaxNode, Tree } from "@lezer/common";
import { parseXml, forEachElement, elementTagInfo } from "../../shared/xml-utils";
import type { ElementInfo, AttrInfo } from "../../shared/xml-utils";
import { lexDollar, hasDollarConstruct } from "./xacro-lexer";
import type { DollarLexResult, LexIssue } from "./xacro-lexer";
import { parseMacroParams } from "./macro-params";
import type { MacroParam } from "./macro-params";
import { fixedTagOf, macroNameOf } from "./xacro-tags";
import type { FixedTag } from "./xacro-tags";

/** 固定标签实例 */
export interface XacroTagInstance {
    tag: FixedTag;
    info: ElementInfo;
    attrs: Map<string, AttrInfo>;
    /** tag==="macro" 时的 params 全语法解析结果 */
    macroParams?: MacroParam[];
}

/** 宏调用点(xacro: 前缀且非固定标签;含未知名——供 XG9"未知宏"诊断) */
export interface XacroMacroCall {
    name: string;
    info: ElementInfo;
    attrs: Map<string, AttrInfo>;
}

export interface XacroMacroDef {
    name: string;
    params: MacroParam[];
    info: ElementInfo;
    nameAttr: AttrInfo;
}

export interface XacroPropDef {
    name: string;
    value?: string;          // value 属性原文(未求值)
    hasDefault: boolean;     // default 属性存在(defaultValue 原文见 defaultAttr)
    defaultAttr?: AttrInfo;
    scope?: string;          // scope 属性原文(parent/global/其他)
    remove: boolean;         // 静态可判的布尔真值(get_boolean_value 口径)
    lazyEval?: boolean;      // 静态可判时给出;表达式/未给出 → undefined
    isBlock: boolean;        // 块属性:无 value、无 default、remove≠true(官方存储名前缀 **)
    info: ElementInfo;
    nameAttr: AttrInfo;
}

export interface XacroArgDef {
    name: string;
    defaultValue: string;
    info: ElementInfo;
    nameAttr: AttrInfo;
}

export interface XacroDocument {
    uri: vscode.Uri | undefined;
    text: string;
    tree: Tree;
    tags: Map<FixedTag, XacroTagInstance[]>;
    macroCalls: XacroMacroCall[];
    symbols: { macros: XacroMacroDef[]; props: XacroPropDef[]; args: XacroArgDef[] };
    /** 全部属性值 `$` 词法 issue(文本节点的 issue 同样收录——含 $ 的文本段解析时即词法) */
    dollarIssues: LexIssue[];
    /** 全部已词法的 `$` 段(属性值 + 含 $ 文本节点;XG9 诊断遍历用) */
    dollarSegments: ReadonlyArray<{ from: number; to: number; res: DollarLexResult }>;
    /** 取某 offset 所在"段"(属性值/文本节点)的 $ 词法结果;不在任何含 $ 段内 → undefined */
    dollarTokensAt(offset: number): DollarLexResult | undefined;
}

/** 静态布尔判定(get_boolean_value 口径:仅 true/True/false/False 或 int 可解析) */
export function staticBoolean(raw: string | undefined): boolean | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (raw === "true" || raw === "True") {
        return true;
    }
    if (raw === "false" || raw === "False") {
        return false;
    }
    if (/^[+-]?\d+$/.test(raw)) {
        return parseInt(raw, 10) !== 0;
    }
    return undefined; // 表达式等动态值,静态不可判
}

/** 解析 xacro 文档文本(纯函数;畸形输入恢复式产出部分结果,不抛错) */
export function parseXacroDocument(text: string, uri?: vscode.Uri): XacroDocument {
    const tree = parseXml(text);
    const tags = new Map<FixedTag, XacroTagInstance[]>();
    const macroCalls: XacroMacroCall[] = [];
    const symbols = { macros: [] as XacroMacroDef[], props: [] as XacroPropDef[], args: [] as XacroArgDef[] };
    const dollarIssues: LexIssue[] = [];
    /** 段(属性值/含 $ 文本节点)列表:from 起、to 止,词法结果 */
    const segments: Array<{ from: number; to: number; res: DollarLexResult }> = [];

    const attrMapOf = (info: ElementInfo): Map<string, AttrInfo> => {
        const m = new Map<string, AttrInfo>();
        for (const a of info.attrs) {
            if (!m.has(a.name)) {
                m.set(a.name, a);
            }
        }
        return m;
    };

    forEachElement(tree.topNode, text, (elem, info) => {
        if (info.tag === null) {
            return; // 恢复伪节点(无 OpenTag/SelfClosingTag)
        }
        const attrs = attrMapOf(info);
        // 属性值 $ 词法
        for (const a of info.attrs) {
            if (a.value !== undefined && a.valueFrom >= 0 && hasDollarConstruct(a.value)) {
                const res = lexDollar(a.value, a.valueFrom);
                segments.push({ from: a.valueFrom, to: a.valueTo, res });
                for (const issue of res.issues) {
                    dollarIssues.push(issue);
                }
            }
        }
        // 标签分发
        const fixed = fixedTagOf(info.tag);
        if (fixed) {
            const inst: XacroTagInstance = { tag: fixed, info, attrs };
            if (fixed === "macro") {
                const paramsAttr = attrs.get("params");
                inst.macroParams = parseMacroParams(paramsAttr?.value ?? "", paramsAttr && paramsAttr.valueFrom >= 0 ? paramsAttr.valueFrom : 0);
            }
            let arr = tags.get(fixed);
            if (!arr) {
                arr = [];
                tags.set(fixed, arr);
            }
            arr.push(inst);
            // 符号提取(macro/property/arg;其余固定标签由 tags 携带)
            if (fixed === "macro") {
                const nameAttr = attrs.get("name");
                if (nameAttr?.value) {
                    symbols.macros.push({
                        name: nameAttr.value,
                        params: inst.macroParams ?? [],
                        info, nameAttr
                    });
                }
            } else if (fixed === "property") {
                const nameAttr = attrs.get("name");
                if (nameAttr?.value) {
                    const valueAttr = attrs.get("value");
                    const defaultAttr = attrs.get("default");
                    const removeRaw = attrs.get("remove")?.value;
                    const remove = staticBoolean(removeRaw) === true;
                    const lazyRaw = attrs.get("lazy_eval")?.value;
                    const lazyEval = lazyRaw === undefined ? undefined : staticBoolean(lazyRaw);
                    symbols.props.push({
                        name: nameAttr.value,
                        value: valueAttr?.value,
                        hasDefault: defaultAttr !== undefined,
                        defaultAttr,
                        scope: attrs.get("scope")?.value,
                        remove,
                        lazyEval,
                        isBlock: valueAttr === undefined && defaultAttr === undefined && !remove,
                        info, nameAttr
                    });
                }
            } else if (fixed === "arg") {
                const nameAttr = attrs.get("name");
                if (nameAttr?.value) {
                    symbols.args.push({
                        name: nameAttr.value,
                        defaultValue: attrs.get("default")?.value ?? "",
                        info, nameAttr
                    });
                }
            }
            return;
        }
        const macroName = macroNameOf(info.tag);
        if (macroName) {
            macroCalls.push({ name: macroName, info, attrs });
        }
    });

    // 文本节点段(含 $ 才词法;CDATA/注释官方不求值,天然不在 Text 节点内)
    const walkText = (node: SyntaxNode): void => {
        if (node.name === "Text") {
            const seg = text.slice(node.from, node.to);
            if (hasDollarConstruct(seg)) {
                const res = lexDollar(seg, node.from);
                segments.push({ from: node.from, to: node.to, res });
                for (const issue of res.issues) {
                    dollarIssues.push(issue);
                }
            }
            return;
        }
        for (let c = node.firstChild; c; c = c.nextSibling) {
            walkText(c);
        }
    };
    walkText(tree.topNode);
    segments.sort((a, b) => a.from - b.from);

    return {
        uri, text, tree, tags, macroCalls, symbols, dollarIssues,
        dollarSegments: segments,
        dollarTokensAt(offset: number): DollarLexResult | undefined {
            for (const seg of segments) {
                if (offset >= seg.from && offset < seg.to) {
                    return seg.res;
                }
            }
            return undefined;
        }
    };
}

/**
 * 文档解析缓存:uri+version 键控,五类 provider 与 IncludeGraph 共享。
 * version 相同且 text 全等 → 命中免解析;任一变化 → 重解析并覆盖。
 */
export class XacroDocumentStore {
    private readonly cache = new Map<string, { version: number; text: string; doc: XacroDocument }>();

    get(uri: vscode.Uri, text: string, version: number): XacroDocument {
        const key = uri.toString();
        const hit = this.cache.get(key);
        if (hit && hit.version === version && hit.text === text) {
            return hit.doc;
        }
        const doc = parseXacroDocument(text, uri);
        this.cache.set(key, { version, text, doc });
        return doc;
    }

    invalidate(uri: vscode.Uri): void {
        this.cache.delete(uri.toString());
    }

    dispose(): void {
        this.cache.clear();
    }
}
