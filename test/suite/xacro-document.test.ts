/**
 * xacro-tags 标签模型 + xacro-document 单遍解析/缓存单测(XG4,设计:设计/xacro/14 §1.4/§1.5)
 *
 * 覆盖:10 固定标签分类、宏调用识别、属性签名表、SUBST_COMMANDS、EVAL_GLOBALS;
 *       单遍解析的标签实例/符号/宏参数/$词法段/issue,uri+version 缓存命中。
 */

import * as assert from "assert";
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

import * as vscode from "vscode";

import {
    fixedTagOf, macroNameOf, TAG_ATTRS, SUBST_COMMANDS, EVAL_GLOBALS
} from "../../src/languages/xacro/parse/xacro-tags";
import {
    parseXacroDocument, XacroDocumentStore, staticBoolean
} from "../../src/languages/xacro/parse/xacro-document";

const SAMPLE = `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="test">
  <xacro:arg name="sim" default="false"/>
  <xacro:property name="the_radius" value="2.1"/>
  <xacro:property name="props" value="\${dict(a=1)}"/>
  <xacro:property name="origin_block">
    <origin xyz="0 0 0"/>
  </xacro:property>
  <xacro:macro name="wheel" params="prefix reflect:=1 *origin **extra">
    <link name="\${prefix}_wheel"/>
  </xacro:macro>
  <xacro:wheel prefix="front" reflect="-1">
    <origin xyz="1 0 0"/>
  </xacro:wheel>
  <xacro:include filename="$(find pkg)/sub/\${dir}/f.xacro"/>
  <xacro:if value="\${the_radius > 1}"><link name="big"/></xacro:if>
  <geometry radius="\${the_radius}" length="\${a"/>
  <xacro:unknown_thing/>
</robot>
`;

describe("xacro-tags 标签模型(XG4)", () => {
    it("fixedTagOf:10 固定标签命中,无前缀/未知名/大小写敏感拒绝", () => {
        assert.strictEqual(fixedTagOf("xacro:property"), "property");
        assert.strictEqual(fixedTagOf("xacro:call"), "call");
        assert.strictEqual(fixedTagOf("xacro:unless"), "unless");
        assert.strictEqual(fixedTagOf("property"), null, "无前缀=普通元素(2.0.8 起)");
        assert.strictEqual(fixedTagOf("xacro:element_inject"), null, "element_inject 非官方");
        assert.strictEqual(fixedTagOf("Xacro:Property"), null, "大小写敏感");
    });

    it("macroNameOf:xacro: 前缀非固定标签 → 宏名(可含点)", () => {
        assert.strictEqual(macroNameOf("xacro:wheel"), "wheel");
        assert.strictEqual(macroNameOf("xacro:ns.macro"), "ns.macro");
        assert.strictEqual(macroNameOf("xacro:element_inject"), "element_inject");
        assert.strictEqual(macroNameOf("xacro:property"), null, "固定标签不是宏调用");
        assert.strictEqual(macroNameOf("robot"), null);
        assert.strictEqual(macroNameOf("xacro:"), null);
    });

    it("TAG_ATTRS:官方签名逐标签对齐", () => {
        assert.deepStrictEqual(TAG_ATTRS.property.required, ["name"]);
        assert.deepStrictEqual(TAG_ATTRS.property.optional, ["value", "default", "remove", "scope", "lazy_eval"]);
        assert.deepStrictEqual(TAG_ATTRS.include.optional, ["ns", "optional"]);
        assert.deepStrictEqual(TAG_ATTRS.element.required, ["xacro:name"]);
        assert.deepStrictEqual(TAG_ATTRS.arg.required, ["name", "default"]);
        assert.deepStrictEqual(TAG_ATTRS.call.required, ["macro"]);
        assert.deepStrictEqual(TAG_ATTRS.insert_block.required, ["name"]);
        assert.deepStrictEqual(TAG_ATTRS.insert_block.optional, [], "insert_block 无 scope(官方)");
    });

    it("SUBST_COMMANDS:官方命令集 + find-pkg-share 宽容", () => {
        for (const c of ["find", "find-pkg-share", "arg", "env", "optenv", "dirname", "eval", "cwd"]) {
            assert.ok(SUBST_COMMANDS.has(c), `缺少 ${c}`);
        }
        assert.strictEqual(SUBST_COMMANDS.size, 8);
    });

    it("EVAL_GLOBALS:补全数据源条目齐备", () => {
        assert.strictEqual(EVAL_GLOBALS.get("pi")?.kind, "constant");
        assert.strictEqual(EVAL_GLOBALS.get("radians")?.kind, "function");
        assert.strictEqual(EVAL_GLOBALS.get("math")?.kind, "namespace");
        assert.strictEqual(EVAL_GLOBALS.get("load_yaml")?.kind, "function");
        assert.ok(EVAL_GLOBALS.get("dict")?.detail.includes("字典"));
    });
});

describe("xacro-document 单遍解析(XG4)", () => {
    const doc = parseXacroDocument(SAMPLE);

    it("固定标签实例:property×3 / macro / include / if / arg 各 1", () => {
        assert.strictEqual(doc.tags.get("property")?.length, 3);
        assert.strictEqual(doc.tags.get("macro")?.length, 1);
        assert.strictEqual(doc.tags.get("include")?.length, 1);
        assert.strictEqual(doc.tags.get("if")?.length, 1);
        assert.strictEqual(doc.tags.get("arg")?.length, 1);
    });

    it("宏调用识别:wheel 与 unknown_thing(未知名也入列)", () => {
        assert.deepStrictEqual(doc.macroCalls.map(c => c.name), ["wheel", "unknown_thing"]);
        assert.strictEqual(doc.macroCalls[0].attrs.get("prefix")?.value, "front");
    });

    it("宏定义符号:params 全语法解析(prefix/reflect/*origin/**extra)", () => {
        assert.strictEqual(doc.symbols.macros.length, 1);
        const m = doc.symbols.macros[0];
        assert.strictEqual(m.name, "wheel");
        assert.deepStrictEqual(m.params.map(p => [p.name, p.kind, p.defaultKind, p.defaultValue]), [
            ["prefix", "scalar", "none", undefined],
            ["reflect", "scalar", "value", "1"],
            ["*origin", "block", "none", undefined],
            ["**extra", "dict", "none", undefined]
        ]);
        // 参数 offset 为文档绝对坐标
        assert.strictEqual(SAMPLE.slice(m.params[0].from, m.params[0].to), "prefix");
        assert.strictEqual(SAMPLE.slice(m.params[2].from, m.params[2].to), "*origin");
    });

    it("属性符号:value/default/块属性三分", () => {
        const byName = new Map(doc.symbols.props.map(p => [p.name, p]));
        assert.strictEqual(byName.get("the_radius")?.value, "2.1");
        assert.strictEqual(byName.get("the_radius")?.isBlock, false);
        assert.strictEqual(byName.get("props")?.value, "${dict(a=1)}");
        assert.strictEqual(byName.get("origin_block")?.isBlock, true, "无 value/default/remove → 块属性");
        assert.strictEqual(byName.get("origin_block")?.value, undefined);
    });

    it("arg 符号:sim / false", () => {
        assert.strictEqual(doc.symbols.args.length, 1);
        assert.strictEqual(doc.symbols.args[0].name, "sim");
        assert.strictEqual(doc.symbols.args[0].defaultValue, "false");
    });

    it("属性值 $ 词法段:dollarTokensAt 命中 expr 段", () => {
        const at = SAMPLE.indexOf("${dict(a=1)}");
        const res = doc.dollarTokensAt(at + 3);
        assert.ok(res, "应命中 props 值段");
        assert.deepStrictEqual(res!.tokens.filter(t => t.kind === "expr").map(t => t.content), ["dict(a=1)"]);
        assert.strictEqual(doc.dollarTokensAt(0), undefined, "非段内返回 undefined");
    });

    it("$ 词法 issue 收集:length 值未闭合 ${a → unclosed-expr(属性值路径)", () => {
        assert.ok(doc.dollarIssues.some(i => i.kind === "unclosed-expr"));
    });

    it("静态布尔:get_boolean_value 口径(仅 true/True/false/False/整数字符串)", () => {
        assert.strictEqual(staticBoolean("true"), true);
        assert.strictEqual(staticBoolean("True"), true);
        assert.strictEqual(staticBoolean("1"), true);
        assert.strictEqual(staticBoolean("-5"), true);
        assert.strictEqual(staticBoolean("false"), false);
        assert.strictEqual(staticBoolean("0"), false);
        assert.strictEqual(staticBoolean("1.0"), undefined, "int() 不可解析,官方亦报错");
        assert.strictEqual(staticBoolean("abc"), undefined);
        assert.strictEqual(staticBoolean(undefined), undefined);
    });
});

describe("xacro-document uri+version 缓存(XG4)", () => {
    /** 最小 uri 替身(store 只用 toString() 作键;_vscode-stub 不含 Uri) */
    const mkUri = (p: string): vscode.Uri => ({ fsPath: p, toString: () => `file://${p}` }) as unknown as vscode.Uri;

    it("同 version 同 text 命中缓存(同一实例);version/text 变化重解析;invalidate 生效", () => {
        const store = new XacroDocumentStore();
        const uri = mkUri("/tmp/a.xacro");
        const d1 = store.get(uri, SAMPLE, 1);
        const d2 = store.get(uri, SAMPLE, 1);
        assert.strictEqual(d1, d2, "命中缓存返回同一实例");
        const d3 = store.get(uri, SAMPLE, 2);
        assert.notStrictEqual(d1, d3, "version 变化重解析");
        assert.strictEqual(store.get(uri, SAMPLE, 2), d3);
        const d4 = store.get(uri, SAMPLE + " ", 2);
        assert.notStrictEqual(d3, d4, "text 变化重解析");
        store.invalidate(uri);
        assert.notStrictEqual(store.get(uri, SAMPLE, 2), d4, "invalidate 后重解析");
        store.dispose();
    });
});
