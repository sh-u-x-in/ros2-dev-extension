// (c) MIT

/**
 * @file scanner.ts
 * anchors/ 文本扫描核心:按语言把文本划分为 code/str/comment 区域,
 * 再做跨行的括号配对(自动跳过字符串/注释/bracket 参数)。
 * 纯 TS,零 vscode 依赖,可无头测。
 */

export type Lang = "python" | "cmake" | "generic";

export type RegionType = "code" | "str" | "comment";

export interface Region {
    type: RegionType;
    start: number;
    end: number;
}

/** 跳过反斜杠转义的引号字符串(从引号索引起),返回独占结尾 */
function skipQuoted(text: string, i: number, quote: string): number {
    let j = i + 1;
    while (j < text.length) {
        const c = text[j];
        if (c === "\\") { j += 2; continue; }
        if (c === quote) { return j + 1; }
        j++;
    }
    return text.length;
}

/** 跳过 python 单/双引号或三引号字符串(自引号字符索引起) */
function skipPythonString(text: string, i: number): number {
    const q = text[i];
    const triple = text[i + 1] === q && text[i + 2] === q;
    if (triple) {
        let j = i + 3;
        while (j < text.length) {
            if (text[j] === "\\") { j += 2; continue; }
            if (text[j] === q && text[j + 1] === q && text[j + 2] === q) { return j + 3; }
            j++;
        }
        return text.length;
    }
    return skipQuoted(text, i, q);
}

function skipLineComment(text: string, i: number): number {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length : nl + 1;
}

function isBracket(c: string): boolean { return c === "(" || c === "[" || c === "{"; }

function closeFor(c: string): string {
    return c === "(" ? ")" : c === "[" ? "]" : c === "{" ? "}" : "";
}

/** 按语言把文本划为 code/str/comment 区域(用于判断某 token 是否真代码) */
export function classifyRegions(text: string, lang: Lang): Region[] {
    const regions: Region[] = [];
    let i = 0;
    let codeStart = 0;
    const flushCode = (until: number): void => {
        if (until > codeStart) { regions.push({ type: "code", start: codeStart, end: until }); }
    };
    while (i < text.length) {
        const c = text[i];
        if (lang === "python") {
            if (c === "#") {
                flushCode(i);
                const end = skipLineComment(text, i);
                regions.push({ type: "comment", start: i, end });
                i = end; codeStart = i;
                continue;
            }
            if (c === "'" || c === '"') {
                const prev = text[i - 1];
                const isPrefix = i > 0 && /[a-zA-Z]/.test(prev); // r/f/b/u 前缀
                flushCode(isPrefix ? i - 1 : i);
                const end = skipPythonString(text, i);
                regions.push({ type: "str", start: isPrefix ? i - 1 : i, end });
                i = end; codeStart = i;
                void prev;
                continue;
            }
            i++;
            continue;
        }
        if (lang === "cmake") {
            if (c === "#") {
                const m = /^#\[(=*)\[/.exec(text.slice(i));
                if (m) {
                    flushCode(i);
                    const level = m[1].length;
                    const endPat = "]" + m[1] + "]";
                    const closeAt = text.indexOf(endPat, i + m[0].length);
                    const end = closeAt < 0 ? text.length : closeAt + endPat.length;
                    regions.push({ type: "comment", start: i, end });
                    i = end; codeStart = i;
                    continue;
                }
                flushCode(i);
                const end = skipLineComment(text, i);
                regions.push({ type: "comment", start: i, end });
                i = end; codeStart = i;
                continue;
            }
            if (c === '"') {
                flushCode(i);
                const end = skipQuoted(text, i, '"');
                regions.push({ type: "str", start: i, end });
                i = end; codeStart = i;
                continue;
            }
            if (c === "[") {
                const m = /^\[(=*)\[/.exec(text.slice(i));
                if (m) {
                    flushCode(i);
                    const level = m[1].length;
                    const endPat = "]" + m[1] + "]";
                    const closeAt = text.indexOf(endPat, i + m[0].length);
                    const end = closeAt < 0 ? text.length : closeAt + endPat.length;
                    regions.push({ type: "str", start: i, end });
                    i = end; codeStart = i;
                    continue;
                }
            }
            i++;
            continue;
        }
        if (c === "'" || c === '"') {
            flushCode(i);
            const end = skipQuoted(text, i, c);
            regions.push({ type: "str", start: i, end });
            i = end; codeStart = i;
            continue;
        }
        i++;
    }
    flushCode(text.length);
    return regions;
}

/** pos 所在区域类型;不在任何区域内视为 code */
export function regionAt(regions: Region[], pos: number): RegionType {
    for (const r of regions) {
        if (pos >= r.start && pos < r.end) { return r.type; }
    }
    return "code";
}

/**
 * 找 openIndex 处开括号的配对闭括号(跨行,跳过字符串/注释/bracket 参数)。
 * 不平衡或 openIndex 位于字符串/注释内时返回 -1(调用方必须视为"不可动")。
 */
export function findMatchingClose(text: string, openIndex: number, lang: Lang): number {
    if (openIndex < 0 || openIndex >= text.length) { return -1; }
    const open = text[openIndex];
    if (!isBracket(open)) { return -1; }
    const regions = classifyRegions(text, lang);
    if (regionAt(regions, openIndex) !== "code") { return -1; }
    const stack: string[] = [closeFor(open)];
    let i = openIndex + 1;
    while (i < text.length) {
        if (regionAt(regions, i) !== "code") { i++; continue; }
        const c = text[i];
        if (isBracket(c)) { stack.push(closeFor(c)); }
        else if (c === ")" || c === "]" || c === "}") {
            const top = stack[stack.length - 1];
            if (c === top) {
                stack.pop();
                if (stack.length === 0) { return i; }
            }
        }
        i++;
    }
    return -1;
}

const SPECIAL = new Set([".", "*", "+", "?", "^", "$", "(", ")", "|", "[", "]", "\\", "{", "}"]);
const escapeRe = (s: string): string =>
    [...s].map((ch) => (SPECIAL.has(ch) ? "\\" + ch : ch)).join("");

/** 找 from 之后首个属于 code 区的调用开括号:token( ... ) 中的 '(' */
export function findCallOpen(text: string, token: string, from: number, lang: Lang): number {
    const src = "\\b" + escapeRe(token) + "\\s*\\(";
    const regions = classifyRegions(text, lang);
    const g = new RegExp(src, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
        if (m.index < from) { continue; }
        if (regionAt(regions, m.index) !== "code") { continue; }
        const openAt = m.index + m[0].lastIndexOf("(");
        if (regionAt(regions, openAt) === "code") { return openAt; }
    }
    return -1;
}
