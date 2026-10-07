// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file create-python-package.test.ts
 * create-python-package 模板展开单元测试
 *
 * 纯逻辑测试:不依赖 VS Code / ROS 环境,可直接用 mocha 运行(含 Windows)。
 * 运行方式(无需启动 VS Code):
 *   npm run test-compile && npx mocha out/test/suite/create-python-package.test.js
 */

import * as assert from 'assert';
import {
    validatePackageName,
    parseNodeNames,
    validateNodeNamesInput,
    generatePythonPackageFiles,
} from '../../src/build-tool/package-service/create/generate/create-python-package';

describe('validatePackageName', () => {
    it('合法包名返回 null', () => {
        assert.strictEqual(validatePackageName('my_pkg'), null);
        assert.strictEqual(validatePackageName('demo_pkg_py'), null);
        assert.strictEqual(validatePackageName('a'), null);
        assert.strictEqual(validatePackageName('abc123_xyz'), null);
    });

    it('非法包名返回错误信息', () => {
        assert.ok(validatePackageName(''));
        assert.ok(validatePackageName('   '));
        assert.ok(validatePackageName('MyPkg'));        // 大写
        assert.ok(validatePackageName('1abc'));         // 数字开头
        assert.ok(validatePackageName('my__pkg'));      // 连续下划线
        assert.ok(validatePackageName('my_pkg_'));      // 下划线结尾
        assert.ok(validatePackageName('my-pkg'));       // 连字符
        assert.ok(validatePackageName('my.pkg'));       // 点号
        assert.ok(validatePackageName('test'));         // 保留名
    });
});

describe('parseNodeNames', () => {
    it('空输入返回空列表', () => {
        const r = parseNodeNames('  ');
        assert.strictEqual(r.error, null);
        assert.deepStrictEqual(r.nodeNames, []);
    });

    it('空格分隔多个节点名', () => {
        const r = parseNodeNames('node1 node2  node3');
        assert.strictEqual(r.error, null);
        assert.deepStrictEqual(r.nodeNames, ['node1', 'node2', 'node3']);
    });

    it('重复节点名报错', () => {
        const r = parseNodeNames('node1 node1');
        assert.ok(r.error !== null);
        assert.ok(r.error!.includes('duplicated'));
        assert.deepStrictEqual(r.nodeNames, []);
    });

    it('大写/下划线开头合法(官方 rmw 规则)', () => {
        assert.strictEqual(parseNodeNames('Node1').error, null);
        assert.deepStrictEqual(parseNodeNames('Node1').nodeNames, ['Node1']);
        assert.strictEqual(parseNodeNames('_node').error, null);
    });

    it('非法节点名报错(数字开头/连字符)', () => {
        const r1 = parseNodeNames('1node');
        assert.ok(r1.error !== null);
        assert.ok(r1.error!.includes('is invalid'));
        const r2 = parseNodeNames('node-1');
        assert.ok(r2.error !== null);
    });

    it('Windows 保留设备名报错', () => {
        const r = parseNodeNames('con');
        assert.ok(r.error !== null);
        assert.ok(r.error!.includes('reserved Windows name'));
    });

    it('Python 关键字不可用作模块名', () => {
        for (const kw of ['class', 'def', 'import', 'lambda', 'True', 'None']) {
            const r = parseNodeNames(kw);
            assert.ok(r.error !== null, `"${kw}" 应报关键字错误`);
            assert.ok(r.error!.includes('Python keyword'), `"${kw}" 错误信息应含「Python keyword」`);
        }
        assert.strictEqual(parseNodeNames('my_node').error, null);
    });

    it('超长报错', () => {
        const r = parseNodeNames('a'.repeat(251));
        assert.ok(r.error !== null);
        assert.ok(r.error!.includes('too long'));
    });
});

describe('validateNodeNamesInput (节点名动态校验, validateInput 用)', () => {
    it('空输入返回 undefined(允许空=0 节点)', () => {
        assert.strictEqual(validateNodeNamesInput(''), undefined);
        assert.strictEqual(validateNodeNamesInput('   '), undefined);
    });

    it('合法输入返回 undefined', () => {
        assert.strictEqual(validateNodeNamesInput('node1'), undefined);
        assert.strictEqual(validateNodeNamesInput('node1 node2'), undefined);
    });

    it('大写/下划线开头合法(官方 rmw 规则)', () => {
        assert.strictEqual(validateNodeNamesInput('Node1'), undefined);
        assert.strictEqual(validateNodeNamesInput('_node'), undefined);
    });

    it('非法输入返回错误串(数字开头/连字符/保留名/关键字)', () => {
        assert.ok(validateNodeNamesInput('111')?.includes('is invalid'));
        assert.ok(validateNodeNamesInput('node-1')?.includes('is invalid'));
        assert.ok(validateNodeNamesInput('con')?.includes('reserved Windows name'));
        assert.ok(validateNodeNamesInput('class')?.includes('Python keyword'));
    });

    it('重复节点名返回错误串', () => {
        assert.ok(validateNodeNamesInput('node1 node1')?.includes('duplicated'));
    });
});

describe('generatePythonPackageFiles', () => {
    it('生成完整官方文件清单', () => {
        const files = generatePythonPackageFiles({ packageName: 'my_pkg', nodeNames: ['node1', 'node2'] });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes('package.xml'));
        assert.ok(paths.includes('setup.py'));
        assert.ok(paths.includes('setup.cfg'));
        assert.ok(paths.includes('resource/my_pkg'));
        assert.ok(paths.includes('my_pkg/__init__.py'));
        assert.ok(paths.includes('my_pkg/py.typed'));
        assert.ok(paths.includes('my_pkg/node1.py'));
        assert.ok(paths.includes('my_pkg/node2.py'));
        assert.ok(paths.includes('test/test_copyright.py'));
        assert.ok(paths.includes('test/test_flake8.py'));
        assert.ok(paths.includes('test/test_mypy.py'));
        assert.ok(paths.includes('test/test_pep257.py'));
        assert.ok(paths.includes('test/test_xmllint.py'));
        // 2 节点场景:6 基础文件 + 2 节点文件 + 5 test = 13
        assert.strictEqual(files.length, 13);
    });

    it('单节点时正好 12 个文件(与官方 ament_python 清单一致)', () => {
        const files = generatePythonPackageFiles({ packageName: 'my_pkg', nodeNames: ['node1'] });
        assert.strictEqual(files.length, 12);
    });

    it('package.xml 包名与 build_type 正确', () => {
        const files = generatePythonPackageFiles({ packageName: 'my_pkg', nodeNames: [] });
        const pkg = files.find((f) => f.path === 'package.xml')!;
        assert.ok(pkg.content.includes('<name>my_pkg</name>'));
        assert.ok(pkg.content.includes('<build_type>ament_python</build_type>'));
        assert.ok(!pkg.content.includes('std_msgs'));
    });

    it('setup.py 多节点入口正确', () => {
        const files = generatePythonPackageFiles({ packageName: 'my_pkg', nodeNames: ['node1', 'node2'] });
        const setup = files.find((f) => f.path === 'setup.py')!;
        assert.ok(setup.content.includes("package_name = 'my_pkg'"));
        assert.ok(setup.content.includes("'node1 = my_pkg.node1:main'"));
        assert.ok(setup.content.includes("'node2 = my_pkg.node2:main'"));
    });

    it('setup.py 无节点时 console_scripts 为空', () => {
        const files = generatePythonPackageFiles({ packageName: 'my_pkg', nodeNames: [] });
        const setup = files.find((f) => f.path === 'setup.py')!;
        // 只统计实际节点入口行 (以单引号开头、以 ', 结尾); 排除 # 注释的示例行
        const entries = setup.content.split('\n').filter((line) => {
            const t = line.trim();
            return t.startsWith("'") && t.endsWith("',");
        });
        assert.strictEqual(entries.length, 0);
    });

    it('节点文件:类名 DemoNode + 节点名 + 注释含包名', () => {
        const files = generatePythonPackageFiles({ packageName: 'my_pkg', nodeNames: ['talker'] });
        const node = files.find((f) => f.path === 'my_pkg/talker.py')!;
        assert.ok(node.content.includes('class DemoNode(Node)'));
        assert.ok(node.content.includes("super().__init__('talker')"));
        assert.ok(node.content.includes('my_pkg minimal demo node'));
        assert.ok(node.content.includes('#!/usr/bin/env python3'));
    });

    it('空文件:resource / __init__.py / py.typed', () => {
        const files = generatePythonPackageFiles({ packageName: 'my_pkg', nodeNames: [] });
        const resource = files.find((f) => f.path === 'resource/my_pkg')!;
        const init = files.find((f) => f.path === 'my_pkg/__init__.py')!;
        const typed = files.find((f) => f.path === 'my_pkg/py.typed')!;
        assert.strictEqual(resource.content, '');
        assert.strictEqual(init.content, '');
        assert.strictEqual(typed.content, '');
    });

    it('setup.cfg 路径含包名', () => {
        const files = generatePythonPackageFiles({ packageName: 'my_pkg', nodeNames: [] });
        const cfg = files.find((f) => f.path === 'setup.cfg')!;
        assert.ok(cfg.content.includes('script_dir=$base/lib/my_pkg'));
        assert.ok(cfg.content.includes('install_scripts=$base/lib/my_pkg'));
    });
});

describe('generatePythonPackageFiles: 依赖接入口 (extraDeps)', () => {
    it('未传/空数组 → 无额外依赖', () => {
        const a = generatePythonPackageFiles({ packageName: 'p', nodeNames: [] });
        const b = generatePythonPackageFiles({ packageName: 'p', nodeNames: [], extraDeps: [] });
        const xa = a.find((f) => f.path === 'package.xml')!.content;
        const xb = b.find((f) => f.path === 'package.xml')!.content;
        assert.ok(!xa.includes('<depend>std_msgs</depend>'));
        assert.ok(!xb.includes('<depend>std_msgs</depend>'));
    });

    it('单个额外依赖 → package.xml 展开为 3 个独立标签', () => {
        const files = generatePythonPackageFiles({ packageName: 'p', nodeNames: [], extraDeps: ['std_msgs'] });
        const xml = files.find((f) => f.path === 'package.xml')!.content;
        assert.ok(xml.includes('<depend>rclpy</depend>'));
        assert.ok(xml.includes('<build_depend>std_msgs</build_depend>'));
        assert.ok(xml.includes('<build_export_depend>std_msgs</build_export_depend>'));
        assert.ok(xml.includes('<exec_depend>std_msgs</exec_depend>'));
        assert.ok(!xml.includes('<depend>std_msgs</depend>'));   // 不用复合标签
        // 追加在 rclpy 后、测试段前, 用空行分隔
        assert.ok(xml.includes('  <depend>rclpy</depend>\n\n  <build_depend>std_msgs</build_depend>'));
    });

    it('额外依赖与默认 rclpy 重复 → 静默过滤', () => {
        const files = generatePythonPackageFiles({ packageName: 'p', nodeNames: [], extraDeps: ['rclpy', 'std_msgs'] });
        const xml = files.find((f) => f.path === 'package.xml')!.content;
        // rclpy 不重复: 仅默认 <depend>rclpy</depend>, 无额外 build/build_export/exec 三标签
        assert.ok(xml.includes('<depend>rclpy</depend>'));
        assert.ok(!xml.includes('<build_depend>rclpy</build_depend>'));
        assert.ok(!xml.includes('<build_export_depend>rclpy</build_export_depend>'));
        assert.ok(!xml.includes('<exec_depend>rclpy</exec_depend>'));
        // std_msgs 正常保留
        assert.ok(xml.includes('<build_depend>std_msgs</build_depend>'));
    });

    it('member_of_group 标配对注入(ament_python): 生成器+运行支撑 → 自动加组声明', () => {
        const files = generatePythonPackageFiles({
            packageName: 'p', nodeNames: [],
            extraDeps: ['rosidl_default_generators', 'rosidl_default_runtime'],
        });
        const xml = files.find((f) => f.path === 'package.xml')!.content;
        assert.ok(xml.includes('<member_of_group>rosidl_interface_packages</member_of_group>'));
        // 半对不注入
        const half = generatePythonPackageFiles({ packageName: 'p', nodeNames: [], extraDeps: ['rosidl_default_generators'] });
        assert.ok(!half.find((f) => f.path === 'package.xml')!.content.includes('member_of_group'));
    });

    it('额外依赖按消费形态分类展开(ament_python 无 CMakeLists, 仅 package.xml)', () => {
        const files = generatePythonPackageFiles({ packageName: 'p', nodeNames: [], extraDeps: ['launch_ros', 'std_msgs'] });
        const xml = files.find((f) => f.path === 'package.xml')!.content;
        // C3 → 仅 exec_depend
        assert.ok(xml.includes('<exec_depend>launch_ros</exec_depend>'));
        assert.ok(!xml.includes('<build_depend>launch_ros</build_depend>'));
        // C1 → 三标签
        assert.ok(xml.includes('<build_depend>std_msgs</build_depend>'));
        assert.ok(xml.includes('<build_export_depend>std_msgs</build_export_depend>'));
        assert.ok(xml.includes('<exec_depend>std_msgs</exec_depend>'));
    });

    it('多个额外依赖 → 按标签类型分组排布', () => {
        const files = generatePythonPackageFiles({
            packageName: 'p', nodeNames: [], extraDeps: ['std_msgs', 'nav_msgs', 'geometry_msgs'],
        });
        const xml = files.find((f) => f.path === 'package.xml')!.content;
        for (const d of ['std_msgs', 'nav_msgs', 'geometry_msgs']) {
            assert.ok(xml.includes(`<build_depend>${d}</build_depend>`));
            assert.ok(xml.includes(`<build_export_depend>${d}</build_export_depend>`));
            assert.ok(xml.includes(`<exec_depend>${d}</exec_depend>`));
        }
        // 按标签类型分组: 所有 build_depend → 所有 build_export_depend → 所有 exec_depend
        const b1 = xml.indexOf('<build_depend>std_msgs</build_depend>');
        const b3 = xml.indexOf('<build_depend>geometry_msgs</build_depend>');
        const be1 = xml.indexOf('<build_export_depend>std_msgs</build_export_depend>');
        const e1 = xml.indexOf('<exec_depend>std_msgs</exec_depend>');
        assert.ok(b1 < b3 && b3 < be1 && be1 < e1, '额外依赖应按标签类型分组排布');
    });
});

describe('generatePythonPackageFiles: 0 节点边缘', () => {
    it('nodeNames 空数组 → 无节点文件, 仅基础文件 (11 个)', () => {
        const files = generatePythonPackageFiles({ packageName: 'p', nodeNames: [] });
        // 除 __init__.py 外, 不应有任何 p/*.py 节点文件
        assert.ok(!files.some((f) => /^p\/[^/]+\.py$/.test(f.path) && f.path !== 'p/__init__.py'));
        assert.strictEqual(files.length, 11);
    });

    it('setup.py 0 节点: 无节点入口且不报错', () => {
        const files = generatePythonPackageFiles({ packageName: 'p', nodeNames: [] });
        const setup = files.find((f) => f.path === 'setup.py')!.content;
        const entries = setup.split('\n').filter((line) => {
            const t = line.trim();
            return t.startsWith("'") && t.endsWith("',");
        });
        assert.strictEqual(entries.length, 0);
    });
});
