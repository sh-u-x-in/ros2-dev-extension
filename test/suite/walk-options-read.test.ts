// Licensed under the MIT License.

/**
 * @file walk-options-read.test.ts(2026-10-18 平铺批新增)
 * 读取层 `readWalkTimeoutConfig(type)`(12 键 ROS2.search.walkTimeout.<type>.<field> 逐字段现读)
 * 的无头单测:未播种回落内置 profile / 合法值采纳 / 非法值(低于下限、非数)回落 /
 * 下限边界(total·branch 禁 0、depth 0 合法)/ walkOptions 集成。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/walk-options-read.test.js
 */

import * as assert from 'assert';

import { installVscodeStub, vscodeStubConfig } from './_vscode-stub';

installVscodeStub();

// walk-options import vscode → 无头先装 stub 再 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const walkOptionsMod = require('../../src/build-tool/walk/walk-options') as typeof import('../../src/build-tool/walk/walk-options');

describe('readWalkTimeoutConfig:12 键逐字段现读(2026-10-18 平铺批)', function () {
    before(function (this: Mocha.Context) {
        const g = global as unknown as { __vscodeStubInstalled?: boolean };
        if (!g.__vscodeStubInstalled) {
            this.skip(); // 播种走无头桩配置仓,集成宿主不可播种
        }
    });

    beforeEach(() => {
        vscodeStubConfig.reset();
    });

    it('未播种 → 回落内置 profile(message 10000/2000/8;test 30000/5000/12)', () => {
        assert.deepStrictEqual(walkOptionsMod.readWalkTimeoutConfig('message'), {
            totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8,
        });
        assert.deepStrictEqual(walkOptionsMod.readWalkTimeoutConfig('test'), {
            totalTimeoutMs: 30000, branchTimeoutMs: 5000, maxDepth: 12,
        });
    });

    it('合法值逐字段采纳(只动一个字段,其余仍回落)', () => {
        vscodeStubConfig.store['search.walkTimeout.message.totalTimeoutMs'] = 12345;
        assert.deepStrictEqual(walkOptionsMod.readWalkTimeoutConfig('message'), {
            totalTimeoutMs: 12345, branchTimeoutMs: 2000, maxDepth: 8,
        });
    });

    it('非法值回落:低于下限(0)/负数/非数字', () => {
        vscodeStubConfig.store['search.walkTimeout.package.totalTimeoutMs'] = 0;
        vscodeStubConfig.store['search.walkTimeout.package.branchTimeoutMs'] = -5;
        vscodeStubConfig.store['search.walkTimeout.package.maxDepth'] = 'twelve';
        assert.deepStrictEqual(walkOptionsMod.readWalkTimeoutConfig('package'), {
            totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8,
        });
    });

    it('下限边界:total/branch 取 1 合法;maxDepth 取 0 合法(仅根目录)', () => {
        vscodeStubConfig.store['search.walkTimeout.test.totalTimeoutMs'] = 1;
        vscodeStubConfig.store['search.walkTimeout.test.branchTimeoutMs'] = 1;
        vscodeStubConfig.store['search.walkTimeout.test.maxDepth'] = 0;
        assert.deepStrictEqual(walkOptionsMod.readWalkTimeoutConfig('test'), {
            totalTimeoutMs: 1, branchTimeoutMs: 1, maxDepth: 0,
        });
    });

    it('walkOptions 集成:播种值流入 WalkOptions 三字段', () => {
        vscodeStubConfig.store['search.walkTimeout.xacro.totalTimeoutMs'] = 20000;
        const opts = walkOptionsMod.walkOptions('xacro');
        assert.strictEqual(opts.totalTimeoutMs, 20000);
        assert.strictEqual(opts.branchTimeoutMs, 2000);
        assert.strictEqual(opts.maxDepth, 8);
        assert.ok(opts.excludedDirNames instanceof Set, '内置排除名单仍在');
    });
});
