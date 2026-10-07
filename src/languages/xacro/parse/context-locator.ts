/**
 * context-locator — 光标上下文定位器(设计 02,方案 A:@lezer/xml)
 *
 * 把光标 offset"精确映射为元素/属性上下文",供补全(04)与跳转(03)判断。
 * 替代旧 completion-provider.isInsideTag(只数 < >):跨行标签/注释/CDATA/编辑中未闭合均正确。
 *
 * XG6(2026-09-24):拆出 getCursorContextFromTree(tree, text, document, pos) 核心——
 * 调用方传入 IncludeGraph.getDocument(...) 缓存的树即免重复解析(X-F4);
 * 原 getCursorContext(document, pos) 签名保留(内部自解析,向后兼容)。
 *
 * 实测边界(cursorAt 在 < 边界/属性值引号上返回父节点):
 *  - cursorAt 在 "<" 上可能返回外层 Element(而非 StartTag)→ tagStart 需配合行文本判断
 *  - cursorAt 在属性值引号/ "=" 上返回 Attribute → 用 offset 与 AttributeValue 范围判定角色
 */
import * as vscode from "vscode";
import { parseXml, elementTagInfo } from "../../shared/xml-utils";
import type { Tree } from "@lezer/common";
import type { SyntaxNode } from "@lezer/common";

/** 光标所在语法体 */
export type CursorRole = "tagName" | "attrName" | "attrValue" | "text" | "tagStart";

/** 光标上下文 */
export interface CursorContext {
    elementName: string;      // 光标所在元素的标签名;不在元素内则为 ""
    role: CursorRole;
    attrName?: string;        // role=attrValue/attrName 时的属性名
    isXacro: boolean;         // 是否在 xacro 前缀开标签内
    inComment: boolean;       // 是否在 <!-- --> 注释内
    inTag: boolean;           // 是否在某个开标签 <...> 内部(不含注释;tagStart 视为未真正进入)
}

/** 定位光标上下文(便捷入口:自解析;有缓存树时请用 getCursorContextFromTree) */
export function getCursorContext(document: vscode.TextDocument, pos: vscode.Position): CursorContext {
    const text = document.getText();
    return getCursorContextFromTree(parseXml(text), text, document, pos);
}

/** 定位光标上下文(核心:调用方提供缓存 lezer 树,XG6) */
export function getCursorContextFromTree(tree: Tree, text: string, document: vscode.TextDocument, pos: vscode.Position): CursorContext {
    const offset = document.offsetAt(pos);
    const lineBefore = text.slice(Math.max(0, offset - (pos.character + 1)), offset);

    const node = tree.cursorAt(offset).node;

    // ① 注释内
    let cur: SyntaxNode | null = node;
    while (cur) {
        if (cur.name === "Comment") {
            return { elementName: "", role: "text", inComment: true, isXacro: false, inTag: false };
        }
        cur = cur.parent;
    }

    // ② 最近 Element 祖先(含光标自身)
    const justTypedOpen = /<\s*$/.test(lineBefore); // 行内光标前以 < 结尾(含尾随空格)
    let elem: SyntaxNode | null = node;
    while (elem && elem.name !== "Element") {
        elem = elem.parent;
    }
    const elementName = elem ? (elementTagInfo(elem, text).tag ?? "") : "";
    const isXacro = elementName.startsWith("xacro:");
    if (!elem) {
        // 未解析出 Element(如刚输入 < 尚未闭合,lezer 恢复为错误节点):行内仅 < 结尾 → tagStart
        return { elementName, role: justTypedOpen ? "tagStart" : "text", isXacro, inComment: false, inTag: false };
    }

    const open = elem.getChild("OpenTag") || elem.getChild("SelfClosingTag");
    if (open) {
        // ③ 光标是否落在某属性上(按子节点范围判断,不依赖 cursorAt 返回节点)
        for (const a of open.getChildren("Attribute")) {
            const an = a.getChild("AttributeName");
            if (!an) {
                continue;
            }
            const attrName = text.slice(an.from, an.to);
            const av = a.getChild("AttributeValue");
            if (av && offset >= av.from && offset < av.to) {
                return { elementName, role: "attrValue", attrName, isXacro, inComment: false, inTag: true };
            }
            if (offset >= an.from && offset < an.to) {
                return { elementName, role: "attrName", attrName, isXacro, inComment: false, inTag: true };
            }
            // 2026-09-13:补 av 守卫——原实现此分支在 av 为 null(输入中的不完整属性)时会 TypeError;
            // 该分支语义本就以 av 有效为前提,守卫后跳过
            if (av && offset >= an.to && offset < av.from) {
                // 名与值之间(含 "=" 与引号):归 attrName(仍视为在标签内,不提供标签级补全)
                return { elementName, role: "attrName", attrName, isXacro, inComment: false, inTag: true };
            }
        }

        // ④ 标签名上
        const tn = open.getChild("TagName");
        if (tn && offset >= tn.from && offset < tn.to) {
            return { elementName, role: "tagName", isXacro, inComment: false, inTag: true };
        }

        // ⑤ tagStart:刚输入 <(行内光标前以 < 结尾,含尾随空格),或光标恰在开标签起始 "<" 处
        if (justTypedOpen || offset <= open.from + 1) {
            return { elementName, role: "tagStart", isXacro, inComment: false, inTag: false };
        }

        // ⑥ 开标签内部(空白 / ">" 前)
        if (offset > open.from && offset < open.to) {
            return { elementName, role: "text", isXacro, inComment: false, inTag: true };
        }
    }

    // ⑦ 元素文本/闭合标签名/元素间空白
    return { elementName, role: "text", isXacro, inComment: false, inTag: false };
}
