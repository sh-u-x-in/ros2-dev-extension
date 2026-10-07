// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file kinds.ts
 * 包类型(kind)注册表(create 子域,2026-09-04 结构重构建立)。
 *
 * 此前 kind 默认配置散落于 create-cpp-package.kindSpec 的 switch 分支, 而
 * "内置默认依赖"又在 dep-parse.DEP_BUILTIN 各写一份(两份清单靠注释约定对齐);
 * 本文件把"kind 是什么"收敛为**单一数据源**:
 *   - DepCheckKind / CppPackageKind: 类型全集;
 *   - KIND_DEFAULT_DEPS: 每 kind 内置默认依赖(生成层过滤额外依赖 + dep 域静默去重共用);
 *   - kindDefaults(): 每 kind 默认示范节点 / 脚本路径 / 开关(取代 kindSpec 三分支)。
 *
 * 扩展位: 新增包类型(如未来补"纯 C++ 包"UI 入口或新形态) = 加一个 kind 数据行,
 * 生成器与 dep 域零改动。cpp-only 目前无 UI 入口但被测试作为"纯 C++ 包"配置
 * (对应《三种构建方式定义》#1)充分使用, 必须保留为一等 kind。
 *
 * 纯数据 + 纯函数, 零依赖(仅取 ./names 的 CppNodeSpec 类型), 可单测。
 */

import type { CppNodeSpec } from './naming/names';

/** 校验/去重所需的包类型(与生成器 kind 一致, 外加纯 Python) */
export type DepCheckKind = 'cpp-only' | 'cpp-dual' | 'mixed' | 'python';

/** 含 C++ 节点的包类型(生成器 kind; python = ament_python 不含 C++) */
export type CppPackageKind = Exclude<DepCheckKind, 'python'>;

/**
 * 各 kind 内置默认依赖(单一来源; 兼作 dep 域 DEP_BUILTIN 与生成层默认依赖过滤):
 *   - cpp-only: ament_cmake(构建系统) + rclcpp(C++ 客户端库);
 *   - cpp-dual: 上述 + rclpy(Python 脚本运行时 import);
 *   - mixed:    上述 + ament_cmake_python(Python 模块安装宏);
 *   - python:   rclpy(ament_python 唯一语言运行时)。
 */
export const KIND_DEFAULT_DEPS: Record<DepCheckKind, readonly string[]> = {
    'cpp-only': ['ament_cmake', 'rclcpp'],
    'cpp-dual': ['ament_cmake', 'rclcpp', 'rclpy'],
    'mixed': ['ament_cmake', 'rclcpp', 'rclpy', 'ament_cmake_python'],
    'python': ['rclpy'],
};

/** kind 默认内容行(生成器 resolveSpec 的起点; python 行不使用本表, 由 ament_python 生成器自理) */
export interface KindNodeDefaults {
    /** C++ 节点清单(文件基名 + 节点名) */
    cppNodes: CppNodeSpec[];
    /** 是否启用 Python 客户端库 rclpy */
    enableRclpy: boolean;
    /** 是否启用 Python 模块安装(ament_cmake_python) */
    enablePythonModule: boolean;
    /** Python 脚本相对路径列表(PROGRAMS 安装; mixed = <pkg>/, 其余 = scripts/) */
    pythonScriptPaths: string[];
    /** Python 节点清单(脚本或模块) */
    pythonNodes: CppNodeSpec[];
}

/**
 * 各 kind 默认示范节点/开关(与迁移前 kindSpec 逐字一致)。
 * @param kind 包类型(cpp-only / cpp-dual / mixed)
 * @param pkg  包名(mixed 的模块脚本路径需要 <pkg>/ 前缀)
 */
export function kindDefaults(kind: CppPackageKind, pkg: string): KindNodeDefaults {
    switch (kind) {
        case 'cpp-only':
            return {
                cppNodes: [
                    { file: 'cpp_node_1', node: 'cpp_node_1' },
                    { file: 'cpp_node_2', node: 'cpp_node_2' },
                ],
                enableRclpy: false,
                enablePythonModule: false,
                pythonScriptPaths: [],
                pythonNodes: [],
            };
        case 'cpp-dual':
            return {
                cppNodes: [{ file: 'cpp_node_1', node: 'cpp_node_1' }],
                enableRclpy: true,
                enablePythonModule: false,
                pythonScriptPaths: ['scripts/py_node.py'],
                pythonNodes: [{ file: 'py_node', node: 'py_node' }],
            };
        case 'mixed':
            return {
                cppNodes: [{ file: 'cpp_node_1', node: 'cpp_node_1' }],
                enableRclpy: true,
                enablePythonModule: true,
                pythonScriptPaths: [`${pkg}/py_node_1.py`],
                pythonNodes: [{ file: 'py_node_1', node: 'py_node_1' }],
            };
    }
}
