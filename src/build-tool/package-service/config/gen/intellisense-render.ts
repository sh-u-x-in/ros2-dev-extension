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
 *    标准字段不代写不代升(2026-10-14 用户裁定:所有权归用户,补写只动 includePath)。
 * 2026-09-08(有感删除预检):新增 cppIncludeEntryExists / clangdIncludeExists / pythonPathExists——
 * 弹窗前存在性检查:配置里已无的条目不再弹窗(无命中类整体消失);判定口径与 remove* 完全一致。
 */

import * as path from "path";
import { promises as fsPromises } from "fs";
import * as vscode from "vscode";

import { isPythonPackage, type PackageEntry } from "../../../package-core/api";
import * as jsoncParser from "jsonc-parser";

import { normalizeCommentLang } from "../../../../../l10n/templates/index";
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
 * 多路同步/删除并发时还会互相交错。本链按 workspaceRoot 串行化全部配置文件写入:
 * 顺序执行、不重叠(2026-10-15 用户裁定"串行必须做"——c_cpp_properties.json/.clangd 的同步与
 * 有感删除也已并入本链,读-改-写竞态从结构上消除)。
 */
const settingsWriteChains = new Map<string, Promise<unknown>>();

/** 串行执行一次 settings 写入任务(前次失败不阻断后续;返回本次任务结果) */
function enqueueSettingsWrite<T>(workspaceRoot: string, task: () => Promise<T>): Promise<T> {
    const prev = settingsWriteChains.get(workspaceRoot) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    settingsWriteChains.set(workspaceRoot, run.catch(() => undefined));
    return run;
}

/**
 * 原子写(2026-10-15 用户裁定"原子性必须做"):临时文件 + rename 替换 —— 断电/断连/写盘中途失败
 * 不会产生半截文件(最坏保留旧版)。cpp/clangd 两文件专用;settings.json 走 VS Code 托管更新不适用。
 * 前置:调用方已入单飞链(同根串行),.tmp 名不会互相踩踏。
 */
async function writeFileAtomic(filename: string, content: string): Promise<void> {
    const tmp = `${filename}.tmp`;
    await fsPromises.writeFile(tmp, content, "utf8");
    await fsPromises.rename(tmp, filename);
}


/** c_cpp_properties.json 默认 compileCommands(与 ros2/environment/compile-commands.ts 合并产物位置一致) */
const CPP_DEFAULT_COMPILE_COMMANDS = "${workspaceFolder}/build/compile_commands.json";
/** 编译器默认系统搜索根(2026-09-06 起不再收录;历史旧文件残留条目在升级时清除) */
const USR_INCLUDE_ROOT = "/usr/include"; // POSIX 恒等,比较前统一分隔符

/**
 * 新建一份 name=ros2 配置成员(2026-10-14 鲁棒化):追加/从零生成两处共用,消字面量重复。
 * 形状 = 三键(name/includePath/compileCommands),极简克制(2026-10-14 用户裁定:
 * 标准字段所有权归用户,cppStandard/cStandard/browse/intelliSenseMode/compilerPath 一律不写)。
 */
function freshRos2Config(canonical: string[]): any {
    return {
        name: "ros2",
        includePath: canonical,
        compileCommands: CPP_DEFAULT_COMPILE_COMMANDS,
    };
}

/* ================================================================== */
/* 生成条目替换表(2026-10-14 三文件分辖):每张表的 key = 该文件生成条目的程序级精确定义值,
 * value = 替换串(逐字使用,不自动补 "-" 前缀),value 空串 = 删除该条目。三键分辖三文件、
 * key 文法各异(.clangd 裸 token / includePath 完整条目串 / extraPaths 目录串),撞 key 从
 * 结构上不可能——作用范围是显式声明,不靠"恰好匹配哪个文件的格式"。应用语义 = 链式解析至
 * 不动点(A→B→C 一次同步直达 C,零时间波动);环(如 A→B→A)→ 该条目剔除 + log.warn。
 * 原生条目(非 key)优先占位、映射副本撞车丢弃(「去用户副本留原生」)。【表盲红线】有感
 * 删除(remove*)与消失预检不感知任何一张表;非字符串值(清单约束 string,容错口径)按无
 * 规则处理。 */
/* ================================================================== */

/**
 * 三张替换表的设置键(键名锁测试在案,改名须同步测试与 package.json/nls/docs):
 * clangd → .clangd Add token;cpptools → c_cpp_properties.json includePath;python → 双 extraPaths。
 */
export const ENTRY_OVERRIDES_CLANGD_SETTING = "ide.entryOverrides.clangd";
export const ENTRY_OVERRIDES_CPPTOOLS_SETTING = "ide.entryOverrides.cpptools";
export const ENTRY_OVERRIDES_PYTHON_SETTING = "ide.entryOverrides.python";

/** 条目替换表解析结果:落位列表 + 空值链删除集(原条目)+ 环计数 */
export interface ApplyOverridesResult {
    list: string[];
    /** 空值链命中的原条目(文件侧主动删除用) */
    dropped: Set<string>;
    /** 环形规则剔除的条目数(每条已 log.warn) */
    cycles: number;
}

/** 替换表的有效 key 集(仅认字符串值;非字符串值 = 无规则,整条按原生条目处理) */
export function overrideKeySet(overrides: Record<string, string> | undefined): Set<string> {
    const ov = overrides ?? {};
    return new Set(Object.keys(ov).filter((k) => typeof ov[k] === "string"));
}

/** 链式解析:沿表跳至不动点;链末空值 → {null,false}(删除);环 → {null,true}(剔除);无规则/非字符串值 → 原样 */
function resolveChain(entry: string, ov: Record<string, string>): { value: string | null; cycle: boolean } {
    const seen = new Set<string>([entry]);
    let cur = entry;
    for (;;) {
        const next = ov[cur];
        if (typeof next !== "string") {
            return { value: cur, cycle: false }; // 不动点
        }
        cur = next;
        if (cur === "") {
            return { value: null, cycle: false }; // 链末空值 = 删除
        }
        if (seen.has(cur)) {
            return { value: null, cycle: true }; // 环 → 剔除(防无限循环与来回翻转)
        }
        seen.add(cur);
    }
}

/**
 * 对生成条目集应用替换表(纯函数):
 * 第一遍落所有【原生条目】(非 key)的解析值(优先占位),第二遍再落【映射条目】的解析值
 * (值已被占用 → 映射副本丢弃)。结果按首次落位去重,组内位置保持。
 */
export function applyEntryOverrides(entries: string[], overrides: Record<string, string> | undefined): ApplyOverridesResult {
    const ov = overrides ?? {};
    const keys = overrideKeySet(ov);
    const dropped = new Set<string>();
    let cycles = 0;
    const placed = new Set<string>();
    const list: string[] = [];
    const place = (entry: string): void => {
        const r = resolveChain(entry, ov);
        if (r.value === null) {
            if (r.cycle) {
                cycles++;
                log.warn(`entryOverrides:条目"${entry}"替换规则成环,该条目剔除`);
            } else {
                dropped.add(entry); // 链末空值 → 原条目删除
            }
            return;
        }
        if (!placed.has(r.value)) {
            placed.add(r.value);
            list.push(r.value);
        }
    };
    for (const e of entries) {
        if (!keys.has(e)) {
            place(e); // 第一遍:原生优先占位
        }
    }
    for (const e of entries) {
        if (keys.has(e)) {
            place(e); // 第二遍:映射条目(撞车丢映射副本)
        }
    }
    return { list, dropped, cycles };
}

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
 *  - 生成(缺失):全新文件,三键形状(name/includePath/compileCommands);
 *  - 已存在:includePath 整块重排 = [管辖条目(新条目规范序,去重)] + [管辖外额外条目(原顺序去重,
 *    如用户自加目录,不纳入顺序判断)];标准字段不补不升(所有权归用户)。无变化不写盘。
 *  - 替换表(2026-10-14,cpptools 键 `ide.entryOverrides.cpptools`,本文件专属):includes 先经
 *    applyEntryOverrides 链式解析(空值/环条目不落 canonical);
 *    文件里替换表管辖条目的旧形态(无论链末替换还是空值删除)一律清除,不经"管辖外条目"通道回流队尾。
 */
export async function syncCppProperties(workspaceRoot: string, includes: string[], overrides?: Record<string, string>): Promise<void> {
    // 2026-10-15 用户裁定"串行必须做":读-改-写整体入单飞链(与 settings.json 同链,per-root 串行)
    return enqueueSettingsWrite(workspaceRoot, () => syncCppPropertiesInner(workspaceRoot, includes, overrides));
}

async function syncCppPropertiesInner(workspaceRoot: string, includes: string[], overrides?: Record<string, string>): Promise<void> {
    const dir = path.join(workspaceRoot, ".vscode");
    const filename = path.join(dir, "c_cpp_properties.json");
    const canonical = applyEntryOverrides(includes.map((i) => toCppIncludeEntry(i, workspaceRoot)), overrides).list; // 管辖条目(规范序,链式解析后)
    // ---- 解析链(2026-10-14 鲁棒化):严格 JSON → JSONC 宽容(注释/尾逗号,jsonc-parser,覆盖面比官方宽)
    //      → 两连败(或结果非对象)才"迫不得已"从零重建。宽容命中 = 写盘丢注释,日志声明。 ----
    let raw: any;
    let tolerant = false;
    const text = await fsPromises.readFile(filename, "utf8").catch(() => undefined);
    if (text !== undefined) {
        try {
            raw = JSON.parse(text);
        } catch {
            try {
                raw = jsoncParser.parse(text);
                tolerant = true;
            } catch {
                raw = undefined;
            }
        }
        if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
            raw = undefined; // 顶层不是配置对象(数字/字符串等)→ 视同无法解析
        }
        if (tolerant && raw !== undefined) {
            log.info("c_cpp_properties.json:非严格 JSON(注释/尾逗号),已按宽容模式解析;本次写盘后注释将丢失");
        }
    }
    if (raw === undefined) {
        // 迫不得已(文件不存在/彻底报废):从零生成 —— 唯一允许"字面量整写"的场景
        const cppProperties = { configurations: [freshRos2Config(canonical)], version: 4 };
        await fsPromises.mkdir(dir, { recursive: true });
        await writeFileAtomic(filename, JSON.stringify(cppProperties, undefined, 2));
        log.info(`c_cpp_properties.json:文件不存在或无法解析,迫不得已从零生成(includePath ${canonical.length} 条;compileCommands 默认;标准字段不代写)`);
        return;
    }
    // ---- 认领 ros2 成员(2026-10-14 管理权白名单,用户裁定):只接管第一个 name==="ros2" 的成员;
    //      用户自有成员零接触;没找到 → 追加到数组【末尾】(不抢 [0],用户默认配置零位移);
    //      重复 ros2 → 保留最前一个接管,其余删除(name 重复永不愈合,删除数进日志)。 ----
    let claimChanged = false; // 认领段变更(建数组/追加/去重/补 version)——必须落盘(2026-10-15 修"改了但没写"案)
    if (!Array.isArray(raw.configurations)) {
        raw.configurations = [];
        claimChanged = true;
    }
    const configurations: any[] = raw.configurations;
    let cfg = configurations.find((c) => c && typeof c === "object" && c.name === "ros2") as any | undefined;
    if (cfg === undefined) {
        configurations.push(freshRos2Config(canonical));
        cfg = configurations[configurations.length - 1];
        claimChanged = true;
        log.info(`c_cpp_properties.json:未找到 name=ros2 配置,已追加到末尾(现有 ${configurations.length - 1} 个用户配置未动;includePath ${canonical.length} 条)`);
    }
    const dupCount = configurations.filter((c) => c && typeof c === "object" && c !== cfg && c.name === "ros2").length;
    if (dupCount > 0) {
        raw.configurations = configurations.filter((c) => c === cfg || !(c && typeof c === "object" && c.name === "ros2"));
        claimChanged = true;
        log.warn(`c_cpp_properties.json:清理重复的 name=ros2 配置 ${dupCount} 个(保留最前一个接管)`);
    }
    if (raw.version === undefined) {
        raw.version = 4;
        claimChanged = true;
    }
    if (!Array.isArray(cfg.includePath)) {
        // includePath 键缺失/非数组:外科手术只补这一个字段 —— browse 等其余字段与既有键序原样保留
        // (2026-10-14 修"删 includePath 键 → 旧实现整体重建致 browse 陪葬+键序重排"案;JSON.parse 认 key)
        cfg.includePath = canonical;
        await writeFileAtomic(filename, JSON.stringify(raw, undefined, 2));
        log.info(`c_cpp_properties.json:includePath 键缺失/非数组,已补 ${canonical.length} 条(browse 等其余字段与键序原样保留)`);
        return;
    }
    // 重排:管辖条目规范序在前;管辖外额外条目按原顺序去重追加(不参与管辖顺序判断)
    // 历史残留 /usr/include 条目(上版生成器收录,现属编译器默认、不归管辖)→ 清除
    const canonicalSet = new Set(canonical);
    const ovKeys = overrideKeySet(overrides);
    const leftovers: string[] = [];
    const seen = new Set<string>();
    let usrRemoved = 0;
    let managedRemoved = 0; // 本工作区 install/build 派生的旧条目(旧布局/旧形状)→ 删除
    let ovRemoved = 0; // 替换表管辖条目旧形态(链末替换值已入 canonical/空值=删除)→ 不留队尾
    for (const e of cfg.includePath) {
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
        if (ovKeys.has(e)) {
            ovRemoved++; // 替换表管辖旧形态:命运由表定,不经"管辖外"通道回流
            continue;
        }
        if (!canonicalSet.has(e) && !seen.has(e)) {
            seen.add(e);
            leftovers.push(e);
        }
    }
    const newPath = [...canonical, ...leftovers];
    let pathChanged = false;
    if (newPath.length !== cfg.includePath.length || newPath.some((e, i) => e !== cfg.includePath[i])) {
        cfg.includePath = newPath;
        pathChanged = true;
    }
    // 字段补齐/升级已废除(2026-10-14 用户裁定:标准字段所有权归用户——compileCommands/cppStandard/cStandard
    // 一律不再补、不再升,补写只动 includePath;用户手写的 gnu++17 也不再被强翻 gnu++20)
    // 认领变更必须落盘(2026-10-15 用户实测"日志说改了,文件没改"案:追加/去重曾只改内存,
    // includePath 恰好无需变化时被"无变化"闸门吞掉)
    if (claimChanged || pathChanged) {
        await writeFileAtomic(filename, JSON.stringify(raw, undefined, 2));
        const parts: string[] = [];
        if (claimChanged) {
            parts.push("认领变更落盘(追加/清理重复 ros2 成员)");
        }
        if (pathChanged) {
            parts.push(`includePath 重排:管辖 ${canonical.length} 条 + 管辖外保留 ${leftovers.length} 条`);
            if (usrRemoved > 0) {
                parts.push(`清除 /usr/include 残留 ${usrRemoved} 条`);
            }
            if (managedRemoved > 0) {
                parts.push(`清除本工作区构建产物残留 ${managedRemoved} 条(布局/形状已变)`);
            }
            if (ovRemoved > 0) {
                parts.push(`清除替换表管辖旧形态 ${ovRemoved} 条`);
            }
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
    tpl: DistroPathTemplate = DEFAULT_PATH_TEMPLATE,
    overrides?: Record<string, string>
): Promise<void> {
    await enqueueSettingsWrite(workspaceRoot, () => syncPythonPathsInner(workspaceRoot, entries, envDirs, layout, tpl, overrides));
}

async function syncPythonPathsInner(workspaceRoot: string, entries: PackageEntry[], envDirs: string[], layout: InstallLayout, tpl: DistroPathTemplate, overrides?: Record<string, string>): Promise<void> {
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
    // 替换表(2026-10-14,python 键 `ide.entryOverrides.python`,双 extraPaths 两键同表):并集先链式解析至
    // 不动点(空值条目不落管辖集);整表写入,链末空值 = 不再管辖,
    // 旧条目由 syncKey 的替换表管辖分支清除(src 包根不是构建产物,不走既有 install/build 残留删除通道)。
    const rawMerged = Array.from(new Set([...pythonDirs, ...installDirs, ...developDirs, ...envDirs]));
    if (rawMerged.length === 0) {
        return;
    }
    const ovRes = applyEntryOverrides(rawMerged, overrides);
    const mergedDirs = ovRes.list;
    const ovKeys = overrideKeySet(overrides);
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
        // 2026-10-14:替换表管辖条目旧形态(链末替换值已入新集合/空值=删除)同样清除,不经"用户条目"通道回流
        let ovRemoved = 0;
        const leftover = cur.filter((e) => {
            if (inM.has(e) || isBuildArtifactEntry(e, workspaceRoot)) {
                return false;
            }
            if (ovKeys.has(e)) {
                ovRemoved++;
                return false;
            }
            return true;
        });
        const missing = mergedDirs.filter((e) => !cur.includes(e)); // 新收录(含新包/新 env 目录)
        const canonical = orderPythonExtraPaths([...managedCur, ...missing], pythonDirs);
        const desired = [...canonical, ...leftover];
        if (cur.length === desired.length && cur.every((e, i) => e === desired[i])) {
            log.debug(`${label} 无变化,不写`);
            return;
        }
        await cfg.update(key, desired, vscode.ConfigurationTarget.Workspace);
        const added = desired.length - cur.length;
        log.info(`${label} ${added > 0 ? `补充 ${added} 条并规范重排` : "规范重排"}后共 ${desired.length} 条${ovRemoved > 0 ? `(替换表管辖旧形态清除 ${ovRemoved} 条)` : ""}`);
    };
    await syncKey("python.autoComplete.extraPaths", "settings.json:python.autoComplete.extraPaths");
    await syncKey("python.analysis.extraPaths", "settings.json:python.analysis.extraPaths");
}

/* ================================================================== */
/* .clangd 分组注释标记(2026-10-14 L10N 化,用户裁定):双语表(en 源 + zh-cn),
 * 生成/接管重排按 UI 语言输出(normalizeCommentLang,复用 l10n/templates 的归一口径),
 * 匹配恒收【全语言全布局】变体 —— 任何语言写的文件在任何 UI 下都能识别;
 * zh-cn 文本与历史版本逐字节一致(存量中文标记文件的匹配依赖)。
 * ================================================================== */

/** 标记语言(与模板注释语种同口径) */
export type ClangdMarkerLang = "en" | "zh-cn";

/** zh-cn 标记文本(历史字节,勿改) */
const ZH_MARKERS = {
    flags: "# ---- 编译标志(与 include 无关) ----",
    ws: "# ---- 工作空间包 include(工作空间在前,-I) ----",
    install: (layout: InstallLayout): string => `# ---- 工作空间安装产物 include:${layout} install/${layout === "merged" ? "include" : "<pkg>/include"}(在后,-isystem) ----`,
    sys: "# ---- 环境前缀 include:发行版(在后,-isystem) ----",
};
/** en 标记文本(源语言) */
const EN_MARKERS = {
    flags: "# ---- Compile flags (unrelated to includes) ----",
    ws: "# ---- Workspace package includes (workspace first, -I) ----",
    install: (layout: InstallLayout): string => `# ---- Workspace install-product includes: ${layout} install/${layout === "merged" ? "include" : "<pkg>/include"} (-isystem, after) ----`,
    sys: "# ---- Environment prefix includes: distro (after, -isystem) ----",
};

export type ClangdMarkerId = "flags" | "ws" | "install" | "sys";

/** 取当前语言的标记文本(install 需传布局) */
export function clangdMarkerOf(id: ClangdMarkerId, lang: ClangdMarkerLang, layout: InstallLayout = "isolated"): string {
    const t = lang === "zh-cn" ? ZH_MARKERS : EN_MARKERS;
    return id === "install" ? t.install(layout) : t[id];
}

/** 全语言全布局标记变体(匹配用;dropOrphanedAddMarkers 与组定位都认它) */
const ALL_MARKER_VARIANTS: readonly string[] = [
    ZH_MARKERS.flags, ZH_MARKERS.ws, ZH_MARKERS.install("isolated"), ZH_MARKERS.install("merged"), ZH_MARKERS.sys,
    EN_MARKERS.flags, EN_MARKERS.ws, EN_MARKERS.install("isolated"), EN_MARKERS.install("merged"), EN_MARKERS.sys,
];

/** 当前 UI 语言 → 标记语言(zh* → zh-cn;未支持/缺省/无头无 env → en) */
export function currentMarkerLang(): ClangdMarkerLang {
    return normalizeCommentLang(typeof vscode.env?.language === "string" ? vscode.env.language : undefined);
}

/**
 * 接管排序设置键(2026-10-14 用户裁定:**默认 false 不接管**——重排会移动用户文件里的行,
 * 未经同意不做;开启后 block 形态同步做管辖行规范重排+重钉分组注释,用户行原序移到块尾,效果单向)。
 */
export const CLANGD_TIDY_SETTING = "ide.clangdTidy";

/** 接管开关当前值(缺省/非法 → 关) */
export function getClangdTidyEnabled(): boolean {
    return vscode.workspace.getConfiguration("ROS2").get<boolean>(CLANGD_TIDY_SETTING, false) === true;
}

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

/** 删除后清理:被删空的组,其注释标记行一并移除(防孤儿注释);识别全语言变体,其余不动。 */
function dropOrphanedAddMarkers(lines: string[]): string[] {
    return lines.filter((l, i) => {
        if (!ALL_MARKER_VARIANTS.includes(l.trim())) {
            return true;
        }
        for (let j = i + 1; j < lines.length; j++) {
            const n = lines[j];
            if (n.trim() === "") {
                return false; // 后接空行/文件尾 → 孤儿
            }
            if (ALL_MARKER_VARIANTS.includes(n.trim())) {
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

/** 接管重排的管辖行集(替换表解析后的四组 token) */
export interface ClangdTidyManaged {
    flags: string[];
    ws: string[];
    install: string[];
    sys: string[];
}

/**
 * 接管排序(纯函数,2026-10-14 用户裁定,受控推翻 2026-09-07"不整块重排"):
 * 把 Add 块重排为规范组序(标志→工作空间→安装→发行版),各组前重钉【当前语言】分组注释;
 * 管辖外行(用户自加条目/注释,不在 managed 任何组的 token)以原相对顺序移到块尾 ——
 * 与 cpp includePath"管辖外原序留队尾"、extraPaths"用户条目原序留队尾"同语义。
 * 标记行(全语言变体)与空行不带入(注释重钉);**缺失的管辖 token(文件里没有对应行的)按组
 * 生成规范行补入组尾**(2026-10-15 修正:重建只重排已有行,原本无人补缺失——用户实测 -std=c++20
 * 永久丢失);外行已承载的同名 token(如行内注释 "- -Wall # keep")跳过注入,防同 token 双写。
 * 已是规范形态 → 返回 null(调用方不写盘)。
 */
export function tidyClangdAddLines(
    lines: string[],
    addIdx: number,
    blockEnd: number,
    managed: ClangdTidyManaged,
    lang: ClangdMarkerLang,
    installLayout: InstallLayout
): string[] | null {
    const managedTokens = new Set([...managed.flags, ...managed.ws, ...managed.install, ...managed.sys]);
    const grouped: Record<"flags" | "ws" | "install" | "sys", string[]> = { flags: [], ws: [], install: [], sys: [] };
    const foreignRows: string[] = [];
    const foreignTokens = new Set<string>();
    const seen = new Set<string>();
    for (let i = addIdx + 1; i < blockEnd; i++) {
        const line = lines[i];
        const token = itemTokenOf(line);
        if (token === null) {
            if (!ALL_MARKER_VARIANTS.includes(line.trim()) && line.trim() !== "") {
                foreignRows.push(line); // 用户注释/无法解析的行:当外行保留(内容不丢)
            }
            continue; // 标记行与空行不带入(注释重钉)
        }
        if (!managedTokens.has(token)) {
            foreignRows.push(line); // 管辖外条目:原相对顺序,最后移到块尾
            foreignTokens.add(token);
            continue;
        }
        if (seen.has(token)) {
            continue; // 重复行折叠(归正后理论不剩,防御)
        }
        seen.add(token);
        if (managed.flags.includes(token)) {
            grouped.flags.push(line);
        } else if (managed.ws.includes(token)) {
            grouped.ws.push(line);
        } else if (managed.install.includes(token)) {
            grouped.install.push(line);
        } else {
            grouped.sys.push(line);
        }
    }
    // 缺失补入:组内缺席且外行也未承载的管辖 token,生成规范行(4 空格缩进)追加到组尾。
    // "外行承载"= 外行 token 与之相同,或以外行为首段(行内注释如 "- -Wall # keep")—— 以用户行
    // 原样保留为准,不再裸注入,防同语义双写。
    const carriedByForeign = (t: string): boolean => {
        if (foreignTokens.has(t)) {
            return true;
        }
        for (const ft of foreignTokens) {
            if (ft.startsWith(t + " ")) {
                return true;
            }
        }
        return false;
    };
    for (const id of ["flags", "ws", "install", "sys"] as const) {
        for (const t of managed[id]) {
            if (!seen.has(t) && !carriedByForeign(t)) {
                grouped[id].push("    - " + t);
            }
        }
    }
    const built = lines.slice(0, addIdx + 1); // Add: 行及之前原样
    const pushGroup = (id: "flags" | "ws" | "install" | "sys"): void => {
        if (grouped[id].length === 0) {
            return;
        }
        built.push("    " + clangdMarkerOf(id, lang, installLayout));
        built.push(...grouped[id]);
    };
    pushGroup("flags");
    pushGroup("ws");
    pushGroup("install");
    pushGroup("sys");
    built.push(...foreignRows);
    built.push(...lines.slice(blockEnd)); // Add 块之后原样
    for (let i = 0; i < built.length; i++) {
        if (built[i] !== lines[i]) {
            return built; // 有差异 → 新形态
        }
    }
    return built.length === lines.length ? null : built; // 逐行相同 → 无变化
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
export async function syncClangd(workspaceRoot: string, groups: { ws: string[]; install?: string[]; sys: string[] }, layout: InstallLayout = "isolated", overrides?: Record<string, string>): Promise<void> {
    // 2026-10-15 用户裁定"串行必须做":读-改-写整体入单飞链(per-root 串行,与 cpp 同链互斥)
    return enqueueSettingsWrite(workspaceRoot, () => syncClangdInner(workspaceRoot, groups, layout, overrides));
}

async function syncClangdInner(workspaceRoot: string, groups: { ws: string[]; install?: string[]; sys: string[] }, layout: InstallLayout, overrides?: Record<string, string>): Promise<void> {
    const filename = path.join(workspaceRoot, ".clangd");
    const dirs = await clangdGroupDirs(groups.ws, groups.install ?? [], groups.sys);
    // 替换表(2026-10-14,clangd 键 `ide.entryOverrides.clangd`,本文件专属):四组 token 各自链式解析至不动点
    // (组内位置保持);生成/行集/缺失补入均以解析后为准
    const ov = overrides ?? {};
    const ovKeys = overrideKeySet(ov);
    const wsTokens = applyEntryOverrides(dirs.ws.map((d) => `-I${d}`), ov).list;
    const installTokens = applyEntryOverrides(dirs.install.map((d) => `-isystem${d}`), ov).list;
    const sysTokens = applyEntryOverrides(dirs.sys.map((d) => `-isystem${d}`), ov).list;
    const mLang = currentMarkerLang(); // 标记语言(生成/重钉按 UI 语言;匹配恒收全语言变体)
    const tidyOn = getClangdTidyEnabled(); // 接管排序开关(默认关,用户裁定)
    const installMarker = clangdMarkerOf("install", mLang, layout);
    const flagsTokens = applyEntryOverrides([...CLANGD_FLAG_ENTRIES], ov).list;
    let text: string | undefined;
    try {
        text = await fsPromises.readFile(filename, "utf8");
    } catch {
        text = undefined; // 不存在 → 生成全新
    }
    if (text === undefined) {
        // 生成:block 风格 + CompileFlags.CompilationDatabase 子键 + 分组注释(当前 UI 语言)
        const lines = ["CompileFlags:", "  CompilationDatabase: build", "  Add:"];
        lines.push("    " + clangdMarkerOf("flags", mLang));
        for (const e of flagsTokens) {
            lines.push(`    - ${e}`);
        }
        if (wsTokens.length > 0) {
            lines.push("    " + clangdMarkerOf("ws", mLang));
            for (const e of wsTokens) {
                lines.push(`    - ${e}`);
            }
        }
        if (installTokens.length > 0) {
            lines.push("    " + clangdMarkerOf("install", mLang, layout));
            for (const e of installTokens) {
                lines.push(`    - ${e}`);
            }
        }
        if (sysTokens.length > 0) {
            lines.push("    " + clangdMarkerOf("sys", mLang));
            for (const e of sysTokens) {
                lines.push(`    - ${e}`);
            }
        }
        await writeFileAtomic(filename, lines.join("\n") + "\n");
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
            await writeFileAtomic(filename, text);
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
                await writeFileAtomic(filename, text);
                log.info(`.clangd:已更新(${changes.join(";")};无 Add 行,保守不处理)`);
            }
            return;
        }
        let blockEnd = findAddBlockEnd(lines, addIdx + 1);
        // ---- 管辖内破坏性归正:旧形态/错位/重复/旧父子并列行移除(不整块重排,管辖外条目原地保留) ----
        // 行集以【解析后】token 为准:替换值若保持 -I/-isystem 形态,同样算规范行;非路径替换值由下方
        // 替换表管辖分支原位收敛(下次同步按"非路径条目"不动)。
        const dirsOfTokens = (tokens: string[], flag: string): Set<string> => new Set(tokens.filter((t) => t.startsWith(flag)).map((t) => t.slice(flag.length)));
        const wsRowSet = dirsOfTokens(wsTokens, "-I");
        const installRowSet = dirsOfTokens(installTokens, "-isystem");
        const sysRowSet = dirsOfTokens(sysTokens, "-isystem");
        // 旧形态来源(2026-09-07 约定 B 层级收敛):env 父根 include 本身在新行集(只列子根)中永不出现,
        // 一律属"旧父行";工作空间 include 根下的子目录属"旧 ws 子行"。二者均无对应规范行 → 移除;
        // 其余非规范行 = 管辖外,原地保留。
        const envParentLegacy = new Set([...groups.sys, ...(groups.install ?? [])].filter((d) => !sysRowSet.has(d) && !installRowSet.has(d)));
        const isUnderWsRoot = (d: string): boolean => groups.ws.some((p) => d.startsWith(p + path.sep) || d.startsWith(p + "/"));
        const removalIdx: number[] = [];
        const seenCanonical = new Set<string>();
        const blockTokens = new Set<string>(); // 全块 token 预扫(替换撞车判定:值已有行 → 丢映射副本)
        for (let i = addIdx + 1; i < blockEnd; i++) {
            const t = itemTokenOf(lines[i]);
            if (t !== null) {
                blockTokens.add(t);
            }
        }
        let ovReplaced = 0; // 替换表原位收敛行数
        for (let i = addIdx + 1; i < blockEnd; i++) {
            const token = itemTokenOf(lines[i]);
            if (token === null) {
                continue;
            }
            // 替换表管辖行(2026-10-14):链式解析定命运 —— 原位替换(链末不动点,一次收敛)/
            // 空值·环 → 删行 / 替换值已有行 → 丢映射副本(撞车丢映射留原生)
            if (ovKeys.has(token)) {
                const r = resolveChain(token, ov);
                if (r.value === null || blockTokens.has(r.value)) {
                    removalIdx.push(i);
                } else {
                    lines[i] = lines[i].replace(token, r.value);
                    blockTokens.add(r.value);
                    seenCanonical.add(r.value); // 替换值若为路径形态则占住规范位(后续同值行按重复折叠)
                    ovReplaced++;
                }
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
            changes.push(`管辖归正移除 ${removalIdx.length} 行(旧形态/重复行/残留 /usr/include/替换表空值·环·撞车)`);
            changed = true;
            blockEnd = findAddBlockEnd(lines, addIdx + 1); // 行号已变,重算
        }
        if (ovReplaced > 0) {
            changes.push(`替换表原位收敛 ${ovReplaced} 行(链式至不动点)`);
            changed = true;
        }
        // ---- 接管排序(2026-10-14,ROS2.ide.clangdTidy 默认关):开 → tidy 重建整块(规范组序+重钉当前语言
        //      分组注释+用户行原序移尾),缺失的管辖 token 由重建**注入组尾**(2026-10-15 修正:重建只重排
        //      已有行,原注释"缺失补入天然覆盖"不成立——用户实测 -std=c++20 永久丢失),已规范零写盘;
        //      关 → 原路径(孤儿注释清理 + 组内插入),行为与接管前逐字节一致。 ----
        if (tidyOn) {
            const tidied = tidyClangdAddLines(lines, addIdx, blockEnd, { flags: flagsTokens, ws: wsTokens, install: installTokens, sys: sysTokens }, mLang, layout);
            if (tidied !== null) {
                lines.length = 0;
                lines.push(...tidied);
                changes.push("接管排序:Add 块规范重排+分组注释重钉(用户行原序移尾)");
                changed = true;
            }
        } else {
        // ---- 孤儿分组注释清理(2026-09-16):布局切换后"另一布局"的安装组注释会留下(其行已被上一步删掉),
        //      以及被删空的组注释。dropOrphanedAddMarkers 认全语言变体标记文本,
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
            const mFlags = mIdx(clangdMarkerOf("flags", mLang));
            const mWs = mIdx(clangdMarkerOf("ws", mLang));
            const mInstall = mIdx(installMarker);
            const mSys = mIdx(clangdMarkerOf("sys", mLang));
            const hasMarkers = mFlags >= 0 || mWs >= 0 || mInstall >= 0 || mSys >= 0;
            const ops: { at: number; add: string[] }[] = [];
            if (hasMarkers) {
                if (missingFlags.length > 0) {
                    ops.push({ at: mFlags >= 0 ? mFlags + 1 : addIdx + 1, add: missingFlags.map((e) => `    - ${e}`) });
                }
                if (missingWs.length > 0) {
                    const add: string[] = [];
                    if (mWs < 0) {
                        add.push("    " + clangdMarkerOf("ws", mLang));
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
                        add.push("    " + clangdMarkerOf("sys", mLang));
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
        } // else(接管关)
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
        await writeFileAtomic(filename, lines.join("\n"));
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
    return enqueueSettingsWrite(workspaceRoot, () => removeCppIncludesInner(workspaceRoot, entries));
}

async function removeCppIncludesInner(workspaceRoot: string, entries: string[]): Promise<number> {
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
            await writeFileAtomic(cppPath, JSON.stringify(raw, undefined, 2));
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
    return enqueueSettingsWrite(workspaceRoot, () => removeClangdIncludesInner(workspaceRoot, entries));
}

async function removeClangdIncludesInner(workspaceRoot: string, entries: string[]): Promise<number> {
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
            await writeFileAtomic(clangdPath, cleaned.join("\n"));
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
// 修改时间:2026-10-12(彻底移除 settings.json 三排除键写入(用户裁定:排除与否属个人工作区偏好,扩展不应触碰
// files.watcherExclude / search.exclude / python.analysis.exclude 三键任何形式):旧实现 ensureWorkspaceExcludeSettings
// 以"合并视图做底 + 整对象写回 Workspace"补三条 glob,实际把 VS Code 内置默认条目与全局层既有条目一并写进了
// 工作区 settings.json(issue #3 泄露清单整块即其产物);已写入用户文件的历史残留不主动清理——清理等同再写一次)
// 修改时间:2026-10-14(新增生成条目替换表三键(ide.entryOverrides.clangd/cpptools/python,同日由单一合并键
// 拆分——key 空间撞车须结构性排除+三文法不得混居一张表):syncCppProperties/syncClangd/syncPythonPaths 各收
// 本文件专属表(末位可选参 overrides,缺省 {} = 关闭);applyEntryOverrides 纯函数链式解析至不动点(单次同步
// 一步到位,环剔除+warn)+ 两遍法落位(原生优先占位、撞车丢映射副本留原生);cpp/clangd 文件侧旧形态行原位替换
// 或清除(不经"管辖外/用户条目"残留通道回流);【表盲红线】remove* 与预检三函数零改动、不感知任何一张表)
// 修改时间:2026-10-14(接管排序 ROS2.ide.clangdTidy(默认关,用户裁定"默认不接管,防止影响用户使用"):
// block 形态同步开 → 归正后 tidyClangdAddLines 纯函数重建 Add 块(管辖行规范组序 标志→ws→install→sys +
// 重钉当前语言分组注释 + 用户行/用户注释原序移尾;已规范零写盘,flow 不重排);受控推翻 2026-09-07"不整块重排"
// 裁定(仅设置开启时生效)。分组注释同步 L10N 化(用户点名):硬编码中文常量 → ZH/EN 双语表(zh 逐字节同历史,
// 存量匹配依赖),生成/重钉按 normalizeCommentLang(vscode.env.language) 输出,匹配恒收全语言全布局变体
// (跨语言文件照常识别);旧 ADD_* 常量退役)
// 修改时间:2026-10-14(标准字段收缩(用户裁定"极其克制"):freshRos2Config 缩为三键(name/includePath/compileCommands,browse·cppStandard·cStandard·intelliSenseMode·compilerPath 不再写);补写字段补齐/升级整段废除——compileCommands 不再补、cppStandard 不再强写也不再 gnu++17→gnu++20 强翻(用户手写 gnu++17 保留)、cStandard 不再补;CPP_DEFAULT_CPP_STANDARD 常量废除;标准字段所有权彻底移交用户,.clangd 的 -std=c++20 同性质缩减另案)
// 修改时间:2026-10-15(认领落盘+串行+原子写(用户裁定"原子性必须做,串行必须做"):①claimChanged 四处置位(建 configurations 数组/追加 ros2 成员/清理重复/补 version),正常路径写盘条件 claimChanged||pathChanged——修"日志说清理重复了,文件没改"案(认领只改内存,被 pathChanged 闸门吞);②syncCppProperties/syncClangd/removeCppIncludes/removeClangdIncludes 拆壳入 enqueueSettingsWrite 单飞链(per-root 串行);③writeFileAtomic(tmp+rename)替换 cpp/clangd 全部直接写)
