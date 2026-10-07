// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file semantic-token-builder.test.ts
 * rosmsg 语义 token 数据生成单元测试
 *
 * 验证:
 *  - 复合类型 pkg/Name 拆分为 namespace + type(长度正确)
 *  - 内置类型 / 未限定类型 → type
 *  - 字段名 / 常量名 → variable
 *  - SemanticTokens 增量编码(deltaLine/deltaChar)正确
 */

import * as assert from 'assert';
import type { TextDocument } from 'vscode';
import { parseRosMessageDocument } from '../../src/languages/rosmsg/parse/rosmsg-document';
import { buildSemanticTokenData } from '../../src/languages/rosmsg/parse/semantic-token-builder';

/** 构造最小 TextDocument mock */
function makeDoc(fileName: string, content: string): TextDocument {
    return {
        fileName,
        uri: fileName,
        version: 1,
        languageId: 'rosmsg',
        getText: () => content,
    } as unknown as TextDocument;
}

/** 解码 SemanticTokens 编码数组为易读 token 列表 */
function decode(data: number[]): { line: number; char: number; length: number; type: number }[] {
    const tokens: { line: number; char: number; length: number; type: number }[] = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i < data.length; i += 5) {
        const dLine = data[i];
        const dChar = data[i + 1];
        const len = data[i + 2];
        const type = data[i + 3];
        line += dLine;
        char = dLine === 0 ? char + dChar : dChar;
        tokens.push({ line, char, length: len, type });
        char += len;
    }
    return tokens;
}

describe('语义 token 生成(buildSemanticTokenData)', () => {
    it('复合类型 std_msgs/Header 拆为 namespace(8)+type(6),字段名 variable', () => {
        const doc = makeDoc('t.msg', 'std_msgs/Header header\n');
        const tokens = decode(buildSemanticTokenData(parseRosMessageDocument(doc)));
        assert.deepStrictEqual(tokens, [
            { line: 0, char: 0, length: 8, type: 0 },  // std_msgs(8字符) → namespace
            { line: 0, char: 9, length: 6, type: 1 },  // Header → type
            { line: 0, char: 16, length: 6, type: 2 }, // header → variable
        ]);
    });

    it('内置类型 int8 → type,字段名 variable', () => {
        const doc = makeDoc('t.msg', 'int8 a\n');
        const tokens = decode(buildSemanticTokenData(parseRosMessageDocument(doc)));
        assert.deepStrictEqual(tokens, [
            { line: 0, char: 0, length: 4, type: 1 }, // int8 → type
            { line: 0, char: 5, length: 1, type: 2 }, // a → variable
        ]);
    });

    it('未限定类型 BasicTypes → type', () => {
        const doc = makeDoc('t.msg', 'BasicTypes robot_config\n');
        const tokens = decode(buildSemanticTokenData(parseRosMessageDocument(doc)));
        assert.strictEqual(tokens.length, 2);
        assert.strictEqual(tokens[0].type, 1);
        assert.strictEqual(tokens[0].length, 10); // BasicTypes
        assert.strictEqual(tokens[1].type, 2);    // robot_config
    });

    it('数组类型 float64[] → type 仅覆盖基础名(不含括号)', () => {
        const doc = makeDoc('t.msg', 'float64[] vals\n');
        const tokens = decode(buildSemanticTokenData(parseRosMessageDocument(doc)));
        assert.strictEqual(tokens[0].length, 7);   // float64
        assert.strictEqual(tokens[1].char, 10);    // vals(在 float64[] + 空格之后)
    });

    it('多行多字段:增量编码正确(跨行 deltaLine/deltaChar)', () => {
        const doc = makeDoc('t.msg', 'int32 a\nstring b\n');
        const tokens = decode(buildSemanticTokenData(parseRosMessageDocument(doc)));
        assert.deepStrictEqual(tokens, [
            { line: 0, char: 0, length: 5, type: 1 }, // int32
            { line: 0, char: 6, length: 1, type: 2 }, // a
            { line: 1, char: 0, length: 6, type: 1 }, // string
            { line: 1, char: 7, length: 1, type: 2 }, // b
        ]);
    });

    it('常量字段名 → variable', () => {
        const doc = makeDoc('t.msg', 'uint8 STATUS_OK=0\n');
        const tokens = decode(buildSemanticTokenData(parseRosMessageDocument(doc)));
        assert.strictEqual(tokens.length, 2);
        assert.strictEqual(tokens[0].type, 1);       // uint8
        assert.strictEqual(tokens[1].type, 2);       // STATUS_OK
        assert.strictEqual(tokens[1].length, 9);
    });

    it('srv 多段:跨段行号递增仍正确', () => {
        const doc = makeDoc('t.srv', 'int32 req\n---\nstring res\n');
        const tokens = decode(buildSemanticTokenData(parseRosMessageDocument(doc)));
        assert.strictEqual(tokens.length, 4);
        assert.deepStrictEqual(tokens[0], { line: 0, char: 0, length: 5, type: 1 });
        assert.deepStrictEqual(tokens[2], { line: 2, char: 0, length: 6, type: 1 });
    });
});
