// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file env-compare.test.ts
 * 环境比较单元测试(路径剔除 + 折叠序列/顺序指纹;纯逻辑,不依赖 VS Code)。
 * 运行方式:
 *   npm run test-compile && npx mocha out/test/suite/env-compare.test.js
 */

import * as assert from 'assert';
import * as path from 'path';
import {
    externalChanged,
    fingerprint,
    isWorkspaceEntry,
    normalizePathForCompare,
    snapshotChanged,
    valueShape,
} from '../../src/ros2/environment/env-compare';

/** 工作空间根(测试用) */
const WS = '/home/ros2/roa2_ws';
const wsA = `${WS}/install`;
const wsB = `${WS}/install/local/lib/python3.10/dist-packages`;
const opt = '/opt/ros/humble';
/** 平台路径分隔符(POSIX ":" / Windows ";")——2026-09-22 平台无关化后,夹具一律用它拼接 */
const D = path.delimiter;

describe('isWorkspaceEntry(前缀匹配与防误伤)', () => {
    it('等于工作空间根 → 是', () => {
        assert.strictEqual(isWorkspaceEntry(WS, WS), true);
    });
    it('工作空间子树 → 是', () => {
        assert.strictEqual(isWorkspaceEntry(wsA, WS), true);
        assert.strictEqual(isWorkspaceEntry(wsB, WS), true);
    });
    it('相似前缀(roa2_ws2)不受误伤', () => {
        assert.strictEqual(isWorkspaceEntry(`${WS}2/install`, WS), false);
        assert.strictEqual(isWorkspaceEntry(`${WS}-extra`, WS), false);
    });
    it('非工作空间条目 → 否', () => {
        assert.strictEqual(isWorkspaceEntry(opt, WS), false);
    });
});

describe('fingerprint(剔除 + 折叠序列)', () => {
    it('工作空间条目仅在最前 ≡ 完全不存在', () => {
        assert.strictEqual(fingerprint(opt, WS), fingerprint([wsA, opt].join(D), WS));
    });
    it('工作空间块内部乱序 → 指纹相同(不算变化)', () => {
        assert.strictEqual(
            fingerprint([wsA, wsB, opt].join(D), WS),
            fingerprint([wsB, wsA, opt].join(D), WS));
    });
    it('工作空间块被外部条目分裂 → 指纹不同(算变化)', () => {
        assert.notStrictEqual(
            fingerprint([wsA, opt].join(D), WS),
            fingerprint([wsA, opt, wsB].join(D), WS));
    });
    it('工作空间与外部条目的相对位置翻转 → 指纹不同(算变化)', () => {
        assert.notStrictEqual(
            fingerprint([wsA, opt].join(D), WS),
            fingerprint([opt, wsA].join(D), WS));
    });
    it('纯工作空间变量 → null(视为不存在)', () => {
        assert.strictEqual(fingerprint(wsA, WS), null);
        assert.strictEqual(fingerprint([wsA, wsB].join(D), WS), null);
    });
    it('空值变量 → 非 null(保真,不视为不存在)', () => {
        assert.notStrictEqual(fingerprint('', WS), null);
    });
});

describe('valueShape(空元素保真)', () => {
    it('连续/结尾空元素不被过滤', () => {
        assert.deepStrictEqual(valueShape(['a', '', 'b', ''].join(D), WS).ext, ['a', '', 'b', '']);
    });
    it('整值就是一个分隔符 → 两个空条目(POSIX 下即 GIT_EDITOR=":")', () => {
        assert.deepStrictEqual(valueShape(D, WS).ext, ['', '']);
    });
});

describe('externalChanged(外部变化判定)', () => {
    it('完全相同 → 无变化', () => {
        const pathValue = [wsA, `${opt}/bin`, '/usr/bin'].join(D);
        const amentValue = [wsA, opt].join(D);
        const a = { PATH: pathValue, AMENT: amentValue };
        const b = { PATH: pathValue, AMENT: amentValue };
        assert.strictEqual(externalChanged(a, b, WS), false);
    });
    it('工作空间条目增删/乱序(块内)→ 无变化', () => {
        const a = { P: [wsA, wsB, opt].join(D) };
        const b = { P: [wsA, wsB, `${wsB}2`, opt].join(D) };
        assert.strictEqual(externalChanged(a, b, WS), false);
        const c = { P: [wsB, wsA, opt].join(D) };
        assert.strictEqual(externalChanged(a, c, WS), false);
    });
    it('工作表空间首次构建(从无到有,仅块位)→ 无变化', () => {
        assert.strictEqual(externalChanged({ P: opt }, { P: [wsA, opt].join(D) }, WS), false);
    });
    it('变量从"不存在"到"纯工作空间值" → 无变化(视为不存在)', () => {
        assert.strictEqual(externalChanged({}, { P: wsA }, WS), false);
    });
    it('外部条目乱序 → 变化', () => {
        assert.strictEqual(
            externalChanged({ P: [wsA, 'a', 'b'].join(D) }, { P: [wsA, 'b', 'a'].join(D) }, WS), true);
    });
    it('外部条目增删 → 变化', () => {
        assert.strictEqual(
            externalChanged({ P: [wsA, 'a'].join(D) }, { P: [wsA, 'a', 'b'].join(D) }, WS), true);
    });
    it('工作空间块被分裂 → 变化', () => {
        assert.strictEqual(
            externalChanged({ P: [wsA, 'a'].join(D) }, { P: [wsA, 'a', wsB].join(D) }, WS), true);
    });
    it('shell 状态键(PWD 等)不参与比较', () => {
        const a = { PATH: opt, PWD: '/one' };
        const b = { PATH: opt, PWD: '/two' };
        assert.strictEqual(externalChanged(a, b, WS), false);
    });
    it('首轮(prev 缺失)→ 视为变化', () => {
        assert.strictEqual(externalChanged(undefined, { P: opt }, WS), true);
    });
});

describe('snapshotChanged(快照写入判定)', () => {
    it('值变化 → true;仅 shell 状态变化 → false', () => {
        assert.strictEqual(snapshotChanged({ A: '1' }, { A: '2' }), true);
        assert.strictEqual(snapshotChanged({ A: '1', PWD: '/x' }, { A: '1', PWD: '/y' }), false);
    });
    it('键增删 → true;首轮 → true', () => {
        assert.strictEqual(snapshotChanged({ A: '1' }, { A: '1', B: '2' }), true);
        assert.strictEqual(snapshotChanged(undefined, { A: '1' }), true);
    });
});

// 2026-09-22 平台无关化(修既有 Windows 缺陷):
//  · 归一化:反斜杠 → 正斜杠、去尾部斜杠(根 "/" 除外)、Windows 大小写不敏感;
//  · 路径型变量按 `path.delimiter` 拆分(不再是硬编码 ":"),Windows 上为 ";"。
describe('isWorkspaceEntry / valueShape:平台无关化(分隔符、尾斜杠、大小写)', () => {
    it('尾部斜杠的工作空间根:子树仍判为工作空间条目', () => {
        assert.strictEqual(isWorkspaceEntry('/ws/install', '/ws/'), true);
        assert.strictEqual(isWorkspaceEntry('/ws/install', '/ws'), true);
        assert.strictEqual(isWorkspaceEntry('/ws', '/ws/'), true);
    });

    it('归一化纯函数:反斜杠转正斜杠、去尾斜杠、根保留', () => {
        assert.strictEqual(normalizePathForCompare('/ws/install/'), '/ws/install');
        assert.strictEqual(normalizePathForCompare('/'), '/');
        assert.strictEqual(
            normalizePathForCompare('C:\\ws\\install'),
            process.platform === 'win32' ? 'c:/ws/install' : 'C:/ws/install');
    });

    it('Windows 风格路径(反斜杠)不因平台而误判为外部条目', () => {
        // 用平台无关方式构造:反斜杠字符串在两个平台上都应被识别为"同一根之下"
        const root = 'C:\\ws';
        const inside = 'C:\\ws\\install\\pkg';
        const outside = 'C:\\other';
        assert.strictEqual(isWorkspaceEntry(inside, root), true, '反斜杠子树应判为工作空间条目');
        assert.strictEqual(isWorkspaceEntry(outside, root), false);
        assert.strictEqual(isWorkspaceEntry('C:/ws/install', root), true, '正/反斜杠混用同样识别');
    });

    it('Windows 上大小写不敏感(与文件系统一致);POSIX 上大小写敏感', () => {
        if (process.platform === 'win32') {
            assert.strictEqual(isWorkspaceEntry('C:\\WS\\install', 'c:\\ws'), true);
        } else {
            assert.strictEqual(isWorkspaceEntry('/WS/install', '/ws'), false);
        }
    });

    it('valueShape 按平台分隔符拆分(Windows ";" / POSIX ":")', () => {
        const root = process.platform === 'win32' ? 'C:\\ws' : '/ws';
        const inside = process.platform === 'win32' ? 'C:\\ws\\install' : '/ws/install';
        const value = [inside, opt].join(path.delimiter);
        const shape = valueShape(value, root);
        assert.deepStrictEqual(shape.ext, [opt], '工作空间条目被剔除,外部条目保留');
        assert.strictEqual(fingerprint(value, root), fingerprint(opt, root), '与"只有外部条目"同指纹');
    });
});
