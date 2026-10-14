// Licensed under the MIT License.

/**
 * @file l10n/templates/zh-cn.ts
 * 【生成包模板教学注释 · 简体中文译文表】(2026-10-12 建立)
 *
 * 作用:与 ./en.ts(源语言表)**同键集**的简体中文译文——类型标注强制键集一致,
 * 漏译/多译在编译期直接报错。值 = 生成物注释的中文整句;cmake 列取自范本评审定稿的
 * 中文原文(ab04792 英文化前的逐行对照),其余取自各模板英文化前的现行中文。
 * 渲染时由 ./index.ts 按 UI 语言分派;输出物单语,同文件内不与英文混排。
 *
 * 横向扩展:新增语种 = 仿照本文件增加 `ja.ts` 等表文件(实现同一批 builder 签名)+
 * 在 ./index.ts 注册;模板代码零改动。
 */

import {
    buildCmakeEn, buildXmlEn, buildCppNodeEn, buildPyNodeEn, buildPySetupEn, buildMiscEn,
    type CmakeCtx, type XmlCtx, type CppNodeCtx, type PyNodeCtx, type PySetupCtx, type MiscCtx,
    type CmakeStrings, type XmlStrings, type CppNodeStrings, type PyNodeStrings, type PySetupStrings, type MiscStrings,
} from "./en";

/** cmake 模板中文注释表(键集 = CmakeStrings,编译期强制) */
export function buildCmakeZh(c: CmakeCtx): CmakeStrings {
    return {
        headerTitle: `# ${c.pkg}/CMakeLists.txt: 示范包 (ament_cmake) 的构建脚本`,
        headerPurpose: '# 作用: 定义 CMake 编译与安装方式',
        contentsCpp: '# 内容: C++ 节点 —— add_executable 编译, install(TARGETS) 装至 lib/<pkg>/, 供 ros2 run',
        contentsPyModule: '# 内容: Python 模块 —— ament_python_install_package 装为可 import 模块 (需 <pkg>/__init__.py)',
        contentsPyScripts: '# 内容: Python 脚本 —— install(PROGRAMS) 装至 lib/<pkg>/, 命令名带 .py (ros2 run 包名.py)',
        minVersionComment: `# 最低 CMake 版本 (${c.ver})`,
        projectNameComment: '# 项目名 (与 package.xml 的 <name> 一致)',
        cxxStandardGuard: '# 默认采用当前 ROS 2 发行版的 C++ 标准;',
        cxxStandardOverride: '# 传 -DCMAKE_CXX_STANDARD=<version> 可覆盖',
        compileOptions: '# ---- 编译选项: 开启警告 ----',
        depBanner: '## 依赖查找 (对应 package.xml 的 <depend>) ##',
        depAment: '## ament 构建系统 (每个 ament_cmake 包必需)',
        depRclcpp: '## ROS 2 的 C++ 客户端库 (C++ 节点依赖它)',
        depRclpy: '## Python 客户端库 (import rclpy 由运行环境保证; find_package 为构建期校验)',
        depPyModule: '## 提供 ament_python_install_package 宏 (Python 模块安装)',
        depStdMsgs: '## 标准消息类型 (使用 std_msgs 时启用)',
        exampleMoreDeps: '# ----- 示例: 需要更多外部包时的写法 (取消注释, 包名/目标名都换成实际值) -----',
        exampleDepMsgPkg: '# ament_target_dependencies(<目标名> geometry_msgs)   # 消息包经 rosidl 生成代码并导出, 用法与普通库相同',
        exampleDepTip: '# 提示: 只声明 <exec_depend> 的运行类依赖 (launch_ros/turtlesim 等) 不需要 find_package',
        pyOnlyDepsTitle: '## 纯 Python 运行依赖 (无 CMake 导出, 只供 Python 侧 import —— 不需要也不能 find_package):',
        pyOnlyDepsNote: '## (已在 package.xml 以 <exec_depend> 声明; 包内 Python 代码要 import 的就是它们, C++ 侧不受影响)',
        buildBanner: '## 构建 ##',
        buildMinExe: '## 编译最小可执行文件 (C++ 节点)',
        buildAttachDeps: '## 给每个目标挂依赖: 一行完成 include + 链接 (依赖包按新式 targets 或旧式变量导出均支持)',
        addNodeExample: '# ----- 示例: 再加一个 C++ 节点的三行写法 (取消注释即可) -----',
        addNodeHint: `# 还应在下方 "安装" 段的 install(TARGETS ...) 里一并列出 ${c.sampleExe}`,
        ifaceBanner: '## 自定义消息/服务/动作接口生成 (msg / srv / action) ##',
        ifaceDedicated: '# 接口建议放独立 CMake 包 (接口只能在 CMake 包中定义, 独立成包便于多包共用):',
        ifaceXmlAdd: '#   package.xml 加 <buildtool_depend>rosidl_default_generators</buildtool_depend>',
        ifaceUsage: '#   CMakeLists 写法 (取消注释 + 换成你的 .msg/.srv 文件):',
        ifaceDeps: '#   DEPENDENCIES std_msgs      # ← .msg/.srv 里引用到的外部接口包写这里 (会被自动传递)',
        ifaceConflict: '# 注意: 本包若同时用 ament_python_install_package 装同名 Python 模块, 构建会直接失败',
        ifaceConflictWhy: '#       (rosidl 生成的 Python 代码与它同名) —— 接口定义与 Python 模块安装不要放在同一个包',
        ifaceUseOnly: '# 本包若只是"使用"接口包 (如 std_msgs): find_package 后把包名加进上方 ament_target_dependencies 即可',
        exportBanner: '## 对外提供头文件/库 (让别人 #include / 链接) ##',
        headersTwoLevel: '# 头文件安装为双层布局 (与 rclcpp/std_msgs 等系统包一致):',
        twoLevelSource: '#   源码 include/<包名>/x.hpp → 安装后 <prefix>/include/<包名>/<包名>/x.hpp',
        twoLevelConsumer: '#   消费方 -I <prefix>/include/<包名> 后照常写 #include <包名>/x.hpp',
        twoLevelAgree: '#   三处必须对齐: 导出根(ament_export_include_directories) 与 INSTALL_INTERFACE 同为 include/<包名>;',
        twoLevelDest: '#                 安装落点(DESTINATION) 在导出根下再多一层包名 = include/<包名>/<包名>',
        mismatchNote: '#   任一处错配: 本包编译照常通过, 错误发生在下游 (构建/编译期找不到头文件)',
        headerOnly: '# ① 纯头文件 (header-only): 装箱 + 公告, 两行',
        realLibrary: '# ② 有 .cpp 的真库: 再加"造库 + 装箱(EXPORT) + 公告(export_targets)", EXPORT 名两边必须一致',
        archiveDest: '#   ARCHIVE DESTINATION lib      # 静态库',
        libraryDest: '#   LIBRARY DESTINATION lib      # 共享库 .so → lib/ 根',
        runtimeDest: '#   RUNTIME DESTINATION bin)     # 可执行/.dll',
        linkOwnLibrary: '# 本包节点要用自家库: 直接裸名链接 (活目标在同一个 CMakeLists 里)',
        headersSingleLevel: '# 头文件安装为单层布局 (与 rclcpp/std_msgs 等系统包一致):',
        singleSource: '#   源码 include/<包名>/x.hpp → 安装后 <prefix>/include/<包名>/x.hpp',
        singleConsumer: '#   消费方 -I <prefix>/include 后照常写 #include <包名>/x.hpp',
        singleAgree: '#   两处必须对齐: 导出根(ament_export_include_directories) 与 INSTALL_INTERFACE 同为 include',
        buildInterfaceComment: '# 本包自编译走源码 include',
        installInterfaceCommentDouble: `# 导出后消费方 -I 的根, 与导出根同为 include/${c.PN}`,
        installInterfaceCommentSingle: '# 导出后消费方 -I 的根, 与导出根同为 include',
        pyModuleBanner: '## Python 模块安装 (供 import 复用) ##',
        pyModuleInstall: `## 将 ${c.pkg}/ 目录安装为可 import 的 Python 模块`,
        pyModuleDest: '## 落点由本宏按构建机环境自动解析, 无需手动指定',
        pyModuleReq: `## 约束: ${c.pkg}/__init__.py 必须存在, 否则配置期直接报错`,
        installBanner: '## 安装 ##',
        installArtifacts: '## 编译产物 (可执行/库) → lib/<包名>/, 供 ros2 run 定位',
        installScripts: '## 现成可执行脚本 (Python .py 等) → lib/<包名>/ (保留 shebang; 文件名带 .py, ros2 run 命令名随之)',
        execBitNote: '## 可执行位: 拷贝安装由 CMake 设置; 符号安装链接到源文件, 源文件须自身有可执行位, 否则被静默跳过',
        dirBanner: '## DIRECTORY: 安装整个目录 (递归复制, 不编译)',
        dirLaunch: '## 用于: launch/ 装至 share/<包名>/; ros2 launch <包> <文件名> 在 share/<包名>/ 内按文件名查找',
        dirResource: '## 同理可装 urdf/ config/ 等资源目录 (节点/工具通常经 get_package_share_directory(<包>) 定位)',
        dirIncludeTwo: '## 用于: include/ 装至 include/<包名>/<包名>/ (双层布局; 导出根 / INSTALL_INTERFACE = include/<包名>,',
        dirIncludeTwoMore: '##        安装落点再多一层包名 —— 与上方"对外提供头文件/库"示例块一致)',
        dirIncludeOne: '## 用于: include/ 装至 include/<包名>/ (单层布局; 导出根 / INSTALL_INTERFACE = include,',
        dirIncludeOneMore: '##        与上方"对外提供头文件/库"示例块一致)',
        testBanner: '## 测试 ##',
        testColcon: '## colcon build 只构建不运行测试; 测试用 colcon test 运行 (结果用 colcon test-result 汇总)',
        testLintEnable: '## 启用 lint: ① 取消下方注释 ② 取消 package.xml 里两个 lint test_depend 注释 (二者缺一不可; lint 包需已安装)',
        testSkipCopyright: '#   # 跳过版权检查 (未添加版权头时; 全部源文件加了版权头后注掉本行即可恢复)',
        testSkipCpplint: '#   # 跳过 cpplint 检查 (cpplint 只在 git 仓库中有效)',
        amentPackage: '## 声明包配置完成 (每个 ament_cmake 包末尾必需)',
    };
}

/** package-xml 模板中文注释表(键集 = XmlStrings,编译期强制) */
export function buildXmlZh(c: XmlCtx): XmlStrings {
    return {
        headerManifest: `     ${c.pkg}/package.xml: 示范包的包清单`,
        headerManifestPy: `     ${c.pkg}/package.xml: 纯 Python 包的包清单`,
        cppOnlyNote: '说明: 纯 C++ 节点包 (ament_cmake, 无 Python)',
        cppOnlyDesc: '纯 C++ 示范包 (ament_cmake)',
        cppDualNote: '说明: C++ 节点 + Python 脚本 (双语言包, ament_cmake; 经 PROGRAMS 安装, ros2 run 命令名保留 .py)',
        cppDualDesc: '双语言示范包 (ament_cmake: C++ 节点 + Python 脚本)',
        mixedNote: '说明: C++ 节点 + Python 模块 (混合包, ament_cmake + ament_cmake_python)',
        mixedDesc: '混合示范包 (ament_cmake: C++ 节点 + Python 模块)',
        nameComment: '  <!-- 包名 (全局唯一; 构建与运行都用它) -->',
        nameCommentPy: '  <!-- 包名 -->',
        versionComment: '  <!-- 版本 -->',
        buildtoolComment: '  <!-- 构建工具依赖: 声明 ament_cmake 为构建系统 -->',
        buildtoolPyComment: '  <!-- 构建工具依赖: 安装 Python 模块需要 ament_cmake_python -->',
        rclcppComment: '  <!-- 运行依赖: C++ 节点需要 rclcpp -->',
        rclpyComment: '  <!-- 运行依赖: Python 节点需要 rclpy -->',
        rclpyCommentPy: '  <!-- 运行依赖: 节点代码需要 rclpy -->',
        pyOnlyComment: '  <!-- 运行依赖: 纯 Python 包 (无 CMake 导出; 仅包内 Python 代码 import; 不参与 C++ 构建) -->',
        groupComment: '  <!-- 组成员声明: 声明本包属于 rosidl_interface_packages (面向接口提供方; 与 depend 标签互不相干, 添加 msg/srv/action 后需要一次) -->',
        lintComment: '  <!-- 测试依赖: lint 工具 (未启用; 需要时取消注释) -->',
        lintPyComment: '  <!-- 测试依赖: lint 工具与 pytest -->',
        buildTypeCmake: '    <!-- 构建类型: 告知 colcon 用 CMake 构建 -->',
        buildTypePython: '    <!-- 构建类型: 告知 colcon 用 setuptools 构建 -->',
    };
}

/** cpp-node 模板中文注释表(键集 = CppNodeStrings,编译期强制) */
export function buildCppNodeZh(c: CppNodeCtx): CppNodeStrings {
    return {
        fileHeader: `${c.pkg} 最小示范节点: 继承 rclcpp::Node 注册节点 + 打印Node name (一次)`,
        classInherit: '// 继承 rclcpp::Node, 构造函数里用 Node("Node name") 初始化父类',
        printOnce: '    // 打印Node name (只打印一次)',
        stepInit: '  // 1) 初始化 ROS 2',
        stepCreate: '  // 2) 创建节点实例 (构造时即注册节点并打印)',
        stepShutdown: '  // 3) 释放资源',
    };
}

/** py-node 模板中文注释表(键集 = PyNodeStrings,编译期强制) */
export function buildPyNodeZh(c: PyNodeCtx): PyNodeStrings {
    return {
        moduleDocstring: `${c.pkg} 最小示范节点: 继承 rclpy Node, 注册节点并打印节点名 (一次)。`,
        classInherit: "# 继承 rclpy.node.Node, 构造函数里 super().__init__('Node name')",
        printOnce: '        # 打印Node name (只打印一次)',
        initNote: '    # rclpy.init() 返回 None, 不能当 with 上下文管理器用;',
        flowNote: '    # 标准流程 = 初始化 → 建节点 → 用毕显式释放 → 关闭 rclpy',
        registerNote: '# 构造时即注册节点并打印',
        destroyNote: '# 释放节点 (示范代码不 spin, 用完即退)',
    };
}

/** py-setup 模板中文注释表(键集 = PySetupStrings,编译期强制) */
export function buildPySetupZh(c: PySetupCtx): PySetupStrings {
    return {
        setupTitle: `# ${c.pkg}/setup.py: 纯 Python 包 (ament_python) 的构建脚本`,
        setupPurpose: '# 作用: 定义 setuptools 的打包与安装方式',
        setupNoCmake: '# Note: ament_python 包无 CMakeLists.txt, 构建入口为 setup.py',
        secBasic: '## 基础信息 ##',
        pkgNameComment: '# 包名 (与 package.xml 的 <name> 一致)',
        secCollect: '## 模块收集 ##',
        collectComment: `# 收集 ${c.pkg}/ 目录下的 Python 模块 (排除 test/ 测试目录; 无 __init__.py 的目录本就不算包)`,
        secPkgData: '## 包内数据文件 (package_data) ##',
        pkgDataComment1: '# 包内"non-.py"文件(类型标记/模板/json 等)默认不随包分发, 须在此显式声明;',
        pkgDataComment2: '# 落点 = site-packages/<pkg>/ (与代码同目录, import 体系内, importlib.resources 可读)。',
        pyTypedComment1: '# py.typed (PEP 561 类型标记): 必须显式声明才会随包安装;',
        pyTypedComment2: '#   显式声明跨 setuptools 版本无害, 一律显式最稳。',
        secDataFiles: '## 数据文件 ##',
        amentIndexComment: `        # 1) ament 索引地图标记 (resource/${c.pkg} 空文件): 存在 → ros2 工具可定位本包前缀`,
        pkgXmlInstallComment: `        # 2) 安装 package.xml 至 share/<包名>/, 供 ros2 pkg/colcon/rosdep 等按约定路径读取`,
        secDeps: '## 依赖 ##',
        installRequiresComment: '# Python 安装依赖 (ROS 依赖在 package.xml 声明)',
        testsRequireComment: '# 测试依赖',
        secMeta: '## 包元数据 ##',
        zipSafeComment: '# zip_safe=False: 包内带数据/二进制/扩展时最稳 (zip 态下按 __file__ 相对定位读文件会失败)',
        secEntry: '## 节点可执行入口 ##',
        consoleScriptsComment: '# console_scripts 定义命令名与模块函数入口的映射',
        consoleFormatComment: "# 格式: 'command name = module path.function name'",
        consoleLibComment: `# 生成的命令装至 lib/${c.pkg}/ (由 setup.cfg 的 install_scripts 指定落点), 供 ros2 run 定位`,
        addNodeExample: '        # 新增节点示例 (按需追加):',
        cfgTitle: `# ${c.pkg}/setup.cfg: 配合 setup.py 的打包配置`,
        cfgPurpose: '# 作用: 指定可执行命令的安装目录',
    };
}

/** 生成层杂项中文表(键集 = MiscStrings,编译期强制) */
export function buildMiscZh(c: MiscCtx): MiscStrings {
    return {
        initPyDocstring: `"""${c.pkg} 的 Python 模块 (供 import 复用)."""`,
    };
}
