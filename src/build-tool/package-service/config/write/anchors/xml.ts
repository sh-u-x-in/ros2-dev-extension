// (c) MIT

/**
 * @file xml.ts
 * anchors/ package.xml 增量插入(2026-09-04 定调):用第三方 @lezer/xml(xml-utils)解析定位,
 * 使用方(configure-actions 等)按**依赖类别**直接插入——一个 package.xml 有多个插入点,
 * 每类依赖(<buildtool_depend>/<build_depend>/<build_export_depend>/<exec_depend>/<depend>/
 * <test_depend>/<member_of_group>/<doc_depend>)各归其位:同类元素聚在一起时插到**同类的尾部**,
 * 无同类时插到依赖区整体末尾,绝不越过根闭合标签(内容落到 </package> 后 = XML 非法)。
 * 纯 TS,零 vscode 依赖(仅 @lezer/xml),可无头测。幂等判定不依赖本层(走文本/parse)。
 */

import { parseXml, elementTagInfo, forEachElement } from "../../../../../languages/shared/xml-utils";
import type { SyntaxNode } from "@lezer/common";

/** package.xml 依赖/声明类别(覆盖 5 类以上) */
export const XML_DEP_KINDS = [
    "buildtool_depend",
    "build_depend",
    "build_export_depend",
    "exec_depend",
    "depend",
    "test_depend",
    "doc_depend",
    "member_of_group",
] as const;

export type XmlDepKind = (typeof XML_DEP_KINDS)[number];

function isDepKind(tag: string | null): tag is XmlDepKind {
    return !!tag && (XML_DEP_KINDS as readonly string[]).includes(tag);
}

/** 根 <package> 直接子元素中 tag 为 kind 的最后一个元素的节点(无则 undefined) */
function lastOfKind(text: string, kind: XmlDepKind): { elem: SyntaxNode; endLineStart: number } | undefined {
    const tree = parseXml(text);
    let root: SyntaxNode | undefined;
    for (let c = tree.topNode.firstChild; c; c = c.nextSibling) {
        if (c.name === "Element") { root = c; break; }
    }
    if (!root) { return undefined; }
    let last: SyntaxNode | undefined;
    for (let c = root.firstChild; c; c = c.nextSibling) {
        if (c.name !== "Element") { continue; }
        const info = elementTagInfo(c, text);
        if (info.tag === kind) { last = c; }
    }
    if (!last) { return undefined; }
    const nl = text.indexOf("\n", last.to);
    return { elem: last, endLineStart: nl < 0 ? text.length : nl + 1 };
}

/**
 * 定位 kind 类依赖的插入点(字符偏移,新元素从该处写):
 *   同类已有元素 → 同类最后一个元素所在行行尾之后(保持同类连续);
 *   无同类但有其它依赖类 → 最后出现的依赖类元素之后(依赖区整体末尾);
 *   全无(他人手写空 package.xml)→ 根闭合标签前。
 */
export function locateXmlDepInsert(text: string, kind: XmlDepKind): number {
    const own = lastOfKind(text, kind);
    if (own) { return own.endLineStart; }
    const tree = parseXml(text);
    let root: SyntaxNode | undefined;
    for (let c = tree.topNode.firstChild; c; c = c.nextSibling) {
        if (c.name === "Element") { root = c; break; }
    }
    let lastDepEnd = -1;
    if (root) {
        for (let c = root.firstChild; c; c = c.nextSibling) {
            if (c.name !== "Element") { continue; }
            const info = elementTagInfo(c, text);
            if (isDepKind(info.tag)) {
                const nl = text.indexOf("\n", c.to);
                lastDepEnd = nl < 0 ? c.to : nl + 1;
            }
        }
    }
    if (lastDepEnd >= 0) { return lastDepEnd; }
    // 兜底:依赖元素惯例在 <export> 之前(若无 export 则根闭合前);落点取行首,保住行缩进
    const lineStart = (pos: number): number => text.lastIndexOf("\n", pos - 1) + 1;
    const exportAt = text.lastIndexOf("<export>");
    if (exportAt >= 0) { return lineStart(exportAt); }
    const close = text.lastIndexOf("</package>");
    if (close >= 0) { return lineStart(close); }
    return text.length;
}

/** 生成一条缩进的依赖元素文本(不含尾部换行),如 "  <exec_depend>std_msgs</exec_depend>" */
export function depElementLine(kind: XmlDepKind, name: string, indent?: string): string {
    const pad = indent ?? "  ";
    return pad + "<" + kind + ">" + name + "</" + kind + ">";
}

/**
 * 把一条依赖(或组声明)插入 package.xml 文本,落点见 locateXmlDepInsert(纯函数)。
 * 文本形如 <kind>name</kind>;返回新文本。
 */
export function insertXmlDepElement(text: string, kind: XmlDepKind, name: string, indent?: string, inlineComment?: string): string {
    const at = locateXmlDepInsert(text, kind);
    const line = depElementLine(kind, name, indent ?? "  ");
    const prefix = at > 0 && text[at - 1] === "\n" ? "" : "\n";
    // 2026-09-04 定稿:不做「解说注释行」,仅按需在该元素行尾内联一个标注
    // (如 `<!-- rde-ros-2 扩展生成 2026-09-04 01:30 -->`),每次插入单独带标、有迹可循
    const inline = inlineComment ? " " + inlineComment : "";
    return text.slice(0, at) + prefix + line + inline + "\n" + text.slice(at);
}

/** 根闭合标签前插入(chunk 为整段文本,含换行与缩进);根缺失时原样返回 */
export function insertBeforePackageClose(text: string, chunk: string): string {
    const close = text.lastIndexOf("</package>");
    if (close < 0) { return text; }
    return text.slice(0, close) + chunk + text.slice(close);
}

/** 首个 <name> ... </name> 的内容区间(经 lezer,注释内同名不误命中) */
export function nameTagSpan(text: string): { start: number; end: number } | undefined {
    const tree = parseXml(text);
    let found: { start: number; end: number } | undefined;
    forEachElement(tree.topNode, text, (elem, info) => {
        if (found || info.tag !== "name") { return; }
        const open = elem.getChild("OpenTag");
        const close = elem.getChild("CloseTag");
        if (open && close) { found = { start: open.to, end: close.from }; }
    });
    return found;
}

/** 根闭合标签位置(lezer 精确;注释内出现 </package> 不误命中) */
export function findPackageCloseTag(text: string): number {
    const tree = parseXml(text);
    let closeAt = -1;
    forEachElement(tree.topNode, text, (elem, info) => {
        if (info.tag === "package") {
            const close = elem.getChild("CloseTag");
            if (close) { closeAt = close.from; }
        }
    });
    return closeAt;
}