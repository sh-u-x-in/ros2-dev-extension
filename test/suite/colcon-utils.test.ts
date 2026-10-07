/**
 * Colcon Utils Test
 * 
 * Test the colcon utilities for package discovery and ignore management.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isValidPackageXml } from '../../src/build-tool/package-core/api';

describe('Colcon Utils Tests', () => {
    // 2026-08-30:getPackages / findPackageForPath 用例已删除(旧壳 colcon-utils API 2026-08-28 退役),
    // 仅保留 isValidPackageXml(纯逻辑校验,自 package-core/api 导入)。
    describe('isValidPackageXml', () => {
        // 临时包目录:package.xml + 可选构建文件
        function tmpPkg(packageXml: string, buildFile: string | null = 'CMakeLists.txt'): string {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colcon-pkg-'));
            fs.writeFileSync(path.join(dir, 'package.xml'), packageXml, 'utf8');
            if (buildFile) {
                fs.writeFileSync(path.join(dir, buildFile), '# stub\n', 'utf8');
            }
            return dir;
        }

        it('合法 package.xml(声明 ament_cmake)+ 构建文件 → true', async () => {
            const dir = tmpPkg('<package><name>my_pkg</name><export><build_type>ament_cmake</build_type></export></package>');
            assert.strictEqual(await isValidPackageXml(dir), true);
        });

        it('未声明 build_type → false(2026-08-22 收紧口径:未声明不合法)', async () => {
            const dir = tmpPkg('<package><name>my_pkg</name></package>');
            assert.strictEqual(await isValidPackageXml(dir), false);
        });

        it('未闭合标签 → false', async () => {
            const dir = tmpPkg('<package><name>my_pkg</package>');
            assert.strictEqual(await isValidPackageXml(dir), false);
        });

        it('不匹配闭合 → false', async () => {
            const dir = tmpPkg('<package><name>my_pkg</name2></package>');
            assert.strictEqual(await isValidPackageXml(dir), false);
        });

        it('多根元素 → false', async () => {
            const dir = tmpPkg('<package><name>my_pkg</name></package><extra/>');
            assert.strictEqual(await isValidPackageXml(dir), false);
        });

        it('根外非空白文本 → false', async () => {
            const dir = tmpPkg('hello<package><name>my_pkg</name></package>');
            assert.strictEqual(await isValidPackageXml(dir), false);
        });

        it('注释干扰不阻断 → true', async () => {
            const dir = tmpPkg('<!-- 说明 --><package><name>my_pkg</name><export><build_type>ament_cmake</build_type></export></package>');
            assert.strictEqual(await isValidPackageXml(dir), true);
        });

        it('声明 ament_cmake 但无构建文件 → false(缺 CMakeLists.txt)', async () => {
            const dir = tmpPkg('<package><name>my_pkg</name><export><build_type>ament_cmake</build_type></export></package>', null);
            assert.strictEqual(await isValidPackageXml(dir), false);
        });
    });

});
