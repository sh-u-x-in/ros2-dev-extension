// Licensed under the MIT License.

/**
 * @file test-results-parser.ts
 * 测试结果产物解析:junit(pytest)/ gtest XML → 统一 `ParsedSuite`。
 *
 * 背景(2026-09-24 测试改造 B1,见 `设计/测试功能/实施-三粒度执行层-执行计划-2026-09-24.md` §2.2):
 *   - 这才是"成败真值":pytest 的退出码 0/1/4/5 语义不同、gtest 的 0 命中也是 0(实测假绿),
 *     所以判定一律以产物为准,退出码只用来识别"没跑起来"。
 *   - **必须真 XML 解析,禁止行 grep**:实测 junit 失败消息里带换行,整个文件可能是一行巨行
 *     (`grep -c '<testcase'` 会数错)。
 *   - pytest 6.2.5 的 junit **没有** `file`/`line` 属性(xunit1/xunit2 实测都一样),不得依赖。
 *   - 仓库无 DOMParser,且两种格式结构都很浅(`testsuite > testcase > failure|error|skipped|system-out`),
 *     故手写浅解析,**不新增 npm 依赖**。
 */

/** 单条用例结果(与 XML 字段一一对应) */
export interface ParsedCase {
    classname: string;
    name: string;
    status: "passed" | "failed" | "skipped" | "errored";
    timeSec?: number;
    message?: string;
    valueParam?: string;
}

/** 一次产物的汇总(由用例清单算出,不依赖 XML 汇总属性) */
export interface ParsedSuite {
    tests: number;
    failures: number;
    skipped: number;
    cases: ParsedCase[];
}

/** 开标签解析结果 */
interface TagInfo {
    name: string;
    attrs: Record<string, string>;
    selfClosing: boolean;
    closing: boolean;
}

/** XML 实体反转义 */
function unescapeXml(s: string): string {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * 找到标签结束的 `>`。属性值里可能出现 `>`(经转义或原文),
 * 故用引号状态机,而不是裸 `indexOf('>')`。
 */
function findTagEnd(text: string, start: number): number {
    let inQuote = false;
    for (let i = start + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            inQuote = !inQuote;
        } else if (ch === ">" && !inQuote) {
            return i;
        }
    }
    return -1;
}

/** 解析一个标签(不含两端 `<>`) */
function parseTag(body: string): TagInfo {
    const closing = body.startsWith("/");
    const trimmed = closing ? body.slice(1) : body;
    const selfClosing = trimmed.endsWith("/");
    const core = selfClosing ? trimmed.slice(0, -1) : trimmed;
    const nameMatch = core.match(/^\s*([\w:.-]+)/);
    const name = nameMatch === null ? "" : nameMatch[1];
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(core)) !== null) {
        attrs[m[1]] = unescapeXml(m[2]);
    }
    return { name, attrs, selfClosing, closing };
}

/** 浅解析中间形态 */
interface ShallowCase {
    attrs: Record<string, string>;
    suiteName: string;
    /** 子标签类型 → 原始文本(failure/error/skipped) */
    marks: Map<string, string>;
}

/**
 * 两格式共用的浅解析:只认 `testsuite` / `testcase` / `failure` / `error` / `skipped` 五类标签,
 * 其余(`system-out`、`properties`、注释、PI)整体跳过。
 */
function shallowParse(text: string): ShallowCase[] {
    const cases: ShallowCase[] = [];
    let suiteName = "";
    let current: ShallowCase | null = null;
    let markName: string | null = null;
    let markBuf = "";

    let i = 0;
    while (i < text.length) {
        const lt = text.indexOf("<", i);
        if (lt < 0) {
            break;
        }
        if (markName !== null && lt > i) {
            markBuf += text.slice(i, lt);
        }
        if (text.startsWith("<?", lt)) {
            const end = text.indexOf("?>", lt);
            i = end < 0 ? text.length : end + 2;
            continue;
        }
        if (text.startsWith("<!--", lt)) {
            const end = text.indexOf("-->", lt);
            i = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith("<!", lt)) {
            const end = findTagEnd(text, lt);
            i = end < 0 ? text.length : end + 1;
            continue;
        }
        const gt = findTagEnd(text, lt);
        if (gt < 0) {
            break;
        }
        const tag = parseTag(text.slice(lt + 1, gt));
        i = gt + 1;
        if (tag.name === "") {
            continue;
        }

        if (tag.closing) {
            if (tag.name === "testcase") {
                if (current !== null) {
                    cases.push(current);
                    current = null;
                }
            } else if (tag.name === markName && current !== null) {
                current.marks.set(markName, unescapeXml(markBuf));
                markName = null;
                markBuf = "";
            }
            continue;
        }

        if (tag.name === "testsuite") {
            suiteName = tag.attrs.name === undefined ? "" : tag.attrs.name;
        } else if (tag.name === "testcase") {
            current = { attrs: tag.attrs, suiteName, marks: new Map<string, string>() };
            if (tag.selfClosing) {
                cases.push(current);
                current = null;
            }
        } else if (tag.name === "failure" || tag.name === "error" || tag.name === "skipped") {
            if (current !== null) {
                if (tag.selfClosing) {
                    current.marks.set(tag.name, tag.attrs.message === undefined ? "" : tag.attrs.message);
                } else {
                    markName = tag.name;
                    markBuf = tag.attrs.message === undefined ? "" : tag.attrs.message + "\n";
                }
            }
        }
    }
    return cases;
}

function timeOf(attrs: Record<string, string>): number | undefined {
    const raw = attrs.time;
    if (raw === undefined) {
        return undefined;
    }
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
}

function summarize(cases: ParsedCase[]): ParsedSuite {
    let failures = 0;
    let skipped = 0;
    for (const c of cases) {
        if (c.status === "failed" || c.status === "errored") {
            failures++;
        } else if (c.status === "skipped") {
            skipped++;
        }
    }
    return { tests: cases.length, failures, skipped, cases };
}

function textOf(mark: string | undefined): string | undefined {
    if (mark === undefined) {
        return undefined;
    }
    const t = mark.trim();
    return t.length === 0 ? undefined : t;
}

/**
 * pytest junitxml → ParsedSuite。
 * 状态映射:`<failure>` → failed;`<error>` → errored;`<skipped>` → skipped;无子标签 → passed。
 */
export function parseJunitXml(text: string): ParsedSuite {
    const cases: ParsedCase[] = [];
    for (const c of shallowParse(text)) {
        let status: ParsedCase["status"] = "passed";
        let message: string | undefined;
        if (c.marks.has("failure")) {
            status = "failed";
            message = textOf(c.marks.get("failure"));
        } else if (c.marks.has("error")) {
            status = "errored";
            message = textOf(c.marks.get("error"));
        } else if (c.marks.has("skipped")) {
            status = "skipped";
            message = textOf(c.marks.get("skipped"));
        }
        cases.push({
            // junit 的 classname 是点分模块[.类];无 classname 时退回 suite name
            classname: c.attrs.classname === undefined ? c.suiteName : c.attrs.classname,
            name: c.attrs.name === undefined ? "" : c.attrs.name,
            status,
            timeSec: timeOf(c.attrs),
            message,
        });
    }
    return summarize(cases);
}

/**
 * gtest `--gtest_output=xml` → ParsedSuite。
 * `classname` + `name` 拼起来**正好是 `--gtest_filter` 的真名**
 * (如 `AdderCases/AdderParamTest` + `param_macro/0`);`value_param` 透传。
 */
export function parseGtestXml(text: string): ParsedSuite {
    const cases: ParsedCase[] = [];
    for (const c of shallowParse(text)) {
        const result = c.attrs.result;
        const status0 = c.attrs.status;
        let status: ParsedCase["status"] = "passed";
        let message: string | undefined;
        if (c.marks.has("failure")) {
            status = "failed";
            message = textOf(c.marks.get("failure"));
        } else if (result === "skipped" || status0 === "notrun" || c.marks.has("skipped")) {
            status = "skipped";
            message = textOf(c.marks.get("skipped"));
        }
        cases.push({
            classname: c.attrs.classname === undefined ? c.suiteName : c.attrs.classname,
            name: c.attrs.name === undefined ? "" : c.attrs.name,
            status,
            timeSec: timeOf(c.attrs),
            message,
            valueParam: c.attrs.value_param,
        });
    }
    return summarize(cases);
}
