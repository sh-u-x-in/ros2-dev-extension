// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file create-python-package.ts
 * 纯 Python 包(ament_python)生成器组装层 —— 纯逻辑、不依赖 VS Code / ROS 环境,
 * 可在任意 Node 环境(含 Windows)单独测试。
 *
 * 2026-09-04 结构重构(等价变换):本文件从 486 行瘦身为"组装 + 公共 API 门面"——
 *   - 校验/解析        → ../naming/names(公共命名层; 消除对 create-cpp-package 的反向 import);
 *   - package.xml      → ../templates/package-xml(与 ament_cmake 系共享依赖标签/组声明段);
 *   - setup.py/setup.cfg/lint 测试 → ../templates/py-setup;
 *   - Python 节点模板  → ../templates/py-node(全库唯一来源, 与 cpp-dual/mixed 共用);
 *   - GeneratedFile    → ../naming/generated-file(唯一定义)。
 * 本文件保留原文件名与全部对外符号(测试与交互层 import 兼容), 只做:过滤默认依赖 →
 * 按官方 ament_python 结构调模板 → 拼文件清单。生成内容与迁移前逐字节一致。
 */

import { getLogger } from "../../../../logger";
import { renderAmentPythonPackageXml } from '../templates/package-xml';
import { renderSetupPy, renderSetupCfg, LINT_TEST_FILES } from '../templates/py-setup';
import { pyNodeSource } from '../templates/py-node';
import type { GeneratedFile } from '../naming/generated-file';

// —— 公共 API 门面(符号自新模块转发, 兼容既有 import 路径) ——
export { validatePackageName, parseNodeNames, validateNodeNamesInput } from '../naming/names';
export type { GeneratedFile } from '../naming/generated-file';

/** 扩展日志薄封装(带 create-py-pkg 模块前缀) */
const log = getLogger("create-py-pkg");

// ---------------------------------------------------------------------------
// 类型定义(公共配置面)
// ---------------------------------------------------------------------------

/** 生成纯 Python 包的配置 */
export interface PythonPackageConfig {
    /** 包名(必须符合 ROS 命名规范) */
    packageName: string;
    /** 示范节点名列表(可为空) */
    nodeNames: string[];
    /** 额外运行依赖(追加 <depend>, 不含默认的 rclpy; 可为空) */
    extraDeps?: string[];
}

// ---------------------------------------------------------------------------
// 模板展开(核心纯函数)
// ---------------------------------------------------------------------------

/**
 * 按官方 ament_python 结构生成纯 Python 包的完整文件清单。
 * 不写盘、不依赖环境,返回 [路径, 内容] 列表,由调用方决定写盘。
 */
export function generatePythonPackageFiles(config: PythonPackageConfig): GeneratedFile[] {
    log.debug(`生成 Python 包文件清单:${config.packageName},${config.nodeNames.length} 个节点`);
    const pkg = config.packageName;
    const nodes = config.nodeNames;
    // 额外依赖去重: ament_python 默认已有 rclpy, 重复输入静默过滤
    const extraDeps = (config.extraDeps || []).filter((d) => d !== 'rclpy');
    const files: GeneratedFile[] = [];

    files.push({ path: 'package.xml', content: renderAmentPythonPackageXml(pkg, extraDeps) });
    files.push({ path: 'setup.py', content: renderSetupPy(pkg, nodes) });
    files.push({ path: 'setup.cfg', content: renderSetupCfg(pkg) });
    files.push({ path: `resource/${pkg}`, content: '' });
    files.push({ path: `${pkg}/__init__.py`, content: '' });
    files.push({ path: `${pkg}/py.typed`, content: '' });

    // 循环:为每个节点生成 Python 源文件(模板全库唯一来源 pyNodeSource)
    for (const node of nodes) {
        files.push({ path: `${pkg}/${node}.py`, content: pyNodeSource(pkg, node) });
    }

    for (const t of LINT_TEST_FILES) {
        files.push({ path: t.path, content: t.content });
    }

    return files;
}
