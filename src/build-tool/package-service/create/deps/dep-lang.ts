// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file dep-lang.ts
 * 依赖"语言/来源"判定(2026-09-06 知识修订, 纯函数可单测)。
 *
 * 回答: 某个依赖候选是纯 Python 吗? 是本工作区自定义包吗? 候选集合由哪些来源并集而成?
 * 判定来源(按优先级):
 *   1. 工作区包: package-core 已带 buildType(analyzePackageDir 读 package.xml 得来, 权威)——
 *      ament_python → 纯 Python; ament_cmake/cmake → CMake 包;
 *   2. 系统包(/opt/ros 等, 无工作区条目): 目录表 KNOWN_PYTHON_ONLY 已知纯 Python;
 *   3. 其余(外部 overlay 未收录/未来发行版): unknown —— 标注不猜测。
 *
 * 2026-09-14 增补: 候选来源并集 `unionCandidateNames`(工作区已确认包 ∪ 环境可见包)——
 * 与"语言判定"同层, 因为"是工作区包吗"的答案在并集之后**由来源直接给出**, 不再需要取交集反推。
 *
 * 语义红线(与代码级依赖方向一致):
 *   - C++ 代码永远不消费 Python 包 → cpp-only 语境遇纯 Python 依赖 = 拦截;
 *   - 含 Python 内容(kind=cpp-dual/mixed)的包: 纯 Python 依赖仅对"Python 侧脚本 import"
 *     成立 → 只落运行依赖(exec_depend), 绝不 find_package / 不进 C++ 节点;
 *   - 纯 Python 包(ament_python)依赖 C++ 包或 Python 包均合法(import 通道)。
 */

import { isKnownPythonOnly } from './dep-catalog';

/** package-core 工作区/未忽略域条目的最小形状(只取判定所需字段) */
export interface DepWorkspaceEntry {
    name: string;
    buildType?: string;
}

/** 由 package-core 域条目构建的判定上下文 */
export interface DepLangContext {
    /** name → buildType(工作区包, 权威; 无 = 该系统包或未知) */
    byName: Map<string, string | undefined>;
}

/** 空上下文(全部系统/未知处理) */
export const EMPTY_LANG_CONTEXT: DepLangContext = { byName: new Map() };

/** 由工作区/未忽略域条目构造判定上下文(重复 name 取先者, 实为同包) */
export function makeLangContext(entries: readonly DepWorkspaceEntry[]): DepLangContext {
    const byName = new Map<string, string | undefined>();
    for (const e of entries) {
        if (!byName.has(e.name)) {
            byName.set(e.name, e.buildType);
        }
    }
    return { byName };
}

/** 是否为工作区自定义包(本工作空间内, 路径由 package-core 域收录) */
export function isWorkspaceDep(dep: string, ctx: DepLangContext): boolean {
    return ctx.byName.has(dep);
}

/**
 * 判定依赖是否纯 Python(无 CMake 导出, C++ 不可消费):
 *   - 工作区条目 buildType === 'ament_python' → true;
 *   - 工作区条目 buildType 为 ament_cmake/cmake → false(权威);
 *   - 无工作区条目 → 目录表 KNOWN_PYTHON_ONLY 兜底(系统包已知名单)。
 */
export function isPythonDep(dep: string, ctx: DepLangContext): boolean {
    const bt = ctx.byName.get(dep);
    if (bt !== undefined) {
        return bt === 'ament_python';
    }
    return isKnownPythonOnly(dep);
}

/* ================================================================== */
/* 候选来源并集(2026-09-14 create 语义修订)                            */
/* ================================================================== */

/**
 * 依赖候选名并集: **候选 = 工作区已确认包 ∪ 环境可见包**。
 *
 * 为什么不再"只含已构建包"(2026-09-01 硬约束的反转, 2026-09-14 定):
 *   - 工作区侧名称来自 package-core `unignored`(colcon list 权威 + walk 兜底), **已通过合法性检查**
 *     (package-core §5.1: 结构/包名/buildtype/同目录构建配置), 只是可能尚未构建过 —— 与"自定义输入"
 *     (允许任意不在列表中的名字, 只查格式)相比要求严格得多, 没有理由排除;
 *   - `system` 域语义已改为"**只表示工作空间以外**", 不再保证包含本工作空间已构建的包 ——
 *     因此只用 system 取候选会**漏掉工作区包**, 并集是修复而非增强。
 *
 * 顺序与去重:
 *   - 工作区条目在前(域内相对顺序不动), 仅环境独有的条目在后 —— 用户打开弹窗即见"自己的包";
 *   - 按名去重, **同名以工作区为准**(运行时 overlay 同样是工作区胜出, 判定上下文里的 buildType
 *     也取工作区权威值; 环境侧同名条目是另一个真实外部包, 依赖名相同无需区分);
 *   - 空名剔除; 两侧均 null/undefined 按"缺席"处理(不阻塞另一侧)。
 * 纯函数, 零 vscode, 可无头单测。
 */
export function unionCandidateNames(
    workspace: readonly DepWorkspaceEntry[] | null | undefined,
    systemNames: readonly string[] | null | undefined,
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (name: string): void => {
        if (name.length > 0 && !seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    };
    for (const e of workspace ?? []) {
        push(e.name);
    }
    for (const n of systemNames ?? []) {
        push(n);
    }
    return out;
}
