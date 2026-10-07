// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file intellisense-render.ts
 * 配置生成【渲染器】(写文件侧):c_cpp_properties.json / .clangd / python extraPaths。
 * 从原 intellisense-config.ts 分裂(2026-09-02):sync* 语义="存在→合并缺失、缺失→生成"+ 有感删除;
 * 引擎开关(cpptools/clangd 侧)由编排层决定调用哪些,本层不感知。
 *
 * 2026-09-07 语义修订(头文件布局统一【约定 B】,层级收敛):
 *  - include 按【来源】分工作空间(src)/ 环境前缀(CMAKE/AMENT/COLCON 拼 include,含 <ws>/install);
 *    编译器默认搜索路径(/usr/include 等)**不再收录**(隐式自带,收录即与系统路径重复)。
 *  - .clangd:工作空间 → `-I<dir>`,环境前缀 → `-isystem<dir>`(单 token,clang/g++ 均接受;已实测)。
 *    -I 组无条件先于 -isystem 命中(与顺序无关,已实测)——src 新头永远优先于 install/发行版旧头。
 *    行集 = **每包一行消费根**:工作空间包 = <pkg>/include 父根(src 头经此解析);环境前缀 =
 *    各包子根 include/<pkg>(约定 B 双层物理 include/<pkg>/<pkg>/… 的消费根)。不再"顶层+一级子层"
 *    父子并列(旧 2026-09-06 形态兼容 A/B 两套而全列,统一 B 后父行对 B 无解析力、子行对 src 冗余)。
 *    增量合并:管辖条目(即当前 ws/env 行集)无论被用户改成什么形态(-I<env>、重复行、旧父/子行),
 *    同步时归正为规范形态并入组,多余重复行移除;管辖外条目原地保留;不整块重排(列表太长,用户
 *    无法核对"哪一个在哪")。
 *  - c_cpp_properties.json(短文件,策略靠顺序生效):includePath 每轮重排为
 *    [管辖条目规范序(工作空间 src → 环境前缀)] + [管辖外额外条目(原顺序、去重,不参与顺序判断)];
 *    字段补齐/升级:缺 compileCommands 补 ${workspaceFolder}/build/compile_commands.json;
 *    cppStandard == 旧默认 gnu++17 → gnu++20(与 .clangd 的 -std=c++20 对齐)。
 * 2026-09-08(有感删除预检):新增 cppIncludeEntryExists / clangdIncludeExists / pythonPathExists——
 * 弹窗前存在性检查:配置里已无的条目不再弹窗(无命中类整体消失);判定口径与 remove* 完全一致。
 */

import * as path from "path";
import { promises as fsPromises } from "fs";
import * as vscode from "vscode";

import { isPythonPackage, type PackageEntry } from "../../../package-core/api";
import {
    CLANGD_FLAG_ENTRIES,
    clangdGroupDirs,
    collectStaticPythonDirs,
    DEFAULT_PATH_TEMPLATE,
    isBuildArtifactEntry,
    orderPythonExtraPaths,
    parseClangdAddEntries,
    pythonDevelopDir,
    toCppIncludeEntry,
    type DistroPathTemplate,
    type InstallLayout,
} from "./intellisense-utils";
import { getLogger } from "../../../../logger";

/** 渲染器日志(2026-09-06:补配置生成落盘可观测性——每个真实写盘/变更决策留 info,细节 debug) */
const log = getLogger("intellisense-render");

/**
 * 工作区 settings.json 写入单飞链(2026-09-09,参照 state-file 单写者思路):
 * `cfg.update` 每调用一次就整文件重写 settings.json,而 python 侧一个同步动作要写两个键
 * (python.autoComplete.extraPaths → python.analysis.extraPaths)——两次写之间存在"只改了一半"的中间态,
 * 多路同步/删除并发时还会互相交错。本链按 workspaceRoot 串行化全部 settings 相关写入:
 * 顺序执行、不重叠(两次保存仍不可避免,但绝不交错,收敛结果一致)。
 */
const settingsWriteChains = new Map<string, Promise<unknown>>();

/** 串行执行一次 settings 写入任务(前次失败不阻断后续;返回本次任务结果) */
function enqueueSettingsWrite<T>(workspaceRoot: string, task: () => Promise<T>): Promise<T> {
    const prev = settingsWriteChains.get(workspaceRoot) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    settingsWriteChains.set(workspaceRoot, run.catch(() => undefined));
    return run;
}


/** c_cpp_properties.json 默认 compileCommands(与 ros2/environment/compile-commands.ts 合并产物位置一致) */
const CPP_DEFAULT_COMPILE_COMMANDS = "${workspaceFolder}/build/compile_commands.json";
/** 与 .clangd -std=c++20 对齐的 cppStandard(2026-09-06 由 gnu++17 提升) */
const CPP_DEFAULT_CPP_STANDARD = "gnu++20";
/** 编译器默认系统搜索根(2026-09-06 起不再收录;历史旧文件残留条目在升级时清除) */
const USR_INCLUDE_ROOT = "/usr/include"; // POSIX 恒等,比较前统一分隔符

/** includePath 条目字符串 → 目录(剥 ${workspaceFolder} 与尾 /**,仅用于比对管辖) */
function includePathDirOf(entry: string): string {
    let d = entry;
    if (d.startsWith("${workspaceFolder}/") || d.startsWith("${workspaceFolder}\\") || d === "${workspaceFolder}") {
        d = d.slice("${workspaceFolder}".length).replace(/^[\\/]/, "");
    }
    d = d.replace(/\*\*$/, "").replace(/[\\/]$/, "");
    return d.replace(/\\/g, "/");
}

/** 残留历史管辖判断:/usr/include 及其子目录(编译器默认路径,现不在任何管辖集) */
function isLegacyUsrInclude(entryOrDir: string): boolean {
    const d = entryOrDir.includes("**") ? includePathDirOf(entryOrDir) : entryOrDir.replace(/\\/g, "/");
    return d === USR_INCLUDE_ROOT || d.startsWith(USR_INCLUDE_ROOT + "/");
}

/**
 * c_cpp_properties.json 同步(2026-09-06 语义升级):
 *  - 生成(缺失):全新文件,compileCommands + cppStandard gnu++20(Linux 附 intelliSenseMode/compilerPath);
 *  - 已存在:includePath 整块重排 = [管辖条目(新条目规范序,去重)] + [管辖外额外条目(原顺序去重,
 *    如用户自加目录,不纳入顺序判断)];字段补齐/升级(缺 compileCommands 补默认、cppStandard==gnu++17
 *    旧默认升 gnu++20、缺 cStandard 补 gnu11),其余字段保留。无变化不写盘。
 */
export async function syncCppProperties(workspaceRoot: string, includes: string[]): Promise<void> {
    const dir = path.join(workspaceRoot, ".vscode");
    const filename = path.join(dir, "c_cpp_properties.json");
    const canonical = Array.from(new Set(includes.map((i) => toCppIncludeEntry(i, workspaceRoot)))); // 管辖条目(规范序)
    let raw: any;
    try {
        raw = JSON.parse(await fsPromises.readFile(filename, "utf8"));
    } catch {
        raw = undefined; // 不存在/损坏 → 生成全新
    }
    if (raw === undefined) {
        const cfg: any = {
            browse: {
                databaseFilename: "${workspaceFolder}/.vscode/browse.vc.db",
                limitSymbolsToIncludedHeaders: false,
            },
            includePath: canonical,
            name: "ros2",
            compileCommands: CPP_DEFAULT_COMPILE_COMMANDS,
            cppStandard: CPP_DEFAULT_CPP_STANDARD, // 对齐 .clangd -std=c++20(跨平台)
        };
        if (process.platform === "linux") {
            cfg.intelliSenseMode = "gcc-" + process.arch;
            cfg.compilerPath = "/usr/bin/gcc";
            cfg.cStandard = "gnu11";
        }
        const cppProperties = { configurations: [cfg], version: 4 };
        await fsPromises.mkdir(dir, { recursive: true });
        await fsPromises.writeFile(filename, JSON.stringify(cppProperties, undefined, 2), "utf8");
        log.info(`c_cpp_properties.json:已生成(缺失才写;includePath ${canonical.length} 条;compileCommands 默认;cppStandard=${CPP_DEFAULT_CPP_STANDARD})`);
        return;
    }
    const cfg0 = raw?.configurations?.[0];
    if (!cfg0 || !Array.isArray(cfg0.includePath)) {
        // 结构异常 → 整体重建(修复损坏文件)
        const cppProperties: any = {
            configurations: [{
                includePath: canonical,
                name: "ros2",
                compileCommands: CPP_DEFAULT_COMPILE_COMMANDS,
                cppStandard: CPP_DEFAULT_CPP_STANDARD,
            }],
            version: 4,
        };
        if (process.platform === "linux") {
            cppProperties.configurations[0].intelliSenseMode = "gcc-" + process.arch;
            cppProperties.configurations[0].compilerPath = "/usr/bin/gcc";
            cppProperties.configurations[0].cStandard = "gnu11";
        }
        await fsPromises.mkdir(dir, { recursive: true });
        await fsPromises.writeFile(filename, JSON.stringify(cppProperties, undefined, 2), "utf8");
        log.warn(`c_cpp_properties.json:结构异常(缺 configurations[0].includePath),整体重建修复(includePath ${canonical.length} 条)`);
        return;
    }
    // 重排:管辖条目规范序在前;管辖外额外条目按原顺序去重追加(不参与管辖顺序判断)
    // 历史残留 /usr/include 条目(上版生成器收录,现属编译器默认、不归管辖)→ 清除
    const canonicalSet = new Set(canonical);
    const leftovers: string[] = [];
    const seen = new Set<string>();
    let usrRemoved = 0;
    let managedRemoved = 0; // 本工作区 install/build 派生的旧条目(旧布局/旧形状)→ 删除
    for (const e of cfg0.includePath) {
        if (typeof e !== "string") {
            continue;
        }
        if (isLegacyUsrInclude(e)) {
            usrRemoved++; // 旧管辖残留(系统默认路径):升级清除
            continue;
        }
        if (isBuildArtifactEntry(e, workspaceRoot) && !canonicalSet.has(e)) {
            managedRemoved++; // 旧布局/旧形状残留(管辖条目):整批更换时删除,不留队尾
            continue;
        }
        if (!canonicalSet.has(e) && !seen.has(e)) {
            seen.add(e);
            leftovers.push(e);
        }
    }
    const newPath = [...canonical, ...leftovers];
    let pathChanged = false;
    if (newPath.length !== cfg0.includePath.length || newPath.some((e, i) => e !== cfg0.includePath[i])) {
        cfg0.includePath = newPath;
        pathChanged = true;
    }
    // 字段补齐/升级(缺默认补、旧默认升级;用户自定义其它值保留)
    const fieldChanges: string[] = [];
    if (cfg0.compileCommands === undefined) {
        cfg0.compileCommands = CPP_DEFAULT_COMPILE_COMMANDS;
        fieldChanges.push("补 compileCommands 默认");
    }
    if (cfg0.cppStandard === undefined || cfg0.cppStandard === "gnu++17") {
        const old = cfg0.cppStandard;
        cfg0.cppStandard = CPP_DEFAULT_CPP_STANDARD;
        fieldChanges.push(old === "gnu++17" ? "cppStandard gnu++17→gnu++20" : "补 cppStandard gnu++20");
    }
    if (process.platform === "linux" && cfg0.cStandard === undefined) {
        cfg0.cStandard = "gnu11";
        fieldChanges.push("补 cStandard gnu11");
    }
    if (pathChanged || fieldChanges.length > 0) {
        await fsPromises.writeFile(filename, JSON.stringify(raw, undefined, 2), "utf8");
        const parts: string[] = [];
        if (pathChanged) {
            parts.push(`includePath 重排:管辖 ${canonical.length} 条 + 管辖外保留 ${leftovers.length} 条`);
            if (usrRemoved > 0) {
                parts.push(`清除 /usr/include 残留 ${usrRemoved} 条`);
            }
            if (managedRemoved > 0) {
                parts.push(`清除本工作区构建产物残留 ${managedRemoved} 条(布局/形状已变)`);
            }
        }
        if (fieldChanges.length > 0) {
            parts.push(`字段:${fieldChanges.join(";")}`);
        }
        log.info(`c_cpp_properties.json:已更新(${parts.join(";")})`);
    } else {
        log.debug("c_cpp_properties.json:无变化,不写盘");
    }
}
/**
 * Python extraPaths:工作区包 = ament_python 包根(方案 A 按类型分派) + **静态安装路径模板**
 * (2026-09-15:install/build 落点一律由本地模板生成,不再取 env.PYTHONPATH 里的本工作区条目);
 * env 侧只贡献"其他工作空间 + 系统"的注入目录。
 * 发行版模板(2026-09-28 VD-2):tpl 由编排层按 env.ROS_DISTRO + PYTHONPATH 观测解析后传入
 * (缺省 = DEFAULT humble,与历史行为一致),决定 site-packages 的 ABI 段与 ament_cmake purelib 形态。
 * 维护语义(2026-09-09 升级,对齐 cpp includePath 整块重排):成员 = 现有 ∪ 新收录(用户条目保留),
 * **顺序按规范组序整块重排**(orderPythonExtraPaths:src 源码 → 其它 → build → install/site-packages
 * → install/local/dist-packages → /opt/ros 官方置尾)——先列先赢:同名冲突时"你的包"胜、实体安装陈旧时
 * 分析器看新版;与 C++ `-I` 同思路(无 -isystem 抑制语义,纯排序无副作用)。
 */
export async function syncPythonPaths(
    workspaceRoot: string,
    entries: PackageEntry[],
    envDirs: string[],
    layout: InstallLayout = "isolated",
    tpl: DistroPathTemplate = DEFAULT_PATH_TEMPLATE
): Promise<void> {
    await enqueueSettingsWrite(workspaceRoot, () => syncPythonPathsInner(workspaceRoot, entries, envDirs, layout, tpl));
}

async function syncPythonPathsInner(workspaceRoot: string, entries: PackageEntry[], envDirs: string[], layout: InstallLayout, tpl: DistroPathTemplate): Promise<void> {
    // settings.json 的通用排除键(手稿要求):与 extraPaths 一并维护,补写缺失模式
    await ensureWorkspaceExcludeSettings();
    // 按类型分派(2026-09-02 方案 A):ament_python 包根(= 源码,官方布局 setup.py 必在包根);
    // C++ 包根不进 extraPaths。
    const pythonPkgs = entries.filter((p) => isPythonPackage(p));
    const pythonDirs: string[] = pythonPkgs.map((p) => p.dir);
    // 安装侧落点(2026-09-16 定版):按 .colcon_install_layout 塌缩成 isolated/merged 对应形态,
    // **静态全量写入、不做存在性检测** —— 配置修正只有"包事件 / 环境事件"两个触发源,新增头文件/新建目录
    // 没有事件;按存在性筛条目会导致"用户事后补上目录时配置里永远没有这条"。不存在的条目对分析器无害。
    // (符号安装下 site-packages 里只有 <pkg>.egg-link 存根 → 同样一律写入,用户裁定"必须得加"。)
    const installDirs = collectStaticPythonDirs(
        workspaceRoot,
        entries.map((p) => ({ name: p.name, isPython: isPythonPackage(p) })),
        layout,
        tpl
    );
    // 符号安装的 develop 注入目录(egg-link 指向的就是它)
    const developDirs = pythonPkgs.map((p) => pythonDevelopDir(workspaceRoot, p.name));
    // envDirs 此时只含"其他工作空间 + 系统"条目(本工作区条目已在 collectPythonDirs 内剔除)
    const mergedDirs = Array.from(new Set([...pythonDirs, ...installDirs, ...developDirs, ...envDirs]));
    if (mergedDirs.length === 0) {
        return;
    }
    // 维护语义(2026-09-09,对齐 cpp includePath):管辖范围 = 当前工作区 ament_python 包根 + env.PYTHONPATH 注入目录;
    // 整块规范重排**只作用于管辖条目**(orderPythonExtraPaths:src → build → site-packages → local/dist → /opt/ros,
    // 先列先赢:同名时"你的包"胜、实体陈旧时看新版);**管辖外条目(用户自加,可出现在任何位置)不参与排序,
    // 以原相对顺序保留在队尾,且写盘与否的比较只看管辖段**——用户调整队尾/自加条目不触发重写。
    // 用户条目保留、不覆盖(2026-09-02 语义不变)。
    const cfg = vscode.workspace.getConfiguration();
    const syncKey = async (key: string, label: string): Promise<void> => {
        const cur = cfg.get<string[]>(key, []);
        const inM = new Set(mergedDirs);
        const managedCur = cur.filter((e) => inM.has(e));   // 管辖段(现文件里归我们管的)
        // 2026-09-15:本工作区 install/build 派生条目若不在新集合中 = 旧布局/旧形状残留 → 删除(不留队尾)
        const leftover = cur.filter((e) => !inM.has(e) && !isBuildArtifactEntry(e, workspaceRoot));
        const missing = mergedDirs.filter((e) => !cur.includes(e)); // 新收录(含新包/新 env 目录)
        const canonical = orderPythonExtraPaths([...managedCur, ...missing], pythonDirs);
        const desired = [...canonical, ...leftover];
        if (cur.length === desired.length && cur.every((e, i) => e === desired[i])) {
            log.debug(`${label} 无变化,不写`);
            return;
        }
        await cfg.update(key, desired, vscode.ConfigurationTarget.Workspace);
        const added = desired.length - cur.length;
        log.info(`${label} ${added > 0 ? `补充 ${added} 条并规范重排` : "规范重排"}后共 ${desired.length} 条`);
    };
    await syncKey("python.autoComplete.extraPaths", "settings.json:python.autoComplete.extraPaths");
    await syncKey("python.analysis.extraPaths", "settings.json:python.analysis.extraPaths");
}

/* ================================================================== */
/* settings.json 通用排除键(手稿 2026-09-15) */
/* ================================================================== */

/** 与 build/install/log 相关的排除模式(手稿四键) */
const WORKSPACE_EXCLUDE_GLOBS: readonly string[] = ["**/build/**", "**/install/**", "**/log/**"];

/**
 * 补写 settings.json 的三类排除键(手稿要求,只补缺失、不动用户已有值/顺序):
 *  · files.watcherExclude / search.exclude(对象:缺的键补 true)
 *  · python.analysis.exclude(数组:缺的模式追加到尾部)
 * 说明:ROS2.env.distro 不在此处维护——它由 ros2/environment 域(发行版自动发现)写入,gen 不越权。
 */
async function ensureWorkspaceExcludeSettings(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration();
    for (const key of ["files.watcherExclude", "search.exclude"]) {
        const cur = cfg.get<Record<string, boolean>>(key, {});
        const missing = WORKSPACE_EXCLUDE_GLOBS.filter((g) => cur[g] === undefined);
        if (missing.length === 0) {
            continue;
        }
        const next: Record<string, boolean> = { ...cur };
        for (const g of missing) {
            next[g] = true;
        }
        await cfg.update(key, next, vscode.ConfigurationTarget.Workspace);
        log.info(`settings.json:${key} 补写 ${missing.length} 条排除模式`);
    }
    const cur = cfg.get<string[]>("python.analysis.exclude", []);
    const missing = WORKSPACE_EXCLUDE_GLOBS.filter((g) => !cur.includes(g));
    if (missing.length > 0) {
        await cfg.update("python.analysis.exclude", [...cur, ...missing], vscode.ConfigurationTarget.Workspace);
        log.info(`settings.json:python.analysis.exclude 补写 ${missing.length} 条排除模式`);
    }
}

/* ================================================================== */
/* .clangd 分组注释标记(行尾精确匹配定位;生成/增量/删除清理共用) */
/* ================================================================== */

const ADD_FLAGS_MARKER = "# ---- 编译标志(与 include 无关) ----";
const ADD_WS_MARKER = "# ---- 工作空间包 include(工作空间在前,-I) ----";
/** 工作空间安装产物组注释(前缀固定,布局字样随 .colcon_install_layout) */
const ADD_INSTALL_MARKER_PREFIX = "# ---- 工作空间安装产物 include:";
const ADD_SYS_MARKER = "# ---- 环境前缀 include:发行版(在后,-isystem) ----";
/** 生成 install 组注释(手稿:isolated install/<pkg>/include / merged install/include) */
function addInstallMarker(layout: InstallLayout): string {
    return `${ADD_INSTALL_MARKER_PREFIX}${layout} install/${layout === "merged" ? "include" : "<pkg>/include"}(在后,-isystem) ----`;
}
const ADD_INSTALL_MARKER_ISOLATED = addInstallMarker("isolated");
const ADD_INSTALL_MARKER_MERGED = addInstallMarker("merged");
/** 全部本模块拥有的标记行(含另一布局的 install 注释,便于清理布局切换后的孤儿注释) */
const ADD_MARKERS = [ADD_FLAGS_MARKER, ADD_WS_MARKER, ADD_INSTALL_MARKER_ISOLATED, ADD_INSTALL_MARKER_MERGED, ADD_SYS_MARKER];

/**
 * CompilationDatabase 归属修正:clangd schema 中它是 CompileFlags 的【子键】,顶层/其它块内为无效键。
 * 保证最终状态:至多一行 CompilationDatabase,且(存在时)位于首个 CompileFlags 块内
 * (无块则文件尾补 CompileFlags 块承载;块内已有用户值 → 保留原值不覆盖;历史顶层行 → 移除)。
 * 返回:修正后的全文;无变化时返回原文本。只动 CompilationDatabase 相关行,不触碰 Add/其它内容。
 */
function ensureNestedCompilationDatabase(text: string): string {
    const lines = text.split("\n");
    // 定位首个 CompileFlags 块
    let cfIdx = -1;
    let cfIndent = 0;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*CompileFlags:\s*$/.test(lines[i])) {
            cfIdx = i;
            cfIndent = (lines[i].match(/^\s*/) || [""])[0].length;
            break;
        }
    }
    const isDbLine = (l: string): boolean => /^\s*CompilationDatabase:/.test(l);
    // 块内是否已有嵌套 CompilationDatabase(取首个)
    let nestedIdx = -1;
    if (cfIdx >= 0) {
        for (let i = cfIdx + 1; i < lines.length; i++) {
            const l = lines[i];
            if (l.trim() === "") {
                continue;
            }
            const indent = (l.match(/^\s*/) || [""])[0].length;
            if (indent <= cfIndent) {
                break;
            }
            if (isDbLine(l)) {
                nestedIdx = i;
                break;
            }
        }
    }
    const kept: string[] = [];
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (isDbLine(l)) {
            if (i === nestedIdx) {
                kept.push(l); // 块内唯一合法实例:保留(含用户自定义值)
            } else {
                changed = true; // 顶层/重复/其它块内实例:删除(无效键)
            }
            continue;
        }
        kept.push(l);
        if (cfIdx >= 0 && i === cfIdx && nestedIdx < 0) {
            kept.push(" ".repeat(cfIndent + 2) + "CompilationDatabase: build");
            changed = true;
        }
    }
    if (cfIdx < 0) {
        // 无 CompileFlags 块:文件尾补块承载(历史行为是裸顶层键,现改为合法嵌套)
        if (kept.length > 0 && kept[kept.length - 1] !== "") {
            kept.push("");
        }
        kept.push("CompileFlags:", "  CompilationDatabase: build");
        changed = true;
    }
    if (!changed) {
        return text;
    }
    let out = kept.join("\n");
    if (!out.endsWith("\n")) {
        out += "\n";
    }
    return out;
}

/** Add 块结束位置:from 起第一个空行/回到顶层键(index;含)。与 parseClangdAddEntries 的终止判定对齐。 */
function findAddBlockEnd(lines: string[], from: number): number {
    for (let i = from; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === "") {
            return i;
        }
        const indent = (l.match(/^\s*/) || [""])[0].length;
        if (indent <= 0) {
            return i;
        }
    }
    return lines.length;
}

/** 删除后清理:被删空的组,其注释标记行一并移除(防孤儿注释);仅识别本模块拥有的标记行,其余不动。 */
function dropOrphanedAddMarkers(lines: string[]): string[] {
    return lines.filter((l, i) => {
        if (!ADD_MARKERS.includes(l.trim())) {
            return true;
        }
        for (let j = i + 1; j < lines.length; j++) {
            const n = lines[j];
            if (n.trim() === "") {
                return false; // 后接空行/文件尾 → 孤儿
            }
            if (ADD_MARKERS.includes(n.trim())) {
                return false; // 后接另一标记 → 孤儿
            }
            const indent = (n.match(/^\s*/) || [""])[0].length;
            if (indent <= 2) {
                return false; // 后接缩进 ≤2 的键行 → 孤儿
            }
            return /^\s*-\s+/.test(n); // 后接条目 → 保留
        }
        return false; // 到文件尾仍无条目 → 孤儿
    });
}

/** YAML 列表项行 → 裸条目 token("-I<dir>" / "-isystem<dir>" / "-Wall" / 用户自加内容);非条目行返回 null */
function itemTokenOf(line: string): string | null {
    const t = line.trim();
    if (!t.startsWith("- ")) {
        return null;
    }
    const v = t.slice(2).trim();
    return v.length > 0 ? v : null;
}

/**
 * .clangd 同步(2026-09-07 修订,约定 B 层级收敛):
 *  - 生成(不存在):CompileFlags.CompilationDatabase 子键 + Add 分组:编译标志(-Wall/-std=c++20)/
 *    工作空间组 `-I<dir>` / 环境前缀组 `-isystem<dir>`(每包一行消费根:ws 父根 / env 子根,注释分隔);
 *  - 已存在(block):CompilationDatabase 归属修正 → Add 管辖条目归正(旧 `-I<env目录>` → `-isystem<...>`,
 *    错位/重复行/旧父子并列形态的父行(env include 父根)与子行(ws include/<pkg>)移除;
 *    管辖 = 当前 ws/env 行集;管辖外条目原地保留)→ 缺失规范条目按组插入
 *    (工作空间组 / 环境组 / 标志头);无分组注释的旧 block 文件同样归正,缺失条目统一补在列表头;
 *  - flow(用户风格):保守——仅缺失条目在 `]` 前插入,不做归正;
 *  - 不整块重排(列表太长,用户无法核对条目位置)。
 */
export async function syncClangd(workspaceRoot: string, groups: { ws: string[]; install?: string[]; sys: string[] }, layout: InstallLayout = "isolated"): Promise<void> {
    const filename = path.join(workspaceRoot, ".clangd");
    const dirs = await clangdGroupDirs(groups.ws, groups.install ?? [], groups.sys);
    const wsTokens = dirs.ws.map((d) => `-I${d}`);
    const installTokens = dirs.install.map((d) => `-isystem${d}`);
    const sysTokens = dirs.sys.map((d) => `-isystem${d}`);
    const installMarker = addInstallMarker(layout);
    const flagsTokens = [...CLANGD_FLAG_ENTRIES];
    let text: string | undefined;
    try {
        text = await fsPromises.readFile(filename, "utf8");
    } catch {
        text = undefined; // 不存在 → 生成全新
    }
    if (text === undefined) {
        // 生成:block 风格 + CompileFlags.CompilationDatabase 子键 + 分组注释
        const lines = ["CompileFlags:", "  CompilationDatabase: build", "  Add:"];
        lines.push("    " + ADD_FLAGS_MARKER);
        for (const e of flagsTokens) {
            lines.push(`    - ${e}`);
        }
        if (wsTokens.length > 0) {
            lines.push("    " + ADD_WS_MARKER);
            for (const e of wsTokens) {
                lines.push(`    - ${e}`);
            }
        }
        if (installTokens.length > 0) {
            lines.push("    " + installMarker);
            for (const e of installTokens) {
                lines.push(`    - ${e}`);
            }
        }
        if (sysTokens.length > 0) {
            lines.push("    " + ADD_SYS_MARKER);
            for (const e of sysTokens) {
                lines.push(`    - ${e}`);
            }
        }
        await fsPromises.writeFile(filename, lines.join("\n") + "\n", "utf8");
        log.info(`.clangd:已生成(CompileFlags.CompilationDatabase:build;布局 ${layout};Add 标志 ${flagsTokens.length}/工作空间 -I ${wsTokens.length}/安装 -isystem ${installTokens.length}/发行版 -isystem ${sysTokens.length})`);
        return;
    }
    // 已存在 → ① CompilationDatabase 归属修正 ② 管辖归正 + 缺失合并
    const original = text;
    const migrated = ensureNestedCompilationDatabase(text);
    const dbMigrated = migrated !== original;
    const changes: string[] = [];
    if (dbMigrated) {
        changes.push("CompilationDatabase 收编为 CompileFlags 子键");
    }
    let changed = dbMigrated;
    text = migrated;
    const parsed = parseClangdAddEntries(text);
    if (!parsed) {
        if (changed) {
            await fsPromises.writeFile(filename, text, "utf8");
            log.info(`.clangd:已更新(${changes.join(";")};无 CompileFlags/Add 块,保守不代建 Add)`);
        } else {
            log.debug(".clangd:无变化,不写盘(无 CompileFlags/Add 块)");
        }
        return; // 无 CompileFlags/Add 块:只做 DB 归属修正(保守,不代建 Add)
    }
    const lines = text.split("\n");
    if (parsed.style === "block") {
        const addIdx = lines.findIndex((l) => /^\s*Add:\s*$/.test(l));
        if (addIdx < 0) {
            if (changed) {
                await fsPromises.writeFile(filename, text, "utf8");
                log.info(`.clangd:已更新(${changes.join(";")};无 Add 行,保守不处理)`);
            }
            return;
        }
        let blockEnd = findAddBlockEnd(lines, addIdx + 1);
        // ---- 管辖内破坏性归正:旧形态/错位/重复/旧父子并列行移除(不整块重排,管辖外条目原地保留) ----
        const wsRowSet = new Set(dirs.ws);
        const installRowSet = new Set(dirs.install);
        const sysRowSet = new Set(dirs.sys);
        // 旧形态来源(2026-09-07 约定 B 层级收敛):env 父根 include 本身在新行集(只列子根)中永不出现,
        // 一律属"旧父行";工作空间 include 根下的子目录属"旧 ws 子行"。二者均无对应规范行 → 移除;
        // 其余非规范行 = 管辖外,原地保留。
        const envParentLegacy = new Set([...groups.sys, ...(groups.install ?? [])].filter((d) => !sysRowSet.has(d) && !installRowSet.has(d)));
        const isUnderWsRoot = (d: string): boolean => groups.ws.some((p) => d.startsWith(p + path.sep) || d.startsWith(p + "/"));
        const removalIdx: number[] = [];
        const seenCanonical = new Set<string>();
        for (let i = addIdx + 1; i < blockEnd; i++) {
            const token = itemTokenOf(lines[i]);
            if (token === null) {
                continue;
            }
            let dir: string | null = null;
            let kind: "ws" | "sys" | null = null;
            if (token.startsWith("-I")) {
                dir = token.slice(2);
                kind = "ws";
            } else if (token.startsWith("-isystem")) {
                dir = token.slice("-isystem".length);
                kind = "sys";
            }
            if (dir === null || kind === null) {
                continue; // 非路径条目(标志/用户自加内容):不动
            }
            if (isLegacyUsrInclude(dir)) {
                removalIdx.push(i); // 历史残留 /usr/include(编译器默认):升级清除
                continue;
            }
            const inWs = wsRowSet.has(dir);
            const inInstall = installRowSet.has(dir);
            const inSys = sysRowSet.has(dir);
            const canonical = kind === "ws" ? inWs : inInstall || inSys;
            if (!canonical) {
                // 组间错位(env 行写成 -I / ws 行写成 -isystem)或旧父子并列行 → 移除;其余管辖外保留
                const misPlaced = kind === "ws" ? inInstall || inSys : inWs;
                if (misPlaced || envParentLegacy.has(dir) || isUnderWsRoot(dir) || isBuildArtifactEntry(dir, workspaceRoot)) {
                    removalIdx.push(i);
                }
                continue;
            }
            const canon = kind === "ws" ? `-I${dir}` : `-isystem${dir}`;
            if (seenCanonical.has(canon)) {
                removalIdx.push(i); // 管辖条目重复行 → 去重(保留首个)
            } else {
                seenCanonical.add(canon);
            }
        }
        for (const i of removalIdx.sort((a, b) => b - a)) {
            lines.splice(i, 1);
        }
        if (removalIdx.length > 0) {
            changes.push(`管辖归正移除 ${removalIdx.length} 行(旧形态/重复行/残留 /usr/include)`);
            changed = true;
            blockEnd = findAddBlockEnd(lines, addIdx + 1); // 行号已变,重算
        }
        // ---- 孤儿分组注释清理(2026-09-16):布局切换后"另一布局"的安装组注释会留下(其行已被上一步删掉),
        //      以及被删空的组注释。dropOrphanedAddMarkers 只认本模块拥有的标记文本(含 isolated/merged 两种安装组注释),
        //      后接条目 → 保留;后接空行/另一标记/文件尾 → 视为孤儿移除。 ----
        {
            const cleaned = dropOrphanedAddMarkers(lines);
            if (cleaned.length !== lines.length) {
                const removed = lines.length - cleaned.length;
                lines.length = 0;
                lines.push(...cleaned);
                changes.push(`清理孤儿分组注释 ${removed} 行(布局切换/组被删空)`);
                changed = true;
                blockEnd = findAddBlockEnd(lines, addIdx + 1);
            }
        }
        // ---- 缺失规范条目 → 组内插入(带分组注释按组定位;无注释旧文件统一插列表头) ----
        const present = new Set<string>();
        for (let i = addIdx + 1; i < blockEnd; i++) {
            const token = itemTokenOf(lines[i]);
            if (token !== null) {
                present.add(token);
            }
        }
        const missingFlags = flagsTokens.filter((e) => !present.has(e));
        const missingWs = wsTokens.filter((e) => !present.has(e));
        const missingInstall = installTokens.filter((e) => !present.has(e));
        const missingSys = sysTokens.filter((e) => !present.has(e));
        const needInsert = missingFlags.length + missingWs.length + missingInstall.length + missingSys.length > 0;
        if (needInsert) {
            const inRegion = lines.slice(addIdx + 1, blockEnd);
            const mIdx = (m: string): number => {
                const k = inRegion.findIndex((l) => l.trim() === m);
                return k < 0 ? -1 : k + addIdx + 1;
            };
            const mFlags = mIdx(ADD_FLAGS_MARKER);
            const mWs = mIdx(ADD_WS_MARKER);
            const mInstall = mIdx(installMarker);
            const mSys = mIdx(ADD_SYS_MARKER);
            const hasMarkers = mFlags >= 0 || mWs >= 0 || mInstall >= 0 || mSys >= 0;
            const ops: { at: number; add: string[] }[] = [];
            if (hasMarkers) {
                if (missingFlags.length > 0) {
                    ops.push({ at: mFlags >= 0 ? mFlags + 1 : addIdx + 1, add: missingFlags.map((e) => `    - ${e}`) });
                }
                if (missingWs.length > 0) {
                    const add: string[] = [];
                    if (mWs < 0) {
                        add.push("    " + ADD_WS_MARKER);
                    }
                    add.push(...missingWs.map((e) => `    - ${e}`));
                    const at = mInstall >= 0 ? mInstall : mSys >= 0 ? mSys : blockEnd;
                    ops.push({ at, add });
                }
                if (missingInstall.length > 0) {
                    const add: string[] = [];
                    if (mInstall < 0) {
                        add.push("    " + installMarker);
                    }
                    add.push(...missingInstall.map((e) => `    - ${e}`));
                    ops.push({ at: mInstall >= 0 ? mInstall + 1 : mSys >= 0 ? mSys : blockEnd, add });
                }
                if (missingSys.length > 0) {
                    const add: string[] = [];
                    if (mSys < 0) {
                        add.push("    " + ADD_SYS_MARKER);
                    }
                    add.push(...missingSys.map((e) => `    - ${e}`));
                    ops.push({ at: blockEnd, add });
                }
            } else {
                // 无分组注释的旧 block 文件:缺失条目统一插在 Add: 后(保守不重排)
                ops.push({ at: addIdx + 1, add: [...missingFlags, ...missingWs, ...missingInstall, ...missingSys].map((e) => `    - ${e}`) });
            }
            let shift = 0;
            for (const op of ops) {
                lines.splice(op.at + shift, 0, ...op.add);
                shift += op.add.length;
            }
            if (hasMarkers) {
                changes.push(`组内补缺失:标志 ${missingFlags.length}/工作空间 ${missingWs.length}/安装 ${missingInstall.length}/发行版 ${missingSys.length}`);
            } else {
                changes.push(`无组注释旧文件,列表头补缺失 ${missingFlags.length + missingWs.length + missingInstall.length + missingSys.length} 条`);
            }
            changed = true;
        }
    } else {
        // flow 风格(用户手写):保守,仅缺失条目在 `]` 前插入(带尾逗号);不做归正
        const missing = [...flagsTokens, ...wsTokens, ...installTokens, ...sysTokens].filter((e) => !parsed.entries.has(e));
        if (missing.length > 0) {
            const closeIdx = lines.findIndex((l) => l.trim() === "]");
            if (closeIdx >= 0) {
                lines.splice(closeIdx, 0, ...missing.map((e) => `    ${e},`));
                changes.push(`flow 保守:"]"前补缺失 ${missing.length} 条`);
                changed = true;
            }
        }
    }
    if (changed) {
        await fsPromises.writeFile(filename, lines.join("\n"), "utf8");
        log.info(`.clangd:已更新(${changes.join(";")})`);
    } else {
        log.debug(".clangd:无变化,不写盘");
    }
}
/* ================================================================== */
/* 有感删除【预检】(2026-09-08):弹窗前检查条目是否真在配置里——用户可能删包时已自删条目, */
/* 不在则不该弹窗(无命中类整体消失)。判定口径与下方 remove* 完全一致。 */
/* ================================================================== */

/** 预检(cpp 侧):c_cpp_properties.json includePath 是否含该条目(精确字符串匹配,与 removeCppIncludes 同口径) */
export async function cppIncludeEntryExists(workspaceRoot: string, entry: string): Promise<boolean> {
    try {
        const raw = JSON.parse(await fsPromises.readFile(path.join(workspaceRoot, ".vscode", "c_cpp_properties.json"), "utf8"));
        const cfg0 = raw?.configurations?.[0];
        return Array.isArray(cfg0?.includePath) && cfg0.includePath.includes(entry);
    } catch {
        return false; // 文件缺失/损坏 → 无条目可删
    }
}

/** 预检(clangd 侧):.clangd Add 是否含 -I<dir>(-I<dir><sep> 历史子行形态也算,与 removeClangdIncludes 同口径) */
export async function clangdIncludeExists(workspaceRoot: string, absIncludeDir: string): Promise<boolean> {
    try {
        const text = await fsPromises.readFile(path.join(workspaceRoot, ".clangd"), "utf8");
        const pattern = `-I${absIncludeDir}`;
        for (const line of text.split("\n")) {
            let t = line.trim();
            if (t.startsWith("- ")) {
                t = t.slice(2).trim(); // block 风格:剥列表项前缀
            }
            if (t === pattern || t.startsWith(pattern + path.sep) || t.startsWith(pattern + "/")) {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

/** 预检(python 侧):settings extraPaths(analysis / autoComplete)是否含该目录条目 */
export async function pythonPathExists(dir: string): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration();
    return cfg.get<string[]>("python.analysis.extraPaths", []).includes(dir)
        || cfg.get<string[]>("python.autoComplete.extraPaths", []).includes(dir);
}

/** 有感删除(A 侧):从 c_cpp_properties.json includePath 移除指定条目(精确匹配),返回删除数 */
export async function removeCppIncludes(workspaceRoot: string, entries: string[]): Promise<number> {
    const cppPath = path.join(workspaceRoot, ".vscode", "c_cpp_properties.json");
    try {
        const raw = JSON.parse(await fsPromises.readFile(cppPath, "utf8"));
        const cfg0 = raw?.configurations?.[0];
        if (!cfg0 || !Array.isArray(cfg0.includePath)) {
            return 0;
        }
        const removeSet = new Set(entries);
        const kept = cfg0.includePath.filter((e: unknown) => typeof e === "string" && !removeSet.has(e));
        const removedCount = cfg0.includePath.length - kept.length; // 先算差值(赋值后长度相等,不能再用原数组长度算)
        if (removedCount > 0) {
            cfg0.includePath = kept;
            await fsPromises.writeFile(cppPath, JSON.stringify(raw, undefined, 2), "utf8");
            log.info(`c_cpp_properties.json:有感删除 includePath ${removedCount} 条`);
        } else {
            log.debug("c_cpp_properties.json:有感删除无命中(残留容忍,只多不少)");
        }
        return removedCount;
    } catch {
        return 0;
    }
}

/**
 * 有感删除(B 侧):从 .clangd 移除指定 -I 条目(工作空间根精确 + 历史遗留子行前缀匹配),兼容
 * flow/block 两种风格行。entries 为顶层 include 绝对路径;匹配 trim 后(block 先剥 `- ` 前缀)
 * 等于 -I<entry> 或以 -I<entry><sep> 开头(旧"顶层+子层"并列形态残留一并清理)。
 * 删除后该组条目被删空时,一并移除本模块拥有的组注释标记(防孤儿注释);其余内容原样保留。
 */
export async function removeClangdIncludes(workspaceRoot: string, entries: string[]): Promise<number> {
    const clangdPath = path.join(workspaceRoot, ".clangd");
    try {
        let text = await fsPromises.readFile(clangdPath, "utf8");
        const patterns = entries.map((e) => `-I${e}`);
        const lines = text.split("\n");
        const kept: string[] = [];
        let removed = 0;
        for (const line of lines) {
            let t = line.trim();
            if (t.startsWith("- ")) {
                t = t.slice(2).trim(); // block 风格:剥掉列表项前缀
            }
            const hit = patterns.some((p) => t === p || t.startsWith(p + path.sep) || t.startsWith(p + "/"));
            if (hit) {
                removed++;
            } else {
                kept.push(line);
            }
        }
        if (removed > 0) {
            const cleaned = dropOrphanedAddMarkers(kept);
            await fsPromises.writeFile(clangdPath, cleaned.join("\n"), "utf8");
            log.info(`.clangd:有感删除 -I 条目 ${removed} 行(组注释清理 ${kept.length - cleaned.length} 行)`);
        } else {
            log.debug(".clangd:有感删除无命中(残留容忍,只多不少)");
        }
        return removed;
    } catch {
        return 0;
    }
}

/**
 * 有感删除(python 侧):从 python.analysis.extraPaths / python.autoComplete.extraPaths 移除指定目录条目
 * (精确匹配,与 syncPythonPaths 的补充语义对应——包消失时其源码目录一并移除)。
 * 返回删除条目总数。
 */
export async function removePythonPaths(workspaceRoot: string, entries: string[]): Promise<number> {
    return enqueueSettingsWrite(workspaceRoot, () => removePythonPathsInner(entries));
}

async function removePythonPathsInner(entries: string[]): Promise<number> {
    const cfg = vscode.workspace.getConfiguration();
    const removeSet = new Set(entries);
    let total = 0;
    for (const key of ["python.autoComplete.extraPaths", "python.analysis.extraPaths"]) {
        const cur = cfg.get<string[]>(key, []);
        const kept = cur.filter((e) => !removeSet.has(e));
        if (kept.length !== cur.length) {
            await cfg.update(key, kept, vscode.ConfigurationTarget.Workspace);
            total += cur.length - kept.length;
        }
    }
    if (total > 0) {
        log.info(`settings.json:有感删除 extraPaths 共 ${total} 条`);
    } else {
        log.debug("settings.json:有感删除 extraPaths 无命中(残留容忍,只多不少)");
    }
    return total;
}
// 修改时间:2026-09-08 22:53(新增有感删除预检三函数:cppIncludeEntryExists / clangdIncludeExists /
// pythonPathExists,与 remove* 同口径,供编排层弹窗前存在性检查——无命中不再弹窗)
// 修改时间:2026-09-09 01:43(syncPythonPaths 升级为整块规范重排:并集补缺失 + orderPythonExtraPaths 组序
// (src→其它→build→site-packages→local/dist→/opt/ros),对齐 cpp includePath 的先列先赢语义)
// 修改时间:2026-09-09 01:52(管辖收敛:重排/比较只作用于管辖条目(工作区包根+env 注入),用户自加条目
// 可位于任意位置、以原相对顺序留队尾,队尾/自加条目的顺序变化不触发重写)
// 修改时间:2026-09-09 20:47(settings.json 写入单飞链:syncPythonPaths/removePythonPaths 按 workspaceRoot 串行化,
// 防两键(analysis/autoComplete)两次整文件写并发交错成"只写一半"的中间态)
