// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file param-tree-build.ts
 * 扁平参数映射 → 参数树(2026-10-03 十九轮批4 自 param-helper-client.ts 拆出,纯函数模块):
 * "." 拆键的严格逆操作,无损重建层级。类型 ParamTree/ParamTypedValue 契约在 api 层。
 */

import type { ParamStructureEntry } from "./param-store";
import type { ParamTree, ParamTypedValue } from "../../../api";

/** JS 值反推类型化参数值(助手回传 JSON 原生类型;截断标记 → array + total) */
export function fromJsonValue(v: unknown): ParamTypedValue {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const marker = v as { __rde_truncated?: unknown; total?: unknown; items?: unknown };
        if (marker.__rde_truncated === true && Array.isArray(marker.items)) {
            return { kind: "array", value: marker.items.map(fromJsonValue), total: Number(marker.total) };
        }
    }
    if (typeof v === "number") { return { kind: Number.isInteger(v) ? "integer" : "double", value: v }; }
    if (typeof v === "boolean") { return { kind: "boolean", value: v }; }
    if (Array.isArray(v)) { return { kind: "array", value: v.map(fromJsonValue) }; }
    return { kind: "string", value: String(v) };
}

/** 结构条目类型 → 懒叶(值未取;webview 渲染"—") */
function toLazyLeaf(type: string): ParamTypedValue {
    const kind = (["boolean", "integer", "double", "string", "array"] as const).includes(type as never)
        ? type as ParamTypedValue["kind"] : "string";
    return { kind, value: null, lazy: true };
}

/** 结构名册 → 懒参数树(重设计阶段 3b:只有名+类型,值占位 null+lazy;纯函数) */
export function buildLazyTree(entries: ParamStructureEntry[]): ParamTree {
    const tree: ParamTree = {};
    for (const { name, type } of entries) {
        const segs = name.split(".");
        let cur = tree;
        for (let i = 0; i < segs.length - 1; i++) {
            const seg = segs[i];
            let branch = cur[seg];
            if (branch === undefined || isTypedLeaf(branch)) {
                branch = {};
                cur[seg] = branch;
            }
            cur = branch;
        }
        cur[segs[segs.length - 1]] = toLazyLeaf(type);
    }
    return tree;
}

/** 懒树合并值:值缓存就地并入懒叶(同构建路径;值形状与结构类型天然对齐) */
export function mergeValuesIntoLazyTree(tree: ParamTree, flat: Record<string, unknown>): ParamTree {
    const merged: ParamTree = {};
    for (const [name, value] of Object.entries(flat)) {
        const segs = name.split(".");
        let cur = merged;
        for (let i = 0; i < segs.length - 1; i++) {
            const seg = segs[i];
            let branch = cur[seg];
            if (branch === undefined || isTypedLeaf(branch)) {
                branch = {};
                cur[seg] = branch;
            }
            cur = branch;
        }
        cur[segs[segs.length - 1]] = fromJsonValue(value);
    }
    // 结构里有而值缓存没有的条目(理论上展开取全值后不该有;防御保留懒叶)
    const keep = (target: ParamTree, src: ParamTree): void => {
        for (const key of Object.keys(src)) {
            const sv = src[key];
            if (isTypedLeaf(sv)) {
                if (target[key] === undefined) {
                    target[key] = sv;
                }
            } else {
                const tv = (target[key] !== undefined && !isTypedLeaf(target[key]))
                    ? target[key] as ParamTree : {};
                keep(tv, sv);
                target[key] = tv;
            }
        }
    };
    keep(merged, tree);
    return merged;
}

/** 扁平点分参数名映射 → 参数树(纯函数) */
export function buildParamTree(flat: Record<string, unknown>): ParamTree {
    const tree: ParamTree = {};
    for (const [name, value] of Object.entries(flat)) {
        const segs = name.split(".");
        let cur = tree;
        for (let i = 0; i < segs.length - 1; i++) {
            const seg = segs[i];
            let branch = cur[seg];
            if (branch === undefined || isTypedLeaf(branch)) {
                branch = {};
                cur[seg] = branch;
            }
            cur = branch;
        }
        cur[segs[segs.length - 1]] = fromJsonValue(value);
    }
    return tree;
}

/** 叶子判别:属性 "kind" 为 string */
export function isTypedLeaf(v: unknown): v is ParamTypedValue {
    return v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as { kind?: unknown }).kind === "string";
}
