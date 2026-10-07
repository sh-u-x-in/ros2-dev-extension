// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file dep-pick.test.ts
 * 依赖多选纯逻辑单元测试(2026-09-01, 04-包创建依赖多选设计 §9)。
 * 覆盖:mergeDeps(合并/去重/内置过滤)、validateFinal(显式校验:升级/跨体系/全合法)、depAnnotation(元信息标注)。
 * 纯逻辑(dep-merge.ts / dep-parse.ts 零 vscode),可直接 mocha 运行:
 *   npm run test-compile && npx mocha out/test/suite/dep-pick.test.js
 */

import * as assert from 'assert';
import { mergeDeps, validateFinal, excludeBuiltin } from '../../src/build-tool/package-service/create/deps/dep-merge';
import { depAnnotation } from '../../src/build-tool/package-service/create/deps/dep-parse';

describe('mergeDeps (勾选项 ∪ 自定义, 内置过滤 + 去重)', () => {
    it('勾选+自定义合并: 结果含并集且顺序稳定(勾选在前, 自定义在后)', () => {
        const merged = mergeDeps(['std_msgs', 'nav_msgs'], ['geometry_msgs'], 'cpp-only');
        assert.deepStrictEqual(merged, ['std_msgs', 'nav_msgs', 'geometry_msgs']);
    });

    it('重复去重: 勾选 rclcpp + 自定义 rclcpp(未命中内置时) → 仅 1 个', () => {
        // 用非内置依赖验证"勾选∩自定义"去重
        const merged = mergeDeps(['std_msgs'], ['std_msgs'], 'cpp-only');
        assert.deepStrictEqual(merged, ['std_msgs']);
    });

    it('内置过滤: cpp-only 勾 rclcpp/ament_cmake → 静默剔除(生成器已有)', () => {
        const merged = mergeDeps(['rclcpp', 'ament_cmake', 'std_msgs'], [], 'cpp-only');
        assert.deepStrictEqual(merged, ['std_msgs']);
    });

    it('内置过滤 + 去重同时生效: mixed 勾 rclpy + 自定义 rclpy → 剔除', () => {
        const merged = mergeDeps(['rclpy'], ['rclpy'], 'mixed');
        assert.deepStrictEqual(merged, []);
    });

    it('python: rclpy 内置过滤, 普通依赖保留', () => {
        const merged = mergeDeps(['rclpy', 'std_msgs'], ['nav_msgs'], 'python');
        assert.deepStrictEqual(merged, ['std_msgs', 'nav_msgs']);
    });
});

describe('validateFinal (显式逐项校验)', () => {
    it('升级命中: cpp-only + [rclpy] → 非 null, 文案含「needs Python nodes」', () => {
        const err = validateFinal(['std_msgs', 'rclpy'], 'cpp-only');
        assert.ok(err !== null);
        assert.ok(err!.includes('needs Python nodes'));
    });

    it('跨体系命中: python + [rclcpp] → 非 null, 文案含「no CMakeLists」', () => {
        const err = validateFinal(['rclcpp'], 'python');
        assert.ok(err !== null);
        assert.ok(err!.includes('no CMakeLists'));
    });

    it('全合法 → null', () => {
        assert.strictEqual(validateFinal(['std_msgs', 'nav_msgs'], 'cpp-only'), null);
        assert.strictEqual(validateFinal([], 'cpp-only'), null);
    });
});

describe('excludeBuiltin (候选过滤: 内置依赖自动隐藏)', () => {
    it('cpp-only: rclcpp/ament_cmake 剔除, 其余保留', () => {
        assert.deepStrictEqual(excludeBuiltin(['rclcpp', 'ament_cmake', 'std_msgs', 'rclpy'], 'cpp-only'), ['std_msgs', 'rclpy']);
    });

    it('python: rclpy 剔除', () => {
        assert.deepStrictEqual(excludeBuiltin(['rclpy', 'std_msgs'], 'python'), ['std_msgs']);
    });

    it('全内置 → 空列表', () => {
        assert.deepStrictEqual(excludeBuiltin(['ament_cmake', 'rclcpp'], 'cpp-only'), []);
    });
});

describe('depAnnotation (QuickPick description 元信息标注, 纯文本)', () => {
    it('升级信号 → "[needs dual-language/hybrid package]"', () => {
        assert.strictEqual(depAnnotation('rclpy', 'cpp-only'), '[needs dual-language/hybrid package]');
        assert.strictEqual(depAnnotation('ament_cmake_python', 'cpp-dual'), '[needs dual-language/hybrid package]');
    });

    it('跨体系不可能 → "[unavailable for this package type]"', () => {
        assert.strictEqual(depAnnotation('rclcpp', 'python'), '[unavailable for this package type]');
    });

    it('内置依赖(已由 excludeBuiltin 隐藏)与普通依赖 → undefined(无标注)', () => {
        assert.strictEqual(depAnnotation('rclcpp', 'cpp-only'), undefined);
        assert.strictEqual(depAnnotation('std_msgs', 'cpp-only'), undefined);
        assert.strictEqual(depAnnotation('nav_msgs', 'python'), undefined);
    });
});
