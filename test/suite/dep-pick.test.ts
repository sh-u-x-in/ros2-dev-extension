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
import { parseUserIndexValue, descriptionOverrideOf, USER_INDEX_SETTING } from '../../src/build-tool/package-service/create/deps/dep-lang';

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

describe('parseUserIndexValue(用户补充索引 value 解析,2026-10-13)', () => {
    it('py| 前缀 → 强制纯 Python 标注 + 描述为后文(可再含 |)', () => {
        assert.deepStrictEqual(parseUserIndexValue('py|我的自定义包'), { py: true, description: '我的自定义包' });
        assert.deepStrictEqual(parseUserIndexValue('PY|a|b'), { py: true, description: 'a|b' }, '前缀忽略大小写,描述可含 |');
    });

    it('cpp| 前缀 → 无强制标注,描述为后文', () => {
        assert.deepStrictEqual(parseUserIndexValue('cpp|某些 C++ 包'), { py: false, description: '某些 C++ 包' });
    });

    it('非法前缀(osdcno|)→ 前缀直接丢弃,正常显示描述', () => {
        assert.deepStrictEqual(parseUserIndexValue('osdcno|忘了怎么写'), { py: false, description: '忘了怎么写' });
    });

    it('无 | → 全值为描述,无强制标注(cpp 默认)', () => {
        assert.deepStrictEqual(parseUserIndexValue('纯描述'), { py: false, description: '纯描述' });
    });

    it('空 value → 空描述', () => {
        assert.deepStrictEqual(parseUserIndexValue(''), { py: false, description: '' });
    });

    it('转义:cpp 描述经 \\| 携带 | 字符,无分隔符 → 全句为描述', () => {
        assert.deepStrictEqual(parseUserIndexValue('性能\\|延迟权衡'), { py: false, description: '性能|延迟权衡' });
    });

    it('转义:py 标注描述内同样生效;旧 leading-| 写法向后兼容', () => {
        assert.deepStrictEqual(parseUserIndexValue('py|要点\\|备注'), { py: true, description: '要点|备注' });
        assert.deepStrictEqual(parseUserIndexValue('|一段描述|一段描述'), { py: false, description: '一段描述|一段描述' });
    });

    it('转义扫描:仅未转义的 | 是分隔符(既有 osdcno| 丢弃行为不变)', () => {
        assert.deepStrictEqual(parseUserIndexValue('osdcno|忘了怎么写'), { py: false, description: '忘了怎么写' });
    });
});

describe('descriptionOverrideOf(按包名查覆盖,未命中 undefined)', () => {
    const map = {
        'my_pkg': 'py|我的自定义包',
        'sys_pkg': '系统包描述覆盖',
        'empty_pkg': '',
    };

    it('命中 → 解析结果', () => {
        assert.deepStrictEqual(descriptionOverrideOf(map, 'my_pkg'), { py: true, description: '我的自定义包' });
        assert.deepStrictEqual(descriptionOverrideOf(map, 'sys_pkg'), { py: false, description: '系统包描述覆盖' });
    });

    it('value 空串 → 清空描述(py=false)', () => {
        assert.deepStrictEqual(descriptionOverrideOf(map, 'empty_pkg'), { py: false, description: '' });
    });

    it('未命中 → undefined(条目不显示的语义由调用方保证)', () => {
        assert.strictEqual(descriptionOverrideOf(map, 'nope'), undefined);
        assert.strictEqual(descriptionOverrideOf(undefined, 'my_pkg'), undefined);
    });

    it('键名锁:ROS2.packages.userIndex(照 preflight 键名锁先例)', () => {
        assert.strictEqual(USER_INDEX_SETTING, 'packages.userIndex');
    });
});
