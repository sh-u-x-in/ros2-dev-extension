// Licensed under the MIT License.

/**
 * @file presets-table.test.ts(2026-10-17 两拆分新增;2026-10-18 文法再收敛随改)
 * 预设键值表 ⇄ 内部形状双向适配的无头单测(纯函数,零 vscode 依赖,logger 自动回退 console)。
 *
 * 文法(收敛定案):**裸键(不含未转义 |)= 0 号**——键 = ${0} 输入框描述、值 = 框内占位提示,
 * 多个裸键取书写顺序第一个;**"槽号|描述"(槽号 ≥1)= 槽位条目**(0| 显式写零按非法拒绝);
 * 同槽多条 = 互斥组;缺号补空组;\| = 字面竖线(裸键描述含竖线必须转义);容错逐条忽略。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/presets-table.test.js
 */

import * as assert from 'assert';

import { parsePresetsTable, serializePresetsTable } from '../../src/build-tool/package-service/share/presets-table';
import type { CommandSpec } from '../../src/build-tool/package-service/share/types';

describe('presets-table:parsePresetsTable(键值表 → 内部形状)', () => {
    it('正常解析:槽号升序成槽、组内保书写序;无裸键 ⇒ custom/customHint 缺省(交 mergeSpec 回落出厂)', () => {
        const parsed = parsePresetsTable({ '2|B 描述': '--b', '1|A 描述': '--a' })!;
        assert.deepStrictEqual(parsed.argv_list, [
            { argv: '--a', describe: 'A 描述' },
            { argv: '--b', describe: 'B 描述' },
        ], '槽号升序,与键书写顺序无关');
        assert.strictEqual(parsed.custom, undefined);
        assert.strictEqual(parsed.customHint, undefined);
    });

    it('裸键 = 0 号:键 = ${0} 描述,值 = 占位提示;多个裸键整组取书写顺序第一个', () => {
        const parsed = parsePresetsTable({
            '第一个裸键': 'hint-a',
            '第二个裸键': 'hint-b',
            '1|A': '--a',
        })!;
        assert.strictEqual(parsed.custom, '第一个裸键', '多裸键取首(对象插入序)');
        assert.strictEqual(parsed.customHint, 'hint-a', '描述与提示整组同取');
        assert.deepStrictEqual(parsed.argv_list, [{ argv: '--a', describe: 'A' }]);
    });

    it('只有裸键 ⇒ 显式空表(customHint 照取;空串提示 = 显示层回落调用方示例)', () => {
        const parsed = parsePresetsTable({ '只改描述不改提示': '' })!;
        assert.strictEqual(parsed.custom, '只改描述不改提示');
        assert.strictEqual(parsed.customHint, '');
        assert.deepStrictEqual(parsed.argv_list, []);
    });

    it('同槽多条 = 互斥备选组:全部保留、组内保书写序', () => {
        const parsed = parsePresetsTable({
            '1|Debug': '--cmake-args -DCMAKE_BUILD_TYPE=Debug',
            '1|Release': '--cmake-args -DCMAKE_BUILD_TYPE=Release',
            '2|Solo': '--solo',
        })!;
        assert.deepStrictEqual(parsed.argv_list, [
            [
                { argv: '--cmake-args -DCMAKE_BUILD_TYPE=Debug', describe: 'Debug' },
                { argv: '--cmake-args -DCMAKE_BUILD_TYPE=Release', describe: 'Release' },
            ],
            { argv: '--solo', describe: 'Solo' },
        ]);
    });

    it('缺号槽位补空组:1 与 3 有键 ⇒ 2 为空组占位(槽号不移位)', () => {
        const parsed = parsePresetsTable({ '1|A': '--a', '3|C': '--c' })!;
        assert.deepStrictEqual(parsed.argv_list, [
            { argv: '--a', describe: 'A' },
            [],
            { argv: '--c', describe: 'C' },
        ]);
    });

    it('\\| 转义:裸键描述与槽位描述都可含字面竖线', () => {
        const bare = parsePresetsTable({ '性能\\|延迟权衡': '' })!;
        assert.strictEqual(bare.custom, '性能|延迟权衡', '裸键唯一管道被转义 ⇒ 无分隔符 = 0 号');
        const slotted = parsePresetsTable({ '1|性能\\|延迟权衡': '--x' })!;
        assert.deepStrictEqual(slotted.argv_list, [{ argv: '--x', describe: '性能|延迟权衡' }]);
    });

    it('容错:非数字槽(含显式 0|)/描述段为空 / value 非字符串 → 条目逐条忽略', () => {
        const parsed = parsePresetsTable({
            'abc|非数字槽': '--y',
            '0|显式写零': '--z',
            '1|': '--w',
            '2|好条目': '--good',
            '3|value 非串': 42,
        })!;
        assert.deepStrictEqual(parsed.argv_list, [
            [], // 槽 1 的唯一条目(空描述)非法 → 空组占位(槽号不移位,设计行为)
            { argv: '--good', describe: '好条目' },
        ], '非法条目逐条忽略;合法条目存活');
        assert.strictEqual(parsed.custom, undefined);
    });

    it('整表口径:非对象/数组 → undefined(未给出);空对象 → 显式空表;有键全非法 → undefined(防垃圾键清空出厂)', () => {
        assert.strictEqual(parsePresetsTable(undefined), undefined);
        assert.strictEqual(parsePresetsTable(null), undefined);
        assert.strictEqual(parsePresetsTable('junk'), undefined);
        assert.strictEqual(parsePresetsTable(42), undefined);
        assert.strictEqual(parsePresetsTable(['--array-form']), undefined);
        const empty = parsePresetsTable({})!;
        assert.deepStrictEqual(empty.argv_list, [], '空对象 = 显式无预设');
        assert.strictEqual(empty.custom, undefined);
        assert.strictEqual(parsePresetsTable({ 'abc|x': 1 }), undefined, '有键但全非法 → 回落出厂');
    });
});

describe('presets-table:serializePresetsTable + 往返(同步锁同源)', () => {
    const spec: CommandSpec = {
        template: 't ${1} ${2} ${0}',
        custom: 'custom desc with | pipe',
        customHint: 'example hint',
        argv_list: [
            { argv: '--one', describe: 'One | 优先' },
            [
                { argv: '--two-a', describe: 'Two A' },
                { argv: '--two-b', describe: 'Two B' },
            ],
        ],
    };

    it('serialize:custom 产裸键(value = 占位提示)、槽号升序、描述转义', () => {
        const table = serializePresetsTable(spec);
        const keys = Object.keys(table);
        assert.strictEqual(keys[0], 'custom desc with \\| pipe', '裸键置首,描述转义');
        assert.strictEqual(table[keys[0]], 'example hint', 'value = 占位提示');
        assert.deepStrictEqual(keys.slice(1), ['1|One \\| 优先', '2|Two A', '2|Two B']);
    });

    it('往返:serialize → parse = 原 custom/customHint/argv_list(无空组形态)', () => {
        const parsed = parsePresetsTable(serializePresetsTable(spec))!;
        assert.strictEqual(parsed.custom, spec.custom);
        assert.strictEqual(parsed.customHint, spec.customHint);
        assert.deepStrictEqual(parsed.argv_list, spec.argv_list);
    });
});
