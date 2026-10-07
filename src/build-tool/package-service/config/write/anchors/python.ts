// (c) MIT

/**
 * @file python.ts
 * anchors/ python/setup.py 定位原语(基于 scanner)。
 */

import { findMatchingClose, findCallOpen, classifyRegions, regionAt } from "./scanner";
import { BracketPair } from "./types";

/** 调用 token( 的开闭括号对,如 setup( ... ) */
export function findCallParens(text: string, token: string, from = 0): BracketPair | undefined {
    const open = findCallOpen(text, token, from, "python");
    if (open < 0) { return undefined; }
    const close = findMatchingClose(text, open, "python");
    return close < 0 ? undefined : { openIndex: open, closeIndex: close };
}

/** setup( ... ) 的跨行括号对(字符串/注释安全) */
export function findSetupCall(text: string): BracketPair | undefined {
    return findCallParens(text, "setup");
}

/** pos 所在行的行首空白 */
export function lineIndentAt(text: string, pos: number): string {
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    const m = /^[ \t]*/.exec(text.slice(lineStart, pos + 1));
    return m ? m[0] : "";
}

function indentLines(s: string, pad: string): string {
    return s.split("\n").map((l, idx) => (idx === 0 && !l ? l : l ? pad + l : l)).join("\n");
}

/**
 * 把 item 作为 openIndex 容器的最后一个元素插到闭括号前(python list/dict/调用参数),
 * 格式对齐 create 模板风格:
 *   - 多行容器:补逗号(如无)后,item 单独一行(缩进 = 容器行缩进 + extraIndent),闭括号保持原行;
 *   - 单行容器(如 ['a']):内联补 ", item";
 *   - 空容器:item 直接落入(单行内联, 多行换行缩进),不加孤立逗号。
 * 返回改写后的文本。
 */
export function insertItemAtContainerTail(
    text: string,
    openIndex: number,
    closeIndex: number,
    item: string,
    extraIndent = 4,
): string {
    const inner = text.slice(openIndex + 1, closeIndex);
    const innerEmpty = inner.trim() === "";
    const multiline = inner.includes("\n");
    const pad = lineIndentAt(text, openIndex) + " ".repeat(extraIndent);
    const itemLines = indentLines(item, pad);

    if (!multiline) {
        // 单行容器: [..]/ {..} 同行 → 内联插入
        if (innerEmpty) {
            return text.slice(0, openIndex + 1) + item + text.slice(closeIndex);
        }
        const sep = inner.trimEnd().endsWith(",") ? "" : ", ";
        return text.slice(0, closeIndex) + sep + item + text.slice(closeIndex);
    }

    // 多行容器:item 放"最后内容行之后、闭括号行之前"
    const closeLineStart = text.lastIndexOf("\n", closeIndex - 1) + 1;
    let k = closeLineStart - 1;
    while (k >= openIndex && /\s/.test(text[k])) { k--; }
    if (k <= openIndex) {
        // 空的多行容器(如 [\n]):补在闭括号行前
        return text.slice(0, closeLineStart) + itemLines + "\n" + text.slice(closeLineStart);
    }
    const needsSep = text[k] !== ",";
    const chunk = (needsSep ? "," : "") + "\n" + itemLines;
    return text.slice(0, k + 1) + chunk + "\n" + text.slice(closeLineStart);
}

/** 通用:把 chunk 插到 pos 之前 */
export function insertBefore(text: string, pos: number, chunk: string): string {
    return text.slice(0, pos) + chunk + text.slice(pos);
}

// ---------- 顶层参数分块(kwarg 块定位,块模型需要) ----------


/**
 * 调用 ( openIndex, closeIndex ) 内"顶层参数"的区间列表:
 * 在调用括号深度为 0 处按逗号切分(跳过字符串/注释),返回每个参数的 [start,end)(含行内前导空白)。
 */
export function topLevelArgRanges(text: string, openIndex: number, closeIndex: number): Array<{ start: number; end: number }> {
    const regions = classifyRegions(text, "python");
    const out: Array<{ start: number; end: number }> = [];
    let argStart = openIndex + 1;
    let depth = 0;
    let i = openIndex + 1;
    const push = (end: number): void => {
        // 跳过空白/纯注释的空段(如"尾随逗号后到闭括号的换行")
        if (text.slice(argStart, end).trim().length > 0) {
            out.push({ start: argStart, end });
        }
    };
    while (i < closeIndex) {
        if (regionAt(regions, i) !== "code") { i++; continue; }
        const c = text[i];
        if (c === "(" || c === "[" || c === "{") { depth++; }
        else if (c === ")" || c === "]" || c === "}") { depth--; }
        else if (c === "," && depth === 0) {
            push(i);
            argStart = i + 1;
        }
        i++;
    }
    push(closeIndex);
    return out;
}

/** 调用内名为 kwargName 的顶层参数块区间(如 entry_points=、data_files=);找不到返回 undefined */
export function findKwargSpan(text: string, openIndex: number, kwargName: string): { start: number; end: number } | undefined {
    const closeIndex = findMatchingClose(text, openIndex, "python");
    if (closeIndex < 0) { return undefined; }
    const re = new RegExp("^(?:\\s|#[^\\r\\n]*(?:\\r?\\n|$))*" + kwargName.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") + "\\s*=");
    for (const r of topLevelArgRanges(text, openIndex, closeIndex)) {
        const argText = text.slice(r.start, r.end);
        if (re.test(argText)) {
            return r;
        }
    }
    return undefined;
}

/** 行内(引号外)首个 '#' 索引;无返回 -1 */
function hashOutsideQuotes(line: string): number {
    let q: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === q) { q = undefined; } continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === "#") { return i; }
    }
    return -1;
}

/**
 * 规范多行尾插(console_scripts 等列表用,2026-09-04):
 *  - 追加的条目行**自带尾逗号**,可再带行内扩展生成标注(形如 `'x = m:f', # [rde-ros-2 扩展生成] ts`);
 *  - 前一行已是 create 风格(每条带尾逗号)→ **不再改写既有行**,反复追加是纯行插入;
 *  - 前一行缺尾逗号 → 只在行尾/行尾注释前补一次逗号(规范化);
 *  - 单行/空容器 → 转为规范多行(条目 + 独立闭括号行)。
 */
export function insertListItemCanonical(
    text: string,
    openIndex: number,
    closeIndex: number,
    itemNoComma: string,
    opts: { stamp?: string; padOffset?: number } = {},
): string {
    const pad = lineIndentAt(text, openIndex) + " ".repeat(opts.padOffset ?? 4);
    const itemLine = pad + itemNoComma + "," + (opts.stamp ? " " + opts.stamp : "");
    const inner = text.slice(openIndex + 1, closeIndex);
    if (!inner.includes("\n")) {
        // 单行(含空)容器 → 规范多行:既有条目逐行展开(每条自带尾逗号)+ 新条目,闭括号独立行
        const openPad = lineIndentAt(text, openIndex);
        const pieces: string[] = [];
        let cur = "";
        let q: string | undefined;
        const push = (): void => { const v = cur.trim(); if (v) { pieces.push(v); } cur = ""; };
        for (const ch of inner) {
            if (q) { cur += ch; if (ch === q) { q = undefined; } continue; }
            if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
            if (ch === ",") { push(); continue; }
            cur += ch;
        }
        push();
        const lines: string[] = [];
        for (const pc of pieces) { lines.push(pad + pc + ","); }
        lines.push(itemLine);
        const content = "\n" + lines.join("\n") + "\n" + openPad + "]";
        return text.slice(0, openIndex + 1) + content + text.slice(closeIndex + 1);
    }
    const closeLineStart = text.lastIndexOf("\n", closeIndex - 1) + 1;
    let lastStart = -1;
    let lastEnd = -1;
    let s = openIndex + 1;
    while (s < closeLineStart) {
        const nl = text.indexOf("\n", s);
        const e = nl < 0 || nl > closeLineStart ? closeLineStart : nl;
        if (text.slice(s, e).trim().length > 0 && !text.slice(s, e).trim().startsWith("#")) { lastStart = s; lastEnd = e; }
        s = nl < 0 ? closeLineStart : nl + 1;
    }
    if (lastStart < 0) {
        return text.slice(0, closeLineStart) + itemLine + "\n" + text.slice(closeLineStart);
    }
    const lastRaw = text.slice(lastStart, lastEnd);
    const hashAt = hashOutsideQuotes(lastRaw);
    const codePart = hashAt >= 0 ? lastRaw.slice(0, hashAt) : lastRaw;
    let out = text;
    if (!/,\s*$/.test(codePart)) {
        const at = hashAt >= 0 ? lastStart + hashAt : lastEnd;
        out = out.slice(0, at) + "," + out.slice(at);
    }
    return out.slice(0, closeLineStart) + itemLine + "\n" + out.slice(closeLineStart);
}

// ---------- entry_points 外部变量字典定位(2026-09-04,鲁棒性补课) ----------

/** 引号外 '#' 索引(行内注释剥离用) */
function hashOutside(line: string): number {
    let inQ: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) { if (c === inQ) { inQ = undefined; } continue; }
        if (c === "'" || c === '"') { inQ = c; continue; }
        if (c === "#") { return i; }
    }
    return -1;
}

/** 规范化 console 条目:去外围引号/尾逗号/空白 → 可比较 */
function normalizeConsoleItem(s: string): string {
    let t = s.trim();
    if (t.endsWith(",")) { t = t.slice(0, -1).trim(); }
    if (t.length >= 2 && ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"'))) {
        t = t.slice(1, -1).trim();
    }
    return t;
}

/**
 * 定位文本中第一个「entry_points 字典(内联 kwarg 或模块级变量赋值)」内的 console_scripts 列表括号对。
 * 覆盖:entry_points={'console_scripts': [...]} 与 entry_points: Dict[str, List[str]] = { 'console_scripts': [...] } 等静态形态。
 * 找不到返回 undefined。
 */
export function findConsoleScriptsList(text: string): { lb: number; rb: number } | undefined {
    const regions = classifyRegions(text, "python");
    const kw = "entry_points";
    for (const r of regions) {
        if (r.type !== "code") { continue; }
        let from = r.start;
        while (true) {
            const at = text.indexOf(kw, from);
            if (at < 0 || at >= r.end) { break; }
            from = at + kw.length;
            const prev = at > 0 ? text[at - 1] : "";
            const nxt = at + kw.length < text.length ? text[at + kw.length] : "";
            if (/[A-Za-z0-9_]/.test(prev) || /[A-Za-z0-9_]/.test(nxt)) { continue; }
            // 前进找 '='(允许 ': Dict[...]' 类型标注;遇 '(' 即视为别的调用上下文,放弃该处)
            let eq = -1;
            for (let i = at + kw.length; i < text.length && i - (at + kw.length) < 500; i++) {
                const ch = text[i];
                if (regionAt(regions, i) !== "code") { continue; }
                if (ch === "=") { eq = i; break; }
                if (ch === "(") { break; }
                if (ch === "\n" && i - (at + kw.length) > 80) { break; }
            }
            if (eq < 0) { continue; }
            // 本行内找 '{'
            let ob = -1;
            for (let i = eq + 1; i < text.length && i - eq < 2000; i++) {
                const ch = text[i];
                if (regionAt(regions, i) !== "code") { continue; }
                if (ch === "\n") { break; }
                if (ch === "{") { ob = i; break; }
            }
            if (ob < 0) { continue; }
            const cb = findMatchingClose(text, ob, "python");
            if (cb <= ob) { continue; }
            // dict body 内找 'console_scripts' key(词前为引号)→ 其 '[' 列表
            let scan = ob;
            while (scan < cb) {
                const keyAt = text.indexOf("console_scripts", scan);
                if (keyAt < 0 || keyAt >= cb) { break; }
                scan = keyAt + "console_scripts".length;
                let k = keyAt - 1;
                while (k > ob && /\s/.test(text[k])) { k--; }
                if (text[k] !== "'" && text[k] !== '"') { continue; }
                let lb = -1;
                for (let i = keyAt + "console_scripts".length; i < cb && i - keyAt < 300; i++) {
                    const ch = text[i];
                    if (regionAt(regions, i) !== "code") { continue; }
                    if (ch === "[") { lb = i; break; }
                }
                if (lb < 0) { continue; }
                const rb = findMatchingClose(text, lb, "python");
                if (rb > lb) { return { lb, rb }; }
            }
        }
    }
    return undefined;
}

/** console_scripts 列表内是否已含 item(引号/尾逗号/注释无关的规范化比较) */
export function consoleListHasItem(text: string, lb: number, rb: number, itemNoComma: string): boolean {
    const want = normalizeConsoleItem(itemNoComma);
    const inner = text.slice(lb + 1, rb);
    for (const line of inner.split("\n")) {
        const h = hashOutside(line);
        const code = (h >= 0 ? line.slice(0, h) : line).trim();
        if (!code) { continue; }
        if (normalizeConsoleItem(code) === want) { return true; }
    }
    return false;
}
