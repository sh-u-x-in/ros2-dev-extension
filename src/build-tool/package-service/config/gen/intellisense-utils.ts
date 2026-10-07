// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file intellisense-utils.ts
 * 配置生成【工具层】(纯函数,零 vscode 依赖,可无头测试)。
 * 路径转换 / 环境变量提取(前缀→include、PYTHONPATH 拆分)/ .clangd 子包层展开 / 包 include 判定与复核。
 * 从原 intellisense-config.ts 分裂(2026-09-02):渲染器与编排各司其职,本层只做无副作用计算。
 */

import * as path from "path";
import { promises as fsPromises } from "fs";

/** 绝对 include 路径 → c_cpp_properties.json includePath 条目(与旧实现口径一致,R-A1) */
export function toCppIncludeEntry(absInclude: string, workspaceRoot: string): string {
    const relative = path.relative(workspaceRoot, absInclude);
    if (relative && !relative.startsWith("..")) {
        const posix = relative.split(path.sep).join(path.posix.sep);
        return path.posix.join("${workspaceFolder}", posix, "**");
    }
    return path.join(absInclude, "**");
}

/** 条目路径归一:${workspaceFolder} 展开 + 分隔符/尾斜杠统一(仅用于归属判定) */
function normalizeEntryPath(entryOrDir: string, workspaceRoot: string): string {
    const p = entryOrDir.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
    return path.normalize(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 条目是否落在本工作区之下 */
export function isUnderWorkspace(entryOrDir: string, workspaceRoot: string): boolean {
    if (!workspaceRoot || !entryOrDir) {
        return false;
    }
    const ws = path.normalize(workspaceRoot).replace(/\\/g, "/").replace(/\/+$/, "");
    const p = normalizeEntryPath(entryOrDir, workspaceRoot);
    return p === ws || p.startsWith(ws + "/");
}

/**
 * 条目是否由【构建产物】派生(<ws>/install 或 <ws>/build 之下)。
 * 用途:这批条目随安装布局(isolated↔merged)与构建形态整体更换——
 * **不在新集合里就删除**,而不是当"管辖外条目"留在队尾(2026-09-15 用户裁定)。
 */
export function isBuildArtifactEntry(entryOrDir: string, workspaceRoot: string): boolean {
    if (!workspaceRoot || !entryOrDir) {
        return false;
    }
    const ws = path.normalize(workspaceRoot).replace(/\\/g, "/").replace(/\/+$/, "");
    const p = normalizeEntryPath(entryOrDir, workspaceRoot);
    return p.startsWith(ws + "/install") || p.startsWith(ws + "/build");
}

/**
 * 从 env 提取 include 前缀集合(CMAKE/AMENT/COLCON_PREFIX_PATH,与 terminal-profile 同键)。
 */
export function collectPrefixes(env: any | undefined): Set<string> {
    const prefixes = new Set<string>();
    if (env) {
        for (const key of ["CMAKE_PREFIX_PATH", "AMENT_PREFIX_PATH", "COLCON_PREFIX_PATH"]) {
            const v = env[key];
            if (typeof v === "string") {
                for (const part of v.split(path.delimiter)) {
                    if (part.length > 0) {
                        prefixes.add(part);
                    }
                }
            }
        }
    }
    return prefixes;
}

/**
 * 系统 include 目录:前缀拼 /include 无条件收录(2026-09-02 简化——空路径在 include 搜索中被静默跳过,
 * 无副作用;不存在时无需检测,将来目录创建即生效,也不需要 watcher)。无环境时返回空。
 */
export function collectSystemIncludes(env: any | undefined, workspaceRoot = ""): string[] {
    const dirs: string[] = [];
    for (const prefix of collectPrefixes(env)) {
        // 本工作区前缀一律剔除(2026-09-15 用户裁定):本工作区的头走"工作空间包 src include"组;
        // install 前缀的形状随布局(isolated↔merged)变化,收进来只会让配置随布局抖动
        if (workspaceRoot && isUnderWorkspace(prefix, workspaceRoot)) {
            continue;
        }
        dirs.push(path.join(prefix, "include"));
    }
    return dirs;
}

/** Python 搜索目录:env.PYTHONPATH 原样条目(extraPaths 以运行时为准,不猜目录) */
export function collectPythonDirs(env: any | undefined, workspaceRoot = ""): string[] {
    const v = env?.PYTHONPATH;
    if (typeof v !== "string" || !v) {
        return [];
    }
    return v
        .split(path.delimiter)
        .filter((s) => s.length > 0)
        // 同上:本工作区条目(install/*/site-packages、build/<pkg> 等)一律剔除
        .filter((s) => !(workspaceRoot && isUnderWorkspace(s, workspaceRoot)));
}

/* ================================================================== */
/* 静态安装路径模板(2026-09-15):工作区包的 install/build 落点          */
/* ================================================================== */

/**
 * 发行版路径常量(2026-09-15 用户裁定:不做版本区分,先把默认值定到 Humble)。
 * 跨发行版**只留本接口**:Iron+ 的 ament_cmake(python) 落点已并入 lib/<abi>/site-packages
 * (见 手工重设计/gen-静态路径核实-2026-09-15.md §4),届时换 cmakePythonPurelib 即可。
 */
export interface DistroPathTemplate {
    /** 发行版名(标注/日志用) */
    distro: string;
    /** Python ABI 目录段(如 python3.10);Windows 落点无此段,后续接 Windows 时另开字段 */
    pythonAbi: string;
    /** ament_cmake(+python) 的 purelib 相对前缀(Humble = local/lib/<abi>/dist-packages) */
    cmakePythonPurelib: string;
}

export const HUMBLE_PATH_TEMPLATE: DistroPathTemplate = {
    distro: "humble",
    pythonAbi: "python3.10",
    cmakePythonPurelib: "local/lib/python3.10/dist-packages",
};

export const DEFAULT_PATH_TEMPLATE: DistroPathTemplate = HUMBLE_PATH_TEMPLATE;

/** 安装布局(install/.colcon_install_layout 的内容;colcon 未加 --merge-install 即 isolated) */
export type InstallLayout = "isolated" | "merged";

/** 标记内容无法识别/文件缺失时的默认布局(colcon 默认 isolated) */
export const DEFAULT_INSTALL_LAYOUT: InstallLayout = "isolated";

/** 解析布局标记内容(实测落盘字节形如 "isolated\n" / "merged\n";其它/空 → undefined) */
export function parseInstallLayout(text: string | undefined): InstallLayout | undefined {
    const t = (text ?? "").trim().toLowerCase();
    return t === "isolated" || t === "merged" ? t : undefined;
}

/**
 * 读工作区安装布局 = 读 <wsRoot>/install/.colcon_install_layout **内容**(2026-09-15 手稿裁定)。
 * 文件不存在/读失败/内容非法 → DEFAULT_INSTALL_LAYOUT(isolated)。
 * 该文件由 colcon 在 install 基座创建时写一次(已存在不重写;删库或删 install/ 才会再现),
 * 故它同时是"构建结构变化"的信号(见 extension.ts 的 onDidCreate 监听)。
 */
export async function readInstallLayout(wsRoot: string, log?: { debug(msg: string): void }): Promise<InstallLayout> {
    try {
        const text = await fsPromises.readFile(path.join(wsRoot, "install", ".colcon_install_layout"), "utf8");
        const parsed = parseInstallLayout(text);
        if (parsed === undefined) {
            log?.debug(`安装布局标记内容无法识别("${text.trim()}")→ 按 ${DEFAULT_INSTALL_LAYOUT}`);
            return DEFAULT_INSTALL_LAYOUT;
        }
        return parsed;
    } catch {
        log?.debug(`安装布局标记不存在/不可读 → 按 ${DEFAULT_INSTALL_LAYOUT}`);
        return DEFAULT_INSTALL_LAYOUT;
    }
}

/**
 * ament_python 包(`isPythonPackage`)的 install 侧落点(**按布局塌缩**,2026-09-15 手稿裁定)。
 *  · isolated → `install/<pkg>/lib/<abi>/site-packages`
 *  · merged   → `install/lib/<abi>/site-packages`(所有包共用一条,外层去重)
 * **一律收录**(用户裁定"必须得加"):实体安装下这里是对应包的真实文件;符号安装下只有
 * `<pkg>.egg-link`(22B 指针,内容就是 `build/<pkg>`)——指针本身分析不了但目录真实、无害,
 * 且"实体/符号"不由 .colcon_install_layout 记录,这里不做内容嗅探。
 */
export function amentPythonInstallDir(wsRoot: string, pkg: string, layout: InstallLayout, tpl: DistroPathTemplate = DEFAULT_PATH_TEMPLATE): string {
    return layout === "merged"
        ? path.join(wsRoot, "install", "lib", tpl.pythonAbi, "site-packages")
        : path.join(wsRoot, "install", pkg, "lib", tpl.pythonAbi, "site-packages");
}

/**
 * ament_cmake(+python)包(rosidl 接口包 / ament_cmake_python 混合包)的 install 侧落点(按布局)。
 *  · isolated → `install/<pkg>/<purelib>`(Humble = local/lib/<abi>/dist-packages)
 *  · merged   → `install/<purelib>`
 * 符号安装下该目录**真实存在**、内部条目是指向 build/src 的符号链 → 分析器可直接用(与 site-packages 的
 * egg-link 存根不同);纯 C++ 包命中不到该目录,由存在性过滤剔除,故无需按包判定"是否含 Python"。
 */
export function cmakePythonInstallDir(wsRoot: string, pkg: string, layout: InstallLayout, tpl: DistroPathTemplate = DEFAULT_PATH_TEMPLATE): string {
    return layout === "merged"
        ? path.join(wsRoot, "install", tpl.cmakePythonPurelib)
        : path.join(wsRoot, "install", pkg, tpl.cmakePythonPurelib);
}

/** ament_python 包的符号安装 develop 注入目录(`build/<pkg>`;egg-link 指向的正是它) */
export function pythonDevelopDir(wsRoot: string, pkg: string): string {
    return path.join(wsRoot, "build", pkg);
}

/** 按包类型分派 + 去重的 install 侧 python 候选目录(pkgs 只需 name/isPython 两个事实) */
export function collectStaticPythonDirs(
    wsRoot: string,
    pkgs: readonly { name: string; isPython: boolean }[],
    layout: InstallLayout,
    tpl: DistroPathTemplate = DEFAULT_PATH_TEMPLATE
): string[] {
    const out: string[] = [];
    for (const p of pkgs) {
        if (!p.name) {
            continue;
        }
        out.push(p.isPython ? amentPythonInstallDir(wsRoot, p.name, layout, tpl) : cmakePythonInstallDir(wsRoot, p.name, layout, tpl));
    }
    return Array.from(new Set(out));
}

/**
 * C++ 安装侧 include **消费根**(非 ament_python 包;按布局塌缩):
 *  · isolated → `install/<pkg>/include/<pkg>`(每包一条;**多写一层包名**,杜绝
 *    `#include <pkg>/<pkg>/…` 这种双层包名导入 —— 与 clangd 消费根同款,2026-09-15 手稿注记)
 *  · merged   → `install/include`(所有包共用一条;cpptools 允许 `/**` 递归,故合并成一条)
 * 消费方差异(手稿裁定):cpptools 的 includePath 支持 `/**` 递归 → 列全(死条目无害);
 * clangd 的 Add 只做逐条拼接、没有通配递归 → 由 clangdGroupDirs 只取**真实存在**的子根。
 */
export function cppInstallIncludeDir(wsRoot: string, pkg: string, layout: InstallLayout): string {
    return layout === "merged"
        ? path.join(wsRoot, "install", "include")
        : path.join(wsRoot, "install", pkg, "include", pkg);
}

/** 工作区安装侧 include 集合(去重;只收非 python 包——python 包没有头文件) */
export function collectStaticCppIncludes(wsRoot: string, pkgs: readonly { name: string; isPython: boolean }[], layout: InstallLayout): string[] {
    const out: string[] = [];
    for (const p of pkgs) {
        if (!p.name || p.isPython) {
            continue;
        }
        out.push(cppInstallIncludeDir(wsRoot, p.name, layout));
    }
    return Array.from(new Set(out));
}

/**
 * C++ 安装侧 include 的 **clangd 消费根**(静态写死,**不做存在性检测** —— 2026-09-16 用户裁定):
 *  · isolated → `install/<pkg>/include/<pkg>`(每包一条;与 cpptools 侧同一串)
 *  · merged   → `install/include/<pkg>`(每包一条 —— clangd 的 Add **没有通配递归**,必须逐包写完整条目)
 * 为什么静态:配置修正只有"包事件 / 环境事件"两个触发源,**新增头文件没有事件**;若按"目录现在是否存在"
 * 决定要不要写这一行,用户事后补上 `include/<pkg>` 时这行永远补不进配置。写死后目录将来出现即自然生效,
 * 当前不存在的行对 clangd 无害(找不到即跳过)。
 */
export function clangdInstallIncludeDir(wsRoot: string, pkg: string, layout: InstallLayout): string {
    return layout === "merged"
        ? path.join(wsRoot, "install", "include", pkg)
        : path.join(wsRoot, "install", pkg, "include", pkg);
}

/** 工作区安装侧 clangd 消费根集合(静态全量;去重,只收非 python 包) */
export function collectStaticClangdInstallIncludes(wsRoot: string, pkgs: readonly { name: string; isPython: boolean }[], layout: InstallLayout): string[] {
    const out: string[] = [];
    for (const p of pkgs) {
        if (!p.name || p.isPython) {
            continue;
        }
        out.push(clangdInstallIncludeDir(wsRoot, p.name, layout));
    }
    return Array.from(new Set(out));
}

/**
 * .clangd CompileFlags.Add 的【分组模型】(2026-09-07 修订,按【约定 B】只列一层消费根):
 * 目录集合按来源分组——
 *   ws = 工作区包 src include 根(源码布局 include/<pkg>/x.hpp,消费根即 <pkg>/include 本身);
 *   env = 前缀 include(含 <ws>/install 前缀、发行版 /opt/ros 等)下**各包子根 include/<pkg>**
 *         (约定 B 双层物理 include/<pkg>/<pkg>/… 的消费根,Humble+ 官方/rosidl 同款)。
 * .clangd 的 Add 不支持递归通配、须逐层显式;但按 B 语义**缺哪层列哪层**,不再"顶层 + 一级子层"
 * 并列:src 头经 ws 父根解析、install/发行版头经 sys 子根解析——父行对 B 安装头无解析力,
 * 子行对 src 源码是纯冗余(旧 2026-09-06 两者全列 = 冗余噪音)。前缀(-I / -isystem)由渲染层
 * 按组决定:工作区用 -I(用户源码高优先、告警全开),环境用 -isystem(系统级、告警抑制)。
 * 通用标志常量 -Wall(开启全部警告,历史保留)/ -std=c++20(必须,rclcpp 用 C++17 特性)。
 * 本层只算目录集合(格式无关,可无头测试)。
 */

/** Add 通用标志(非路径)常量:保持历史顺序 -Wall / -std=c++20 */
export const CLANGD_FLAG_ENTRIES: readonly string[] = ["-Wall", "-std=c++20"];

/**
 * 目录的直接子目录(仅目录、隐藏排除,排序保证输出稳定)。
 * 不存在/不可读 → undefined(调用方按"无子目录"处理)。
 */
async function childDirsOf(inc: string): Promise<string[] | undefined> {
    let subs;
    try {
        subs = await fsPromises.readdir(inc, { withFileTypes: true });
    } catch {
        return undefined;
    }
    const out = subs
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => path.join(inc, e.name));
    out.sort();
    return out;
}

/** include 目录分组(消费根绝对目录,无 -I/-isystem 前缀) */
export interface ClangdDirGroups {
    /** 工作空间包 src include 根(<pkg>/include,渲染为 -I<dir>) */
    ws: string[];
    /** 工作空间**安装产物** include 子根(按布局:install/<pkg>/include/<pkg> 或 install/include/<pkg>) */
    install: string[];
    /** 其它工作空间/发行版前缀的各包子根(include/<pkg>,渲染为 -isystem<dir>) */
    sys: string[];
}

/**
 * 按来源分三组收集 .clangd 需要的目录集合(2026-09-16 定版:工作区侧**全静态**,发行版侧仍需枚举):
 *  ws      = 工作区包 src include 根(源码,渲染 -I,告警全开;由包清单静态得出);
 *  install = 工作区**安装产物** include 消费根(由包清单 + 布局静态得出,**原样收录、不检测存在性**);
 *  sys     = 其它工作空间/发行版前缀的直接子目录 include/<pkg>(**这些前缀里的包名事先未知,只能枚举**——
 *            这一路保留 readdir;发行版包集合只有重装 ROS 才会变,不属"用户事后新增头文件"那一类),
 *            并在**末尾补一条前缀 include 根本身**(单层包名 `include/<pkg>/x.hpp` 只有父根能解析)。
 * 所有非 ws 行都渲染 -isystem。
 * 为什么工作区侧不检测存在性(用户裁定):配置修正只有"包事件 / 环境事件"两个触发源,**新增头文件没有事件**;
 *  按存在性筛行 = 用户事后补 `include/<pkg>` 时配置里永远没有这行。静态写死则目录将来出现即生效,
 *  当前不存在的行对 clangd 无害(找不到即跳过)。
 * 同目录跨组去重,优先级 ws > install > sys。
 */
export async function clangdGroupDirs(wsIncludes: string[], installIncludes: string[], sysIncludes: string[]): Promise<ClangdDirGroups> {
    const ws: string[] = [];
    const wsSeen = new Set<string>();
    for (const inc of new Set(wsIncludes)) {
        if (!wsSeen.has(inc)) {
            wsSeen.add(inc);
            ws.push(inc);
        }
    }
    const install: string[] = [];
    const installSeen = new Set<string>();
    for (const d of new Set(installIncludes)) {
        if (!wsSeen.has(d) && !installSeen.has(d)) {
            installSeen.add(d);
            install.push(d); // 静态原样收录(不 readdir、不 stat)
        }
    }
    const sys: string[] = [];
    const sysSeen = new Set<string>();
    for (const inc of new Set(sysIncludes)) {
        if (wsSeen.has(inc) || installSeen.has(inc)) {
            continue;
        }
        const children = await childDirsOf(inc);
        if (!children || children.length === 0) {
            continue;
        }
        for (const d of children) {
            if (!wsSeen.has(d) && !installSeen.has(d) && !sysSeen.has(d)) {
                sysSeen.add(d);
                sys.push(d);
            }
        }
    }
    // 末尾补"前缀 include 根本身"(2026-09-16 用户裁定:**就补这一条根**)——
    // 发行版里有若干包不是双层包名(实测 /opt/ros/humble/include 下 7 个:foonathan_memory、intra_process_demo、
    // libyaml_vendor、moodycamel、tf2_sensor_msgs、urdfdom、urdfdom_headers),头直接在 `<prefix>/include/<pkg>/x.hpp`,
    // 消费写法是 `#include <<pkg>/x.hpp>`,只有**父根**能解析;双层包(rosidl)继续走上方的子根行。
    for (const inc of new Set(sysIncludes)) {
        if (!wsSeen.has(inc) && !installSeen.has(inc) && !sysSeen.has(inc)) {
            sysSeen.add(inc);
            sys.push(inc);
        }
    }
    return { ws, install, sys };
}

/**
 * 解析 .clangd 的 CompileFlags.Add 块(兼容 flow `Add: [` 与 block `Add:` 两种 YAML 风格),
 * 返回 { style, entries }——entries 为去格式前缀的规范条目集合(如 `-I<abs>` / `-std=c++20`)。
 * Add 列表内 # 注释行(2026-09-06 分组标记注释)一律跳过,不中断 block 列表、不冒充条目。
 * 找不到 CompileFlags/Add 块 → undefined(增量合并跳过,由全量生成兜底)。
 */
export function parseClangdAddEntries(text: string): { style: "flow" | "block"; entries: Set<string> } | undefined {
    const lines = text.split(/\r?\n/);
    // 找 CompileFlags 块
    let cfIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*CompileFlags:\s*$/.test(lines[i])) {
            cfIdx = i;
            break;
        }
    }
    if (cfIdx < 0) {
        return undefined;
    }
    const cfIndent = (lines[cfIdx].match(/^\s*/) || [""])[0].length;
    for (let i = cfIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") {
            continue;
        }
        const indent = (line.match(/^\s*/) || [""])[0].length;
        if (indent <= cfIndent) {
            break; // 离开 CompileFlags 块
        }
        const m = line.match(/^\s*Add:\s*(\[)?\s*$/);
        if (!m) {
            continue;
        }
        const style: "flow" | "block" = m[1] === "[" ? "flow" : "block";
        const entries = new Set<string>();
        if (style === "flow") {
            // Add: [ 之后到 ] 行的元素(每行逗号分隔,去掉尾逗号);# 开头注释行跳过
            for (let j = i + 1; j < lines.length; j++) {
                const l = lines[j];
                if (l.trim().startsWith("#")) {
                    continue;
                }
                if (l.includes("]")) {
                    const item = l.slice(0, l.indexOf("]")).trim().replace(/,$/, "");
                    if (item.length > 0) {
                        entries.add(item);
                    }
                    break;
                }
                const item = l.trim().replace(/,$/, "");
                if (item.length > 0) {
                    entries.add(item);
                }
            }
        } else {
            // block: Add: 之后的 `- <item>` 行,直到空行/离开 CompileFlags;# 注释行跳过(不中断列表)
            for (let j = i + 1; j < lines.length; j++) {
                const l = lines[j];
                if (l.trim() === "") {
                    break;
                }
                if (l.trim().startsWith("#")) {
                    continue;
                }
                const lIndent = (l.match(/^\s*/) || [""])[0].length;
                if (lIndent <= cfIndent) {
                    break;
                }
                const m2 = l.trim().match(/^-\s+(.+)$/);
                if (m2) {
                    entries.add(m2[1].trim());
                }
            }
        }
        return { style, entries };
    }
    return undefined;
}
/** 包 include 目录(包 dir/include 绝对路径) */
export function absIncludeForPkg(dir: string): string {
    return path.join(dir, "include");
}

/**
 * 删除前复核:dir 下 package.xml 仍存在 → 包未消失(未缺席)→ false(不删);
 * package.xml 不存在 → 包确实消失 → true(可删)。目录被占用/恢复时包仍在,保守不删。
 */
export async function recheckPackageAbsent(dir: string): Promise<boolean> {
    try {
        await fsPromises.access(path.join(dir, "package.xml"));
        return false; // 包仍在(恢复/目录被占用)→ 不删
    } catch {
        return true; // package.xml 缺失 → 包确实消失 → 可删
    }
}

/**
 * Python extraPaths 规范排序(2026-09-09,与 C++ includePath"先列先赢 + 每轮整块重排"对齐):
 * 先列先赢,src 源码(同名冲突时"你的"胜)优先于 build/install 陈旧拷贝,官方置尾兜底。
 * 组序(跨组固定;同组保持输入相对顺序,稳定排序,不 churn):
 *   ① 工作区 ament_python 包根(pkgRoots 名单,当前源码,如 `<ws>/src/<pkg>`)
 *   → ② 其它未分类(env 内非常规/历史遗留)
 *   → ③ `install/.../site-packages`(已装 python 包;实体=真实文件,符号=egg-link 存根)
 *   → ④ 含 `build` 段的目录(符号安装的 develop 注入 `build/<pkg>`,egg-link 指向的正是它)
 *   → ⑤ `install/.../local/.../dist-packages` 等其它 install 形态(接口包/混合包)
 *   → ⑥ `/opt/ros`(官方兜底置尾)
 * 注意:**只对管辖条目调用**(调用方把用户自加条目留在队尾原序保留,不传入本函数);本函数不做用户条目排序。
 * 无 Python "-isystem 告警抑制"概念,排序唯一作用 = 同名谁赢 + 实体陈旧时看新版,纯加分无副作用。
 */
export function orderPythonExtraPaths(dirs: readonly string[], pkgRoots: readonly string[]): string[] {
    const rootSet = new Set(pkgRoots.map((d) => path.normalize(d)));
    const bucketOf = (d: string): number => {
        const norm = path.normalize(d);
        if (rootSet.has(norm)) {
            return 0; // ① 工作区 python 包根(源码)
        }
        const p = norm.replace(/\\/g, "/").replace(/\/+$/, "");
        if (p.startsWith("/opt/ros")) {
            return 6; // ⑥ 官方置尾
        }
        const segs = p.split("/").filter((s) => s.length > 0);
        if (segs.includes("site-packages")) {
            return 3; // ③ install/.../site-packages(已装 python 包;实体=真实文件,符号=egg-link 存根)
        }
        if (segs.includes("build")) {
            return 4; // ④ build/<pkg>(符号安装 develop 注入,egg-link 指向的正是它)
        }
        if (segs.includes("install")) {
            return 5; // ⑤ install/.../local/.../dist-packages 等其它 install 形态(接口包/混合包)
        }
        return 1; // ② 其它(用户自加/非常规)
    };
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const d of dirs) {
        if (d.length > 0 && !seen.has(d)) {
            seen.add(d);
            unique.push(d);
        }
    }
    // 稳定排序:同桶保持原相对顺序(组内顺序不因历史累积漂移)
    return unique.sort((a, b) => bucketOf(a) - bucketOf(b));
}
// 修改时间:2026-09-09 01:43(新增 orderPythonExtraPaths:python extraPaths 规范组序,对齐 C++ includePath 重排)