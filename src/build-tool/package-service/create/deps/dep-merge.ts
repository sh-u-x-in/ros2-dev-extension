// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file dep-merge.ts
 * 依赖多选的合并/校验纯函数(2026-09-01, 见 04-包创建依赖多选-具体设计方案.md §4)。
 * 零 vscode 依赖, 可 mocha 单测;UI 壳在 dep-pick.ts(只编排, 不掺逻辑)。
 */

import { validateDepList, DEP_BUILTIN, DepCheckKind } from './dep-parse';

/**
 * 合并去重: 勾选项 ∪ 自定义输入。
 * 规则: 与 DEP_BUILTIN[kind] 内置依赖同名 → 静默过滤;勾选与自定义重复 → 静默去重。
 * 顺序稳定: 勾选项在前、自定义在后,各自保持输入顺序。
 */
export function mergeDeps(selected: string[], custom: string[], kind: DepCheckKind): string[] {
    const builtin = DEP_BUILTIN[kind];
    const seen = new Set<string>();
    const out: string[] = [];
    // 循环:逐个合并(内置过滤 + 去重)
    for (const dep of [...selected, ...custom]) {
        if (builtin.includes(dep)) {
            continue; // 内置依赖: 静默过滤(生成器已有, 不重复写)
        }
        if (seen.has(dep)) {
            continue; // 重复(勾选∩自定义): 静默去重
        }
        seen.add(dep);
        out.push(dep);
    }
    return out;
}

/**
 * 候选过滤: 剔除 DEP_BUILTIN[kind] 内置依赖(QuickPick 列表自动隐藏; 勾了也会被 mergeDeps 静默过滤,
 * 留在列表纯属误导——2026-09-01)。
 */
export function excludeBuiltin(candidates: string[], kind: DepCheckKind): string[] {
    const builtin = DEP_BUILTIN[kind];
    return candidates.filter((n) => !builtin.includes(n));
}

/**
 * 显式逐项校验(多选场景无内联输入框, 合并后调用; 2026-09-01 "内联 → 显式")。
 * 复用 validateDepList 单值口径(格式 → 升级信号 → 跨体系不可能);返回首个错误或 null。
 */
export function validateFinal(deps: string[], kind: DepCheckKind): string | null {
    // 循环:逐项显式校验
    for (const dep of deps) {
        const err = validateDepList(dep, kind);
        if (err) {
            return err;
        }
    }
    return null;
}
