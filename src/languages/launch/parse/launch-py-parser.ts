/**
 * launch.py 文本解析器(共享)
 *
 * ⚠️ 2026-09-06 曾冻结,2026-09-08 按用户澄清**解冻恢复**(冻结对象是"可执行文件跳转",
 * 非启动文件 include 跳转)。当前口径(用户):**假设启动文件不引入外部变量,只做文件内静态
 * 解析;解析不成功 → 静默失败(不给假链接、不弹"未解析")**。
 *
 * 统一 launch include / 节点的轻量文本解析,供:
 *  - launchpy-provider(文件内 DocumentLink + Hover)——已恢复注册;
 *    LE-1 起 DocumentLink 含 Node 系 package/executable 值的文件级直达链接(scanLaunchNodeRefs);
 *  - ui/launch-definition-provider、ui/launch-hover-provider(定位与悬浮)。
 *
 * 不做结构校验(由 Python 扩展负责);include 路径解析支持:
 *  - os.path.join + get_package_share_directory('pkg')
 *  - 顶部/局部**简单赋值变量**(collectSimpleVars:字面量 / get_package_share_directory / os.path.join / 变量引用)
 *  - 字符串字面量(含 $(find-pkg-share pkg)/... 或相对/绝对路径)
 *  - 动态/外部变量(LaunchConfiguration、env…)解析失败 → 静默跳过
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getLogger } from "../../../logger";
import { PackageMap } from "../../shared/package-map";

/**
 * 相邻字符串字面量拼接(LI,2026-10-01 用户批准的窄口径):从 from 起解析第一个字符串,
 * 其后若仅隔空白/注释/`\`续行就紧跟另一字符串字面量,则继续消费并拼接值——
 * 即 `package="p10_mix_de" \n "ps_std"` 这类长名拆行写法(隐式拼接,python 编译期合并)。
 * 遇到任何非字符串 token(变量/逗号/运算符/f-string)立即停止——不做表达式求值;
 * `+` 号拼接不做。单字符串场景行为与 parsePyString 完全一致。
 */
export function parsePyStringConcatenation(text: string, from: number): PyStringSpan | undefined {
    const first = parsePyString(text, from);
    if (!first) {
        return undefined;
    }
    let i = first.nodeEnd;
    let value = first.value;
    let nodeEnd = first.nodeEnd;
    let contentEnd = first.contentEnd;
    for (;;) {
        if (i >= text.length) {
            break;
        }
        const c = text[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
            i++;
            continue;
        }
        if (c === "\\" && text[i + 1] === "\n") {
            i += 2; // 显式续行
            continue;
        }
        if (c === "#") {
            while (i < text.length && text[i] !== "\n") {
                i++;
            }
            continue;
        }
        const next = parsePyString(text, i);
        if (!next) {
            break; // 非字符串 token:拼接结束
        }
        value += next.value;
        nodeEnd = next.nodeEnd;
        contentEnd = next.contentEnd;
        i = next.nodeEnd;
    }
    return { quote: first.quote, raw: first.raw, value, contentStart: first.contentStart, contentEnd, nodeStart: first.nodeStart, nodeEnd };
}

const log = getLogger("launch-py-parser");

/** py 字符串字面量解析结果(LF-0;区间在 text 内,排他端点) */
export interface PyStringSpan {
    /** 引号形态 */
    quote: "'''" | '"""' | "'" | '"';
    /** 是否 raw 字符串(r/R 前缀,无转义处理) */
    raw: boolean;
    /** 转义还原后的值(三引号含换行) */
    value: string;
    /** 值内容首字符 offset(不含引号) */
    contentStart: number;
    /** 值内容末字符后一 offset(排他,不含引号) */
    contentEnd: number;
    /** 首引号起点(r 前缀不计入) */
    nodeStart: number;
    /** 整个字面量终点(排他,含闭引号) */
    nodeEnd: number;
}

/**
 * 从 text 的 from 处解析一个 Python 字符串字面量(LF-0,字符级扫描):
 *  - 可选 r/R 前缀(raw,无转义处理);
 *  - 三引号("""/''')支持内含换行与同形引号(非转义/非三连即内容);
 *  - 单/双引号 `\` 转义(`\\`+换行 = 续行消隐;还原 \\" \\\\ \\n \\t,其余保真),支持多行;
 *  - from 处须为引号或 r/R 前缀;未闭合 → undefined。
 */
export function parsePyString(text: string, from: number): PyStringSpan | undefined {
    return scanPyString(text, from, false);
}

/**
 * parsePyString 的未闭合容错版(LJ-4 os.path.join 末段补全用):引号已开未闭合时
 * 扫到文本末尾并返回(contentEnd = nodeEnd = 末尾);from 处非引号 → undefined。
 */
export function parsePyStringOpen(text: string, from: number): PyStringSpan | undefined {
    return scanPyString(text, from, true);
}

/** parsePyString/parsePyStringOpen 共用扫描核心(allowUnclosed 决定未闭合返回还是容错到末尾) */
function scanPyString(text: string, from: number, allowUnclosed: boolean): PyStringSpan | undefined {
    let i = from;
    let isRaw = false;
    if ((text[i] === "r" || text[i] === "R") && (text[i + 1] === '"' || text[i + 1] === "'")) {
        isRaw = true;
        i++;
    }
    const q = text[i];
    if (q !== '"' && q !== "'") {
        return undefined;
    }
    const triple = text.slice(i, i + 3) === q + q + q;
    const openLen = triple ? 3 : 1;
    const closing = q.repeat(openLen);
    const contentStart = i + openLen;
    let value = "";
    let j = contentStart;
    let closed = false;
    while (j < text.length) {
        if (!isRaw && text[j] === "\\") {
            const n = text[j + 1];
            if (n === undefined) {
                break;
            }
            if (n === "\n") {
                j += 2; // 续行消隐
                continue;
            }
            if (n === '"') { value += '"'; } else if (n === "\\") { value += "\\"; } else if (n === "n") { value += "\n"; } else if (n === "t") { value += "\t"; } else { value += n; }
            j += 2;
            continue;
        }
        if (!triple && q === "'" && text[j] === "'" && text[j + 1] === "'") {
            value += "'"; // 单引号串内 '' = 字面 '
            j += 2;
            continue;
        }
        if (text.startsWith(closing, j)) {
            closed = true;
            j += openLen;
            break;
        }
        value += text[j];
        j++;
    }
    if (!closed && !allowUnclosed) {
        return undefined;
    }
    return {
        quote: triple ? (q === "'" ? "'''" : '"""') : (q === "'" ? "'" : '"'),
        raw: isRaw,
        value,
        contentStart,
        contentEnd: closed ? j - openLen : j,
        nodeStart: i,
        nodeEnd: j
    };
}

/** 一条 launch include 记录 */
export interface LaunchInclude {
    /** 目标文件(可解析时) */
    target?: vscode.Uri;
    /** 表达式文本(链接显示范围) */
    expr: string;
    /** 文档中 offset 范围 */
    start: number;
    end: number;
}

/** 一个 Node 系调用的可链接引用(LE-1:DocumentLink/定位共用;值 range 不含引号) */
export interface LaunchNodeRef {
    kind: "node" | "lifecycle" | "composable" | "container";
    /** 调用起始 offset(名称首字符) */
    callStart: number;
    /** 调用结束 offset(含闭合括号,排他) */
    callEnd: number;
    package?: string;
    packageRange?: [number, number];
    executable?: string;
    executableRange?: [number, number];
}

/**
 * 掩码 Python 注释与三引号 docstring(等长空格替换、保留 \n,offset 不变)。
 * 2026-09-05(审计 L-F1 收窄):注释/docstring 里的 os.path.join、launch 字面量不再成链;
 * 单行单/双引号字符串保留(真实 include 字面量住在里面,掩码会误伤)。
 */
export function maskPythonNoise(text: string): string {
    const out = text.split("");
    const n = text.length;
    const maskFrom = (start: number, end: number): void => {
        for (let i = start; i < end && i < n; i++) {
            if (out[i] !== "\n") {
                out[i] = " ";
            }
        }
    };
    let i = 0;
    while (i < n) {
        const c = text[i];
        if (c === "#") {
            let j = i;
            while (j < n && text[j] !== "\n") {
                j++;
            }
            maskFrom(i, j);
            i = j;
            continue;
        }
        if (c === "'" || c === '"') {
            if (i + 2 < n && text[i + 1] === c && text[i + 2] === c) {
                // 三引号(docstring):整体掩码
                let j = i + 3;
                while (j < n) {
                    if (text[j] === "\\") {
                        j += 2;
                        continue;
                    }
                    if (text[j] === c && text[j + 1] === c && text[j + 2] === c) {
                        j += 3;
                        break;
                    }
                    j++;
                }
                maskFrom(i, j);
                i = j;
                continue;
            }
            // 单行字符串:保留内容,只跳过(内含转义引号)
            i++;
            while (i < n && text[i] !== "\n") {
                if (text[i] === "\\") {
                    i += 2;
                    continue;
                }
                if (text[i] === c) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        i++;
    }
    return out.join("");
}

/** include 语境调用名单(join 语义门;2026-09-06 增 AnyLaunchDescriptionSource,适配 launch_ros 新写法) */
const INCLUDE_CTX_RE = /(?:IncludeLaunchDescription|IncludeLaunchFile|PythonLaunchDescriptionSource|FileLaunchDescriptionSource|AnyLaunchDescriptionSource)/;

/** join 是否具 launch include 语义(2026-09-05 L-F2 收窄):末段字面量须是 .launch.(py|xml|yaml) 且处于 include/描述源调用上下文 */
function joinLooksLikeLaunch(src: string, argsText: string, openIndex: number): boolean {
    const parts = splitTopLevel(argsText);
    const last = parts.length > 0 ? parts[parts.length - 1].trim() : "";
    if (!/^['"][^'"]*\.launch\.(?:py|xml|yaml)['"]$/.test(last)) {
        return false;
    }
    // 近窗口内存在 include 调用上下文(IncludeLaunchDescription / IncludeLaunchFile / …DescriptionSource)
    const before = src.slice(Math.max(0, openIndex - 1200), openIndex);
    return INCLUDE_CTX_RE.test(before);
}

/**
 * 顶部/局部简单赋值变量表(2026-09-06 升级,用户口径:假设不引入外部变量,只解析文件内静态赋值):
 *   NAME = "literal"
 *   NAME = get_package_share_directory('pkg')
 *   NAME = os.path.join(...)            (递归:参数可为字面量/上述调用/其它变量)
 * 动态/未知(LaunchConfiguration、os.environ、函数调用等)一律不进表 → 引用它的 include 解析失败 → 静默。
 * 逐行扫描(掩码后文本,注释/docstring 已剔除;单行赋值;同名后写覆盖)。
 */
function collectSimpleVars(src: string, packages: PackageMap): Map<string, string> {
    const vars = new Map<string, string>();
    const lineRe = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(src)) !== null) {
        const name = m[2];
        const expr = m[3].trim();
        if (expr.length === 0) {
            continue;
        }
        const v = evalStaticExpr(expr, packages, vars, 0);
        if (v !== undefined) {
            vars.set(name, v);
        }
    }
    return vars;
}

/** 递归求值静态表达式(字面量 / get_package_share_directory / os.path.join / 变量引用);深度限 5 */
function evalStaticExpr(
    exprRaw: string,
    packages: PackageMap,
    vars: Map<string, string>,
    depth: number
): string | undefined {
    if (depth > 5) {
        return undefined;
    }
    const expr = exprRaw.trim();
    // 1) 字面量字符串
    const strM = expr.match(/^['"]([^'"]*)['"]$/);
    if (strM) {
        return strM[1];
    }
    // 2) get_package_share_directory('pkg') → 包目录(工作区/已缓存系统包)
    const pkgM = expr.match(/^get_package_share_directory\s*\(\s*['"]([^'"]+)['"]\s*\)\s*$/);
    if (pkgM) {
        const dir = packages.get(pkgM[1]);
        return dir ? dir.fsPath : undefined;
    }
    // 3) os.path.join(...) → 逐参数递归拼接
    const joinM = expr.match(/^os\.path\.join\s*\(/);
    if (joinM) {
        const open = expr.indexOf("(");
        const close = findMatchingParen(expr, open);
        if (close < 0) {
            return undefined;
        }
        const parts = splitTopLevel(expr.slice(open + 1, close));
        const segs: string[] = [];
        for (const part of parts) {
            const v = evalStaticExpr(part, packages, vars, depth + 1);
            if (v === undefined) {
                return undefined;
            }
            segs.push(v);
        }
        if (segs.length === 0) {
            return undefined;
        }
        return path.join(segs[0], ...segs.slice(1));
    }
    // 4) 变量引用
    const varM = expr.match(/^[A-Za-z_][A-Za-z0-9_]*$/);
    if (varM && vars.has(expr)) {
        return vars.get(expr);
    }
    return undefined; // 其它(外部变量/动态):不进表
}

/** 扫描 launch.py 文本中的 include 表达式(与文件内链接 / 树共用) */
export function scanLaunchIncludes(
    text: string,
    docUri: vscode.Uri,
    packages: PackageMap
): LaunchInclude[] {
    const includes: LaunchInclude[] = [];
    // 2026-09-05(L-F1):注释/docstring 先掩码(等长,offset 不变),后续一律扫 src
    const src = maskPythonNoise(text);
    // 2026-09-06:简单赋值变量表(解析 join 里的变量段;外部变量假设不存在)
    const vars = collectSimpleVars(src, packages);

    // 1) os.path.join(...) 组合构造(优先,内部字符串不单独成链)
    const joinStartRe = /os\.path\.join\s*\(/g;
    const covered: Array<[number, number]> = []; // 全跨度(LD-4:字面量案去重依据,与呈现范围分离)
    let jm: RegExpExecArray | null;
    while ((jm = joinStartRe.exec(src)) !== null) {
        const openIndex = src.indexOf("(", jm.index + "os.path.join".length);
        const closeIndex = findMatchingParen(src, openIndex);
        if (closeIndex < 0) {
            continue;
        }
        const argsText = src.slice(openIndex + 1, closeIndex);
        if (!joinLooksLikeLaunch(src, argsText, openIndex)) {
            continue; // 非 launch include 语义的 join(如 config/params 拼路径)不成链(L-F2)
        }
        // LD-4(2026-09-30,用户点 3):链接/hover/F12 命中范围收窄为末段 .launch.* 字面量的
        // 引号内内容(joinLooksLikeLaunch 已保证末参是 .launch.* 字面量)——os.path.join 与
        // 变量段不再被我们的下划线罩住,让位 python 自身跳转/悬浮;解析逻辑零改动
        const joinSeg = src.slice(openIndex + 1, closeIndex);
        const litInJoin = /['"]([^'"]*\.launch\.(?:py|xml|yaml))['"]/g;
        let lastLit: RegExpExecArray | null;
        let cur: RegExpExecArray | null;
        while ((cur = litInJoin.exec(joinSeg)) !== null) {
            lastLit = cur;
        }
        let rangeStart = jm.index;
        let rangeEnd = closeIndex + 1;
        if (lastLit) {
            const litBase = openIndex + 1 + lastLit.index;
            rangeStart = litBase + 1;                    // 去开引号
            rangeEnd = litBase + lastLit[0].length - 1;  // 去闭引号
        }
        covered.push([jm.index, closeIndex + 1]);
        includes.push({
            target: resolveJoinExpr(argsText, packages, vars),
            expr: src.slice(jm.index, closeIndex + 1),
            start: rangeStart,
            end: rangeEnd
        });
    }

    // 2) 字符串字面量 launch 路径(排除已被 os.path.join 覆盖的区域;LD-4:覆盖判定用全跨度 covered)
    // 2026-09-05:后缀含 yaml——yaml 是最简格式、只作"被跳目标"(自身无 include 出边),py 字面量 include 它时也要可跳
    const litRe = /['"]([^'"]*\.launch\.(?:py|xml|yaml))['"]/g;
    let lm: RegExpExecArray | null;
    while ((lm = litRe.exec(src)) !== null) {
        if (covered.some(([s, e]) => lm!.index >= s && lm!.index < e)) {
            continue; // 位于某个 os.path.join 表达式内
        }
        const raw = lm[1];
        const exprStart = lm.index + 1; // 去掉引号
        includes.push({
            target: resolveLiteral(raw, docUri, packages),
            expr: raw,
            start: exprStart,
            end: exprStart + raw.length
        });
    }

    // 2026-09-06(用户口径):解析不成功 → 静默失败(不给假链接、不弹"未解析")
    return includes.filter(inc => inc.target !== undefined);
}

/**
 * 扫描 launch.py 文本中全部 Node 系调用(LE-1;掩码后,嵌套各算各;只认字面量参数)。
 * 供 DocumentLink(pkg/exec 值的文件级直达链接)与 pyNodeCallAt(定位)共用。
 */
const PY_WORD_RE = /[A-Za-z0-9_]/;

/**
 * 在 call 区间原文 [start, end) 上做代码态游走,提取 `name=` 后第一个字符串字面量**及其相邻拼接**
 * (LF-2:注释跳过、字符串经 parsePyString 整体消费——转义/三引号/多行/续行全支持;
 * LI:相邻纯字面量拼接支持——长名拆行写法;非字符串值 → undefined)。
 */
function grabKwargString(text: string, start: number, end: number, name: string): { v: string; r: [number, number] } | undefined {
    let i = start;
    while (i < end) {
        const c = text[i];
        if (c === "#") {
            while (i < end && text[i] !== "\n") {
                i++;
            }
            continue;
        }
        if (c === "'" || c === '"' || ((c === "r" || c === "R") && (text[i + 1] === "'" || text[i + 1] === '"'))) {
            const ps = parsePyString(text, i);
            i = ps ? ps.nodeEnd : i + 1;
            continue;
        }
        if (text.startsWith(name, i) && (i === start || !PY_WORD_RE.test(text[i - 1]))) {
            const after = text[i + name.length] ?? "";
            if (!PY_WORD_RE.test(after)) {
                let j = i + name.length;
                while (j < end && (text[j] === " " || text[j] === "\t" || (text[j] === "\\" && text[j + 1] === "\n"))) {
                    j += text[j] === "\\" ? 2 : 1;
                }
                if (text[j] === "=" && text[j + 1] !== "=") {
                    j++;
                    while (j < end && (text[j] === " " || text[j] === "\t" || (text[j] === "\\" && text[j + 1] === "\n"))) {
                        j += text[j] === "\\" ? 2 : 1;
                    }
                    const ps = parsePyStringConcatenation(text, j);
                    if (ps) {
                        return { v: ps.value, r: [ps.contentStart, ps.contentEnd] };
                    }
                    return undefined; // 非字符串值(变量/数字/调用)→ 字面量口径忽略
                }
            }
        }
        i++;
    }
    return undefined;
}

export function scanLaunchNodeRefs(text: string): LaunchNodeRef[] {
    const src = maskPythonNoise(text);
    const re = /\b(Node|LifecycleNode|ComposableNode|ComposableNodeContainer)\s*\(/g;
    const out: LaunchNodeRef[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const open = src.indexOf("(", m.index);
        const close = findMatchingParen(src, open);
        if (close < 0) {
            continue;
        }
        const kind: LaunchNodeRef["kind"] = m[1] === "LifecycleNode" ? "lifecycle"
            : m[1] === "ComposableNode" ? "composable" : m[1] === "ComposableNodeContainer" ? "container" : "node";
        // LF-2:值提取改在原文上进行(掩码仅用于 call 检测;offset 等长互通)——
        // 三引号/转义/多行/注释内的值不再丢失或截断
        const pkg = grabKwargString(text, open + 1, close, "package");
        const exe = grabKwargString(text, open + 1, close, "executable");
        out.push({
            kind,
            callStart: m.index,
            callEnd: close + 1,
            package: pkg?.v,
            packageRange: pkg?.r,
            executable: exe?.v,
            executableRange: exe?.r
        });
    }
    return out;
}

/** 光标所在 Node 系调用的分段信息(LA-3 解析跳转;值 range 不含引号,供"光标是否落在值内"判定) */
export interface PyNodeCallAt {
    kind: "node" | "lifecycle" | "composable" | "container";
    callStart: number;
    callEnd: number;
    package?: string;
    packageRange?: [number, number];
    executable?: string;
    executableRange?: [number, number];
}

/**
 * 定位 offset 所在的最内层 Node 系调用(嵌套取内层,如 ComposableNode ⊂ ComposableNodeContainer)。
 * 注释/docstring 已掩码;只认字面量参数(与 scanLaunchNodeRefs 同口径)。
 */
export function pyNodeCallAt(text: string, offset: number): PyNodeCallAt | undefined {
    let best: LaunchNodeRef | undefined;
    for (const ref of scanLaunchNodeRefs(text)) {
        if (offset < ref.callStart || offset > ref.callEnd) {
            continue;
        }
        // 最内层优先(嵌套时小调用覆盖)
        if (!best || (ref.callEnd - ref.callStart) < (best.callEnd - best.callStart)) {
            best = ref;
        }
    }
    return best;
}

/** 解析 os.path.join(...) 参数:get_package_share_directory('pkg') / 字面量段 / 简单变量引用(2026-09-06) */
function resolveJoinExpr(
    argsText: string,
    packages: PackageMap,
    vars: Map<string, string>
): vscode.Uri | undefined {
    const parts = splitTopLevel(argsText);
    const segments: string[] = [];
    for (const part of parts) {
        const p = part.trim();
        // get_package_share_directory('pkg')
        const pkgM = p.match(/get_package_share_directory\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (pkgM) {
            const pkgDir = packages.get(pkgM[1]);
            if (!pkgDir) {
                log.debug(vscode.l10n.t("get_package_share_directory package miss: {0}", pkgM[1]));
                return undefined;
            }
            segments.push(pkgDir.fsPath);
            continue;
        }
        // 字面量字符串段
        const strM = p.match(/^['"]([^'"]*)['"]$/);
        if (strM) {
            segments.push(strM[1]);
            continue;
        }
        // 简单变量段(顶部赋值表;外部变量假设不存在,未命中即失败 → 静默)
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) {
            const v = vars.get(p);
            if (v === undefined) {
                log.debug(vscode.l10n.t("join variable miss: {0}", p));
                return undefined;
            }
            segments.push(v);
            continue;
        }
        // 其它(表达式)无法静态解析
        return undefined;
    }
    if (segments.length === 0) {
        return undefined;
    }
    const joined = path.join(segments[0], ...segments.slice(1));
    if (fs.existsSync(joined)) {
        return vscode.Uri.file(joined);
    }
    return undefined;
}

/** 解析字符串字面量路径:$(find-pkg-share pkg)/... 或相对/绝对路径 */
function resolveLiteral(
    raw: string,
    docUri: vscode.Uri,
    packages: PackageMap
): vscode.Uri | undefined {
    const rel = raw.trim();
    if (!rel) {
        return undefined;
    }
    // $(find-pkg-share pkg)/rest | $(find pkg)/rest
    if (rel.indexOf("$(") >= 0) {
        const resolved = packages.resolveFindExpr(rel);
        if (resolved && fs.existsSync(resolved.fsPath)) {
            return resolved;
        }
        return undefined;
    }
    // 其它表达式(变量等)跳过
    if (rel.indexOf("${") >= 0) {
        return undefined;
    }
    // 相对/绝对路径
    const p = path.isAbsolute(rel)
        ? rel
        : path.join(path.dirname(docUri.fsPath), rel);
    return fs.existsSync(p) ? vscode.Uri.file(p) : undefined;
}

/** 从 openIndex 的 '(' 开始找配对的 ')' 位置 */
function findMatchingParen(text: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
        const c = text[i];
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

/** 按顶层括号深度用逗号分割参数 */
function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "(") {
            depth++;
        } else if (c === ")") {
            depth--;
        }
        if (c === "," && depth === 0) {
            parts.push(cur);
            cur = "";
            continue;
        }
        cur += c;
    }
    parts.push(cur);
    return parts;
}
