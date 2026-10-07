// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ignore-classify.ts
 * 池 × 标记集 M 分类纯函数(2026-09-06 四项修复 §12.2 / §12.12)。
 *
 * 语义(镜像 colcon 递归发现的自上而下剪枝时序):
 *  - 任何目录含 COLCON_IGNORE → 整棵子树跳过(祖先语义,P2);
 *  - 识别为合法包的目录 → 不再下钻(嵌套重叠,P1);
 *  - 故对每条合法池条目 p,沿祖先链(根 → p)找**第一个阻挡者**:
 *      阻挡者 ∈ M(含自身 = 同目录标记)→ same-dir / ancestor;阻挡者为合法包(且非 p 自身)→ overlap;
 *  - 已忽略包(ignore 域)与 list 不同论域,不进任何"圆"(§12.12 三区定义域)。
 *
 * 纯 TS、零 vscode 依赖、可无头表驱动测试。分类只依赖 dir/isValid 与标记集,
 * 不重读 fs —— COLCON_IGNORE 事件路径(applyMarkerSync)与 walk 重建路径共用本函数,单一事实源。
 */

import * as path from "path";
import type { PackageScanEntry, IgnoreReason } from "./package-scan";

/** 路径归一化(比较键统一形态;事件/walk/colcon 三路同构) */
const norm = (p: string): string => path.normalize(p);

/**
 * 单目录分类:沿祖先链(根 → 父)自根向下找第一个阻挡者;无阻挡再看自身标记。
 * 输入集(标记集 / 合法包目录集)由调用方以 norm 形态准备。
 */
export function classifyIgnoreReason(
    dir: string,
    markers: ReadonlySet<string>,
    validPkgDirs: ReadonlySet<string>,
    workspaceRoot: string,
): IgnoreReason | undefined {
    const root = norm(workspaceRoot);
    const d = norm(dir);
    const rel = path.relative(root, d);
    if (rel !== "") {
        const segs = rel.split(/[\\/]+/).filter((s) => s.length > 0);
        // 自根向下逐个检查祖先(含根自身,不含 dir 自身)
        let cur = root;
        for (let i = 0; i < segs.length; i++) {
            const a = norm(cur);
            if (markers.has(a)) {
                return "ancestor";
            }
            if (validPkgDirs.has(a)) {
                return "overlap";
            }
            cur = path.join(cur, segs[i]);
        }
    }
    // 无祖先阻挡:自身标记 → 同目录忽略(标记优先于"自身是包")
    if (markers.has(d)) {
        return "same-dir";
    }
    return undefined;
}

/**
 * 对全量条目重算分类(hasColconIgnore + ignoredBy)。
 * 条目其余字段(合法/类型/name)不受标记影响,原样保留;结果全量替换,供快照存储与指纹比对。
 */
export function classifyEntries(
    entries: readonly PackageScanEntry[],
    markers: readonly string[],
    workspaceRoot: string,
): PackageScanEntry[] {
    const markerSet = new Set(markers.map(norm));
    const validDirs = new Set(entries.filter((e) => e.isValid).map((e) => norm(e.dir)));
    return entries.map((e) => {
        const reason = classifyIgnoreReason(e.dir, markerSet, validDirs, workspaceRoot);
        const hasColconIgnore = reason === "same-dir";
        if (e.ignoredBy === reason && e.hasColconIgnore === hasColconIgnore) {
            return e;
        }
        return { ...e, hasColconIgnore, ignoredBy: reason };
    });
}

/**
 * visible 谓词(§12.2 visible(池)):合法 && 非空 name && 未被忽略(any reason)。
 * 供 walk 侧三区、fallback、并集补入共用 —— "没有被忽略的包"。
 */
export function isVisibleEntry(e: PackageScanEntry): e is PackageScanEntry & { name: string } {
    return e.isValid && !!e.name && !e.ignoredBy;
}
