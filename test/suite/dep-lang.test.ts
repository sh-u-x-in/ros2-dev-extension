// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file dep-lang.test.ts
 * dep-lang 依赖语言/来源判定单测(2026-09-06; 2026-09-14 增候选来源并集)。
 * 纯逻辑, 可直接 mocha:
 *   npm run test-compile && npx mocha out/test/suite/dep-lang.test.js
 */

import * as assert from 'assert';
import { makeLangContext, isWorkspaceDep, isPythonDep, EMPTY_LANG_CONTEXT, unionCandidateNames } from '../../src/build-tool/package-service/create/deps/dep-lang';

describe('makeLangContext / isWorkspaceDep', () => {
    const ctx = makeLangContext([
        { name: 'iii', buildType: 'ament_python' },
        { name: 'holle', buildType: 'ament_cmake' },
        { name: 'msg_iface', buildType: 'ament_cmake' },
    ]);

    it('工作区包判定: 收录即真, 未收录即假', () => {
        assert.strictEqual(isWorkspaceDep('iii', ctx), true);
        assert.strictEqual(isWorkspaceDep('holle', ctx), true);
        assert.strictEqual(isWorkspaceDep('std_msgs', ctx), false);
        assert.strictEqual(isWorkspaceDep('sensor_msgs_py', ctx), false);
    });

    it('空上下文: 无任何工作区包', () => {
        assert.strictEqual(isWorkspaceDep('iii', EMPTY_LANG_CONTEXT), false);
    });
});

describe('isPythonDep(纯 Python 判定)', () => {
    const ctx = makeLangContext([
        { name: 'iii', buildType: 'ament_python' },   // 工作区纯 Python(权威)
        { name: 'aaa', buildType: 'ament_cmake' },    // 工作区 CMake 包(权威)
    ]);

    it('工作区 buildType 权威: ament_python=true, ament_cmake=false', () => {
        assert.strictEqual(isPythonDep('iii', ctx), true);
        assert.strictEqual(isPythonDep('aaa', ctx), false);
    });

    it('系统已知纯 Python(KNOWN_PYTHON_ONLY 兜底): sensor_msgs_py/tf2_py 等', () => {
        assert.strictEqual(isPythonDep('sensor_msgs_py', EMPTY_LANG_CONTEXT), true);
        assert.strictEqual(isPythonDep('tf2_py', EMPTY_LANG_CONTEXT), true);
        assert.strictEqual(isPythonDep('ament_index_python', EMPTY_LANG_CONTEXT), true);
        assert.strictEqual(isPythonDep('rclpy', EMPTY_LANG_CONTEXT), true);
    });

    it('系统 C++/未知包: std_msgs=false, 未收录未来包=false(标注不猜)', () => {
        assert.strictEqual(isPythonDep('std_msgs', EMPTY_LANG_CONTEXT), false);
        assert.strictEqual(isPythonDep('future_lib_2099', EMPTY_LANG_CONTEXT), false);
    });
});

describe('unionCandidateNames(候选来源并集: 工作区已确认包 ∪ 环境可见包)', () => {
    // p17_unbuilt = 典型"在 src/ 里、已通过合法性检查、但从未构建"的工作区包(system 域不含它)
    const ws = [
        { name: 'iii', buildType: 'ament_python' },
        { name: 'p17_unbuilt', buildType: 'ament_cmake' },
    ];

    it('并集: 工作区条目在前(含未构建), 环境独有条目在后', () => {
        assert.deepStrictEqual(
            unionCandidateNames(ws, ['std_msgs', 'iii', 'nav_msgs']),
            ['iii', 'p17_unbuilt', 'std_msgs', 'nav_msgs'],
        );
    });

    it('同名去重且以工作区为准(只出现一次, 落在工作区段)', () => {
        assert.deepStrictEqual(unionCandidateNames(ws, ['p17_unbuilt']), ['iii', 'p17_unbuilt']);
    });

    it('环境侧缺席(null/undefined = 未刷新或现取失败) → 只用工作区侧, 不整体降级', () => {
        assert.deepStrictEqual(unionCandidateNames(ws, null), ['iii', 'p17_unbuilt']);
        assert.deepStrictEqual(unionCandidateNames(ws, undefined), ['iii', 'p17_unbuilt']);
    });

    it('工作区侧缺席(null = 未刷新) → 只用环境侧', () => {
        assert.deepStrictEqual(unionCandidateNames(null, ['std_msgs', 'nav_msgs']), ['std_msgs', 'nav_msgs']);
    });

    it('两侧都缺席/都为空 → 空数组(调用方据此降级纯输入框)', () => {
        assert.deepStrictEqual(unionCandidateNames(null, null), []);
        assert.deepStrictEqual(unionCandidateNames([], []), []);
    });

    it('空名剔除, 不产生空候选项', () => {
        assert.deepStrictEqual(unionCandidateNames([{ name: '' }], ['', 'std_msgs']), ['std_msgs']);
    });
});

describe('并集后的来源标注(未构建的工作区包同样命中 [本工作区包])', () => {
    const ctx = makeLangContext([{ name: 'p17_unbuilt', buildType: 'ament_cmake' }]);

    it('未构建工作区包: 来源可判(不依赖 system 是否收录)', () => {
        assert.strictEqual(isWorkspaceDep('p17_unbuilt', ctx), true);
        assert.strictEqual(isPythonDep('p17_unbuilt', ctx), false);
    });

    it('同名外部包与工作区包同名: 按工作区 buildType 权威判定', () => {
        const py = makeLangContext([{ name: 'collide', buildType: 'ament_python' }]);
        assert.strictEqual(isWorkspaceDep('collide', py), true);
        assert.strictEqual(isPythonDep('collide', py), true);
    });
});
