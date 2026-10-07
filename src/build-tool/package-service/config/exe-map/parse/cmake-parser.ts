/**
 * CMakeLists.txt 聚焦提取器（独立模块，2026-08-22）
 *
 * 不做完整 CMake 解析器（不执行语义 / 不求值控制流），只做**聚焦提取**：
 * 从 ament_cmake 包的 CMakeLists.txt 中提取可执行目标与相关配置，
 * **尽量解析所有常见命令**（多多益善）。
 *
 * 设计（用户 2026-08-22）：
 *  - **避免错误的正则匹配**：命令级**扫描器**（括号配对 + CMake 参数分词），
 *    注释/字符串/跨行由扫描器处理，不靠脆弱正则；
 *  - **输入文本 → 输出结构**：纯函数 `parseCMakeLists(text)`，无状态、无变化检测/事件出口；
 *  - **静态可解析**：`project()` / `set()` 变量表 + `$ {VAR}` 展开；
 *  - **动态标记**：函数/宏/foreach/if 块内、或变量无法展开 → 标 `dynamic`，不解析值；
 *  - 纯 TS，无 vscode / child_process 依赖，可无头测试。
 */

/** 一条 CMake 命令 */
export interface CMakeCommand {
    /** 命令名（小写） */
    name: string;
    /** 括号内原始参数文本 */
    rawArgs: string;
    /** 分词后的参数（去引号，未展开变量） */
    args: string[];
    /** 起始行号（1 基，近似） */
    line: number;
}

/** 一个 add_executable 目标 */
export interface CMakeExecutable {
    /** 目标名（字面量或经变量表展开） */
    name: string;
    /** 源文件（字面量，已排除生成器表达式/选项） */
    sources: string[];
    /** ament_target_dependencies 关联的依赖 */
    deps: string[];
    /** 目标名含未解析动态（变量无法展开） */
    dynamic: boolean;
    /** 所在块（function/foreach/if/while...），顶层时为 undefined */
    block?: string;
    /** 起始行号 */
    line: number;
}

/** install(...) 的一条记录 */
export interface CMakeInstall {
    /** 安装关键字：TARGETS / DIRECTORY / PROGRAMS / FILES / 其它 */
    kind: string;
    /** 该关键字下的参数 */
    args: string[];
    line: number;
}

/** CMakeLists.txt 解析结果（多多益善；逐命令独立容错） */
export interface CMakeListsParseResult {
    /** 是否解析到命令 */
    found: boolean;
    /** project(<name>) 项目名（变量展开后） */
    projectName?: string;
    /** cmake_minimum_required(VERSION x) */
    cmakeMinVersion?: string;
    /** 可执行目标（add_executable） */
    executables: CMakeExecutable[];
    /** 库目标（add_library） */
    libraries: string[];
    /** install(...) 记录 */
    installs: CMakeInstall[];
    /** ament_export_executables(...) */
    exportExecutables: string[];
    /** ament_export_dependencies(...) */
    exportDependencies: string[];
    /** find_package(...) 依赖 */
    dependencies: string[];
    /** set(...) 变量表（名 → 值列表） */
    variables: Record<string, string[]>;
    /** 全部命令（多多益善，供调用方深挖） */
    commands: CMakeCommand[];
    /** 是否含动态构造（块内目标 / 未解析变量） */
    dynamic: boolean;
    /** 逐命令解析失败记录（容错：不阻断整体） */
    issues: string[];
}

/** 从 openIndex 的 '(' 开始找配对的 ')'（跳过引号与 $ { } 引用） */
function findMatchingParen(text: string, openIndex: number): number {
    let depth = 0;
    let quote: string | undefined;
    for (let i = openIndex; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === "\\") {
                i++;
            } else if (c === quote) {
                quote = undefined;
            }
            continue;
        }
        if (c === '"') {
            quote = c;
            continue;
        }
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

/** 剥离 CMake 注释：# 行注释 与 #[==[ ... ]==] 括号注释（引号外） */
function stripCMakeComments(text: string): string {
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
        if (c === '"') {
            quote = c;
            out += c;
            continue;
        }
        if (c === "#") {
            // #[==[ bracket 注释 ]==]
            if (text[i + 1] === "[") {
                let j = i + 2;
                while (j < text.length && text[j] === "=") {
                    j++;
                }
                if (text[j] === "[") {
                    const equals = j - i - 2; // '=' 数量
                    const closeTok = "]" + "=".repeat(equals) + "]";
                    const closeAt = text.indexOf(closeTok, j);
                    if (closeAt >= 0) {
                        i = closeAt + closeTok.length - 1;
                        out += "\n";
                        continue;
                    }
                }
            }
            // 行注释：# 到行尾
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

/** CMake 参数分词：空格分隔，引号内空白合并，括号并入当前参数 */
function tokenizeArgs(raw: string): string[] {
    const args: string[] = [];
    let cur = "";
    let i = 0;
    const n = raw.length;
    const flush = (): void => {
        if (cur) {
            args.push(cur);
            cur = "";
        }
    };
    while (i < n) {
        const c = raw[i];
        if (c === '"') {
            i++;
            while (i < n && raw[i] !== '"') {
                if (raw[i] === "\\" && i + 1 < n) {
                    cur += raw[i + 1];
                    i += 2;
                    continue;
                }
                cur += raw[i];
                i++;
            }
            i++; // 跳过闭合引号
            continue;
        }
        if (/\s/.test(c)) {
            flush();
            i++;
            continue;
        }
        cur += c;
        i++;
    }
    flush();
    return args;
}

/** 命令扫描器：识别 identifier(args) 并括号配对（注释已剥离） */
function tokenizeCommands(text: string): CMakeCommand[] {
    const cmds: CMakeCommand[] = [];
    let i = 0;
    const n = text.length;
    let line = 1;
    while (i < n) {
        const c = text[i];
        if (c === "\n") {
            line++;
            i++;
            continue;
        }
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        // 读标识符
        if (/[A-Za-z_]/.test(c)) {
            let j = i;
            while (j < n && /[A-Za-z0-9_]/.test(text[j])) {
                j++;
            }
            const name = text.slice(i, j);
            // 跳过空白找 '('
            let k = j;
            while (k < n && /\s/.test(text[k])) {
                k++;
            }
            if (text[k] === "(") {
                const close = findMatchingParen(text, k);
                if (close >= 0) {
                    const rawArgs = text.slice(k + 1, close);
                    cmds.push({
                        name: name.toLowerCase(),
                        rawArgs,
                        args: tokenizeArgs(rawArgs),
                        line,
                    });
                    i = close + 1;
                    continue;
                }
            }
            i = j;
            continue;
        }
        i++;
    }
    return cmds;
}

/**
 * 变量展开：`$ {VAR}` 用变量表替换。
 * 返回 { value, dynamic }：全部可展开 → value；有未解析变量 → dynamic=true。
 */
function expandVar(expr: string, vars: Record<string, string[]>): { value?: string; dynamic: boolean } {
    if (!expr.includes("${")) {
        return { value: expr, dynamic: false };
    }
    const re = /\$\{([^}]*)\}/g;
    let out = "";
    let last = 0;
    let unresolved = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expr)) !== null) {
        out += expr.slice(last, m.index);
        const varName = m[1].trim();
        const v = vars[varName];
        if (v !== undefined && v.length > 0) {
            out += v.join(";"); // CMake 列表以 ; 连接
        } else {
            unresolved = true;
            out += m[0];
        }
        last = m.index + m[0].length;
    }
    out += expr.slice(last);
    if (unresolved || /\$\{/.test(out)) {
        return { value: undefined, dynamic: true };
    }
    return { value: out, dynamic: false };
}

/**
 * install(...) 解析：按顶层关键字分组(2026-09-04 加固)。
 *  - 组起始 TARGETS/DIRECTORY/PROGRAMS/FILES/EXPORT/DESTINATION/*_DESTINATION——其后文件/目标参数保持干净;
 *  - install(TARGETS …) 的组件段关键字 RUNTIME/LIBRARY/ARCHIVE/OBJECTS/FRAMEWORK/BUNDLE/PRIVATE_HEADER/
 *    PUBLIC_HEADER/RESOURCE(不再把 RUNTIME 误当 TARGETS 参数,如 `… RUNTIME DESTINATION … ARCHIVE DESTINATION …`);
 *  - DIRECTORY/FILES 选项关键字 FILES_MATCHING/PATTERN/REGEX/EXCLUDE/PERMISSIONS/COMPONENT/OPTIONAL/
 *    CONFIGURATIONS/TYPE/NAMELINK_COMPONENT(不再把 `FILES_MATCHING *.yaml` 混进 DESTINATION 参数);
 *  - 段/选项关键字仅在已出现组起始(TARGETS… 等)后生效,避免误伤首个参数。
 */
function parseInstall(cmd: CMakeCommand): CMakeInstall[] {
    const out: CMakeInstall[] = [];
    const args = cmd.args;
    let curKind: string | undefined;
    let curArgs: string[] = [];
    const flush = (): void => {
        if (curKind !== undefined) {
            if (curArgs.length > 0) {
                out.push({ kind: curKind, args: curArgs, line: cmd.line });
            }
            curKind = undefined;
            curArgs = [];
        }
    };
    const starters = new Set(["TARGETS", "DIRECTORY", "PROGRAMS", "FILES", "EXPORT",
        "DESTINATION", "RUNTIME_DESTINATION", "LIBRARY_DESTINATION", "ARCHIVE_DESTINATION"]);
    const sections = new Set(["RUNTIME", "LIBRARY", "ARCHIVE", "OBJECTS", "FRAMEWORK", "BUNDLE",
        "PRIVATE_HEADER", "PUBLIC_HEADER", "RESOURCE"]);
    const options = new Set(["FILES_MATCHING", "PATTERN", "REGEX", "EXCLUDE", "PERMISSIONS",
        "COMPONENT", "OPTIONAL", "CONFIGURATIONS", "TYPE", "NAMELINK_COMPONENT"]);
    let pendingKind: string | undefined;
    for (const a of args) {
        const upper = a.toUpperCase();
        if (starters.has(upper)) {
            flush();
            pendingKind = upper;
            curKind = upper;
            curArgs = [];
            continue;
        }
        if (pendingKind !== undefined && (sections.has(upper) || options.has(upper))) {
            flush();
            pendingKind = upper;
            curKind = upper;
            curArgs = [];
            continue;
        }
        if (pendingKind !== undefined) {
            curArgs.push(a);
        }
    }
    flush();
    return out;
}

/**
 * 解析 CMakeLists.txt 文本。
 * @param text CMakeLists.txt 文件内容
 */
export function parseCMakeLists(text: string): CMakeListsParseResult {
    const result: CMakeListsParseResult = {
        found: false,
        executables: [],
        libraries: [],
        installs: [],
        exportExecutables: [],
        exportDependencies: [],
        dependencies: [],
        variables: {},
        commands: [],
        dynamic: false,
        issues: [],
    };

    const cleaned = stripCMakeComments(text);
    const commands = tokenizeCommands(cleaned);
    result.commands = commands;
    result.found = commands.length > 0;

    // 控制流块栈（function/foreach/if/while/macro）
    const blockStack: string[] = [];
    const openBlocks = new Set(["if", "foreach", "function", "macro", "while"]);
    const closeBlocks = new Set(["endif", "endforeach", "endfunction", "endmacro", "endwhile"]);

    for (const cmd of commands) {
        try {
            const name = cmd.name;
            const args = cmd.args;

            // —— 控制流 ——
            if (openBlocks.has(name)) {
                blockStack.push(`${name}(${args[0] ?? ""})`);
                continue;
            }
            if (closeBlocks.has(name)) {
                blockStack.pop();
                continue;
            }

            switch (name) {
                case "project":
                    if (args.length >= 1) {
                        const p = expandVar(args[0], result.variables);
                        if (p.value) {
                            result.projectName = p.value;
                            result.variables["PROJECT_NAME"] = [p.value];
                        }
                    }
                    break;

                case "cmake_minimum_required": {
                    const vi = args.findIndex((a) => a.toUpperCase() === "VERSION");
                    if (vi >= 0 && args[vi + 1]) {
                        result.cmakeMinVersion = args[vi + 1];
                    }
                    break;
                }

                case "set": {
                    if (args.length >= 1) {
                        const vname = args[0];
                        // 跳过 CACHE / PARENT_SCOPE（作用域修饰，非直接赋值）
                        if (!args.some((a) => a.toUpperCase() === "CACHE" || a.toUpperCase() === "PARENT_SCOPE")) {
                            result.variables[vname] = args.slice(1).length > 0 ? args.slice(1) : [""];
                        }
                    }
                    break;
                }

                case "find_package": {
                    if (args.length >= 1) {
                        const p = expandVar(args[0], result.variables);
                        if (p.value) {
                            result.dependencies.push(p.value);
                        } else {
                            result.dynamic = true;
                        }
                    }
                    break;
                }

                case "add_executable": {
                    if (args.length >= 1) {
                        const info = expandVar(args[0], result.variables);
                        const exec: CMakeExecutable = {
                            name: info.value ?? args[0],
                            sources: args
                                .slice(1)
                                .filter((s) => !s.startsWith("$<") && s.toUpperCase() !== "EXCLUDE_FROM_ALL"),
                            deps: [],
                            dynamic: info.dynamic,
                            block: blockStack.length > 0 ? blockStack[blockStack.length - 1] : undefined,
                            line: cmd.line,
                        };
                        if (info.dynamic) {
                            result.dynamic = true;
                        }
                        result.executables.push(exec);
                    }
                    break;
                }

                case "add_library": {
                    if (args.length >= 1) {
                        const info = expandVar(args[0], result.variables);
                        if (info.value) {
                            result.libraries.push(info.value);
                        } else {
                            result.dynamic = true;
                        }
                    }
                    break;
                }

                case "ament_target_dependencies": {
                    if (args.length >= 2) {
                        const info = expandVar(args[0], result.variables);
                        const target = info.value ?? args[0];
                        const exec = result.executables.find((e) => e.name === target);
                        if (exec) {
                            exec.deps = args.slice(1);
                        }
                    }
                    break;
                }

                case "install": {
                    result.installs.push(...parseInstall(cmd));
                    break;
                }

                case "ament_export_executables":
                case "ament_export_targets": {
                    result.exportExecutables.push(...args);
                    break;
                }

                case "ament_export_dependencies": {
                    result.exportDependencies.push(...args);
                    break;
                }

                default:
                    // 其它命令（target_include_directories / target_link_libraries / add_definitions / set_property ...）
                    // 多多益善：命令已收集在 commands，这里不做深解析
                    break;
            }
        } catch (e) {
            // 逐命令容错：单个命令失败不影响整体
            result.issues.push(`${cmd.name}:${cmd.line} ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return result;
}
