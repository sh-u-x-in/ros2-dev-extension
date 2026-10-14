// Licensed under the MIT License.

/**
 * @file l10n/templates/en.ts
 * 【生成包模板教学注释 · 源语言表(英语源)】(2026-10-12 建立,用户裁定「路线 2」)
 *
 * 作用:包创建模板(cmake / package-xml / cpp-node / py-node / py-setup)生成物里的
 * 全部「教学散文注释」以本文件为**唯一英文源**(stable ID → 英文整句);各语种译文表
 * (如 ./zh-cn.ts)与本表**键集编译期强制一致**(缺译/多译直接编译红),渲染时按
 * `TemplateCommentLang` 二选一,输出物为**单语**(同文件内不再中英混排,根治市场 issue #5)。
 *
 * 边界(入表口径):
 *  · 只收「教学散文注释」;**代码示例行、被注释掉的代码、XML 标签、官方 lint 测试原文不译**(保持内联);
 *  · 含变量的条目由 ctx 构建器产出纯字符串(ctx = pkg / PN / 版本 / 示例名等,由模板层装配);
 *  · meta.ts 为纯值常量(版本号/license/占位维护者),无教学散文,不入表;
 *  · 本文件与 UI 文案机制(bundle.l10n.*.json + i18n 审计)**完全无涉**,两套并行互不干扰。
 *
 * 横向扩展:新增语言 = 仿照 ./zh-cn.ts 增加一个语种表文件(实现同一批 builder 签名)+ 在
 * ./index.ts 注册一行;模板代码零改动。
 */

// ---------------------------------------------------------------------------
// cmake 模板(CMakeLists.txt)
// ---------------------------------------------------------------------------

/** cmake 模板上下文(装配变量:包名 / CMake 变量文本 / 版本 / 示例名) */
export interface CmakeCtx {
    /** 包名 */
    pkg: string;
    /** CMake 项目变量文本(${PROJECT_NAME} 字面量) */
    PN: string;
    /** 最低 CMake 版本号 */
    ver: string;
    /** 注释示例中的占位可执行名 */
    sampleExe: string;
    /** 注释示例中的占位脚本路径 */
    sampleScript: string;
    /** CMake 当前源码目录变量文本(${CMAKE_CURRENT_SOURCE_DIR} 字面量) */
    curSrc: string;
}

/** cmake 模板英文注释表(键 = 稳定 ID;其余语种表必须同键集) */
export function buildCmakeEn(c: CmakeCtx) {
    return {
        // —— 头注释 / 工程段 ——
        headerTitle: `# ${c.pkg}/CMakeLists.txt: build script for a demo package (ament_cmake)`,
        headerPurpose: '# Purpose: defines how CMake builds and installs',
        contentsCpp: '# Contents: C++ nodes - compiled via add_executable, installed to lib/<pkg>/ via install(TARGETS) for ros2 run',
        contentsPyModule: '# Contents: Python modules - installed as importable modules via ament_python_install_package (requires <pkg>/__init__.py)',
        contentsPyScripts: '# Contents: Python scripts - installed to lib/<pkg>/ via install(PROGRAMS); the command name keeps .py (ros2 run pkg name.py)',
        minVersionComment: `# Minimum CMake version (${c.ver})`,
        projectNameComment: '# Project name (must match the <name> in package.xml)',
        cxxStandardGuard: '# Default to the C++ standard for this ROS 2 distribution;',
        cxxStandardOverride: '# pass -DCMAKE_CXX_STANDARD=<version> to override',
        compileOptions: '# ---- Compile options: enable warnings ----',
        // —— 依赖查找段 ——
        depBanner: '## Dependency lookup (mirrors <depend> in package.xml) ##',
        depAment: '## ament build system (required by every ament_cmake package)',
        depRclcpp: '## ROS 2 C++ client library (required by C++ nodes)',
        depRclpy: '## Python client library (import rclpy is guaranteed at runtime; find_package is a build-time check)',
        depPyModule: '## Provides the ament_python_install_package macro (Python module install)',
        depStdMsgs: '## Standard message types (enable when using std_msgs)',
        exampleMoreDeps: '# ----- Example: when more external packages are needed (uncomment; substitute real package/target names) -----',
        exampleDepMsgPkg: '# ament_target_dependencies(<target> geometry_msgs)   # message packages generate code via rosidl and export like ordinary libraries',
        exampleDepTip: '# Tip: runtime-only dependencies declared as <exec_depend> (launch_ros/turtlesim etc.) do not need find_package',
        pyOnlyDepsTitle: '## Pure-Python runtime dependencies (no CMake export; Python-side import only - no find_package needed or possible):',
        pyOnlyDepsNote: '## (already declared as <exec_depend> in package.xml; only Python code in the package imports them - the C++ side is unaffected)',
        // —— 构建段 ——
        buildBanner: '## Build ##',
        buildMinExe: '## Build the minimal executable (C++ node)',
        buildAttachDeps: '## Attach dependencies per target: one line for include + link (works with both modern target exports and legacy variable exports)',
        addNodeExample: '# ----- Example: three lines to add another C++ node (just uncomment) -----',
        addNodeHint: `# Also list ${c.sampleExe} in the install(TARGETS ...) call of the "install" section below`,
        // —— 接口定义示例块 ——
        ifaceBanner: '## Custom message/service/action interface generation (msg / srv / action) ##',
        ifaceDedicated: '# Interfaces belong in a dedicated CMake package (interfaces can only be defined in CMake packages; a dedicated package makes them easy to share)',
        ifaceXmlAdd: '#   add <buildtool_depend>rosidl_default_generators</buildtool_depend> to package.xml',
        ifaceUsage: '#   CMakeLists usage (uncomment and substitute your .msg/.srv files):',
        ifaceDeps: '#   DEPENDENCIES std_msgs      # <- external interface packages referenced by your .msg/.srv go here (propagated automatically)',
        ifaceConflict: '# Note: if this package also installs a same-named Python module via ament_python_install_package, the build fails outright',
        ifaceConflictWhy: '#       (rosidl generates Python code with the same name) - do not put interface definitions and Python module installs in the same package',
        ifaceUseOnly: '# If this package only *uses* an interface package (e.g. std_msgs): find_package it and add the name to ament_target_dependencies above',
        // —— 导出头文件/库示例块 ——
        exportBanner: '## Export headers/libraries (for others to #include / link) ##',
        headersTwoLevel: '# Headers install in a two-level layout (consistent with system packages like rclcpp/std_msgs):',
        twoLevelSource: '#   source include/<pkg>/x.hpp -> installed <prefix>/include/<pkg>/<pkg>/x.hpp',
        twoLevelConsumer: '#   consumers add -I <prefix>/include/<pkg> and keep writing #include <pkg>/x.hpp',
        twoLevelAgree: '#   Three places must agree: the export root (ament_export_include_directories) and INSTALL_INTERFACE both use include/<pkg>;',
        twoLevelDest: '#                 the install DESTINATION adds one package-name level under the export root = include/<pkg>/<pkg>',
        mismatchNote: '#   Any mismatch still compiles this package; the error surfaces downstream (headers not found at build/compile time)',
        headerOnly: '# (1) Header-only library: install + declare, two lines',
        realLibrary: '# (2) Real library with .cpp files: additionally "build the library + install with EXPORT + declare via export_targets"; the EXPORT name must match on both sides',
        archiveDest: '#   ARCHIVE DESTINATION lib      # static libraries',
        libraryDest: '#   LIBRARY DESTINATION lib      # shared libraries .so -> lib/ root',
        runtimeDest: '#   RUNTIME DESTINATION bin)     # executables/.dll',
        linkOwnLibrary: "# For this package's nodes to use its own library: link by bare name (the live target is in the same CMakeLists)",
        headersSingleLevel: '# Headers install in a single-level layout (consistent with system packages like rclcpp/std_msgs):',
        singleSource: '#   source include/<pkg>/x.hpp -> installed <prefix>/include/<pkg>/x.hpp',
        singleConsumer: '#   consumers add -I <prefix>/include and keep writing #include <pkg>/x.hpp',
        singleAgree: '#   Two places must agree: the export root (ament_export_include_directories) and INSTALL_INTERFACE both use include',
        buildInterfaceComment: '# this package\'s own build resolves from the source include/',
        installInterfaceCommentDouble: `# the consumer's -I root after export; same as the export root: include/${c.PN}`,
        installInterfaceCommentSingle: "# the consumer's -I root after export; same as the export root: include",
        // —— Python 模块段 ——
        pyModuleBanner: '## Python module installation (for import reuse) ##',
        pyModuleInstall: `## Install the ${c.pkg}/ directory as an importable Python module`,
        pyModuleDest: '## The destination is resolved automatically by this macro per build environment; no manual path needed',
        pyModuleReq: `## Requirement: ${c.pkg}/__init__.py must exist, otherwise the configure step fails outright`,
        // —— 安装段 ——
        installBanner: '## Install ##',
        installArtifacts: '## Build artifacts (executables/libraries) -> lib/<pkg>/, located by ros2 run',
        installScripts: '## Ready-made executable scripts (Python .py etc.) -> lib/<pkg>/ (shebang kept; the .py suffix stays in the ros2 run command name)',
        execBitNote: '## Executable bit: set by CMake on copy install; symlink install links to the source file, which must have the executable bit itself or it is silently skipped',
        dirBanner: '## DIRECTORY: installs a whole directory (recursive copy, no compilation)',
        dirLaunch: '## For: launch/ -> share/<pkg>/; ros2 launch <pkg> <file> looks the file up by name inside share/<pkg>/',
        dirResource: '## Similarly install resource dirs like urdf/ config/ (nodes/tools usually locate them via get_package_share_directory(<pkg>))',
        dirIncludeTwo: '## For: include/ -> include/<pkg>/<pkg>/ (two-level layout; export root / INSTALL_INTERFACE = include/<pkg>,',
        dirIncludeTwoMore: '##        the install destination gains one more package-name level - matching the export example block above)',
        dirIncludeOne: '## For: include/ -> include/<pkg>/ (single-level layout; export root / INSTALL_INTERFACE = include,',
        dirIncludeOneMore: '##        matching the export example block above)',
        // —— 测试段 / 收尾 ——
        testBanner: '## Test ##',
        testColcon: '## colcon build only builds and does not run tests; run tests with colcon test (summarize results with colcon test-result)',
        testLintEnable: '## Enable linting: (1) uncomment below (2) uncomment the two lint test_depend entries in package.xml (both required; lint packages must be installed)',
        testSkipCopyright: '#   # skip the copyright check (while no copyright headers yet; re-comment this line once all sources have headers)',
        testSkipCpplint: '#   # skip cpplint (it only works inside a git repository)',
        amentPackage: '## Declare the package configured (required at the end of every ament_cmake package)',
    };
}

/** cmake 模板注释表类型(zh 等语种表以此为键集契约) */
export type CmakeStrings = ReturnType<typeof buildCmakeEn>;

// ---------------------------------------------------------------------------
// package-xml 模板(package.xml)
// ---------------------------------------------------------------------------

/** package-xml 模板上下文 */
export interface XmlCtx {
    /** 包名 */
    pkg: string;
}

/** package-xml 模板英文注释表 */
export function buildXmlEn(c: XmlCtx) {
    return {
        headerManifest: `     ${c.pkg}/package.xml: package manifest for a demo package`,
        headerManifestPy: `     ${c.pkg}/package.xml: package manifest for a pure-Python package`,
        // —— 变体文案(顶部 Note 与 <description>) ——
        cppOnlyNote: 'Note: pure C++ node package (ament_cmake, no Python)',
        cppOnlyDesc: 'Pure C++ demo package (ament_cmake)',
        cppDualNote: 'Note: C++ node + Python scripts (dual-language package, ament_cmake; installed via PROGRAMS, the ros2 run name keeps .py)',
        cppDualDesc: 'Dual-language demo package (ament_cmake: C++ node + Python scripts)',
        mixedNote: 'Note: C++ node + Python module (mixed package, ament_cmake + ament_cmake_python)',
        mixedDesc: 'Mixed demo package (ament_cmake: C++ node + Python module)',
        // —— XML 教学注释 ——
        nameComment: '  <!-- Package name (globally unique; used for both build and run) -->',
        nameCommentPy: '  <!-- Package name -->',
        versionComment: '  <!-- Version -->',
        buildtoolComment: '  <!-- Buildtool depend: declares ament_cmake as the build system -->',
        buildtoolPyComment: '  <!-- Buildtool depend: ament_cmake_python is required for Python module installation -->',
        rclcppComment: '  <!-- Exec depend: C++ nodes need rclcpp -->',
        rclpyComment: '  <!-- Exec depend: Python nodes need rclpy -->',
        rclpyCommentPy: '  <!-- Exec depend: node code needs rclpy -->',
        pyOnlyComment: "  <!-- Exec depend: pure-Python package (no CMake export; imported by the package's Python code only; not part of the C++ build) -->",
        groupComment: '  <!-- Group membership: declares this package as part of rosidl_interface_packages (for interface providers; orthogonal to depend tags and required once msg/srv/action are added) -->',
        lintComment: '  <!-- Test depend: lint tools (not enabled; uncomment when needed) -->',
        lintPyComment: '  <!-- Test depend: lint tools and pytest -->',
        buildTypeCmake: '    <!-- Build type: tell colcon to build with CMake -->',
        buildTypePython: '    <!-- Build type: tell colcon to build with setuptools -->',
    };
}

/** package-xml 模板注释表类型 */
export type XmlStrings = ReturnType<typeof buildXmlEn>;

// ---------------------------------------------------------------------------
// cpp-node 模板(C++ 示范节点源)
// ---------------------------------------------------------------------------

/** cpp-node 模板上下文 */
export interface CppNodeCtx {
    /** 包名(仅出现在文件头注释) */
    pkg: string;
}

/** cpp-node 模板英文注释表 */
export function buildCppNodeEn(c: CppNodeCtx) {
    return {
        fileHeader: `${c.pkg} minimal demo node: subclasses rclcpp::Node, registers it and prints the node name (once)`,
        classInherit: '// inherits rclcpp::Node; the constructor initializes the parent with Node("Node name")',
        printOnce: '    // print the node name (once)',
        stepInit: '  // 1) initialize ROS 2',
        stepCreate: '  // 2) create the node instance (registered and printed at construction)',
        stepShutdown: '  // 3) release resources',
    };
}

/** cpp-node 模板注释表类型 */
export type CppNodeStrings = ReturnType<typeof buildCppNodeEn>;

// ---------------------------------------------------------------------------
// py-node 模板(Python 示范节点源)
// ---------------------------------------------------------------------------

/** py-node 模板上下文 */
export interface PyNodeCtx {
    /** 包名(出现在模块 docstring) */
    pkg: string;
}

/** py-node 模板英文注释表 */
export function buildPyNodeEn(c: PyNodeCtx) {
    return {
        moduleDocstring: `${c.pkg} minimal demo node: subclasses an rclpy Node, registers it and prints the node name (once).`,
        classInherit: "# subclass rclpy.node.Node; super().__init__('Node name') in the constructor",
        printOnce: '        # print the node name (once)',
        initNote: '    # rclpy.init() returns None; it cannot be used as a with-context manager;',
        flowNote: '    # standard flow = initialize -> create node -> destroy explicitly after use -> shutdown rclpy',
        registerNote: '    node = DemoNode()   # registered (and printed) at construction',
        destroyNote: '    node.destroy_node()  # release the node (demo does not spin; exits after use)',
    };
}

/** py-node 模板注释表类型 */
export type PyNodeStrings = ReturnType<typeof buildPyNodeEn>;

// ---------------------------------------------------------------------------
// py-setup 模板(setup.py / setup.cfg;官方 lint 测试原文不译)
// ---------------------------------------------------------------------------

/** py-setup 模板上下文 */
export interface PySetupCtx {
    /** 包名 */
    pkg: string;
}

/** py-setup 模板英文注释表 */
export function buildPySetupEn(c: PySetupCtx) {
    return {
        setupTitle: `# ${c.pkg}/setup.py: build script for a pure-Python package (ament_python)`,
        setupPurpose: '# Purpose: defines how setuptools packages and installs',
        setupNoCmake: '# Note: an ament_python package has no CMakeLists.txt; setup.py is the build entry',
        secBasic: '## Basic info ##',
        pkgNameComment: '# Package name (must match the <name> in package.xml)',
        secCollect: '## Module collection ##',
        collectComment: `# collect Python modules under the ${c.pkg}/ directory (excluding the test/ directory; directories without __init__.py are not packages anyway)`,
        secPkgData: '## Package data files (package_data) ##',
        pkgDataComment1: '# "non-.py" files inside the package (type markers/templates/json etc.) are not distributed by default; declare them here explicitly;',
        pkgDataComment2: '# destination = site-packages/<pkg>/ (same directory as the code, inside the import system, readable by importlib.resources).',
        pyTypedComment1: '# py.typed (PEP 561 type marker): must be declared explicitly to be installed with the package;',
        pyTypedComment2: '#   declaring it explicitly is harmless across setuptools versions; explicit is always the safest.',
        secDataFiles: '## Data files ##',
        amentIndexComment: `        # 1) ament index map marker (empty resource/${c.pkg} file): its presence lets ros2 tools locate this package's prefix`,
        pkgXmlInstallComment: `        # 2) install package.xml to share/<pkg>/ so ros2 pkg/colcon/rosdep etc. can read it at the conventional path`,
        secDeps: '## Dependencies ##',
        installRequiresComment: '# Python install dependencies (ROS dependencies are declared in package.xml)',
        testsRequireComment: '# test dependencies',
        secMeta: '## Package metadata ##',
        zipSafeComment: '# zip_safe=False: safest when the package ships data/binaries/extensions (reading files relative to __file__ fails in zip form)',
        secEntry: '## Node executable entry points ##',
        consoleScriptsComment: '# console_scripts defines the mapping from command name to module function entry',
        consoleFormatComment: "# format: 'command name = module path.function name'",
        consoleLibComment: `# generated commands are installed to lib/${c.pkg}/ (destination set by setup.cfg's install_scripts) for ros2 run to locate`,
        addNodeExample: '        # example: adding a new node (append as needed):',
        cfgTitle: `# ${c.pkg}/setup.cfg: packaging configuration complementing setup.py`,
        cfgPurpose: '# Purpose: specifies the install directory of executable commands',
    };
}

/** py-setup 模板注释表类型 */
export type PySetupStrings = ReturnType<typeof buildPySetupEn>;

// ---------------------------------------------------------------------------
// 生成层杂项(mixed 包 __init__.py docstring)
// ---------------------------------------------------------------------------

/** 生成层杂项上下文 */
export interface MiscCtx {
    /** 包名 */
    pkg: string;
}

/** 生成层杂项英文表(mixed 包 __init__.py 模块 docstring) */
export function buildMiscEn(c: MiscCtx) {
    return {
        initPyDocstring: `"""${c.pkg} Python module (for import reuse)."""`,
    };
}

/** 生成层杂项注释表类型 */
export type MiscStrings = ReturnType<typeof buildMiscEn>;
