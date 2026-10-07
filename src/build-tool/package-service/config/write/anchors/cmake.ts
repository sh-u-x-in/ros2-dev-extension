// (c) MIT

/**
 * @file cmake.ts
 * anchors/ CMake 定位与增量追加(2026-09-04 定调):configure 只「追加不删改」→ 难点是「往哪插」。
 *   - 原语:命令括号跨行配对(findCommandParens/ament_package 锚点);
 *   - **增量追加定位**:L1 该 kind 已有活跃命令 → 最后活跃调用之后(同型连续);
 *     L2 无活跃、但有自家注释模板 run(去 # 后以该 kind 命令开头)→ 模板 run 起点上方;
 *     L3 两者皆无 → ament_package() 前 / 文件尾。模板 = create 生成物,天然是惯例位置锚,
 *     精确匹配命令名,不用相似度;
 *   - 行/注释 run 辅助(indexLines/commentRuns 等,2026-09-04 自 lines.ts 并入):
 *     供 L2 识别注释模板 run 用——连续纯注释行分组,块模型时代的 label/横幅建议已去掉。
 * 纯 TS,零 vscode 依赖,可无头测。幂等判定不依赖本层(走 exe-map/parse)。
 */

import { findMatchingClose, findCallOpen, classifyRegions, regionAt, Lang } from "./scanner";
import { BracketPair } from "./types";

/** CMake 命令 token( 的开闭括号对(引号字符串/bracket 参数/注释安全) */
export function findCommandParens(text: string, command: string, from = 0): BracketPair | undefined {
    const open = findCallOpen(text, command, from, "cmake");
    if (open < 0) { return undefined; }
    const close = findMatchingClose(text, open, "cmake");
    return close < 0 ? undefined : { openIndex: open, closeIndex: close };
}

/** ament_package() 位置(存在时) */
export function findAmentPackage(text: string): BracketPair | undefined {
    return findCommandParens(text, "ament_package");
}

/**
 * 把片段插到 ament_package() 之前(收尾调用前的惯例位置);无 ament_package() 时追加到文件尾。
 */
export function insertSnippetCmake(text: string, snippet: string): string {
    const ap = findAmentPackage(text);
    if (!ap) {
        const sep = text && !text.endsWith("\n") ? "\n" : "";
        return text + sep + snippet;
    }
    const lineStart = text.lastIndexOf("\n", ap.openIndex - 1) + 1;
    const body = snippet.endsWith("\n") ? snippet : snippet + "\n";
    return text.slice(0, lineStart) + body + text.slice(lineStart);
}

// ---------- 行 / 注释 run 辅助(自 lines.ts 并入,2026-09-04) ----------

/** 一行文本 [start, end),end 不含换行 */
export interface TextLine {
    start: number;
    end: number;
}

/** 建立行索引(每行 [start,end),不含 '\n';文本末尾无换行也收尾行) */
export function indexLines(text: string): TextLine[] {
    const out: TextLine[] = [];
    let start = 0;
    while (start < text.length) {
        const nl = text.indexOf("\n", start);
        if (nl < 0) {
            out.push({ start, end: text.length });
            break;
        }
        out.push({ start, end: nl });
        start = nl + 1;
    }
    return out;
}

/** pos 所在行号(0 基;越界返回 -1) */
export function lineIndexOf(lines: TextLine[], pos: number): number {
    for (let i = 0; i < lines.length; i++) {
        if (pos >= lines[i].start && pos <= lines[i].end) {
            return i;
        }
    }
    return -1;
}

/** 该行是否"纯注释行"(行首首个非空白字符位于注释区) */
export function isCommentOnlyLine(text: string, line: TextLine, lang: Lang): boolean {
    const regions = classifyRegions(text, lang);
    let s = line.start;
    while (s < line.end && /\s/.test(text[s])) { s++; }
    if (s >= line.end) { return false; } // 空白行
    return regionAt(regions, s) === "comment";
}

/** 去掉行首 '#' 及其后空白后的注释文本(仅注释行);非注释行返回 undefined */
export function commentTextOfLine(text: string, line: TextLine, lang: Lang): string | undefined {
    if (!isCommentOnlyLine(text, line, lang)) { return undefined; }
    const raw = text.slice(line.start, line.end).trim();
    if (!raw.startsWith("#")) { return undefined; }
    return raw.replace(/^#+/, "").trim();
}

/** 一条注释行 run(连续纯注释行;含起止偏移,不含块模型时代的 label/texts) */
export interface CommentRun {
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
}

/** 连续纯注释行分组(空行会断开);至少 1 行即返回 */
export function commentRuns(text: string, lang: Lang): CommentRun[] {
    const lines = indexLines(text);
    const runs: CommentRun[] = [];
    let cur: CommentRun | undefined;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (commentTextOfLine(text, line, lang) !== undefined) {
            if (!cur) {
                cur = { startLine: i, endLine: i, startOffset: line.start, endOffset: line.end };
            }
            cur.endLine = i;
            cur.endOffset = line.end;
            continue;
        }
        if (cur) {
            runs.push(cur);
            cur = undefined;
        }
    }
    if (cur) {
        runs.push(cur);
    }
    return runs;
}

// ---------- 增量追加定位(2026-09-04) ----------

/** 五种增量配置 kind → 主命令名(小写;cmake 命令大小写不敏感,匹配按小写) */
export const CMAKE_KIND_CMDS = {
    deps: ["find_package"],
    interfaces: ["rosidl_generate_interfaces"],
    build: ["add_executable", "add_library"],
    pyinstall: ["ament_python_install_package"],
    install: ["install"],
} as const;

export type CmakeLocateKind = keyof typeof CMAKE_KIND_CMDS;

/** 一条活跃 CMake 命令调用(括号配对,跳过注释/字符串/bracket 参数) */
export interface CmdCall {
    name: string;
    openIndex: number;
    closeIndex: number;
}

/** 一次扫出全部活跃命令调用:只在 code 区扫 identifier( ... )(注释模板天然排除) */
export function scanActiveCalls(text: string, lang: Lang = "cmake"): CmdCall[] {
    const regions = classifyRegions(text, lang);
    const calls: CmdCall[] = [];
    for (const r of regions) {
        if (r.type !== "code") { continue; }
        let i = r.start;
        while (i < r.end) {
            const c = text[i];
            if (!/[A-Za-z_]/.test(c)) { i++; continue; }
            let j = i;
            while (j < r.end && /[A-Za-z0-9_]/.test(text[j])) { j++; }
            const name = text.slice(i, j);
            let k = j;
            while (k < text.length && /\s/.test(text[k])) { k++; }
            if (text[k] === "(" && regionAt(regions, k) === "code") {
                const close = findMatchingClose(text, k, lang);
                if (close > k) {
                    calls.push({ name, openIndex: k, closeIndex: close });
                    i = close + 1;
                    continue;
                }
            }
            i = j;
        }
    }
    return calls;
}

/** 该 kind 的最后一个活跃调用(无则 undefined) */
function lastActiveCall(text: string, kind: CmakeLocateKind): CmdCall | undefined {
    const cmds = CMAKE_KIND_CMDS[kind];
    const calls = scanActiveCalls(text).filter((c) =>
        cmds.some((m) => c.name.toLowerCase() === m),
    );
    if (calls.length === 0) { return undefined; }
    return calls[calls.length - 1];
}

/** 注释 run 是否为该 kind 的模板 run:存在一行去 # 后以 kind 主命令名开头 */
function isKindTemplateRun(text: string, run: CommentRun, kind: CmakeLocateKind): boolean {
    const cmds = CMAKE_KIND_CMDS[kind];
    for (const raw of text.slice(run.startOffset, run.endOffset).split("\n")) {
        const body = raw.replace(/^#+/, "").trim();
        if (!body) { continue; }
        const low = body.toLowerCase();
        for (const cmd of cmds) {
            if (low === cmd || low.startsWith(cmd + "(") || low.startsWith(cmd + " ")) {
                return true;
            }
        }
    }
    return false;
}

export interface CmakeLocateResult {
    kind: CmakeLocateKind;
    /** 1=活跃尾 2=模板上方 3=通用兜底(新建第一段) */
    level: 1 | 2 | 3;
    /** 插入点:新块从该字符偏移开始写 */
    insertAt: number;
    /** L1:命中的最后一个活跃调用 */
    lastCall?: CmdCall;
    /** L2:命中的注释模板 run 起点偏移 */
    templateRunStart?: number;
    note: string;
}

/**
 * 定位该 kind 的追加插入点(纯函数)。
 * 返回 undefined 仅当文本为空等无任何落点(上层应提示手动)。
 */
export function locateCmakeInsert(text: string, kind: CmakeLocateKind): CmakeLocateResult | undefined {
    if (!text.trim()) { return undefined; }
    // L1:有活跃命令 → 最后一个活跃调用所在行结束后新起一行
    const last = lastActiveCall(text, kind);
    if (last) {
        const nl = text.indexOf("\n", last.closeIndex);
        const insertAt = nl < 0 ? text.length : nl + 1;
        return { kind, level: 1, insertAt, lastCall: last, note: "最后活跃 " + CMAKE_KIND_CMDS[kind][0] + "() 之后" };
    }
    // L2:无活跃 → 找注释模板 run(自家生成模板即惯例位置锚)
    for (const run of commentRuns(text, "cmake")) {
        if (isKindTemplateRun(text, run, kind)) {
            return { kind, level: 2, insertAt: run.startOffset, templateRunStart: run.startOffset, note: "注释模板上方(该 kind 惯例位置)" };
        }
    }
    // L3:新建第一段 → ament_package() 前(该 kind 通用语义点);无则文件尾
    const ap = text.lastIndexOf("ament_package()");
    if (ap >= 0) {
        const lineStart = text.lastIndexOf("\n", ap - 1) + 1;
        return { kind, level: 3, insertAt: lineStart, note: "无既有段:ament_package() 之前" };
    }
    return { kind, level: 3, insertAt: text.length, note: "无既有段:文件尾" };
}

/**
 * 按「create 注释模板」定位插入锚点(2026-09-04 分区插入):同一命令对不同媒介有独立模板区
 * (install 的 TARGETS/PROGRAMS/DIRECTORY 各有注释模板)。找到第一个去 # 后以 cmd 开头且(可选)
 * 含 argHint 的注释 run,返回其起点上方偏移(活跃代码插到模板区上方,模板保留作说明/示例)。
 * 找不到返回 undefined —— 调用方回退到 locateCmakeInsert(kind)。
 */

// (c) MIT

/**
 * ===== 块内追加与模板码锚(2026-09-04 用户特许:垂直规范形态)=====
 * 背景:追加型命令(install TARGETS/PROGRAMS、rosidl_generate_interfaces)第二次追加必须并进
 * 既有活跃块;紧凑形态(参数挤在头行/DESTINATION 同行)没有可靠行级缝隙 → 特许:先整体重排为
 * 「垂直规范形态」(命令头行=上界、参数一参一行、区尾关键字行 DESTINATION/DEPENDENCIES 原样、
 * 行尾 `)` 单独成行=下界),再在内容区尾部(最后文件/目标行之后、区尾关键字行之前)插新行。
 * 重排范围 = 一切紧凑块(create 产物/用户手写),旧行标注保持原样,仅新增行带自己的 stamp。
 * 纯 TS,零 vscode 依赖,可无头测。
 */

/** 引号外的单词切分(保留引号原文);引号内空白不切分 */
function splitWords(code: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    const flush = (): void => { if (cur) { out.push(cur); cur = ""; } };
    for (const ch of code) {
        if (ch === '"') { inQ = !inQ; cur += ch; continue; }
        if (/\s/.test(ch) && !inQ) { flush(); continue; }
        cur += ch;
    }
    flush();
    return out;
}

/** 扫描命令参数区(open+1 .. close)为 token 流;每行行尾 # 注释挂到该行末 token(旧行标注保留) */
function scanInnerTokens(inner: string): Array<{ raw: string; comment?: string }> {
    const out: Array<{ raw: string; comment?: string }> = [];
    for (const ln of inner.split("\n")) {
        let codeEnd = ln.length;
        let inQ = false;
        for (let i = 0; i < ln.length; i++) {
            const ch = ln[i];
            if (ch === '"') { inQ = !inQ; }
            else if (ch === "#" && !inQ) { codeEnd = i; break; }
        }
        const commentRaw = ln.slice(codeEnd).trim();
        const words = splitWords(ln.slice(0, codeEnd));
        for (let i = 0; i < words.length; i++) {
            out.push({ raw: words[i], comment: i === words.length - 1 && commentRaw ? commentRaw : undefined });
        }
    }
    return out;
}

/** 定位:cmd 的注释模板区里「首条被注释代码行」起始偏移。## 说明头不参与匹配、不在其上方生成(2026-09-04) */
export function locateCmakeTemplateCodeAnchor(text: string, cmd: string, argHint?: string): number | undefined {
    const lines = indexLines(text);
    for (const run of commentRuns(text, "cmake")) {
        let firstCodeOffset: number | undefined;
        let matched = false;
        for (let i = run.startLine; i <= run.endLine; i++) {
            const body = commentTextOfLine(text, lines[i], "cmake");
            if (body === undefined) { continue; }
            if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(body)) {
                if (firstCodeOffset === undefined) { firstCodeOffset = lines[i].start; }
                if (body.toLowerCase().startsWith(cmd.toLowerCase() + "(")
                    && (!argHint || body.includes(argHint))) { matched = true; }
            }
        }
        if (matched && firstCodeOffset !== undefined) { return firstCodeOffset; }
    }
    return undefined;
}

/** 找最后一个「参数区含 argHint」的活跃调用(install 的媒介用 PROGRAMS/TARGETS 等做 hint) */
export function findActiveCallByArgs(text: string, cmd: string, argHint?: string): CmdCall | undefined {
    const calls = scanActiveCalls(text).filter((c) => c.name.toLowerCase() === cmd.toLowerCase());
    for (let i = calls.length - 1; i >= 0; i--) {
        const inner = text.slice(calls[i].openIndex + 1, calls[i].closeIndex);
        if (!argHint || inner.includes(argHint)) { return calls[i]; }
    }
    return undefined;
}

/** 追加结果 */
export interface CmakeBlockAppendResult {
    /** 新整文(未变化时 = 原文本) */
    text: string;
    /** 目标项已在块内(幂等命中) */
    already: boolean;
    /** 本次是否发生了「紧凑 → 垂直」排版改写 */
    converted: boolean;
    /** 不支持时的原因(ok 用 reason 有无判断) */
    reason?: string;
}

/** 安装媒介值关键字(其后参数为该关键字的值,直到下一关键字) */
const CMAKE_VALUE_KEYWORDS = new Set([
    "DESTINATION", "RUNTIME_DESTINATION", "LIBRARY_DESTINATION", "ARCHIVE_DESTINATION", "DEPENDENCIES",
]);

/**
 * 把 itemRaw 追加进活跃块内容区(install TARGETS/PROGRAMS、rosidl_generate_interfaces):
 *   - 幂等:块内已含相同 token(忽略外层引号) → already=true,不改文本;
 *   - 紧凑块先垂直化(头行参数 + 一参一行 + DESTINATION/DEPENDENCIES 行 + `)` 独立行),
 *     converted=true 表示本次发生了排版改写(modal 摘要提示);
 *   - 新行插到「最后文件/目标行之后、区尾关键字行之前」,可带行尾 stamp;
 *   - 结构无法识别(空块/闭括号后残留非注释/不支持媒介)→ reason,不改文本。
 */
export function cmakeAppendArgToBlock(
    text: string,
    call: CmdCall,
    itemRaw: string,
    opts: { stamp?: string } = {},
): CmakeBlockAppendResult {
    const fail = (reason: string): CmakeBlockAppendResult => ({ text, already: false, converted: false, reason });
    const cmdLow = call.name.toLowerCase();
    const isInstall = cmdLow === "install";
    const isRosidl = cmdLow === "rosidl_generate_interfaces";
    if (!isInstall && !isRosidl) { return fail("仅支持 install / rosidl_generate_interfaces 的块内追加"); }

    const tokens = scanInnerTokens(text.slice(call.openIndex + 1, call.closeIndex));
    if (tokens.length === 0) { return fail("块参数区为空,无法定位追加位置"); }

    const head = tokens[0];
    const headComment = head.comment;
    let items: typeof tokens;
    let groupTail: typeof tokens;
    let mediaKind: string | undefined;
    if (isInstall) {
        mediaKind = head.raw.toUpperCase();
        if (mediaKind !== "TARGETS" && mediaKind !== "PROGRAMS") {
            return fail("仅 PROGRAMS/TARGETS 媒介支持块内追加(当前 " + mediaKind + ")");
        }
        const kwIdx = tokens.findIndex((t, i) => i > 0 && CMAKE_VALUE_KEYWORDS.has(t.raw.toUpperCase()));
        items = kwIdx < 0 ? tokens.slice(1) : tokens.slice(1, kwIdx);
        groupTail = kwIdx < 0 ? [] : tokens.slice(kwIdx);
    } else {
        mediaKind = "rosidl";
        const kwIdx = tokens.findIndex((t, i) => i > 0 && CMAKE_VALUE_KEYWORDS.has(t.raw.toUpperCase()));
        items = kwIdx < 0 ? tokens.slice(1) : tokens.slice(1, kwIdx);
        groupTail = kwIdx < 0 ? [] : tokens.slice(kwIdx);
    }

    const norm = (s: string): string => s.trim().replace(/^"+|"+$/g, "");
    const targetNorm = norm(itemRaw);
    const already = items.some((it) => norm(it.raw) === targetNorm);

    // 区尾关键字组(如 DESTINATION lib/${PROJECT_NAME} 或 DEPENDENCIES std_msgs)→ 单行保留
    const groups: string[] = [];
    let cur: string[] | undefined;
    for (const t of groupTail) {
        if (CMAKE_VALUE_KEYWORDS.has(t.raw.toUpperCase())) {
            if (cur) { groups.push(cur.join(" ")); }
            cur = [t.raw];
        } else if (cur) {
            cur.push(t.raw);
        } else {
            return fail("无法识别的参数结构:" + t.raw);
        }
    }
    if (cur) { groups.push(cur.join(" ")); }

    // 原块行范围:开括号所在行行首 → 闭括号所在行行尾(含 ')' 后同行注释)
    const prefixStart = text.lastIndexOf("\n", call.openIndex - 1) + 1;
    let closeLineEnd = text.indexOf("\n", call.closeIndex);
    if (closeLineEnd < 0) { closeLineEnd = text.length; }
    const tailAfterClose = text.slice(call.closeIndex + 1, closeLineEnd).trim();
    if (tailAfterClose && !tailAfterClose.startsWith("#")) {
        return fail("闭括号后有无法处理的残留:" + tailAfterClose);
    }
    const blockPrefix = text.slice(prefixStart, call.openIndex + 1); // indent + cmd + '('
    const afterComment = tailAfterClose.startsWith("#") ? tailAfterClose : undefined;
    const headCommentFinal = headComment ?? afterComment;
    const suffix = closeLineEnd < text.length ? text.slice(closeLineEnd) : ""; // 原 ')' 行后的换行/余文

    const assemble = (extra?: { raw: string; comment?: string }): string => {
        const lines: string[] = [head.raw + (headCommentFinal ? " " + headCommentFinal : "")];
        for (const it of items) {
            lines.push("  " + it.raw + (it.comment ? " " + it.comment : ""));
        }
        if (extra) {
            lines.push("  " + extra.raw + (extra.comment ? " " + extra.comment : ""));
        }
        for (const g of groups) { lines.push("  " + g); }
        return blockPrefix + lines.join("\n") + "\n)";
    };

    const baseBlock = assemble(); // 不含新项的规范形态
    const oldRegion = text.slice(prefixStart, closeLineEnd);
    const converted = oldRegion !== baseBlock;

    if (already) {
        // 幂等命中:若块还需规范化也不强改(已配置优先)
        return { text, already: true, converted, reason: "块内已含 " + itemRaw };
    }

    const newItem: { raw: string; comment?: string } = {
        raw: itemRaw,
        comment: opts.stamp ? "# " + opts.stamp.replace(/^#\s*/, "") : undefined,
    };
    const finalText = text.slice(0, prefixStart) + assemble(newItem) + suffix;
    return { text: finalText, already: false, converted, reason: undefined };
}
