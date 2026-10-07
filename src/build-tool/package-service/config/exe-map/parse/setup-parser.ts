import * as fs from "fs";
import * as path from "path";

/**
 * setup.py 解析器（TS 静态 + 可安全展开的动态 + 动态层检测，独立模块，2026-08-22 v5）
 *
 * 从 ament_python 包的 setup.py 中，按 setup(**kwargs) 传入参数**逐条**解析，
 * **对照 setuptools.setup() 完整签名，包不漏**（用户 2026-08-22 提供签名）。
 *
 * 分层（用户 2026-08-22 设计）：
 *  - **静态可解析层**：字面量 / 顶部变量表（标识符 = 字面量或列表字面量）/
 *    字符串拼接 → 解析出**值**；
 *  - **可安全展开的动态（v5）**：`find_packages()`（TS 文件系统等价扫描，对齐
 *    setuptools 59.6.0 语义）、`glob()`（TS glob 展开）、列表推导 + 顶部列表
 *    字面量（模板展开）——真值 TS 无副作用可得，展开成功则不标 dynamic；
 *  - **动态层检测层**：展开失败或不可展开的动态，只识别表达式的**结构**（列表
 *    推导 / f-string / 函数调用）与**依赖**（iterable 变量、引用变量、函数参数），
 *    把依赖变量的**当前值**纳入语义指纹；
 *  - **语义指纹**：hash(静态字段值 + 动态模板[变量名规范化] + 动态依赖值)，
 *    对**变量名**不敏感、对**语义值**敏感——变量改名但值不变，指纹不变；
 *  - **变化事件出口**：`SetupChangeDetector` 持有 path→指纹缓存，检测到指纹变化
 *    触发 `onDidChange`，供外部（python ast 解析层 / executable-map / 缓存层）
 *    订阅，分离检测与解析。
 *
 * API 使用约定（2026-08-22 用户拍板）：
 *  - **主用 API 只有一个**：`parseSetupPy(text)` —— 一个文件内容进、一个解析结果出（纯函数）；
 *  - **`fingerprint`（语义指纹）为顺带输出**，当前可能不使用；
 *  - **`SetupChangeDetector` / `onDidChange` 事件接口为预留**：不会被删除，但当前**无人引用**，
 *    仅留作未来接入（python ast / executable-map / 缓存层）的出口；
 *  - 解析行为向下兼容，不做破坏性改动。
 *
 * 设计原则（用户定）：
 *  1. 每一个字段都**允许解析失败**，独立容错——某个字段失败不导致整体返回失败；
 *  2. 多多益善——能解析多少字段就解析多少；
 *  3. 不解析任意动态（for 循环语句 / 任意表达式），只做确定性结构识别；
 *  4. 纯 TS，无 vscode / child_process 依赖，可无头测试。
 */

/** 一条 console_scripts 入口点 */
export interface ConsoleScript {
    /** 可执行命令名（console_scripts 项的 '=' 左侧） */
    name: string;
    /** 模块路径（'module:func' 的 module 部分） */
    module: string;
    /** 入口函数（'module:func' 的 func 部分） */
    func: string;
}

/** data_files 的一条记录：(目标目录, [文件列表]) */
export interface DataFileEntry {
    /** 目标安装目录（如 share/<pkg>/launch；变量拼接经变量表展开） */
    target: string;
    /** 文件列表（字面量/变量展开；动态表达式如 glob() 提取不到时为空） */
    files: string[];
    /** 该条是否含动态表达式（glob 等），静态无法完整解析 */
    dynamic?: boolean;
}

/** package_data 等字典的一条记录：{ 'key': [文件] } */
export interface PackageDataEntry {
    /** dict 的 key（如包名或 ''） */
    key: string;
    /** 字面量文件 glob 列表 */
    files: string[];
}

/** 动态表达式依赖描述（不解析值，只记录结构 + 依赖变量的当前值，供语义指纹用） */
export interface DynamicDep {
    /** 动态形态 */
    kind: "listcomp" | "fstring" | "funcall" | "other";
    /** 规范化模板（变量名已替换为值/占位符，名字无关） */
    template: string;
    /** 依赖变量名 → 当前值（值参与指纹） */
    depVars: Record<string, string>;
    /** 函数调用名（funcall 时） */
    callName?: string;
}

/** setup.py 解析结果（多多益善；逐字段独立容错） */
export interface SetupPyParseResult {
    /** 是否找到 setup() 调用 */
    found: boolean;
    /** 检测到的 kwargs 键名列表（原始顺序） */
    keys: string[];
    /** 是否检测到动态构造（部分字段可能不完整） */
    dynamic: boolean;
    /** 字段解析失败记录（容错：记录但不阻断整体） */
    issues: string[];

    // —— 字符串字段 ——
    name?: string;
    version?: string;
    author?: string;
    authorEmail?: string;
    maintainer?: string;
    maintainerEmail?: string;
    url?: string;
    license?: string;
    description?: string;
    longDescription?: string;
    downloadUrl?: string;
    licenseExpression?: string;
    longDescriptionContentType?: string;
    extPackage?: string;
    srcRoot?: string;

    // —— 布尔字段 ——
    zipSafe?: boolean;
    verbose?: boolean;
    help?: boolean;
    helpCommands?: boolean;
    includePackageData?: boolean;

    // —— 字符串或字符串列表 ——
    keywords: string[];
    platforms: string[];
    classifiers: string[];
    requires: string[];
    provides: string[];
    obsoletes: string[];

    // —— 字符串列表 ——
    packages: string[];
    pyModules: string[];
    headers: string[];
    scripts: string[];
    dependencyLinks: string[];
    setupRequires: string[];
    installRequires: string[];
    testsRequire: string[];
    commandPackages: string[];
    licenseFiles: string[];

    // —— 安装数据 / 资源 ——
    dataFiles: DataFileEntry[];
    packageData: PackageDataEntry[];
    excludePackageData: PackageDataEntry[];
    extrasRequire: PackageDataEntry[];
    packageDir: Record<string, string>;
    projectUrls: Record<string, string>;

    // —— 可执行入口 ——
    entryPoints: Record<string, string[]>;
    consoleScripts: ConsoleScript[];

    // —— 复杂/未知字段原始表达式（包不漏：不深度解析也保留） ——
    raw: Record<string, string>;

    // —— 动态层检测（静态可解析 + 动态依赖识别） ——
    /** 字段名 → 动态表达式依赖描述（不解析值，只记结构与依赖） */
    dynamicDeps: Record<string, DynamicDep[]>;
    /** 语义指纹（静态值 + 动态模板 + 依赖值，变量名无关） */
    fingerprint: string;
}

// ============================================================================
// 文件系统访问抽象（可安全展开的动态：find_packages / glob 需要文件系统）
// ============================================================================

/**
 * 文件系统访问抽象。生产用 node:fs 默认实现；测试用内存 mock，保持无头可测。
 * 纯 TS，无 vscode / child_process 依赖（不 spawn python）。
 */
export interface SetupFs {
    /** 路径是否为普通文件 */
    isFile(p: string): boolean;
    /** 路径是否为目录（跟随符号链接，对齐 os.walk(followlinks=True)） */
    isDirectory(p: string): boolean;
    /** 列出目录子项名称（文件与目录） */
    readdir(p: string): string[];
}

/** node:fs 默认实现 */
export const nodeFs: SetupFs = {
    isFile: (p) => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
    },
    isDirectory: (p) => {
        try { return fs.statSync(p).isDirectory(); } catch { return false; }
    },
    readdir: (p) => {
        try { return fs.readdirSync(p); } catch { return []; }
    },
};

/** parseSetupPy 选项：提供文件系统上下文后，find_packages/glob 可安全展开 */
export interface SetupParseOptions {
    /** setup.py 所在包根目录（find_packages / glob 的相对基准；绝对或相对路径） */
    packageDir?: string;
    /** 文件系统访问器（默认 node:fs） */
    fs?: SetupFs;
}

/** 从 openIndex 开始找与 open 配对的 close（括号深度计数），找不到返回 -1 */
function findMatching(text: string, openIndex: number, open: string, close: string): number {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
        if (text[i] === open) {
            depth++;
        } else if (text[i] === close) {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/** 提取第一个 setup( 调用的参数体（不含最外层括号） */
function extractSetupCall(text: string): string | undefined {
    const re = /\bsetup\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const openIndex = text.indexOf("(", m.index);
        const closeIndex = findMatching(text, openIndex, "(", ")");
        if (closeIndex < 0) {
            continue;
        }
        return text.slice(openIndex + 1, closeIndex);
    }
    return undefined;
}

/**
 * 将 setup() 参数体按顶层逗号分割为 [key, value] 列表。
 * value 保留原始表达式文本（可能含嵌套括号/引号）。
 */
function splitTopLevelKwargs(callText: string): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    for (const part of splitTopLevelItems(callText)) {
        const kv = splitKeyValue(part);
        if (kv) {
            pairs.push(kv);
        }
    }
    return pairs;
}

/** 按顶层逗号分割为项列表（括号/引号内逗号忽略） */
function splitTopLevelItems(body: string): string[] {
    const items: string[] = [];
    let depth = 0;
    let quote: string | undefined;
    let cur = "";
    for (const c of body) {
        if (quote) {
            cur += c;
            if (c === quote) {
                quote = undefined;
            }
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            cur += c;
            continue;
        }
        if (c === "(" || c === "[" || c === "{") {
            depth++;
        } else if (c === ")" || c === "]" || c === "}") {
            depth--;
        }
        if (c === "," && depth === 0) {
            items.push(cur.trim());
            cur = "";
            continue;
        }
        cur += c;
    }
    if (cur.trim()) {
        items.push(cur.trim());
    }
    return items;
}

/** 将单个 kwarg 文本 'key = value' 拆为 [key, value]，非法返回 undefined */
function splitKeyValue(kwarg: string): [string, string] | undefined {
    const eq = kwarg.indexOf("=");
    if (eq < 0) {
        return undefined;
    }
    const key = kwarg.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return undefined;
    }
    return [key, kwarg.slice(eq + 1).trim()];
}

/** 剥离 Python 注释（引号外的 # 到行尾），保留字符串字面量内的 #。 */
function stripPythonComments(text: string): string {
    let out = "";
    let quote: string | undefined;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            out += c;
            if (c === "\\") {
                out += text[i + 1] ?? "";
                i++;
            } else if (c === quote) {
                quote = undefined;
            }
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            out += c;
            continue;
        }
        if (c === "#") {
            // 跳过到行尾
            while (i < text.length && text[i] !== "\n") {
                i++;
            }
            out += "\n";
            continue;
        }
        out += c;
    }
    return out;
}

/** 各行的括号深度(行首处,字符串内的括号不计);用于区分模块级赋值与调用体内 kwarg */
function lineStartDepths(text: string): number[] {
    const depths: number[] = [0];
    let d = 0;
    let q: string | undefined;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "\n") { depths.push(d); continue; }
        if (q) { if (c === q) { q = undefined; } continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === "(" || c === "[" || c === "{") { d++; }
        else if (c === ")" || c === "]" || c === "}") { d = Math.max(0, d - 1); }
    }
    return depths;
}

function lineIndexOf(text: string, pos: number): number {
    let n = 0;
    for (let i = 0; i < pos && i < text.length; i++) { if (text[i] === "\n") { n++; } }
    return n;
}

/**
 * 收集 setup.py 顶层的简单赋值(2026-09-04 增强):
 *  - **仅模块级(括号深度 0)行**收集——setup() 调用体内的 `install_requires=…` 等 kwarg 不误收;
 *  - 标量/单行字符串、布尔、数字(含 `name: str = "…"` 类型注解形式);
 *  - **容器字面量**(多行 `[...]` / `{...}`,含嵌套与类型注解,如
 *    `entry_points: Dict[str, List[str]] = {…}` / `data_files = [ … ]`)→ 存其原始字面量文本;
 *  - 供 setup() 实参为标识符时按字面量继续解析(不再因“值不是字面量”跳过)。
 */
function collectTopLevelVars(text: string): Map<string, string> {
    const vars = new Map<string, string>();
    const depths = lineStartDepths(text);
    const re = /^[ \t]*([A-Za-z_]\w*)(?:\s*:[^\r\n]*?)?\s*=/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (PY_KEYWORDS.has(name) || name === "setup") { continue; }
        const ln = lineIndexOf(text, m.index);
        if (depths[ln] !== 0) { continue; } // 非模块级(如 setup() 参数内 kwarg)不收
        const eqAbs = m.index + m[0].length - 1; // '=' 位置
        let v = eqAbs + 1;
        while (v < text.length && /\s/.test(text[v])) { v++; }
        const c = text[v];
        const noLineEnd = text.indexOf("\n", v);
        const endLine = noLineEnd < 0 ? text.length : noLineEnd;
        if (c === "{" || c === "[") {
            const close = findMatching(text, v, c, c === "{" ? "}" : "]");
            if (close > v) {
                vars.set(name, text.slice(v, close + 1));
                re.lastIndex = close + 1;
                continue;
            }
        } else if (c === "'" || c === '"') {
            let e = v + 1;
            while (e < text.length && e < endLine) {
                if (text[e] === "\\") { e += 2; continue; }
                if (text[e] === c) { break; }
                e++;
            }
            if (e < text.length && e < endLine) {
                vars.set(name, text.slice(v, e + 1));
                re.lastIndex = e + 1;
                continue;
            }
            vars.set(name, text.slice(v, endLine).trim());
            re.lastIndex = endLine + 1;
            continue;
        }
        vars.set(name, text.slice(v, endLine).trim());
        re.lastIndex = endLine + 1;
    }
    return vars;
}

/**
 * setup() 实参为标识符且模块级变量是**容器字面量** → 展开为其原始文本;
 * 标量仍保留标识符(走 resolveExpression),其它原样返回。
 */
function expandLiteralRef(raw: string, vars: Map<string, string>): string {
    const m = /^([A-Za-z_]\w*)$/.exec(raw.trim());
    if (!m) { return raw; }
    const vv = vars.get(m[1]);
    if (vv && (vv.startsWith("[") || vv.startsWith("{"))) { return vv; }
    return raw;
}

/**
 * 用变量表展开表达式：提取字面量片段 + 变量引用并拼接。
 * 如 `'share/' + package_name + '/launch'` + {package_name:"'rde_py'"} → "share/rde_py/launch"
 * 无法展开的片段（变量不在表内 / 函数调用等）返回 undefined。
 */
function resolveExpression(expr: string, vars: Map<string, string>): string | undefined {
    // 纯字面量
    const lit = expr.match(/^(?:f|r|b|fr|rf)?['"]([^'"]*)['"]$/);
    if (lit) {
        return lit[1];
    }
    // 纯变量引用
    const varOnly = expr.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
    if (varOnly) {
        const v = vars.get(varOnly[1]);
        return v !== undefined ? parseStringLiteral(v) : undefined;
    }
    // 拼接：'lit' + var + 'lit' ...
    if (expr.includes("+")) {
        let resolved = "";
        for (const part of splitTopLevelItems(expr.replace(/\s*\+\s*/g, ","))) {
            const litPart = part.match(/^(?:f|r|b|fr|rf)?['"]([^'"]*)['"]$/);
            if (litPart) {
                resolved += litPart[1];
                continue;
            }
            const varPart = part.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
            if (varPart) {
                const v = vars.get(varPart[1]);
                if (v === undefined) {
                    return undefined;
                }
                const val = parseStringLiteral(v);
                if (val === undefined) {
                    return undefined;
                }
                resolved += val;
                continue;
            }
            // 其它表达式（函数调用等）无法静态展开
            return undefined;
        }
        return resolved;
    }
    return undefined;
}

/** 解析字符串字面量值：'x' / "x"。非纯字面量（f'..'、变量等）返回 undefined */
function parseStringLiteral(value: string): string | undefined {
    const m = value.match(/^(?:f|r|b|fr|rf)?['"]([^'"]*)['"]$/);
    return m ? m[1] : undefined;
}

/** 解析布尔字面量：True / False */
function parseBoolLiteral(value: string): boolean | undefined {
    if (value === "True") {
        return true;
    }
    if (value === "False") {
        return false;
    }
    return undefined;
}

/** 从字符串列表中提取所有字符串字面量（忽略动态表达式） */
function parseStringList(body: string): string[] {
    const items: string[] = [];
    const re = /['"]([^'"]*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        items.push(m[1]);
    }
    return items;
}

/**
 * 解析 `[...]` 列表值为字符串数组。
 * 有变量表时逐项展开（支持变量引用 / 拼接）；无变量表时仅字面量。
 */
function parseStringListLiteral(value: string, vars?: Map<string, string>): string[] {
    if (!value.startsWith("[")) {
        return [];
    }
    const close = findMatching(value, 0, "[", "]");
    if (close < 0) {
        return [];
    }
    const body = value.slice(1, close);
    if (!vars) {
        return parseStringList(body);
    }
    const out: string[] = [];
    for (const part of splitTopLevelItems(body)) {
        const resolved = resolveExpression(part, vars);
        if (resolved !== undefined) {
            out.push(resolved);
        }
    }
    return out;
}

/** 解析单条 console_scripts 项：'name = module:func' */
function parseConsoleScriptItem(item: string): ConsoleScript | undefined {
    const eq = item.indexOf("=");
    if (eq < 0) {
        return undefined;
    }
    const name = item.slice(0, eq).trim();
    const target = item.slice(eq + 1).trim();
    const colon = target.lastIndexOf(":");
    if (colon < 0) {
        return undefined;
    }
    return {
        name,
        module: target.slice(0, colon).trim(),
        func: target.slice(colon + 1).trim(),
    };
}

/** 动态构造特征检测（表达式文本内出现即视为静态无法完整解析） */
function hasDynamicConstruct(expr: string): boolean {
    // 列表推导
    if (/\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b/.test(expr)) {
        return true;
    }
    // f-string / join
    if (/f['"]/.test(expr) || /\.join\(/.test(expr)) {
        return true;
    }
    // 函数调用（glob / find_packages / range 等）
    if (/[A-Za-z_][A-Za-z0-9_]*\(/.test(expr)) {
        return true;
    }
    return false;
}

/** 在字符串中找顶层（非括号/引号内）第一个逗号的位置 */
function indexOfTopLevel(s: string): number {
    let depth = 0;
    let quote: string | undefined;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === quote) {
                quote = undefined;
            }
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            continue;
        }
        if (c === "(" || c === "[" || c === "{") {
            depth++;
        } else if (c === ")" || c === "]" || c === "}") {
            depth--;
        }
        if (c === "," && depth === 0) {
            return i;
        }
    }
    return -1;
}

/** 解析 data_files 值：[(target, [files]), ...]（target/files 支持变量表展开；glob() 可展开） */
function parseDataFiles(value: string, vars?: Map<string, string>, opts?: SetupParseOptions): DataFileEntry[] {
    const entries: DataFileEntry[] = [];
    if (!value.startsWith("[")) {
        return entries;
    }
    const close = findMatching(value, 0, "[", "]");
    if (close < 0) {
        return entries;
    }
    const body = value.slice(1, close);
    for (const part of splitTopLevelItems(body)) {
        if (!part.startsWith("(")) {
            continue;
        }
        const pc = findMatching(part, 0, "(", ")");
        if (pc < 0) {
            continue;
        }
        const inner = part.slice(1, pc);
        const firstComma = indexOfTopLevel(inner);
        if (firstComma < 0) {
            continue;
        }
        const targetExpr = inner.slice(0, firstComma).trim();
        const filesExpr = inner.slice(firstComma + 1).trim();
        const target = (vars ? resolveExpression(targetExpr, vars) : parseStringLiteral(targetExpr)) ?? "";
        const files = parseStringListLiteral(filesExpr, vars);
        // glob('pattern') 安全展开（文件系统 glob → 真实文件相对路径；展开成功则值确定）
        const globbed = files.length === 0 ? expandGlobCall(filesExpr, vars, opts) : undefined;
        if (globbed) {
            files.push(...globbed);
        }
        const dynamic =
            (hasDynamicConstruct(filesExpr) && globbed === undefined) ||
            hasDynamicConstruct(targetExpr);
        entries.push({ target, files, dynamic: dynamic || undefined });
    }
    return entries;
}

/** 解析 package_data / exclude_package_data / extras_require 值：{ 'key': [...], ... } */
function parsePackageData(value: string): PackageDataEntry[] {
    const entries: PackageDataEntry[] = [];
    if (!value.startsWith("{")) {
        return entries;
    }
    const close = findMatching(value, 0, "{", "}");
    if (close < 0) {
        return entries;
    }
    const body = value.slice(1, close);
    const re = /['"]([^'"]*)['"]\s*:\s*\[/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        const key = m[1];
        const listOpen = body.indexOf("[", m.index);
        const listClose = findMatching(body, listOpen, "[", "]");
        if (listClose < 0) {
            continue;
        }
        entries.push({ key, files: parseStringList(body.slice(listOpen + 1, listClose)) });
    }
    return entries;
}

/** 解析 `{'k': 'v', ...}` 字符串字典（值支持变量表展开） */
function parseStringDict(value: string, vars?: Map<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    if (!value.startsWith("{")) {
        return out;
    }
    const close = findMatching(value, 0, "{", "}");
    if (close < 0) {
        return out;
    }
    const body = value.slice(1, close);
    const re = /['"]([^'"]*)['"]\s*:\s*((?:f|r|b|fr|rf)?['"][^'"]*['"]|[A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        const val = vars ? resolveExpression(m[2], vars) : parseStringLiteral(m[2]);
        if (val !== undefined) {
            out[m[1]] = val;
        }
    }
    return out;
}

/** 从 `{…: {'console_scripts': [...]}}` 字典字面量中取 console_scripts 条目(键以引号界定) */
function consoleScriptsLiteral(dictRaw: string): string[] {
    const m = /['"]console_scripts['"]\s*:\s*\[/g.exec(dictRaw);
    if (!m) { return []; }
    const lb = dictRaw.indexOf("[", m.index);
    const rb = findMatching(dictRaw, lb, "[", "]");
    if (!(rb > lb)) { return []; }
    return parseStringList(dictRaw.slice(lb + 1, rb));
}

/** 模块级赋值名 → 原始容器文本(如 `entry_points = {…}`);找不到返回空串 */
function topLevelVarRaw(text: string, name: string): string {
    const re = new RegExp("^[ \\t]*" + name.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")
        + "(?:\\s*:[^\\r\\n]*?)?\\s*=\\s*([{\\[]) ?(?![\\w])", "gm");
    const m = re.exec(text);
    if (!m) { return ""; }
    const openAt = m.index + m[0].lastIndexOf(m[1]);
    const close = findMatching(text, openAt, m[1], m[1] === "{" ? "}" : "]");
    if (!(close > openAt)) { return ""; }
    return text.slice(openAt, close + 1);
}

/** 解析 entry_points 值：{ 'group': [...], ... }，填入结果；动态列表做结构识别 */
function parseEntryPointsInto(value: string, result: SetupPyParseResult, vars: Map<string, string>, sourceText?: string): void {
    if (!value.startsWith("{")) {
        return;
    }
    const close = findMatching(value, 0, "{", "}");
    if (close < 0) {
        return;
    }
    const body = value.slice(1, close);

    // 2026-09-04:识别「加法式 console_scripts」——键值形如
    //   "console_scripts": entry_points["console_scripts"] + [ 'new = mod:main', … ]
    // (工具在 entry_points 为模块级变量时生成的调用点合并写法)
    {
        const addM = /['"]console_scripts['"]\s*:\s*([A-Za-z_]\w*)\s*\[\s*['"]console_scripts['"]\s*\]\s*\+\s*\[/g;
        const gm = addM.exec(body);
        if (gm) {
            const varName = gm[1];
            const plusAt = body.indexOf("+ [", gm.index);
            if (plusAt >= 0) {
                const lb = plusAt + 2;
                const rb = findMatching(body, lb, "[", "]");
                if (rb > lb) {
                    // 基础入口取模块级变量字典(以源文本为准,vars 表仅作兜底)
                    const varRaw = (sourceText && topLevelVarRaw(sourceText, varName)) || vars.get(varName) || "";
                    const items = [...consoleScriptsLiteral(varRaw),
                        ...parseStringList(body.slice(lb + 1, rb))];
                    result.entryPoints["console_scripts"] = items;
                    for (const it of items) {
                        const cs = parseConsoleScriptItem(it);
                        if (cs) { result.consoleScripts.push(cs); }
                    }
                }
            }
        }
    }

    const groupRe = /['"]([^'"]+)['"]\s*:\s*\[/g;
    let gm: RegExpExecArray | null;
    while ((gm = groupRe.exec(body)) !== null) {
        const group = gm[1];
        const listOpen = body.indexOf("[", gm.index);
        const listClose = findMatching(body, listOpen, "[", "]");
        if (listClose < 0) {
            continue;
        }
        const listBody = body.slice(listOpen + 1, listClose);
        const items = parseStringList(listBody);
        result.entryPoints[group] = items;
        if (group === "console_scripts") {
            // 先尝试列表推导安全展开：'[f\'{n} = {pkg}.{n}:main\' for n in NODES]'
            // iterable 在顶部变量表（列表字面量）→ 模板展开出真实入口，值确定不标 dynamic
            const expanded = expandListComp(listBody, vars);
            if (expanded) {
                for (const item of expanded) {
                    const cs = parseConsoleScriptItem(item);
                    if (cs) {
                        result.consoleScripts.push(cs);
                    }
                }
                continue;
            }
            if (hasDynamicConstruct(listBody)) {
                // 动态列表（f-string/推导/函数调用）：不做字面量解析（模板非真实值），只做结构识别
                result.dynamic = true;
                const key = "entry_points.console_scripts";
                result.dynamicDeps[key] = (result.dynamicDeps[key] || []).concat(
                    analyzeDynamicExpr(listBody, vars),
                );
                continue;
            }
            for (const item of items) {
                const cs = parseConsoleScriptItem(item);
                if (cs) {
                    result.consoleScripts.push(cs);
                }
            }
        }
    }
}

/** 解析值为字符串（单个）或字符串列表，统一返回 string[] */
function parseStringOrStringList(value: string, vars?: Map<string, string>): string[] {
    if (value.startsWith("[")) {
        return parseStringListLiteral(value, vars);
    }
    const s = vars ? resolveExpression(value, vars) : parseStringLiteral(value);
    return s !== undefined ? [s] : [];
}

// ============================================================================
// 动态层检测：结构识别 + 依赖取值 + 语义指纹（名字无关）
// ============================================================================

/** Python 关键字（避免被误当变量引用） */
const PY_KEYWORDS = new Set([
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
    "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
    "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
    "return", "try", "while", "with", "yield", "True", "False", "None",
]);

/**
 * 规范化表达式模板：已知变量名 → 其值，循环变量 → 占位符 $V，
 * 使指纹对**变量名**不敏感、对**值**敏感。
 */
function normalizeTemplate(expr: string, vars: Map<string, string>, loopVars: Set<string>): string {
    return expr.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (m, name: string) => {
        if (PY_KEYWORDS.has(name)) {
            return m;
        }
        if (loopVars.has(name)) {
            return "$V";
        }
        const v = vars.get(name);
        return v !== undefined ? `#{v}#` : m;
    });
}

/** 收集表达式内的变量引用 → 变量当前值（值入指纹；名字不入） */
function collectVarRefs(expr: string, vars: Map<string, string>, out: Record<string, string>): void {
    const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expr)) !== null) {
        const name = m[1];
        if (PY_KEYWORDS.has(name) || name in out) {
            continue;
        }
        const v = vars.get(name);
        if (v !== undefined) {
            out[name] = v;
        }
    }
}

/**
 * 动态表达式结构识别（不解析值）：
 *  - 列表推导 [expr for v in iter]：模板 = 规范化 body，依赖 iterable 变量值
 *  - 函数调用 func(...)：记录 callName 与参数内变量值
 *  - f-string / 其它：记录规范化模板 + 引用变量值
 */
function analyzeDynamicExpr(expr: string, vars: Map<string, string>): DynamicDep {
    const trimmed = expr.trim();
    const dep: DynamicDep = { kind: "other", template: trimmed, depVars: {} };

    // 列表推导 [body for var in iter]
    const lc = trimmed.match(/^\[?([\s\S]*?)\s+for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+?)\]?$/);
    if (lc) {
        const [, bodyExpr, loopVar, iterable] = lc;
        const loopVars = new Set([loopVar]);
        dep.kind = "listcomp";
        dep.template = normalizeTemplate(bodyExpr.trim(), vars, loopVars) + " [for] " + loopVar;
        // iterable 依赖：变量查表取值 / 字面量原样 / 其它表达式
        const iterVar = iterable.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
        if (iterVar) {
            const v = vars.get(iterVar[1]);
            dep.depVars[iterVar[1]] = v !== undefined ? v : "<unresolved>";
        } else {
            dep.depVars["__iter__"] = iterable.trim();
        }
        collectVarRefs(bodyExpr, vars, dep.depVars);
        return dep;
    }

    // 函数调用 func(...)
    const fc = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/);
    if (fc) {
        dep.kind = "funcall";
        dep.callName = fc[1];
        dep.template = normalizeTemplate(trimmed, vars, new Set());
        collectVarRefs(fc[2], vars, dep.depVars);
        return dep;
    }

    // f-string
    if (/f['"]/.test(trimmed)) {
        dep.kind = "fstring";
        dep.template = normalizeTemplate(trimmed, vars, new Set());
        collectVarRefs(trimmed, vars, dep.depVars);
        return dep;
    }

    // 其它动态（拼接/引用等）
    dep.template = normalizeTemplate(trimmed, vars, new Set());
    collectVarRefs(trimmed, vars, dep.depVars);
    return dep;
}

// ============================================================================
// 可安全展开的动态（v5）：find_packages / glob / 列表推导 → TS 无副作用求值
// 对齐 setuptools 59.6.0 实测语义；展开失败返回 undefined，由动态检测层兜底
// ============================================================================

/** 正则转义（供 glob / fnmatch 转正则） */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * fnmatchcase 的 TS 等价（大小写敏感；支持 * 与 ?）。
 * setuptools 的 exclude/include 模式作用于**完整点分包名**（'foo.*' 匹配 foo.bar 但非 foo）。
 */
function fnmatch(name: string, pattern: string): boolean {
    const re = new RegExp(
        "^" +
        pattern
            .split("*")
            .map((seg) => seg.split("?").map(escapeRegex).join("."))
            .join(".*") +
        "$",
    );
    return re.test(name);
}

/**
 * find_packages 的 TS 等价（对照 setuptools PackageFinder 实测语义，2026-08-22）：
 *  1. 从 where 递归找"含 __init__.py 的目录"（_looks_like_package）；
 *  2. 只递归"是包的目录"——非包目录整个跳过（os.walk dirs 清空剪枝）；
 *  3. 包名 = 相对 where 的点分路径（rel_path.replace(sep, '.')）；
 *  4. 目录名含 '.' 跳过（'.' in dir）；
 *  5. include/exclude 为 fnmatch 模式，作用于完整点分包名；
 *  6. 默认排除 'ez_setup' 与 '*__pycache__'；
 *  7. isDirectory 跟随符号链接（对齐 os.walk(followlinks=True)）。
 */
export function findPackages(
    where: string,
    opts: { exclude?: string[]; include?: string[]; fs?: SetupFs } = {},
): string[] {
    const f = opts.fs ?? nodeFs;
    const excludes = ["ez_setup", "*__pycache__", ...(opts.exclude ?? [])];
    const includes = opts.include && opts.include.length > 0 ? opts.include : ["*"];
    const out: string[] = [];

    const walk = (dir: string, relPrefix: string): void => {
        for (const name of f.readdir(dir)) {
            if (name.includes(".")) {
                continue; // 目录名含 '.' → 跳过（不 yield 不递归）
            }
            const full = path.join(dir, name);
            if (!f.isDirectory(full)) {
                continue;
            }
            const rel = relPrefix ? `${relPrefix}.${name}` : name;
            if (!f.isFile(path.join(full, "__init__.py"))) {
                continue; // 非包目录 → 不 yield 不递归（剪枝）
            }
            if (
                includes.some((p) => fnmatch(rel, p)) &&
                !excludes.some((p) => fnmatch(rel, p))
            ) {
                out.push(rel);
            }
            walk(full, rel); // 是包 → 递归
        }
    };

    walk(where, "");
    return out;
}

/**
 * Python glob.glob 的 TS 近似（相对 base，返回 / 分隔的相对路径，对齐 python 输出）。
 * 支持 * 与 ?（不跨段）；不支持 ** 递归（data_files 场景少见）。文件与目录均匹配。
 */
export function expandGlob(base: string, pattern: string, f: SetupFs = nodeFs): string[] {
    const segs = pattern.replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
    const results: string[] = [];

    const walk = (dir: string, relParts: string[], idx: number): void => {
        if (idx >= segs.length) {
            return;
        }
        const seg = segs[idx];
        const last = idx === segs.length - 1;
        if (seg.includes("*") || seg.includes("?")) {
            const re = new RegExp(
                "^" +
                seg
                    .split("*")
                    .map((s2) => s2.split("?").map(escapeRegex).join("."))
                    .join(".*") +
                "$",
            );
            for (const name of f.readdir(dir)) {
                if (!re.test(name)) {
                    continue;
                }
                const full = path.join(dir, name);
                const rel = [...relParts, name].join("/");
                if (last) {
                    results.push(rel);
                } else if (f.isDirectory(full)) {
                    walk(full, [...relParts, name], idx + 1);
                }
            }
        } else {
            const full = path.join(dir, seg);
            if (last) {
                if (f.isFile(full) || f.isDirectory(full)) {
                    results.push([...relParts, seg].join("/"));
                }
            } else if (f.isDirectory(full)) {
                walk(full, [...relParts, seg], idx + 1);
            }
        }
    };

    walk(base, [], 0);
    return results;
}

/** 展开 glob('pattern') 调用：解析参数（字面量/变量）→ expandGlob。未提供 packageDir → undefined */
function expandGlobCall(
    expr: string,
    vars: Map<string, string> | undefined,
    opts?: SetupParseOptions,
): string[] | undefined {
    if (!opts?.packageDir) {
        return undefined;
    }
    const m = expr.trim().match(/^glob\(([\s\S]*)\)$/);
    if (!m) {
        return undefined;
    }
    // vars 可空：无变量表时 pattern 只能是纯字符串字面量
    const pattern = vars ? resolveExpression(m[1].trim(), vars) : parseStringLiteral(m[1].trim());
    if (pattern === undefined) {
        return undefined;
    }
    return expandGlob(opts.packageDir, pattern, opts.fs);
}

/** 展开 find_packages(...) 调用：解析 where/exclude/include（字面量/变量）→ findPackages */
function expandFindPackages(
    value: string,
    vars: Map<string, string>,
    opts?: SetupParseOptions,
): string[] | undefined {
    if (!opts?.packageDir) {
        return undefined;
    }
    const m = value.trim().match(/^find_packages\(([\s\S]*)\)$/);
    if (!m) {
        return undefined;
    }
    let where = ".";
    let exclude: string[] | undefined;
    let include: string[] | undefined;
    for (const a of splitTopLevelItems(m[1])) {
        const kv = splitKeyValue(a);
        if (kv) {
            if (kv[0] === "exclude") {
                exclude = parseStringListLiteral(kv[1], vars);
            } else if (kv[0] === "include") {
                include = parseStringListLiteral(kv[1], vars);
            }
            // 其它关键字参数（如 where=...）少见，忽略
        } else {
            const resolved = resolveExpression(a, vars);
            if (resolved !== undefined) {
                where = resolved;
            }
        }
    }
    const fsr = opts.fs ?? nodeFs;
    // path.join 而非 path.resolve：resolve 在 Windows 会给 POSIX 风格路径加盘符，
    // 破坏无盘符的 mock 树；join 纯拼接，生产（绝对 packageDir）与测试（mock）都正确
    const base = path.join(opts.packageDir, where);
    if (!fsr.isDirectory(base)) {
        return undefined;
    }
    return findPackages(base, { exclude, include, fs: opts.fs });
}

/**
 * 轻量 f-string 求值：只支持 {变量}（循环变量 + 变量表）。
 * 其它（表达式 / :格式化 / !转换 / 嵌套）→ undefined（无法静态展开）。
 */
function evalFString(
    template: string,
    vars: Map<string, string>,
    loopVar: string,
    loopVal: string,
): string | undefined {
    const re = /\{([^}]*)\}/g;
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(template)) !== null) {
        out += template.slice(last, m.index);
        const expr = m[1].trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
            return undefined; // 表达式 / 格式化 → 无法静态展开
        }
        if (expr === loopVar) {
            out += loopVal;
        } else {
            const v = vars.get(expr);
            if (v === undefined) {
                return undefined;
            }
            const val = parseStringLiteral(v);
            if (val === undefined) {
                return undefined;
            }
            out += val;
        }
        last = m.index + m[0].length;
    }
    out += template.slice(last);
    return out;
}

/**
 * 列表推导安全展开：[body for v in iterable]
 *  iterable = 顶部变量表的列表字面量；body = 单个字符串/f-string 字面量。
 * 成功返回展开项列表，否则 undefined（由动态检测层兜底）。
 */
function expandListComp(expr: string, vars: Map<string, string>): string[] | undefined {
    // 外层方括号可选：调用方 parseEntryPointsInto 已剥离 [...]，analyzeDynamicExpr 风格一致
    const m = expr
        .trim()
        .match(/^\[?([\s\S]*?)\s+for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+?)\]?$/);
    if (!m) {
        return undefined;
    }
    const [, body, loopVar, iterable] = m;
    const iterVar = iterable.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!iterVar) {
        return undefined;
    }
    const listText = vars.get(iterVar[1]);
    if (listText === undefined || !listText.startsWith("[")) {
        return undefined;
    }
    const iterVals = parseStringListLiteral(listText, vars);
    const bodyStr = body.trim().match(/^(?:f|r|b|fr|rf)?(['"])([\s\S]*)\1$/);
    if (!bodyStr) {
        return undefined;
    }
    const template = bodyStr[2];
    const out: string[] = [];
    for (const v of iterVals) {
        const expanded = evalFString(template, vars, loopVar, v);
        if (expanded === undefined) {
            return undefined;
        }
        out.push(expanded);
    }
    return out;
}

/** 简单字符串哈希（djb2），用于语义指纹 */
function hashString(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

/** 计算语义指纹：静态字段值 + 动态模板 + 动态依赖值（名字无关） */
function computeFingerprint(result: SetupPyParseResult): string {
    const payload: unknown[] = [];

    // 静态标量/布尔（只取已解析值）
    const scalars: Record<string, unknown> = {};
    const scalarKeys: ReadonlyArray<keyof SetupPyParseResult> = [
        "name", "version", "author", "authorEmail", "maintainer", "maintainerEmail",
        "url", "license", "description", "longDescription", "downloadUrl",
        "licenseExpression", "longDescriptionContentType", "extPackage", "srcRoot",
        "zipSafe", "verbose", "help", "helpCommands", "includePackageData",
    ];
    for (const k of scalarKeys) {
        const v = result[k];
        if (v !== undefined) {
            scalars[k as string] = v;
        }
    }
    payload.push(["scalars", scalars]);

    // 静态列表字段（只取非空）
    const lists: Record<string, unknown[]> = {};
    const listKeys: ReadonlyArray<keyof SetupPyParseResult> = [
        "packages", "pyModules", "headers", "scripts", "dependencyLinks",
        "setupRequires", "installRequires", "testsRequire", "commandPackages",
        "licenseFiles", "keywords", "platforms", "classifiers", "requires",
        "provides", "obsoletes", "dataFiles", "consoleScripts",
    ];
    for (const k of listKeys) {
        const v = result[k] as unknown[] | undefined;
        if (v && v.length > 0) {
            lists[k as string] = v;
        }
    }
    payload.push(["lists", lists]);

    // 动态依赖（名字无关：depVars 只取值排序；模板已规范化）
    const deps: unknown[] = [];
    for (const field of Object.keys(result.dynamicDeps).sort()) {
        for (const d of result.dynamicDeps[field]) {
            deps.push([field, d.kind, d.template, Object.values(d.depVars).sort()]);
        }
    }
    payload.push(["deps", deps]);

    return hashString(JSON.stringify(payload));
}

/**
 * 解析 setup.py 文本（对照 setuptools.setup() 完整签名，包不漏）。
 * @param text setup.py 文件内容
 */
export function parseSetupPy(text: string, options?: SetupParseOptions): SetupPyParseResult {
    const result: SetupPyParseResult = {
        found: false,
        keys: [],
        dynamic: false,
        issues: [],
        keywords: [], platforms: [], classifiers: [],
        requires: [], provides: [], obsoletes: [],
        packages: [], pyModules: [], headers: [], scripts: [],
        dependencyLinks: [], setupRequires: [], installRequires: [], testsRequire: [],
        commandPackages: [], licenseFiles: [],
        dataFiles: [], packageData: [], excludePackageData: [], extrasRequire: [],
        packageDir: {}, projectUrls: {},
        entryPoints: {}, consoleScripts: [], raw: {},
        dynamicDeps: {}, fingerprint: "",
    };

    const cleaned = stripPythonComments(text);
    const vars = collectTopLevelVars(cleaned);
    const setupCall = extractSetupCall(cleaned);
    if (!setupCall) {
        // 无 setup() 调用：可能配置来自外部变量 → 标记动态
        result.dynamic =
            /\b(entry_points|data_files|install_requires|packages)\s*=/.test(text) ||
            /\bconsole_scripts\b/.test(text);
        result.fingerprint = computeFingerprint(result);
        return result;
    }
    result.found = true;

    // 按 kwargs 逐条解析（多多益善 + 逐字段独立容错）
    for (const [key, rawValue] of splitTopLevelKwargs(setupCall)) {
        result.keys.push(key);
        try {
            // 实参为标识符且对应模块级容器 → 按其字面量解析(不再因“值不是字面量”跳过)
            const value = expandLiteralRef(rawValue, vars);
            switch (key) {
                // —— 字符串 ——
                case "name": result.name = resolveExpression(value, vars) ?? result.name; break;
                case "version": result.version = resolveExpression(value, vars) ?? result.version; break;
                case "author": result.author = resolveExpression(value, vars) ?? result.author; break;
                case "author_email": result.authorEmail = resolveExpression(value, vars) ?? result.authorEmail; break;
                case "maintainer": result.maintainer = resolveExpression(value, vars) ?? result.maintainer; break;
                case "maintainer_email": result.maintainerEmail = resolveExpression(value, vars) ?? result.maintainerEmail; break;
                case "url": result.url = resolveExpression(value, vars) ?? result.url; break;
                case "license": result.license = resolveExpression(value, vars) ?? result.license; break;
                case "description": result.description = resolveExpression(value, vars) ?? result.description; break;
                case "long_description": result.longDescription = resolveExpression(value, vars) ?? result.longDescription; break;
                case "download_url": result.downloadUrl = resolveExpression(value, vars) ?? result.downloadUrl; break;
                case "license_expression": result.licenseExpression = resolveExpression(value, vars) ?? result.licenseExpression; break;
                case "long_description_content_type": result.longDescriptionContentType = resolveExpression(value, vars) ?? result.longDescriptionContentType; break;
                case "ext_package": result.extPackage = resolveExpression(value, vars) ?? result.extPackage; break;
                case "src_root": result.srcRoot = resolveExpression(value, vars) ?? result.srcRoot; break;

                // —— 布尔 ——
                case "zip_safe": result.zipSafe = parseBoolLiteral(value) ?? result.zipSafe; break;
                case "verbose": result.verbose = parseBoolLiteral(value) ?? result.verbose; break;
                case "help": result.help = parseBoolLiteral(value) ?? result.help; break;
                case "help_commands": result.helpCommands = parseBoolLiteral(value) ?? result.helpCommands; break;
                case "include_package_data": result.includePackageData = parseBoolLiteral(value) ?? result.includePackageData; break;

                // —— 字符串或字符串列表 ——
                case "keywords": result.keywords = parseStringOrStringList(value, vars); break;
                case "platforms": result.platforms = parseStringOrStringList(value, vars); break;
                case "classifiers": result.classifiers = parseStringOrStringList(value, vars); break;
                case "requires": result.requires = parseStringOrStringList(value, vars); break;
                case "provides": result.provides = parseStringOrStringList(value, vars); break;
                case "obsoletes": result.obsoletes = parseStringOrStringList(value, vars); break;
                case "command_packages": result.commandPackages = parseStringOrStringList(value, vars); break;
                case "license_files": result.licenseFiles = parseStringOrStringList(value, vars); break;

                // —— 字符串列表 ——
                case "packages": {
                    // find_packages() → TS 文件系统等价扫描（对齐 setuptools 语义）
                    // 展开成功 → 值确定，不标 dynamic
                    const expandedPackages = expandFindPackages(value, vars, options);
                    if (expandedPackages) {
                        result.packages = expandedPackages;
                    } else {
                        result.packages = parseStringListLiteral(value, vars);
                    }
                    if (hasDynamicConstruct(value) && !expandedPackages) {
                        result.dynamic = true;
                        result.dynamicDeps["packages"] = [analyzeDynamicExpr(value, vars)];
                    }
                    break;
                }
                case "py_modules": result.pyModules = parseStringListLiteral(value, vars); break;
                case "headers": result.headers = parseStringListLiteral(value, vars); break;
                case "scripts": result.scripts = parseStringListLiteral(value, vars); break;
                case "dependency_links": result.dependencyLinks = parseStringListLiteral(value, vars); break;
                case "setup_requires": result.setupRequires = parseStringListLiteral(value, vars); break;
                case "install_requires": result.installRequires = parseStringOrStringList(value, vars); break;
                case "tests_require": result.testsRequire = parseStringOrStringList(value, vars); break;

                // —— 安装数据 / 资源 ——
                case "data_files": {
                    result.dataFiles = parseDataFiles(value, vars, options);
                    // 仅存在未展开的动态条目时标记 dynamic（glob 展开成功 → 值确定）
                    if (result.dataFiles.some((d) => d.dynamic)) {
                        result.dynamic = true;
                        result.dynamicDeps["data_files"] = [analyzeDynamicExpr(value, vars)];
                    }
                    break;
                }
                case "package_data": result.packageData = parsePackageData(value); break;
                case "exclude_package_data": result.excludePackageData = parsePackageData(value); break;
                case "extras_require": result.extrasRequire = parsePackageData(value); break;
                case "package_dir": result.packageDir = parseStringDict(value, vars); break;
                case "project_urls": result.projectUrls = parseStringDict(value, vars); break;

                // —— 可执行入口 ——
                case "entry_points": parseEntryPointsInto(value, result, vars, cleaned); break;

                // —— 复杂/构建内部字段及未知字段：包不漏，保留原始表达式 ——
                default:
                    result.raw[key] = value;
                    break;
            }
        } catch (e) {
            // 逐字段容错：单个字段失败不影响整体
            result.issues.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // 汇总子级动态：dataFiles 任一条动态 → 整体 dynamic
    if (result.dataFiles.some((d) => d.dynamic)) {
        result.dynamic = true;
    }

    // 语义指纹（名字无关：静态值 + 动态模板 + 依赖值）
    result.fingerprint = computeFingerprint(result);

    return result;
}

// ============================================================================
// 变化事件出口（分离检测与解析；外部可订阅 onDidChange 接入准确解析层/缓存）
// ============================================================================

/** 语义变化事件载荷 */
export interface SetupChangeEvent {
    /** setup.py 路径 */
    path: string;
    /** 本次解析结果（静态 + 动态依赖描述） */
    result: SetupPyParseResult;
    /** 是否发生语义变化 */
    changed: boolean;
}

/**
 * 语义变化检测器：持有 path → 指纹缓存。
 * check() 解析并比对指纹，语义变化（指纹不同）时触发 onDidChange。
 * 指纹对变量名不敏感 → 变量改名不触发，避免反复调用下游（如 python ast）。
 */
export class SetupChangeDetector {
    private fingerprints = new Map<string, string>();
    private listeners = new Set<(e: SetupChangeEvent) => void>();

    /** 订阅语义变化事件，返回取消函数 */
    readonly onDidChange = (fn: (e: SetupChangeEvent) => void): (() => void) => {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    };

    /** 解析 + 指纹比对 + 语义变化时触发事件。返回本次结果与是否变化。 */
    check(path: string, text: string): { changed: boolean; result: SetupPyParseResult } {
        const result = parseSetupPy(text);
        const fp = result.fingerprint;
        const prev = this.fingerprints.get(path);
        const changed = prev !== fp;
        this.fingerprints.set(path, fp);
        if (changed) {
            for (const fn of this.listeners) {
                fn({ path, result, changed: true });
            }
        }
        return { changed, result };
    }

    /** 移除某路径缓存（文件删除时调用） */
    remove(path: string): void {
        this.fingerprints.delete(path);
    }

    /** 当前指纹（调试用） */
    fingerprintOf(path: string): string | undefined {
        return this.fingerprints.get(path);
    }

    dispose(): void {
        this.listeners.clear();
        this.fingerprints.clear();
    }
}
