/**
 * xacro 诊断语法级规则单测(XG9,设计:设计/xacro/14 §3)
 *
 * 覆盖:D8 未闭合(Error 级唯一词法源)、D9 未知 $() 命令、D12 条件静态布尔、
 *       D13 重定义/覆盖内建、D14 候选收集口径(非固定 xacro: 标签)。
 * 策略:parseXacroDocument 纯模型断言(规则在 refresh 内消费同一数据源)。
 */

import * as assert from "assert";
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

import { parseXacroDocument } from "../../src/languages/xacro/parse/xacro-document";
import { SUBST_COMMANDS } from "../../src/languages/xacro/parse/xacro-tags";
import { EVAL_BARE_IDENTS } from "../../src/languages/xacro/parse/expression-tokens";
import { staticBoolean } from "../../src/languages/xacro/parse/xacro-document";

/** D9 同口径:提取 $() 命令名并判官方集 */
function unknownCommands(text: string): string[] {
    const doc = parseXacroDocument(text);
    const out: string[] = [];
    for (const seg of doc.dollarSegments) {
        for (const tok of seg.res.tokens) {
            if (tok.kind !== "extension") {
                continue;
            }
            const cmd = /^\s*([A-Za-z_][A-Za-z0-9_-]*)/.exec(tok.content)?.[1];
            if (cmd && !SUBST_COMMANDS.has(cmd)) {
                out.push(cmd);
            }
        }
    }
    return out;
}

describe("xacro 诊断语法级规则(XG9)", () => {
    it("D8 未闭合 ${ → dollarIssues 收录 unclosed-expr(Error 级唯一词法源)", () => {
        const doc = parseXacroDocument('<robot><link name="${abc"/></robot>');
        assert.deepStrictEqual(doc.dollarIssues.map(i => i.kind), ["unclosed-expr"]);
        // $() 未闭合同理
        const doc2 = parseXacroDocument('<robot><xacro:include filename="$(find pkg"/></robot>');
        assert.ok(doc2.dollarIssues.some(i => i.kind === "unclosed-extension"));
    });

    it("D8 合法文件零 issue(0-error 护栏的词法面)", () => {
        const doc = parseXacroDocument([
            '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
            '  <xacro:include filename="$(find pkg)/sub/f.xacro"/>',
            '  <geometry radius="${pi/2}" length="$(arg n)"/>',
            "</robot>"
        ].join("\n"));
        assert.strictEqual(doc.dollarIssues.length, 0);
    });

    it("D9 $() 未知命令报官方集外;宽容 find-pkg-share/eval/cwd", () => {
        assert.deepStrictEqual(
            unknownCommands('<r><a x="$(bogus 1)"/><b y="$(find pkg)"/><c z="$(eval 1+1)"/></r>'),
            ["bogus"]);
        assert.deepStrictEqual(
            unknownCommands('<r><a x="$(find-pkg-share p)"/><b y="$(cwd)"/><c z="$(env V)"/><d w="$(optenv V d)"/><e q="$(dirname)"/></r>'),
            []);
    });

    it("D12 静态布尔口径支撑:条件字面量可判/不可判", () => {
        assert.strictEqual(staticBoolean("true"), true);
        assert.strictEqual(staticBoolean("False"), false);
        assert.strictEqual(staticBoolean("2"), true);
        assert.strictEqual(staticBoolean("${x > 0}"), undefined, "表达式静态不可判 → 不报");
    });

    it("D13 数据源:重定义与覆盖内建由 symbols.props 全量提供", () => {
        const doc = parseXacroDocument([
            "<robot>",
            '  <xacro:property name="pi" value="3"/>',
            '  <xacro:property name="len" value="2"/>',
            "</robot>"
        ].join("\n"));
        const names = doc.symbols.props.map(p => p.name);
        assert.ok(names.includes("pi") && names.includes("len"));
        assert.ok(EVAL_BARE_IDENTS.has("pi"), "pi 在内建表 → 覆盖内建提示");
        // 宏体内定义被 D13 规则按作用域豁免(数据可判:macros 跨度包含)
        const doc2 = parseXacroDocument([
            "<robot>",
            '  <xacro:macro name="m"><xacro:property name="pi" value="3"/></xacro:macro>',
            "</robot>"
        ].join("\n"));
        const inner = doc2.symbols.props[0];
        const enclosed = doc2.symbols.macros.some(mm => mm.info.spanFrom <= inner.info.spanFrom && inner.info.spanFrom < mm.info.spanTo);
        assert.ok(enclosed, "宏内属性可判定为宏作用域(规则豁免)");
    });

    it("D14 候选口径:非固定 xacro: 标签进入宏调用清单(含未知名)", () => {
        const doc = parseXacroDocument([
            "<robot>",
            "  <xacro:wheel/>",
            "  <xacro:if value=\"true\"/>",
            "  <xacro:element_inject/>",
            "</robot>"
        ].join("\n"));
        assert.deepStrictEqual(doc.macroCalls.map(c => c.name), ["wheel", "element_inject"]);
    });
});
