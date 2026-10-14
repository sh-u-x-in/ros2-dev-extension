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
 *
 * 教学注释 L10N(2026-10-12,用户裁定「路线 2」):全部教学散文注释以稳定 ID 查表
 * (源语言表 = l10n/templates/en.ts 英语源,译文表 = l10n/templates/zh-cn.ts 等),
 * 按 `lang` 出**单语**生成物(同文件内不再中英混排);**代码示例行/被注释掉的代码不译**,
 * 保持内联。缺省 "en" 时输出与历史英文版逐字节一致。
 */

import { getLogger } from "../../../../logger";
import { depTagClass } from '../deps/dep-catalog';
import { resolveCmakeStrings } from '../../../../../l10n/templates/index';
import type { TemplateCommentLang } from '../../../../../l10n/templates/index';
import type { CxxStandard } from "../../config/gen/distro-templates";

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
    /**
     * C++ 标准锁定(2026-10-13, 按机器发行版分派经 resolveCxxStandard 注入; 缺省 "17"):
     * dashing~foxy=14 / galactic~kilted=17 / lyrical=20 / 未知→17。经 guard 块写入 CMakeLists
     * (if NOT → set + REQUIRED), 外部 -DCMAKE_CXX_STANDARD 可覆盖。生成文本版本中立不写发行版名。
     */
    cxxStandard?: CxxStandard;
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
export function renderCmakeLists(pkg: string, spec: CmakeSpec, lang: TemplateCommentLang = "en"): string {
    const cppNodes = spec.cppNodes;
    const PN = cm('PROJECT_NAME'); // CMake 变量(项目名)
    const depNames = nodeDependencyNames(spec); // 每个 C++ 节点统一的依赖列表
    // std_msgs 特殊: 额外依赖命中时激活预留注释行, 不另追加
    const stdMsgsEnabled = spec.extraDeps.includes('std_msgs');
    const hasCpp = cppNodes.length > 0;
    const hasScripts = spec.pythonScriptPaths.length > 0;
    // 头文件布局按机器发行版分派(缺省 double; 文本两个变体都版本中立、不携带"约定"概念)
    const doubleLayout = (spec.includeLayout ?? 'double') === 'double';
    // 示例块通用拼接
    const depListStr = depNames.join(' ');

    // 教学注释表(按语种; 缺省 en 与历史英文版逐字节一致)
    const T = resolveCmakeStrings(lang, {
        pkg,
        PN,
        ver: CMAKE_MIN_VERSION,
        sampleExe: SAMPLE_EXE_NAME,
        sampleScript: SAMPLE_SCRIPT_PATH,
        curSrc: cm('CMAKE_CURRENT_SOURCE_DIR'),
    });

    log.trace(`展开 CMakeLists:${pkg}, C++ 节点 ${cppNodes.length} 个, Python 脚本 ${spec.pythonScriptPaths.length} 个, 模块安装 ${spec.enablePythonModule}`);

    const lines: string[] = [];

    // 头注释(按实际内容动态描述)
    lines.push(
        '# ============================================================',
        T.headerTitle,
        T.headerPurpose,
    );
    if (hasCpp) {
        lines.push(T.contentsCpp);
    }
    if (spec.enablePythonModule) {
        lines.push(T.contentsPyModule);
    }
    if (hasScripts) {
        lines.push(T.contentsPyScripts);
    }
    lines.push(
        '# ============================================================',
        '',
        T.minVersionComment,
        `cmake_minimum_required(VERSION ${CMAKE_MIN_VERSION})`,
        '',
        T.projectNameComment,
        `project(${pkg})`,
        '',
        // C++ 标准锁定(2026-10-13):guard 形态尊重外部 -DCMAKE_CXX_STANDARD 覆盖;值按发行版分派注入
        // (教学注释 2026-10-14 入 L10N 表——27952df 曾硬编码英文绕过模板注释体系,中文 UI 下全文件唯它混排)
        T.cxxStandardGuard,
        T.cxxStandardOverride,
        'if(NOT CMAKE_CXX_STANDARD)',
        `  set(CMAKE_CXX_STANDARD ${spec.cxxStandard ?? "17"})`,
        '  set(CMAKE_CXX_STANDARD_REQUIRED ON)',
        'endif()',
        '',
        T.compileOptions,
        'if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")',
        '  add_compile_options(-Wall -Wextra -Wpedantic)',
        'endif()',
        '',
    );

    // 依赖段: 真实生效的 find_package(分模块激活)
    lines.push(
        '########################################',
        T.depBanner,
        '########################################',
        '',
        T.depAment,
        'find_package(ament_cmake REQUIRED)',
        '',
        T.depRclcpp,
        'find_package(rclcpp REQUIRED)',
        '',
        T.depRclpy,
        spec.enableRclpy ? 'find_package(rclpy REQUIRED)' : '# find_package(rclpy REQUIRED)',
        '',
        T.depPyModule,
        spec.enablePythonModule ? 'find_package(ament_cmake_python REQUIRED)' : '# find_package(ament_cmake_python REQUIRED)',
        '',
        T.depStdMsgs,
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
        T.exampleMoreDeps,
        '# find_package(geometry_msgs REQUIRED)',
        T.exampleDepMsgPkg,
        T.exampleDepTip,
        '',
    );

    // 纯 Python 运行依赖注记(不 find_package; 供包内 Python 侧 import, package.xml 以 <exec_depend> 声明)
    if ((spec.pythonOnlyDeps?.length ?? 0) > 0) {
        lines.push(
            T.pyOnlyDepsTitle,
            `##   ${spec.pythonOnlyDeps!.join(', ')}`,
            T.pyOnlyDepsNote,
            '',
        );
    }

    // 构建段: 真实代码(节点编译 + 官方默认宏)
    lines.push(
        '###########',
        T.buildBanner,
        '###########',
        '',
        T.buildMinExe,
    );
    for (const n of cppNodes) {
        lines.push(`add_executable(${n.node} src/${n.file}.cpp)`);
    }
    if (!hasCpp) {
        lines.push(`# add_executable(${SAMPLE_EXE_NAME} src/${SAMPLE_EXE_NAME}.cpp)`);
    }
    lines.push(
        '',
        T.buildAttachDeps,
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
        T.addNodeExample,
        `# add_executable(${SAMPLE_EXE_NAME} src/${SAMPLE_EXE_NAME}.cpp)`,
        `# ament_target_dependencies(${SAMPLE_EXE_NAME} ${depListStr})`,
        T.addNodeHint,
        '',
    );

    // 直观示例块: 在本包"definition"新接口(msg/srv/action) —— 重实践: 独立成包一句 + 严重错误一条简注, 不展开机制
    lines.push(
        '####################################################',
        T.ifaceBanner,
        '####################################################',
        '',
        T.ifaceDedicated,
        T.ifaceXmlAdd,
        '#               + <exec_depend>rosidl_default_runtime</exec_depend>',
        '#               + <member_of_group>rosidl_interface_packages</member_of_group>',
        T.ifaceUsage,
        '# find_package(rosidl_default_generators REQUIRED)',
        `# rosidl_generate_interfaces(${PN}`,
        '#   "msg/MyMsg.msg"',
        '#   "srv/MySrv.srv"',
        T.ifaceDeps,
        '# )',
        '# ament_export_dependencies(rosidl_default_runtime)',
        '#',
        T.ifaceConflict,
        T.ifaceConflictWhy,
        T.ifaceUseOnly,
        '',
    );

    // 直观示例块: 让别人 include 你的头 / 链接你的库(库生产者场景; 布局按机器发行版分派, 文本只讲形态+简因)
    if (doubleLayout) {
        lines.push(
            '####################################################',
            T.exportBanner,
            '####################################################',
            '',
            T.headersTwoLevel,
            T.twoLevelSource,
            T.twoLevelConsumer,
            T.twoLevelAgree,
            T.twoLevelDest,
            T.mismatchNote,
            T.headerOnly,
            `# install(DIRECTORY include/${PN}/ DESTINATION include/${PN}/${PN})`,
            `# ament_export_include_directories(include/${PN})`,
            '#',
            T.realLibrary,
            `# add_library(${PN} SHARED src/my_class.cpp)`,
            `# target_include_directories(${PN} PUBLIC`,
            `#   $<BUILD_INTERFACE:${cm('CMAKE_CURRENT_SOURCE_DIR')}/include>   ${T.buildInterfaceComment}`,
            `#   $<INSTALL_INTERFACE:include/${PN}>   ${T.installInterfaceCommentDouble}`,
            '# )',
            `# install(TARGETS ${PN} EXPORT export_${PN}`,
            T.archiveDest,
            T.libraryDest,
            T.runtimeDest,
            `# ament_export_targets(export_${PN})`,
            '#',
            T.linkOwnLibrary,
            '# target_link_libraries(<node> ' + PN + ')',
            '',
        );
    } else {
        lines.push(
            '####################################################',
            T.exportBanner,
            '####################################################',
            '',
            T.headersSingleLevel,
            T.singleSource,
            T.singleConsumer,
            T.singleAgree,
            T.mismatchNote,
            T.headerOnly,
            `# install(DIRECTORY include/${PN}/ DESTINATION include)`,
            '# ament_export_include_directories(include)',
            '#',
            T.realLibrary,
            `# add_library(${PN} SHARED src/my_class.cpp)`,
            `# target_include_directories(${PN} PUBLIC`,
            `#   $<BUILD_INTERFACE:${cm('CMAKE_CURRENT_SOURCE_DIR')}/include>   ${T.buildInterfaceComment}`,
            '#   $<INSTALL_INTERFACE:include>   ' + T.installInterfaceCommentSingle,
            '# )',
            `# install(TARGETS ${PN} EXPORT export_${PN}`,
            T.archiveDest,
            T.libraryDest,
            T.runtimeDest,
            `# ament_export_targets(export_${PN})`,
            '#',
            T.linkOwnLibrary,
            '# target_link_libraries(<node> ' + PN + ')',
            '',
        );
    }

    // Python 模块段: 真实代码(分模块激活)
    lines.push(
        '########################################',
        T.pyModuleBanner,
        '########################################',
        '',
        T.pyModuleInstall,
        T.pyModuleDest,
        T.pyModuleReq,
        spec.enablePythonModule ? `ament_python_install_package(${PN})` : `# ament_python_install_package(${PN})`,
        '',
    );

    // 安装段: 真实代码(TARGETS / PROGRAMS) + 注释示例(DIRECTORY)
    lines.push(
        '#############',
        T.installBanner,
        '#############',
        '',
        T.installArtifacts,
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
        T.installScripts,
        T.execBitNote,
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
        T.dirBanner,
        T.dirLaunch,
        `# install(DIRECTORY launch`,
        `#   DESTINATION share/${PN})`,
        T.dirResource,
        '# install(DIRECTORY urdf',
        `#   DESTINATION share/${PN})`,
        '',
    );
    // include 安装示例: 与头文件块同一布局分派(文本自身版本中立)
    if (doubleLayout) {
        lines.push(
            T.dirBanner,
            T.dirIncludeTwo,
            T.dirIncludeTwoMore,
            `# install(DIRECTORY include/${PN}/`,
            `#   DESTINATION include/${PN}/${PN})`,
            '',
        );
    } else {
        lines.push(
            T.dirBanner,
            T.dirIncludeOne,
            T.dirIncludeOneMore,
            `# install(DIRECTORY include/${PN}/`,
            '#   DESTINATION include)',
            '',
        );
    }

    // 测试段(注释态, 直观块)
    lines.push(
        '#############',
        T.testBanner,
        '#############',
        '',
        T.testColcon,
        T.testLintEnable,
        '# if(BUILD_TESTING)',
        '#   find_package(ament_lint_auto REQUIRED)',
        T.testSkipCopyright,
        '#   set(ament_cmake_copyright_FOUND TRUE)',
        T.testSkipCpplint,
        '#   set(ament_cmake_cpplint_FOUND TRUE)',
        '#   ament_lint_auto_find_test_dependencies()',
        '# endif()',
        '',
        T.amentPackage,
        'ament_package()',
        '',
    );

    return lines.join('\n');
}
