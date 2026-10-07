/**
 * macro-params 宏参数全语法单测(XG2,设计:设计/xacro/14 §1.2 + 13 §3.2)
 *
 * 用例对齐官方 re_macro_arg / parse_macro_arg 语义(含兜底路径与官方怪癖)。
 */

import * as assert from "assert";

import { parseMacroParams, MacroParam } from "../../src/languages/xacro/parse/macro-params";

/** 精简投影(断言辅助) */
function brief(ps: MacroParam[]): Array<[string, string, string, string | undefined]> {
    return ps.map(p => [p.name, p.kind, p.defaultKind, p.defaultValue]);
}

describe("macro-params 宏参数全语法(XG2)", () => {
    it("纯标量:params='prefix' 与多标量 'a b c'", () => {
        assert.deepStrictEqual(brief(parseMacroParams("prefix")), [["prefix", "scalar", "none", undefined]]);
        assert.deepStrictEqual(brief(parseMacroParams("a b c")), [
            ["a", "scalar", "none", undefined],
            ["b", "scalar", "none", undefined],
            ["c", "scalar", "none", undefined]
        ]);
    });

    it("官方 wiki 默认值全家桶:x:=${x} y:=${2*y} z:=0 text:='some text' N:=${None}", () => {
        const ps = parseMacroParams("x:=${x} y:=${2*y} z:=0 text:='some text' N:=${None}");
        assert.deepStrictEqual(brief(ps), [
            ["x", "scalar", "value", "${x}"],
            ["y", "scalar", "value", "${2*y}"],
            ["z", "scalar", "value", "0"],
            ["text", "scalar", "value", "'some text'"],
            ["N", "scalar", "value", "${None}"]
        ]);
    });

    it("官方转发形态:p3:=^ 与 p4:=^|expr_b", () => {
        const ps = parseMacroParams("p1 p2:=expr_a p3:=^ p4:=^|expr_b");
        assert.deepStrictEqual(brief(ps), [
            ["p1", "scalar", "none", undefined],
            ["p2", "scalar", "value", "expr_a"],
            ["p3", "scalar", "forward", undefined],
            ["p4", "scalar", "forward-or-default", "expr_b"]
        ]);
    });

    it("块参数:*origin 与 **extra(星号入名,nameFrom 越过星号)", () => {
        const ps = parseMacroParams("*origin **extra");
        assert.deepStrictEqual(brief(ps), [
            ["*origin", "block", "none", undefined],
            ["**extra", "dict", "none", undefined]
        ]);
        assert.strictEqual(ps[0].nameFrom, ps[0].from + 1);
        assert.strictEqual(ps[1].nameFrom, ps[1].from + 2);
        assert.strictEqual(ps[0].nameTo - ps[0].nameFrom, "origin".length);
    });

    it("真实混合签名:prefix parent reflect:=1 *origin **extra", () => {
        const ps = parseMacroParams("prefix parent reflect:=1 *origin **extra");
        assert.deepStrictEqual(brief(ps), [
            ["prefix", "scalar", "none", undefined],
            ["parent", "scalar", "none", undefined],
            ["reflect", "scalar", "value", "1"],
            ["*origin", "block", "none", undefined],
            ["**extra", "dict", "none", undefined]
        ]);
    });

    it("裸 = 与宽松空白:a=1、a := 1、x :=1", () => {
        assert.deepStrictEqual(brief(parseMacroParams("a=1")), [["a", "scalar", "value", "1"]]);
        assert.deepStrictEqual(brief(parseMacroParams("a := 1")), [["a", "scalar", "value", "1"]]);
        assert.deepStrictEqual(brief(parseMacroParams("x :=1")), [["x", "scalar", "value", "1"]]);
    });

    it("官方怪癖:a:=(空默认)正则命中、defaultmap 存 (None,None) → 名字为 a、等效必填", () => {
        const ps = parseMacroParams("a:=");
        assert.deepStrictEqual(brief(ps), [["a", "scalar", "none", undefined]]);
        assert.strictEqual(ps[0].to - ps[0].from, 3); // token 区间仍覆盖 'a:='
    });

    it("官方怪癖:默认值引号未闭合 → 整 token 兜底为名(a:='x b)", () => {
        const ps = parseMacroParams("a:='x b");
        assert.deepStrictEqual(brief(ps), [["a:='x", "scalar", "none", undefined], ["b", "scalar", "none", undefined]]);
    });

    it("官方怪癖:名字含冒号非 := → 整 token 兜底(a:b c)", () => {
        assert.deepStrictEqual(brief(parseMacroParams("a:b c")), [
            ["a:b", "scalar", "none", undefined],
            ["c", "scalar", "none", undefined]
        ]);
    });

    it("^| 后接表达式回退:y:=^|${2*x}", () => {
        const ps = parseMacroParams("y:=^|${2*x}");
        assert.deepStrictEqual(brief(ps), [["y", "scalar", "forward-or-default", "${2*x}"]]);
    });

    it("引号串内含另一种引号:m:='\"' → 默认值 '\"'", () => {
        const ps = parseMacroParams(`m:='"'`);
        assert.deepStrictEqual(brief(ps), [["m", "scalar", "value", `'"'`]]);
    });

    it("未闭合 ${ 默认值退化为字面裸串:a:=${b c → 默认 '${b',随后 c 成新参", () => {
        const ps = parseMacroParams("a:=${b c");
        assert.deepStrictEqual(brief(ps), [
            ["a", "scalar", "value", "${b"],
            ["c", "scalar", "none", undefined]
        ]);
    });

    it("默认值拼接:='x'y 合法(官方 (?:...)+ 拼接组)", () => {
        const ps = parseMacroParams("a:='x'y");
        assert.deepStrictEqual(brief(ps), [["a", "scalar", "value", "'x'y"]]);
    });

    it("base 偏移:参数 offset = base + 值内相对偏移", () => {
        // 值 "a b":a@0..1,b@2..3;base=100
        const ps = parseMacroParams("a b", 100);
        assert.deepStrictEqual([ps[0].from, ps[0].to, ps[0].nameFrom, ps[0].nameTo], [100, 101, 100, 101]);
        assert.deepStrictEqual([ps[1].from, ps[1].to], [102, 103]);
    });

    it("跨行折行:空白含换行(a\\nb)", () => {
        assert.deepStrictEqual(brief(parseMacroParams("a\nb")), [
            ["a", "scalar", "none", undefined],
            ["b", "scalar", "none", undefined]
        ]);
    });

    it("空串与纯空白 → 0 参数(比官方空白串崩溃更宽容)", () => {
        assert.deepStrictEqual(parseMacroParams("").length, 0);
        assert.deepStrictEqual(parseMacroParams("   \n\t ").length, 0);
    });

    it("$() 默认值:a:=$(arg x) 原文保留", () => {
        const ps = parseMacroParams("a:=$(arg x)");
        assert.deepStrictEqual(brief(ps), [["a", "scalar", "value", "$(arg x)"]]);
    });
});
