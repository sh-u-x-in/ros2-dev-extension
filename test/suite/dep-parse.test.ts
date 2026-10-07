// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file dep-parse.test.ts
 * dep-parse 额外依赖输入解析单元测试
 *
 * 纯逻辑测试:不依赖 VS Code,直接用 mocha 运行。
 * 运行方式:
 *   npm run test-compile && npx mocha out/test/suite/dep-parse.test.js
 */

import * as assert from 'assert';
import { parseDepList, validateDepList, DEP_BUILTIN } from '../../src/build-tool/package-service/create/deps/dep-parse';

describe('parseDepList', () => {
    it('空输入 → 空列表', () => {
        assert.deepStrictEqual(parseDepList(''), []);
        assert.deepStrictEqual(parseDepList('   '), []);
    });

    it('空格分隔 → 独立项', () => {
        assert.deepStrictEqual(parseDepList('std_msgs nav_msgs geometry_msgs'),
            ['std_msgs', 'nav_msgs', 'geometry_msgs']);
    });

    it('逗号分隔(含逗号+空格)→ 独立项且无逗号残留', () => {
        assert.deepStrictEqual(parseDepList('std_msgs, nav_msgs,geometry_msgs'),
            ['std_msgs', 'nav_msgs', 'geometry_msgs']);
    });

    it('混合分隔 → 独立项', () => {
        assert.deepStrictEqual(parseDepList('  a, b   c ,d '),
            ['a', 'b', 'c', 'd']);
    });

    it('单个依赖 → 单元素列表', () => {
        assert.deepStrictEqual(parseDepList('lll'), ['lll']);
    });
});

describe('validateDepList: 三类处理', () => {
    it('空输入 → null(合法)', () => {
        assert.strictEqual(validateDepList('', 'mixed'), null);
        assert.strictEqual(validateDepList('   ', 'python'), null);
    });

    it('普通依赖 → 任何 kind 都合法', () => {
        for (const kind of ['cpp-only', 'cpp-dual', 'mixed', 'python'] as const) {
            assert.strictEqual(validateDepList('std_msgs nav_msgs', kind), null);
        }
    });

    it('非法包名 → 报错(与 kind 无关)', () => {
        assert.ok(validateDepList('MyPkg', 'mixed')!.includes('is invalid'));
        assert.ok(validateDepList('std-msgs', 'python')!.includes('is invalid'));
    });

    it('完全重复默认依赖 → 合法(由生成层静默去重)', () => {
        // mixed 已含 rclcpp/rclpy/ament_cmake_python, 重复输入不算错(生成层过滤)
        assert.strictEqual(validateDepList('rclcpp rclpy ament_cmake_python', 'mixed'), null);
        // cpp-dual 已含 rclpy
        assert.strictEqual(validateDepList('rclpy', 'cpp-dual'), null);
    });

    it('升级信号: cpp-only 加 rclpy / ament_cmake_python → 报错', () => {
        assert.ok(validateDepList('rclpy', 'cpp-only')!.includes('hybrid package'));
        assert.ok(validateDepList('ament_cmake_python', 'cpp-only')!.includes('hybrid package'));
    });

    it('升级信号: cpp-dual 加 ament_cmake_python → 报错', () => {
        assert.ok(validateDepList('ament_cmake_python', 'cpp-dual')!.includes('hybrid package'));
    });

    it('跨体系不可能: python 加 rclcpp / ament_cmake_python → 报错', () => {
        assert.ok(validateDepList('rclcpp', 'python')!.includes('C++'));
        assert.ok(validateDepList('ament_cmake_python', 'python')!.includes('CMake'));
    });
});

describe('DEP_BUILTIN: 各 kind 默认依赖集合', () => {
    it('cpp-only 含 rclcpp, 不含 rclpy', () => {
        assert.ok(DEP_BUILTIN['cpp-only'].includes('rclcpp'));
        assert.ok(!DEP_BUILTIN['cpp-only'].includes('rclpy'));
    });
    it('cpp-dual 含 rclcpp+rclpy', () => {
        assert.ok(DEP_BUILTIN['cpp-dual'].includes('rclcpp'));
        assert.ok(DEP_BUILTIN['cpp-dual'].includes('rclpy'));
    });
    it('mixed 含四项(含 ament_cmake_python)', () => {
        assert.deepStrictEqual(DEP_BUILTIN.mixed,
            ['ament_cmake', 'rclcpp', 'rclpy', 'ament_cmake_python']);
    });
    it('python 仅含 rclpy', () => {
        assert.deepStrictEqual(DEP_BUILTIN.python, ['rclpy']);
    });
});
