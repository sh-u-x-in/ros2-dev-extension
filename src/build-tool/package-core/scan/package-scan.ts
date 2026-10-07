// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-scan.ts
 * 统一工作区 package.xml 搜索接口(问题5 设计,收拢 #1~#6 六个搜索点)。
 *
 * 设计意图(2026-08-20):
 *  - 六个组件各自实现/调用"遍历工作区找 package.xml"(colcon scanIgnoredPackages / PackageMap
 *    scanPackages / rosmsg refreshPackageNames / debugger findPackageXmlFiles / launch-parser
 *    findFiles / vscode-utils workspaceContainsPackageXml),实现方式三套(findFiles / 自实现同步
 *    递归 / 自实现异步递归),排除口径、真包判定、超时/深度限制互不对齐——本文件收敛为单一入口。
 *  - 底层统一 walkWithTimeout(双超时 + maxDepth + excludedDirNames + followSymlinks=false,
 *    不跟随符号链接,天然规避问题4 的 ros2share 遍历爆炸)。
 *  - 搜索期排除 = 内置产物/依赖目录(默认) + buildExcludeFolders 配置路径(统一入口,见问题5 第八章)。
 *  - 真包判定对齐 colcon isValidPackageXml 口径(同目录构建文件 + 非空 name),见问题5 第五章。
 *
 * 2026-09-06(四项修复 §12.2/§12.6/§12.10):
 *  - 结果增 `ignoreMarkers`(标记集 M:扫描范围内含 COLCON_IGNORE 的目录,含非包目录)→
 *    祖先忽略(P2)与分类(overlap/ancestor/same-dir)的事实源;收集方式 = 第二趟轻量遍历
 *    COLCON_IGNORE(native 单模式加速器一次只出一个 pattern → 双趟,超时/深度同 package 画像);
 *  - **点目录对齐(§12.10-B)**:凡路径自 wsRoot 起任一段以 `.` 开头 → 不收录(与 colcon
 *    剪枝 `.` 开头子目录一致);在 scan 层过滤,不改通用 walk,不影响 test/message/xacro 消费方;
 *  - `PackageScanEntry.ignoredBy`(same-dir/ancestor/overlap)由 cache 层调用
 *    scan/ignore-classify.classifyEntries(池 × M)填写 —— 本层只出 raw + M,不二次判定。
 *
 * ✅ 接入状态(2026-08-22):已由 package-cache 调用 scanWorkspacePackages(问题5 批2 单一数据源)。
 */

import { l10n } from "vscode";

import * as path from "path";

// 统一从 walk 层导入(排除工具/配置/底层封装;walk 层由 index barrel 对外)
import {
    walkWithTimeout,
    WALK_FOLLOW_SYMLINKS_DEFAULT,
    getWalkTimeoutConfig,
    DEFAULT_EXCLUDED_DIR_NAMES,
    resolveExcludeFolders,
    isPathExcluded,
} from "../../walk";
import { getLogger } from "../../../logger";
// 目录级真包判定核心(读 package.xml + build_type 同类型校验,收敛 isValidPackageXml/buildEntry)
import { analyzePackageDir } from "./package-xml";

/** 统一搜索模块日志 */
const log = getLogger("package-scan");

// 内置产物/依赖目录统一排除(已提升至 walk/excluded-paths 共享,见该文件头注释);re-export 保持外部兼容
// (原定义含 logs/devel/.git 全量,与共享 DEFAULT_EXCLUDED_DIR_NAMES 一致)
export { DEFAULT_EXCLUDED_DIR_NAMES };

/** 忽略原因(ignore 域成员分类;undefined = 未忽略,即 visible/unignore 候选)——与 ignore-classify 共享 */
export type IgnoreReason = "same-dir" | "ancestor" | "overlap";

/** 统一搜索配置 */
export interface PackageScanOptions {
    /** 搜索根(工作区根) */
    workspaceRoot: string;
    /** buildExcludeFolders 配置(绝对/相对/${workspaceFolder}),合并进搜索期排除 */
    excludedFolders?: string[];
    /** 分支时长限制(毫秒),默认 = WALK_TIMEOUT_PROFILES.package.branchTimeoutMs(2000,独立且小于总超时) */
    branchTimeoutMs?: number;
    /** 总超时时长(毫秒),默认 = WALK_TIMEOUT_PROFILES.package.totalTimeoutMs(10000) */
    totalTimeoutMs?: number;
    /** 最大递归深度,默认 = WALK_TIMEOUT_PROFILES.package.maxDepth(8) */
    maxDepth?: number;
    /** 是否跟随符号链接,默认 = WALK_FOLLOW_SYMLINKS_DEFAULT(false,防共享目录遍历爆炸) */
    followSymlinks?: boolean;
}

/** 单个包目录的完整画像(一次遍历补齐,消费方按需取字段) */
export interface PackageScanEntry {
    /** package.xml 所在目录(绝对路径) */
    dir: string;
    /** package.xml <name>(读取失败为 undefined) */
    name?: string;
    /** package.xml <export><build_type>(未声明/读取失败为 undefined) */
    buildType?: string;
    /** 同目录有 COLCON_IGNORE(2026-09-06 起由 ignore-classify 按标记集派生:语义 = ignoredBy==="same-dir") */
    hasColconIgnore: boolean;
    /** 父目录名为 src */
    parentIsSrc: boolean;
    /** 合法包(build_type 同类型校验通过 && 非空 name,2026-08-22 全量收紧) */
    isValid: boolean;
    /**
     * 忽略原因(2026-09-06 §12.2,由 classifyEntries 填写;undefined = 未忽略 → visible(池)):
     * same-dir = 自身 COLCON_IGNORE;ancestor = 祖先 COLCON_IGNORE 遮蔽(整棵子树);
     * overlap = 位于合法包目录之下(嵌套重叠,colcon 包边界不下钻)。
     */
    ignoredBy?: IgnoreReason;
}

/** 统一搜索结果 */
export interface PackageScanResult {
    entries: PackageScanEntry[];
    /** 标记集 M(2026-09-06):扫描范围内含 COLCON_IGNORE 的目录(含非包目录),供祖先遮蔽分类 */
    ignoreMarkers: string[];
    timedOut: boolean;
    elapsedMs: number;
    visitedDirs: number;
}

/**
 * 路径是否落在"walk 会进入的扫描范围"之外(2026-09-06):
 *  - 相对路径任一段以 `.` 开头(点目录对齐,colcon 剪枝);或
 *  - 任一段命中内置产物目录名(任意层级);或
 *  - 位于 buildExcludeFolders 配置排除路径内。
 * 供 scan 过滤与事件层廉价预过滤共用(与 walk 实际行为同口径)。
 */
export function isDirScanExcluded(workspaceRoot: string, dir: string, excludedAbs: string[]): boolean {
    const rel = path.relative(workspaceRoot, path.normalize(dir));
    if (rel === "") {
        return false;
    }
    const segs = rel.split(/[\\/]+/);
    for (const s of segs) {
        if (s.startsWith(".")) {
            return true; // 点目录(colcon 剪枝;排除 .git/.hg/.svn 等默认名的超集)
        }
        if (DEFAULT_EXCLUDED_DIR_NAMES.includes(s)) {
            return true;
        }
    }
    return excludedAbs.length > 0 && isPathExcluded(path.normalize(dir), excludedAbs);
}

/** 读取单目录字段画像(自包含,不依赖 colcon-utils,避免接入时循环依赖) */
async function buildEntry(dir: string): Promise<PackageScanEntry> {
    // 真包判定核心:读 package.xml + build_type 同类型校验(复用 analyzePackageDir,消除与 isValidPackageXml 的重复)
    const analysis = await analyzePackageDir(dir);

    // 2026-09-06:COLCON_IGNORE 不再逐目录 access —— 单一事实源 = 标记集 M(ignoreMarkers),
    // hasColconIgnore/ignoredBy 由 cache 层 classifyEntries 统一派生,此处不设(避免双源漂移)
    const parentIsSrc = path.basename(path.dirname(dir)) === "src";
    if (!analysis.valid && analysis.reason) {
        log.warn(l10n.t("Invalid package: {0}: {1}", analysis.reason, dir));
    }

    return {
        dir,
        name: analysis.name,
        buildType: analysis.buildType,
        hasColconIgnore: false, // 占位:分类见 scan/ignore-classify
        parentIsSrc,
        isValid: analysis.valid,
    };
}

/**
 * 统一搜索工作区 package.xml(遍历一次补齐画像;另轻量遍历一次 COLCON_IGNORE 收集标记集 M)。
 * 搜索期排除:内置产物目录名(遍历期跳过)+ buildExcludeFolders 路径 + 点目录(isDirScanExcluded 过滤)。
 * 底层 walkWithTimeout:双超时 + maxDepth + 不跟随符号链接;超时返回已搜到的部分结果。
 */
export async function scanWorkspacePackages(options: PackageScanOptions): Promise<PackageScanResult> {
    const pkgCfg = getWalkTimeoutConfig("package");
    const {
        workspaceRoot,
        excludedFolders = [],
        totalTimeoutMs = pkgCfg.totalTimeoutMs,
        branchTimeoutMs = pkgCfg.branchTimeoutMs,
        maxDepth = pkgCfg.maxDepth,
        followSymlinks = WALK_FOLLOW_SYMLINKS_DEFAULT,
    } = options;
    const walkOpts = {
        branchTimeoutMs,
        totalTimeoutMs,
        maxDepth,
        excludedDirNames: new Set(DEFAULT_EXCLUDED_DIR_NAMES),
        followSymlinks,
    };
    const result = await walkWithTimeout(workspaceRoot, "package.xml", walkOpts);
    // 标记集 M:第二趟轻量遍历(§12.6/12.7 选项②:纯 TS 跑 COLCON_IGNORE;native 单模式一次一个 pattern)
    const markerResult = await walkWithTimeout(workspaceRoot, "COLCON_IGNORE", walkOpts);

    // buildExcludeFolders 路径级排除(绝对路径,walk 目录名排除无法表达任意路径 → 此处过滤)
    const excludedAbs = resolveExcludeFolders(workspaceRoot, excludedFolders);

    const entries: PackageScanEntry[] = [];
    for (const p of result.matches) {
        const dir = path.normalize(path.dirname(p));
        if (isDirScanExcluded(workspaceRoot, dir, excludedAbs)) {
            continue;
        }
        entries.push(await buildEntry(dir));
    }

    // 标记集 M(与 entries 同口径排除;含非包目录,供祖先遮蔽分类)
    const ignoreMarkers: string[] = [];
    {
        const seen = new Set<string>();
        for (const p of markerResult.matches) {
            const dir = path.normalize(path.dirname(p));
            if (isDirScanExcluded(workspaceRoot, dir, excludedAbs)) {
                continue;
            }
            if (!seen.has(dir)) {
                seen.add(dir);
                ignoreMarkers.push(dir);
            }
        }
        ignoreMarkers.sort();
    }

    const timedOut = result.timedOut || markerResult.timedOut;
    if (timedOut) {
        log.warn(l10n.t("Unified package scan timed out ({0} ms); returning partial results: {1} packages ({2} markers)", totalTimeoutMs, entries.length, ignoreMarkers.length));
    }
    log.debug(l10n.t("Unified package scan completed: {0} packages (markers={1}, timedOut={2}, dirs={3})", entries.length, ignoreMarkers.length, timedOut, result.visitedDirs));
    return {
        entries,
        ignoreMarkers,
        timedOut,
        elapsedMs: result.elapsedMs + markerResult.elapsedMs,
        visitedDirs: result.visitedDirs,
    };
}

/** 便捷派生:合法包列表(isValid,2026-08-22 起 build_type 同类型校验) */
export function toValidEntries(entries: PackageScanEntry[]): PackageScanEntry[] {
    return entries.filter((e) => e.isValid);
}

/** 便捷派生:被忽略的包(合法包中 ignoredBy 非空;2026-09-06 起覆盖同目录/祖先/重叠) */
export function toIgnoredEntries(entries: PackageScanEntry[]): PackageScanEntry[] {
    return entries.filter((e) => e.isValid && !!e.ignoredBy);
}

/** 便捷派生:父目录为 src 的包(rosmsg 合法路径判定) */
export function toSrcEntries(entries: PackageScanEntry[]): PackageScanEntry[] {
    return entries.filter((e) => e.parentIsSrc);
}
