// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file configure-actions.ts
 * config 写侧·01 一键配置【纯动作层】(2026-09-03,设计:设计/新功能/01 + 总纲约束⑤)。
 * 输入:文件角色 + 包上下文 + 现有构建文件文本 → 输出:计划(幂等判定 + 追加/改写内容)。
 * 零 vscode 依赖,可无头单测;确认交互与实际写回在 configure-file.ts(编排层)。
 * ⚠️ 定位说明(2026-09-03):幂等判定复用 exe-map/parse(语义提取);**位置相关改写尚未接入
 *    anchors/**——当前 append 对 package.xml 属尾追加(会落到 </package> 之后,XML 非法),
 *    需按 配置动作规格-文件角色×包类型.md §4 清单改为锚点插入(anchors/insertBeforePackageClose 等)。
 */

import { parseCMakeLists } from "../exe-map/parse/cmake-parser";
import { parseSetupPy } from "../exe-map/parse/setup-parser";
// anchors 统一经桶出口(index.ts)消费,不再直连子模块(2026-09-04 规范化)
import {
    findMatchingClose, classifyRegions, regionAt,
    findSetupCall, findKwargSpan, insertItemAtContainerTail, insertListItemCanonical,
    findConsoleScriptsList, consoleListHasItem,
    locateCmakeInsert, scanActiveCalls, findActiveCallByArgs, cmakeAppendArgToBlock,
    locateCmakeTemplateCodeAnchor, indexLines, commentRuns, commentTextOfLine, CmakeLocateKind,
    insertXmlDepElement, XmlDepKind,
} from "./anchors";

export type BuildTypeName = "ament_python" | "ament_cmake" | "cmake";

/** 文件角色(扩展名 + 包内目录启发) */
export type Role = "launch" | "msg" | "srv" | "action" | "python" | "shell" | "cpp" | "unknown";

export interface ConfigurePackage {
    name: string;
    dir: string;
    buildType?: BuildTypeName;
}

/** 包内相对路径(posix) */
export function detectRole(fileRel: string): Role {
    const lower = fileRel.toLowerCase();
    if (/\.launch\.py$/.test(lower) || /\.launch\.(xml|yaml|yml)$/.test(lower)) {
        return "launch";
    }
    if (/(^|\/)msg\//.test(lower) && lower.endsWith(".msg")) { return "msg"; }
    if (/(^|\/)srv\//.test(lower) && lower.endsWith(".srv")) { return "srv"; }
    if (/(^|\/)action\//.test(lower) && lower.endsWith(".action")) { return "action"; }
    if (lower.endsWith(".py")) { return "python"; }
    if (lower.endsWith(".sh") || lower.endsWith(".bash")) { return "shell"; }
    if (/\.(cpp|cc|cxx|hpp|h|hxx)$/.test(lower)) { return "cpp"; }
    return "unknown";
}

export interface BuildTexts {
    cmakeText: string;
    setupPyText: string;
    packageXmlText: string;
}

/**
 * 一条计划写入:
 *  - mode "append"  → content 为追加到文件末尾的片段;
 *  - mode "replace" → content 为整文件新文本(console_scripts 等需原位改写时用);
 *  - already=true   → 已配置,content 为空。
 */
export interface PlannedWrite {
    file: "CMakeLists.txt" | "package.xml" | "setup.py";
    already: boolean;
    mode: "append" | "replace";
    content: string;
    summary: string;
}

export interface ConfigurePlan {
    role: Role;
    /** 全部 writes.already(无写入需求) */
    already: boolean;
    writes: PlannedWrite[];
    note?: string;
}

export interface ConsoleScriptTarget { name: string; module: string; func: string }

// ---------- 小工具 ----------

const done = (file: PlannedWrite["file"], summary: string): PlannedWrite =>
    ({ file, already: true, mode: "append", content: "", summary: summary + "(已配置)" });

/**
 * console_scripts 增量改写(2026-09-04 起基于 anchors/python.ts 定位,替代自写括号配对/裸 indexOf):
 * 返回 [新文本, 是否插入];已存在返回原样 false。
 * 三分支:
 *   (a) entry_points 内有 console_scripts 列表 → 列表容器尾插条目(insertItemAtContainerTail,逗号语义正确);
 *   (b) 有 entry_points 但无 console_scripts 键 → 其 dict 尾插键;
 *   (c) 完全没有 entry_points → setup() 尾部补参数。
 */
/** 在 [from,to) 内找 console_scripts 键的列表括号对(供调用点 entry_points 值内部使用) */
function consoleListIn(text: string, from: number, to: number): { lb: number; rb: number } | undefined {
    let scan = from;
    while (scan < to) {
        const keyAt = text.indexOf("console_scripts", scan);
        if (keyAt < 0 || keyAt >= to) { break; }
        scan = keyAt + "console_scripts".length;
        let k = keyAt - 1;
        while (k > from && /\s/.test(text[k])) { k--; }
        if (text[k] !== "'" && text[k] !== '"') { continue; }
        let lb = text.indexOf("[", keyAt);
        while (lb >= from && lb < to) {
            const rb = findMatchingClose(text, lb, "python");
            if (!(rb > lb && rb <= to)) { break; }
            // 跳过索引括号(如 entry_points["console_scripts"] 的 [ )——真正条目列表内含 '='
            if (text.slice(lb + 1, rb).includes("=")) { return { lb, rb }; }
            lb = text.indexOf("[", rb + 1);
        }
    }
    return undefined;
}

function withConsoleScriptEntry(text: string, target: ConsoleScriptTarget, stamp: string): { text: string; inserted: boolean; already?: boolean } {
    const parsed = parseSetupPy(text);
    if (parsed.consoleScripts.some((c) => c.name === target.name)) {
        return { text, inserted: false }; // 已存在(解析层命中)
    }
    const item = "'" + target.name + " = " + target.module + ":" + target.func + "'";
    const setup = findSetupCall(text);
    if (!setup) { return { text, inserted: false }; }
    const openIdx = setup.openIndex;
    const ep = findKwargSpan(text, openIdx, "entry_points");
    if (ep) {
        // kwarg 关键字起点:在 code 区按词界找(ep.start 可能落在前导注释/缩进段),eq 只在 code 区找
        const regions = classifyRegions(text, "python");
        let kwStart = -1;
        {
            let p = ep.start;
            while (p < ep.end) {
                p = text.indexOf("entry_points", p);
                if (p < 0 || p >= ep.end) { break; }
                const pEnd = p + "entry_points".length;
                const prevOk = p === 0 || !/[A-Za-z0-9_]/.test(text[p - 1]);
                const nextOk = pEnd >= text.length || !/[A-Za-z0-9_]/.test(text[pEnd]);
                if (regionAt(regions, p) === "code" && prevOk && nextOk) { kwStart = p; break; }
                p = pEnd;
            }
        }
        let eq = -1;
        if (kwStart >= 0) {
            for (let i = kwStart + "entry_points".length; i < ep.end; i++) {
                if (regionAt(regions, i) === "code" && text[i] === "=") { eq = i; break; }
            }
        }
        if (eq >= 0 && kwStart >= 0) {
            const head = text.slice(eq + 1, ep.end).trimStart();
            if (head.startsWith("{")) {
                // 值已是字典(原始内联 或 上次生成的加法表达式)→ 在其 console_scripts 列表内规范尾插
                const list = consoleListIn(text, eq + 1, ep.end);
                if (list) {
                    if (consoleListHasItem(text, list.lb, list.rb, item)) {
                        return { text, inserted: false, already: true };
                    }
                    return { text: insertListItemCanonical(text, list.lb, list.rb, item, { stamp }), inserted: true };
                }
                // 字典内无 console_scripts 键 → dict 尾补键(plain,后续追加走规范尾插)
                const ob = text.indexOf("{", eq + 1);
                if (ob >= 0 && ob < ep.end) {
                    const cb = findMatchingClose(text, ob, "python");
                    if (cb > ob && cb <= ep.end) {
                        const value2 = "'console_scripts': [" + item + "]";
                        return { text: insertItemAtContainerTail(text, ob, cb, value2), inserted: true };
                    }
                }
                return { text, inserted: false };
            }
            // 值 = 标识符(如 entry_points=entry_points)→ 加法式补充:调用点合并表达式,变量零改动
            const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(head);
            if (m) {
                const varName = m[1];
                const lineStart = text.lastIndexOf("\n", kwStart - 1) + 1;
                const lineIndent = (/^[ \t]*/.exec(text.slice(lineStart, kwStart)) || [""])[0];
                const endMark = text[ep.end] === "," ? ep.end + 1 : ep.end;
                const lines = [
                    "entry_points={" + "\n" +
                    lineIndent + "    **" + varName + "," + "\n" +
                    lineIndent + "    \"console_scripts\": " + varName + "[\"console_scripts\"] + [" + "\n" +
                    lineIndent + "        " + item + ", " + stamp + "\n" +
                    lineIndent + "    ]," + "\n" +
                    lineIndent + "},"
                ].join("");
                const out = text.slice(0, kwStart) + lines + text.slice(endMark);
                return { text: out, inserted: true };
            }
            return { text, inserted: false }; // 复杂表达式值,不做加法(交手动)
        }
    }
    // 完全没有 entry_points kwarg → setup() 尾部补参数(plain 单行列表,后续追加走规范尾插)
    const close = setup.closeIndex;
    const prev = text.charAt(close - 1).trim();
    const needComma = prev !== "(" && prev !== ",";
    const param = (needComma ? ",\n    " : "\n    ") + "entry_points={'console_scripts': [" + item + "]}";
    return { text: text.slice(0, close) + param + text.slice(close), inserted: true };
}

// ---------- 各角色计划 ----------


// ---------- 垂直规范形态块(2026-09-04 特许:追加型媒介,头行+内容行各自 stamp,`)` 独立行) ----------

/** install 垂直块(PROGRAMS/TARGETS):一参一行,DESTINATION 区尾行,`)` 独立行 */
function verticalInstallBlock(kind: "PROGRAMS" | "TARGETS", items: string[], dest: string, now: Date): string {
    const ts = stampComment("cmake", now);
    const lines: string[] = ["install(" + kind + " " + ts];
    for (const it of items) { lines.push("  " + it + " " + ts); }
    lines.push("  DESTINATION " + dest);
    lines.push(")");
    return lines.join("\n");
}

/** rosidl 垂直块:deps 可缺省;DEPENDENCIES 为区尾行 */
function verticalRosidlBlock(files: string[], now: Date, dependencies?: string[]): string {
    const ts = stampComment("cmake", now);
    const lines: string[] = ["rosidl_generate_interfaces(${PROJECT_NAME} " + ts];
    for (const f of files) { lines.push("  " + f + " " + ts); }
    if (dependencies && dependencies.length > 0) { lines.push("  DEPENDENCIES " + dependencies.join(" ")); }
    lines.push(")");
    return lines.join("\n");
}

/** 在 at 前插入块(自动补前导换行;块自带尾换行) */
function cmakeInsertAt(text: string, at: number, block: string): string {
    const sep = at > 0 && text[at - 1] === "\n" ? "" : "\n";
    const tail = block.endsWith("\n") ? block : block + "\n";
    return text.slice(0, at) + sep + tail + text.slice(at);
}

// ---------- 整文改写助手(2026-09-04:定位 + 整文,编排层只落盘) ----------

/** 在 CMake 定位点插入片段,返回整文;定位失败(无落点)返回 undefined */
function cmakeInsertBlock(text: string, kind: CmakeLocateKind, block: string): string | undefined {
    const loc = locateCmakeInsert(text, kind);
    if (!loc) { return undefined; }
    const at = loc.insertAt;
    const sep = at > 0 && text[at - 1] === "\n" ? "" : "\n";
    return text.slice(0, at) + sep + block + text.slice(at);
}

/** package.xml 按类逐条插入(每条一次定位,保同类连续);comment = 该元素行尾的完整行内标注(如 XML 注释),可缺省 */
function xmlInsertDeps(xml: string, deps: Array<{ kind: XmlDepKind; name: string; comment?: string }>): string {
    let out = xml;
    for (const d of deps) {
        out = insertXmlDepElement(out, d.kind, d.name, undefined, d.comment);
    }
    return out;
}

// ---------- 各角色计划 ----------

function planLaunchCmake(pkg: ConfigurePackage, fileRel: string, texts: BuildTexts): PlannedWrite {
    const summary = "CMakeLists.txt 安装 launch 目录(install DIRECTORY)";
    if (!texts.cmakeText.trim()) { return { file: "CMakeLists.txt", already: false, mode: "replace", content: "", summary: summary + "——无 CMakeLists.txt" }; }
    const r = parseCMakeLists(texts.cmakeText);
    if (r.installs.some((i) => i.kind === "DIRECTORY" && i.args.includes("launch"))) {
        return done("CMakeLists.txt", summary);
    }
    // DIRECTORY 属一次性媒介:优先在 create 注释模板的「首条代码注释行」上方新建(## 说明头不参与匹配);
    // 无模板 → locateCmakeInsert 惯例位;形态与 create 一致(两行紧凑),stamp 贴首个内容行
    const block = [
        "install(DIRECTORY launch",
        "  DESTINATION share/${PROJECT_NAME})",
        "",
    ].join("\n");
    const stamped = stampSnippet("cmake", block, new Date());
    const anchor = locateCmakeTemplateCodeAnchor(texts.cmakeText, "install", "DIRECTORY launch")
        ?? locateCmakeInsert(texts.cmakeText, "install")?.insertAt;
    if (anchor === undefined) { return { file: "CMakeLists.txt", already: false, mode: "replace", content: "", summary: summary + "——无法定位插入点" }; }
    const next = cmakeInsertAt(texts.cmakeText, anchor, stamped);
    return { file: "CMakeLists.txt", already: false, mode: "replace", content: next, summary: summary + "(整文改写)" };
}


/** 从 create 注释模板提取 DEPENDENCIES 列表(结构参照 create;模板无 DEPENDENCIES 返回 undefined) */
function rosidlTemplateDependencies(cmake: string): string[] | undefined {
    const lines = indexLines(cmake);
    for (const run of commentRuns(cmake, "cmake")) {
        let inGen = false;
        for (let i = run.startLine; i <= run.endLine; i++) {
            const body = commentTextOfLine(cmake, lines[i], "cmake");
            if (body === undefined) { continue; }
            if (!inGen && body.toLowerCase().startsWith("rosidl_generate_interfaces(")) { inGen = true; continue; }
            if (inGen && body.toUpperCase().startsWith("DEPENDENCIES")) {
                const deps = body.slice("DEPENDENCIES".length).trim().split(/\s+/).filter((s) => s.length > 0);
                return deps.length > 0 ? deps : undefined;
            }
        }
    }
    return undefined;
}

function planInterface(pkg: ConfigurePackage, role: Role, fileRel: string, texts: BuildTexts): ConfigurePlan {
    const writes: PlannedWrite[] = [];
    const pkgXml = texts.packageXmlText;
    if (!texts.cmakeText.trim()) { return { role, already: false, writes: [], note: "无 CMakeLists.txt,无法配置接口依赖链" }; }
    const now = new Date();
    const stamp = stampComment("cmake", now);
    const fileArg = "\"" + fileRel + "\"";
    let cm = texts.cmakeText;
    let cmSummary = "CMakeLists.txt 接口依赖链";
    const cmHasFind = (text: string): boolean => scanActiveCalls(text).some((c) =>
        c.name.toLowerCase() === "find_package"
        && text.slice(c.openIndex, c.closeIndex).includes("rosidl_default_generators"));
    const cmHasExport = (text: string): boolean => scanActiveCalls(text).some((c) =>
        c.name.toLowerCase() === "ament_export_dependencies"
        && text.slice(c.openIndex, c.closeIndex).includes("rosidl_default_runtime"));
    const lastGen = (text: string) => scanActiveCalls(text)
        .filter((c) => c.name.toLowerCase() === "rosidl_generate_interfaces")
        .pop();

    // A) find_package(rosidl_default_generators) → 依赖区(与其它 find_package 同区),两处落点之①
    if (!cmHasFind(cm)) {
        const depAt = locateCmakeInsert(cm, "deps")?.insertAt;
        if (depAt === undefined) { return { role, already: false, writes: [], note: "CMakeLists.txt 无法定位 find_package 依赖区" }; }
        cm = cmakeInsertAt(cm, depAt, "find_package(rosidl_default_generators REQUIRED) " + stamp);
        cmSummary += " + find_package@依赖区";
    }

    // B) rosidl_generate_interfaces 块(两处落点之②;DEPENDENCIES 结构参照 create 模板;无块=新建,有块未含本文件=块内追加)
    const gen = lastGen(cm);
    if (!gen) {
        const depsList = rosidlTemplateDependencies(cm);
        const block = verticalRosidlBlock([fileArg], now, depsList)
            + "\n" + "ament_export_dependencies(rosidl_default_runtime) " + stamp;
        const anchor = locateCmakeTemplateCodeAnchor(cm, "rosidl_generate_interfaces")
            ?? locateCmakeInsert(cm, "interfaces")?.insertAt;
        if (anchor === undefined) { return { role, already: false, writes: [], note: "CMakeLists.txt 无法定位 rosidl 接口区" }; }
        cm = cmakeInsertAt(cm, anchor, block);
        cmSummary += " + rosidl 块@接口区" + (depsList ? "(DEPENDENCIES 参照模板)" : "");
    } else if (!cm.slice(gen.openIndex, gen.closeIndex).includes(fileRel)) {
        const app = cmakeAppendArgToBlock(cm, gen, fileArg, { stamp });
        if (app.reason) { return { role, already: false, writes: [], note: "rosidl 块内追加失败:" + app.reason + "(请在块内手动补 " + fileArg + ")" }; }
        cm = app.text;
        cmSummary += " + " + fileArg + "@既有块" + (app.converted ? "(垂直化)" : "");
    }

    // C) ament_export_dependencies(rosidl_default_runtime) 缺失 → 接口区(rosidl 块后)补
    if (!cmHasExport(cm)) {
        const g = lastGen(cm);
        if (!g) { return { role, already: false, writes: [], note: "无 rosidl 块可挂接 ament_export_dependencies" }; }
        const nl = cm.indexOf("\n", g.closeIndex);
        const at = nl < 0 ? cm.length : nl + 1;
        cm = cm.slice(0, at) + "ament_export_dependencies(rosidl_default_runtime) " + stamp + "\n" + cm.slice(at);
        cmSummary += " + export@接口区";
    }

    if (cm !== texts.cmakeText) {
        writes.push({ file: "CMakeLists.txt", already: false, mode: "replace", content: cm, summary: cmSummary });
    }

    // package.xml 三类,缺哪补哪:每类单独定位插入(同类聚堆),每个元素行尾各自带一个独立行内标注(有迹可循)
    const stampXml = stampComment("packageXml", now); // 完整 XML 注释,如 <!-- rde-ros-2 扩展生成 … -->
    const adds: Array<{ kind: XmlDepKind; name: string; comment?: string }> = [];
    if (!pkgXml.includes("rosidl_default_generators")) { adds.push({ kind: "buildtool_depend", name: "rosidl_default_generators", comment: stampXml }); }
    if (!pkgXml.includes("rosidl_default_runtime")) { adds.push({ kind: "exec_depend", name: "rosidl_default_runtime", comment: stampXml }); }
    if (!pkgXml.includes("rosidl_interface_packages")) { adds.push({ kind: "member_of_group", name: "rosidl_interface_packages", comment: stampXml }); }
    if (adds.length > 0 && pkgXml.includes("</package>")) {
        const xmlNext = xmlInsertDeps(pkgXml, adds);
        writes.push({ file: "package.xml", already: false, mode: "replace", content: xmlNext, summary: "package.xml 接口依赖(member_of_group/rosidl,元素各自带行内标注)" });
    } else if (adds.length === 0) {
        writes.push(done("package.xml", "package.xml 接口依赖"));
    }

    return { role, already: writes.length > 0 && writes.every((w) => w.already), writes };
}

function planExecutableCmake(pkg: ConfigurePackage, role: Role, fileRel: string, texts: BuildTexts): PlannedWrite {
    const summary = "CMakeLists.txt 安装可执行(install PROGRAMS)";
    if (!texts.cmakeText.trim()) { return { file: "CMakeLists.txt", already: false, mode: "replace", content: "", summary: summary + "——无 CMakeLists.txt" }; }
    const r = parseCMakeLists(texts.cmakeText);
    if (r.installs.some((i) => i.kind === "PROGRAMS" && i.args.includes(fileRel))) {
        return done("CMakeLists.txt", summary);
    }
    const now = new Date();
    // 1) 活跃 PROGRAMS 块 → 并块追加(紧凑块先垂直化,旧行标注保留,新行带 stamp);幂等块内含时直接 done
    const active = findActiveCallByArgs(texts.cmakeText, "install", "PROGRAMS");
    if (active) {
        const app = cmakeAppendArgToBlock(texts.cmakeText, active, fileRel, { stamp: stampComment("cmake", now) });
        if (app.already) { return done("CMakeLists.txt", summary); }
        if (!app.reason) {
            return { file: "CMakeLists.txt", already: false, mode: "replace", content: app.text, summary: summary + "(并块" + (app.converted ? "·垂直化" : "") + ")" };
        }
    }
    // 2) 无活跃块:模板代码锚上方新建垂直块;无模板 → 惯例位
    const block = verticalInstallBlock("PROGRAMS", [fileRel], "lib/${PROJECT_NAME}", now);
    const anchor = locateCmakeTemplateCodeAnchor(texts.cmakeText, "install", "PROGRAMS")
        ?? locateCmakeInsert(texts.cmakeText, "install")?.insertAt;
    if (anchor === undefined) { return { file: "CMakeLists.txt", already: false, mode: "replace", content: "", summary: summary + "——无法定位插入点" }; }
    const next = cmakeInsertAt(texts.cmakeText, anchor, block);
    return { file: "CMakeLists.txt", already: false, mode: "replace", content: next, summary: summary + "(新建垂直块)" };
}

function planConsoleScript(pkg: ConfigurePackage, fileRel: string, texts: BuildTexts, target: ConsoleScriptTarget): PlannedWrite {
    const summary = "setup.py console_scripts 增加 " + target.name;
    if (!texts.setupPyText.trim()) { return { file: "setup.py", already: false, mode: "replace", content: "", summary: summary + "——无 setup.py" }; }
    const res = withConsoleScriptEntry(texts.setupPyText, target, stampComment("setup", new Date()));
    if (!res.inserted) {
        if (res.already) { return done("setup.py", summary); }
        const parsed = parseSetupPy(texts.setupPyText);
        if (parsed.consoleScripts.some((c) => c.name === target.name)) {
            return done("setup.py", summary);
        }
        return { file: "setup.py", already: false, mode: "replace", content: "", summary: summary + "——无法定位(无 setup()/entry_points 结构),需手动" };
    }
    return { file: "setup.py", already: false, mode: "replace", content: res.text, summary: summary + "(整文改写)" };
}

function planCpp(pkg: ConfigurePackage, fileRel: string, texts: BuildTexts): ConfigurePlan {
    if (!texts.cmakeText.trim()) { return { role: "cpp", already: false, writes: [], note: "无 CMakeLists.txt,无法配置" }; }
    const base = (fileRel.split("/").pop() ?? fileRel).replace(/\.(cpp|cc|cxx)$/, "");
    const target = base.replace(/[^a-zA-Z0-9_]/g, "_");
    const r = parseCMakeLists(texts.cmakeText);
    if (r.executables.some((e) => e.name === target)) {
        return { role: "cpp", already: true, writes: [done("CMakeLists.txt", "add_executable(" + target + ")")] };
    }
    const now = new Date();
    // 1) add_executable 骨架(build 段,定位/幂等走 parse + locateCmakeInsert)
    const block = [
        "add_executable(" + target + " " + fileRel + ")",
        "# ament_target_dependencies(" + target + " rclcpp)",
        "",
    ].join("\n");
    const execNext = cmakeInsertBlock(texts.cmakeText, "build", stampSnippet("cmake", block, now));
    if (execNext === undefined) { return { role: "cpp", already: false, writes: [], note: "CMakeLists.txt 无法定位 build 插入点" }; }
    // 2) Q2 定稿:目标并入 install(TARGETS) 闭环 ros2 run;活跃块并块 / 模板新建 / 惯例兜底
    const tActive = findActiveCallByArgs(execNext, "install", "TARGETS");
    let cmakeNext: string | undefined;
    let tSummary = "";
    if (tActive) {
        const app = cmakeAppendArgToBlock(execNext, tActive, target, { stamp: stampComment("cmake", now) });
        if (!app.reason) {
            cmakeNext = app.text;
            tSummary = "install(TARGETS)并块" + (app.converted ? "·垂直化" : "");
        }
    }
    if (cmakeNext === undefined) {
        const vBlock = verticalInstallBlock("TARGETS", [target], "lib/${PROJECT_NAME}", now);
        const anchor = locateCmakeTemplateCodeAnchor(execNext, "install", "TARGETS")
            ?? locateCmakeInsert(execNext, "install")?.insertAt;
        if (anchor === undefined) { return { role: "cpp", already: false, writes: [], note: "CMakeLists.txt 无法定位 TARGETS 安装插入点" }; }
        cmakeNext = cmakeInsertAt(execNext, anchor, vBlock);
        tSummary = "install(TARGETS)新建垂直块";
    }
    return {
        role: "cpp",
        already: false,
        writes: [{ file: "CMakeLists.txt", already: false, mode: "replace", content: cmakeNext, summary: "add_executable(" + target + ") 骨架 + " + tSummary }],
    };
}

export function planConfigure(
    pkg: ConfigurePackage,
    fileRel: string,
    texts: BuildTexts,
    consoleScript?: ConsoleScriptTarget,
): ConfigurePlan {
    const role = detectRole(fileRel);
    const unsupported = (note: string): ConfigurePlan => ({ role, already: false, writes: [], note });
    if (role === "unknown") { return unsupported("不支持的文件类型:" + fileRel); }
    const bt = pkg.buildType;
    if (!bt) { return unsupported("未能确定包构建类型(包可能不在参与构建名单),无法生成片段"); }
    const wrap = (writes: PlannedWrite[]): ConfigurePlan => ({ role, already: writes.length > 0 && writes.every((w) => w.already), writes });
    switch (role) {
        case "launch":
            if (bt === "ament_cmake" || bt === "cmake") {
                return wrap([planLaunchCmake(pkg, fileRel, texts)]);
            }
            return unsupported("ament_python 包:launch 安装(data_files)需按现有 setup.py 结构改写,v1 请手动");
        case "msg":
        case "srv":
        case "action":
            if (bt === "ament_cmake" || bt === "cmake") { return planInterface(pkg, role, fileRel, texts); }
            return unsupported("接口文件一般属 ament_cmake 包,当前构建类型=" + bt);
        case "python":
            if (bt === "ament_cmake" || bt === "cmake") {
                return wrap([planExecutableCmake(pkg, role, fileRel, texts)]);
            }
            if (!consoleScript) { return unsupported("ament_python 的 python 可执行需 console_scripts 目标(编排层询问)"); }
            return wrap([planConsoleScript(pkg, fileRel, texts, consoleScript)]);
        case "shell":
            return wrap([planExecutableCmake(pkg, role, fileRel, texts)]);
        case "cpp":
            if (bt === "ament_cmake" || bt === "cmake") { return planCpp(pkg, fileRel, texts); }
            return unsupported("C++ 文件一般属 ament_cmake 包,当前构建类型=" + bt);
        default:
            return unsupported("不支持的文件类型:" + fileRel);
    }
}


// ---------- 扩展生成标志(2026-09-04 定调) ----------

/** 行尾标志的标志键(2026-10-04 i18n 期0 收口,同日 D3 裁定英文化):生成本体与幂等叠加判定必须引用同一常量;
 * 写入用户文件的戳记走语言中立英文(不 l10n,文件内容随仓库/平台共享),未发布前翻转无历史包袱 */
const STAMP_TAIL_MARK = "# [rde-ros-2 generated]";

export type StampFile = "cmake" | "setup" | "packageXml";

/** 生成时间戳文本(YYYY-MM-DD HH:mm,精确到分) */
export function stampTimestamp(now: Date): string {
    const p = (n: number): string => String(n).padStart(2, "0");
    return now.getFullYear() + "-" + p(now.getMonth() + 1) + "-" + p(now.getDate())
        + " " + p(now.getHours()) + ":" + p(now.getMinutes());
}

/**
 * 生成标志注释文本:
 *   cmake/setup   → 行尾注释(供拼到片段内容行尾)
 *   packageXml    → 独立 XML 注释行(供追加到片段之后)
 */
export function stampComment(file: StampFile, now: Date): string {
    const ts = stampTimestamp(now);
    return file === "packageXml"
        ? "<!-- rde-ros-2 generated " + ts + " -->"
        : STAMP_TAIL_MARK + " " + ts;
}

/** 首个「非空且非注释起始」行号(无则 -1):标志贴命令内容行,不贴横幅/说明注释行 */
function firstContentLine(text: string): number {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.length > 0 && !t.startsWith("#")) { return i; }
    }
    return -1;
}

/**
 * 给将要写入的新增片段打上生成标志(纯函数):
 *   cmake/setup   → 首个非空内容行行尾追加行尾注释(多行按第一行算);
 *   packageXml    → 片段末尾追加独立 XML 注释行。
 * 片段为空/全空白时原样返回(无可标志内容)。
 * 说明:标志**仅人读/排障**,幂等判定、重复排除、归属识别一律不依赖它
 * (走 exe-map/parse/结构)——扩展解析 CMakeLists/setup.py 时按注释规则天然跳过。
 */
export function stampSnippet(file: StampFile, snippet: string, now: Date): string {
    const comment = stampComment(file, now);
    if (!snippet || snippet.trim().length === 0) { return snippet; }
    if (file === "packageXml") {
        const sep = snippet.endsWith("\n") ? "" : "\n";
        return snippet + sep + comment + "\n";
    }
    const idx = firstContentLine(snippet);
    if (idx < 0) { return snippet; }
    const lines = snippet.split("\n");
    // 该行已带扩展生成标注(历史遗留/重复触发)时不再叠加,保持标注幂等
    if (!lines[idx].includes(STAMP_TAIL_MARK)) {
        lines[idx] = lines[idx] + (lines[idx].endsWith(" ") ? "" : " ") + comment;
    }
    return lines.join("\n");
}