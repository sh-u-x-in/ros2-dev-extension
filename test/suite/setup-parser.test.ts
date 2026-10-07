// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file setup-parser.test.ts
 * setup.py 解析器（v5）单元测试
 *
 * 纯逻辑测试：mock SetupFs（内存目录树）+ 文本输入，不依赖 VS Code / 真实文件系统。
 * 覆盖 find_packages 的 setuptools 语义、glob 展开、列表推导展开、语义指纹。
 *
 * 运行方式：
 *   npm run test-compile && npx mocha out/test/suite/setup-parser.test.js
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    parseSetupPy,
    findPackages,
    expandGlob,
    nodeFs,
    SetupFs,
} from '../../src/build-tool/package-service/config/exe-map/parse/setup-parser';

/** 内存文件系统 mock：路径 → 'file' | 'dir'（键统一正斜杠，兼容 Windows path.join 反斜杠） */
function makeFs(tree: Record<string, string>): SetupFs {
    const entries = new Map<string, string>();
    for (const [k, v] of Object.entries(tree)) {
        entries.set(k.replace(/\\/g, '/'), v);
    }
    return {
        isFile: (p) => entries.get(p.replace(/\\/g, '/')) === 'file',
        // 目录：是某文件/子项条目的父目录（树只存文件叶节点，目录无显式键）
        isDirectory: (p) => {
            const key = p.replace(/\\/g, '/');
            const base = key.endsWith('/') ? key : key + '/';
            for (const k of entries.keys()) {
                if (k.startsWith(base)) {
                    return true;
                }
            }
            return false;
        },
        readdir: (p) => {
            const base = p.replace(/\\/g, '/');
            const prefix = base.endsWith('/') ? base : base + '/';
            const children = new Set<string>();
            for (const k of entries.keys()) {
                if (k.startsWith(prefix)) {
                    const rest = k.slice(prefix.length);
                    const first = rest.split('/')[0];
                    if (first) {
                        children.add(first);
                    }
                }
            }
            return [...children].sort();
        },
    };
}

// 共享 mock 树：嵌套包 + 非包目录 + 含点目录 + __pycache__ + test 包
const demoFs = makeFs({
    '/pkg/demo/__init__.py': 'file',
    '/pkg/demo/a/__init__.py': 'file',
    '/pkg/demo/b/__init__.py': 'file',
    '/pkg/demo/b/sub/__init__.py': 'file',
    '/pkg/demo/__pycache__/__init__.py': 'file',
    '/pkg/test/__init__.py': 'file',
    '/pkg/noinit/x/__init__.py': 'file', // noinit 无 __init__.py → 整个剪枝
    '/pkg/a.b/__init__.py': 'file',      // 目录名含 '.' → 跳过
    '/pkg/setup.py': 'file',
});

describe('findPackages (setuptools 59.6.0 语义)', () => {
    it('只返回含 __init__.py 的目录；非包目录整体剪枝（不递归）', () => {
        assert.deepStrictEqual(
            findPackages('/pkg', { fs: demoFs }).sort(),
            ['demo', 'demo.a', 'demo.b', 'demo.b.sub', 'test'].sort(),
        );
    });

    it('目录名含 . 跳过', () => {
        const r = findPackages('/pkg', { fs: demoFs });
        assert.ok(!r.includes('a.b'));
    });

    it('默认排除 *__pycache__', () => {
        const r = findPackages('/pkg', { fs: demoFs });
        assert.ok(!r.some((p) => p.includes('__pycache__')));
    });

    it('exclude 作用完整点分包名：exclude demo.b → demo.b.sub 保留', () => {
        const r = findPackages('/pkg', { fs: demoFs, exclude: ['demo.b'] });
        assert.ok(!r.includes('demo.b'));
        assert.ok(r.includes('demo.b.sub'));
    });

    it('exclude test 精确排除顶层 test 包', () => {
        const r = findPackages('/pkg', { fs: demoFs, exclude: ['test'] });
        assert.ok(!r.includes('test'));
        assert.ok(r.includes('demo'));
    });
});

describe('expandGlob (python glob 近似)', () => {
    const globFs = makeFs({
        '/p/launch/rde_demo.launch.py': 'file',
        '/p/launch/rde_pub.launch.py': 'file',
        '/p/launch/rde_sub.launch.py': 'file',
        '/p/launch/README.md': 'file',
    });

    it('launch/*.launch.py → 3 个相对路径', () => {
        assert.deepStrictEqual(
            expandGlob('/p', 'launch/*.launch.py', globFs).sort(),
            ['launch/rde_demo.launch.py', 'launch/rde_pub.launch.py', 'launch/rde_sub.launch.py'].sort(),
        );
    });
});

describe('parseSetupPy v5 安全展开', () => {
    it('packages=find_packages(exclude=[\'test\']) → 展开真实包列表且不标 dynamic', () => {
        const text = `from setuptools import find_packages, setup
setup(name='demo', packages=find_packages(exclude=['test']))`;
        const r = parseSetupPy(text, { packageDir: '/pkg', fs: demoFs });
        assert.deepStrictEqual(
            r.packages.sort(),
            ['demo', 'demo.a', 'demo.b', 'demo.b.sub'].sort(),
        );
        assert.strictEqual(r.dynamic, false);
    });

    it('无 packageDir 时 find_packages 保持动态检测（向后兼容）', () => {
        const text = `from setuptools import find_packages, setup
setup(name='demo', packages=find_packages(exclude=['test']))`;
        const r = parseSetupPy(text);
        assert.strictEqual(r.packages.length, 0);
        assert.strictEqual(r.dynamic, true);
        assert.strictEqual(r.dynamicDeps['packages']?.[0]?.callName, 'find_packages');
    });

    it('data_files 中 glob(\'launch/*.launch.py\') → 展开真实文件，不标 dynamic', () => {
        const globFs2 = makeFs({
            '/p/launch/rde_demo.launch.py': 'file',
            '/p/launch/rde_pub.launch.py': 'file',
            '/p/launch/rde_sub.launch.py': 'file',
        });
        const text = `from setuptools import setup
from glob import glob
setup(name='p', data_files=[('share/p/launch', glob('launch/*.launch.py'))])`;
        const r = parseSetupPy(text, { packageDir: '/p', fs: globFs2 });
        assert.strictEqual(r.dataFiles.length, 1);
        assert.deepStrictEqual(
            r.dataFiles[0].files.sort(),
            ['launch/rde_demo.launch.py', 'launch/rde_pub.launch.py', 'launch/rde_sub.launch.py'].sort(),
        );
        assert.strictEqual(r.dynamic, false);
    });

    it('console_scripts 列表推导 → 模板展开真实入口，不标 dynamic', () => {
        const text = `from setuptools import setup
NODES = ['node1', 'node2']
pkg = 'demo_pkg_py'
setup(name=pkg, entry_points={'console_scripts': [f'{n} = {pkg}.{n}:main' for n in NODES]})`;
        const r = parseSetupPy(text);
        assert.deepStrictEqual(
            r.consoleScripts.map((c) => `${c.name}=${c.module}:${c.func}`),
            ['node1=demo_pkg_py.node1:main', 'node2=demo_pkg_py.node2:main'],
        );
        assert.strictEqual(r.dynamic, false);
    });

    it('列表推导 iterable 非变量（字面量列表）→ 回退动态检测', () => {
        const text = `from setuptools import setup
setup(name='p', entry_points={'console_scripts': [f'{n}:main' for n in ['a', 'b']]})`;
        const r = parseSetupPy(text);
        assert.strictEqual(r.dynamic, true);
        assert.ok(r.dynamicDeps['entry_points.console_scripts']);
    });
});

describe('语义指纹（名字无关）', () => {
    it('find_packages 展开值入指纹：文件系统值变 → 指纹变', () => {
        const text = `from setuptools import find_packages, setup
setup(name='demo', packages=find_packages(exclude=['test']))`;
        const r1 = parseSetupPy(text, { packageDir: '/pkg', fs: demoFs });
        const r2 = parseSetupPy(text, { packageDir: '/pkg', fs: demoFs });
        assert.strictEqual(r1.fingerprint, r2.fingerprint);

        // 换成只含 demo（无子包）的树 → 指纹变
        const smallFs = makeFs({ '/pkg/demo/__init__.py': 'file', '/pkg/setup.py': 'file' });
        const r3 = parseSetupPy(text, { packageDir: '/pkg', fs: smallFs });
        assert.notStrictEqual(r1.fingerprint, r3.fingerprint);
    });

    it('console_scripts 展开值入指纹：变量改名但值同 → 指纹不变', () => {
        const t1 = `from setuptools import setup
NODES = ['node1', 'node2']
pkg = 'demo_pkg_py'
setup(name=pkg, entry_points={'console_scripts': [f'{n} = {pkg}.{n}:main' for n in NODES]})`;
        const t2 = `from setuptools import setup
NODE_LIST = ['node1', 'node2']
the_pkg = 'demo_pkg_py'
setup(name=the_pkg, entry_points={'console_scripts': [f'{x} = {the_pkg}.{x}:main' for x in NODE_LIST]})`;
        assert.strictEqual(parseSetupPy(t1).fingerprint, parseSetupPy(t2).fingerprint);
    });
});

describe('真实 samples 端到端（工作区存在才跑）', () => {
    const samplesRoot = path.resolve(__dirname, '../../../samples/src/rde_py');
    const hasSamples = fs.existsSync(path.join(samplesRoot, 'setup.py'));

    it('rde_py: find_packages → [rde_py], console_scripts 2 条, glob 3 文件, 无 dynamic', function () {
        if (!hasSamples) {
            this.skip();
            return;
        }
        const text = fs.readFileSync(path.join(samplesRoot, 'setup.py'), 'utf8');
        const r = parseSetupPy(text, { packageDir: samplesRoot, fs: nodeFs });
        assert.deepStrictEqual(r.packages, ['rde_py']);
        assert.strictEqual(r.consoleScripts.length, 2);
        assert.deepStrictEqual(
            r.dataFiles[2].files.sort(),
            ['launch/rde_demo.launch.py', 'launch/rde_publisher.launch.py', 'launch/rde_subscriber.launch.py'].sort(),
        );
        assert.strictEqual(r.dynamic, false);
    });
});

describe('setup-parser 模块级容器与加法式 entry_points(2026-09-04)', function () {
    it('模块级容器变量 + setup 标识符实参 → 解析出 data_files/install_requires/entry_points(类型注解形态)', () => {
        const text = [
            'from typing import Dict, List',
            'from setuptools import find_packages, setup',
            'entry_points: Dict[str, List[str]] = {',
            "    'console_scripts': [",
            "        'old = p.old:main',",
            "    ],",
            '}',
            'install_requires = [',
            '    "setuptools",',
            '    "numpy>=1.20",',
            ']',
            'data_files = [',
            "    ('share/' + 'p', ['package.xml']),",
            ']',
            "setup(name='p', entry_points=entry_points, install_requires=install_requires, data_files=data_files)",
            '',
        ].join('\n');
        const r = parseSetupPy(text);
        assert.strictEqual(r.found, true);
        assert.deepStrictEqual(r.consoleScripts.map((c) => c.name), ['old']);
        assert.deepStrictEqual(r.installRequires, ['setuptools', 'numpy>=1.20']);
        assert.strictEqual(r.dataFiles.length, 1);
        assert.ok((r.dataFiles[0] as any).target.includes('/p') || JSON.stringify(r.dataFiles[0]).includes('share'), JSON.stringify(r.dataFiles[0]));
        assert.ok(r.entryPoints['console_scripts'], 'console_scripts 组应存在');
    });

    it('加法式 console_scripts(变量 + 调用点合并)→ 基础+新增合并、无脏项', () => {
        const text = [
            'from setuptools import setup',
            'entry_points = {',
            "    'console_scripts': [",
            "        'talker = p.talker:main',",
            "        'listener = p.listener:main',",
            '    ],',
            '}',
            'setup(',
            '    name="p",',
            '    entry_points={',
            '        **entry_points,',
            '        "console_scripts": entry_points["console_scripts"] + [',
            "            'zz = p.zz:main', # [rde-ros-2 扩展生成] 2026-09-04 02:11",
            '        ],',
            '    },',
            ')',
            '',
        ].join('\n');
        const r = parseSetupPy(text);
        assert.deepStrictEqual(r.consoleScripts.map((c) => c.name), ['talker', 'listener', 'zz']);
        const group = r.entryPoints['console_scripts'];
        assert.deepStrictEqual(group, [
            'talker = p.talker:main',
            'listener = p.listener:main',
            'zz = p.zz:main',
        ]);
        assert.ok(!group.some((g) => g === 'console_scripts'), '不得出现脏项 console_scripts');
    });

    it('内联 entry_points 形态不受影响', () => {
        const text = "setup(name='p', entry_points={'console_scripts': ['a = m.a:main']})\n";
        const r = parseSetupPy(text);
        assert.deepStrictEqual(r.consoleScripts.map((c) => c.name), ['a']);
    });
});
