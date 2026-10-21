// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file walk-options.ts
 * walk 统一入口(封装之上的封装,2026-08-30)。
 *
 * 定位:walk/base/ 的原封装(walk-utils → ts-walk / walk-config / path-exclude / excluded-paths)零 vscode 依赖;
 * 本文件是【二次封装】——逻辑简单(读设置 + 组装 WalkOptions),直接依赖 vscode 读设置,
 * 不做注入隔离(二次封装逻辑简单,原封装无问题即默认其无问题)。
 * 依赖方向:二次封装(walk-options) → vscode(第三方) + 原封装(walk 内部);不依赖任何上层模块。
 *
 * 解决的问题:各调用方(languages/test-provider)此前各自读设置 + 组装 5 字段 options,样板重复;
 * 统一后读设置仅此处一处,调用方只需 walkOptions(type) 或叠加额外排除。
 */

import * as vscode from "vscode";
import { getWalkTimeoutConfig } from "./base/walk-config";
import type { WalkSearchType, WalkTimeoutConfig } from "./base/walk-config";
import { WALK_FOLLOW_SYMLINKS_DEFAULT } from "./base/walk-utils";
import { DEFAULT_EXCLUDED_DIR_NAMES } from "./base/excluded-paths";
import type { WalkOptions } from "./base/ts-walk";

/** 读符号跟随设置(ROS2.search.followSymlinks,默认 WALK_FOLLOW_SYMLINKS_DEFAULT) */
function readFollowSymlinksSetting(): boolean {
    return vscode.workspace.getConfiguration("ROS2").get<boolean>("search.followSymlinks", WALK_FOLLOW_SYMLINKS_DEFAULT) === true;
}

/** 各字段的下限(2026-10-18 平铺批:总/分支超时禁 0——0 = 立即超时 footgun;深度 0 = 仅根目录,合法) */
const FIELD_MINIMUMS: Record<keyof WalkTimeoutConfig, number> = { totalTimeoutMs: 1, branchTimeoutMs: 1, maxDepth: 0 };

/**
 * 读某类搜索的超时/深度配置(2026-10-18 平铺批,自 vscode-utils 迁入以兑现"读设置仅此处一处"):
 * 12 键 `ROS2.search.walkTimeout.<type>.<field>` 逐字段现读,非法(非有限数/低于下限)回落内置默认
 * (walk-config profiles 表,亦即 manifest default 同源值);设置变化即时生效(每次现读,无缓存)。
 * 消费方:walkOptions(本文件)+ package-core 链(extension.ts 经此导入)。
 */
export function readWalkTimeoutConfig(type: WalkSearchType): WalkTimeoutConfig {
    const def = getWalkTimeoutConfig(type);
    const cfg = vscode.workspace.getConfiguration("ROS2");
    const field = (name: keyof WalkTimeoutConfig): number => {
        const raw = cfg.get<unknown>(`search.walkTimeout.${type}.${name}`);
        const minimum = FIELD_MINIMUMS[name];
        return typeof raw === "number" && Number.isFinite(raw) && raw >= minimum ? raw : def[name];
    };
    return {
        totalTimeoutMs: field("totalTimeoutMs"),
        branchTimeoutMs: field("branchTimeoutMs"),
        maxDepth: field("maxDepth"),
    };
}

/** walkOptions 的调用方叠加项(全部可选:当前调用方无额外需求时可不传) */
export interface WalkOptionsExtra {
    /** 调用方额外排除的目录名(叠加进基础排除 DEFAULT_EXCLUDED_DIR_NAMES,并集) */
    excludedDirNames?: Iterable<string>;
    /** 覆盖符号跟随(缺省读设置) */
    followSymlinks?: boolean;
}

/**
 * 统一入口:读设置(一处) + 基础排除(内置产物目录) + 叠加调用方额外排除,
 * 返回 walkWithTimeout 需要的完整 WalkOptions。调用方无需自行读取任何设置。
 *
 * @param type  搜索类型(walk-config 按类型分组的超时/深度配置;default 仅内部兜底,无设置键)
 * @param extra 调用方额外隔离的部分(可选;当前无调用方需要传)
 */
export function walkOptions(type: WalkSearchType, extra?: WalkOptionsExtra): WalkOptions {
    const cfg = readWalkTimeoutConfig(type);
    return {
        branchTimeoutMs: cfg.branchTimeoutMs,
        totalTimeoutMs: cfg.totalTimeoutMs,
        maxDepth: cfg.maxDepth,
        excludedDirNames: new Set([...DEFAULT_EXCLUDED_DIR_NAMES, ...(extra?.excludedDirNames ?? [])]),
        followSymlinks: extra?.followSymlinks ?? readFollowSymlinksSetting(),
    };
}
