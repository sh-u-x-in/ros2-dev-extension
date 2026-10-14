// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file create-template-l10n.test.ts
 * 生成包模板「教学注释 L10N」守卫测试(2026-10-12,用户裁定「路线 2」)。
 *
 * 锁三件事:
 *  ① 缺省(英语源)输出**不含任何 CJK 字符**——templates/README「④ 语言口径:生成文件内
 *     注释一律英文(按语种单语)」从此有测试锁,任何模板改动混入中文直接红(根治市场 issue #5 类混排);
 *  ② commentLang: 'zh-cn' 冒烟——各生成物的教学注释按 l10n/templates/zh-cn.ts 中文表出单语;
 *  ③ normalizeCommentLang 映射口径(zh* → zh-cn,其余/空 → en)。
 */

import * as assert from 'assert';
import {
    generateCppPackageFiles,
} from '../../src/build-tool/package-service/create/generate/create-cpp-package';
import {
    generatePythonPackageFiles,
} from '../../src/build-tool/package-service/create/generate/create-python-package';
import {
    normalizeCommentLang,
} from '../../l10n/templates/index';

/** CJK 统一表意字符(含扩展 A;守卫口径 = 生成物内不允许出现) */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** 便捷: 取生成清单中某路径的内容 */
function contentOf(files: { path: string; content: string }[], p: string): string {
    const f = files.find((x) => x.path === p);
    assert.ok(f, `缺少文件 ${p}`);
    return f!.content;
}

/** 便捷: 断言清单内所有文件内容都不含 CJK */
function assertNoCjk(files: { path: string; content: string }[], label: string): void {
    for (const f of files) {
        assert.ok(!CJK.test(f.content), `${label}/${f.path} 含 CJK 字符(生成物必须单语英文):${f.content.split('\n').find((l) => CJK.test(l)) ?? ''}`);
    }
}

describe('create 模板教学注释 L10N(英语源 + zh-cn 译文表)', () => {

    it('normalizeCommentLang: zh* 归一 zh-cn;其余语言/空回退 en', () => {
        assert.strictEqual(normalizeCommentLang('zh-cn'), 'zh-cn');
        assert.strictEqual(normalizeCommentLang('zh-tw'), 'zh-cn');
        assert.strictEqual(normalizeCommentLang('zh'), 'zh-cn');
        assert.strictEqual(normalizeCommentLang('en'), 'en');
        assert.strictEqual(normalizeCommentLang('ja'), 'en');
        assert.strictEqual(normalizeCommentLang(undefined), 'en');
        assert.strictEqual(normalizeCommentLang(''), 'en');
    });

    it('守卫: 缺省(en 源)三类包生成物全部无 CJK 字符', () => {
        for (const kind of ['cpp-only', 'cpp-dual', 'mixed'] as const) {
            const files = generateCppPackageFiles({ packageName: 'demo_pkg', kind });
            assertNoCjk(files, `en/${kind}`);
        }
        const py = generatePythonPackageFiles({ packageName: 'demo_pkg', nodeNames: ['talker'] });
        assertNoCjk(py, 'en/python');
    });

    it('等价: commentLang 缺省与显式 "en" 输出逐字节一致', () => {
        for (const kind of ['cpp-only', 'cpp-dual', 'mixed'] as const) {
            const implicit = generateCppPackageFiles({ packageName: 'demo_pkg', kind });
            const explicit = generateCppPackageFiles({ packageName: 'demo_pkg', kind, commentLang: 'en' });
            assert.deepStrictEqual(implicit, explicit, `kind=${kind} 缺省与显式 en 不一致`);
        }
        assert.deepStrictEqual(
            generatePythonPackageFiles({ packageName: 'demo_pkg', nodeNames: ['talker'] }),
            generatePythonPackageFiles({ packageName: 'demo_pkg', nodeNames: ['talker'], commentLang: 'en' }),
            'python 缺省与显式 en 不一致',
        );
    });

    it('zh-cn 冒烟: C++ 类包(CMakeLists/package.xml/节点源/__init__ docstring)按中文表出单语', () => {
        const files = generateCppPackageFiles({ packageName: 'demo_pkg', kind: 'mixed', commentLang: 'zh-cn' });
        const cmake = contentOf(files, 'CMakeLists.txt');
        assert.ok(cmake.includes('示范包 (ament_cmake) 的构建脚本'), 'CMakeLists 头注释未走中文表');
        assert.ok(cmake.includes('## 构建 ##'), 'CMakeLists 构建段标尺未走中文表');
        assert.ok(cmake.includes('## 对外提供头文件/库 (让别人 #include / 链接) ##'), 'CMakeLists 导出段标尺未走中文表');
        // CXX 标准 guard 注释入表(2026-10-14):27952df 曾硬编码英文绕过体系,中文 UI 下全文件唯它混排
        assert.ok(cmake.includes('默认采用当前 ROS 2 发行版的 C++ 标准'), 'CMakeLists CXX 标准 guard 注释未走中文表');
        assert.ok(!cmake.includes('Default to the C++ standard'), 'CMakeLists 残留英文 guard 注释(中英混排)');
        const pkgXml = contentOf(files, 'package.xml');
        assert.ok(pkgXml.includes('示范包的包清单'), 'package.xml 头注释未走中文表');
        assert.ok(pkgXml.includes('混合示范包 (ament_cmake: C++ 节点 + Python 模块)'), 'package.xml 变体描述未走中文表');
        assert.ok(pkgXml.includes('包名 (全局唯一; 构建与运行都用它)'), 'package.xml XML 教学注释未走中文表');
        const cpp = files.find((f) => f.path.endsWith('.cpp'));
        assert.ok(cpp && cpp.content.includes('最小示范节点'), 'C++ 节点源注释未走中文表');
        const init = contentOf(files, 'demo_pkg/__init__.py');
        assert.ok(init.includes('的 Python 模块 (供 import 复用)'), 'mixed __init__ docstring 未走中文表');
    });

    it('zh-cn 冒烟: Python 包(setup.py/setup.cfg/节点源)按中文表出单语', () => {
        const files = generatePythonPackageFiles({ packageName: 'demo_pkg', nodeNames: ['talker'], commentLang: 'zh-cn' });
        const setup = contentOf(files, 'setup.py');
        assert.ok(setup.includes('纯 Python 包 (ament_python) 的构建脚本'), 'setup.py 头注释未走中文表');
        assert.ok(setup.includes('## 基础信息 ##'), 'setup.py 段落标尺未走中文表');
        const cfg = contentOf(files, 'setup.cfg');
        assert.ok(cfg.includes('配合 setup.py 的打包配置'), 'setup.cfg 头注释未走中文表');
        const node = files.find((f) => f.path.endsWith('talker.py'));
        assert.ok(node && node.content.includes('继承 rclpy.node.Node'), 'Python 节点源注释未走中文表');
        // docstring 已入表(2026-10-12):zh 输出必须中文 docstring,杜绝"英文 docstring + 中文注释"混排
        assert.ok(node && node.content.includes('最小示范节点: 继承 rclpy Node, 注册节点并打印节点名 (一次)。'), 'Python 节点 docstring 未走中文表');
    });

    it('shebang 按执行方式分派(方案 B):直装直执行路径保留,入口点路径不写', () => {
        // cpp-dual scripts / mixed 模块:install(PROGRAMS) 直装 lib/<pkg>/ 被 ros2 run 直接执行 ⇒ 保留 shebang
        for (const kind of ['cpp-dual', 'mixed'] as const) {
            const files = generateCppPackageFiles({ packageName: 'demo_pkg', kind });
            const pyFiles = files.filter((f) => f.path.endsWith('.py') && !f.path.endsWith('__init__.py'));
            for (const f of pyFiles) {
                assert.ok(f.content.startsWith('#!/usr/bin/env python3\n'), `${kind}/${f.path} 直执行路径缺 shebang`);
            }
        }
        // ament_python 模块:console_scripts 入口点执行(包装器自带 shebang)⇒ 不写,以 docstring 开头
        const py = generatePythonPackageFiles({ packageName: 'demo_pkg', nodeNames: ['talker'] });
        const node = py.find((f) => f.path.endsWith('talker.py'))!;
        assert.ok(!node.content.startsWith('#!'), 'ament_python 模块不应写 shebang');
        assert.ok(node.content.startsWith('"""'), 'ament_python 模块应以 docstring 开头');
    });
});
