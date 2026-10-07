/**
 * launch 可执行补全/解析跳转/域门控测试(LA-2/LA-3/LA-1,2026-09-25)
 *
 * 策略:core 纯函数头测 + provider 集成(注入 fake LaunchExecSource / fake PackageMap,
 * 不依赖真实构建产物;域门控用 os.tmpdir(工作区外)验证早退)。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import {
    pyValueSource, xmlValueSource, yamlValueSource,
    pyStringKwargInCall, xmlTagAttrBefore, yamlSiblingKeyValue,
    execValueCandidates
} from "../../src/languages/launch/core/launch-completion-core";
import { LaunchPyCompletionProvider, LaunchXmlCompletionProvider, LaunchExecSource } from "../../src/languages/launch/ui/launch-completion";
import { LaunchDefinitionProvider } from "../../src/languages/launch/ui/launch-definition-provider";
import { pyNodeCallAt } from "../../src/languages/launch/parse/launch-py-parser";
import type { PackageMap } from "../../src/languages/shared/package-map";

const CTS = new vscode.CancellationTokenSource().token;

/** 工作区内临时目录(LA-1 域门要求夹具在工作区内;测试工作区根 = samples/) */
function wsTmpDir(prefix: string): string {
    const samples = path.resolve(__dirname, "../../../samples");
    return fs.mkdtempSync(path.join(samples, "." + prefix));
}

/** fake 可执行源(注入;名单固定) */
function fakeExec(names: string[], srcFile?: string): LaunchExecSource {
    return {
        async execNames(pkg?: string): Promise<string[] | undefined> {
            return pkg === "other_pkg" ? [] : names;
        },
        async sourceOf(pkg: string, name: string): Promise<string | undefined> {
            return srcFile && pkg === "demo_pkg" && name === "demo_node" ? srcFile : undefined;
        }
    };
}

/** fake PackageMap(仅 resolvePackageDir/resolveFileRef;目录含 package.xml) */
function fakePkgMap(pkgDir: string): PackageMap {
    return {
        resolvePackageDir: async (p: string) => p === "demo_pkg" ? vscode.Uri.file(pkgDir) : undefined,
        resolveFileRef: (raw: string, fromUri: vscode.Uri) => {
            if (raw.includes("$(")) { return undefined; }
            const rel = raw.trim();
            const p = path.isAbsolute(rel) ? rel : path.join(path.dirname(fromUri.fsPath), rel);
            return fs.existsSync(p) ? vscode.Uri.file(p) : undefined;
        },
        getPackageNames: () => ["demo_pkg"]
    } as unknown as PackageMap;
}

describe("launch 可执行值源 core 纯函数(LA-2)", () => {
    it("三格式 executable 值源识别", () => {
        assert.strictEqual(pyValueSource("executable"), "exec");
        assert.strictEqual(xmlValueSource("exec", "")?.source, "exec");
        assert.strictEqual(yamlValueSource("exec", "")?.source, "exec");
        // 非可执行属性不受影响
        assert.strictEqual(pyValueSource("name"), undefined);
        assert.strictEqual(xmlValueSource("args", "")?.source, undefined);
    });

    it("pkg 上下文提取:py 调用内 / xml 同标签 / yaml 同块", () => {
        const pyText = "Node(\n\tpackage='demo_pkg',\n\texecutable='";
        const open = pyText.indexOf("(");
        assert.strictEqual(pyStringKwargInCall(pyText, open, pyText.length, "package"), "demo_pkg");
        const xmlText = '<node pkg="demo_pkg" exec="';
        assert.strictEqual(xmlTagAttrBefore(xmlText, xmlText.length, "pkg"), "demo_pkg");
        const yamlText = '- node:\n    pkg: "demo_pkg"\n    exec: ';
        assert.strictEqual(yamlSiblingKeyValue(yamlText, yamlText.length, "pkg"), "demo_pkg");
        // 越过动作行不找
        assert.strictEqual(yamlSiblingKeyValue("- node:\n    exec: ", 100, "pkg"), undefined);
    });

    it("execValueCandidates 生成 value 候选", () => {
        const items = execValueCandidates(["demo_node", "other"]);
        assert.deepStrictEqual(items.map(i => i.label), ["demo_node", "other"]);
        assert.ok(items.every(i => i.kind === "value"));
    });

    it("pyNodeCallAt:光标在 executable 值内 → package/executable 及值范围", () => {
        const text = "Node(\n    package='demo_pkg',\n    executable='demo_node',\n)";
        const exeAt = text.indexOf("'demo_node'") + 5;
        const call = pyNodeCallAt(text, exeAt);
        assert.ok(call && call.executable === "demo_node" && call.package === "demo_pkg");
        assert.ok(call.packageRange && text.slice(call.packageRange[0], call.packageRange[1]) === "demo_pkg");
        // 嵌套取内层
        const nested = "ComposableNodeContainer(\n    node=ComposableNode(\n        package='a',\n    ),\n)";
        const inner = pyNodeCallAt(nested, nested.indexOf("'a'") + 1);
        assert.ok(inner && inner.kind === "composable", "应取最内层 ComposableNode");
    });
});

describe("launch 可执行补全接线(LA-2 集成)", () => {
    it("py:executable='' 内弹出注入名单;name= 不弹", async () => {
        const dir = wsTmpDir("la-exec-");
        try {
            const p = path.join(dir, "demo.launch.py");
            const text = "Node(package='demo_pkg', executable='')";
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyCompletionProvider({} as never, fakeExec(["demo_node"]));
            const col = text.indexOf("executable='") + "executable='".length;
            const items = await provider.provideCompletionItems(doc, new vscode.Position(0, col), CTS);
            const labels = (items ?? []).map(i => (typeof i.label === "string" ? i.label : i.label.label));
            assert.ok(labels.includes("demo_node"), `应含注入的可执行名(实际 ${JSON.stringify(labels)})`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("xml:node exec='' 弹注入名单(同标签 pkg 上下文)", async () => {
        const dir = wsTmpDir("la-exec-");
        try {
            const p = path.join(dir, "demo.launch.xml");
            const text = '<node pkg="demo_pkg" exec=""/>';
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider({} as never, fakeExec(["demo_node"]));
            const col = text.indexOf('exec="') + 'exec="'.length;
            const items = await provider.provideCompletionItems(doc, new vscode.Position(0, col), CTS);
            assert.ok((items ?? []).some(i => (typeof i.label === "string" ? i.label : i.label.label) === "demo_node"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LA-1 域门控:工作区外文档补全早退", async () => {
        // 故意在域外:os.tmpdir 不在测试工作区(samples/)内
        const p = path.join(os.tmpdir(), "rde-la-outside.launch.xml");
        fs.writeFileSync(p, '<node pkg="demo_pkg" exec=""/>');
        try {
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider({} as never, fakeExec(["demo_node"]));
            const col = fs.readFileSync(p, "utf8").indexOf('exec="') + 'exec="'.length;
            const items = await provider.provideCompletionItems(doc, new vscode.Position(0, col), CTS);
            assert.strictEqual(items, undefined, "域外应早退 undefined");
        } finally {
            fs.rmSync(p, { force: true });
        }
    });
});

describe("launch 解析跳转(LA-3 集成)", () => {
    it("XML:node exec 值 → 注入源文件;pkg 值 → package.xml;include file → 目标", async () => {
        const dir = wsTmpDir("la-def-");
        try {
            fs.writeFileSync(path.join(dir, "package.xml"), "<package/>");
            const src = path.join(dir, "src", "demo_node.py");
            fs.mkdirSync(path.dirname(src));
            fs.writeFileSync(src, "#!/usr/bin/env python3");
            fs.writeFileSync(path.join(dir, "sub.launch.xml"), "<launch/>");
            const main = path.join(dir, "main.launch.xml");
            const text = [
                '<launch>',
                '  <node pkg="demo_pkg" exec="demo_node" name="n"/>',
                '  <include file="sub.launch.xml"/>',
                "</launch>"
            ].join("\n");
            fs.writeFileSync(main, text);
            const doc = await vscode.workspace.openTextDocument(main);
            const provider = new LaunchDefinitionProvider(fakePkgMap(dir), fakeExec(["demo_node"], src));
            // exec 值内(列 = 行内索引;不能用全文偏移冒充行内列)
            const line1 = text.split("\n")[1];
            const exeCol = line1.indexOf('exec="demo_node"') + 'exec="'.length + 2;
            const def1 = await provider.provideDefinition(doc, new vscode.Position(1, exeCol), CTS);
            assert.ok(def1, "exec 应命中源文件");
            const l1 = (Array.isArray(def1) ? def1[0] : def1) as vscode.Location;
            assert.strictEqual(path.basename(l1.uri.fsPath), "demo_node.py");
            // pkg 值内(行内列)
            const pkgCol = line1.indexOf('pkg="demo_pkg"') + 'pkg="'.length + 2;
            const def2 = await provider.provideDefinition(doc, new vscode.Position(1, pkgCol), CTS);
            assert.ok(def2, "pkg 应命中 package.xml");
            const l2 = (Array.isArray(def2) ? def2[0] : def2) as vscode.Location;
            assert.strictEqual(path.basename(l2.uri.fsPath), "package.xml");
            // include file 值内(行内列)
            const line2 = text.split("\n")[2];
            const incCol = line2.indexOf('file="sub.launch.xml"') + 'file="'.length + 2;
            const def3 = await provider.provideDefinition(doc, new vscode.Position(2, incCol), CTS);
            assert.ok(def3, "include 应命中目标文件");
            const l3 = (Array.isArray(def3) ? def3[0] : def3) as vscode.Location;
            assert.strictEqual(path.basename(l3.uri.fsPath), "sub.launch.xml");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("py:Node executable 值 → 注入源文件;LA-1 域外早退", async () => {
        const dir = wsTmpDir("la-def-");
        try {
            const src = path.join(dir, "demo_node.py");
            fs.writeFileSync(src, "print(1)");
            const p = path.join(dir, "demo.launch.py");
            const text = "Node(package='demo_pkg', executable='demo_node')";
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchDefinitionProvider(fakePkgMap(dir), fakeExec(["demo_node"], src));
            const col = text.indexOf("'demo_node'") + 3;
            const def = await provider.provideDefinition(doc, new vscode.Position(0, col), CTS);
            assert.ok(def, "py executable 应命中源文件");
            const l = (Array.isArray(def) ? def[0] : def) as vscode.Location;
            assert.strictEqual(path.basename(l.uri.fsPath), "demo_node.py");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
