// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file rosmsg-diagnostics.test.ts
 * rosmsg 语义诊断(analyzeDocument)单元测试
 *
 * 覆盖:
 *  - 废弃类型 byte/char → warning(建议 uint8/int8),含数组后缀
 *  - 字段名重复 → error
 *  - 结构错误(srv 缺 ---) → error
 *  - 未知消息类型(索引查不到) → warning
 *  - 已知消息类型(索引命中) → 无未知类型 warning
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TextDocument } from 'vscode';
import { analyzeDocument } from '../../src/languages/rosmsg/ui/diagnostic-provider';
import type { MessageIndex } from '../../src/languages/rosmsg/data/message-index';

/** 构造最小 TextDocument mock(解析器只用 fileName/getText/uri/version;字段重名诊断需 lineAt/lineCount) */
function makeDoc(fileName: string, content: string): TextDocument {
    const lines = content.split(/\r?\n/);
    return {
        fileName,
        uri: fileName, // 仅用于日志字符串插值,任意值即可
        version: 1,
        languageId: 'rosmsg',
        getText: () => content,
        lineCount: lines.length,
        lineAt: (n: number) => ({ text: lines[n] ?? '', range: new vscode.Range(n, 0, n, (lines[n] ?? '').length) }),
    } as unknown as TextDocument;
}

/** 假索引:getMessagesInPackage 返回指定包下的消息名列表;getPackageForFile 返 undefined 走目录推导兼底 */
function makeIndex(known: Record<string, string[]> = {}): MessageIndex {
    const getMessagesInPackage = (pkg: string): Array<{ name: string }> =>
        (known[pkg] ?? []).map(name => ({ name }));
    return {
        getMessagesInPackage,
        getPackageForFile: () => undefined,
    } as unknown as MessageIndex;
}

describe('rosmsg 语义诊断(analyzeDocument)', () => {
    it('废弃类型 byte → warning,建议 uint8', async () => {
        const doc = makeDoc('test.msg', 'byte flag\n');
        const dep = (await analyzeDocument(doc, makeIndex())).filter(d => d.message.includes('废弃类型'));
        assert.strictEqual(dep.length, 1);
        assert.strictEqual(dep[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.ok(dep[0].message.includes('byte'), `消息应提及 byte: ${dep[0].message}`);
        assert.ok(dep[0].message.includes('uint8'), `消息应建议 uint8: ${dep[0].message}`);
    });

    it('废弃类型 char → warning,建议 int8', async () => {
        const doc = makeDoc('test.msg', 'char c\n');
        const dep = (await analyzeDocument(doc, makeIndex())).filter(d => d.message.includes('废弃类型'));
        assert.strictEqual(dep.length, 1);
        assert.ok(dep[0].message.includes('int8'), `消息应建议 int8: ${dep[0].message}`);
    });

    it('废弃类型数组 byte[] / char[3] → 各一条 warning(范围含数组后缀)', async () => {
        const doc = makeDoc('test.msg', 'byte[] samples\nchar[3] signature\n');
        const dep = (await analyzeDocument(doc, makeIndex())).filter(d => d.message.includes('废弃类型'));
        assert.strictEqual(dep.length, 2);
        for (const d of dep) {
            assert.ok(d.range.end.character > d.range.start.character, '诊断范围应有长度');
            assert.strictEqual(d.severity, vscode.DiagnosticSeverity.Warning);
        }
    });

    it('字段名重复 → error', async () => {
        const doc = makeDoc('test.srv', 'int32 a\nint32 a\n---\nint32 b\n');
        const dup = (await analyzeDocument(doc, makeIndex())).filter(d => d.message.includes('重复'));
        assert.strictEqual(dup.length, 1);
        assert.strictEqual(dup[0].severity, vscode.DiagnosticSeverity.Error);
    });

    it('srv 缺分隔线 → 结构错误 error', async () => {
        const doc = makeDoc('test.srv', 'int32 a\nint32 b\n');
        const errs = (await analyzeDocument(doc, makeIndex()))
            .filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        assert.ok(errs.length >= 1, '缺 --- 的 srv 应产生结构错误');
    });

    it('未知消息类型(索引查不到) → warning', async () => {
        const doc = makeDoc('test.msg', 'geometry_msgs/PoseStamped pose\n');
        const unk = (await analyzeDocument(doc, makeIndex()))
            .filter(d => d.message.includes('未知消息类型'));
        assert.strictEqual(unk.length, 1);
        assert.strictEqual(unk[0].severity, vscode.DiagnosticSeverity.Warning);
    });

    it('已知消息类型(索引命中) → 无未知类型 warning', async () => {
        const doc = makeDoc('test.msg', 'geometry_msgs/PoseStamped pose\n');
        const idx = makeIndex({ geometry_msgs: ['PoseStamped'] });
        const unk = (await analyzeDocument(doc, idx))
            .filter(d => d.message.includes('未知消息类型'));
        assert.strictEqual(unk.length, 0);
    });

    it('无包名类型(当前包索引存在同名) → 不报未知', async () => {
        // 路径 _fmt_demo/rosmsg/demo3.msg 推断当前包 _fmt_demo
        const doc = makeDoc('_fmt_demo/rosmsg/demo3.msg', 'demo4 s\n');
        const idx = makeIndex({ _fmt_demo: ['demo4'] });
        const unk = (await analyzeDocument(doc, idx))
            .filter(d => d.message.includes('未知消息类型'));
        assert.strictEqual(unk.length, 0);
    });

    it('无包名类型(其他包有同名,当前包没有) → 报未知', async () => {
        const doc = makeDoc('_fmt_demo/rosmsg/demo3.msg', 'demo4 s\n');
        const idx = makeIndex({ other_pkg: ['demo4'] });
        const unk = (await analyzeDocument(doc, idx))
            .filter(d => d.message.includes('未知消息类型'));
        assert.strictEqual(unk.length, 1);
    });

    it('无包名类型(当前包索引无同名) → 报未知 warning', async () => {
        const doc = makeDoc('_fmt_demo/rosmsg/demo3.msg', 'demo4 s\n');
        const unk = (await analyzeDocument(doc, makeIndex()))
            .filter(d => d.message.includes('未知消息类型'));
        assert.strictEqual(unk.length, 1);
        assert.strictEqual(unk[0].severity, vscode.DiagnosticSeverity.Warning);
    });

    it('自包含:字段类型等于当前消息名 → error', async () => {
        const doc = makeDoc('demo3.msg', 'demo3 s\n');
        const self = (await analyzeDocument(doc, makeIndex()))
            .filter(d => d.message.includes('自包含'));
        assert.strictEqual(self.length, 1);
        assert.strictEqual(self[0].severity, vscode.DiagnosticSeverity.Error);
    });

    it('自包含:带自己包名指向自身 → 也算自包含', async () => {
        // 路径 _fmt_demo/rosmsg/demo3.msg 推断包名 _fmt_demo,消息名 demo3
        const doc = makeDoc('_fmt_demo/rosmsg/demo3.msg', '_fmt_demo/demo3 s\n');
        const self = (await analyzeDocument(doc, makeIndex()))
            .filter(d => d.message.includes('自包含'));
        assert.strictEqual(self.length, 1);
    });

    it('自包含:带其他包名(非自己包)的同名类型不算自包含', async () => {
        const doc = makeDoc('_fmt_demo/rosmsg/demo3.msg', 'other_pkg/demo3 s\n');
        const self = (await analyzeDocument(doc, makeIndex()))
            .filter(d => d.message.includes('自包含'));
        assert.strictEqual(self.length, 0);
    });

    it('无法识别的行(错误的结构) → error', async () => {
        const doc = makeDoc('test.msg', 'garbage line here\n');
        const errs = (await analyzeDocument(doc, makeIndex()))
            .filter(d => d.message.includes('错误的结构'));
        assert.strictEqual(errs.length, 1);
        assert.strictEqual(errs[0].severity, vscode.DiagnosticSeverity.Error);
    });

    // ---------- RE-1 三级判定(接电):索引冷时的 FS/系统兜底 ----------

    it('RE-1 pkg/Type 经 findMessageWithSystemPath 命中 → 不报未知(系统懒登记与跳转同源)', async () => {
        const doc = makeDoc('test.msg', 'geometry_msgs/PoseStamped pose\n');
        const idx = makeIndex();
        (idx as { findMessageWithSystemPath?: unknown }).findMessageWithSystemPath =
            async (pkg: string, name: string) => ({ name, package: pkg });
        const unk = (await analyzeDocument(doc, idx))
            .filter(d => d.message.includes('未知消息类型'));
        assert.strictEqual(unk.length, 0);
    });

    it('RE-1 pkg/Type 索引冷但标准布局 FS 命中 → 不报未知', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're1-fs-'));
        try {
            fs.mkdirSync(path.join(dir, 'msg'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'msg', 'PoseStamped.msg'), 'int32 x\n');
            const doc = makeDoc('test.msg', 'geometry_msgs/PoseStamped pose\n');
            const pkgs = {
                resolvePackageDir: async (p: string) => p === 'geometry_msgs' ? { fsPath: dir } : undefined
            };
            const unk = (await analyzeDocument(doc, makeIndex(), pkgs as unknown as never))
                .filter(d => d.message.includes('未知消息类型'));
            assert.strictEqual(unk.length, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('RE-1 裸名同包索引冷但标准布局 FS 命中 → 不报未知', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're1-bare-'));
        try {
            fs.mkdirSync(path.join(dir, 'msg'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'msg', 'demo4.msg'), 'int32 x\n');
            const doc = makeDoc('_fmt_demo/rosmsg/demo3.msg', 'demo4 s\n');
            const pkgs = {
                resolvePackageDir: async (p: string) => p === '_fmt_demo' ? { fsPath: dir } : undefined
            };
            const unk = (await analyzeDocument(doc, makeIndex(), pkgs as unknown as never))
                .filter(d => d.message.includes('未知消息类型'));
            assert.strictEqual(unk.length, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
