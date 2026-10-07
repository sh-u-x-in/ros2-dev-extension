// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file names.ts
 * 命名与校验公共层(create/naming,2026-09-04 结构重构建立)。
 *
 * 单一事实来源(消除 create-cpp-package / create-python-package 两处重复与
 * py/dep 对 cpp 生成器的反向 import):
 *   - 包名域      validatePackageName / PACKAGE_NAME_RE   (曾复制于两个生成器)
 *   - 文件基名域  FILE_BASE_RE / NAME_MAX_LENGTH / 保留设备名 / parseFileBaseList
 *                 / validateFileBaseName(s)              (曾仅存于 create-cpp-package)
 *   - 节点名域    NODE_NAME_RE / Python 关键字 / parseNodeNames
 *                 / validateNodeNamesInput                (曾仅存于 create-python-package)
 *   - 映射与顺延  CppNodeSpec / CppNodeInput / toNodeName / disambiguateNodeNames
 *                 (曾仅存于 create-cpp-package)
 *
 * 语义锚点(create/README.md §4/§7,不因搬移改变):
 *   输入 = 文件基名(宽范围, 可含连字符), 真实对应生成的文件名;
 *   有损映射(-→_)只发生在节点名层, 冲突时对节点名顺延 _1/_2, 文件基名不动。
 *   - C++ 源文件 / Python 脚本(cpp-dual):  宽域基名 + 映射顺延;
 *   - Python 模块(mixed / ament_python): 输入即标识符, 文件 === 模块名 === 节点名。
 *
 * 纯逻辑, 零 vscode / 零生成器依赖, 可 mocha 单测。
 */

import { l10n } from "vscode";

import { getLogger } from "../../../../logger";

/** 扩展日志薄封装(带 create-names 模块前缀; 通道未注入时回退 console) */
const log = getLogger("create-names");

// ---------------------------------------------------------------------------
// 包名域
// ---------------------------------------------------------------------------

/** 官方包名规范:小写字母开头,仅小写字母/数字/下划线,下划线不能连续、不能结尾 */
const PACKAGE_NAME_RE = /^[a-z](_?[a-z0-9]+)*$/;

/**
 * 校验包名:合法返回 null,非法返回错误信息字符串。
 * (单一实现; 曾复制于 create-cpp-package 与 create-python-package, 两处逐字相同)
 */
export function validatePackageName(name: string): string | null {
    log.trace(l10n.t('Validating package name: {0}', name.trim() || l10n.t('(empty)')));
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        return l10n.t('Package name cannot be empty');
    }
    if (!PACKAGE_NAME_RE.test(trimmed)) {
        return l10n.t('Package name must start with a lowercase letter and contain only lowercase letters/digits/underscores; underscores may not repeat or trail');
    }
    if (trimmed === 'test') {
        return l10n.t('Package name cannot be "test" (conflicts with the test directory; official ament_python rejects it)');
    }
    return null;
}

// ---------------------------------------------------------------------------
// 文件基名域(宽范围: C++ 源文件 / Python 脚本, 可含连字符)
// ---------------------------------------------------------------------------

/** 宽范围文件基名规则: 字母/下划线开头, 仅字母/数字/下划线/连字符, ≤250(映射后必为合法节点名) */
const FILE_BASE_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** 输入长度上限: 含扩展名后不超 Windows 组件 255, 且不超 rmw 节点名 255 */
export const NAME_MAX_LENGTH = 250;

/** Windows 保留设备名(文件基名禁用, 大小写不敏感) */
const RESERVED_FILE_NAMES = ['con','prn','aux','nul','com1','com2','com3','com4','com5','com6','com7','com8','com9','lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9'];

/** 是否为 Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9, 大小写不敏感) */
export function isReservedFileName(name: string): boolean {
    return RESERVED_FILE_NAMES.includes(name.trim().toLowerCase());
}

/** 解析空格分隔的文件基名列表; 空输入 → [] */
export function parseFileBaseList(input: string): string[] {
    const t = input.trim();
    return t.length === 0 ? [] : t.split(/\s+/);
}

/** 校验单个文件基名: 合法返回 null, 否则返回错误信息字符串 */
export function validateFileBaseName(name: string): string | null {
    if (name.length === 0) {
        return l10n.t('File base name cannot be empty');
    }
    if (name.length > NAME_MAX_LENGTH) {
        return l10n.t('File base name too long (max {0} characters)', NAME_MAX_LENGTH);
    }
    if (!FILE_BASE_RE.test(name)) {
        return l10n.t('Invalid file base name: must start with a letter or underscore; only letters/digits/underscores/hyphens allowed');
    }
    if (isReservedFileName(name)) {
        return l10n.t('File base name "{0}" is a reserved Windows name; please choose another', name);
    }
    return null;
}

/**
 * 文件基名输入实时校验(输入框 validateInput 用): 空允许; 逐项格式/保留名 + 列表内去重。
 * 合法返回 undefined; 非法返回错误串(与回车后最终校验口径一致)。
 */
export function validateFileBaseNamesInput(input: string): string | undefined {
    const seen = new Set<string>();
    // 循环:逐项校验(格式/保留名/重复)
    for (const n of parseFileBaseList(input)) {
        const err = validateFileBaseName(n);
        if (err) {
            return err;
        }
        if (seen.has(n)) {
            return l10n.t('File base name "{0}" is duplicated', n);
        }
        seen.add(n);
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// 节点名 / Python 模块名域(标识符: mixed / ament_python 模块场景)
// ---------------------------------------------------------------------------

/** 节点名/模块名规范(官方 rmw 规则, 见 create/README.md §2): 字母或下划线开头, 仅字母/数字/下划线 */
const NODE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Python 3 关键字(35 个, 不可用作模块名/标识符; 用于模块文件 import 合法性) */
const PYTHON_KEYWORDS = new Set<string>([
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
    'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
    'True', 'try', 'while', 'with', 'yield',
]);

/**
 * 解析节点名输入(可空、可多个、空格分隔、不允许重复)。
 * 返回去重后的节点名列表; 含错误时 error 非 null、nodeNames 为空。
 */
export function parseNodeNames(input: string): { nodeNames: string[]; error: string | null } {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return { nodeNames: [], error: null };
    }
    const parts = trimmed.split(/\s+/);
    const seen = new Set<string>();
    const nodeNames: string[] = [];
    // 循环:逐个解析节点名(校验格式/长度/保留名 + 去重)
    for (const part of parts) {
        if (!NODE_NAME_RE.test(part)) {
            return { nodeNames: [], error: l10n.t('Node name "{0}" is invalid: must start with a letter or underscore; only letters/digits/underscores allowed', part) };
        }
        if (part.length > NAME_MAX_LENGTH) {
            return { nodeNames: [], error: l10n.t('Node name too long (max {0} characters)', NAME_MAX_LENGTH) };
        }
        if (isReservedFileName(part)) {
            return { nodeNames: [], error: l10n.t('Node name "{0}" is a reserved Windows name; please choose another', part) };
        }
        if (PYTHON_KEYWORDS.has(part)) {
            return { nodeNames: [], error: l10n.t('Node name "{0}" is a Python keyword; cannot be used as a module name', part) };
        }
        if (seen.has(part)) {
            return { nodeNames: [], error: l10n.t('Node name "{0}" is duplicated', part) };
        }
        seen.add(part);
        nodeNames.push(part);
    }
    return { nodeNames, error: null };
}

/**
 * 节点名输入实时校验(showInputBox validateInput 用):空允许;非法返回错误串;合法返回 undefined。
 * 复用 parseNodeNames 的格式 + 去重校验,与回车后最终校验口径一致(三种包 5 处输入框共用)。
 */
export function validateNodeNamesInput(input: string): string | undefined {
    const parsed = parseNodeNames(input);
    return parsed.error ?? undefined;
}

// ---------------------------------------------------------------------------
// 文件基名 → 节点名: 有损映射与顺延
// ---------------------------------------------------------------------------

/**
 * 单个示范节点:文件基名与节点名分离。
 * file = 写盘用文件名(宽范围, 可含连字符, 如 my-node);
 * node = 节点名 / CMake target 名(合法标识符, 由 file 有损映射而来, 冲突时顺延)。
 * 模块场景(混合包 Python)file === node(恒等, 见 create/README.md §4/§7)。
 */
export interface CppNodeSpec {
    /** 文件基名(写盘用, 宽范围) */
    file: string;
    /** 节点名 / CMake target 名(合法标识符) */
    node: string;
}

/** 节点输入: 字符串 = 恒等(file === node); 对象 = 显式分离(file !== node) */
export type CppNodeInput = string | CppNodeSpec;

/** 字符串节点输入归一化为恒等 spec (file === node, 如模块场景) */
export function toSpec(x: CppNodeInput): CppNodeSpec {
    return typeof x === 'string' ? { file: x, node: x } : x;
}

/** 有损映射: 文件基名 → 节点名 (仅替换连字符; 输入规则保证结果必为合法节点名) */
export function toNodeName(fileBase: string): string {
    return fileBase.replace(/-/g, '_');
}

/**
 * 节点名顺延: 有损映射后结果冲突时, 对节点名追加 _1/_2…(文件基名保持不变, 真实对应输入)。
 * 例: ['my-node','my_node'] → [{file:'my-node',node:'my_node'},{file:'my_node',node:'my_node_1'}]
 */
export function disambiguateNodeNames(fileBases: string[]): CppNodeSpec[] {
    const used = new Set<string>();
    // 循环:逐个映射并顺延
    return fileBases.map((file) => {
        const base = toNodeName(file);
        let node = base;
        let k = 1;
        while (used.has(node)) {
            node = `${base}_${k++}`;
        }
        used.add(node);
        return { file, node };
    });
}
