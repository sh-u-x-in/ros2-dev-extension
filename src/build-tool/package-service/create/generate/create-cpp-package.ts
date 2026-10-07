// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file create-cpp-package.ts
 * 含 C++ 节点包(ament_cmake)生成器组装层 —— 纯逻辑、不依赖 VS Code / ROS 环境,
 * 可在任意 Node 环境(含 Windows)单独测试。
 *
 * 2026-09-04 结构重构(等价变换):本文件从 720 行巨文件瘦身为"组装 + 公共 API 门面"——
 *   - 校验/映射/顺延  → ../naming/names(公共命名层, 单一来源);
 *   - 类型/默认行     → ../kinds(kind 注册表: 默认节点 + KIND_DEFAULT_DEPS);
 *   - 模板正文        → ../templates(CMakeLists / package.xml / C++ 节点 / Python 节点);
 *   - GeneratedFile   → ../naming/generated-file(唯一定义)。
 * 本文件保留原文件名与全部对外符号(测试与交互层 import 兼容), 只做:解析配置 →
 * 合成差异项(spec) → 调模板 → 拼文件清单。生成内容与迁移前逐字节一致。
 *
 * 名称语义(create/README.md §4/§7): file = 写盘文件名(宽范围, 可含连字符);
 * node = 节点名/CMake target 名(合法标识符, 由交互层经 names 映射顺延)。
 *
 * 三种包类型(对应两种大类型,C++ 包再分两种):
 *   cpp-only : 纯 C++ 节点包 —— 2 个 C++ 节点,无 Python(无 UI 入口, 测试覆盖; 对应"纯 C++ 包")
 *   cpp-dual : 双语言节点包 —— 1 个 C++ 节点 + 1 个 Python 脚本节点(PROGRAMS,无模块)
 *   mixed    : 混合包       —— 1 个 C++ 节点 + 1 个 Python 模块节点(ament_cmake_python)
 */

import { l10n } from "vscode";

import { getLogger } from "../../../../logger";
import { toSpec } from '../naming/names';
import type { CppNodeSpec, CppNodeInput } from '../naming/names';
import { kindDefaults, KIND_DEFAULT_DEPS, CppPackageKind } from '../kinds';
import { isKnownPythonOnly } from '../deps/dep-catalog';
import type { GeneratedFile } from '../naming/generated-file';
import { renderCmakeLists } from '../templates/cmake';
import { renderAmentCmakePackageXml } from '../templates/package-xml';
import { cppNodeSource } from '../templates/cpp-node';
import { pyNodeSource } from '../templates/py-node';

// —— 公共 API 门面(符号自新模块转发, 兼容既有 import 路径) ——
export { validatePackageName, isReservedFileName, NAME_MAX_LENGTH, parseFileBaseList, validateFileBaseNamesInput, toNodeName, disambiguateNodeNames } from '../naming/names';
export type { CppNodeSpec, CppNodeInput } from '../naming/names';
export type { CppPackageKind } from '../kinds';
export type { GeneratedFile } from '../naming/generated-file';

/** 扩展日志薄封装(带 create-cpp-pkg 模块前缀) */
const log = getLogger("create-cpp-pkg");

// ---------------------------------------------------------------------------
// 类型定义(公共配置面)
// ---------------------------------------------------------------------------

/** 生成含 C++ 节点包的配置 */
export interface CppPackageConfig {
    /** 包名(必须符合 ROS 命名规范) */
    packageName: string;
    /** 包类型: cpp-only / cpp-dual / mixed */
    kind: CppPackageKind;
    /** 覆盖默认 C++ 节点列表; 未传用 kind 默认, 空数组 = 0 个 C++ 节点 */
    cppNodes?: CppNodeInput[];
    /** 覆盖默认 Python 节点列表; 未传用 kind 默认, 空数组 = 0 个 Python 节点 */
    pythonNodes?: CppNodeInput[];
    /** 额外运行依赖 (追加 find_package + <depend>, 不含默认依赖) */
    extraDeps?: string[];
    /**
     * 纯 Python 运行依赖(工作区自定义包等, 由交互层经 dep-lang 判定后传入):
     * 无 CMake 导出 —— 不 find_package、不挂 C++ 节点宏; package.xml 仅 <exec_depend>。
     * (目录表 KNOWN_PYTHON_ONLY 的系统包在本层自动并入, 无需手填)
     */
    pythonOnlyDeps?: string[];
    /**
     * 头文件安装布局(内容对齐分派):由交互层按 env.ROS_DISTRO 经 resolveIncludeLayout 解析后传入
     * (dashing~galactic = single 单层 / humble~lyrical = double 双层 / 未知与 rolling 缺省 double);
     * 两个变体的生成文本都版本中立、不携带发行版名与"约定"概念。缺省 double。
     */
    includeLayout?: "double" | "single";
}

// ---------------------------------------------------------------------------
// 差异项合成(kind 默认 + 用户覆盖)
// ---------------------------------------------------------------------------

/** 解析后的最终差异项(传给模板渲染) */
interface KindSpec {
    /** 包类型变体(供 package.xml 描述/说明文案) */
    variant: CppPackageKind;
    /** C++ 节点清单(文件基名 + 节点名) */
    cppNodes: CppNodeSpec[];
    /** 是否启用 Python 客户端库 rclpy */
    enableRclpy: boolean;
    /** 是否启用 Python 模块安装(ament_cmake_python) */
    enablePythonModule: boolean;
    /** Python 脚本相对路径列表(PROGRAMS 安装) */
    pythonScriptPaths: string[];
    /** Python 节点清单(脚本或模块) */
    pythonNodes: CppNodeSpec[];
    /** 额外运行依赖 (已过滤默认依赖; 不含纯 Python 运行依赖) */
    extraDeps: string[];
    /** 纯 Python 运行依赖(仅 <exec_depend>; 含 config.pythonOnlyDeps ∪ 目录表 KNOWN_PYTHON_ONLY) */
    pythonOnlyDeps: string[];
    /** 该 kind 已内置的默认依赖 (用于额外依赖去重, 含 buildtool) */
    defaultDeps: readonly string[];
}

/**
 * 解析最终差异项: kind 默认值 + 用户覆盖 (节点名/额外依赖)。
 */
function resolveSpec(config: CppPackageConfig): KindSpec {
    log.trace(`解析包差异项:${config.kind} / ${config.packageName}`);
    const defaults = kindDefaults(config.kind, config.packageName);
    const spec: KindSpec = {
        ...defaults,
        variant: config.kind,
        extraDeps: [],
        pythonOnlyDeps: [],
        defaultDeps: KIND_DEFAULT_DEPS[config.kind],
    };
    if (config.cppNodes !== undefined) {
        spec.cppNodes = config.cppNodes.map(toSpec);
    }
    if (config.pythonNodes !== undefined) {
        spec.pythonNodes = config.pythonNodes.map(toSpec);
        // 同步重算 PROGRAMS 脚本路径 (按 kind 决定脚本/模块目录, 基名取 file)
        spec.pythonScriptPaths = spec.pythonNodes.map((py) =>
            config.kind === 'mixed' ? `${config.packageName}/${py.file}.py` : `scripts/${py.file}.py`);
    }
    // 额外依赖去重 + 通道拆分:
    //   纯 Python(调用方标注 ∪ 目录表 KNOWN_PYTHON_ONLY)→ 只作 Python 侧运行依赖(exec_depend);
    //   其余 → 构建/链接侧依赖(find_package + 节点宏 + 三标签)。
    const pyOnly = new Set<string>(config.pythonOnlyDeps ?? []);
    for (const d of config.extraDeps ?? []) {
        if (isKnownPythonOnly(d)) {
            pyOnly.add(d);
        }
    }
    // 构建/链接侧依赖: 去默认内置 + 剔纯 Python
    spec.extraDeps = (config.extraDeps || []).filter((d) => !spec.defaultDeps.includes(d) && !pyOnly.has(d));
    // 纯 Python 运行依赖: 保序去重(extraDeps 命中 KNOWN_PYTHON_ONLY ∪ 调用方 pythonOnlyDeps)
    const seen = new Set<string>();
    for (const d of (config.extraDeps ?? []).concat(config.pythonOnlyDeps ?? [])) {
        if (seen.has(d) || spec.defaultDeps.includes(d) || !pyOnly.has(d)) {
            continue;
        }
        seen.add(d);
        spec.pythonOnlyDeps.push(d);
    }
    return spec;
}

// ---------------------------------------------------------------------------
// 模板展开(核心纯函数)
// ---------------------------------------------------------------------------

/**
 * 按统一模板生成含 C++ 节点包的完整文件清单。
 * 不写盘、不依赖环境,返回 [路径, 内容] 列表,由调用方决定写盘。
 */
export function generateCppPackageFiles(config: CppPackageConfig): GeneratedFile[] {
    log.debug(l10n.t('C++ package file manifest: {0} ({1})', config.packageName, config.kind));
    const pkg = config.packageName;
    const spec = resolveSpec(config);
    const files: GeneratedFile[] = [];

    files.push({ path: 'CMakeLists.txt', content: renderCmakeLists(pkg, { ...spec, includeLayout: config.includeLayout }) });
    files.push({ path: 'package.xml', content: renderAmentCmakePackageXml(pkg, spec) });
    // 标准目录骨架: include/<pkg>/ 恒存在 (空目录, 不写占位文件)
    files.push({ path: `include/${pkg}/`, content: '', directory: true });

    if (spec.cppNodes.length > 0) {
        // 循环:为每个 C++ 节点生成源文件 (文件名用 file 基名, 节点名用 node)
        for (const n of spec.cppNodes) {
            files.push({ path: `src/${n.file}.cpp`, content: cppNodeSource(pkg, n.node) });
        }
    } else {
        // src/ 恒存在 (0 节点时为空目录, 不写占位文件)
        files.push({ path: 'src/', content: '', directory: true });
    }

    if (config.kind === 'mixed') {
        // 混合包: 模块安装必需 __init__.py (即使未生成节点文件)
        files.push({ path: `${pkg}/__init__.py`, content: `"""${pkg} 的 Python 模块 (供 import 复用)."""\n` });
    }
    // 循环:为每个 Python 节点生成脚本/模块文件 (文件名用 file 基名, 节点名用 node)
    // exec: 这些文件都经 install(PROGRAMS) 运行, 需要可执行位 (symlink 安装下源无 +x 会被 ros2 run 漏掉)
    for (const py of spec.pythonNodes) {
        if (config.kind === 'mixed') {
            // 模块形式: Python 文件位于包目录内 (file === node, 必须为标识符)
            files.push({ path: `${pkg}/${py.file}.py`, content: pyNodeSource(pkg, py.node), exec: true });
        } else {
            // 脚本形式: 位于 scripts/, 供 PROGRAMS 安装 (file 可含连字符)
            files.push({ path: `scripts/${py.file}.py`, content: pyNodeSource(pkg, py.node), exec: true });
        }
    }

    return files;
}
