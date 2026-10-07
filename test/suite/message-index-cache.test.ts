// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file message-index-cache.test.ts
 * 工作区消息缓存序列化(workspaceCacheTo/FromPayload)单元测试 —— v4 正表快照格式。
 *
 * 覆盖:
 *  - 序列化 → 反序列化 往返内容一致(真包 + 非法包哨兵行)
 *  - 反表由正表重建(路径点查可用)
 *  - 版本不符 / 缺失 pkgRows / undefined 载荷 → 返回 undefined(缓存失效)
 *  - 空工作区 → 往返为空
 */

import * as assert from 'assert';
import {
    workspaceCacheToPayload,
    workspaceCacheFromPayload,
} from '../../src/languages/rosmsg/data/message-index';
import type { PkgRow } from '../../src/languages/rosmsg/data/tables';
import { LOOSE_PKG } from '../../src/languages/rosmsg/data/tables';

/** 构造多包 + 非法桶的正表快照(顺序故意打乱,验证装载时归一排序) */
function makePkgRows(): PkgRow[] {
    return [
        {
            pkg: 'my_pkg',
            entries: [{ name: 'MsgA', path: '/ws/src/my_pkg/MsgA.msg' }],
        },
        {
            pkg: '_fmt_demo',
            entries: [
                { name: 'demo3', path: '/ws/src/_fmt_demo/demo3.msg' },
                { name: 'demo1', path: '/ws/src/_fmt_demo/demo1.msg' },
            ],
        },
        {
            pkg: LOOSE_PKG,
            entries: [{ name: 'demo4', path: '/ws/_fmt_demo/demo4.msg' }],
        },
    ];
}

describe('工作区消息缓存序列化(workspaceCacheTo/FromPayload,v4 正表快照)', () => {
    it('往返:序列化 → 反序列化 内容一致(真包+非法包哨兵)', () => {
        const payload = workspaceCacheToPayload(makePkgRows(), '/ws');
        assert.strictEqual(payload.version, 4);
        assert.strictEqual(payload.workspaceRoot, '/ws');
        const back = workspaceCacheFromPayload(payload);
        assert.ok(back, '反序列化不应返回 undefined');
        assert.strictEqual(back.pkgRows.length, 3, '应有 my_pkg / _fmt_demo / 哨兵 三行');

        const demo = back.pkgRows.find((r) => r.pkg === '_fmt_demo')!;
        assert.strictEqual(demo.entries.length, 2);
        assert.strictEqual(demo.entries[0].name, 'demo1', '行内按消息名升序重建');
        assert.strictEqual(demo.entries[0].path, '/ws/src/_fmt_demo/demo1.msg');

        const loose = back.pkgRows.find((r) => r.pkg === LOOSE_PKG)!;
        assert.strictEqual(loose.entries[0].path, '/ws/_fmt_demo/demo4.msg');

        // 正表外层按包名升序(哨兵 '<loose>' 的 '<' 码位最小,排最前)
        assert.strictEqual(back.pkgRows[0].pkg, LOOSE_PKG);
    });

    it('反表由正表重建:路径点查立即可用', () => {
        const payload = workspaceCacheToPayload(makePkgRows(), '/ws');
        const back = workspaceCacheFromPayload(payload)!;
        assert.strictEqual(back.pathRows.length, 4);
        const row = back.pathRows.find((r) => r.path === '/ws/src/_fmt_demo/demo3.msg');
        assert.ok(row);
        assert.strictEqual(row!.pkg, '_fmt_demo');
        const looseRow = back.pathRows.find((r) => r.path === '/ws/_fmt_demo/demo4.msg');
        assert.strictEqual(looseRow!.pkg, LOOSE_PKG);
        // 反表按路径升序
        for (let i = 1; i < back.pathRows.length; i++) {
            assert.ok(back.pathRows[i - 1].path <= back.pathRows[i].path, '反表应保持路径升序');
        }
    });

    it('版本不符 → 返回 undefined(缓存失效)', () => {
        const payload = workspaceCacheToPayload(makePkgRows(), '/ws');
        payload.version = 999;
        assert.strictEqual(workspaceCacheFromPayload(payload), undefined);
    });

    it('缺失 pkgRows → 返回 undefined', () => {
        const payload = workspaceCacheToPayload(makePkgRows(), '/ws') as any;
        delete payload.pkgRows;
        assert.strictEqual(workspaceCacheFromPayload(payload), undefined);
    });

    it('undefined 载荷 → 返回 undefined', () => {
        assert.strictEqual(workspaceCacheFromPayload(undefined), undefined);
    });

    it('空工作区 → 往返为空', () => {
        const payload = workspaceCacheToPayload([], '/ws');
        const back = workspaceCacheFromPayload(payload);
        assert.ok(back);
        assert.strictEqual(back.pkgRows.length, 0);
        assert.strictEqual(back.pathRows.length, 0);
    });
});
