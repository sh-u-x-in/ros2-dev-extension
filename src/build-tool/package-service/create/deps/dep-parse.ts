// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from "vscode";

import { getLogger } from "../../../../logger";
import { validatePackageName } from '../naming/names';
import type { DepCheckKind } from '../kinds';

// —— 公共 API 门面(符号自新模块转发, 兼容既有 import 路径) ——
export { KIND_DEFAULT_DEPS as DEP_BUILTIN } from '../kinds';
export type { DepCheckKind } from '../kinds';

/** 扩展日志薄封装(带 dep-parse 模块前缀) */
const log = getLogger("dep-parse");

/**
 * @file dep-parse.ts
 * 额外依赖输入解析与按包类型(kind)校验(纯逻辑, 不依赖 vscode, 可单测)。
 *
 * 2026-09-04 结构重构(等价变换):
 *   - DepCheckKind / DEP_BUILTIN 移至 ../kinds 单一数据源, 本文件门面转发
 *     (消除此前 validatePackageName 反向依赖 create-cpp-package 的倒挂);
 *   - validatePackageName 改经 ../naming/names(公共命名层)。
 * 行为(三类处理 / 校验口径 / 元信息标注)与迁移前逐字一致。
 *
 * 三类处理(由 kind 决定):
 *   1. 完全重复 —— 与当前 kind 已激活的默认依赖同名 → 静默去重(生成层过滤)
 *   2. 升级信号 —— 属于本体系但当前 kind 未启用(如 cpp-only 加 rclpy) → 弹错误引导换包类型
 *   3. 跨体系不可能 —— 底层构建系统不支持(如 ament_python 加 rclcpp) → 弹错误
 * 普通依赖(std_msgs/nav_msgs 等)与包类型无关, 照常展开。
 * 格式规则:逐个展开独立项(每项生成 <depend> / find_package),不用复合项；
 * 支持 空格 和/或 逗号 分隔,输出干净、无分隔符残留；逐项按包名规范筛查。
 */

/**
 * 解析额外依赖输入:空格/逗号分隔 → 去空白后的干净列表。
 * 例如 "std_msgs, nav_msgs  geometry_msgs" → ['std_msgs','nav_msgs','geometry_msgs']
 */
export function parseDepList(input: string): string[] {
    // 解析:按空格/逗号拆分并去空白,得到干净依赖列表
    const deps = input.trim().split(/[\s,]+/).filter((s) => s.length > 0);
    log.trace(l10n.t('Parsed extra dependency input: {0} items', deps.length));
    return deps;
}

/** 升级信号: 本体系依赖但当前 kind 未启用 → 弹错误(引导换包类型);表值为 l10n.t 译键(模块装载期翻译, 同 pick-preset CUSTOM_ITEM_LABEL 先例) */
const UPGRADE_DEPS: Record<DepCheckKind, Record<string, string>> = {
    'cpp-only': {
        'rclpy': l10n.t('Extra dependency rclpy needs Python nodes, but the current package is pure C++; use "Generate C++ package" (dual-language) or "Generate hybrid package" from the context menu'),
        'ament_cmake_python': l10n.t('Extra dependency ament_cmake_python is a Python module install macro, enabled only for hybrid packages; use "Generate hybrid package" from the context menu'),
    },
    'cpp-dual': {
        'ament_cmake_python': l10n.t('Extra dependency ament_cmake_python is a Python module install macro, enabled only for hybrid packages; use "Generate hybrid package" from the context menu'),
    },
    'mixed': {},
    'python': {},
};

/** 跨体系不可能: 底层构建系统不支持 → 弹错误 */
const IMPOSSIBLE_DEPS: Record<DepCheckKind, Record<string, string>> = {
    'cpp-only': {},
    'cpp-dual': {},
    'mixed': {},
    'python': {
        'rclcpp': l10n.t('Extra dependency rclcpp is a C++ client library; a pure Python package (ament_python) has no CMakeLists and cannot build it; use a C++ package instead'),
        'ament_cmake_python': l10n.t('Extra dependency ament_cmake_python is a CMake macro; a pure Python package (ament_python) cannot use it'),
    },
};

/**
 * 校验额外依赖列表(按包类型)。
 * 逐项检查: 包名格式 → 升级信号 → 跨体系不可能。
 * 任一非法 → 返回带具体依赖名的错误信息(可在 validateInput 中直接显示)；全部合法 → 返回 null。
 */
export function validateDepList(input: string, kind: DepCheckKind): string | null {
    // 循环:逐项校验额外依赖(格式 → 升级信号 → 跨体系不可能)
    for (const dep of parseDepList(input)) {
        log.trace(l10n.t('Validating extra dependency {0} ({1})', dep, kind));
        const err = validatePackageName(dep);
        if (err) {
            log.debug(l10n.t('Extra dependency {0} invalid: {1}', dep, err));
            return l10n.t('Extra dependency "{0}" is invalid: {1}', dep, err);
        }
        const upgrade = UPGRADE_DEPS[kind][dep];
        if (upgrade) {
            log.debug(l10n.t('Extra dependency {0} triggered an upgrade signal: {1}', dep, upgrade));
            return upgrade;
        }
        const impossible = IMPOSSIBLE_DEPS[kind][dep];
        if (impossible) {
            log.debug(l10n.t('Extra dependency {0} cross-system impossible: {1}', dep, impossible));
            return impossible;
        }
    }
    return null;
}

/**
 * 依赖元信息标注(QuickPick description 用, 2026-09-01 依赖多选;纯文本, 不用 emoji):
 *   - 命中 UPGRADE_DEPS[kind] → "[需双语言/混合包]"(升级信号);
 *   - 命中 IMPOSSIBLE_DEPS[kind] → "[当前类型无法使用]"(跨体系不可能);
 *   - 内置依赖(DEP_BUILTIN)由 UI 层自动隐藏(excludeBuiltin), 本函数不标注;
 *   - 无标注 → undefined。
 */
export function depAnnotation(dep: string, kind: DepCheckKind): string | undefined {
    if (UPGRADE_DEPS[kind][dep]) {
        return l10n.t('[needs dual-language/hybrid package]');
    }
    if (IMPOSSIBLE_DEPS[kind][dep]) {
        return l10n.t('[unavailable for this package type]');
    }
    return undefined;
}
