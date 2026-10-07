// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-xml.ts
 * package.xml 模板(create/templates,2026-09-04 结构重构建立)。
 *
 * 两份渲染函数收敛于此(曾分属 create-cpp-package.packageXmlTemplate 与
 * create-python-package.packageXmlTemplate, 依赖标签段/member_of_group 段逐字重复):
 *   - renderAmentCmakePackageXml   ament_cmake 系(cpp-only / cpp-dual / mixed);
 *   - renderAmentPythonPackageXml  ament_python 系(纯 Python)。
 * 共享段(依赖标签分类展开 / 接口意图组声明)抽为下方私有 helper, 全库唯一实现;
 * 元数据值经 ./meta PKG_META 引用(变量替换扩展位)。
 *
 * 内容与迁移前逐字节一致(结构重构硬约束)。
 */

import { depTagClass, hasInterfaceIntent } from '../deps/dep-catalog';
import { PKG_META, XML_DECL_LINES } from './meta';

/** ament_cmake 系 package.xml 渲染所需差异项(结构上与生成器 KindSpec 子集兼容) */
export interface AmentCmakeXmlSpec {
    /** 包类型变体(决定 description/Note文案, 保证名实相符): cpp-only / cpp-dual / mixed */
    variant: 'cpp-only' | 'cpp-dual' | 'mixed';
    /** 是否启用 Python 模块安装(ament_cmake_python): mixed = true */
    enablePythonModule: boolean;
    /** 是否启用 Python 客户端库 rclpy: cpp-dual / mixed = true, cpp-only = false */
    enableRclpy: boolean;
    /** Extra dependencies(已由生成层过滤内置默认依赖与纯 Python 依赖, 并按需分类) */
    extraDeps: string[];
    /** 纯 Python 运行依赖(无 CMake 导出; 仅 <exec_depend>, 供包内 Python 侧 import) */
    pythonOnlyDeps?: string[];
}

/** 变体 → package.xml 顶部"Note"与 <description> 文案(与生成内容名实相符) */
const VARIANT_XML_TEXT: Record<AmentCmakeXmlSpec['variant'], { note: string; desc: string }> = {
    'cpp-only': {
        note: 'Note: pure C++ node package (ament_cmake, no Python)',
        desc: 'Pure C++ demo package (ament_cmake)',
    },
    'cpp-dual': {
        note: 'Note: C++ node + Python scripts (dual-language package, ament_cmake; installed via PROGRAMS, the ros2 run name keeps .py)',
        desc: 'Dual-language demo package (ament_cmake: C++ node + Python scripts)',
    },
    'mixed': {
        note: 'Note: C++ node + Python module (mixed package, ament_cmake + ament_cmake_python)',
        desc: 'Mixed demo package (ament_cmake: C++ node + Python module)',
    },
};

/**
 * 追加"Extra dependencies"标签组(消费形态分类, 05 文档 §2):
 *   C1 depend → build + build_export + exec 三标签; C2 buildtool → buildtool_depend;
 *   C3/metapkg/demo → 仅 exec_depend。
 * 组前置空行; 组内按类型分组、组内无空行 —— 与迁移前逐字一致。
 */
function pushExtraDepTags(lines: string[], extraDeps: string[]): void {
    const buildtoolDeps = extraDeps.filter((d) => depTagClass(d) === 'buildtool');
    const dependDeps = extraDeps.filter((d) => depTagClass(d) === 'depend');
    const execDeps = extraDeps.filter((d) => {
        const c = depTagClass(d);
        return c === 'exec' || c === 'metapkg' || c === 'demo';
    });
    lines.push('');
    for (const d of buildtoolDeps) {
        lines.push(`  <buildtool_depend>${d}</buildtool_depend>`);
    }
    for (const d of dependDeps) {
        lines.push(`  <build_depend>${d}</build_depend>`);
    }
    for (const d of dependDeps) {
        lines.push(`  <build_export_depend>${d}</build_export_depend>`);
    }
    for (const d of [...dependDeps, ...execDeps]) {
        lines.push(`  <exec_depend>${d}</exec_depend>`);
    }
}

/**
 * 接口意图组声明(06 文档 §3 决策矩阵 #1-3):
 * 勾选同时含"generator-side >=1"且"runtime-side >=1"(标配对) → 注入
 * `<member_of_group>rosidl_interface_packages</member_of_group>`; 否则不加。
 */
function pushInterfaceGroup(lines: string[], extraDeps: string[]): void {
    if (hasInterfaceIntent(extraDeps)) {
        lines.push(
            '',
            '  <!-- Group membership: declares this package as part of rosidl_interface_packages (for interface providers; orthogonal to depend tags and required once msg/srv/action are added) -->',
            '  <member_of_group>rosidl_interface_packages</member_of_group>',
        );
    }
}

/**
 * ament_cmake 系 package.xml(简约路线, 不激活元素彻底不出现)。
 * 结构: 声明 + 头部注释 → 包名/版本/维护者/license → buildtool 组(ament_cmake [+ ament_cmake_python])
 *   → 空行 → 运行依赖组(rclcpp [+ rclpy]) → [Extra dependencies组] → [接口组] → 空行 → 测试段 → export → 收尾。
 */
export function renderAmentCmakePackageXml(pkg: string, spec: AmentCmakeXmlSpec): string {
    const txt = VARIANT_XML_TEXT[spec.variant];
    // 数组拼接, 显式控制块间空行:
    // buildtool 组(组内无空行) -> 空行 -> 运行依赖组(组内无空行) -> 空行 -> 测试段 -> 空行 -> export
    const lines: string[] = [
        ...XML_DECL_LINES,
        '<!-- ============================================================',
        `     ${pkg}/package.xml: 示范包的包清单`,
        `     ${txt.note}`,
        '     ============================================================ -->',
        '<package format="3">',
        '  <!-- Package name (globally unique; used for both build and run) -->',
        `  <name>${pkg}</name>`,
        '',
        '  <!-- Version -->',
        `  <version>${PKG_META.version}</version>`,
        '',
        `  <description>${txt.desc}</description>`,
        `  <maintainer email="${PKG_META.maintainerEmail}">${PKG_META.maintainerName}</maintainer>`,
        `  <license>${PKG_META.license}</license>`,
        '',
        '  <!-- Buildtool depend: declares ament_cmake as the build system -->',
        '  <buildtool_depend>ament_cmake</buildtool_depend>',
    ];
    if (spec.enablePythonModule) {
        lines.push(
            '  <!-- Buildtool depend: ament_cmake_python is required for Python module installation -->',
            '  <buildtool_depend>ament_cmake_python</buildtool_depend>',
        );
    }
    lines.push(
        '',
        '  <!-- Exec depend: C++ nodes need rclcpp -->',
        '  <depend>rclcpp</depend>',
    );
    if (spec.enableRclpy) {
        lines.push(
            '  <!-- Exec depend: Python nodes need rclpy -->',
            '  <depend>rclpy</depend>',
        );
    }
    if (spec.extraDeps.length > 0) {
        pushExtraDepTags(lines, spec.extraDeps);
    }
    pushInterfaceGroup(lines, spec.extraDeps);
    // 纯 Python 运行依赖: 无 CMake 导出 —— 仅 <exec_depend>(Python 侧 import 用), 不三标签、不 find_package
    const pyOnlyDeps = spec.pythonOnlyDeps ?? [];
    if (pyOnlyDeps.length > 0) {
        lines.push(
            '',
            "  <!-- Exec depend: pure-Python package (no CMake export; imported by the package's Python code only; not part of the C++ build) -->",
        );
        for (const d of pyOnlyDeps) {
            lines.push(`  <exec_depend>${d}</exec_depend>`);
        }
    }
    lines.push(
        '',
        '  <!-- Test depend: lint tools (not enabled; uncomment when needed) -->',
        '  <!-- <test_depend>ament_lint_auto</test_depend> -->',
        '  <!-- <test_depend>ament_lint_common</test_depend> -->',
        '',
        '  <export>',
        '    <!-- Build type: tell colcon to build with CMake -->',
        '    <build_type>ament_cmake</build_type>',
        '  </export>',
        '</package>',
        '',
    );
    return lines.join('\n');
}

/**
 * ament_python 系 package.xml(简约风格: 无 buildtool 组, rclpy 后直接追加Extra dependencies)。
 * 结构: 声明 + 头部注释 → 包名/版本/维护者/license → 空行 → rclpy → [Extra dependencies组]
 *   → [接口组] → 空行 → 测试段 → export → 收尾。
 */
export function renderAmentPythonPackageXml(pkg: string, extraDeps: string[]): string {
    // 数组拼接, 简约风格: rclpy 后直接追加Extra dependencies, 再空行接测试段
    const lines: string[] = [
        ...XML_DECL_LINES,
        '<!-- ============================================================',
        `     ${pkg}/package.xml: 纯 Python 包的包清单`,
        '     structure note: an ament_python package has no <buildtool_depend> tag',
        '     ============================================================ -->',
        '<package format="3">',
        '  <!-- Package name -->',
        `  <name>${pkg}</name>`,
        '',
        '  <!-- Version -->',
        `  <version>${PKG_META.version}</version>`,
        '',
        '  <description>Pure-Python demo package (ament_python)</description>',
        `  <maintainer email="${PKG_META.maintainerEmail}">${PKG_META.maintainerName}</maintainer>`,
        `  <license>${PKG_META.license}</license>`,
        '',
        '  <!-- Exec depend: node code needs rclpy -->',
        '  <depend>rclpy</depend>',
    ];
    if (extraDeps.length > 0) {
        pushExtraDepTags(lines, extraDeps);
    }
    pushInterfaceGroup(lines, extraDeps);
    lines.push(
        '',
        '  <!-- Test depend: lint tools and pytest -->',
        '  <!-- <test_depend>ament_copyright</test_depend> -->',
        '  <!-- <test_depend>ament_flake8</test_depend> -->',
        '  <!-- <test_depend>ament_mypy</test_depend> -->',
        '  <!-- <test_depend>ament_pep257</test_depend> -->',
        '  <!-- <test_depend>ament_xmllint</test_depend> -->',
        '  <!-- <test_depend>python3-pytest</test_depend> -->',
        '',
        '  <export>',
        '    <!-- Build type: tell colcon to build with setuptools -->',
        '    <build_type>ament_python</build_type>',
        '  </export>',
        '</package>',
        '',
    );
    return lines.join('\n');
}
