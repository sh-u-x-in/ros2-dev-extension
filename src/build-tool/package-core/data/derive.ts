// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file derive.ts
 * 数据层:派生计算(从源集合派生快照字段)。
 *  - deriveWorkspace: 工作区工作包 = unignored + ignored
 *  - deriveAll: 所有工作包 = workspace + system(2026-08-28 曾删,2026-08-29 随 system 域恢复;2026-09-08 起弃用,弃用标签见函数注释)
 *  - fallbackUnignoredFromWalk: colcon 未跑时的 walk 兜底(2026-09-02 设计 D2,兜底上移自 executable-map.isBuildable;
 *    2026-09-06 §12.2:口径 = visible(池)——合法且非空 name 且未被忽略(same-dir/ancestor/overlap 均排除),
 *    与 colcon 发现视图一致)
 * 纯 TS,无依赖,可无头测试。
 */

import { PackageEntry } from "../shared/types";
import type { PackageScanEntry } from "../scan/package-scan";
import { isVisibleEntry } from "../scan/ignore-classify";

/** 按 name 去重合并(前者优先) */
function mergeByName(lists: PackageEntry[][]): PackageEntry[] {
    const seen = new Set<string>();
    const out: PackageEntry[] = [];
    for (const list of lists) {
        for (const e of list) {
            if (seen.has(e.name)) {
                continue;
            }
            seen.add(e.name);
            out.push(e);
        }
    }
    return out;
}

/**
 * 所有工作包(全域)= workspace + system(按 name 去重,workspace 优先);任一上游 null → null(未知传播)。
 * @deprecated 2026-09-08 起弃用:混合域(工作区 + 系统两宇宙)无单一身份键、历次事件噪音源;
 * 新代码勿用,请改用 workspace / system 两源域;保留实现以兼容 data/commit 的域发射(旧订阅方)。
 */
export function deriveAll(workspace: PackageEntry[] | null, system: PackageEntry[] | null): PackageEntry[] | null {
    if (workspace === null || system === null) {
        return null;
    }
    return mergeByName([workspace, system]);
}

/**
 * walk 视角兜底名单(设计 D2):colcon 未跑(colconReady=false)时,「参与构建最佳名单」退化为
 * walk 侧 visible(池)(2026-09-06 §12.2:合法 && 非空 name && !ignoredBy,同目录/祖先忽略与重叠一律排除,
 * 与 colcon 发现视图一致)——原 executable-map.isBuildable 的退回逻辑上移。
 * 合法条目必带已声明 buildType(analyzePackageDir 收紧规则),故兜底天然全类型。
 */
export function fallbackUnignoredFromWalk(entries: PackageScanEntry[]): PackageEntry[] {
    return entries
        .filter(isVisibleEntry)
        .map((e) => ({ name: e.name, dir: e.dir, buildType: e.buildType }));
}

/** 工作区工作包 = unignored + ignored(按 name 去重,unignored 优先);任一上游 null → null(未知传播) */
export function deriveWorkspace(
    unignored: PackageEntry[] | null,
    ignored: PackageEntry[] | null
): PackageEntry[] | null {
    if (unignored === null || ignored === null) {
        return null;
    }
    return mergeByName([unignored, ignored]);
}
// 修改时间:2026-09-08 22:45(deriveAll 弃用标注)