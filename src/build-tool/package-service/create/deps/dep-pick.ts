// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file dep-pick.ts
 * 依赖多选交互层(2026-09-01, 见 04-包创建依赖多选-具体设计方案.md §2/§3/§5)。
 * 职责:取候选 → QuickPick 多选 → 按需自定义输入 → 合并 → 显式校验(失败弹错重开)。
 * 校验/合并逻辑在 dep-merge.ts / dep-parse.ts(纯函数, 可单测);本文件只编排 UI。
 *
 * 2026-09-06 知识修订(依赖语言/来源标注 + 语境拦截), 2026-09-14 候选来源修订(并集):
 *   - 候选 = **工作区 ∪ 环境**(见 unionCandidateNames):工作区侧取 package-core `unignored`
 *     (**含未构建包**, 名称已通过合法性检查), 环境侧取 `system`(语义 = 只表示工作空间以外);
 *     为什么不能用"只有 system"或"只含已构建":system 已不再保证包含本工作空间已构建的包 → 会漏包;
 *   - 来源标注**直接按域判定**(unignored 命中即 [本工作区包], 其 buildType 权威判 [纯 Python 包]),
 *     不再需要"候选 ∩ unignored"取交集来反推来源 —— 并集之后来源本身已知;
 *   - 未命中工作区域的系统/外部包: 目录表 KNOWN_PYTHON_ONLY 兜底; 未收录不猜、不标注;
 *   - 同名重叠(环境里出现与工作区同名的外部包): 运行时 overlay 工作区胜出, 标注按工作区那条
 *     (依赖名相同, 无需区分; 不属本次要解决的歧义);
 *   - "[纯 Python 包]": 工作区命中者用 unignored buildType 权威判定;
 *     非工作区系统包用 KNOWN_PYTHON_ONLY 已知名单(见 dep-lang.ts);
 *   - cpp-only(纯 C++, 无 Python 内容)勾选纯 Python 依赖 → 显式拦截(代码级: C++ 不消费 Python);
 *   - 返回结构含 pythonOnly 通道: cpp-dual/mixed 的纯 Python 依赖只作 Python 侧运行依赖,
 *     由生成器落 <exec_depend>, 不 find_package(见 generate/create-cpp-package)。
 *
 * 数据源(§3 定稿, package-core 五域 null 契约; 2026-09-14 并集修订):
 *   - packageCore.getState().unignored: [e...] → 工作区侧候选(含未构建); null(未刷新) → 工作区侧缺席;
 *   - packageCore.getState().system: [e...] → 环境侧候选; [] → 已刷新但确实没有 → 环境侧空;
 *     null(未刷新/未知) → 现跑 ros2ServiceApi.pkg_list({}) 绕开缓存时序;
 *   - 并集为空(两侧都拿不到) → 降级纯输入框(现状, 零回归)。
 *
 * Esc 语义: 多选/自定义输入框/降级输入框任一 Esc → 返回 null → 调用方终止流程。
 */

import { l10n } from "vscode";

import * as vscode from 'vscode';

import { getLogger } from '../../../../logger';
import { DepCheckKind, parseDepList, validateDepList, depAnnotation } from './dep-parse';
import { mergeDeps, validateFinal, excludeBuiltin } from './dep-merge';
import { depDescription } from './dep-catalog';
import { isPythonDep, isWorkspaceDep, makeLangContext, unionCandidateNames, DepLangContext } from './dep-lang';
import type { PackageEntry } from '../../../package-core/shared/types';
import { packageCore } from '../../../../extension';
import { composeApi } from '../../../../ros2/api';

/** 扩展日志薄封装(带 dep-pick 模块前缀) */
const logger = getLogger('dep-pick');

/** 多选条目(带内部标记):「自定义输入」勾选判定走项上 isCustom,不按 label 反查——label 已本地化,随显示语言变 */
interface DepPickItem extends vscode.QuickPickItem {
    /** 是否为「自定义输入」项 */
    isCustom?: boolean;
}

/** 多选最终结果: deps = 全部采纳依赖; pythonOnly = 其中纯 Python 部分(仅 C++ 类包生成器用) */
export interface PickDepsResult {
    deps: string[];
    pythonOnly: string[];
}

/**
 * 构造"本工作区包"判定上下文:
 *   只取 **未忽略(unignored)** 域(自带路径/buildType, 已刷新)。2026-09-14 起候选本身即
 *   `unignored ∪ system`, 所以这里不再用于"取交集反推来源", 而是**来源已知后的权威类型表**:
 *   unignored 成员 → [本工作区包], 其 buildType 权威判纯 Python; 非成员 → 系统/外部(名单兜底)。
 *   不用 workspace(全量, 含 ignored)以免把已忽略目录算进来; 空/未刷新 → 空上下文(全部按系统/未知处理)。
 */
function langContext(): DepLangContext {
    const s = packageCore?.getState();
    const entries: PackageEntry[] = s?.unignored ?? [];
    return makeLangContext(entries);
}

/**
 * 取候选包名列表(= 工作区已确认包 ∪ 环境可见包, 按名去重、工作区在前):
 *   - 工作区侧: `unignored`(**含未构建包**, 名称已经过 package-core 合法性检查);
 *     null(未刷新) → 工作区侧缺席(不阻塞环境侧);
 *   - 环境侧: `system` 域非 null → 直接用(容忍 ≤60s 陈旧; [] = 已刷新但确实没有);
 *     null(未刷新/未知) → 现跑 pkg_list(绕开缓存时序; 失败返回 null → 环境侧缺席);
 * 返回空数组 = 两侧都拿不到候选(调用方降级纯输入框)。
 */
async function fetchCandidates(): Promise<string[]> {
    const s = packageCore?.getState();
    const workspace = s?.unignored ?? [];
    const sys = s?.system;
    let systemNames: readonly string[] | null;
    if (sys === null || sys === undefined) {
        logger.debug('dep-pick:system 域未刷新(null),现跑 pkg_list');
        systemNames = await composeApi.ros2ServiceApi.pkg_list({});
    } else {
        systemNames = sys.map((e) => e.name);
    }
    const candidates = unionCandidateNames(workspace, systemNames);
    logger.debug(`dep-pick:候选 ${candidates.length} 条(工作区 ${workspace.length} / 环境 ${sys === null || sys === undefined ? '现取' : sys.length})`);
    return candidates;
}

/** 候选条目标注(来源/语言): 返回 detail 附加标记数组 */
function depMarkers(name: string, kind: DepCheckKind, ctx: DepLangContext): string[] {
    const markers: string[] = [];
    if (isWorkspaceDep(name, ctx)) {
        markers.push(l10n.t('[workspace package]'));
    }
    if (isPythonDep(name, ctx)) {
        markers.push(l10n.t('[pure Python package]'));
    }
    const base = depAnnotation(name, kind);
    if (base) {
        markers.push(base);
    }
    return markers;
}

/** QuickPick 多选(可保留上次勾选重开;Esc → undefined)。返回 labels = 去掉自定义项后的纯依赖名 */
async function pickMulti(
    candidates: string[],
    previousPicked: string[],
    previousWantsCustom: boolean,
    kind: DepCheckKind,
    ctx: DepLangContext,
    flow: string,
): Promise<{ labels: string[]; wantsCustom: boolean } | undefined> {
    const items: DepPickItem[] = [
        {
            label: l10n.t('Custom input'),
            description: l10n.t('Hand-enter dependency names not in the list after checking'),
            alwaysShow: true, // 防过滤框输入时首项被滤掉, 勾选入口消失
            picked: previousWantsCustom,
            isCustom: true,
        },
        // 循环:候选(工作区已确认包在前, 环境可见包在后; 内置依赖自动隐藏, 勾了也会被 mergeDeps 静默过滤)
        //   description = 作用说明(A 粒度, dep-catalog; C4/C5 → 类别标记)
        //   detail     = 来源/语言/升级跨体系标注(勾选不拦截, 显式校验兜底)
        ...excludeBuiltin(candidates, kind).map((name) => {
            const markers = depMarkers(name, kind, ctx);
            return {
                label: name,
                description: depDescription(name),
                detail: markers.length > 0 ? markers.join('  ') : undefined,
                picked: previousPicked.includes(name),
            };
        }),
    ];
    const result = await vscode.window.showQuickPick(items, {
        title: `${flow} - ${l10n.t('② Select dependencies')}`,
        canPickMany: true, // 多选(QuickPickOptions.canPickMany, 非 canSelectMany)
        matchOnDescription: true,
        placeHolder: l10n.t('Select dependencies (check "Custom input" to add dependencies not listed)'),
    });
    if (result === undefined) {
        return undefined; // Esc → 终止
    }
    return {
        labels: result.filter((i) => !i.isCustom).map((i) => i.label),
        wantsCustom: result.some((i) => i.isCustom === true),
    };
}

/** 由已采纳依赖计算纯 Python 通道(调用方 ctx 构造一次复用) */
function splitPython(deps: string[], ctx: DepLangContext): PickDepsResult {
    return {
        deps,
        pythonOnly: deps.filter((d) => isPythonDep(d, ctx)),
    };
}

/** 降级路径: 现状纯输入框(validateDepList 内联校验;Esc → null → 终止) */
async function legacyInput(kind: DepCheckKind, ctx: DepLangContext, flow: string): Promise<PickDepsResult | null> {
    logger.debug('dep-pick:无候选,降级纯输入框');
    const v = await vscode.window.showInputBox({
        title: `${flow} - ${l10n.t('② Select dependencies')}`,
        prompt: l10n.t('Enter extra dependencies (space/comma separated; leave empty to skip)'),
        placeHolder: l10n.t('e.g. std_msgs, nav_msgs'),
        validateInput: (value) => validateDepList(value, kind) ?? undefined,
    });
    return v === undefined ? null : splitPython(parseDepList(v), ctx);
}

/**
 * 依赖多选主入口:候选获取 → 多选(+可选自定义) → 合并去重 → 显式校验(失败弹错重开, 保留上次勾选)。
 * flow = 已本地化的向导流名(如「生成 C++ 包」), 用于拼装弹窗标题;取消(任意阶段 Esc)返回 null → 调用方终止。
 */
export async function pickDeps(kind: DepCheckKind, flow: string): Promise<PickDepsResult | null> {
    logger.debug(`弹窗:选择额外依赖(${kind})`);
    const candidates = await fetchCandidates();
    const ctx = langContext();
    if (candidates.length === 0) {
        return legacyInput(kind, ctx, flow); // 降级: 两侧都无候选 → 现状输入框
    }
    let previousPicked: string[] = [];
    let previousWantsCustom = false;
    // 循环:显式校验失败 → 弹错 → 重开多选(保留上次勾选);取消 → 终止
    for (;;) {
        const picked = await pickMulti(candidates, previousPicked, previousWantsCustom, kind, ctx, flow);
        if (picked === undefined) {
            return null; // Esc → 终止
        }
        const selected = picked.labels;
        let custom: string[] = [];
        if (picked.wantsCustom) {
            const customInput = await vscode.window.showInputBox({
                title: `${flow} - ${l10n.t('② Custom dependencies')}`,
                prompt: l10n.t('Enter extra dependencies not in the list (space/comma separated)'),
                placeHolder: l10n.t('e.g. std_msgs, nav_msgs'),
                validateInput: (value) => validateDepList(value, kind) ?? undefined,
            });
            if (customInput === undefined) {
                return null; // Esc → 终止
            }
            custom = parseDepList(customInput);
        }
        const merged = mergeDeps(selected, custom, kind);
        const err = validateFinal(merged, kind);
        if (err) {
            vscode.window.showErrorMessage(err);
            previousPicked = selected; // 保留上次勾选, 重开
            previousWantsCustom = picked.wantsCustom;
            continue;
        }
        const result = splitPython(merged, ctx);
        // 语境拦截: 纯 C++(无 Python 内容)不可能消费纯 Python 依赖 —— 代码级不成立, 直接报错重选
        if (kind === 'cpp-only' && result.pythonOnly.length > 0) {
            vscode.window.showErrorMessage(l10n.t(
                'Pure Python packages {0} cannot be consumed by a pure C++ package (C++ code cannot import Python packages; if the package needs Python, use "Generate C++ package" (dual-language) or "Generate hybrid package" instead)',
                result.pythonOnly.map((d) => `"${d}"`).join(', ')));
            previousPicked = selected;
            previousWantsCustom = picked.wantsCustom;
            continue;
        }
        return result;
    }
}
