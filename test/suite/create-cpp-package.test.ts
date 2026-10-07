// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file create-cpp-package.test.ts
 * create-cpp-package 模板展开单元测试
 *
 * 纯逻辑测试:不依赖 VS Code / ROS 环境,可直接用 mocha 运行(含 Windows)。
 * 运行方式(无需启动 VS Code):
 *   npm run test-compile && npx mocha out/test/suite/create-cpp-package.test.js
 */

import * as assert from 'assert';
import {
    validatePackageName,
    validateFileBaseNamesInput,
    parseFileBaseList,
    toNodeName,
    disambiguateNodeNames,
    isReservedFileName,
    generateCppPackageFiles,
} from '../../src/build-tool/package-service/create/generate/create-cpp-package';

/** 便捷: 取生成清单中某路径的内容 */
function contentOf(files: { path: string; content: string }[], p: string): string {
    const f = files.find((x) => x.path === p);
    assert.ok(f, `缺少文件 ${p}`);
    return f!.content;
}

describe('validatePackageName', () => {
    it('合法包名返回 null', () => {
        assert.strictEqual(validatePackageName('my_pkg'), null);
        assert.strictEqual(validatePackageName('demo_pkg_cpp'), null);
    });

    it('非法包名返回错误信息', () => {
        assert.ok(validatePackageName(''));
        assert.ok(validatePackageName('MyPkg'));
        assert.ok(validatePackageName('my--pkg'));
        assert.ok(validatePackageName('test'));
    });
});

describe('validateFileBaseNamesInput (宽范围文件基名校验, 输入框 validateInput 用)', () => {
    it('空输入返回 undefined(允许空=0 节点)', () => {
        assert.strictEqual(validateFileBaseNamesInput(''), undefined);
        assert.strictEqual(validateFileBaseNamesInput('   '), undefined);
    });

    it('合法输入: 含连字符/大写/下划线开头 → undefined', () => {
        assert.strictEqual(validateFileBaseNamesInput('my-node'), undefined);
        assert.strictEqual(validateFileBaseNamesInput('my_node'), undefined);
        assert.strictEqual(validateFileBaseNamesInput('My-Node'), undefined);
        assert.strictEqual(validateFileBaseNamesInput('_node'), undefined);
        assert.strictEqual(validateFileBaseNamesInput('my-node py_script'), undefined);
    });

    it('非法输入: 数字开头/非法字符 → 错误串', () => {
        assert.ok(validateFileBaseNamesInput('1node')?.includes('start with a letter or underscore'));
        assert.ok(validateFileBaseNamesInput('my.node')?.includes('Invalid file base name'));
        assert.ok(validateFileBaseNamesInput('my/node')?.includes('Invalid file base name'));
        assert.ok(validateFileBaseNamesInput('my*node')?.includes('Invalid file base name'));
        // 空格是分隔符: 'my node' 解析为两个合法基名, 非非法输入
        assert.strictEqual(validateFileBaseNamesInput('my node'), undefined);
    });

    it('Windows 保留设备名 → 错误串', () => {
        assert.ok(validateFileBaseNamesInput('con')?.includes('reserved Windows name'));
        assert.ok(validateFileBaseNamesInput('CON')?.includes('reserved Windows name'));
        assert.ok(validateFileBaseNamesInput('nul')?.includes('reserved Windows name'));
        assert.ok(validateFileBaseNamesInput('com1')?.includes('reserved Windows name'));
    });

    it('同框重复 → 错误串(防重复由校验负责, 不顺延)', () => {
        assert.ok(validateFileBaseNamesInput('my-node my-node')?.includes('duplicated'));
    });

    it('超长 → 错误串', () => {
        assert.ok(validateFileBaseNamesInput('a'.repeat(251))?.includes('too long'));
    });
});

describe('isReservedFileName (Windows 保留设备名)', () => {
    it('保留名返回 true(大小写不敏感)', () => {
        assert.strictEqual(isReservedFileName('con'), true);
        assert.strictEqual(isReservedFileName('PRN'), true);
        assert.strictEqual(isReservedFileName('Aux'), true);
        assert.strictEqual(isReservedFileName('lpt9'), true);
    });

    it('普通名返回 false', () => {
        assert.strictEqual(isReservedFileName('my-node'), false);
        assert.strictEqual(isReservedFileName('node1'), false);
        assert.strictEqual(isReservedFileName('con1'), false);
    });
});

describe('parseFileBaseList (空格分隔解析)', () => {
    it('空输入 → []', () => {
        assert.deepStrictEqual(parseFileBaseList(''), []);
        assert.deepStrictEqual(parseFileBaseList('   '), []);
    });

    it('多个基名去空白', () => {
        assert.deepStrictEqual(parseFileBaseList('my-node py  node2'), ['my-node', 'py', 'node2']);
    });
});

describe('映射与顺延 (toNodeName / disambiguateNodeNames)', () => {
    it('toNodeName: 连字符 → 下划线, 其余不变', () => {
        assert.strictEqual(toNodeName('my-node'), 'my_node');
        assert.strictEqual(toNodeName('my_node'), 'my_node');
        assert.strictEqual(toNodeName('a--b'), 'a__b');
    });

    it('disambiguateNodeNames: 不同基名映射同名 → 节点名顺延, 文件基名不变', () => {
        const specs = disambiguateNodeNames(['my-node', 'my_node']);
        assert.deepStrictEqual(specs, [
            { file: 'my-node', node: 'my_node' },
            { file: 'my_node', node: 'my_node_1' },
        ]);
    });

    it('disambiguateNodeNames: 相同基名(同框重复已被校验拦截, 此处兜底) → 顺延', () => {
        const specs = disambiguateNodeNames(['a', 'a']);
        assert.deepStrictEqual(specs.map((s) => s.node), ['a', 'a_1']);
    });

    it('disambiguateNodeNames: 顺延不撞已占用的 _1', () => {
        const specs = disambiguateNodeNames(['a', 'a', 'a_1']);
        assert.deepStrictEqual(specs.map((s) => s.node), ['a', 'a_1', 'a_1_1']);
    });
});

describe('generateCppPackageFiles: cpp-only (纯 C++ 节点包)', () => {
    const files = generateCppPackageFiles({ packageName: 'my_cpp', kind: 'cpp-only' });
    const paths = files.map((f) => f.path);

    it('生成 2 个 C++ 节点文件', () => {
        assert.ok(paths.includes('src/cpp_node_1.cpp'));
        assert.ok(paths.includes('src/cpp_node_2.cpp'));
    });

    it('不生成任何 Python 文件', () => {
        assert.ok(!paths.some((p) => p.startsWith('scripts/')));
        assert.ok(!paths.some((p) => p.startsWith('my_cpp/')));
    });

    it('package.xml 简约: 无 rclpy', () => {
        const xml = contentOf(files, 'package.xml');
        assert.ok(!xml.includes('<depend>rclpy</depend>'));
        assert.ok(!xml.includes('ament_cmake_python'));
        assert.ok(xml.includes('<depend>rclcpp</depend>'));
        assert.ok(xml.includes('<description>Pure C++ demo package (ament_cmake)</description>'));
    });

    it('CMakeLists: rclpy / ament_cmake_python 均为注释形态', () => {
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('# find_package(rclpy REQUIRED)'));
        assert.ok(cm.includes('# find_package(ament_cmake_python REQUIRED)'));
        assert.ok(!cm.includes('\nfind_package(rclpy REQUIRED)'));
    });

    it('CMakeLists: TARGETS 装 2 节点, PROGRAMS 注释', () => {
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('install(TARGETS cpp_node_1 cpp_node_2'));
        assert.ok(cm.includes('# install(PROGRAMS scripts/my_node.py'));
    });
});

describe('generateCppPackageFiles: cpp-dual (双语言节点包)', () => {
    const files = generateCppPackageFiles({ packageName: 'my_dual', kind: 'cpp-dual' });
    const paths = files.map((f) => f.path);

    it('生成 1 个 C++ 节点 + 1 个 Python 脚本节点', () => {
        assert.ok(paths.includes('src/cpp_node_1.cpp'));
        assert.ok(paths.includes('scripts/py_node.py'));
        assert.ok(!paths.includes('src/cpp_node_2.cpp'));
    });

    it('不生成 Python 模块 (无 __init__.py)', () => {
        assert.ok(!paths.includes('my_dual/__init__.py'));
    });

    it('package.xml 简约: 有 rclpy, 无 ament_cmake_python', () => {
        const xml = contentOf(files, 'package.xml');
        assert.ok(xml.includes('<depend>rclpy</depend>'));
        assert.ok(!xml.includes('ament_cmake_python'));
        // 块间空行: buildtool 后与 rclpy 后各有空行
        assert.ok(xml.includes('  <buildtool_depend>ament_cmake</buildtool_depend>\n\n  <!-- Exec depend'));
        assert.ok(xml.includes('  <depend>rclpy</depend>\n\n  <!-- Test depend'));
        // 运行依赖组内无空行 (rclcpp 与 rclpy 相邻)
        assert.ok(xml.includes('  <depend>rclcpp</depend>\n  <!-- Exec depend: Python nodes need rclpy -->'));
    });

    it('CMakeLists: rclpy 激活, ament_cmake_python 注释, PROGRAMS 激活', () => {
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('\nfind_package(rclpy REQUIRED)'));
        assert.ok(cm.includes('# find_package(ament_cmake_python REQUIRED)'));
        assert.ok(cm.includes('install(PROGRAMS scripts/py_node.py'));
        assert.ok(!cm.includes('\nament_python_install_package('));
    });

    it('Python 脚本节点节点名正确', () => {
        const py = contentOf(files, 'scripts/py_node.py');
        assert.ok(py.includes("super().__init__('py_node')"));
        assert.ok(py.includes('#!/usr/bin/env python3'));
    });
});

describe('generateCppPackageFiles: mixed (混合包)', () => {
    const files = generateCppPackageFiles({ packageName: 'my_mix', kind: 'mixed' });
    const paths = files.map((f) => f.path);

    it('生成 C++ 节点 + Python 模块 (含 __init__.py)', () => {
        assert.ok(paths.includes('src/cpp_node_1.cpp'));
        assert.ok(paths.includes('my_mix/__init__.py'));
        assert.ok(paths.includes('my_mix/py_node_1.py'));
    });

    it('package.xml 简约: 有 ament_cmake_python + rclpy', () => {
        const xml = contentOf(files, 'package.xml');
        assert.ok(xml.includes('<buildtool_depend>ament_cmake_python</buildtool_depend>'));
        assert.ok(xml.includes('<depend>rclpy</depend>'));
        // buildtool 组内无空行; 组后与 rclpy 后各有空行
        assert.ok(xml.includes('  <buildtool_depend>ament_cmake</buildtool_depend>\n  <!-- Buildtool depend: ament_cmake_python is required'));
        assert.ok(xml.includes('  <buildtool_depend>ament_cmake_python</buildtool_depend>\n\n  <!-- Exec depend'));
        assert.ok(xml.includes('  <depend>rclpy</depend>\n\n  <!-- Test depend'));
    });

    it('CMakeLists: ament_cmake_python 激活 + Python 模块激活 + PROGRAMS 激活', () => {
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('\nfind_package(ament_cmake_python REQUIRED)'));
        assert.ok(cm.includes('\nament_python_install_package('));
        assert.ok(cm.includes('install(PROGRAMS my_mix/py_node_1.py'));
    });

    it('Python 模块节点节点名正确', () => {
        const py = contentOf(files, 'my_mix/py_node_1.py');
        assert.ok(py.includes("super().__init__('py_node_1')"));
    });
});

describe('generateCppPackageFiles: 三类包 CMakeLists 公共部分一致', () => {
    it('头注释/接口段/测试段文字一致 (归一化包名后)', () => {
        const a = generateCppPackageFiles({ packageName: 'pa', kind: 'cpp-only' });
        const b = generateCppPackageFiles({ packageName: 'pb', kind: 'cpp-dual' });
        const c = generateCppPackageFiles({ packageName: 'pc', kind: 'mixed' });
        const ca = contentOf(a, 'CMakeLists.txt').split('pa').join('<P>');
        const cb = contentOf(b, 'CMakeLists.txt').split('pb').join('<P>');
        const cc = contentOf(c, 'CMakeLists.txt').split('pc').join('<P>');

        // 抽取三段公共块判断包含关系
        const blocks = [
            '# ---- Compile options: enable warnings ----',
            '## Custom message/service/action interface generation (msg / srv / action) ##',
            '## Build the minimal executable (C++ node)',
            '## Python module installation (for import reuse) ##',
            '## DIRECTORY: installs a whole directory (recursive copy, no compilation)',
            '## colcon build only builds and does not run tests',
        ];
        for (const blk of blocks) {
            assert.ok(ca.includes(blk));
            assert.ok(cb.includes(blk));
            assert.ok(cc.includes(blk));
        }
        // 无"类型独有描述"残留 (通用指代"本包"属中性, 不在检查范围)
        for (const cm of [ca, cb, cc]) {
            assert.ok(!cm.includes('纯 C++ 包'));
            assert.ok(!cm.includes('混合包'));
            assert.ok(!cm.includes('双语言'));
        }
    });
});

describe('generateCppPackageFiles: includeLayout=single (按机分派, 单层形态)', () => {
    const cm = contentOf(generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', includeLayout: 'single' }), 'CMakeLists.txt');

    it('单层落点/导出根/INSTALL_INTERFACE 同值 include;无双层残留、无约定概念', () => {
        assert.strictEqual(cm.split('DESTINATION include)').length - 1, 2, '应恰有 2 处单层落点 DESTINATION include)');
        assert.ok(cm.includes('# ament_export_include_directories(include)'), '导出根应为 include');
        assert.ok(cm.includes('$<INSTALL_INTERFACE:include>'), 'INSTALL_INTERFACE 应为 include');
        assert.ok(!cm.includes('include/${PROJECT_NAME}/${PROJECT_NAME}'), 'single 下不得有双层落点');
        assert.ok(!cm.includes('约定'), '文本不携带约定概念');
    });
});

describe('generateCppPackageFiles: CMakeLists 头文件布局 = 约定 B (三处同源)', () => {
    const cm = contentOf(generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only' }), 'CMakeLists.txt');

    it('① 安装落点 / ② 导出根 / ③ INSTALL_INTERFACE 三处同值 include/<pkg>', () => {
        // ① install(DIRECTORY) 双层落点: header-only 示例(单行) + 安装段示例(两行) = 恰 2 处
        const destB = cm.split('DESTINATION include/${PROJECT_NAME}/${PROJECT_NAME})').length - 1;
        assert.strictEqual(destB, 2, '应恰有 2 处双层落点 DESTINATION include/<pkg>/<pkg>)');
        // ② 包级导出根(子根)
        assert.ok(cm.includes('# ament_export_include_directories(include/${PROJECT_NAME})'), '导出根应为 include/<pkg>');
        // ③ 被导出库 target 的 INSTALL_INTERFACE
        assert.ok(cm.includes('$<INSTALL_INTERFACE:include/${PROJECT_NAME}>'), 'INSTALL_INTERFACE 应为 include/<pkg>');
    });

    it('不残留约定 A 写法 (导出根 include / INSTALL_INTERFACE:include / 单层落点)', () => {
        assert.ok(!cm.includes('# ament_export_include_directories(include)'), '不得再有旧导出根 include');
        assert.ok(!cm.includes('$<INSTALL_INTERFACE:include>'), '不得再有旧 INSTALL_INTERFACE:include');
        assert.ok(!cm.includes('DESTINATION include/${PROJECT_NAME})'), '不得再有单层落点 include/<pkg>');
        assert.ok(!cm.includes('装至 include/<包名>/, 供其他包 include'), '安装段注释应改为双层描述');
    });
});

describe('generateCppPackageFiles: 依赖接入口 (extraDeps)', () => {
    it('未传/空数组 → 无额外依赖', () => {
        const a = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only' });
        const b = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', extraDeps: [] });
        const ca = contentOf(a, 'CMakeLists.txt');
        const xa = contentOf(a, 'package.xml');
        const cb = contentOf(b, 'CMakeLists.txt');
        assert.ok(!ca.includes('\nfind_package(std_msgs REQUIRED)'));
        assert.ok(!xa.includes('<depend>std_msgs</depend>'));
        assert.ok(!cb.includes('\nfind_package(std_msgs REQUIRED)'));
    });

    it('单个额外依赖 → CMakeLists find_package + package.xml 展开为 3 个独立标签', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', extraDeps: ['std_msgs'] });
        const cm = contentOf(files, 'CMakeLists.txt');
        const xml = contentOf(files, 'package.xml');
        assert.ok(cm.includes('\nfind_package(std_msgs REQUIRED)'));
        assert.ok(xml.includes('<build_depend>std_msgs</build_depend>'));
        assert.ok(xml.includes('<build_export_depend>std_msgs</build_export_depend>'));
        assert.ok(xml.includes('<exec_depend>std_msgs</exec_depend>'));
        assert.ok(!xml.includes('<depend>std_msgs</depend>'));   // 不用复合标签
        // 与默认依赖块隔一个空行 (rclcpp/rclpy 后空行再接额外依赖)
        assert.ok(xml.includes('  <depend>rclcpp</depend>\n\n  <build_depend>std_msgs</build_depend>'));
        // std_msgs 联动: 激活预留注释行, 不另追加
        assert.ok(cm.includes('## Standard message types (enable when using std_msgs)\nfind_package(std_msgs REQUIRED)'));
        assert.ok(!cm.includes('# find_package(std_msgs REQUIRED)'));
    });

    it('额外依赖与默认依赖重复 → 静默过滤 (rclcpp/rclpy)', () => {
        // cpp-only 默认已有 rclcpp; 输入重复 rclcpp + 合法 std_msgs
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', extraDeps: ['rclcpp', 'std_msgs'] });
        const cm = contentOf(files, 'CMakeLists.txt');
        const xml = contentOf(files, 'package.xml');
        // rclcpp 不重复: 无额外的 <build_depend>rclcpp</build_depend>
        assert.ok(!xml.includes('<build_depend>rclcpp</build_depend>'));
        assert.ok(!xml.includes('<build_export_depend>rclcpp</build_export_depend>'));
        assert.ok(!xml.includes('<exec_depend>rclcpp</exec_depend>'));
        // std_msgs 正常保留
        assert.ok(xml.includes('<build_depend>std_msgs</build_depend>'));
        // CMakeLists: rclcpp 仅默认一行, 不追加重复
        assert.strictEqual(cm.split('find_package(rclcpp REQUIRED)').length - 1, 1);
    });

    it('member_of_group 标配对注入: 生成器+运行支撑 → 自动加组声明; 半对/只勾消息包 → 不加', () => {
        // 标配对 → 注入
        const withPair = generateCppPackageFiles({
            packageName: 'p', kind: 'cpp-only',
            extraDeps: ['rosidl_default_generators', 'rosidl_default_runtime'],
        });
        const xmlPair = contentOf(withPair, 'package.xml');
        assert.ok(xmlPair.includes('<member_of_group>rosidl_interface_packages</member_of_group>'));
        assert.ok(xmlPair.includes('<buildtool_depend>rosidl_default_generators</buildtool_depend>'));
        assert.ok(xmlPair.includes('<exec_depend>rosidl_default_runtime</exec_depend>'));
        // 半对(只生成器) → 不加
        const half = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', extraDeps: ['rosidl_default_generators'] });
        assert.ok(!contentOf(half, 'package.xml').includes('member_of_group'));
        // 只勾消息包(使用≠定义) → 不加
        const msgs = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', extraDeps: ['std_msgs'] });
        assert.ok(!contentOf(msgs, 'package.xml').includes('member_of_group'));
    });

    it('额外依赖按消费形态分类展开: buildtool_depend / 三标签 / exec_depend', () => {
        const files = generateCppPackageFiles({
            packageName: 'p', kind: 'cpp-only',
            extraDeps: ['ament_cmake_ros', 'std_msgs', 'launch_ros'],
        });
        const xml = contentOf(files, 'package.xml');
        // C2 → buildtool_depend
        assert.ok(xml.includes('<buildtool_depend>ament_cmake_ros</buildtool_depend>'));
        assert.ok(!xml.includes('<build_depend>ament_cmake_ros</build_depend>'));
        // C1 → 三标签
        assert.ok(xml.includes('<build_depend>std_msgs</build_depend>'));
        assert.ok(xml.includes('<build_export_depend>std_msgs</build_export_depend>'));
        assert.ok(xml.includes('<exec_depend>std_msgs</exec_depend>'));
        // C3 → 仅 exec_depend
        assert.ok(xml.includes('<exec_depend>launch_ros</exec_depend>'));
        assert.ok(!xml.includes('<build_depend>launch_ros</build_depend>'));
        assert.ok(!xml.includes('<build_export_depend>launch_ros</build_export_depend>'));
        // CMakeLists: buildtool/depend find_package, exec 不 find_package
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('find_package(ament_cmake_ros REQUIRED)'));
        assert.ok(!cm.includes('find_package(launch_ros'));
    });

    it('多个额外依赖 → 按标签类型分组排布', () => {
        const files = generateCppPackageFiles({
            packageName: 'p', kind: 'mixed', extraDeps: ['std_msgs', 'nav_msgs'],
        });
        const cm = contentOf(files, 'CMakeLists.txt');
        const xml = contentOf(files, 'package.xml');
        for (const d of ['std_msgs', 'nav_msgs']) {
            assert.ok(cm.includes(`find_package(${d} REQUIRED)`));
            assert.ok(xml.includes(`<build_depend>${d}</build_depend>`));
            assert.ok(xml.includes(`<build_export_depend>${d}</build_export_depend>`));
            assert.ok(xml.includes(`<exec_depend>${d}</exec_depend>`));
        }
        // 按标签类型分组: 所有 build_depend → 所有 build_export_depend → 所有 exec_depend
        const b1 = xml.indexOf('<build_depend>std_msgs</build_depend>');
        const b2 = xml.indexOf('<build_depend>nav_msgs</build_depend>');
        const be1 = xml.indexOf('<build_export_depend>std_msgs</build_export_depend>');
        const e1 = xml.indexOf('<exec_depend>std_msgs</exec_depend>');
        assert.ok(b1 < b2 && b2 < be1 && be1 < e1, '额外依赖应按标签类型分组排布');
    });
});

describe('generateCppPackageFiles: 节点接入口 (cppNodes / pythonNodes, 支持字符串恒等与 spec 分离)', () => {
    it('cppNodeNames 覆盖默认: cpp-only 传单个节点 → 只 1 个 C++ 节点', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', cppNodes: ['my_node'] });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('src/my_node.cpp'));
        assert.ok(!paths.includes('src/cpp_node_1.cpp'));
        assert.ok(!paths.includes('src/cpp_node_2.cpp'));
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('add_executable(my_node src/my_node.cpp)'));
        assert.ok(cm.includes('install(TARGETS my_node'));
    });

    it('cppNodeNames 空数组 → 0 个 C++ 节点, 保留 src/ 与 include/ 空目录', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', cppNodes: [] });
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(!/\nadd_executable\(/.test(cm));   // 无激活 add_executable (Mycpp_node 示例是注释)
        assert.ok(!files.some((f) => /^src\/.+\.cpp$/.test(f.path)));   // 无节点文件
        assert.ok(files.some((f) => f.path === 'src/' && f.directory));   // src/ 空目录存在
        assert.ok(files.some((f) => f.path === 'include/p/' && f.directory));   // include/<pkg>/ 空目录
        assert.ok(!files.some((f) => f.path.includes('.gitkeep')));   // 无占位文件
        // 0 节点时 TARGETS 不能是空参数, 应为注释示例 (示例名 Mycpp_node, 避免 CMake 报错)
        assert.ok(!/\ninstall\(TARGETS /.test(cm));
        assert.ok(cm.includes('# install(TARGETS Mycpp_node'));
    });

    it('pythonNodeNames 覆盖: cpp-dual 自定义脚本名', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-dual', pythonNodes: ['my_py'] });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('scripts/my_py.py'));
        assert.ok(!paths.includes('scripts/py_node.py'));
        const py = contentOf(files, 'scripts/my_py.py');
        assert.ok(py.includes("super().__init__('my_py')"));
    });

    it('pythonNodeNames 空数组 → 不生成 Python 节点 (cpp-dual 仍启用 rclpy)', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-dual', pythonNodes: [] });
        assert.ok(!files.some((f) => f.path.startsWith('scripts/')));
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('\nfind_package(rclpy REQUIRED)'));
        const xml = contentOf(files, 'package.xml');
        assert.ok(xml.includes('<depend>rclpy</depend>'));
    });

    it('mixed + pythonNodeNames 空数组 → 仍有 __init__.py, 无节点文件', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'mixed', pythonNodes: [] });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('p/__init__.py'));
        assert.ok(!paths.includes('p/py_node_1.py'));
    });

    it('pythonNodeNames 多个: cpp-dual → 多个 scripts/*.py 且 PROGRAMS 多行', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-dual', pythonNodes: ['talker', 'listener'] });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('scripts/talker.py'));
        assert.ok(paths.includes('scripts/listener.py'));
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('install(PROGRAMS scripts/talker.py'));
        assert.ok(cm.includes('install(PROGRAMS scripts/listener.py'));
    });

    it('pythonNodeNames 多个: mixed → 多个模块节点文件', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'mixed', pythonNodes: ['a_node', 'b_node'] });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('p/a_node.py'));
        assert.ok(paths.includes('p/b_node.py'));
        assert.ok(paths.includes('p/__init__.py'));
    });

    it('cppNodeNames 空数组 → src/ 以空目录保留 (非占位文件)', () => {
        const files = generateCppPackageFiles({ packageName: 'p', kind: 'cpp-only', cppNodes: [] });
        assert.ok(files.some((f) => f.path === 'src/' && f.directory));
        assert.ok(!files.some((f) => f.path.startsWith('src/') && !f.directory));
        assert.ok(!files.some((f) => f.path.includes('.gitkeep')));
    });

    it('向后兼容: 不传新字段 → 与默认输出一致', () => {
        const withNew = generateCppPackageFiles({
            packageName: 'p', kind: 'mixed', cppNodes: undefined, pythonNodes: undefined, extraDeps: undefined,
        });
        const default_ = generateCppPackageFiles({ packageName: 'p', kind: 'mixed' });
        assert.deepStrictEqual(withNew, default_);
    });

    it('cppNodes 传 spec {file,node}: 文件名用 file, target/节点名用 node', () => {
        const files = generateCppPackageFiles({
            packageName: 'p', kind: 'cpp-only',
            cppNodes: [{ file: 'my-node', node: 'my_node' }],
        });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('src/my-node.cpp'), '文件基名保留原输入');
        assert.ok(!paths.includes('src/my_node.cpp'));
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('add_executable(my_node src/my-node.cpp)'), 'target 用 node, 源文件用 file');
        assert.ok(cm.includes('install(TARGETS my_node'));
        const cpp = contentOf(files, 'src/my-node.cpp');
        assert.ok(cpp.includes('Node("my_node")'), '运行时节点名用映射名');
    });

    it('cpp-dual 脚本 spec: scripts/<file>.py + Node(<node>) + PROGRAMS 用 file', () => {
        const files = generateCppPackageFiles({
            packageName: 'p', kind: 'cpp-dual',
            pythonNodes: [{ file: 'py-script', node: 'py_script' }],
        });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('scripts/py-script.py'));
        const py = contentOf(files, 'scripts/py-script.py');
        assert.ok(py.includes("super().__init__('py_script')"));
        const cm = contentOf(files, 'CMakeLists.txt');
        assert.ok(cm.includes('install(PROGRAMS scripts/py-script.py'));
    });

    it('mixed 模块恒等: file === node, 文件位于 <pkg>/', () => {
        const files = generateCppPackageFiles({
            packageName: 'p', kind: 'mixed',
            pythonNodes: [{ file: 'a_node', node: 'a_node' }],
        });
        assert.ok(files.some((f) => f.path === 'p/a_node.py'));
        const py = contentOf(files, 'p/a_node.py');
        assert.ok(py.includes("super().__init__('a_node')"));
    });
});

describe('generateCppPackageFiles: 纯 Python 依赖通道 (2026-09-06)', () => {
    it('目录表 KNOWN_PYTHON_ONLY 系统包自动并入 pythonOnly: 不 find_package, package.xml 仅 exec_depend', () => {
        const files = generateCppPackageFiles({
            packageName: 'p', kind: 'cpp-dual', pythonNodes: ['listener'],
            extraDeps: ['std_msgs', 'sensor_msgs_py'],
        });
        const cm = contentOf(files, 'CMakeLists.txt');
        const xml = contentOf(files, 'package.xml');
        assert.ok(cm.includes('find_package(std_msgs REQUIRED)'), 'std_msgs 正常 find_package');
        assert.ok(!cm.includes('find_package(sensor_msgs_py'), '纯 Python 系统包不 find_package');
        assert.ok(xml.includes('<build_depend>std_msgs</build_depend>'), 'std_msgs 仍三标签');
        assert.ok(xml.includes('<exec_depend>std_msgs</exec_depend>'));
        assert.ok(!xml.includes('<build_depend>sensor_msgs_py</build_depend>'), 'python-only 不三标签');
        assert.ok(xml.includes('<exec_depend>sensor_msgs_py</exec_depend>'), 'python-only 仅 exec_depend');
        assert.ok(cm.includes('sensor_msgs_py'), 'CMakeLists 有注记提及');
    });

    it('工作区自定义纯 Python 包(pythonOnlyDeps 传入): 不 find_package, 仅 exec_depend', () => {
        const files = generateCppPackageFiles({
            packageName: 'p', kind: 'cpp-dual', pythonNodes: ['listener'],
            extraDeps: ['std_msgs'], pythonOnlyDeps: ['iii'],
        });
        const cm = contentOf(files, 'CMakeLists.txt');
        const xml = contentOf(files, 'package.xml');
        assert.ok(!cm.includes('find_package(iii'), '工作区纯 Python 不 find_package');
        assert.ok(xml.includes('<exec_depend>iii</exec_depend>'), '仅 exec_depend');
        assert.ok(!xml.includes('<build_depend>iii</build_depend>'), '不三标签');
        assert.ok(cm.includes('iii'), 'CMakeLists 有注记提及');
    });
});
