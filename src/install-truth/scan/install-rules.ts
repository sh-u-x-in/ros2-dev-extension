/**
 * @file scan/install-rules.ts
 * 安装规则抽取:cmake_install.cmake / ament_cmake_symlink_install.cmake 里的
 * `install(FILES|DIRECTORY|PROGRAMS …)` 与 `ament_cmake_symlink_install_{files,directory,programs}(…)` 调用行。
 *
 * 用途(裁切后只服务一件事):**脚本类可执行 → 源码**。
 *   install(PROGRAMS scripts/run.py DESTINATION lib/<pkg>) 这类入口:
 *   build 侧规则里同时有**源路径**与**安装落点** → 一条规则就是一条跳转,
 *   与构建类型/安装形态无关(实体态是 file(INSTALL …)/install(PROGRAMS …),
 *   symlink 态是 ament_cmake_symlink_install_programs(…),两种写法都认)。
 *
 * ⚠️ 真跑反例(2026-09-14):`ament_cmake_symlink_install_programs` 与 `install(PROGRAMS …)`
 * 曾是漏项 → ament_cmake_python 的脚本整类丢失(实测 roa2_ws 的 fff/rrr.py、
 * p10_mix_deps_std/py_listener.py);且 ament 形态的源常为**根相对路径**
 * (如 "fff/rrr.py"),需按首参根绝对化。
 *
 * 规格来源:`discover/buildonly/scan.py::install_rules`(本文件在其基础上修掉上述漏项)。
 * 纯 TS,零依赖,可无头测试。
 */

import { FsLike } from "../shared/fs/primitives";
import { BuildPackage, InstallRule } from "../shared/models";
import { pbasename, pjoin, pnormalize } from "../shared/paths";

/** CMake 安装调用里的关键字(其余裸词/引号串都是值) */
const KEYWORDS = new Set([
    "FILES",
    "DIRECTORY",
    "PROGRAMS",
    "DESTINATION",
    "RENAME",
    "PATTERN",
    "PATTERN_EXCLUDE",
    "OPTIONAL",
    "TYPE",
    "FILE",
    "PROGRAM",
]);

/** 规则来源文件(两者取其一或都取) */
const RULE_FILES = ["cmake_install.cmake", "ament_cmake_symlink_install/ament_cmake_symlink_install.cmake"];

/** 单行 token 化:引号串为值,裸词为关键字候选 */
function tokenize(line: string): string[] {
    const re = /"([^"]*)"|([A-Za-z_][A-Za-z0-9_/.\-]*)/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
        out.push(m[1] !== undefined ? m[1] : m[2]);
    }
    return out;
}

/** 判定该行是不是安装规则,并识别初始 kind */
function detectKind(line: string): "FILES" | "DIRECTORY" | undefined {
    const head = line.trimStart();
    if (
        head.startsWith("ament_cmake_symlink_install_files") ||
        head.startsWith("ament_cmake_symlink_install_programs")
    ) {
        return "FILES";
    }
    if (head.startsWith("ament_cmake_symlink_install_directory")) {
        return "DIRECTORY";
    }
    const m = /install\(\s*(FILES|DIRECTORY|PROGRAMS)\b/.exec(head);
    if (m) {
        return m[1] === "DIRECTORY" ? "DIRECTORY" : "FILES";
    }
    if (head.indexOf("file(INSTALL") >= 0) {
        const mt = /\bTYPE\s+(FILE|DIRECTORY|PROGRAM)\b/.exec(head);
        return mt && mt[1] === "DIRECTORY" ? "DIRECTORY" : "FILES";
    }
    return undefined;
}

/** 解析单行规则 → {kind, sources, dest}(解析不出返回 undefined) */
export function parseInstallLine(line: string, from: string): InstallRule | undefined {
    let kind = detectKind(line);
    if (kind === undefined) {
        return undefined;
    }
    let collecting = false;
    let wantDest = false;
    let wantType = false;
    const sources: string[] = [];
    let dest: string | undefined;
    /** ament_cmake_symlink_install_* 的**首参根**:其后源常写相对路径(实测 fff/rrr.py),需据此绝对化 */
    let root: string | undefined;
    /** 仅 ament 形态的首参是"根"(install()/file() 形态的源本身即绝对路径) */
    const amentForm = /^\s*ament_cmake_symlink_install_(files|programs|directory)\b/.test(line);
    for (const text of tokenize(line)) {
        if (KEYWORDS.has(text)) {
            if (text === "FILES" || text === "DIRECTORY" || text === "PROGRAMS") {
                collecting = true;
                wantDest = false;
                wantType = false;
            } else if (text === "DESTINATION") {
                collecting = false;
                wantDest = true;
                wantType = false;
            } else if (text === "TYPE") {
                collecting = false;
                wantDest = false;
                wantType = true;
            } else {
                collecting = false;
                wantDest = false;
                wantType = false;
            }
            continue;
        }
        if (collecting) {
            sources.push(text.startsWith("/") || root === undefined ? text : pjoin(root, text));
        } else if (wantDest && dest === undefined) {
            dest = text;
        } else if (wantType) {
            if (text === "FILE" || text === "PROGRAM") {
                kind = "FILES";
            } else if (text === "DIRECTORY") {
                kind = "DIRECTORY";
            }
            wantType = false;
        } else if (root === undefined && amentForm && text.startsWith("/")) {
            root = text;
        }
    }
    if (dest === undefined || sources.length === 0) {
        return undefined;
    }
    // 规范化落点:实体态写作 "${CMAKE_INSTALL_PREFIX}/lib/<pkg>"(真跑反例),
    // 剥离变量与先导斜杠 → 与软链态的 "lib/<pkg>" 同形(统一为"相对安装前缀"),供下游判定。
    const normalizedDest = pnormalize(dest.replace(/\$\{CMAKE_INSTALL_PREFIX\}/g, "").replace(/\/{2,}/g, "/"))
        .replace(/^\/+/, "");
    return { kind, sources, dest: normalizedDest, from };
}

/** 抽取一个包的全部安装规则(上限 200 条,与 Python 原型一致) */
export async function collectInstallRules(fs: FsLike, pkg: BuildPackage): Promise<InstallRule[]> {
    const out: InstallRule[] = [];
    for (const rel of RULE_FILES) {
        const p = pjoin(pkg.buildDir, rel);
        const text = await fs.readText(p);
        if (text === undefined) {
            continue;
        }
        const from = pbasename(p);
        for (const line of text.split(/\r?\n/).slice(0, 4000)) {
            const trimmed = line.trimStart();
            // ⚠️ 真跑反例(四象限不变式抓出):CMake 会把原语义写成**注释行**
            //    `# install(PROGRAMS "fff/rrr.py" "DESTINATION" "lib/fff")`,
            //    紧跟其后的才是真实调用(ament 变体)。注释行的源是相对路径,
            //    若当成规则解析会覆盖真规则(同名先入),导致两态 srcPath 形式不一致。
            if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
                continue;
            }
            const rule = parseInstallLine(line, from);
            if (rule !== undefined) {
                out.push(rule);
                if (out.length >= 200) {
                    return out;
                }
            }
        }
    }
    return out;
}

/**
 * 从规则里挑出"脚本类可执行":FILES/PROGRAMS 规则且落点在 lib/<pkg> 或 bin/ 下。
 * 返回 {name, source}(name = 源文件 basename,即安装后的命令名;RENAME 情形少见,按源名)。
 */
export function scriptExecutablesFromRules(
    pkgName: string,
    rules: InstallRule[]
): Array<{ name: string; source: string; dest: string; from: string }> {
    const out: Array<{ name: string; source: string; dest: string; from: string }> = [];
    for (const rule of rules) {
        if (rule.kind !== "FILES") {
            continue;
        }
        const dest = pnormalize(rule.dest.replace(/\$\{CMAKE_INSTALL_PREFIX\}/g, "").replace(/\\/g, "/"))
            .replace(/^\/+/, "")
            .replace(/^\.\//, "");
        const inLib = dest === `lib/${pkgName}` || dest.startsWith(`lib/${pkgName}/`);
        const inBin = dest === "bin" || dest.startsWith("bin/");
        if (!inLib && !inBin) {
            continue;
        }
        for (const src of rule.sources) {
            if (src === "") {
                continue;
            }
            out.push({ name: pbasename(src), source: src, dest, from: rule.from });
        }
    }
    return out;
}
