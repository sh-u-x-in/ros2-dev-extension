/**
 * xacro-lexer `$` 层词法单测(XG1,设计:设计/xacro/14 §1.1 + 13 §2)
 *
 * 策略:纯函数零依赖,逐用例对照官方 LEXER 语义(转义/裸 $/嵌套禁/未闭合/复合串偏移)。
 */

import * as assert from "assert";

import { lexDollar, hasDollarConstruct, DollarToken, DollarTokenKind } from "../../src/languages/xacro/parse/xacro-lexer";

/** 取指定 kind 的全部 token(断言辅助) */
function tokensOf(kind: DollarTokenKind, s: string, base = 0): DollarToken[] {
    return lexDollar(s, base).tokens.filter(t => t.kind === kind);
}

describe("xacro-lexer $ 层词法(XG1)", () => {
    it("纯文本 → 单 text token,无 issue", () => {
        const r = lexDollar("hello world");
        assert.strictEqual(r.issues.length, 0);
        assert.strictEqual(r.tokens.length, 1);
        assert.strictEqual(r.tokens[0].kind, "text");
        assert.deepStrictEqual([r.tokens[0].from, r.tokens[0].to], [0, 11]);
    });

    it("${expr} 夹在文本中:三段 token,content 精确(含定界符偏移)", () => {
        const r = lexDollar("abc${radius}def");
        assert.strictEqual(r.issues.length, 0);
        assert.deepStrictEqual(r.tokens.map(t => t.kind), ["text", "expr", "text"]);
        const expr = r.tokens[1];
        assert.deepStrictEqual([expr.from, expr.to], [3, 12]);
        assert.strictEqual(expr.content, "radius");
        assert.deepStrictEqual([expr.contentFrom, expr.contentTo], [5, 11]);
    });

    it("base 偏移:token 偏移 = base + 段内偏移(文档绝对坐标)", () => {
        const r = lexDollar("x${a}y", 10);
        const expr = tokensOf("expr", "x${a}y", 10)[0];
        assert.deepStrictEqual([expr.from, expr.to], [11, 15]);
        assert.deepStrictEqual([expr.contentFrom, expr.contentTo], [13, 14]);
        assert.deepStrictEqual(r.tokens.map(t => [t.from, t.to]), [[10, 11], [11, 15], [15, 16]]);
    });

    it("$${ 转义:剥一个 $,输出字面 ${;后续不参与求值", () => {
        const r = lexDollar("pre$${not}post");
        assert.strictEqual(r.issues.length, 0);
        const esc = r.tokens[1];
        assert.strictEqual(esc.kind, "ss-escape");
        assert.deepStrictEqual([esc.from, esc.to], [3, 6]);
        assert.strictEqual(esc.content, "${");
        // 剩余 not}post 为纯文本(不会被当 expr 闭合)
        assert.strictEqual(r.tokens[2].kind, "text");
        assert.strictEqual(r.tokens[2].content, "not}post");
    });

    it("$$( 转义同理", () => {
        const r = lexDollar("a$$(b");
        assert.deepStrictEqual(r.tokens.map(t => [t.kind, t.content]), [
            ["text", "a"], ["ss-escape", "$("], ["text", "b"]
        ]);
    });

    it("三个 $ + {:只剥第一个 $$${a} → 字面 $${ + a}", () => {
        const r = lexDollar("$$${a}");
        const esc = r.tokens[0];
        assert.strictEqual(esc.kind, "ss-escape");
        assert.deepStrictEqual([esc.from, esc.to], [0, 4]);
        assert.strictEqual(esc.content, "$${");
        assert.strictEqual(r.tokens[1].kind, "text");
    });

    it("裸 $ 永为字面:costs$5 and $x → 全 text 无 issue", () => {
        const r = lexDollar("costs$5 and $x");
        assert.strictEqual(r.issues.length, 0);
        assert.ok(r.tokens.every(t => t.kind === "text"));
        assert.strictEqual(r.tokens.map(t => t.content).join(""), "costs$5 and $x");
    });

    it("段尾孤立 $ 与段尾 $$ 都不报错", () => {
        assert.strictEqual(lexDollar("abc$").issues.length, 0);
        assert.strictEqual(lexDollar("abc$").tokens[1].content, "$");
        const rr = lexDollar("ab$$");
        assert.strictEqual(rr.issues.length, 0);
        assert.strictEqual(rr.tokens.map(t => t.content).join(""), "ab$$");
    });

    it("未闭合 ${:token 照常产出(unclosed)+ issue(编辑中态可用)", () => {
        const r = lexDollar("a ${unclosed");
        assert.deepStrictEqual(r.issues.map(i => i.kind), ["unclosed-expr"]);
        assert.deepStrictEqual([r.issues[0].from, r.issues[0].to], [2, 12]);
        const expr = r.tokens[1];
        assert.strictEqual(expr.kind, "expr");
        assert.strictEqual(expr.unclosed, true);
        assert.strictEqual(expr.content, "unclosed");
    });

    it("未闭合 $( 同理", () => {
        const r = lexDollar("$(arg x");
        assert.deepStrictEqual(r.issues.map(i => i.kind), ["unclosed-extension"]);
        assert.strictEqual(r.tokens[0].kind, "extension");
        assert.strictEqual(r.tokens[0].unclosed, true);
        assert.strictEqual(r.tokens[0].content, "arg x");
    });

    it("字典只能走 dict():${dict(a=1)} 单 expr 无 issue(裸 {} 禁令由 content 不含 } 体现)", () => {
        const r = lexDollar("${dict(a=1)}");
        assert.strictEqual(r.issues.length, 0);
        assert.strictEqual(r.tokens.length, 1);
        assert.strictEqual(r.tokens[0].content, "dict(a=1)");
    });

    it("表达式内引号含 }:官方正则到第一个 } 截止(${ 'a}b' } → expr 'a + text b'})", () => {
        const r = lexDollar("${'a}b'}");
        assert.deepStrictEqual(r.tokens.map(t => [t.kind, t.content]), [["expr", "'a"], ["text", "b'}"]]);
    });

    it("表达式可跨行(属性值折行):${a\\nb} 正常闭合", () => {
        const r = lexDollar("${a\nb}");
        assert.strictEqual(r.issues.length, 0);
        assert.strictEqual(r.tokens[0].kind, "expr");
        assert.strictEqual(r.tokens[0].content, "a\nb");
    });

    it("表达式内括号合法:${f(x)} content=f(x)", () => {
        const r = lexDollar("${f(x)}");
        assert.strictEqual(r.tokens[0].content, "f(x)");
        assert.strictEqual(r.issues.length, 0);
    });

    it("$() 基本形态:content 为括号内原文", () => {
        const r = lexDollar("$(find pkg)");
        assert.strictEqual(r.issues.length, 0);
        assert.strictEqual(r.tokens[0].kind, "extension");
        assert.deepStrictEqual([r.tokens[0].from, r.tokens[0].to], [0, 11]);
        assert.strictEqual(r.tokens[0].content, "find pkg");
    });

    it("$() 内 ${} 合法(官方先展开),不记 dollar-in-extension", () => {
        const r = lexDollar("$(find ${pkg}/cfg)");
        assert.strictEqual(r.issues.length, 0);
        assert.strictEqual(r.tokens[0].content, "find ${pkg}/cfg");
    });

    it("$() 内裸 $:记 dollar-in-extension(官方硬错)", () => {
        const r = lexDollar("$(find $PKG)");
        assert.deepStrictEqual(r.issues.map(i => i.kind), ["dollar-in-extension"]);
        assert.deepStrictEqual([r.issues[0].from, r.issues[0].to], [7, 8]);
    });

    it("${} 与 $() 混排:按文档序切分", () => {
        const r = lexDollar("${a}mid$(find p)end");
        assert.deepStrictEqual(r.tokens.map(t => t.kind), ["expr", "text", "extension", "text"]);
        assert.strictEqual(r.issues.length, 0);
    });

    it("空表达式 ${} 与空段容错", () => {
        const r = lexDollar("${}");
        assert.strictEqual(r.tokens[0].content, "");
        assert.strictEqual(lexDollar("").tokens.length, 0);
    });

    it("hasDollarConstruct 快速判空", () => {
        assert.strictEqual(hasDollarConstruct("plain text"), false);
        assert.strictEqual(hasDollarConstruct("a${b}"), true);
        assert.strictEqual(hasDollarConstruct("bare $"), true);
    });
});
