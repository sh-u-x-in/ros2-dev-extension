// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file rosmsg-formatter.test.ts
 * rosmsg 文档格式化纯函数单元测试
 *
 * 覆盖:
 *  - 段内对齐 类型列 与 名称列
 *  - 常量等号规范化(X=0 → X = 0)
 *  - srv/action 多段独立对齐
 *  - 注释/空行/无法识别行保留
 *  - @optional 与数组类型
 *  - 尾空格去除、等号后无值保留
 */

import * as assert from 'assert';
import { formatRosMessageContent } from '../../src/languages/rosmsg/parse/formatter';

describe('rosmsg 格式化(formatRosMessageContent)', () => {
    it('段内对齐类型列(名称/等号直接紧跟)', () => {
        const out = formatRosMessageContent('int32 a\nfloat64[] data\nstring name\n');
        assert.strictEqual(out, 'int32      a\nfloat64[]  data\nstring     name\n');
    });

    it('常量等号规范化(等号紧贴名称)', () => {
        const out = formatRosMessageContent('uint8 STATUS_OK=0\nstring FRAME_ID = "base_link"\n');
        assert.strictEqual(out, 'uint8   STATUS_OK = 0\nstring  FRAME_ID = "base_link"\n');
    });

    it('srv 多段独立对齐(各段单独计算列宽)', () => {
        const out = formatRosMessageContent('int32 a\n---\nstring long_name\nint32 b\n');
        assert.strictEqual(out, 'int32  a\n---\nstring  long_name\nint32   b\n');
    });

    it('分隔线尾随空白 → 格式化裁切为 ---', () => {
        const out = formatRosMessageContent('int32 a\n---  \nint32 b\n');
        assert.strictEqual(out, 'int32  a\n---\nint32  b\n');
    });

    it('行内注释保留(前补两个空格)', () => {
        const out = formatRosMessageContent('float64 temperature  # Celsius\n');
        assert.strictEqual(out, 'float64  temperature  # Celsius\n');
    });

    it('注释行/空行保留,仅去尾空格', () => {
        const out = formatRosMessageContent('# header comment\nint32 a   \n\nstring b   \n');
        assert.strictEqual(out, '# header comment\nint32   a\n\nstring  b\n');
    });

    it('整行注释顶格(去前导空格)', () => {
        const out = formatRosMessageContent('        # 定长数组\nint32[3] data\n');
        assert.strictEqual(out, '# 定长数组\nint32[3]  data\n');
    });

    it('无法识别的行保留原样(仅去尾空格)', () => {
        const out = formatRosMessageContent('this is invalid   \nint32 a\n');
        assert.strictEqual(out, 'this is invalid\nint32  a\n');
    });

    it('@optional 修饰符保留(单行综合长度对齐)', () => {
        const out = formatRosMessageContent('@optional string note\nint32 a\n');
        assert.strictEqual(out, '@optional string  note\nint32  a\n');
    });

    it('数组类型(定长/变长/有界)正常对齐', () => {
        const out = formatRosMessageContent('int32[3] data\nfloat64[] vals\nuint8[<=10] codes\n');
        assert.strictEqual(out, 'int32[3]     data\nfloat64[]    vals\nuint8[<=10]  codes\n');
    });

    it('常量等号后无值保留等号', () => {
        const out = formatRosMessageContent('uint8 X =\n');
        assert.strictEqual(out, 'uint8  X =\n');
    });

    it('格式化结果无行尾空格(逐行校验)', () => {
        const out = formatRosMessageContent('int32 a   \nfloat64[] data   \n');
        for (const line of out.split('\n')) {
            assert.strictEqual(line.endsWith(' '), false, `行尾不应有空格: "${line}"`);
        }
    });

    it('连续多个空行合并为 1 个', () => {
        const out = formatRosMessageContent('int32 a\n\n\n\nstring b\n');
        assert.strictEqual(out, 'int32   a\n\nstring  b\n');
    });

    it('文档末尾多个空行合并为单个结尾换行', () => {
        const out = formatRosMessageContent('int32 a\n\n\n');
        assert.strictEqual(out, 'int32  a\n');
    });
});

describe('rosmsg 格式化 @optional 单/双行动态切换', () => {
    it('同行 @optional 合并总长短于阈值 → 保持单行(综合长度对齐)', () => {
        const out = formatRosMessageContent('@optional string note\nint32 a\n');
        assert.strictEqual(out, '@optional string  note\nint32  a\n');
    });

    it('独立行 @optional 合并总长短于阈值 → 合并单行,行尾注释提取为上方注释行', () => {
        const out = formatRosMessageContent('@optional # opt1\nstring note # c2\nint32 a\n');
        assert.strictEqual(out, '# opt1\n@optional string  note  # c2\nint32  a\n');
    });

    it('单行 @optional 合并总长超阈值 → 拆为双行(@optional 独立一行)', () => {
        const out = formatRosMessageContent('@optional string very_long_field_name # comment\n', 11, 20);
        assert.strictEqual(out, '@optional\nstring  very_long_field_name  # comment\n');
    });

    it('双行 @optional 合并总长超阈值 → 保持双行,行尾注释留在 @optional 行', () => {
        const out = formatRosMessageContent('@optional # opt1\nstring very_long_field_name # comment\n', 11, 20);
        assert.strictEqual(out, '@optional  # opt1\nstring  very_long_field_name  # comment\n');
    });

    it('合并总长恰等于阈值 → 维持现状(单行保持单行)', () => {
        const out = formatRosMessageContent('@optional string note\n', 11, 21);
        assert.strictEqual(out, '@optional string  note\n');
    });

    it('合并总长恰等于阈值 → 维持现状(双行保持双行)', () => {
        const out = formatRosMessageContent('@optional\nstring note\n', 11, 21);
        assert.strictEqual(out, '@optional\nstring  note\n');
    });
});
