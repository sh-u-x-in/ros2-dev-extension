/**
 * launch-args — launch 参数声明提取(LC-1,2026-09-27;对标 xacro 的 property/arg 符号表)
 *
 * 三格式统一 `ArgDecl {name, default?, declOffset, declLineText?}`:
 *  - py:掩码注释/docstring 后 `/DeclareLaunchArgument\s*\(\s*['"]([^'"]+)['"]/`(调用内配对提取
 *    default_value 字面量;动态值不进,与 include 解析的"仅字面量"口径一致);
 *  - xml:lezer(`<arg name/default/value>`,属性序无关;value=固定值,作默认展示);
 *  - yaml:行级 `- arg:` 块 + `name:`/`default:` 键(引号/裸标量;注释截断)。
 * 全部只读纯函数、不求值;declOffset = 名字在文档中的绝对 offset(文档/跳转锚点用)。
 */
import * as path from "path";
import { maskPythonNoise, parsePyStringConcatenation } from "../parse/launch-py-parser";
import { parseXml, forEachElement } from "../../shared/xml-utils";

export interface LaunchArgDecl {
    name: string;
    /** 默认值(py default_value / xml default / yaml default;无 → undefined = 必传) */
    default?: string;
    /** 名字在文档中的绝对 offset */
    declOffset: number;
    /** 声明所在行文本(悬浮/补全文档用) */
    declLineText?: string;
}

export type LaunchFormat = "py" | "xml" | "yaml";

/** 行起始偏移表 */
function buildLineStarts(text: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            starts.push(i + 1);
        }
    }
    return starts;
}

/** offset → 行文本(去行尾换行) */
function lineTextAt(text: string, lineStarts: number[], offset: number): string {
    let lo = 0;
    const ls = lineStarts;
    for (let i = 0; i < ls.length; i++) {
        if (ls[i] <= offset) {
            lo = i;
        } else {
            break;
        }
    }
    const end = lo + 1 < ls.length ? ls[lo + 1] : text.length;
    return text.slice(ls[lo], end).replace(/\r?\n$/, "");
}

/** 括号配对:open 的匹配闭合 offset;无 → -1(忽略字符串内的括号——掩码后注释已除,串内括号罕见,容忍) */
function findCallEnd(src: string, open: number): number {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === "(") {
            depth++;
        } else if (c === ")") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/** py:DeclareLaunchArgument 调用扫描(掩码后定位;LF-2 起名字/默认值经 parsePyString
 *  于原文提取——转义/引号内空格/多行全支持;值仍为字面量口径) */
export function declaredArgsPy(text: string): LaunchArgDecl[] {
    const src = maskPythonNoise(text);
    const out: LaunchArgDecl[] = [];
    const seen = new Set<string>();
    const re = /\bDeclareLaunchArgument\s*\(\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const namePs = parsePyStringConcatenation(text, m.index + m[0].length);
        if (!namePs || namePs.raw || namePs.quote === "'''" || namePs.quote === '"""') {
            continue; // 名字位须为单/双引号普通字符串
        }
        const name = namePs.value;
        if (!name || seen.has(name)) {
            continue; // 首个声明优先(与符号表口径一致)
        }
        seen.add(name);
        const open = src.indexOf("(", m.index);
        const close = findCallEnd(src, open);
        const declOffset = namePs.contentStart;
        const lineStarts = buildLineStarts(text);
        const declLine = lineTextAt(text, lineStarts, m.index);
        let defaultValue: string | undefined;
        if (close > open) {
            // default_value:call 区原文定位后 parsePyString(转义感知)
            const dm = /\bdefault_value\s*=\s*/.exec(text.slice(open + 1, close));
            if (dm) {
                const ps = parsePyStringConcatenation(text, open + 1 + dm.index + dm[0].length);
                if (ps) {
                    defaultValue = ps.value;
                }
            }
        }
        out.push({
            name,
            ...(defaultValue !== undefined ? { default: defaultValue } : {}),
            declOffset,
            declLineText: declLine
        });
    }
    return out;
}

/** xml:<arg> 元素扫描(lezer,属性序无关;value 视为固定值,展示为默认) */
export function declaredArgsXml(text: string): LaunchArgDecl[] {
    const out: LaunchArgDecl[] = [];
    const seen = new Set<string>();
    const lineStarts = buildLineStarts(text);
    try {
        forEachElement(parseXml(text).topNode, text, (_elem, info) => {
            if (info.tag !== "arg") {
                return;
            }
            const nameAttr = info.attrs.find((a) => a.name === "name");
            if (!nameAttr || nameAttr.value === undefined || nameAttr.value.length === 0) {
                return;
            }
            const name = nameAttr.value;
            if (seen.has(name)) {
                return;
            }
            seen.add(name);
            const def = info.attrs.find((a) => a.name === "default" || a.name === "value");
            out.push({
                name,
                ...(def && def.value !== undefined && def.value.length > 0 ? { default: def.value } : {}),
                declOffset: nameAttr.valueFrom,
                declLineText: lineTextAt(text, lineStarts, nameAttr.valueFrom)
            });
        });
    } catch {
        // 恢复式解析不抛错,此 catch 仅防御;畸形文档返回已收集部分
    }
    return out;
}

/** yaml:`- arg:` 块 + name:/default: 键(行级;注释截断;引号剥离) */
export function declaredArgsYaml(text: string): LaunchArgDecl[] {
    const out: LaunchArgDecl[] = [];
    const seen = new Set<string>();
    const lines = text.split(/\r?\n/);
    let offset = 0;
    // 当前 arg 块状态
    let cur: { name?: string; default?: string; declOffset?: number; argIndent: number } | null = null;
    const flush = (): void => {
        if (cur && cur.name !== undefined && !seen.has(cur.name)) {
            seen.add(cur.name);
            out.push({
                name: cur.name,
                ...(cur.default !== undefined ? { default: cur.default } : {}),
                declOffset: cur.declOffset ?? 0,
                declLineText: undefined
            });
        }
        cur = null;
    };
    for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        const indentM = line.match(/^[ \t]*/);
        const indent = (indentM ? indentM[0] : "").length;
        const content = line.slice(indent);
        const argM = content.match(/^-\s*arg:\s*$/);
        if (argM) {
            flush();
            cur = { argIndent: indent };
            offset += raw.length + 1;
            continue;
        }
        if (cur) {
            if (content.trim().length > 0 && indent <= cur.argIndent) {
                flush(); // 块结束(回到同级或更浅)
            } else {
                const nm = content.match(/^name:\s*["']?([^"'\s#]+)["']?/);
                if (nm && cur.name === undefined) {
                    cur.name = nm[1];
                    cur.declOffset = offset + raw.indexOf(nm[1], line.indexOf("name:"));
                }
                const dm = content.match(/^default:\s*(.*)$/);
                if (dm && cur.default === undefined) {
                    const v = dm[1].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
                    if (v.length > 0) {
                        cur.default = v;
                    }
                }
            }
        }
        offset += raw.length + 1;
    }
    flush();
    return out;
}

/** 统一入口(按格式分派) */
export function declaredArgs(text: string, format: LaunchFormat): LaunchArgDecl[] {
    switch (format) {
        case "py": return declaredArgsPy(text);
        case "xml": return declaredArgsXml(text);
        case "yaml": return declaredArgsYaml(text);
        default: return [];
    }
}

/** 按扩展名分派(跨文件读取后用;未知扩展 → undefined) */
export function declaredArgsForFile(filePath: string, text: string): LaunchArgDecl[] | undefined {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".py") {
        return declaredArgsPy(text);
    }
    if (ext === ".yaml" || ext === ".yml") {
        return declaredArgsYaml(text);
    }
    if (ext === ".xml" || ext === ".launch" || text.trimStart().startsWith("<?xml")) {
        return declaredArgsXml(text);
    }
    return undefined;
}
