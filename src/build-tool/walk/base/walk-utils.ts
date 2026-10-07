// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file walk-utils.ts
 * 超时递归搜索转接层:优先 native(walk-native,节点级动态队列并行,worker=CPU核),
 * 缺失/加载失败降级纯 TS(ts-walk.ts)。对外接口两条路径完全一致:
 * walkWithTimeout(root, pattern, options) → WalkResult(含 loopSkipped)。
 * 双超时:branchTimeoutMs(分支截断) + totalTimeoutMs(总结束),native 与纯 TS 均实现。
 * 纯 TS 实现与设计语义见 ./ts-walk.ts;
 * 设计语义/先例/性能剖析详见 问题/新问题/问题4-findFiles符号链接遍历爆炸与超时保护.md。
 */

import { l10n } from "vscode";


import * as fs from "fs";
import * as path from "path";

import { walkWithTimeout as tsWalkWithTimeout } from "./ts-walk";
import type { WalkOptions, WalkResult, FilePattern } from "./ts-walk";
import { getLogger } from "../../../logger";
export type { WalkOptions, WalkResult, FilePattern } from "./ts-walk";

/** walk 转接层模块日志 */
const log = getLogger("walk");

/**
 * 符号跟随默认(与 package.json ROS2.search.followSymlinks 声明一致)。
 * 注:walk 超时(total/branch)与深度已独立到 walk-config.ts(按搜索类型分组,单一出处),
 * 不在此定义,避免与本常量混淆。
 */
export const WALK_FOLLOW_SYMLINKS_DEFAULT = false;   // 符号跟随默认

/**
 * 原生加速模块(napi-rs 编译的 walk-native.node,可选):
 * 存在时 walkWithTimeout 转发给节点级动态队列并行实现(2026-08-20 实测相对纯 TS ~5.6×),
 * 缺失/加载失败时降级为纯 TS 实现。
 */
interface NativeWalkOptions {
    branchTimeoutMs: number;
    totalTimeoutMs: number;
    maxDepth: number;
    excludedDirNames?: string[];
    followSymlinks?: boolean;
}

interface NativeWalkResult {
    matches: string[];
    timedOut: boolean;
    elapsedMs: number;
    visitedDirs: number;
    loopSkipped: number;
}

type NativeWalkFn = (
    root: string,
    patternType: "exact" | "regex",
    pattern: string,
    opts: NativeWalkOptions,
) => NativeWalkResult;

/** 按当前平台/架构选择原生模块文件名(多平台构建产物,2026-08-20) */
function nativeModuleFileName(): string {
    const p = process.platform;
    const a = process.arch;
    if (p === "win32") {
        return a === "arm64" ? "walk-native.win32-arm64-msvc.node" : "walk-native.win32-x64-msvc.node";
    }
    if (p === "darwin") {
        return a === "arm64" ? "walk-native.darwin-arm64.node" : "walk-native.darwin-x64.node";
    }
    // linux
    return a === "arm64" ? "walk-native.linux-arm64-gnu.node" : "walk-native.linux-x64-gnu.node";
}

/** 原生模块候选路径(webpack dist / tsc out 两种布局) */
function resolveNativeModulePath(): string {
    const fileName = nativeModuleFileName();
    const candidates = [
        path.join(__dirname, "..", "native", fileName), // webpack: dist → 扩展根/native
        path.join(__dirname, "..", "..", "..", "..", "native", fileName), // tsc: out/src/build-tool/walk → 扩展根/native
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return candidates[0]; // 均不存在则返回默认,require 抛错由上层 catch 兜底降级
}

let nativeWalk: NativeWalkFn | undefined;
// 环境变量 RDE_ROS2_WALK_NO_NATIVE=1 时禁用原生加速(纯 TS 基准对比/排查用)
if (process.env.RDE_ROS2_WALK_NO_NATIVE !== "1") {
    try {
        // webpackIgnore: 动态路径 require,webpack 跳过分析(不打包 .node)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nativeMod: { walkWithTimeout?: NativeWalkFn } = require(/* webpackIgnore: true */ resolveNativeModulePath());
        if (typeof nativeMod.walkWithTimeout === "function") {
            nativeWalk = nativeMod.walkWithTimeout;
        }
    } catch (e) {
        nativeWalk = undefined; // 原生模块缺失/加载失败 → 降级纯 TS
        log.warn(l10n.t("walk: native module failed to load; falling back to pure TS: {0}", e instanceof Error ? e.message : String(e)));
    }
}

/**
 * 递归搜索:优先 native(自动多线程,分支级截断+总硬停+看门狗+环检测),缺失/加载失败降级纯 TS。
 * pattern:精确文件名(如 "package.xml") / 正则(如 /\.xml$/i);
 * options:时间/深度/排除/符号链接。返回结构(native 与降级)完全一致。
 */
export async function walkWithTimeout(
    root: string,
    pattern: FilePattern,
    options: WalkOptions,
): Promise<WalkResult> {
    // 分支超时由调用点按类型显式传(见 walk-config.ts,分支必须独立且小于总超时);
    // 此处不做"分支=总"的隐式归一化——那是退化语义,会使分支截断形同虚设。
    // 原生加速(可选):节点级动态队列并行,同步返回;缺失时降级纯 TS
    if (nativeWalk) {
        const patternType: "exact" | "regex" = pattern instanceof RegExp ? "regex" : "exact";
        // JS 正则 flags 中 i(忽略大小写)需转为 Rust 内联 (?i);g/y 对 Rust 无意义,忽略
        //
        // ⚠️ 语义注意(2026-08-21):
        //  1. `(?i)` 前置 = 从该位置到末尾全局忽略大小写,与 JS `/xxx/i` 的全局 i 语义等价,不会错位;
        //     且 JS 正则不支持内联 flag(?(?i) 是 PCRE 语法),source 内部不会出现 (?i)/(?-i) 造成作用域冲突。
        //  2. 【Unicode 模式差异】JS 正则默认【非 Unicode】(无 u flag),而 Rust regex 默认【Unicode】:
        //     \w \d \s . 及 [a-z]+i 等元字符在两端语义不同(ASCII vs Unicode 折叠)。当前只转 i、未转 u。
        //     若匹配目标含非 ASCII(中文/é 等),Rust 会多匹配、JS 会少匹配 —— 这是真正可能"语义错位"的点。
        //  3. 【预留预告】未来 test-provider 改用 walk 时,会用正则匹配 "*_test"、"*Test" 等 C++/Python
        //     测试文件名模式(如 /test_.*\.py/ /.*_test\.cpp/ /.*Test\.cpp/)。这些模式当前全 ASCII,
        //     不受上述 Unicode 差异影响;但若引入含 \w 且目标含非 ASCII 的模式,务必复核两端语义。
        const patternSource = pattern instanceof RegExp
            ? (pattern.flags.includes("i") ? `(?i)${pattern.source}` : pattern.source)
            : pattern;
        const r = nativeWalk(root, patternType, patternSource, {
            branchTimeoutMs: options.branchTimeoutMs,
            totalTimeoutMs: options.totalTimeoutMs,
            maxDepth: options.maxDepth,
            excludedDirNames: options.excludedDirNames ? Array.from(options.excludedDirNames) : undefined,
            followSymlinks: options.followSymlinks,
        });
        return {
            matches: r.matches,
            timedOut: r.timedOut,
            elapsedMs: r.elapsedMs,
            visitedDirs: r.visitedDirs,
            loopSkipped: r.loopSkipped, // 接口对齐:透传 native 环检测跳过数
        };
    }
    // 降级:纯 TS 实现(ts-walk.ts,接口一致)
    return tsWalkWithTimeout(root, pattern, options);
}
