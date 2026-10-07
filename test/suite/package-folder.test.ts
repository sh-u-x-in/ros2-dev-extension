// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-folder.test.ts
 * package-folder 包文件夹名冲突校验单元测试
 *
 * 纯逻辑测试:不依赖 VS Code / 真实文件系统,直接用 mocha 运行。
 * 运行方式:
 *   npm run test-compile && npx mocha out/test/suite/package-folder.test.js
 */

import * as assert from 'assert';
import { validatePackageFolder } from '../../src/build-tool/package-service/create/naming/package-folder';

describe('validatePackageFolder', () => {
    it('文件夹不存在 → null(可创建)', () => {
        assert.strictEqual(validatePackageFolder('abc', () => false), null);
        assert.strictEqual(validatePackageFolder('my_pkg', (p) => p === 'other'), null);
    });

    it('文件夹已存在 → 返回冲突信息(含包名)', () => {
        const e = validatePackageFolder('lll', (p) => p === 'lll');
        assert.ok(e !== null);
        assert.ok(e!.includes('lll'));
        assert.ok(e!.includes('already exists'));
    });

    it('空包名按不存在处理? 不: 由调用方保证包名已通过 validatePackageName', () => {
        // 纯校验只关注存在性, 包名格式由 validatePackageName 负责
        assert.strictEqual(validatePackageFolder('', () => false), null);
    });
});
