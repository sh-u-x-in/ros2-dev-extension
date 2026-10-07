// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ts-walk.ts
 * 纯 TS 超时递归搜索实现(自包含,不依赖 native,不依赖 vscode.workspace.findFiles)。
 * 语义与 native(walk-native)对齐:
 *  - DFS 深度优先;进入每个子目录前"冻结"时间,每处理一个文件/子目录前检查全局截止时间;
 *  - 叠加时间:全程共用同一个 deadline = start + timeLimitMs,时间累积;
 *  - 分支级超时截断:某分支(文件搜索或子目录)耗时超过【分支时长限制】→ 截断该分支,回溯到父层
 *    继续处理尚未处理的兄弟分支,而不是整体放弃——保证尽量返回已搜到的部分结果;
 *  - 双超时(2026-08-20 用户定稿):
 *    分支时长限制(branchTimeoutMs):单个目录(分支)处理超时 → 截断该分支,父层继续兄弟;
 *    总超时时长(totalTimeoutMs):整个搜索超时 → 整体结束,返回已搜到的部分结果;
 *  - 辅助:深度限制(maxDepth);
 *  - 目录名排除(excludedDirNames,如 build/install/log)在遍历时提前跳过;
 *  - 符号链接:默认不跟随(followSymlinks=false),防共享目录(ros2share)遍历爆炸;可配置跟随。
 *
 * 接口:native 与纯 TS 完全一致——walkWithTimeout(root, pattern, options) → WalkResult(含 loopSkipped)。
 * 转接层:walk-utils.ts 负责 native 优先 / 缺失或加载失败时降级本实现。
 */

import { l10n } from "vscode";


import * as fs from "fs";
import * as path from "path";

import { getLogger } from "../../../logger";

/** 纯 TS 遍历模块日志(默认 trace,遍历热路径避免刷屏) */
const log = getLogger("ts-walk");

/** 遍历配置 */
export interface WalkOptions {
    /** 分支时长限制(毫秒):单个目录(分支)处理超过该时长 → 截断该分支,回溯父层继续兄弟。
     *  必须独立且小于 totalTimeoutMs(见 walk-config.ts)——若等于总超时则分支截断形同虚设。 */
    branchTimeoutMs: number;
    /** 总超时时长(毫秒):整个搜索超过该时长 → 整体结束,返回已搜到的部分结果。 */
    totalTimeoutMs: number;
    /** 最大递归深度(0 = 只扫描根目录下的文件,不进入任何子目录;1 = 进入一层)。 */
    maxDepth: number;
    /** 按目录名提前排除(如 build/install/log/node_modules/.git),只匹配当前层条目名。 */
    excludedDirNames?: ReadonlySet<string>;
    /** 是否跟随符号链接目录(默认 false,防共享目录遍历爆炸)。 */
    followSymlinks?: boolean;
}

/** 遍历结果(native 与纯 TS 接口一致,外部调用方无需区分路径) */
export interface WalkResult {
    /** 匹配的文件绝对路径(按遍历顺序;超时截断后为"已搜到的部分结果") */
    matches: string[];
    /** 是否发生过超时截断(结果可能不完整) */
    timedOut: boolean;
    /** 实际耗时(毫秒) */
    elapsedMs: number;
    /** 访问过的目录数 */
    visitedDirs: number;
    /** 环检测跳过的目录数(纯 TS 无环检测,恒 0;native 透传真实值,接口对齐用) */
    loopSkipped: number;
}

/** 文件匹配模式:精确文件名 | 正则。
 *  设计决策(2026-08-20 用户定稿):只暴露声明式 pattern,不用逐文件回调——
 *  回调频率高(每文件一次跨调用)影响性能,且不利于底层(Rust/C)重写时把匹配逻辑下放。 */
export type FilePattern = string | RegExp;

/** 归一化 FilePattern 为内部 (name)=>boolean(匹配在遍历器内部,不回调外部) */
function toMatcher(p: FilePattern): (name: string) => boolean {
    if (p instanceof RegExp) {
        // 去掉 g/y 标志,避免 lastIndex 状态化导致跨文件误判
        const re = (p.global || p.sticky) ? new RegExp(p.source, p.flags.replace(/[gy]/g, "")) : p;
        return (name) => re.test(name);
    }
    return (name) => name === p;
}

/**
 * 递归搜索:对每个文件按声明式 pattern 匹配,命中则收集其绝对路径。
 * pattern 支持:精确文件名(如 "package.xml") / 正则(如 /\.xml$/i)。
 * 匹配在遍历器内部完成(无逐文件回调)。双超时语义:
 *  - 分支时长限制:单目录超时 → 截断该分支,父层继续兄弟;
 *  - 总超时时长:整个搜索超时 → 整体结束,返回已搜到的部分结果。
 *
 * @param root        搜索根目录
 * @param pattern     文件名匹配:精确字符串 | RegExp
 * @param options     分支/总超时 + 深度/排除/符号链接配置
 */
export async function walkWithTimeout(
    root: string,
    pattern: FilePattern,
    options: WalkOptions,
): Promise<WalkResult> {
    const matcher = toMatcher(pattern);
    const globalStart = Date.now();
    const globalDeadline = globalStart + options.totalTimeoutMs; // 总超时:全局截止
    const matches: string[] = [];
    let visitedDirs = 0;
    let timedOut = false;
    let stopped = false; // 总超时后的整体停止标志(传播到所有层级)

    const walk = async (dir: string, depth: number): Promise<void> => {
        // 总超时优先:已整体停止或已到总时长 → 整体结束
        if (stopped) {
            return;
        }
        if (Date.now() > globalDeadline) {
            stopped = true;
            timedOut = true;
            return;
        }
        // 深度限制(辅助):超限不深入
        if (depth > options.maxDepth) {
            return;
        }
        visitedDirs++;
        // 【分支独立计时】进入本目录的时刻;后续条目/子目录用其检查 分支时长限制
        const branchStart = Date.now();
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (e) {
            log.trace(l10n.t("ts-walk: directory inaccessible; skipping: {0} ({1})", dir, e instanceof Error ? e.message : String(e)));
            return; // 不可访问(权限/已删):跳过该目录
        }

        // 第一阶段:搜索本目录下的文件(用户语义:先搜完文件,再进子目录)
        for (const entry of entries) {
            // 总超时:整体结束
            if (Date.now() > globalDeadline) {
                stopped = true;
                timedOut = true;
                return;
            }
            // 分支超时:本目录处理超过分支时长限制 → 截断本分支(父层继续兄弟)
            if (Date.now() - branchStart > options.branchTimeoutMs) {
                timedOut = true;
                return;
            }
            if (!entry.isFile()) {
                continue;
            }
            if (matcher(entry.name)) {
                matches.push(path.join(dir, entry.name));
            }
        }

        // 第二阶段:递归子目录
        for (const entry of entries) {
            // 子分支已触发总超时 → 整体停(传播)
            if (stopped) {
                return;
            }
            if (Date.now() > globalDeadline) {
                stopped = true;
                timedOut = true;
                return;
            }
            // 分支超时:本目录处理超过分支时长限制 → 截断剩余兄弟(父层继续)
            if (Date.now() - branchStart > options.branchTimeoutMs) {
                timedOut = true;
                return;
            }
            if (!entry.isDirectory()) {
                continue;
            }
            if (options.excludedDirNames?.has(entry.name)) {
                continue; // 目录名排除(如 build/install/log)
            }
            if (entry.isSymbolicLink() && !options.followSymlinks) {
                continue; // 符号链接:默认不跟随
            }
            await walk(path.join(dir, entry.name), depth + 1);
        }
    };

    await walk(root, 0);
    // 接口对齐:纯 TS 无环检测,loopSkipped 恒 0(native 与降级返回结构一致,外部无需区分)
    return { matches, timedOut, elapsedMs: Date.now() - globalStart, visitedDirs, loopSkipped: 0 };
}
