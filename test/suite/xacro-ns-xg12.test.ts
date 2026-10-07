/**
 * xacro ns N 级寻址单测(XG12,设计:官方 resolve_macro/process_include 镜像)
 *
 * 覆盖:一级 ns / 无 ns 嵌套传染 / 两级 ns / 属性链 / collectNsTable / 分段导航
 *       (head→ns= 声明、尾段→定义、中段→声明)/ 未知名不命中(诊断据此报未知宏)。
 * 夹具:ns_lab 结构缩影(lib + deep(无 ns)+ sub(ns=)三级)。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { XacroDefinitionProvider } from "../../src/languages/xacro/ui/definition-provider";
import { IncludeGraph } from "../../src/languages/xacro/core/include-graph";
import {
    resolveNsQualified, collectNsTable, nsDeclHopAt
} from "../../src/languages/xacro/ui/ns-resolve";
import { parseXacroDocument } from "../../src/languages/xacro/parse/xacro-document";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "rde-xacro-ns12-"));
}

function posOf(text: string, needle: string, shift = 0): vscode.Position {
    const idx = text.indexOf(needle);
    assert.ok(idx >= 0, `锚点未找到:${needle}`);
    const before = text.slice(0, idx + shift);
    const lines = before.split("\n");
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

/** ns_lab 结构缩影 */
const FILES: Record<string, string> = {
    "entry.xacro": [
        '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
        '  <xacro:include filename="lib.xacro" ns="kit" />',
        "  <xacro:kit.plate name=\"a\" />",
        "  <xacro:kit.shim name=\"b\" />",
        "  <xacro:kit.sub.nut name=\"c\" />",
        "  <link name=\"V_${kit.version}\" />",
        "  <link name=\"N_${kit.sub.nut_t}\" />",
        "</robot>"
    ].join("\n"),
    "lib.xacro": [
        '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
        '  <xacro:property name="version" value="2.0" />',
        '  <xacro:macro name="plate" params="name">',
        '    <link name="${name}" />',
        "  </xacro:macro>",
        '  <xacro:include filename="deep.xacro" />',
        '  <xacro:include filename="sub.xacro" ns="sub" />',
        "</robot>"
    ].join("\n"),
    "deep.xacro": [
        '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
        '  <xacro:macro name="shim" params="name">',
        '    <link name="${name}" />',
        "  </xacro:macro>",
        "</robot>"
    ].join("\n"),
    "sub.xacro": [
        '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
        '  <xacro:property name="nut_t" value="0.01" />',
        '  <xacro:macro name="nut" params="name">',
        '    <link name="${name}" />',
        "  </xacro:macro>",
        "</robot>"
    ].join("\n")
};

function buildGraph(dir: string): IncludeGraph {
    const graph = new IncludeGraph({} as never);
    for (const [name, text] of Object.entries(FILES)) {
        fs.writeFileSync(path.join(dir, name), text);
        graph.upsert(vscode.Uri.file(path.join(dir, name)), text);
    }
    return graph;
}

describe("xacro ns N 级寻址(XG12)", () => {
    let dir: string;
    let graph: IncludeGraph;
    let entryUri: vscode.Uri;
    let entryDoc: ReturnType<typeof parseXacroDocument>;

    before(() => {
        dir = tmpDir();
        graph = buildGraph(dir);
        entryUri = vscode.Uri.file(path.join(dir, "entry.xacro"));
        const node = graph.getFile(entryUri)!;
        entryDoc = node.doc ?? parseXacroDocument(node.text, entryUri);
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("一级 ns:kit.plate → lib.xacro 宏定义", () => {
        const hit = resolveNsQualified(graph, entryDoc, entryUri, ["kit", "plate"], "macro");
        assert.ok(hit, "应命中");
        assert.strictEqual(path.basename(hit!.ref.uri.fsPath), "lib.xacro");
        assert.strictEqual(hit!.ref.name, "plate");
        assert.strictEqual(hit!.hops.length, 1, "一跳");
    });

    it("无 ns 嵌套传染:kit.shim → deep.xacro(官方 func 递归传表语义)", () => {
        const hit = resolveNsQualified(graph, entryDoc, entryUri, ["kit", "shim"], "macro");
        assert.ok(hit, "传染语义应命中 deep 文件的 shim");
        assert.strictEqual(path.basename(hit!.ref.uri.fsPath), "deep.xacro");
    });

    it("两级 ns:kit.sub.nut → sub.xacro", () => {
        const hit = resolveNsQualified(graph, entryDoc, entryUri, ["kit", "sub", "nut"], "macro");
        assert.ok(hit, "两级应命中");
        assert.strictEqual(path.basename(hit!.ref.uri.fsPath), "sub.xacro");
        assert.strictEqual(hit!.hops.length, 2, "两跳声明");
    });

    it("属性链:kit.version 命中 lib;kit.sub.nut_t 命中 sub", () => {
        const p1 = resolveNsQualified(graph, entryDoc, entryUri, ["kit", "version"], "property");
        assert.ok(p1 && path.basename(p1.ref.uri.fsPath) === "lib.xacro");
        const p2 = resolveNsQualified(graph, entryDoc, entryUri, ["kit", "sub", "nut_t"], "property");
        assert.ok(p2 && path.basename(p2.ref.uri.fsPath) === "sub.xacro");
    });

    it("未知名/未知 ns → undefined(D14 据此报未知宏,不再误伤合法链)", () => {
        assert.strictEqual(resolveNsQualified(graph, entryDoc, entryUri, ["kit", "nope"], "macro"), undefined);
        assert.strictEqual(resolveNsQualified(graph, entryDoc, entryUri, ["nope", "x"], "macro"), undefined);
        assert.strictEqual(resolveNsQualified(graph, entryDoc, entryUri, ["kit", "sub", "nope"], "macro"), undefined);
    });

    it("collectNsTable:kit 表宏含传染(shim)、子 ns 含 sub;sub 表只有 nut", () => {
        const kit = collectNsTable(graph, entryDoc, entryUri, ["kit"]);
        assert.ok(kit, "kit 表应可收集");
        assert.deepStrictEqual(kit!.macros.map(m => m.name).sort(), ["plate", "shim"], "传染宏应并入");
        assert.deepStrictEqual(kit!.namespaces, ["sub"]);
        const sub = collectNsTable(graph, entryDoc, entryUri, ["kit", "sub"]);
        assert.ok(sub);
        assert.deepStrictEqual(sub!.macros.map(m => m.name), ["nut"]);
        assert.deepStrictEqual(sub!.props.map(p => p.name), ["nut_t"]);
    });

    it("nsDeclHopAt:第 0/1 段声明定位;末段索引拒绝", () => {
        const h0 = nsDeclHopAt(graph, entryDoc, entryUri, ["kit", "sub", "nut"], 0);
        assert.ok(h0 && h0.uri.fsPath === entryUri.fsPath && h0.ns === "kit");
        const h1 = nsDeclHopAt(graph, entryDoc, entryUri, ["kit", "sub", "nut"], 1);
        assert.ok(h1 && path.basename(h1.uri.fsPath) === "lib.xacro" && h1.ns === "sub");
        assert.strictEqual(nsDeclHopAt(graph, entryDoc, entryUri, ["kit", "plate"], 1), undefined, "末段是符号非声明");
    });

    it("Definition 分段:head 段 kit → 本文件 ns= 声明;中段 sub → lib 内 ns=sub 声明", async () => {
        const provider = new XacroDefinitionProvider(graph, {} as never);
        const text = FILES["entry.xacro"];
        const doc = await vscode.workspace.openTextDocument(entryUri);
        // head:光标在 <xacro:kit.plate 的 kit 上
        const headPos = posOf(text, "kit.plate", 1);
        const headLoc = await provider.provideDefinition(doc, headPos, new vscode.CancellationTokenSource().token);
        assert.ok(headLoc, "head 段应命中 ns= 声明");
        const hl = (Array.isArray(headLoc) ? headLoc[0] : headLoc) as vscode.Location;
        assert.strictEqual(hl.uri.fsPath, entryUri.fsPath, "声明在本文件 include 行");
        assert.strictEqual(hl.range.start.line, 1);
        // 中段:光标在 kit.sub.nut 的 sub 上
        const midPos = posOf(text, "kit.sub.nut", 5);
        const midLoc = await provider.provideDefinition(doc, midPos, new vscode.CancellationTokenSource().token);
        assert.ok(midLoc, "中段应命中 ns=sub 声明");
        const ml = (Array.isArray(midLoc) ? midLoc[0] : midLoc) as vscode.Location;
        assert.strictEqual(path.basename(ml.uri.fsPath), "lib.xacro", "sub 声明在 lib.xacro 内");
    });

    it("Definition 尾段:kit.shim → deep.xacro 定义(传染)", async () => {
        const provider = new XacroDefinitionProvider(graph, {} as never);
        const text = FILES["entry.xacro"];
        const doc = await vscode.workspace.openTextDocument(entryUri);
        const tailPos = posOf(text, "kit.shim", 5);
        const loc = await provider.provideDefinition(doc, tailPos, new vscode.CancellationTokenSource().token);
        assert.ok(loc, "传染宏应可跳转");
        const l = (Array.isArray(loc) ? loc[0] : loc) as vscode.Location;
        assert.strictEqual(path.basename(l.uri.fsPath), "deep.xacro");
    });

    it("普通宏(无点)不受影响:跳转走原 findSymbol 路径", async () => {
        // lib.xacro 内部直接调用本地宏的形态:在 lib 里追加一个调用不方便,改在 entry 顶层定义+调用
        const dir2 = tmpDir();
        try {
            const t = [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:macro name="local_m"><link /></xacro:macro>',
                "  <xacro:local_m />",
                "</robot>"
            ].join("\n");
            fs.writeFileSync(path.join(dir2, "e.xacro"), t);
            const g2 = new IncludeGraph({} as never);
            g2.upsert(vscode.Uri.file(path.join(dir2, "e.xacro")), t);
            const doc = await vscode.workspace.openTextDocument(path.join(dir2, "e.xacro"));
            const provider = new XacroDefinitionProvider(g2, {} as never);
            const loc = await provider.provideDefinition(doc, posOf(t, "local_m />", 2), new vscode.CancellationTokenSource().token);
            assert.ok(loc, "普通宏跳转应命中");
            const l = (Array.isArray(loc) ? loc[0] : loc) as vscode.Location;
            assert.strictEqual(l.range.start.line, 1);
        } finally {
            fs.rmSync(dir2, { recursive: true, force: true });
        }
    });
});
