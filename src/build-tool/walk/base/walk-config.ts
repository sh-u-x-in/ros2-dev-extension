// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file walk-config.ts
 * walk 搜索超时/深度配置(按搜索类型分组,单一出处,2026-08-21)。
 *
 * 语义:分支超时(branchTimeoutMs)与总超时(totalTimeoutMs)【必须独立且分支 < 总】,
 * 否则分支截断形同虚设(双超时退化为单超时)。各搜索点按自身场景(文件量/目录数)选型:
 *  - test:测试发现用正则匹配、命中文件多(尤其 C++),总/分支都调高、深度加大;
 *  - message/xacro/package:文件量中等,用通用配置;
 *  - default:兜底。
 * 纯常量、零依赖(不依赖 vscode),可被任意模块导入。超时/深度全部由此配置驱动,代码不硬编码。
 */

/** 搜索类型标识(各调用点按自身场景选用) */
export type WalkSearchType = "default" | "message" | "test" | "xacro" | "package";

/** 单类搜索的 walk 超时/深度配置 */
export interface WalkTimeoutConfig {
    /** 总超时(毫秒):整个搜索预算,兜底。 */
    totalTimeoutMs: number;
    /** 分支超时(毫秒):单目录(分支)预算,必须明显小于 totalTimeoutMs 才具分支截断意义。 */
    branchTimeoutMs: number;
    /** 最大递归深度(0=仅根目录文件)。 */
    maxDepth: number;
}

/**
 * 按搜索类型分组的超时/深度配置(数组形式,默认值在此统一声明)。
 * 通用(default/message/xacro/package):总 10s / 分支 2s / 8 层;
 * 测试(test):总 30s / 分支 5s / 12 层(正则命中文件多,调高预算)。
 */
export const WALK_TIMEOUT_PROFILES: ReadonlyArray<{ type: WalkSearchType } & WalkTimeoutConfig> = [
    { type: "default", totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8 },
    { type: "message", totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8 },
    { type: "xacro",   totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8 },
    { type: "package", totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8 },
    { type: "test",    totalTimeoutMs: 30000, branchTimeoutMs: 5000, maxDepth: 12 },
];

/** 用户设置中的单类覆盖(字段缺失 = 用内置默认;来自 ROS2.search.walkTimeouts) */
export type WalkTimeoutOverride = Partial<WalkTimeoutConfig> & { type: WalkSearchType };

/** 合理性保护:非法(非有限数/负数)覆盖值回退默认 */
function positiveOr(v: number | undefined, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * 取某类搜索的超时/深度配置(纯函数,零依赖,始终有值;未知名回退 default)。
 * @param overrides 用户设置覆盖(可选),按 type 匹配;字段缺失或非法时用内置默认。
 */
export function getWalkTimeoutConfig(
    type: WalkSearchType,
    overrides?: ReadonlyArray<WalkTimeoutOverride>,
): WalkTimeoutConfig {
    const def = WALK_TIMEOUT_PROFILES.find((p) => p.type === type) ?? WALK_TIMEOUT_PROFILES[0];
    const o = overrides?.find((p) => p.type === type);
    if (!o) {
        return def;
    }
    return {
        totalTimeoutMs: positiveOr(o.totalTimeoutMs, def.totalTimeoutMs),
        branchTimeoutMs: positiveOr(o.branchTimeoutMs, def.branchTimeoutMs),
        maxDepth: positiveOr(o.maxDepth, def.maxDepth),
    };
}
