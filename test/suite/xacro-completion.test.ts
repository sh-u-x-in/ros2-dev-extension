/**
 * xacro 补全 P2 测试(04)
 *
 * 策略:临时目录写 .xacro 文件 → vscode.workspace.openTextDocument
 *      → new UrdfXacroCompletionProvider(mock graph) → provideCompletionItems。
 * 覆盖:② 关节枚举(type=" 值内)/ ③ 属性名(标签内空白)/ ④ ${} 动态(跨文件可见集)/
 *      入口 ext 过滤。②③ 不依赖 graph;④ 用 mock graph.visibleSymbols。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { UrdfXacroCompletionProvider } from "../../src/languages/xacro/ui/completion-provider";
import { IncludeGraph } from "../../src/languages/xacro/core/include-graph";
import { jointTypes, commonAttributes } from "../../src/languages/xacro/data/urdf-docs";

/** 临时目录(自动清理) */
function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rde-xacro-comp-"));
    return d;
}

/** mock graph:④ 用的 visibleSymbols 固定返回 property/arg */
function fakeGraph(): IncludeGraph {
    return {
        visibleSymbols: () => [
            { name: "wheel_radius", kind: "property", uri: vscode.Uri.file("dummy.xacro"), line: 0, column: 0 },
            { name: "namespace", kind: "arg", uri: vscode.Uri.file("dummy.xacro"), line: 0, column: 0 }
        ]
    } as unknown as IncludeGraph;
}

/** 收集补全项名称(字符串 label) */
function namesOf(items: readonly vscode.CompletionItem[] | undefined): string[] {
    return (items ?? [])
        .map(i => i.label)
        .filter((l): l is string => typeof l === "string");
}

const invokeCtx: vscode.CompletionContext = {
    triggerKind: vscode.CompletionTriggerKind.Invoke,
    triggerCharacter: undefined
};

describe("xacro 补全 P2(04)", () => {
    it("② 关节枚举:type=\" 值内列出 6 个关节类型", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "bot.xacro");
            fs.writeFileSync(p, '<robot><joint name="j1" type=""></joint></robot>');
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider();
            const line = doc.lineAt(0).text;
            const col = line.indexOf('type="') + 'type="'.length; // 光标在 type="" 引号之间
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(0, col), new vscode.CancellationTokenSource().token, invokeCtx);
            assert.deepStrictEqual(namesOf(items).sort(), jointTypes.map(j => j.name).sort());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("② 非 joint 元素(type= 的 origin)不触发", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "bot.xacro");
            fs.writeFileSync(p, '<robot><origin xyz="" type=""></origin></robot>');
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider();
            const line = doc.lineAt(0).text;
            const col = line.indexOf('type="') + 'type="'.length;
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(0, col), new vscode.CancellationTokenSource().token, invokeCtx);
            // 不在任何关节类型名中
            const names = namesOf(items);
            assert.ok(!names.includes("revolute"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("③ 属性名:标签内空白列出该元素属性(joint → name/type)", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "bot2.xacro");
            fs.writeFileSync(p, '<joint name="j1"  ></joint>'); // name 后两个空格
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider();
            const line = doc.lineAt(0).text;
            const col = line.indexOf('name="j1"') + 'name="j1"'.length; // 第一个空格
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(0, col), new vscode.CancellationTokenSource().token, invokeCtx);
            assert.deepStrictEqual(namesOf(items).sort(), [...(commonAttributes.joint ?? [])].sort());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("③ origin 标签内列出 xyz/rpy", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "bot3.xacro");
            fs.writeFileSync(p, '<robot><origin  ></origin></robot>'); // origin 后两个空格
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider();
            const line = doc.lineAt(0).text;
            const col = line.indexOf("origin") + "origin".length + 1; // 第一个空格
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(0, col), new vscode.CancellationTokenSource().token, invokeCtx);
            assert.deepStrictEqual(namesOf(items).sort(), [...(commonAttributes.origin ?? [])].sort());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("④ ${} 动态补全:mock 可见集 property/arg", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "bot4.xacro");
            fs.writeFileSync(p, "<robot>${}</robot>");
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider(fakeGraph());
            const line = doc.lineAt(0).text;
            const col = line.indexOf("${") + 2; // 光标在 ${ 后
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(0, col), new vscode.CancellationTokenSource().token, invokeCtx);
            const vars = (items ?? [])
                .filter(i => i.kind === vscode.CompletionItemKind.Variable)
                .map(i => i.label)
                .filter((l): l is string => typeof l === "string");
            assert.ok(vars.includes("wheel_radius"), "应含 property wheel_radius");
            assert.ok(vars.includes("namespace"), "应含 arg namespace");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("入口过滤:非 urdf/xacro 返回 undefined", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "bot.launch.xml");
            fs.writeFileSync(p, "<launch></launch>");
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider();
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(0, 0), new vscode.CancellationTokenSource().token, invokeCtx);
            assert.strictEqual(items, undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("xacro 补全 XG7(语法层增强,设计/xacro/14 §3)", () => {
    const invokeCtx: vscode.CompletionContext = {
        triggerKind: vscode.CompletionTriggerKind.Invoke,
        triggerCharacter: undefined
    };

    it("④ ${} 官方求值上下文补全:radians(函数)/pi(常量)/math(命名空间)", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "g1.xacro");
            fs.writeFileSync(p, "<robot>${}</robot>");
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider();
            const col = doc.lineAt(0).text.indexOf("${") + 2;
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(0, col), new vscode.CancellationTokenSource().token, invokeCtx);
            const byName = new Map((items ?? []).map(i => [i.label as string, i]));
            assert.strictEqual(byName.get("radians")?.kind, vscode.CompletionItemKind.Function);
            assert.strictEqual(byName.get("pi")?.kind, vscode.CompletionItemKind.Constant);
            assert.strictEqual(byName.get("math")?.kind, vscode.CompletionItemKind.Module);
            assert.ok((byName.get("load_yaml")?.detail ?? "").includes("YAML"), "load_yaml detail 应带语义注");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("③.5 宏调用点参数补全:标量参数入列(默认值入 detail),*块参数不作属性", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "g2.xacro");
            const text = [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:macro name="wheel" params="prefix reflect:=1 *origin">',
                '    <link name="${prefix}_wheel"/>',
                "  </xacro:macro>",
                "  <xacro:wheel  ></xacro:wheel>",
                "</robot>"
            ].join("\n");
            fs.writeFileSync(p, text);
            const graph = new IncludeGraph({} as never);
            graph.upsert(vscode.Uri.file(p), text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider(graph);
            const line = doc.lineAt(4).text;
            const col = line.indexOf("<xacro:wheel") + "<xacro:wheel".length + 1; // 第一个空格(属性区)
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(4, col), new vscode.CancellationTokenSource().token, invokeCtx);
            const byName = new Map((items ?? []).map(i => [i.label as string, i]));
            assert.ok(byName.has("prefix"), "必填标量参数应入列");
            assert.ok(byName.has("reflect"), "带默认标量参数应入列");
            assert.ok((byName.get("reflect")?.detail ?? "").includes("默认 1"), "默认值应进 detail");
            assert.ok(!byName.has("*origin"), "* 块参数不作属性补全");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("⑤ $( 命令位全集:find/env/optenv/dirname/eval/cwd 等 8 项", async () => {
        const dir = tmpDir();
        try {
            const p = path.join(dir, "g3.xacro");
            fs.writeFileSync(p, "<robot>$(</robot>");
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new UrdfXacroCompletionProvider();
            const col = doc.lineAt(0).text.indexOf("$(") + 2;
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(0, col), new vscode.CancellationTokenSource().token, invokeCtx);
            const names = (items ?? []).map(i => i.label).filter((l): l is string => typeof l === "string");
            for (const f of ["find", "find-pkg-share", "arg", "env", "optenv", "dirname", "eval", "cwd"]) {
                assert.ok(names.includes(f), `应含命令 ${f}`);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("④.0 ns 点号补全:${drv. → ns include 目标文件 property", async () => {
        const dir = tmpDir();
        try {
            const a = path.join(dir, "na.xacro");
            fs.writeFileSync(a, [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:property name="ns_radius" value="1"/>',
                "</robot>"
            ].join("\n"));
            const b = path.join(dir, "nb.xacro");
            fs.writeFileSync(b, [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:include filename="na.xacro" ns="drv"/>',
                "  <geometry radius=\"${drv.}\"/>",
                "</robot>"
            ].join("\n"));
            const graph = new IncludeGraph({} as never);
            graph.upsert(vscode.Uri.file(a));
            graph.upsert(vscode.Uri.file(b));
            const doc = await vscode.workspace.openTextDocument(b);
            const provider = new UrdfXacroCompletionProvider(graph);
            const line = doc.lineAt(2).text;
            const col = line.indexOf("${drv.") + "${drv.".length;
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(2, col), new vscode.CancellationTokenSource().token, invokeCtx);
            const names = (items ?? []).map(i => i.label).filter((l): l is string => typeof l === "string");
            assert.ok(names.includes("ns_radius"), `ns property 应入列(实际 ${JSON.stringify(names)})`);
            assert.ok(!names.includes("radians"), "点号上下文应独占(官方函数不入列)");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("④.0 ns 点号补全:<xacro:drv. 标签名位 → ns 宏", async () => {
        const dir = tmpDir();
        try {
            const a = path.join(dir, "ma.xacro");
            fs.writeFileSync(a, [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:macro name="ns_wheel"><link/></xacro:macro>',
                "</robot>"
            ].join("\n"));
            const b = path.join(dir, "mb.xacro");
            fs.writeFileSync(b, [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                '  <xacro:include filename="ma.xacro" ns="drv"/>',
                "  <xacro:drv.",
                "</robot>"
            ].join("\n"));
            const graph = new IncludeGraph({} as never);
            graph.upsert(vscode.Uri.file(a));
            graph.upsert(vscode.Uri.file(b));
            const doc = await vscode.workspace.openTextDocument(b);
            const provider = new UrdfXacroCompletionProvider(graph);
            const line = doc.lineAt(2).text;
            const items = await provider.provideCompletionItems(
                doc, new vscode.Position(2, line.length), new vscode.CancellationTokenSource().token, invokeCtx);
            const names = (items ?? []).map(i => i.label).filter((l): l is string => typeof l === "string");
            assert.ok(names.includes("ns_wheel"), `ns 宏应入列(实际 ${JSON.stringify(names)})`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
