/**
 * xacro 导航增强单测(XG8,设计:设计/xacro/14 §3)
 *
 * 覆盖:${} 点链(ns 头/尾段/属性头)、insert_block→宏参数/块属性、xacro:call→宏、ns.macro 点链。
 * 策略:真实 IncludeGraph(upsert 注入)+ XacroDefinitionProvider;光标锚定子串。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { XacroDefinitionProvider } from "../../src/languages/xacro/ui/definition-provider";
import { IncludeGraph } from "../../src/languages/xacro/core/include-graph";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "rde-xacro-nav-"));
}

function posOf(text: string, needle: string, shift = 0): vscode.Position {
    const idx = text.indexOf(needle);
    assert.ok(idx >= 0, `锚点未找到:${needle}`);
    const before = text.slice(0, idx + shift);
    const lines = before.split("\n");
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

async function openWithGraph(dir: string, files: Record<string, string>): Promise<{ graph: IncludeGraph; docs: Record<string, vscode.TextDocument> }> {
    const graph = new IncludeGraph({} as never);
    const docs: Record<string, vscode.TextDocument> = {};
    for (const [name, text] of Object.entries(files)) {
        const p = path.join(dir, name);
        fs.writeFileSync(p, text);
        graph.upsert(vscode.Uri.file(p), text);
    }
    for (const name of Object.keys(files)) {
        docs[name] = await vscode.workspace.openTextDocument(path.join(dir, name));
    }
    return { graph, docs };
}

const CTS = new vscode.CancellationTokenSource().token;

describe("xacro 导航 XG8(${} 点链 / insert_block / call / ns.macro)", () => {
    it("${ns.prop}:光标在尾段 → ns 目标文件 property", async () => {
        const dir = tmpDir();
        try {
            const { graph, docs } = await openWithGraph(dir, {
                "na.xacro": [
                    '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                    '  <xacro:property name="ns_radius" value="0.2"/>',
                    "</robot>"
                ].join("\n"),
                "nb.xacro": [
                    '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                    '  <xacro:include filename="na.xacro" ns="drv"/>',
                    '  <geometry radius="${drv.ns_radius}"/>',
                    "</robot>"
                ].join("\n")
            });
            const provider = new XacroDefinitionProvider(graph, {} as never);
            const text = docs["nb.xacro"].getText();
            const loc = await provider.provideDefinition(
                docs["nb.xacro"], posOf(text, "ns_radius", 1), CTS);
            assert.ok(loc, "应命中 ns 目标属性");
            const l = Array.isArray(loc) ? loc[0] : loc;
            assert.strictEqual(path.basename((l as vscode.Location).uri.fsPath), "na.xacro");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("${ns.prop}:光标在 ns 头 → ns= 声明(本文件 include 标签)", async () => {
        const dir = tmpDir();
        try {
            const { graph, docs } = await openWithGraph(dir, {
                "na.xacro": '<robot xmlns:xacro="http://www.ros.org/wiki/xacro"><xacro:property name="p" value="1"/></robot>',
                "nb.xacro": [
                    '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                    '  <xacro:include filename="na.xacro" ns="drv"/>',
                    '  <geometry radius="${drv.p}"/>',
                    "</robot>"
                ].join("\n")
            });
            const provider = new XacroDefinitionProvider(graph, {} as never);
            const text = docs["nb.xacro"].getText();
            // 锚定 ${drv.p} 内的 drv(文件里 include 的 ns="drv" 更早出现,不能用作锚点)
            const loc = await provider.provideDefinition(docs["nb.xacro"], posOf(text, "${drv.", 3), CTS);
            assert.ok(loc, "应命中 ns= 声明");
            const l = (Array.isArray(loc) ? loc[0] : loc) as vscode.Location;
            assert.strictEqual(path.basename(l.uri.fsPath), "nb.xacro", "ns= 声明在主文件");
            assert.strictEqual(l.range.start.line, 1, "定位在 include 行");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("${props.a}:光标在尾段、头非 ns → 跳头属性定义", async () => {
        const dir = tmpDir();
        try {
            const text = [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:property name="props" value="${dict(a=1)}"/>',
                '  <geometry radius="${props.a}"/>',
                "</robot>"
            ].join("\n");
            const { graph, docs } = await openWithGraph(dir, { "pa.xacro": text });
            const provider = new XacroDefinitionProvider(graph, {} as never);
            const loc = await provider.provideDefinition(docs["pa.xacro"], posOf(text, "props.a", 7), CTS);
            assert.ok(loc, "应跳头属性 props");
            const l = (Array.isArray(loc) ? loc[0] : loc) as vscode.Location;
            assert.strictEqual(l.range.start.line, 1, "props 定义在第 1 行");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("insert_block name → 宏定义 * 参数(定位参数 token)", async () => {
        const dir = tmpDir();
        try {
            const text = [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:macro name="wheel" params="prefix *origin">',
                '    <xacro:insert_block name="origin"/>',
                "  </xacro:macro>",
                "</robot>"
            ].join("\n");
            const { graph, docs } = await openWithGraph(dir, { "ib.xacro": text });
            const provider = new XacroDefinitionProvider(graph, {} as never);
            const loc = await provider.provideDefinition(docs["ib.xacro"], posOf(text, 'name="origin"', 8), CTS);
            assert.ok(loc, "应命中宏参数 *origin");
            const l = (Array.isArray(loc) ? loc[0] : loc) as vscode.Location;
            assert.strictEqual(l.range.start.line, 1, "参数在宏定义行");
            assert.strictEqual(docs["ib.xacro"].getText().slice(
                docs["ib.xacro"].offsetAt(l.range.start), docs["ib.xacro"].offsetAt(l.range.end)), "origin",
                "选区应为参数裸名(不含 *)");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("insert_block name → 块属性(无所在宏)", async () => {
        const dir = tmpDir();
        try {
            const text = [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                "  <xacro:property name=\"front_left_origin\">",
                '    <origin xyz="0 0 0"/>',
                "  </xacro:property>",
                '  <link><xacro:insert_block name="front_left_origin"/></link>',
                "</robot>"
            ].join("\n");
            const { graph, docs } = await openWithGraph(dir, { "bp.xacro": text });
            const provider = new XacroDefinitionProvider(graph, {} as never);
            // 锚定 insert_block 行的 name 值(属性定义行的 name="front_left_origin" 更早出现)
            const loc = await provider.provideDefinition(
                docs["bp.xacro"], posOf(text, 'insert_block name="front_left_origin"', 'insert_block name="'.length), CTS);
            assert.ok(loc, "应命中块属性");
            const l = (Array.isArray(loc) ? loc[0] : loc) as vscode.Location;
            assert.strictEqual(l.range.start.line, 1, "块属性定义在第 1 行");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("xacro:call macro=${宏名} → 宏定义", async () => {
        const dir = tmpDir();
        try {
            const text = [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:macro name="dyn"><link/></xacro:macro>',
                '  <xacro:call macro="${dyn}"/>',
                "</robot>"
            ].join("\n");
            const { graph, docs } = await openWithGraph(dir, { "dc.xacro": text });
            const provider = new XacroDefinitionProvider(graph, {} as never);
            const loc = await provider.provideDefinition(docs["dc.xacro"], posOf(text, "${dyn}", 3), CTS);
            assert.ok(loc, "应命中宏 dyn");
            const l = (Array.isArray(loc) ? loc[0] : loc) as vscode.Location;
            assert.strictEqual(l.range.start.line, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("<xacro:ns.macro>:光标在宏尾段 → ns 目标文件宏", async () => {
        const dir = tmpDir();
        try {
            const { graph, docs } = await openWithGraph(dir, {
                "ma.xacro": [
                    '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                    '  <xacro:macro name="ns_wheel"><link/></xacro:macro>',
                    "</robot>"
                ].join("\n"),
                "mb.xacro": [
                    '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                    '  <xacro:include filename="ma.xacro" ns="drv"/>',
                    "  <xacro:drv.ns_wheel/>",
                    "</robot>"
                ].join("\n")
            });
            const provider = new XacroDefinitionProvider(graph, {} as never);
            const text = docs["mb.xacro"].getText();
            const loc = await provider.provideDefinition(docs["mb.xacro"], posOf(text, "ns_wheel", 2), CTS);
            assert.ok(loc, "应命中 ns 宏");
            const l = (Array.isArray(loc) ? loc[0] : loc) as vscode.Location;
            assert.strictEqual(path.basename(l.uri.fsPath), "ma.xacro");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
