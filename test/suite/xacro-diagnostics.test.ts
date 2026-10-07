/**
 * xacro 诊断 D1-D7 纯逻辑测试(08)
 *
 * 策略:直接测 diagnostic-provider 导出的纯函数(isPackageRef / extractPkg /
 *      classifyEdge / findIncludeCycleThrough / closingEdgeLine),mock 图节点。
 * 不依赖真实 ROS 环境 / vscode workspace。
 */

import * as assert from "assert";
import * as vscode from "vscode";

import {
    isPackageRef,
    extractPkg,
    classifyEdge,
    findIncludeCycleThrough,
    closingEdgeLine,
    parseMacroParams,
    collectMacroParamSpans,
    isMacroParamRef,
    enclosingMacroSpan
} from "../../src/languages/xacro/ui/diagnostic-provider";
import { parseXml } from "../../src/languages/shared/xml-utils";
import { IncludeGraph, FileNode } from "../../src/languages/xacro/core/include-graph";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** 构造 mock 图:getFile 按 uri.toString() 查节点 */
function mockGraph(nodes: Map<string, { includes: { target?: vscode.Uri; line: number }[] }>): Pick<IncludeGraph, "getFile"> {
    return {
        getFile: (u: vscode.Uri) => nodes.get(u.toString()) as unknown as FileNode | undefined
    };
}

/** Windows 上 fsPath 为反斜杠,用 vscode.Uri.file 生成真实 fsPath 比较 */
const missing1 = vscode.Uri.file("/pkg/missing.xacro").fsPath;
const missing2 = vscode.Uri.file("/pkg/missing2.xacro").fsPath;
const exists = (p: string): boolean => p !== missing1 && p !== missing2;

/* ------------------------------------------------------------------ */
/* isPackageRef / extractPkg                                           */
/* ------------------------------------------------------------------ */

describe("诊断 isPackageRef / extractPkg(08)", () => {
    it("isPackageRef 识别 $(find) / package://,不误判相对与 ${}", () => {
        assert.strictEqual(isPackageRef("$(find my_pkg)/share/x.xacro"), true);
        assert.strictEqual(isPackageRef("package://my_pkg/x.xacro"), true);
        assert.strictEqual(isPackageRef("sub/x.xacro"), false);
        assert.strictEqual(isPackageRef("/abs/x.xacro"), false);
        assert.strictEqual(isPackageRef("${p}/x.xacro"), false); // ${} 非包引用
    });

    it("extractPkg 提取 find / pkg-share / package:// 包名", () => {
        assert.strictEqual(extractPkg("$(find my_pkg)/share/x.xacro"), "my_pkg");
        assert.strictEqual(extractPkg("$(find-pkg-share my_pkg)/x.xacro"), "my_pkg");
        assert.strictEqual(extractPkg("package://my_pkg/x.xacro"), "my_pkg");
        assert.strictEqual(extractPkg("未识别"), "未识别");
    });
});

/* ------------------------------------------------------------------ */
/* classifyEdge(D1/D2)                                                */
/* ------------------------------------------------------------------ */

describe("诊断 classifyEdge D1/D2(08)", () => {
    it("D1:目标已解析但文件不存在(相对路径悬垂)", () => {
        assert.strictEqual(
            classifyEdge({ raw: "sub/x.xacro", target: vscode.Uri.file("/pkg/missing.xacro") }, exists),
            "D1"
        );
    });

    it("目标存在 → undefined(无诊断)", () => {
        assert.strictEqual(
            classifyEdge({ raw: "sub/x.xacro", target: vscode.Uri.file("/pkg/exist.xacro") }, exists),
            undefined
        );
    });

    it("D2:$(find) 包悬空", () => {
        assert.strictEqual(
            classifyEdge({ raw: "$(find ghost_pkg)/x.xacro", target: undefined }, exists),
            "D2"
        );
    });

    it("D2:package:// 包悬空", () => {
        assert.strictEqual(
            classifyEdge({ raw: "package://ghost_pkg/x.xacro", target: undefined }, exists),
            "D2"
        );
    });

    it("${} 悬空(非包引用)→ undefined(归 D5,不重复标 D2)", () => {
        assert.strictEqual(
            classifyEdge({ raw: "${p}/x.xacro", target: undefined }, exists),
            undefined
        );
    });
});

/* ------------------------------------------------------------------ */
/* findIncludeCycleThrough / closingEdgeLine(D3)                      */
/* ------------------------------------------------------------------ */

describe("诊断 D3 include 环(08)", () => {
    const A = vscode.Uri.file("/ws/A.xacro");
    const B = vscode.Uri.file("/ws/B.xacro");
    const C = vscode.Uri.file("/ws/C.xacro");
    const D = vscode.Uri.file("/ws/D.xacro");
    const E = vscode.Uri.file("/ws/E.xacro");
    const F = vscode.Uri.file("/ws/F.xacro");
    const G = vscode.Uri.file("/ws/G.xacro");

    function makeGraph(): Pick<IncludeGraph, "getFile"> {
        const nodes = new Map<string, { includes: { target?: vscode.Uri; line: number }[] }>();
        const put = (u: vscode.Uri, line: number, ...targets: vscode.Uri[]) =>
            nodes.set(u.toString(), { includes: targets.map(t => ({ target: t, line })) });
        put(A, 1, B);
        put(B, 1, A);
        put(C, 1, D);
        put(D, 1);
        // E → F 在第 1 行,E → G 在第 2 行(独立行号,供 closingEdgeLine 验证)
        nodes.set(E.toString(), { includes: [{ target: F, line: 1 }, { target: G, line: 2 }] });
        put(F, 1);
        put(G, 2, E);
        return mockGraph(nodes);
    }

    it("直接环 A↔B", () => {
        assert.deepStrictEqual(findIncludeCycleThrough(makeGraph(), A), ["A.xacro", "B.xacro"]);
    });

    it("从 B 看也是环(方向无关)", () => {
        assert.deepStrictEqual(findIncludeCycleThrough(makeGraph(), B), ["B.xacro", "A.xacro"]);
    });

    it("间接环 E→G→E 只返回环链", () => {
        assert.deepStrictEqual(findIncludeCycleThrough(makeGraph(), E), ["E.xacro", "G.xacro"]);
    });

    it("无环 C→D 返回 undefined", () => {
        assert.strictEqual(findIncludeCycleThrough(makeGraph(), C), undefined);
    });

    it("环外 D 不误报", () => {
        assert.strictEqual(findIncludeCycleThrough(makeGraph(), D), undefined);
    });

    it("closingEdgeLine 定位指向环的 include 行", () => {
        const g = makeGraph();
        // E 的 includes:line 1 → F,line 2 → G(指向环);A 的 includes:line 1 → B(指向环)
        assert.strictEqual(closingEdgeLine(g, A, ["A.xacro", "B.xacro"]), 1);
        assert.strictEqual(closingEdgeLine(g, E, ["E.xacro", "G.xacro"]), 2);
    });
});

/* ------------------------------------------------------------------ */
/* parseMacroParams / collectMacroParamSpans / isMacroParamRef(D5 宏体形参豁免) */
/* ------------------------------------------------------------------ */

describe("诊断 宏形参解析(D5 豁免,08+2026-09-06)", () => {
    it("parseMacroParams:空白分隔 + := 默认值写法", () => {
        assert.deepStrictEqual(parseMacroParams("name radius width color"), ["name", "radius", "width", "color"]);
        assert.deepStrictEqual(parseMacroParams("  prefix  radius:=0.1  x:=1.0  "), ["prefix", "radius", "x"]);
        assert.deepStrictEqual(parseMacroParams(""), []);
        assert.deepStrictEqual(parseMacroParams("   "), []);
        // 非法形如表达式片段的名被过滤(防御)
        assert.deepStrictEqual(parseMacroParams("ok ${a}"), ["ok"]);
    });

    const doc = [
        '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
        '    <xacro:macro name="demo_wheel" params="name radius width color">',
        '        <link name="${name}">',
        '            <cylinder radius="${radius}" length="${width}"/>',
        '            <mass value="${m}"/>',
        '        </link>',
        '    </xacro:macro>',
        '    <link name="${name}"/>',
        '</robot>'
    ].join("\n");

    it("collectMacroParamSpans:只收 xacro:macro 并携带形参集合", () => {
        const spans = collectMacroParamSpans(parseXml(doc), doc);
        assert.strictEqual(spans.length, 1);
        assert.ok(spans[0].params.has("name"));
        assert.ok(spans[0].params.has("radius"));
        assert.ok(!spans[0].params.has("m"));
        assert.ok(spans[0].from < spans[0].to);
    });

    it("enclosingMacroSpan:定位最内层宏 + macroName(供形参跳转定位宏定义)", () => {
        const spans = collectMacroParamSpans(parseXml(doc), doc);
        const offRadius = doc.indexOf("${radius}");
        const span = enclosingMacroSpan(spans, offRadius);
        assert.ok(span, "应命中所在宏");
        assert.strictEqual(span!.macroName, "demo_wheel");
        assert.ok(spans[0].from <= offRadius && offRadius < spans[0].to);
        // 文档末尾(宏体外)不命中
        assert.strictEqual(enclosingMacroSpan(spans, doc.length - 1), undefined);
    });

    it("isMacroParamRef:宏体内形参命中;非形参/宏体之外不命中", () => {
        const spans = collectMacroParamSpans(parseXml(doc), doc);
        const offName = doc.indexOf("${name}");
        const offRadius = doc.indexOf("${radius}");
        const offM = doc.indexOf("${m}");
        const offOutside = doc.lastIndexOf("${name}");
        assert.strictEqual(isMacroParamRef(spans, offName, "name"), true);
        assert.strictEqual(isMacroParamRef(spans, offRadius, "radius"), true);
        // ${m} 在宏体内但不是该宏形参 → 不豁免(仍按全局变量处理)
        assert.strictEqual(isMacroParamRef(spans, offM, "m"), false);
        // 宏体之外的 ${name}(最后一个引用)不豁免
        assert.strictEqual(isMacroParamRef(spans, offOutside, "name"), false);
    });
});
