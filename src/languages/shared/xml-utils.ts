/**
 * xml-utils — @lezer/xml 共享只读工具(languages/shared,2026-08-29 自 languages/xacro/ 上移)。
 *
 * 一处实现、多处复用(纯函数/无状态,不缓存文档):
 *  - xacro:include-graph(scanIncludes/collectSymbols)、providers(引用跳转/属性值定位)、
 *    context-locator(光标上下文)、diagnostic-provider;
 *  - build-tool:package-core/scan/package-xml(package.xml 解析校验);
 *  - 未来:launch.xml 解析等(languages/launch)。
 * 定位:通用 XML 只读工具,不属于任何语言模块;依赖方经 languages/shared 引用。
 *
 * 关键勘误(00 §2):Element 不直接含 TagName/Attribute,而是
 *   Element → (OpenTag | SelfClosingTag) → TagName / Attribute*
 * 必须经 OpenTag/SelfClosingTag 层;AttributeValue 文本含引号,取值 slice(from+1, to-1)。
 *
 *
 * 关键勘误(00 §2):Element 不直接含 TagName/Attribute,而是
 *   Element → (OpenTag | SelfClosingTag) → TagName / Attribute*
 * 必须经 OpenTag/SelfClosingTag 层;AttributeValue 文本含引号,取值 slice(from+1, to-1)。
 */
import { parser as xmlParser } from "@lezer/xml";
import type { SyntaxNode, Tree } from "@lezer/common";

/** 单个属性信息(value 已去引号) */
export interface AttrInfo {
    name: string;
    value: string | undefined;   // 已去引号(单/双);无值属性为 undefined
    valueFrom: number;           // 值首字符 offset;-1 表示无值
    valueTo: number;             // 值末字符后一 offset(排他)
}

/** 单个 Element 的标签与属性信息 */
export interface ElementInfo {
    tag: string | null;
    spanFrom: number;            // Element 起始 offset("<")
    spanTo: number;              // Element 结束 offset(排他)
    attrs: AttrInfo[];
}

/** 解析 XML 文本,返回 lezer 树(恢复式解析,畸形输入不抛错) */
export function parseXml(text: string): Tree {
    return xmlParser.parse(text);
}

/** 取 Element 的标签与属性信息(须经 OpenTag|SelfClosingTag 层) */
export function elementTagInfo(elem: SyntaxNode, text: string): ElementInfo {
    const open = elem.getChild("OpenTag") || elem.getChild("SelfClosingTag");
    if (!open) {
        return { tag: null, spanFrom: elem.from, spanTo: elem.to, attrs: [] };
    }
    const tagNode = open.getChild("TagName");
    const attrs: AttrInfo[] = [];
    for (const a of open.getChildren("Attribute")) {
        const an = a.getChild("AttributeName");
        if (!an) {
            continue;
        }
        const av = a.getChild("AttributeValue");
        if (av) {
            attrs.push({
                name: text.slice(an.from, an.to),
                value: text.slice(av.from + 1, av.to - 1),
                valueFrom: av.from + 1,
                valueTo: av.to - 1
            });
        } else {
            attrs.push({ name: text.slice(an.from, an.to), value: undefined, valueFrom: -1, valueTo: -1 });
        }
    }
    return { tag: tagNode ? text.slice(tagNode.from, tagNode.to) : null, spanFrom: elem.from, spanTo: elem.to, attrs };
}

/** 递归遍历全部 Element,回调 (Element 节点, ElementInfo)。注释/CDATA 内不产生 Element,天然跳过 */
export function forEachElement(top: SyntaxNode, text: string, cb: (elem: SyntaxNode, info: ElementInfo) => void): void {
    const visit = (n: SyntaxNode): void => {
        if (n.name === "Element") {
            cb(n, elementTagInfo(n, text));
        }
        for (let c = n.firstChild; c; c = c.nextSibling) {
            visit(c);
        }
    };
    visit(top);
}

/** 在 lezer 树中定位 offset 所在属性(光标落在属性名或属性值上)。跨行/单引号原生支持。 */
export function attrAtCursor(tree: Tree, text: string, offset: number): { attrName: string; value: string } | undefined {
    const node = tree.cursorAt(offset).node;
    let cur: SyntaxNode | null = node;
    while (cur) {
        if (cur.name === "Attribute") {
            const an = cur.getChild("AttributeName");
            if (!an) {
                return undefined;
            }
            const attrName = text.slice(an.from, an.to);
            const av = cur.getChild("AttributeValue");
            if (av && offset >= av.from && offset <= av.to) {
                return { attrName, value: text.slice(av.from + 1, av.to - 1) };
            }
            if (offset >= an.from && offset <= an.to) {
                return { attrName, value: "" };
            }
            return undefined;
        }
        cur = cur.parent;
    }
    return undefined;
}

// ---------- XML 实体解码(LF-2,2026-10-01) ----------

const XML_ENTITY_MAP: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'"
};

/**
 * 解码 5 个标准 XML 实体(lezer 提取的 AttributeValue 为原文,不解码实体):
 * 供 launch 的 pkg/exec/file 值消费方(跳转/悬浮/链接)在解析前统一应用。
 */
export function decodeXmlEntities(s: string): string {
    return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITY_MAP[name]);
}
