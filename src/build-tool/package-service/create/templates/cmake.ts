// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file cmake.ts
 * CMakeLists.txt 模板(create/templates,2026-09-04 建立;知识修订 + 直观示例块回归)。
 *
 * 设计原则(依 知识/ament_cmake-场景卡速查 与用户评审):
 *   - **直观的代码块 + 注释 = 奇效**:凡包实际做的,给"live code"(可跑);
 *     包暂未做但常见要扩展的(加节点/头文件/库/消息接口/launch),给"fully commented example block",
 *     取消注释即用 —— 不写散文式说明代替代码。
 *   - 语义与知识一致:节点=可执行 → add_executable + 官方默认宏 ament_target_dependencies(M1);
 *     头文件/库公开、接口定义是独立场景,以注释代码块陈列,不默认执行;
 *     PROGRAMS 命令名带 .py;ros2 run 先经 share 地图定前缀再 os.walk lib/<pkg>。
 *
 * 扩展位: 顶部常量表允许变量替换; 每个场景一块独立代码段, 好改好抄。
 */

import { getLogger } from "../../../../logger";
import { depTagClass } from '../deps/dep-catalog';

/** 扩展日志薄封装(带 tmpl-cmake 模块前缀) */
const log = getLogger("tmpl-cmake");

// ---------------------------------------------------------------------------
// CMakeLists 常量表(允许变量替换: 调整生成内容只改此处)
// ---------------------------------------------------------------------------

/** 最低 CMake 版本(注释与 cmake_minimum_required 共用) */
export const CMAKE_MIN_VERSION = '3.20';

/** 注释示例中的占位可执行名(0 节点时 TARGETS/PROGRAMS 以注释示例呈现, 避免空参数报错) */
export const SAMPLE_EXE_NAME = 'Mycpp_node';
export const SAMPLE_SCRIPT_PATH = 'scripts/my_node.py';

/**
 * CMake 变量引用: 生成 `${NAME}` 文本。
 */
function cm(name: string): string {
    return '${' + name + '}';
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** renderCmakeLists 所需差异项(结构上与生成器 KindSpec 子集兼容) */
export interface CmakeSpec {
    /** C++ 节点清单(文件基名 file 写盘; 节点名 node 作 target) */
    cppNodes: { file: string; node: string }[];
    /** 是否启用 Python 客户端库 rclpy */
    enableRclpy: boolean;
    /** 是否启用 Python 模块安装(ament_cmake_python) */
    enablePythonModule: boolean;
    /** Python 脚本相对路径列表(PROGRAMS 安装) */
    pythonScriptPaths: string[];
    /** 额外运行依赖(已过滤内置默认依赖; 消费形态决定 find_package / 是否挂到节点) */
    extraDeps: string[];
    /** 纯 Python 运行依赖(无 CMake 导出; 仅供 Python 侧 import, 只注记不 find_package) */
    pythonOnlyDeps?: string[];
    /**
     * 头文件安装布局(按机器发行版分派, create 命令链经 resolveIncludeLayout 注入; 缺省 double):
     * double = 双层 include/<pkg>/<pkg>(humble~lyrical)/ single = 单层 include/<pkg>(dashing~galactic)。
     * 两个变体的注释文本都版本中立(不出现发行版名/"conventions"概念), 只讲形态 + 简因。
     */
    includeLayout?: "double" | "single";
}

/**
 * C++ 节点依赖(挂到 ament_target_dependencies):
 * rclcpp 恒有; 额外依赖只收"linkable at compile time"(C1 depend, 含 std_msgs 等消息包);
 * buildtool(C2)/exec(C3)/元包(C4)/演示(C5)不进链接列表。
 */
function nodeDependencyNames(spec: CmakeSpec): string[] {
    const names = ['rclcpp'];
    for (const d of spec.extraDeps) {
        if (depTagClass(d) === 'depend') {
            names.push(d);
        }
    }
    return names;
}

/**
 * ament_cmake 系 CMakeLists.txt.
 * 段序: 头注释 → 项目/编译选项 → 依赖查找 → 构建(真实代码 + 加节点示例块)
 *       → 接口定义示例块 → 头文件/库公开示例块 → Python 模块 → 安装(真实代码 + launch/include 示例块)
 *       → 测试 → ament_package()。
 */
export function renderCmakeLists(pkg: string, spec: CmakeSpec): string {
    const cppNodes = spec.cppNodes;
    const PN = cm('PROJECT_NAME'); // CMake 变量(项目名)
    const depNames = nodeDependencyNames(spec); // 每个 C++ 节点统一的依赖列表
    // std_msgs 特殊: 额外依赖命中时激活预留注释行, 不另追加
    const stdMsgsEnabled = spec.extraDeps.includes('std_msgs');
    const hasCpp = cppNodes.length > 0;
    const hasScripts = spec.pythonScriptPaths.length > 0;
    // 头文件布局按机器发行版分派(缺省 double; 文本两个变体都版本中立、不携带"conventions"概念)
    const doubleLayout = (spec.includeLayout ?? 'double') === 'double';
    // 示例块通用拼接
    const depListStr = depNames.join(' ');

    log.trace(`展开 CMakeLists:${pkg}, C++ 节点 ${cppNodes.length} 个, Python 脚本 ${spec.pythonScriptPaths.length} 个, 模块安装 ${spec.enablePythonModule}`);

    const lines: string[] = [];

    // 头注释(按实际内容动态描述)
    lines.push(
        '# ============================================================',
        `# ${pkg}/CMakeLists.txt: 示范包 (ament_cmake) 的构建脚本`,
        '# Purpose: defines how CMake builds and installs',
    );
    if (hasCpp) {
        lines.push('# Contents: C++ nodes - compiled via add_executable, installed to lib/<pkg>/ via install(TARGETS) for ros2 run');
    }
    if (spec.enablePythonModule) {
        lines.push('# Contents: Python modules - installed as importable modules via ament_python_install_package (requires <pkg>/__init__.py)');
    }
    if (hasScripts) {
        lines.push('# Contents: Python scripts - installed to lib/<pkg>/ via install(PROGRAMS); the command name keeps .py (ros2 run pkg name.py)');
    }
    lines.push(
        '# ============================================================',
        '',
        `# 最低 CMake 版本 (${CMAKE_MIN_VERSION})`,
        `cmake_minimum_required(VERSION ${CMAKE_MIN_VERSION})`,
        '',
        `# 项目名 (与 package.xml 的 <name> 一致)`,
        `project(${pkg})`,
        '',
        '# ---- Compile options: enable warnings ----',
        'if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")',
        '  add_compile_options(-Wall -Wextra -Wpedantic)',
        'endif()',
        '',
    );

    // 依赖段: 真实生效的 find_package(分模块激活)
    lines.push(
        '########################################',
        '## Dependency lookup (mirrors <depend> in package.xml) ##',
        '########################################',
        '',
        '## ament build system (required by every ament_cmake package)',
        'find_package(ament_cmake REQUIRED)',
        '',
        '## ROS 2 C++ client library (required by C++ nodes)',
        'find_package(rclcpp REQUIRED)',
        '',
        '## Python client library (import rclpy is guaranteed at runtime; find_package is a build-time check)',
        spec.enableRclpy ? 'find_package(rclpy REQUIRED)' : '# find_package(rclpy REQUIRED)',
        '',
        '## Provides the ament_python_install_package macro (Python module install)',
        spec.enablePythonModule ? 'find_package(ament_cmake_python REQUIRED)' : '# find_package(ament_cmake_python REQUIRED)',
        '',
        '## Standard message types (enable when using std_msgs)',
        stdMsgsEnabled ? 'find_package(std_msgs REQUIRED)' : '# find_package(std_msgs REQUIRED)',
    );
    // 真实生效的额外依赖 find_package: 只看 build+buildtool 消费形态(C1 depend / C2 buildtool)
    for (const d of spec.extraDeps) {
        const cls = depTagClass(d);
        if (cls !== 'buildtool' && cls !== 'depend') {
            continue;
        }
        if (d === 'std_msgs') {
            continue; // std_msgs 已在注释行位置激活, 不另追加
        }
        lines.push(`find_package(${d} REQUIRED)`);
    }
    // 直观示例块: 以后加消息/接口类依赖怎么找(取消注释 + 换包名)
    lines.push(
        '',
        '# ----- Example: when more external packages are needed (uncomment; substitute real package/target names) -----',
        '# find_package(geometry_msgs REQUIRED)',
        '# ament_target_dependencies(<target> geometry_msgs)   # message packages generate code via rosidl and export like ordinary libraries',
        '# Tip: runtime-only dependencies declared as <exec_depend> (launch_ros/turtlesim etc.) do not need find_package',
        '',
    );

    // 纯 Python 运行依赖注记(不 find_package; 供包内 Python 侧 import, package.xml 以 <exec_depend> 声明)
    if ((spec.pythonOnlyDeps?.length ?? 0) > 0) {
        lines.push(
            '## Pure-Python runtime dependencies (no CMake export; Python-side import only - no find_package needed or possible):',
            `##   ${spec.pythonOnlyDeps!.join(', ')}`,
            '## (already declared as <exec_depend> in package.xml; only Python code in the package imports them - the C++ side is unaffected)',
            '',
        );
    }

    // 构建段: 真实代码(节点编译 + 官方默认宏)
    lines.push(
        '###########',
        '## Build ##',
        '###########',
        '',
        '## Build the minimal executable (C++ node)',
    );
    for (const n of cppNodes) {
        lines.push(`add_executable(${n.node} src/${n.file}.cpp)`);
    }
    if (!hasCpp) {
        lines.push(`# add_executable(${SAMPLE_EXE_NAME} src/${SAMPLE_EXE_NAME}.cpp)`);
    }
    lines.push(
        '',
        '## Attach dependencies per target: one line for include + link (works with both modern target exports and legacy variable exports)',
    );
    for (const n of cppNodes) {
        lines.push(`ament_target_dependencies(${n.node} ${depListStr})`);
    }
    if (!hasCpp) {
        lines.push(`# ament_target_dependencies(${SAMPLE_EXE_NAME} ${depListStr})`);
    }
    // 直观示例块: 加一个"new node"只需三行(取消注释)
    lines.push(
        '',
        '# ----- Example: three lines to add another C++ node (just uncomment) -----',
        `# add_executable(${SAMPLE_EXE_NAME} src/${SAMPLE_EXE_NAME}.cpp)`,
        `# ament_target_dependencies(${SAMPLE_EXE_NAME} ${depListStr})`,
        `# 还应在下方 "install" 段的 install(TARGETS ...) 里一并列出 ${SAMPLE_EXE_NAME}`,
        '',
    );

    // 直观示例块: 在本包"definition"新接口(msg/srv/action) —— 重实践: 独立成包一句 + 严重错误一条简注, 不展开机制
    lines.push(
        '####################################################',
        '## Custom message/service/action interface generation (msg / srv / action) ##',
        '####################################################',
        '',
        '# Interfaces belong in a dedicated CMake package (interfaces can only be defined in CMake packages; a dedicated package makes them easy to share)',
        '#   add <buildtool_depend>rosidl_default_generators</buildtool_depend> to package.xml',
        '#               + <exec_depend>rosidl_default_runtime</exec_depend>',
        '#               + <member_of_group>rosidl_interface_packages</member_of_group>',
        '#   CMakeLists usage (uncomment and substitute your .msg/.srv files):',
        '# find_package(rosidl_default_generators REQUIRED)',
        `# rosidl_generate_interfaces(${PN}`,
        '#   "msg/MyMsg.msg"',
        '#   "srv/MySrv.srv"',
        '#   DEPENDENCIES std_msgs      # <- external interface packages referenced by your .msg/.srv go here (propagated automatically)',
        '# )',
        '# ament_export_dependencies(rosidl_default_runtime)',
        '#',
        '# Note: if this package also installs a same-named Python module via ament_python_install_package, the build fails outright',
        '#       (rosidl generates Python code with the same name) - do not put interface definitions and Python module installs in the same package',
        '# If this package only *uses* an interface package (e.g. std_msgs): find_package it and add the name to ament_target_dependencies above',
        '',
    );

    // 直观示例块: 让别人 include 你的头 / 链接你的库(库生产者场景; 布局按机器发行版分派, 文本只讲形态+简因)
    if (doubleLayout) {
        lines.push(
            '####################################################',
            '## Export headers/libraries (for others to #include / link) ##',
            '####################################################',
            '',
            'Headers install in a two-level layout (consistent with system packages like rclcpp/std_msgs):',
            '#   source include/<pkg>/x.hpp -> installed <prefix>/include/<pkg>/<pkg>/x.hpp',
            '#   consumers add -I <prefix>/include/<pkg> and keep writing #include <pkg>/x.hpp',
            '#   Three places must agree: the export root (ament_export_include_directories) and INSTALL_INTERFACE both use include/<pkg>;',
            '#                 the install DESTINATION adds one package-name level under the export root = include/<pkg>/<pkg>',
            '#   Any mismatch still compiles this package; the error surfaces downstream (headers not found at build/compile time)',
            '# (1) Header-only library: install + declare, two lines',
            `# install(DIRECTORY include/${PN}/ DESTINATION include/${PN}/${PN})`,
            `# ament_export_include_directories(include/${PN})`,
            '#',
            '# (2) Real library with .cpp files: additionally "build the library + install with EXPORT + declare via export_targets"; the EXPORT name must match on both sides',
            `# add_library(${PN} SHARED src/my_class.cpp)`,
            `# target_include_directories(${PN} PUBLIC`,
            `#   $<BUILD_INTERFACE:${cm('CMAKE_CURRENT_SOURCE_DIR')}/include>   # 本包自编译走源码 include`,
            `#   $<INSTALL_INTERFACE:include/${PN}>   # 导出后消费方 -I 的根, 与导出根同为 include/<包名>`,
            '# )',
            `# install(TARGETS ${PN} EXPORT export_${PN}`,
            '#   ARCHIVE DESTINATION lib      # static libraries',
            '#   LIBRARY DESTINATION lib      # shared libraries .so -> lib/ root',
            '#   RUNTIME DESTINATION bin)     # executables/.dll',
            `# ament_export_targets(export_${PN})`,
            '#',
            "# For this package's nodes to use its own library: link by bare name (the live target is in the same CMakeLists)",
            '# target_link_libraries(<node> ' + PN + ')',
            '',
        );
    } else {
        lines.push(
            '####################################################',
            '## Export headers/libraries (for others to #include / link) ##',
            '####################################################',
            '',
            'Headers install in a single-level layout (consistent with system packages like rclcpp/std_msgs):',
            '#   source include/<pkg>/x.hpp -> installed <prefix>/include/<pkg>/x.hpp',
            '#   consumers add -I <prefix>/include and keep writing #include <pkg>/x.hpp',
            '#   Two places must agree: the export root (ament_export_include_directories) and INSTALL_INTERFACE both use include',
            '#   Any mismatch still compiles this package; the error surfaces downstream (headers not found at build/compile time)',
            '# (1) Header-only library: install + declare, two lines',
            `# install(DIRECTORY include/${PN}/ DESTINATION include)`,
            '# ament_export_include_directories(include)',
            '#',
            '# (2) Real library with .cpp files: additionally "build the library + install with EXPORT + declare via export_targets"; the EXPORT name must match on both sides',
            `# add_library(${PN} SHARED src/my_class.cpp)`,
            `# target_include_directories(${PN} PUBLIC`,
            `#   $<BUILD_INTERFACE:${cm('CMAKE_CURRENT_SOURCE_DIR')}/include>   # 本包自编译走源码 include`,
            "#   $<INSTALL_INTERFACE:include>   # the consumer's -I root after export; same as the export root: include",
            '# )',
            `# install(TARGETS ${PN} EXPORT export_${PN}`,
            '#   ARCHIVE DESTINATION lib      # static libraries',
            '#   LIBRARY DESTINATION lib      # shared libraries .so -> lib/ root',
            '#   RUNTIME DESTINATION bin)     # executables/.dll',
            `# ament_export_targets(export_${PN})`,
            '#',
            "# For this package's nodes to use its own library: link by bare name (the live target is in the same CMakeLists)",
            '# target_link_libraries(<node> ' + PN + ')',
            '',
        );
    }

    // Python 模块段: 真实代码(分模块激活)
    lines.push(
        '########################################',
        '## Python module installation (for import reuse) ##',
        '########################################',
        '',
        `## 将 ${pkg}/ 目录安装为可 import 的 Python 模块`,
        `## 落点由本宏按构建机环境自动解析, 无需手动指定`,
        `## 约束: ${pkg}/__init__.py 必须存在, 否则配置期直接报错`,
        spec.enablePythonModule ? `ament_python_install_package(${PN})` : `# ament_python_install_package(${PN})`,
        '',
    );

    // 安装段: 真实代码(TARGETS / PROGRAMS) + 注释示例(DIRECTORY)
    lines.push(
        '#############',
        '## Install ##',
        '#############',
        '',
        '## Build artifacts (executables/libraries) -> lib/<pkg>/, located by ros2 run',
    );
    if (hasCpp) {
        lines.push(
            `install(TARGETS ${cppNodes.map((n) => n.node).join(' ')}`,
            `  DESTINATION lib/${PN})`,
        );
    } else {
        lines.push(
            `# install(TARGETS ${SAMPLE_EXE_NAME}`,
            `#   DESTINATION lib/${PN})`,
        );
    }
    lines.push(
        '',
        '## Ready-made executable scripts (Python .py etc.) -> lib/<pkg>/ (shebang kept; the .py suffix stays in the ros2 run command name)',
        '## Executable bit: set by CMake on copy install; symlink install links to the source file, which must have the executable bit itself or it is silently skipped',
    );
    if (hasScripts) {
        for (const sp of spec.pythonScriptPaths) {
            lines.push(
                `install(PROGRAMS ${sp}`,
                `  DESTINATION lib/${PN})`,
            );
        }
    } else {
        lines.push(
            `# install(PROGRAMS ${SAMPLE_SCRIPT_PATH}`,
            `#   DESTINATION lib/${PN})`,
        );
    }
    // 直观示例块: launch / 资源目录 → share/<包名>/ (ros2 launch 在 share 按文件名找)
    lines.push(
        '',
        '## DIRECTORY: installs a whole directory (recursive copy, no compilation)',
        '## For: launch/ -> share/<pkg>/; ros2 launch <pkg> <file> looks the file up by name inside share/<pkg>/',
        `# install(DIRECTORY launch`,
        `#   DESTINATION share/${PN})`,
        '## Similarly install resource dirs like urdf/ config/ (nodes/tools usually locate them via get_package_share_directory(<pkg>))',
        '# install(DIRECTORY urdf',
        `#   DESTINATION share/${PN})`,
        '',
    );
    // include 安装示例: 与头文件块同一布局分派(文本自身版本中立)
    if (doubleLayout) {
        lines.push(
            '## DIRECTORY: installs a whole directory (recursive copy, no compilation)',
            '## For: include/ -> include/<pkg>/<pkg>/ (two-level layout; export root / INSTALL_INTERFACE = include/<pkg>,',
            '##        the install destination gains one more package-name level - matching the export example block above)',
            `# install(DIRECTORY include/${PN}/`,
            `#   DESTINATION include/${PN}/${PN})`,
            '',
        );
    } else {
        lines.push(
            '## DIRECTORY: installs a whole directory (recursive copy, no compilation)',
            '## For: include/ -> include/<pkg>/ (single-level layout; export root / INSTALL_INTERFACE = include,',
            '##        matching the export example block above)',
            `# install(DIRECTORY include/${PN}/`,
            `#   DESTINATION include)`,
            '',
        );
    }

    // 测试段(注释态, 直观块)
    lines.push(
        '#############',
        '## Test ##',
        '#############',
        '',
        '## colcon build only builds and does not run tests; run tests with colcon test (summarize results with colcon test-result)',
        '## Enable linting: (1) uncomment below (2) uncomment the two lint test_depend entries in package.xml (both required; lint packages must be installed)',
        '# if(BUILD_TESTING)',
        '#   find_package(ament_lint_auto REQUIRED)',
        '#   # skip the copyright check (while no copyright headers yet; re-comment this line once all sources have headers)',
        '#   set(ament_cmake_copyright_FOUND TRUE)',
        '#   # skip cpplint (it only works inside a git repository)',
        '#   set(ament_cmake_cpplint_FOUND TRUE)',
        '#   ament_lint_auto_find_test_dependencies()',
        '# endif()',
        '',
        '## Declare the package configured (required at the end of every ament_cmake package)',
        'ament_package()',
        '',
    );

    return lines.join('\n');
}
