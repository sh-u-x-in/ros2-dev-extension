// Licensed under the MIT License.

/**
 * @file ctest-testfile-parser.ts
 * 解析 `build/<pkg>/CTestTestfile.cmake` 的 `add_test` 注册
 * (2026-09-24:B2 首版 → B16 记录驱动发现 → **B17 稳健化**)。
 *
 * 为什么用它:**测试的名单/可执行/类型不能猜** —— 注册面是 CMake 自己写的记录,一条记录同时含
 *   exe 绝对路径(gtest)、launch 源文件路径、`LABELS`(类型)、`WORKING_DIRECTORY`、`TIMEOUT`,
 *   以及 `_BACKTRACE_TRIPLES` 里的 **`CMakeLists.txt;<行号>;<宏>`**(声明位置,可反查源文件)。
 *
 * ## 编码规则(依据 CMake 生成器**源码** + 本机 3.22.1 实物,不是猜的)
 *
 * 生成器:`Source/cmTestGenerator.cxx`(3.22)与 `Source/cmScriptGenerator.cxx`(master);
 * 实物:`/tmp/qtest` 用本机 cmake 3.22.1 生成(名字含 `==`,值含 `\` `"` `$` `;` 空格/空串)。
 *
 * | 位置 | 编码 | 依据 |
 * |:--|:--|:--|
 * | **测试名** | 括号参数 `[=*[name]=*]`,**层数 = 1 + 名字里最长连续 `=` 的个数**;CMP0110 为 OLD 时**裸写** | 3.22 源码 `equalSigns(1 + countMaxConsecutiveEqualSigns(name))`;实测 `eq==name` → `[===[eq==name]===]` |
 * | **命令参数 / 属性值** | 双引号 `"…"`,**唯一转义是 `\"`**(引号);反斜杠/`$`/`;`/空格**原样透传** | 3.22 `cmOutputConverter::EscapeForCMake`;实测 `"C:\path\to thing"`、`"say \"hi\""`、`"$HOME"`、`"a;b"`、`""` |
 * | **属性键** | 裸 token(`LABELS` / `TIMEOUT` / `WORKING_DIRECTORY` / `_BACKTRACE_TRIPLES` …) | 3.22 `os << " " << key << " " << EscapeForCMake(value)` |
 * | **`_BACKTRACE_TRIPLES`** | 恒 `"file;line;name;file;line;name;…"`(写在其它属性之后) | 3.22 `GenerateInternalProperties` |
 * | 多标签 | `LABELS "gtest;extra"` —— **一个引号里用 `;` 分隔** | 实测 |
 * | 无该配置 | `add_test(<名> NOT_AVAILABLE)`(**没有命令**) | 3.22 `GenerateScriptNoConfig` |
 * | 子目录 | `subdirs("gtest")` | 实测 |
 *
 * 另注:master 的 `cmScriptGenerator::Quote` 对含 `"` `$` `\` 的值会改用括号参数 ⇒ 词法里
 * **两种形态都收**(面向未来,不赌版本)。
 *
 * 解析策略:**真词法**(括号参数按层自匹配、引号处理 `\"`、裸 token),而非行内正则 ——
 * 任何一条语句解析失败只记 warn 并跳过该条,**不猜**;"无 add_test → 空数组"是常态(生成型子目录)。
 */

import { l10n } from "vscode";

import * as fs from "fs";
import * as path from "path";

import { getLogger } from "../../logger";

const log = getLogger("ctest-testfile");

/** `_BACKTRACE_TRIPLES` 的一条三元组(CMake 自己写的"这行测试是在哪声明的") */
export interface BacktraceTriple {
    file: string;
    line: number;
    macro: string;
}

/** 一条 CTest 注册项 */
export interface CTestRegistration {
    /** `add_test` 第一参(如 `test_entries`) */
    name: string;
    /** `--command` 之后的**第一个**参数(≈ 可执行绝对路径;兼容既有消费方) */
    exePath?: string;
    /**
     * `--command` 之后的**全部**参数:
     * gtest 侧 = `[<exe>, "--gtest_output=xml:…"]`;launch 侧 =
     * `["/usr/bin/python3", "-m", "launch_testing.launch_test", "<源文件绝对路径>", "--junit-xml=…", "--package-name=…"]`
     * —— **源文件路径就在这里面**(见 `launchTestSourceOf`)。
     * 若注册里没有 `--command` 标记(用户直接 `add_test(名 命令 参数…)`),则整条命令都在这。
     */
    command: string[];
    /** `WORKING_DIRECTORY` 属性 */
    workingDirectory?: string;
    /** `TIMEOUT` 属性(秒) */
    timeoutSec?: number;
    /** `LABELS` 属性(**已按 `;` 拆开**,如 `["gtest"]` / `["launch_test"]`) —— 类型判定的权威依据 */
    labels: string[];
    /** `--gtest_output=xml:` 值(仅记录) */
    gtestXmlPath?: string;
    /** `--package-name` 值 */
    packageName?: string;
    /** `--junit-xml=` 值(launch 等 ament 测试的结果落点) */
    junitXmlPath?: string;
    /** `_BACKTRACE_TRIPLES` 解析结果(声明链) */
    backtrace: BacktraceTriple[];
    /** `add_test(<名> NOT_AVAILABLE)`:该配置下没有命令(不可运行) */
    notAvailable?: boolean;
}

/** 纯文本解析结果 */
export interface ParsedCTestTestfile {
    registrations: CTestRegistration[];
    /** `subdirs("x")` 列出的相对子目录 */
    subdirs: string[];
    /** 解析失败的语句条数(0 = 全部按词法吃下;调用方按需告警) */
    unparsed: number;
}

// ---------------------------------------------------------------------------
// 词法:三种 token 编码(括号参数 / 双引号串 / 裸 token)
// ---------------------------------------------------------------------------

interface Token {
    value: string;
    next: number;
}

function skipWs(s: string, i: number): number {
    let j = i;
    while (j < s.length && /\s/.test(s[j])) {
        j++;
    }
    return j;
}

/** 读一个 token(见文件头编码表);读不出(未闭合/空) → undefined */
function readToken(s: string, start: number): Token | undefined {
    const i = skipWs(s, start);
    if (i >= s.length) {
        return undefined;
    }
    const c = s[i];

    if (c === "[") {
        // 括号参数:`[` `=`*n `[` 内容 `]` `=`*n `]` —— 内容**不做任何转义处理**
        const m = /^\[(=*)\[/.exec(s.slice(i));
        if (m === null) {
            return undefined;
        }
        const eq = m[1];
        const bodyStart = i + m[0].length;
        const endTok = `]${eq}]`;
        const end = s.indexOf(endTok, bodyStart);
        if (end < 0) {
            return undefined;
        }
        return { value: s.slice(bodyStart, end), next: end + endTok.length };
    }

    if (c === '"') {
        // 双引号串:`\"` 是引号转义;其余字符**原样**(3.22 实测:反斜杠不转义)
        let out = "";
        let j = i + 1;
        while (j < s.length) {
            const ch = s[j];
            if (ch === "\\" && s[j + 1] === '"') {
                out += '"';
                j += 2;
                continue;
            }
            if (ch === '"') {
                return { value: out, next: j + 1 };
            }
            out += ch;
            j++;
        }
        return undefined; // 未闭合
    }

    // 裸 token:到空白或 ')' 为止(属性键、CMP0110 OLD 的测试名、`NOT_AVAILABLE`)
    let j = i;
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== ")") {
        j++;
    }
    if (j === i) {
        return undefined;
    }
    return { value: s.slice(i, j), next: j };
}

/** 语句头 `keyword(` 之后的位置;不匹配 → undefined */
function afterOpenParen(logical: string, keyword: string): number | undefined {
    const re = new RegExp(`^${keyword}\\s*\\(`);
    const m = re.exec(logical);
    return m === null ? undefined : m[0].length;
}

/** 剩余 token 列表(到语句末 `)` 为止) */
function readTokens(logical: string, from: number): Token[] | undefined {
    const out: Token[] = [];
    let i = from;
    for (;;) {
        i = skipWs(logical, i);
        if (i >= logical.length) {
            break; // 容错:缺右括号也接受已读到的部分
        }
        if (logical[i] === ")") {
            break;
        }
        const t = readToken(logical, i);
        if (t === undefined) {
            return undefined;
        }
        out.push(t);
        i = t.next;
    }
    return out;
}

/**
 * 取值:`--key v`(两个 token)或 `--key=v`(一个 token)两种写法都收
 * (ament 的注册里两种都出现过);`stripPrefix` 处理 `--gtest_output=xml:<path>` 这类"值里还带子前缀"的形态。
 */
function flagValue(tokens: string[], key: string, stripPrefix?: string): string | undefined {
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === key) {
            const v = tokens[i + 1];
            if (v === undefined) {
                continue;
            }
            return stripPrefix !== undefined && v.startsWith(stripPrefix) ? v.slice(stripPrefix.length) : v;
        }
        if (t.startsWith(`${key}=`)) {
            const v = t.slice(key.length + 1);
            return stripPrefix !== undefined && v.startsWith(stripPrefix) ? v.slice(stripPrefix.length) : v;
        }
    }
    return undefined;
}

/** 取 `--command` 之后的全部参数(无该标记 → 整个参数列表就是命令) */
function commandOf(args: string[]): string[] {
    const idx = args.indexOf("--command");
    return idx < 0 ? args.slice() : args.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// 语句级解析
// ---------------------------------------------------------------------------

/**
 * 把 CMake 文本切成"逻辑语句":括号深度回到 0 才断行(一条 `add_test` 内可能折行)。
 * 双引号串与**括号参数**内部的括号不计数(值里出现 `(` 不会打乱深度)。
 */
function logicalStatements(text: string): string[] {
    const out: string[] = [];
    let buf = "";
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];

        // 双引号串:整段跳过(内部括号不计数)
        if (ch === '"') {
            buf += ch;
            i++;
            while (i < text.length) {
                const c = text[i];
                if (c === "\\" && text[i + 1] === '"') {
                    buf += '\\"';
                    i += 2;
                    continue;
                }
                buf += c;
                i++;
                if (c === '"') {
                    break;
                }
            }
            continue;
        }

        // 括号参数:整段跳过
        if (ch === "[") {
            const m = /^\[(=*)\[/.exec(text.slice(i));
            if (m !== null) {
                const endTok = `]${m[1]}]`;
                const end = text.indexOf(endTok, i + m[0].length);
                if (end >= 0) {
                    buf += text.slice(i, end + endTok.length);
                    i = end + endTok.length;
                    continue;
                }
            }
        }

        buf += ch;
        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;
        }
        i++;
        if (ch === "\n" && depth <= 0) {
            const t = buf.trim();
            if (t !== "") {
                out.push(t);
            }
            buf = "";
            depth = 0;
        }
    }
    const tail = buf.trim();
    if (tail !== "") {
        out.push(tail);
    }
    return out;
}

/** 解析一份 CTestTestfile 文本(纯函数,无 fs) */
export function parseCTestTestfileText(text: string): ParsedCTestTestfile {
    const byName = new Map<string, CTestRegistration>();
    const subdirs: string[] = [];
    let unparsed = 0;

    const ensure = (name: string): CTestRegistration => {
        const found = byName.get(name);
        if (found !== undefined) {
            return found;
        }
        const created: CTestRegistration = { name, labels: [], command: [], backtrace: [] };
        byName.set(name, created);
        return created;
    };

    for (const stmt of logicalStatements(text)) {
        if (stmt.startsWith("add_test")) {
            const start = afterOpenParen(stmt, "add_test");
            const nameTok = start === undefined ? undefined : readToken(stmt, start);
            const rest = nameTok === undefined ? undefined : readTokens(stmt, nameTok.next);
            if (nameTok === undefined || rest === undefined) {
                unparsed++;
                log.warn(l10n.t("add_test statement could not be lexed; skipped: {0}", stmt.slice(0, 120)));
                continue;
            }
            const args = rest.map((t) => t.value);
            const reg = ensure(nameTok.value);
            if (args.length === 1 && args[0] === "NOT_AVAILABLE") {
                reg.notAvailable = true; // 该配置下没有命令
                continue;
            }
            reg.command = commandOf(args);
            reg.exePath = reg.command[0];
            reg.packageName = flagValue(reg.command, "--package-name");
            reg.junitXmlPath = flagValue(reg.command, "--junit-xml");
            reg.gtestXmlPath = flagValue(reg.command, "--gtest_output", "xml:");
            continue;
        }

        if (stmt.startsWith("set_tests_properties")) {
            const start = afterOpenParen(stmt, "set_tests_properties");
            const nameTok = start === undefined ? undefined : readToken(stmt, start);
            const rest = nameTok === undefined ? undefined : readTokens(stmt, nameTok.next);
            if (nameTok === undefined || rest === undefined) {
                unparsed++;
                log.warn(l10n.t("set_tests_properties statement could not be lexed; skipped: {0}", stmt.slice(0, 120)));
                continue;
            }
            const reg = ensure(nameTok.value);
            const tokens = rest.map((t) => t.value);
            const propsIdx = tokens.indexOf("PROPERTIES");
            // 属性 = 键(裸)/ 值(token)成对;不在白名单的键也不影响后续(按名取值)
            for (let i = propsIdx + 1; i + 1 < tokens.length; i += 2) {
                const key = tokens[i];
                const value = tokens[i + 1];
                switch (key) {
                    case "LABELS":
                        reg.labels = value.split(";").filter((s) => s !== "");
                        break;
                    case "TIMEOUT": {
                        const n = Number.parseInt(value, 10);
                        if (!Number.isNaN(n)) {
                            reg.timeoutSec = n;
                        }
                        break;
                    }
                    case "WORKING_DIRECTORY":
                        reg.workingDirectory = value;
                        break;
                    case "_BACKTRACE_TRIPLES":
                        reg.backtrace = parseBacktrace(value);
                        break;
                    default:
                        break; // 其余属性(REQUIRED_FILES 等)本层不需要
                }
            }
            continue;
        }

        const sub = /^subdirs\s*\(/.exec(stmt);
        if (sub !== null) {
            const tok = readToken(stmt, sub[0].length);
            if (tok !== undefined) {
                subdirs.push(tok.value);
            } else {
                unparsed++;
            }
        }
    }

    return { registrations: Array.from(byName.values()), subdirs, unparsed };
}

/**
 * 读取 `buildDir` 下的 CTestTestfile 并**递归 `subdirs()`**。
 * 文件不存在/不可读 → 该目录视为无注册(不抛错);`maxDepth` 防环。
 */
export async function parseCTestTestfile(buildDir: string, maxDepth = 8): Promise<CTestRegistration[]> {
    const visited = new Set<string>();
    const out: CTestRegistration[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > maxDepth) {
            log.warn(l10n.t("CTestTestfile recursion exceeded {0} levels; stopped: {1}", maxDepth, dir));
            return;
        }
        const file = path.join(dir, "CTestTestfile.cmake");
        const key = path.resolve(file);
        if (visited.has(key)) {
            return;
        }
        visited.add(key);

        let text: string;
        try {
            text = await fs.promises.readFile(file, "utf8");
        } catch {
            return; // 无该文件 = 该目录无注册(常态)
        }
        const parsed = parseCTestTestfileText(text);
        out.push(...parsed.registrations);
        if (parsed.unparsed > 0) {
            log.warn(l10n.t("{0}: {1} statements could not be parsed (the rest were taken)", file, parsed.unparsed));
        }
        for (const sub of parsed.subdirs) {
            await walk(path.join(dir, sub), depth + 1);
        }
    };

    await walk(buildDir, 0);
    return out;
}

// ---------------------------------------------------------------------------
// 对外取值(消费方用的语义函数)
// ---------------------------------------------------------------------------

/** `_BACKTRACE_TRIPLES` 原文(分号分隔的三元组串) → 结构化 */
export function parseBacktrace(raw: string): BacktraceTriple[] {
    const parts = raw.split(";").map((s) => s.trim()).filter((s) => s !== "");
    const out: BacktraceTriple[] = [];
    for (let i = 0; i + 1 < parts.length; i += 3) {
        const line = Number.parseInt(parts[i + 1], 10);
        if (Number.isNaN(line)) {
            continue;
        }
        out.push({ file: parts[i], line: line, macro: parts[i + 2] ?? "" });
    }
    return out;
}

/**
 * 反查"这条测试是在哪声明的":取声明链里**最后一条 `CMakeLists.txt;<行号>;宏`**(行号 > 0)。
 * 实物形如 `…;ament_add_gtest.cmake;93;ament_add_gtest_test;<pkg>/CMakeLists.txt;226;ament_add_gtest;<pkg>/CMakeLists.txt;0;`
 * —— 末条行号 0 是文件结束标记,须跳过。
 */
export function declarationOf(reg: CTestRegistration): BacktraceTriple | undefined {
    for (let i = reg.backtrace.length - 1; i >= 0; i--) {
        const t = reg.backtrace[i];
        if (t.line > 0 && /CMakeLists\.txt$/i.test(t.file)) {
            return t;
        }
    }
    return undefined;
}

/**
 * 从 CMakeLists 文本的**声明行**取出 C++ 源文件参数(形如 `ament_add_gtest(test_adder test/test_adder.cpp)`)。
 *
 * 两个必须的容错(真机反例:`ament_add_gtest(test_adder test/test_adder.cpp)` 紧跟着
 * `target_link_libraries(...)` 与 `## 注释`,天真的"按空白切参"会把 `)` 粘在末令牌上而匹配不到扩展名):
 *   · **只取第一条配对完整的语句**(按括号配平截断,不把后续行/注释里的文件名当参数);
 *   · 去掉引号、跳过含 `${…}`/`$VAR` 的参数(本层不解析变量)。
 * 返回**原样参数**(可能是相对路径),由调用方按声明文件所在目录解析。
 */
export function sourceArgAtDeclaration(cmakeText: string, lineOneBased: number): string | undefined {
    const lines = cmakeText.split(/\r?\n/);
    const idx = lineOneBased - 1;
    if (idx < 0 || idx >= lines.length) {
        return undefined;
    }
    const chunk = lines.slice(idx, idx + 8).join(" ");
    const open = chunk.indexOf("(");
    if (open < 0) {
        return undefined;
    }
    const body = chunk.slice(open + 1);
    let depth = 1;
    let end = body.length;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    const args = body
        .slice(0, end)
        .replace(/["'`]/g, " ")
        .split(/[\s,]+/)
        .filter((a) => a !== "" && !a.includes("$"));
    return args.find((a) => /\.(cpp|cc|cxx)$/i.test(a));
}

/**
 * launch 测试的**源文件路径** = `--command` 参数里第一个 `*.py`。
 * 实物:`python3 -m launch_testing.launch_test <源文件> --junit-xml=… --package-name=…`
 * (解释器路径、`-m`、模块名都不是 `.py` 结尾 ⇒ 命中唯一)。
 */
export function launchTestSourceOf(reg: CTestRegistration): string | undefined {
    return reg.command.find((a) => /\.py$/i.test(a));
}

/** 该注册是否为 gtest(类型判定的权威依据 = `LABELS`) */
export function isGtestRegistration(reg: CTestRegistration): boolean {
    return reg.labels.includes("gtest");
}

/** 该注册是否为 launch_testing 测试 */
export function isLaunchTestRegistration(reg: CTestRegistration): boolean {
    return reg.labels.includes("launch_test");
}
