/**
 * expression-tokens ${} 表达式分词单测(XG3,设计:设计/xacro/14 §1.3)
 *
 * 覆盖:分词/refIdents 白名单排除/点链/调用位/关键字实参/控制流标记/f-string/容错。
 */

import * as assert from "assert";

import { scanExpression } from "../../src/languages/xacro/parse/expression-tokens";

describe("expression-tokens ${} 表达式分词(XG3)", () => {
    it("简单属性引用:radius → ident + refIdents", () => {
        const r = scanExpression("radius");
        assert.deepStrictEqual(r.tokens.map(t => t.kind), ["ident"]);
        assert.deepStrictEqual(r.refIdents, ["radius"]);
        assert.strictEqual(r.hasSyntaxIssue, false);
    });

    it("算术:${-chassis_hei/2.0} 内容 → refIdents 只含 chassis_hei", () => {
        const r = scanExpression("-chassis_hei/2.0");
        assert.deepStrictEqual(r.tokens.map(t => t.kind), ["op", "ident", "op", "number"]);
        assert.deepStrictEqual(r.refIdents, ["chassis_hei"]);
    });

    it("内建白名单排除:pi/radians/min 不入 refIdents", () => {
        const r = scanExpression("pi/2 + radians(30) + min(a,b)");
        assert.deepStrictEqual(r.refIdents, ["a", "b"]);
    });

    it("点链:math.pi 排除;props.a 头入尾排;用户命名空间头入(ns 由消费方过滤)", () => {
        const r = scanExpression("math.pi + props.a + ns.prop");
        assert.deepStrictEqual(r.refIdents, ["props", "ns"]);
    });

    it("调用位排除:len(joints) → 只含 joints", () => {
        const r = scanExpression("len(joints)");
        assert.deepStrictEqual(r.tokens.map(t => t.kind), ["call", "punct", "ident", "punct"]);
        assert.deepStrictEqual(r.refIdents, ["joints"]);
    });

    it("关键字实参排除:dict(a=1, b=2) → refIdents 空", () => {
        const r = scanExpression("dict(a=1, b=2)");
        assert.deepStrictEqual(r.refIdents, []);
    });

    it("控制流标记:推导式 hasControlFlow=true(refIdents 供展示不供诊断)", () => {
        const r = scanExpression("[x**2 for x in range(10)]");
        assert.strictEqual(r.hasControlFlow, true);
        assert.deepStrictEqual(r.refIdents, ["x"]);
        const r2 = scanExpression("(lambda v: v*2)(3)");
        assert.strictEqual(r2.hasControlFlow, true);
    });

    it("f-string 前缀并入字符串 token,串内不提取引用", () => {
        const r = scanExpression("f'{x}-tail'");
        assert.deepStrictEqual(r.tokens.map(t => t.kind), ["string"]);
        assert.strictEqual(r.tokens[0].text, "f'{x}-tail'");
        assert.deepStrictEqual(r.refIdents, []);
    });

    it("字符串转义与后续引用:'a\\'b' + s → refIdents [s]", () => {
        const r = scanExpression("'a\\'b' + s");
        assert.deepStrictEqual(r.tokens.map(t => t.kind), ["string", "op", "ident"]);
        assert.deepStrictEqual(r.refIdents, ["s"]);
    });

    it("三引号字符串合法", () => {
        const r = scanExpression("'''a'''");
        assert.strictEqual(r.hasSyntaxIssue, false);
        assert.deepStrictEqual(r.tokens.map(t => t.kind), ["string"]);
    });

    it("未闭合字符串 → hasSyntaxIssue", () => {
        assert.strictEqual(scanExpression("'abc").hasSyntaxIssue, true);
        assert.strictEqual(scanExpression(`"abc`).hasSyntaxIssue, true);
    });

    it("括号失衡 → hasSyntaxIssue;(a+b) 平衡不误报", () => {
        assert.strictEqual(scanExpression("(a + b").hasSyntaxIssue, true);
        assert.strictEqual(scanExpression("(a + b)").hasSyntaxIssue, false);
        assert.strictEqual(scanExpression("dict(a=1)").hasSyntaxIssue, false);
    });

    it("数字形态:2.0、.5、1e-3、0x1F 均 number", () => {
        const r = scanExpression("2.0 + .5 + 1e-3 + 0x1F");
        assert.deepStrictEqual(r.tokens.filter(t => t.kind === "number").map(t => t.text),
            ["2.0", ".5", "1e-3", "0x1F"]);
    });

    it("base 偏移:token offset = base + 相对偏移", () => {
        const r = scanExpression("a+1", 10);
        assert.deepStrictEqual(r.tokens.map(t => [t.from, t.to]), [[10, 11], [11, 12], [12, 13]]);
    });

    it("关键字作 op:and/or/not/in 不入 refIdents", () => {
        const r = scanExpression("a and not b or c in d");
        assert.deepStrictEqual(r.refIdents, ["a", "b", "c", "d"]);
    });

    it("注释:# 至行尾为 comment token", () => {
        const r = scanExpression("a # note");
        assert.deepStrictEqual(r.tokens.filter(t => t.kind === "comment").map(t => t.text), ["# note"]);
        assert.deepStrictEqual(r.refIdents, ["a"]);
    });

    it("引用去重:a + a → refIdents 单条", () => {
        assert.deepStrictEqual(scanExpression("a + a").refIdents, ["a"]);
    });

    it("真实场景:${'%04d' % i} 与 ${props['val1']} 分词正确", () => {
        const r1 = scanExpression("'%04d' % i");
        assert.deepStrictEqual(r1.refIdents, ["i"]);
        const r2 = scanExpression("props['val1']");
        assert.deepStrictEqual(r2.refIdents, ["props"]);
        assert.strictEqual(r2.hasSyntaxIssue, false);
    });
});
