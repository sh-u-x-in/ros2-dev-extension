// Licensed under the MIT License.

/**
 * @file walk-config-sync.test.ts(2026-10-18 平铺批新增)
 * manifest 12 键 `ROS2.search.walkTimeout.<type>.<field>` default 与 walk-config.ts
 * `WALK_TIMEOUT_PROFILES` 的**同步锁**(shareSpec 同步锁先例):两处默认不得漂移;
 * 同时锁定下限政策(total/branch ≥1 关死 0=立即超时;depth ≥0)与 default 死枚举不复活。
 *
 * 纯 fs+json,零 vscode 依赖,双宿主真跑。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/walk-config-sync.test.js
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { WALK_TIMEOUT_PROFILES, getWalkTimeoutConfig } from '../../src/build-tool/walk/base/walk-config';

describe('walk-config 同步锁:manifest 12 键 default 与内置 profile 不漂移', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
        contributes: { configuration: Array<{ properties: Record<string, { default?: unknown; minimum?: number }> }> };
    };
    const props: Record<string, { default?: unknown; minimum?: number }> = {};
    pkg.contributes.configuration.forEach((b) => Object.assign(props, b.properties));

    const FIELDS = ['totalTimeoutMs', 'branchTimeoutMs', 'maxDepth'] as const;

    it('四个暴露 type × 三字段:default === 内置 profile 数值(逐字段)', () => {
        for (const profile of WALK_TIMEOUT_PROFILES) {
            if (profile.type === 'default') {
                continue; // default profile 仅内部兜底,无设置键(用户裁定删死枚举)
            }
            for (const field of FIELDS) {
                const key = `ROS2.search.walkTimeout.${profile.type}.${field}`;
                const decl = props[key];
                assert.ok(decl, `${key} 必须存在`);
                assert.strictEqual(decl.default, profile[field], `${key} default 与内置 profile 漂移`);
            }
        }
    });

    it('下限政策锁:total/branch minimum=1(0=立即超时 footgun 关死),maxDepth minimum=0', () => {
        for (const profile of WALK_TIMEOUT_PROFILES) {
            if (profile.type === 'default') {
                continue;
            }
            for (const field of FIELDS) {
                const key = `ROS2.search.walkTimeout.${profile.type}.${field}`;
                const want = field === 'maxDepth' ? 0 : 1;
                assert.strictEqual(props[key]?.minimum, want, `${key} minimum 应为 ${want}`);
            }
        }
    });

    it('死枚举不复活:default 组三键不存在;旧数组键已删除', () => {
        for (const field of FIELDS) {
            assert.strictEqual(props[`ROS2.search.walkTimeout.default.${field}`], undefined, 'default 组不得复活(零消费方)');
        }
        assert.strictEqual(props['ROS2.search.walkTimeouts'], undefined, '旧数组键应已删除');
    });

    it('内部兜底语义:未知 type 回退 default profile(引擎内部行为不随设置键收缩变化)', () => {
        const fallback = getWalkTimeoutConfig('default');
        assert.deepStrictEqual(
            { totalTimeoutMs: fallback.totalTimeoutMs, branchTimeoutMs: fallback.branchTimeoutMs, maxDepth: fallback.maxDepth },
            { totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8 },
        );
    });
});
