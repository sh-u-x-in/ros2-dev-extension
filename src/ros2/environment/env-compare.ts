// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file env-compare.ts
 * 环境快照比较(2026-09-15 环境体系重设计;纯函数,可无头单测)。
 *
 * 两个判定:
 *  1. snapshotChanged —— 完整快照是否变化(决定是否写入 env);
 *  2. externalChanged —— "外部环境"是否变化(决定是否触发环境变化事件)。
 *
 * 外部判定规则(与设计稿一致):
 *  - 逐变量做"工作空间路径剔除 + 折叠",得到:
 *      ext  = 剔除工作空间条目后的外部条目序列(顺序保留);
 *      gaps = 外部条目各边界上"是否存在工作空间条目段"的布尔序列(长度恒为 ext.length + 1);
 *  - 顺序敏感:工作空间条目内部的顺序不敏感、条目增删不敏感,但"工作空间条目相对外部条目
 *    的位置"敏感(块被外部条目分裂、或工作空间/外部相对次序翻转 => 视为变化);
 *  - 归一化:工作空间条目"仅出现在最前"(gaps[0] 为真且其余全假)与"完全不存在"等价
 *    ——工作空间首次构建/未构建两态不视为外部变化;
 *  - 纯工作空间变量(剔除后外部条目为空)视为"不存在"(与"无此变量"等价);
 *  - shell 状态键(PWD/OLDPWD/SHLVL/_/BASH_EXECUTION_STRING)不参与比较。
 *
 * 注意(2026-09-22 平台无关化):工作空间条目的识别 = 值条目等于工作空间根,或位于其目录树内
 * (值条目级前缀匹配,加分隔符防止前缀误伤)。比较前**归一化**:
 *   · 分隔符统一为正斜杠(Windows 环境条目是反斜杠);
 *   · 去掉尾部斜杠(保留根 "/");
 *   · Windows 上大小写不敏感(与文件系统一致)。
 * 路径型变量的拆分同样改用 `path.delimiter`(POSIX ":" / Windows ";")。
 */

import * as path from "path";

/** 不参与比较的 shell 状态键(每次采集都可能变化的运行态) */
export const SHELL_STATE_KEYS: readonly string[] = [
    "PWD", "OLDPWD", "SHLVL", "_", "BASH_EXECUTION_STRING",
];

/**
 * 比较用归一化:分隔符 → 正斜杠;去尾部斜杠(根 "/" 除外);Windows 转小写。
 * (纯函数,无 IO;同一函数同时服务 `isWorkspaceEntry` 与 `build-env` 的剔除判定。)
 */
export function normalizePathForCompare(p: string): string {
    let s = p.replace(/\\/g, "/");
    if (s.length > 1) {
        s = s.replace(/\/+$/, "");
    }
    return process.platform === "win32" ? s.toLowerCase() : s;
}

/** 值条目是否属于工作空间(等于工作空间根,或位于其目录树内;平台无关) */
export function isWorkspaceEntry(entry: string, workspaceRoot: string): boolean {
    if (workspaceRoot.length === 0) {
        return false;
    }
    const root = normalizePathForCompare(workspaceRoot);
    if (root.length === 0) {
        return false;
    }
    const prefix = root.endsWith("/") ? root : root + "/";
    const e = normalizePathForCompare(entry);
    return e === root || e.startsWith(prefix);
}

/** 单个变量"路径剔除 + 折叠"的结果 */
export interface ValueShape {
    /** 外部条目序列(顺序保留;空字符串条目保真,不过滤) */
    ext: string[];
    /** 外部条目边界上的工作空间段存在性(长度 = ext.length + 1) */
    gaps: boolean[];
}

/** 做一个变量的"路径剔除 + 折叠"(按平台分隔符 split,保真空元素) */
export function valueShape(value: string, workspaceRoot: string): ValueShape {
    const parts = value.split(path.delimiter);
    const ext: string[] = [];
    const gaps: boolean[] = [false];
    for (const p of parts) {
        if (isWorkspaceEntry(p, workspaceRoot)) {
            gaps[ext.length] = true;
        } else {
            ext.push(p);
            gaps.push(false);
        }
    }
    return { ext, gaps };
}

/**
 * 顺序指纹(null = 变量视为不存在)。
 * 归一化:"工作空间条目仅出现在最前" 等价于 "完全不存在"(与首次构建两态对齐)。
 */
export function fingerprint(value: string, workspaceRoot: string): string | null {
    const { ext, gaps } = valueShape(value, workspaceRoot);
    if (ext.length === 0) {
        return null; // 纯工作空间变量 => 视为不存在
    }
    const normalized = gaps[0] && gaps.slice(1).every((g) => !g)
        ? gaps.map(() => false)
        : gaps;
    return JSON.stringify([ext, normalized]);
}

/**
 * "外部环境"是否变化:逐键比较顺序指纹(含"存在性"——null 与非 null 判为变化)。
 * 首轮(prev/next 缺失)视为变化。
 */
export function externalChanged(prev: unknown, next: unknown, workspaceRoot: string): boolean {
    if (prev === undefined || next === undefined) {
        return true;
    }
    const a = prev as Record<string, unknown>;
    const b = next as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        if (SHELL_STATE_KEYS.includes(k)) {
            continue;
        }
        const fa = typeof a[k] === "string" ? fingerprint(a[k] as string, workspaceRoot) : null;
        const fb = typeof b[k] === "string" ? fingerprint(b[k] as string, workspaceRoot) : null;
        if (fa !== fb) {
            return true;
        }
    }
    return false;
}

/**
 * 完整快照是否变化(逐键严格比较;仅排除 shell 状态键)。
 * 用于决定是否把新快照写入 env(工作空间引起的条目变化也写入,但不触发外部事件)。
 */
export function snapshotChanged(prev: unknown, next: unknown): boolean {
    if (prev === undefined || next === undefined) {
        return true;
    }
    const a = prev as Record<string, unknown>;
    const b = next as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        if (SHELL_STATE_KEYS.includes(k)) {
            continue;
        }
        if (a[k] !== b[k]) {
            return true;
        }
    }
    return false;
}
