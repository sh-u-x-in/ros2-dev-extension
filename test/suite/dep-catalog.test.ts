// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file dep-catalog.test.ts
 * 依赖目录常量表 + depTagClass 分类单测(2026-09-01, Phase 1)。
 * 覆盖:目录完整性(271 条, C4/C5 无描述)、lookupDep 命中/未命中、
 *      depTagClass 各类别抽查(对照 05 文档清单)、未收录包兜底 depend。
 * 纯数据, 零依赖, 可直接 mocha:
 *   npm run test-compile && npx mocha out/test/suite/dep-catalog.test.js
 */

import * as assert from 'assert';
import { DEP_CATALOG, DEP_CATALOG_SIZE, lookupDep, depTagClass, hasInterfaceIntent, depDescription, INTERFACE_GENERATOR_SIDE, INTERFACE_RUNTIME_SIDE } from '../../src/build-tool/package-service/create/deps/dep-catalog';

describe('DEP_CATALOG 完整性', () => {
    it('条目数 = 271(humble 桌面完整版清单)', () => {
        assert.strictEqual(DEP_CATALOG_SIZE, 271);
    });

    it('类别分布: depend 82 / buildtool 58 / exec 95 / metapkg 7 / demo 29', () => {
        const dist: Record<string, number> = {};
        for (const k of Object.keys(DEP_CATALOG)) {
            dist[DEP_CATALOG[k].cls] = (dist[DEP_CATALOG[k].cls] ?? 0) + 1;
        }
        assert.deepStrictEqual(dist, { depend: 82, buildtool: 58, exec: 95, metapkg: 7, demo: 29 });
    });

    it('C4/C5 不写描述(36 条无 desc = 7 metapkg + 29 demo)', () => {
        const noDesc = Object.values(DEP_CATALOG).filter((v) => !v.desc);
        assert.strictEqual(noDesc.length, 36);
        assert.ok(noDesc.every((v) => v.cls === 'metapkg' || v.cls === 'demo'));
    });

    it('关键归类抽查(05 文档 §3 边界): rosbag2 库系 depend, uncrustify_vendor buildtool', () => {
        assert.strictEqual(DEP_CATALOG['rosbag2_cpp'].cls, 'depend');
        assert.strictEqual(DEP_CATALOG['rosbag2_storage'].cls, 'depend');
        assert.strictEqual(DEP_CATALOG['rosbag2_transport'].cls, 'depend');
        assert.strictEqual(DEP_CATALOG['rosbag2_compression'].cls, 'depend');
        assert.strictEqual(DEP_CATALOG['uncrustify_vendor'].cls, 'buildtool');
        assert.strictEqual(DEP_CATALOG['rosidl_default_generators'].cls, 'buildtool');
        assert.strictEqual(DEP_CATALOG['rosidl_default_runtime'].cls, 'exec');
        assert.strictEqual(DEP_CATALOG['launch_ros'].cls, 'exec');
        assert.strictEqual(DEP_CATALOG['rclcpp'].cls, 'depend');
    });

    it('C1/C2/C3 全部有描述(A 粒度)', () => {
        for (const k of Object.keys(DEP_CATALOG)) {
            const cls = DEP_CATALOG[k].cls;
            if (cls === 'depend' || cls === 'buildtool' || cls === 'exec') {
                assert.ok(DEP_CATALOG[k].desc, `${k} 应有描述`);
            }
        }
    });
});

describe('lookupDep', () => {
    it('命中返回条目', () => {
        const info = lookupDep('rclcpp');
        assert.ok(info && info.cls === 'depend' && info.desc);
    });

    it('未命中返回 null', () => {
        assert.strictEqual(lookupDep('future_new_pkg'), null);
    });
});

describe('depDescription (QuickPick 作用说明, A 粒度)', () => {
    it('C1/C2/C3 → 一句话作用', () => {
        assert.ok(depDescription('rclcpp')!.includes('client library'));
        assert.ok(depDescription('std_msgs')!.includes('Standard message definitions'));
        assert.ok(depDescription('rosidl_default_generators')!.includes('generator'));
        assert.ok(depDescription('rviz2')!.includes('visualization'));
    });

    it('C4 元包 → "[元包/聚合]"', () => {
        assert.strictEqual(depDescription('ros_base'), '[元包/聚合]');
        assert.strictEqual(depDescription('desktop'), '[元包/聚合]');
    });

    it('C5 演示 → "[演示/教程]"', () => {
        assert.strictEqual(depDescription('action_tutorials_cpp'), '[演示/教程]');
        assert.strictEqual(depDescription('demo_nodes_py'), '[演示/教程]');
    });

    it('未收录 → undefined(不标注)', () => {
        assert.strictEqual(depDescription('future_new_pkg'), undefined);
    });
});

describe('hasInterfaceIntent (member_of_group 标配对, 06 文档 §3)', () => {
    it('两侧集合与 06 文档一致(11 生成器侧 / 9 运行支撑侧)', () => {
        assert.strictEqual(INTERFACE_GENERATOR_SIDE.length, 11);
        assert.strictEqual(INTERFACE_RUNTIME_SIDE.length, 9);
        assert.ok(INTERFACE_GENERATOR_SIDE.includes('rosidl_default_generators'));
        assert.ok(INTERFACE_RUNTIME_SIDE.includes('rosidl_default_runtime'));
    });

    it('标配对 → true (任意生成器侧 + 任意运行支撑侧)', () => {
        assert.strictEqual(hasInterfaceIntent(['rosidl_default_generators', 'rosidl_default_runtime']), true);
        assert.strictEqual(hasInterfaceIntent(['rosidl_generator_cpp', 'rosidl_runtime_cpp']), true);
        assert.strictEqual(hasInterfaceIntent(['rosidl_cmake', 'rclcpp', 'rosidl_default_runtime']), true);
    });

    it('半对(只一侧) → false', () => {
        assert.strictEqual(hasInterfaceIntent(['rosidl_default_generators']), false);
        assert.strictEqual(hasInterfaceIntent(['rosidl_default_runtime']), false);
    });

    it('只勾消息包/普通库(使用≠定义) → false', () => {
        assert.strictEqual(hasInterfaceIntent(['std_msgs', 'geometry_msgs']), false);
        assert.strictEqual(hasInterfaceIntent(['rclcpp', 'tf2_ros']), false);
        assert.strictEqual(hasInterfaceIntent([]), false);
    });
});

describe('depTagClass (消费形态分类)', () => {
    it('各类别命中', () => {
        assert.strictEqual(depTagClass('rclcpp'), 'depend');
        assert.strictEqual(depTagClass('ament_cmake'), 'buildtool');
        assert.strictEqual(depTagClass('rviz2'), 'exec');
        assert.strictEqual(depTagClass('ros_base'), 'metapkg');
        assert.strictEqual(depTagClass('action_tutorials_cpp'), 'demo');
        assert.strictEqual(depTagClass('turtlesim'), 'exec'); // 可运行演示应用, 消费形态=运行期 → C3
    });

    it('未收录包兜底 depend(安全超集, 不猜用法)', () => {
        assert.strictEqual(depTagClass('future_new_pkg'), 'depend');
        assert.strictEqual(depTagClass('my_custom_msgs'), 'depend');
    });
});
