// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file rosmsg-interface-name.test.ts
 * 接口名合规判定(rosidl 语义镜像)单元测试——纯函数零依赖,无需 vscode stub
 *
 * 覆盖:
 *  - interfaceKindOf:三类扩展名判定(大小写容错)
 *  - msg 基名:正则规则 + Sample_/生成后缀剥离怪例(连环剥不 break、单趟循环、_Event 不剥)
 *  - srv/action 种类感知:构造消息名后判定(Foo_Request.srv 构建期实际失败等)
 */

import * as assert from 'assert';
import {
    interfaceKindOf,
    isRosidlCompliantInterfaceName,
    isRosidlValidMessageName,
    ROSIDL_MESSAGE_NAME_PATTERN
} from '../../src/languages/rosmsg/parse/interface-name';

describe('接口名合规(rosidl 镜像)', () => {
    describe('interfaceKindOf', () => {
        it('三类扩展名 → 对应种类', () => {
            assert.strictEqual(interfaceKindOf('pkg/msg/Foo.msg'), 'msg');
            assert.strictEqual(interfaceKindOf('pkg/srv/Foo.srv'), 'srv');
            assert.strictEqual(interfaceKindOf('pkg/action/Foo.action'), 'action');
        });

        it('扩展名大小写容错;其它扩展名/无扩展名 → undefined', () => {
            assert.strictEqual(interfaceKindOf('Foo.MSG'), 'msg');
            assert.strictEqual(interfaceKindOf('Foo.txt'), undefined);
            assert.strictEqual(interfaceKindOf('Foo'), undefined);
        });
    });

    describe('msg 基名(isRosidlCompliantInterfaceName "msg")', () => {
        const valid = (b: string): boolean => isRosidlCompliantInterfaceName('msg', b);

        it('合法:PascalCase 纯字母数字(含数字尾缀)', () => {
            assert.ok(valid('Foo'));
            assert.ok(valid('Foo2'));
            assert.ok(valid('MyMessage'));
        });

        it('非法:小写开头/下划线/连字符/点/空格/非 ASCII/数字开头/空名', () => {
            for (const bad of ['foo', 'myMsg', 'My_Msg', 'My-Msg', 'My.Msg', 'My Msg', 'Мsg', '2Foo', '']) {
                assert.ok(!valid(bad), `"${bad}" 应判不合规`);
            }
        });

        it('剥前缀怪例:Sample_ 前缀仅剥一次 → Sample_Foo 合法,Sample_Sample_Foo / Sample_ 非法', () => {
            assert.ok(valid('Sample_Foo'));
            assert.ok(!valid('Sample_Sample_Foo'));
            assert.ok(!valid('Sample_'));
        });

        it('剥后缀不 break:Foo_Goal / Foo_Request 合法,Foo_Goal_Request 连环剥后归 Foo 合法', () => {
            assert.ok(valid('Foo_Goal'));
            assert.ok(valid('Foo_Request'));
            assert.ok(valid('Foo_Goal_Request'));
        });

        it('_Event 不参与剥离;单趟循环下 Foo_Goal_Goal 剥一次后仍非法', () => {
            assert.ok(!valid('Foo_Event'));
            assert.ok(!valid('Foo_Goal_Goal'));
        });
    });

    describe('srv 基名(构造 +_Request/+_Response 后判定)', () => {
        const valid = (b: string): boolean => isRosidlCompliantInterfaceName('srv', b);

        it('合法 PascalCase → 合规', () => {
            assert.ok(valid('Foo'));
            assert.ok(valid('Foo2'));
        });

        it('小写开头 → 不合规', () => {
            assert.ok(!valid('foo'));
        });

        it('Foo_Request → 不合规(构造 Foo_Request_Request 单次剥后缀仍带下划线)', () => {
            assert.ok(!valid('Foo_Request'));
        });

        it('Foo_Goal → 合规(两个构造名连环剥后均归 Foo)', () => {
            assert.ok(valid('Foo_Goal'));
        });
    });

    describe('action 基名(构造 +_Goal/+_Result/+_Feedback 后判定)', () => {
        const valid = (b: string): boolean => isRosidlCompliantInterfaceName('action', b);

        it('合法 PascalCase → 合规', () => {
            assert.ok(valid('Foo'));
        });

        it('小写开头 → 不合规', () => {
            assert.ok(!valid('foo'));
        });

        it('Foo_Request / Foo_Goal → 不合规(构造名单趟剥离后仍带下划线)', () => {
            assert.ok(!valid('Foo_Request'));
            assert.ok(!valid('Foo_Goal'));
        });
    });

    describe('isRosidlValidMessageName 与模式常量', () => {
        it('模式原文常量与 rosidl 逐字节一致', () => {
            assert.strictEqual(ROSIDL_MESSAGE_NAME_PATTERN, '^[A-Z][A-Za-z0-9]*$');
        });

        it('带盘符/路径的分隔不影响单名判定(单名入口只收基名)', () => {
            assert.ok(isRosidlValidMessageName('Foo'));
            assert.ok(!isRosidlValidMessageName('Foo/Bar'));
        });
    });
});
