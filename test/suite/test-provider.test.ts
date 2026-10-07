// Licensed under the MIT License.

/**
 * 发现层工具单测(2026-09-24 测试改造 B6 重写)。
 *
 * 与旧版差异:旧版测的是 `isTestFile`(已删 —— 发现口径唯一真值是 walk 正则)与
 * `getPythonTestCommand`(已移 runner),并内联复刻了一份 `isPathExcluded` 逻辑去测自己;
 * 现在改为测**真实存在且承重**的纯逻辑:用例 id、两个解析器、包目录定位、walk 层路径排除。
 *
 * 纯逻辑,B6.6 可无头直跑(`npx mocha out/test/suite/test-provider.test.js`)。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TestDiscoveryUtils } from '../../src/test-provider/parsing/test-discovery-utils';
import { isPathExcluded, resolveExcludeFolders } from '../../src/build-tool/walk/base/path-exclude';

describe('ROS 2 Test Provider · 发现层工具(纯逻辑)', () => {
    let dir: string;

    const write = (rel: string, body: string): string => {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
        return full;
    };

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-tp-'));
    });
    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('pythonCaseId:有父类 → 文件::类::方法', () => {
        const id = TestDiscoveryUtils.pythonCaseId('file:///f.py', { name: 'test_a', line: 10, parent: 'TestX' });
        assert.strictEqual(id, 'file:///f.py::TestX::test_a');
    });

    it('pythonCaseId:无父类 → 并入行号(同名方法不再互踩,B3)', () => {
        const a = TestDiscoveryUtils.pythonCaseId('file:///f.py', { name: 'test_foo', line: 3 });
        const b = TestDiscoveryUtils.pythonCaseId('file:///f.py', { name: 'test_foo', line: 9 });
        assert.notStrictEqual(a, b);
        assert.ok(a.indexOf('@3') > 0 && b.indexOf('@9') > 0);
    });

    it('parsePythonTestFile:async def / 模块级 / 类内方法 / 参数化(B3)', () => {
        const file = write('test/test_demo.py', [
            'import pytest',
            '',
            'def test_module():',
            '    pass',
            '',
            'async def test_async():',
            '    pass',
            '',
            'class TestA(unittest.TestCase):',
            '    def test_in_class(self):',
            '        pass',
            '',
            'class Helper:',
            '    def test_no_test_class(self):',
            '        pass',
            '',
            '@pytest.mark.parametrize("x", [1, 2])',
            'def test_param(x):',
            '    pass',
        ].join('\n'));
        const methods = TestDiscoveryUtils.parsePythonTestFile(file).filter((e) => e.type === 'method');
        const names = methods.map((m) => m.name);
        assert.ok(names.indexOf('test_async') >= 0, 'async def 应被识别');
        assert.ok(names.indexOf('test_module') >= 0);
        assert.ok(names.indexOf('test_param') >= 0);
        assert.strictEqual((methods.find((m) => m.name === 'test_in_class') || {}).parent, 'TestA');
        // 已知边界:类名不含 Test 的类不被识别 → 方法挂模块级
        assert.strictEqual((methods.find((m) => m.name === 'test_no_test_class') || {}).parent, undefined);
    });

    it('parseCppTestFile:只认定义用例的宏,且带 macro 字段(B2)', () => {
        const file = write('test/test_macros.cpp', [
            'TEST(A, a) {}',
            'TEST_F(B, b) {}',
            'TEST_P(C, c) {}',
            'TYPED_TEST(D, d) {}',
            'TYPED_TEST_P(E, e) {}',
            'GTEST_TEST(F, f) {}',
            'TYPED_TEST_SUITE(G, GTypes);',
            'INSTANTIATE_TEST_SUITE_P(H, C, ::testing::Values(1));',
            'FRIEND_TEST(I, i);',
        ].join('\n'));
        const items = TestDiscoveryUtils.parseCppTestFile(file);
        assert.strictEqual(items.length, 6, '应只认 6 个定义用例的宏');
        assert.ok(!items.some((i) => i.suite === 'G'), 'TYPED_TEST_SUITE 是声明,不得产出伪项');
        assert.deepStrictEqual(
            items.map((i) => i.macro).sort(),
            ['GTEST_TEST', 'TEST', 'TEST_F', 'TEST_P', 'TYPED_TEST', 'TYPED_TEST_P']
        );
        assert.strictEqual(items.find((i) => i.macro === 'TEST_F').isFixture, true);
        assert.strictEqual(items.find((i) => i.macro === 'TEST').isFixture, false);
    });

    it('findPackageDir:向上找到 package.xml 所在目录', () => {
        const pkgXml = write('src/pkgA/package.xml', '<package><name>pkgA</name></package>');
        const testFile = write('src/pkgA/test/test_x.py', 'def test_x():\n    pass\n');
        assert.strictEqual(TestDiscoveryUtils.findPackageDir(testFile), path.dirname(pkgXml));
        const orphan = write('loose/test_y.py', 'def test_y():\n    pass\n');
        assert.strictEqual(TestDiscoveryUtils.findPackageDir(orphan), undefined);
    });

    it('walk 层 path-exclude:三种写法解析 + 目录边界判定(T11)', () => {
        const ws = path.join(os.tmpdir(), 'ws');
        const resolved = resolveExcludeFolders(ws, ['${workspaceFolder}/external', 'submodules', path.join(ws, 'abs')]);
        assert.strictEqual(resolved.length, 3);
        assert.strictEqual(resolved[0], path.normalize(path.join(ws, 'external')));
        assert.strictEqual(resolved[1], path.normalize(path.join(ws, 'submodules')));
        assert.strictEqual(resolved[2], path.normalize(path.join(ws, 'abs')));
        // 目录边界:同级同前缀不算命中
        assert.strictEqual(isPathExcluded(path.join(ws, 'external', 'test_a.py'), resolved), true);
        assert.strictEqual(isPathExcluded(path.join(ws, 'external2', 'test_a.py'), resolved), false);
        assert.strictEqual(isPathExcluded(path.join(ws, 'src', 'test_a.py'), resolved), false);
    });
});
