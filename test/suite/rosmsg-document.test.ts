// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file rosmsg-document.test.ts
 * 结构解析器分隔线判定单元测试
 *
 * 覆盖:
 *  - 合法分隔线(顶格且恰好 3 个破折号)
 *  - 未顶格分隔线 → warning"必须顶格"
 *  - 破折号数量过多(>3) → warning"破折号过多"
 *  - 破折号不足(<3, 1~2 个) → warning"疑似分隔线"
 *  - 带空格破折号线(如 "- - -") → warning"不应有空格"(保持现状)
 *  - 分隔线数量校验(msg=0/srv=1/action=2)
 */

import * as assert from 'assert';
import type { TextDocument } from 'vscode';
import { parseRosMessageDocument } from '../../src/languages/rosmsg/parse/rosmsg-document';

/** 构造最小 TextDocument mock(解析器只用 fileName/getText/uri/version) */
function makeDoc(fileName: string, content: string): TextDocument {
    return {
        fileName,
        uri: fileName, // 仅用于日志字符串插值,任意值即可
        version: 1,
        languageId: 'rosmsg',
        getText: () => content,
    } as unknown as TextDocument;
}

describe('分隔线判定(parseRosMessageDocument)', () => {
    it('msg 无分隔线 → 无结构错误', () => {
        const doc = makeDoc('test.msg', 'int32 a\nstring b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('srv 恰好 1 个顶格 --- → 合法', () => {
        const doc = makeDoc('test.srv', 'int32 a\n---\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 1);
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('action 恰好 2 个 --- → 合法', () => {
        const doc = makeDoc('test.action', 'int32 a\n---\nint32 b\n---\nint32 c\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 2);
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('顶格 --- 尾随空格 → 收紧:不算合法分隔线,报尾随内容 warning', () => {
        const doc = makeDoc('test.srv', 'int32 a\n---  \nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'warning' && x.reason.includes('尾随')));
    });

    it('srv 缺 --- → 数量不足 error', () => {
        const doc = makeDoc('test.srv', 'int32 a\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('需要 1 个') && x.reason.includes('当前有 0 个')));
    });

    it('srv 有 2 个 --- → 数量过多 error', () => {
        const doc = makeDoc('test.srv', 'int32 a\n---\nint32 b\n---\nint32 c\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 2);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('需要 1 个') && x.reason.includes('当前有 2 个')));
    });

    it('msg 出现 --- → 数量过多(期望 0 个)', () => {
        const doc = makeDoc('test.msg', 'int32 a\n---\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 1);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('需要 0 个') && x.reason.includes('当前有 1 个')));
    });

    it('顶格 ----(4 个) → 破折号过多,不算分隔线', () => {
        const doc = makeDoc('test.srv', 'int32 a\n----\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.reason.includes('破折号过多') && x.reason.includes('4 个')));
    });

    it('顶格 -----(5 个) → 破折号过多', () => {
        const doc = makeDoc('test.srv', 'int32 a\n-----\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.reason.includes('破折号过多') && x.reason.includes('5 个')));
    });

    it('未顶格 ---(前导空格) → 必须顶格,不算分隔线', () => {
        const doc = makeDoc('test.srv', 'int32 a\n   ---\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x => x.reason.includes('必须顶格')));
    });

    it('未顶格且 5 个破折号 → 必须顶格优先', () => {
        const doc = makeDoc('test.srv', 'int32 a\n    -----\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x => x.reason.includes('必须顶格')));
    });

    it('顶格 --(2 个) → 疑似分隔线(不足 3 个)', () => {
        const doc = makeDoc('test.msg', 'int32 a\n--\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.reason.includes('疑似') && x.reason.includes('不足 3 个') && x.reason.includes('2 个')));
    });

    it('顶格 -(1 个) → 疑似分隔线(不足 3 个)', () => {
        const doc = makeDoc('test.msg', 'int32 a\n-\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.reason.includes('疑似') && x.reason.includes('不足 3 个') && x.reason.includes('1 个')));
    });

    it('- - -(带空格) → 疑似:破折号之间不应有空格', () => {
        const doc = makeDoc('test.msg', 'int32 a\n- - -\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.reason.includes('疑似') && x.reason.includes('不应有空格')));
    });

    it('未顶格多空格破折号线 → 仍报疑似(不应有空格,保持现状)', () => {
        const doc = makeDoc('test.msg', 'int32 a\n   -    -    -   -    -   \n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.reason.includes('疑似') && x.reason.includes('不应有空格')));
    });

    it('含注释的 ---(# comment) → 无法识别行,不算分隔线', () => {
        const doc = makeDoc('test.srv', 'int32 a\n--- # comment\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.ok(r.invalidLines.some(x =>
            x.reason.includes('无法识别') && x.text.includes('--- # comment')));
    });

    // ---------- 疑似分隔线计入数量(避免"修好格式后数量突变"的接力式诊断) ----------

    it('srv 仅疑似分隔线(- - -) → 数量校验通过,不报数量不足', () => {
        const doc = makeDoc('test.srv', 'int32 a\n- - -\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.strictEqual(r.suspectSeparators.length, 1);
        // 疑似计入总数(total=1,期望 1)→ 不应再有"数量不足" error
        assert.ok(!r.invalidLines.some(x => x.severity === 'error' && x.reason.includes('分隔线')));
        // 只有疑似格式 warning
        assert.ok(r.invalidLines.some(x => x.reason.includes('不应有空格')));
    });

    it('srv 仅破折号过多(-----) → 数量校验通过,不报数量不足', () => {
        const doc = makeDoc('test.srv', 'int32 a\n-----\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.strictEqual(r.suspectSeparators.length, 1);
        assert.ok(!r.invalidLines.some(x => x.severity === 'error' && x.reason.includes('分隔线')));
        assert.ok(r.invalidLines.some(x => x.reason.includes('破折号过多')));
    });

    it('srv 疑似+合法共 2 个 → 数量过多(含疑似)', () => {
        const doc = makeDoc('test.srv', 'int32 a\n- - -\n---\nint32 b\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 1);
        assert.strictEqual(r.suspectSeparators.length, 1);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('需要 1 个') &&
            x.reason.includes('当前有 2 个') && x.reason.includes('含疑似 1 个')));
    });

    it('msg 仅疑似分隔线(- - -) → 数量错误(期望 0)', () => {
        const doc = makeDoc('test.msg', 'int32 a\n- - -\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.separators.length, 0);
        assert.strictEqual(r.suspectSeparators.length, 1);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('需要 0 个') && x.reason.includes('当前有 1 个')));
    });

    // ---------- 数组长度校验(含 ROS 有界数组 [<=N]) ----------

    it('有界数组 uint8[<=10] → 合法,不报错', () => {
        const doc = makeDoc('test.msg', 'uint8[<=10] status_codes\nint32[6] joints\nfloat64[] data\n');
        const r = parseRosMessageDocument(doc);
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('非法有界数组 [<=x] → 报数组长度非法', () => {
        const doc = makeDoc('test.msg', 'uint8[<=x] bad\n');
        const r = parseRosMessageDocument(doc);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('数组长度非法') && x.reason.includes('[<=x]')));
    });

    it('非法数组 [-1] → 报数组长度非法', () => {
        const doc = makeDoc('test.msg', 'int32[-1] bad\n');
        const r = parseRosMessageDocument(doc);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('数组长度非法') && x.reason.includes('[-1]')));
    });

    // ---------- 常量声明等号(多空格/缺值) ----------

    it('常量等号后无值(uint8 X =) → 报常量缺少值 error', () => {
        const doc = makeDoc('test.msg', 'uint8 STATUS_OK =\n');
        const r = parseRosMessageDocument(doc);
        const f = r.sections.flatMap(s => s.fields)[0];
        assert.ok(f && f.kind === 'constant', 'Should parse as constant declaration');
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('常量声明缺少值')));
    });

    it('常量等号后多空格无值(uint8 X =   ) → 报常量缺少值 error', () => {
        const doc = makeDoc('test.msg', 'uint8 STATUS_OK =   \n');
        const r = parseRosMessageDocument(doc);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('常量声明缺少值')));
    });

    it('常量等号多空格有值(uint8 X  =  0) → 正常解析 value', () => {
        const doc = makeDoc('test.msg', 'uint8   STATUS_OK  =  0\n');
        const r = parseRosMessageDocument(doc);
        const f = r.sections.flatMap(s => s.fields)[0];
        assert.ok(f && f.kind === 'constant' && f.defaultValue === '0', 'value should be 0');
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('常量等号后带注释(uint8 X=0  # ok) → value 与 comment 正确', () => {
        const doc = makeDoc('test.msg', 'uint8 STATUS_OK=0  # ok\n');
        const r = parseRosMessageDocument(doc);
        const f = r.sections.flatMap(s => s.fields)[0];
        assert.ok(f && f.kind === 'constant' && f.defaultValue === '0' && f.comment === 'ok');
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('字符串常量含空格值(string X = "a b") → value 保留空格', () => {
        const doc = makeDoc('test.msg', 'string  FRAME_ID = "base link"\n');
        const r = parseRosMessageDocument(doc);
        const f = r.sections.flatMap(s => s.fields)[0];
        assert.ok(f && f.kind === 'constant' && f.defaultValue === '"base link"');
        assert.strictEqual(r.invalidLines.length, 0);
    });
});

describe('@optional 注解解析(对齐 rosidl)', () => {
    it('@optional 独立一行 + 下一行字段 → 字段 optional 标记,无结构错误', () => {
        const doc = makeDoc('test.msg', '@optional\nint32 field_a\n');
        const r = parseRosMessageDocument(doc);
        const f = r.sections.flatMap(s => s.fields)[0];
        assert.ok(f && f.optional === true, 'field should be optional');
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('@optional 独立一行带行尾注释 → 下一行字段 optional', () => {
        const doc = makeDoc('test.msg', '@optional # 可选字段\nint32 field_a\n');
        const r = parseRosMessageDocument(doc);
        const f = r.sections.flatMap(s => s.fields)[0];
        assert.ok(f && f.optional === true, 'field should be optional');
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('@optional 同行(int32 field) → optional 标记', () => {
        const doc = makeDoc('test.msg', '@optional int32 field_a\n');
        const r = parseRosMessageDocument(doc);
        const f = r.sections.flatMap(s => s.fields)[0];
        assert.ok(f && f.optional === true, 'field should be optional');
        assert.strictEqual(r.invalidLines.length, 0);
    });

    it('连续两个 @optional 独立行 → 报重复 @optional error', () => {
        const doc = makeDoc('test.msg', '@optional\n@optional\nint32 field_a\n');
        const r = parseRosMessageDocument(doc);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('重复的 @optional')));
    });

    it('普通字段无 @optional → optional 未设置', () => {
        const doc = makeDoc('test.msg', 'int32 field_a\n');
        const r = parseRosMessageDocument(doc);
        const f = r.sections.flatMap(s => s.fields)[0];
        assert.ok(f && f.optional === undefined, 'plain field should not be optional');
    });

    it('@deprecated 注解行 → 仍报"错误的结构"(严格对齐 rosidl)', () => {
        const doc = makeDoc('test.msg', '@deprecated "use field_a instead" int32 old_field\n');
        const r = parseRosMessageDocument(doc);
        assert.ok(r.invalidLines.some(x =>
            x.severity === 'error' && x.reason.includes('错误的结构')));
    });
});
