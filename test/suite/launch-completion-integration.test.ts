/**
 * launch 补全集成测试(LC 批次,2026-09-27;电子宿主,夹具在工作区内)
 *
 * 覆盖:参数引用(py LaunchConfiguration / xml+yaml $(var)、$() 命令目录、
 *       include 文件路径单层(目录续层+文件过滤)、include 传参名(跨文件 xml/py)、
 *       py kwarg 名、LC-7 枚举、LA-1 域外早退。
 * 注入:fake PackageMap(demo_pkg → fixtureDir);夹具 = samples/.la-tmp-*
 *       (VS Code 测试工作区 = samples/,满足 LA-1 域内)。
 * 光标口径:一律"行内列"(lineColOf),禁止用全文偏移冒充 Position 列(LA-3 教训)。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import {
    LaunchPyCompletionProvider,
    LaunchXmlCompletionProvider,
    LaunchYamlCompletionProvider,
    LaunchExecSource
} from "../../src/languages/launch/ui/launch-completion";
import { LaunchDefinitionProvider } from "../../src/languages/launch/ui/launch-definition-provider";
import { LaunchPyDocumentLinkProvider } from "../../src/languages/launch/ui/launchpy-provider";
import { LaunchHoverProvider } from "../../src/languages/launch/ui/launch-hover-provider";
import { LaunchLinkProvider } from "../../src/languages/launch/ui/launch-link-provider";
import { LaunchYamlLinkProvider } from "../../src/languages/launch/ui/yaml-link-provider";
import { analyzeLaunchDocument } from "../../src/languages/launch/ui/launch-diagnostic-provider";
import type { PackageMap } from "../../src/languages/shared/package-map";

const CTS = new vscode.CancellationTokenSource().token;
const invoke: vscode.CompletionContext = { triggerKind: vscode.CompletionTriggerKind.Invoke, triggerCharacter: undefined };
const trig = (ch: string): vscode.CompletionContext => ({ triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: ch });

const execStub: LaunchExecSource = {
    execNames: async () => undefined,
    sourceOf: async () => undefined
};

function fakePkgMap(fixtureDir: string): PackageMap {
    return {
        getPackageNames: () => ["demo_pkg"],
        getWorkspaceEntries: () => [{ name: "demo_pkg", dir: fixtureDir }],
        systemAvailable: true, // LH:未知包判定仅名单就绪后生效
        get: (p: string) => p === "demo_pkg" ? vscode.Uri.file(fixtureDir) : undefined,
        resolvePackageDir: async (p: string) => p === "demo_pkg" ? vscode.Uri.file(fixtureDir) : undefined,
        resolveFileRef: (raw: string, fromUri: vscode.Uri) => {
            const rel = raw.trim();
            if (rel.includes("$(") || rel.includes("${") || rel.startsWith("package://")) {
                return undefined;
            }
            const p = path.isAbsolute(rel) ? rel : path.join(path.dirname(fromUri.fsPath), rel);
            return fs.existsSync(p) ? vscode.Uri.file(p) : undefined;
        }
    } as unknown as PackageMap;
}

function wsTmpDir(prefix: string): string {
    const samples = path.resolve(__dirname, "../../../samples");
    return fs.mkdtempSync(path.join(samples, "." + prefix));
}

/** 行内列光标:第 lineIdx 行的 needle 之后 shift 个字符 */
function lineColOf(text: string, lineIdx: number, needle: string, shift: number): vscode.Position {
    const line = text.split("\n")[lineIdx];
    const col = line.indexOf(needle);
    assert.ok(col >= 0, `锚点未找到:${needle}`);
    return new vscode.Position(lineIdx, col + shift);
}

function labels(items: readonly vscode.CompletionItem[] | undefined | null): string[] {
    return (items ?? []).map(i => (typeof i.label === "string" ? i.label : i.label.label));
}

describe("launch 补全 LC 集成(2026-09-27)", () => {
    const argsPy = [
        "from launch import LaunchDescription",
        "from launch.actions import DeclareLaunchArgument",
        "from launch.substitutions import LaunchConfiguration",
        "",
        "def g():",
        "    return LaunchDescription([",
        "        DeclareLaunchArgument('use_sim', default_value='false'),",
        "        DeclareLaunchArgument('world'),",
        "        Node(package='rde_demo', executable='n',",
        "             parameters=[LaunchConfiguration('')]),",
        "    ])"
    ].join("\n");

    it("LC-2 py:LaunchConfiguration(' 值位 → 同文件声明的参数名", async () => {
        const dir = wsTmpDir("lc-py-");
        try {
            const p = path.join(dir, "demo.launch.py");
            fs.writeFileSync(p, argsPy);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyCompletionProvider(fakePkgMap(dir), execStub);
            const idx = doc.getText().indexOf("LaunchConfiguration('") + "LaunchConfiguration('".length;
            const items = await provider.provideCompletionItems(doc, doc.positionAt(idx), CTS, invoke);
            const names = labels(items);
            assert.ok(names.includes("use_sim"), `应含参数 use_sim(实际 ${JSON.stringify(names)})`);
            assert.ok(names.includes("world"));
            const sim = (items ?? []).find(i => (i.label as string) === "use_sim")!;
            assert.ok((sim.detail as string).includes("默认 false"), "默认值应进 detail");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LC-2 xml:$(var 参数位 → 参数名", async () => {
        const dir = wsTmpDir("lc-xml-");
        try {
            const p = path.join(dir, "demo.launch.xml");
            const text = [
                "<launch>",
                '  <arg name="use_sim" default="false"/>',
                '  <param name="x" value="$(var "/>',
                "</launch>"
            ].join("\n");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 2, "$(var ", 6);
            const items = await provider.provideCompletionItems(doc, pos, CTS, invoke);
            assert.ok(labels(items).includes("use_sim"), `应含 use_sim(实际 ${JSON.stringify(labels(items))})`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LC-3 xml:$( 命令位 → 8 命令;(\" 触发窄门控(误位拒绝)", async () => {
        const dir = wsTmpDir("lc-cmd-");
        try {
            const p = path.join(dir, "demo.launch.xml");
            const text = [
                "<launch>",
                '  <param name="y" value="$(',
                "</launch>"
            ].join("\n");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 1, "$(", 2);
            const items = await provider.provideCompletionItems(doc, pos, CTS, invoke);
            const names = labels(items);
            for (const c of ["var", "env", "eval", "find-pkg-share", "find-exec", "param", "dirname", "filename", "if", "log_dir"]) {
                assert.ok(names.includes(c), `命令位应含 ${c}(实际 ${JSON.stringify(names)})`);
            }
            for (const legacy of ["optenv", "find", "cwd"]) {
                assert.ok(!names.includes(legacy), `ROS1 残留 ${legacy} 不应出现(LJ-10a)`);
            }
            const ok = await provider.provideCompletionItems(doc, pos, CTS, trig("("));
            assert.ok(ok !== undefined && labels(ok).length === 23, `"(" 触发在 $() 内应提供 23 命令(LJ-10a 全集)`);
            const bad = await provider.provideCompletionItems(doc, new vscode.Position(0, 3), CTS, trig("("));
            assert.strictEqual(bad, undefined, `"(" 在标签外应被窄门控拒绝`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LC-4 xml:include file 路径单层(目录 / + 续层 + 文件过滤);/ 触发误位拒绝", async () => {
        const dir = wsTmpDir("lc-inc-");
        try {
            fs.mkdirSync(path.join(dir, "launch"));
            fs.writeFileSync(path.join(dir, "launch", "sub.launch.xml"), "<launch/>");
            fs.writeFileSync(path.join(dir, "launch", "other.launch.py"), "pass");
            fs.writeFileSync(path.join(dir, "not_launch.txt"), "x");
            const text = '<launch>\n  <include file=""/>\n</launch>';
            const p = path.join(dir, "main.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 1, 'file=""', 6);
            const items = await provider.provideCompletionItems(doc, pos, CTS, invoke);
            assert.ok(labels(items).includes("launch/"), `应含子目录 launch/(实际 ${JSON.stringify(labels(items))})`);
            // 续层("/" 触发):换新文件名(规避 VS Code 对同 URI 的文档缓存)
            const p2 = path.join(dir, "main2.launch.xml");
            const text2 = '<launch>\n  <include file="launch/"/>\n</launch>';
            fs.writeFileSync(p2, text2);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            // 光标在值内(末个 / 之后、闭引号之前)
            const pos2 = lineColOf(text2, 1, 'file="launch/', 'file="launch/'.length);
            const items2 = await provider.provideCompletionItems(doc2, pos2, CTS, trig("/"));
            const names2 = labels(items2);
            assert.ok(names2.includes("sub.launch.xml") && names2.includes("other.launch.py"),
                `续层应含两个 launch 文件(实际 ${JSON.stringify(names2)})`);
            assert.ok(!names2.includes("not_launch.txt"), "非 launch 文件应被过滤");
            // "/" 触发误位(非 include file)→ undefined
            const bad = await provider.provideCompletionItems(doc2, new vscode.Position(0, 3), CTS, trig("/"));
            assert.strictEqual(bad, undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LC-5 xml:include 子 <arg name=\" → 目标文件声明的参数名(跨文件)", async () => {
        const dir = wsTmpDir("lc-xarg-");
        try {
            fs.writeFileSync(path.join(dir, "target.launch.xml"), [
                "<launch>",
                '  <arg name="target_a" default="1"/>',
                '  <arg name="target_b"/>',
                "</launch>"
            ].join("\n"));
            const text = [
                "<launch>",
                '  <include file="target.launch.xml">',
                '    <arg name=""/>',
                "  </include>",
                "</launch>"
            ].join("\n");
            const p = path.join(dir, "main.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 2, '<arg name=""', '<arg name="'.length);
            const items = await provider.provideCompletionItems(doc, pos, CTS, invoke);
            const names = labels(items);
            assert.ok(names.includes("target_a") && names.includes("target_b"),
                `应含目标声明参数(实际 ${JSON.stringify(names)})`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LC-5 py:launch_arguments={' 键位 → 目标文件参数名(跨文件)", async () => {
        const dir = wsTmpDir("lc-parg-");
        try {
            // 目标放在 launch/ 子目录(与 py include 的 join 路径一致)
            fs.mkdirSync(path.join(dir, "launch"), { recursive: true });
            fs.writeFileSync(path.join(dir, "launch", "target.launch.py"), [
                "from launch import LaunchDescription",
                "from launch.actions import DeclareLaunchArgument",
                "def g():",
                "    return LaunchDescription([DeclareLaunchArgument('py_arg', default_value='1')])"
            ].join("\n"));
            const p = path.join(dir, "main.launch.py");
            const text = [
                "from launch import LaunchDescription",
                "from launch.actions import IncludeLaunchDescription",
                "from launch.launch_description_sources import PythonLaunchDescriptionSource",
                "from ament_index_python.packages import get_package_share_directory",
                "import os",
                "",
                "def g():",
                "    return LaunchDescription([",
                "        IncludeLaunchDescription(",
                "            PythonLaunchDescriptionSource(",
                "                os.path.join(",
                "                    get_package_share_directory('demo_pkg'),",
                "                    'launch',",
                "                    'target.launch.py'",
                "                )",
                "            ),",
                "            launch_arguments={'",
                "        )",
                "    ])"
            ].join("\n");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyCompletionProvider(fakePkgMap(dir), execStub);
            const idx = doc.getText().indexOf("launch_arguments={'") + "launch_arguments={'".length;
            const items = await provider.provideCompletionItems(doc, doc.positionAt(idx), CTS, invoke);
            assert.ok(labels(items).includes("py_arg"), `应含目标 py 声明参数(实际 ${JSON.stringify(labels(items))})`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LC-6 py:Node( 名位 → kwarg 名(排除已键入)", async () => {
        const dir = wsTmpDir("lc-kw-");
        try {
            const p = path.join(dir, "kw.launch.py");
            const text = "Node(package='demo_pkg',\n      na)";
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyCompletionProvider(fakePkgMap(dir), execStub);
            const idx = text.indexOf("na");
            const items = await provider.provideCompletionItems(doc, doc.positionAt(idx), CTS, invoke);
            const names = labels(items);
            assert.ok(names.includes("name"), `应含 kwarg name(实际 ${JSON.stringify(names)})`);
            assert.ok(!names.includes("package"), "已键入的 package 应被排除");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LC-7 xml:respawn 枚举", async () => {
        const dir = wsTmpDir("lc-enum-");
        try {
            const p = path.join(dir, "demo.launch.xml");
            const text = '<launch>\n  <node pkg="a" exec="b" respawn=""/>\n</launch>';
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 1, 'respawn=""', 'respawn="'.length);
            const items = await provider.provideCompletionItems(doc, pos, CTS, invoke);
            assert.deepStrictEqual(labels(items), ["true", "false"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LD-2 xml:$() 命令位 range 只锚已敲前缀($( 保留);值中后续 $(var 参数位可识别", async () => {
        const dir = wsTmpDir("ld2-range-");
        try {
            const p = path.join(dir, "demo.launch.xml");
            const text = [
                "<launch>",
                '  <arg name="use_sim" default="false"/>',
                '  <param name="y" value="$(v"/>',
                "</launch>"
            ].join("\n");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 2, "$(v", 3);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, invoke)) ?? [];
            const v = items.find(i => (i.label as string) === "var");
            assert.ok(v, "命令位应含 var");
            // range 起点 = 已敲前缀 v 之处(而非值起点):选中后 $() 前缀保留
            const vr = v!.range as vscode.Range;
            assert.ok(vr, "var 项应带 range");
            assert.strictEqual(vr.start.character, lineColOf(text, 2, "$(v", 2).character,
                "range 应从已敲前缀起(保住 $()");
            assert.strictEqual((v!.insertText as vscode.SnippetString).value, "var ");

            // 值中后续 $()(尾段口径):$(find-pkg-share …)/x/$(var use_si → 参数名
            const p2 = path.join(dir, "demo2.launch.xml");
            const text2 = [
                "<launch>",
                '  <arg name="use_sim" default="false"/>',
                '  <param name="y" value="$(find-pkg-share demo_pkg)/x/$(var use_si"/>',
                "</launch>"
            ].join("\n");
            fs.writeFileSync(p2, text2);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const pos2 = lineColOf(text2, 2, "use_si", 6);
            const items2 = (await provider.provideCompletionItems(doc2, pos2, CTS, invoke)) ?? [];
            const sim = items2.find(i => (i.label as string) === "use_sim");
            assert.ok(sim, `值中后续 $(var 参数位应出 use_sim(实际 ${JSON.stringify(labels(items2))})`);
            const sr = sim!.range as vscode.Range;
            assert.strictEqual(sr.start.character, pos2.character - "use_si".length,
                "arg-ref range 只锚已敲词($(var 前缀保留)");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LD-2 xml:include file 路径项不设 range(默认词边界,$(find-pkg-share …) 前缀不被抹)", async () => {
        const dir = wsTmpDir("ld2-inc-");
        try {
            fs.mkdirSync(path.join(dir, "launch"));
            fs.writeFileSync(path.join(dir, "launch", "sub.launch.xml"), "<launch/>");
            const text = '<launch>\n  <include file="$(find-pkg-share demo_pkg)/launch/"/>\n</launch>';
            const p = path.join(dir, "main.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 1, "$(find-pkg-share demo_pkg)/launch/", "$(find-pkg-share demo_pkg)/launch/".length);
            const items = await provider.provideCompletionItems(doc, pos, CTS, trig("/"));
            assert.ok(labels(items).includes("sub.launch.xml"), `应含 launch 层文件(实际 ${JSON.stringify(labels(items))})`);
            for (const it of items ?? []) {
                assert.strictEqual(it.range, undefined, "include 路径项不应设 range(锚值起点会抹前缀)");
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LD-2 py:output= 值位 → screen/log/both/none 枚举(LJ-1 起三格式同官方 4 值)", async () => {
        const dir = wsTmpDir("ld2-out-");
        try {
            const p = path.join(dir, "demo.launch.py");
            const text = "Node(package='demo_pkg', executable='n', output='sc)";
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyCompletionProvider(fakePkgMap(dir), execStub);
            const idx = text.indexOf("output='sc") + "output='sc".length;
            const items = await provider.provideCompletionItems(doc, doc.positionAt(idx), CTS, invoke);
            assert.deepStrictEqual(labels(items), ["screen", "log", "both", "none"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LA-1 xml:域外文档早退 undefined;LC-3 yaml:$( 命令位", async () => {
        const dir = wsTmpDir("lc-yaml-");
        try {
            const inside = path.join(dir, "demo.launch.yaml");
            const yamlText = "launch:\n  - node:\n      pkg: a\n      exec: b\n      namespace: '$(var '\n";
            fs.writeFileSync(inside, yamlText);
            const doc = await vscode.workspace.openTextDocument(inside);
            const yamlProvider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            // $( 命令位(yaml):namespace 值内 "$(" 后
            const lineText = "      namespace: '$(";
            const col = lineText.length;
            const items = await yamlProvider.provideCompletionItems(doc, new vscode.Position(4, col), CTS, invoke);
            const names = labels(items);
            for (const c of ["var", "env", "find-pkg-share"]) {
                assert.ok(names.includes(c), `yaml $() 命令位应含 ${c}(实际 ${JSON.stringify(names)})`);
            }
            // LA-1:域外文档 → undefined
            const outside = path.join(os.tmpdir(), "rde-lc-outside.launch.xml");
            const xmlText = '<launch>\n  <arg name="use_sim" default="1"/>\n  <param name="x" value="$(var "/>\n</launch>';
            fs.writeFileSync(outside, xmlText);
            try {
                const doc2 = await vscode.workspace.openTextDocument(outside);
                const xmlProvider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
                const pos = lineColOf(xmlText, 2, "$(var ", 6);
                const r = await xmlProvider.provideCompletionItems(doc2, pos, CTS, invoke);
                assert.strictEqual(r, undefined, "域外应早退 undefined");
            } finally {
                fs.rmSync(outside, { force: true });
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LD-3 yaml F12:pkg:/exec:/file: 三值位(与 XML 同一落点口径)", async () => {
        const dir = wsTmpDir("ld3-yamldef-");
        try {
            fs.writeFileSync(path.join(dir, "target.launch.xml"), "<launch/>");
            fs.writeFileSync(path.join(dir, "talker.cpp"), "int main(){}");
            const yamlText = [
                "launch:",
                "  - node:",
                "      pkg: demo_pkg",
                "      exec: talker.cpp",
                "  - include:",
                "      file: target.launch.xml"
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, yamlText);
            const doc = await vscode.workspace.openTextDocument(p);
            fs.writeFileSync(path.join(dir, "talker.cpp"), "int main(){}");
            const execSrc: LaunchExecSource = {
                execNames: async () => ["talker.cpp"],
                sourceOf: async () => path.join(dir, "talker.cpp")
            };
            const provider = new LaunchDefinitionProvider(fakePkgMap(dir), execSrc);
            // pkg: 值位 → 包目录(fixture 无 package.xml → 目录落点)
            const pkgLoc = await provider.provideDefinition(doc, lineColOf(yamlText, 2, "demo_pkg", 4), CTS);
            assert.ok(pkgLoc && !Array.isArray(pkgLoc), "pkg: 应出定义");
            assert.strictEqual((pkgLoc as vscode.Location).uri.fsPath, path.join(dir), "pkg: 落点=包目录");
            // exec: 值位 → exec 源
            const execLoc = await provider.provideDefinition(doc, lineColOf(yamlText, 3, "talker.cpp", 4), CTS);
            assert.ok(execLoc, "exec: 应出定义(有 pkg 字面量 + exec 源)");
            assert.strictEqual((execLoc as vscode.Location).uri.fsPath, path.join(dir, "talker.cpp"));
            // file: 值位 → 目标文件
            const fileLoc = await provider.provideDefinition(doc, lineColOf(yamlText, 5, "target.launch.xml", 4), CTS);
            assert.ok(fileLoc, "file: 应出定义");
            assert.strictEqual((fileLoc as vscode.Location).uri.fsPath, path.join(dir, "target.launch.xml"));
            // 非值位(顶层键)→ undefined
            const none = await provider.provideDefinition(doc, lineColOf(yamlText, 0, "launch:", 2), CTS);
            assert.strictEqual(none, undefined, "非值位不跳");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LE 引号位守卫(2026-10-01 语义反转:匹配单位=整节点含引号):F12 在引号字符上照常响应", async () => {
        const dir = wsTmpDir("le-quote-");
        try {
            const yamlText = [
                "launch:",
                "  - node:",
                '      pkg: "demo_pkg"',
                '      exec: "talker.cpp"'
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, yamlText);
            fs.writeFileSync(path.join(dir, "talker.cpp"), "int main(){}");
            const doc = await vscode.workspace.openTextDocument(p);
            const execSrc: LaunchExecSource = {
                execNames: async () => ["talker.cpp"],
                sourceOf: async () => path.join(dir, "talker.cpp")
            };
            const provider = new LaunchDefinitionProvider(fakePkgMap(dir), execSrc);
            const line2 = yamlText.split("\n")[2]; // `      pkg: "demo_pkg"`
            const openQuote = line2.indexOf('"');
            const closeQuote = line2.lastIndexOf('"');
            // 开/闭引号字符上 → 照常响应(整节点含引号)
            const openLoc = await provider.provideDefinition(doc, new vscode.Position(2, openQuote), CTS);
            assert.ok(openLoc, "开引号位应响应(整节点匹配)");
            const closeLoc = await provider.provideDefinition(doc, new vscode.Position(2, closeQuote), CTS);
            assert.ok(closeLoc, "闭引号位应响应(整节点匹配)");
            // 值内容内 → 照常响应
            const inside = await provider.provideDefinition(doc, lineColOf(yamlText, 2, "demo_pkg", 4), CTS);
            assert.ok(inside, "值内容内照常响应");
            // 键区冒号前 → 不响应
            const keyArea = await provider.provideDefinition(doc, lineColOf(yamlText, 2, "pkg:", 1), CTS);
            assert.strictEqual(keyArea, undefined, "键区不响应");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LG-1 悬浮同口径:pkg 引号内前导空格 → 悬浮不响应(不再 trim 出正确路径)", async () => {
        const dir = wsTmpDir("lg1-hover-");
        try {
            const yamlText = [
                "launch:",
                "  - node:",
                '      pkg: " demo_pkg"',
                '      exec: "py_listener.py"'
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, yamlText);
            fs.writeFileSync(path.join(dir, "py_listener.py"), "pass");
            const doc = await vscode.workspace.openTextDocument(p);
            const hover = new LaunchHoverProvider(fakePkgMap(dir), execStub);
            // pkg 值(含前导空格)悬浮 → packageHover 字符集门控失败 → 无悬浮
            const h1 = await hover.provideHover(doc, lineColOf(yamlText, 2, "demo_pkg", 4), CTS);
            assert.strictEqual(h1, undefined, "引号内前导空格的 pkg 悬浮应不响应");
            // exec 值悬浮 → pkg 上下文含空格 → 无悬浮
            const h2 = await hover.provideHover(doc, lineColOf(yamlText, 3, "py_listener.py", 4), CTS);
            assert.strictEqual(h2, undefined, "exec 悬浮应随 pkg 上下文失效");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LG-3 多行 include 值:链接按行分段(换行与缩进不入线),多段同目标", async () => {
        const dir = wsTmpDir("lg3-multi-");
        try {
            fs.mkdirSync(path.join(dir, "launch"), { recursive: true });
            fs.writeFileSync(path.join(dir, "launch", "target.launch.xml"), "<launch/>");
            // 官方风格的多行属性值(file= 后换行续写)
            const text = [
                "<launch>",
                "  <include file=\"$(find-pkg-share demo_pkg)/launch/target.launch.xml\">",
                "    <arg name=\"use_sim_time\" value=\"true\"/>",
                "  </include>",
                "</launch>"
            ].join("\n");
            const p = path.join(dir, "main.launch.xml");
            fs.writeFileSync(p, text);
            fs.writeFileSync(path.join(dir, "launch", "target.launch.xml"), "<launch/>");
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchLinkProvider(fakePkgMap(dir));
            const links = await provider.provideDocumentLinks(doc, CTS);
            assert.ok(links.length >= 1, "include 应有链接");
            // 任一段落在线内的,都不应包含换行(分段生效)
            for (const l of links) {
                const t = doc.getText(l.range);
                assert.ok(!t.includes("\n"), `链接段不应含换行(实际 ${JSON.stringify(t)})`);
            }
            // 单行常规 include 仍然工作
            const single = [
                "<launch>",
                '  <include file="$(find-pkg-share demo_pkg)/launch/target.launch.xml"/>',
                "</launch>"
            ].join("\n");
            const p2 = path.join(dir, "main2.launch.xml");
            fs.writeFileSync(p2, single);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const links2 = await provider.provideDocumentLinks(doc2, CTS);
            assert.strictEqual(links2.length, 1, "单行 include 链接不受影响");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LG-1 正确语义:pkg 引号内前导空格真正参与(pkg 无响应 = 正确),合法值后恢复正常", async () => {
        const dir = wsTmpDir("le-cascade-");
        try {
            const yamlText = [
                "launch:",
                "  - node:",
                '      pkg: " demo_pkg"',
                '      exec: "py_listener.py"',
                '      name: "tip_yaml_listener"'
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, yamlText);
            fs.writeFileSync(path.join(dir, "py_listener.py"), "pass");
            const doc = await vscode.workspace.openTextDocument(p);
            const execSrc: LaunchExecSource = {
                execNames: async () => ["py_listener.py"],
                sourceOf: async () => path.join(dir, "py_listener.py")
            };
            const provider = new LaunchDefinitionProvider(fakePkgMap(dir), execSrc);
            // 正确语义:pkg 值 = " demo_pkg"(含前导空格)→ 解析失败 → pkg/exec 均无响应
            const pkgLoc = await provider.provideDefinition(doc, lineColOf(yamlText, 2, "demo_pkg", 4), CTS);
            assert.strictEqual(pkgLoc, undefined, "引号内前导空格真参与:pkg 无响应 = 正确");
            const execLoc = await provider.provideDefinition(doc, lineColOf(yamlText, 3, "py_listener.py", 4), CTS);
            assert.strictEqual(execLoc, undefined, "pkg 上下文含空格:exec 亦无响应(正确对齐)");
            // 链接:范围 = 值内容(含前导空格的解析失败 → 无链接)
            const linkProvider = new LaunchYamlLinkProvider(fakePkgMap(dir), execSrc);
            const links = await linkProvider.provideDocumentLinks(doc, CTS);
            assert.ok(!links.some(l => l.target), "引号内空格值不应产生链接");
            // 修正为合法值后恢复正常(换新文件名,规避同 URI 文档缓存)
            const fixed = yamlText.replace('" demo_pkg"', '"demo_pkg"');
            const p2 = path.join(dir, "fixed.launch.yaml");
            fs.writeFileSync(p2, fixed);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const execLoc2 = await provider.provideDefinition(doc2, lineColOf(fixed, 3, "py_listener.py", 4), CTS);
            assert.ok(execLoc2, "合法值后 exec 跳转恢复");
            assert.strictEqual((execLoc2 as vscode.Location).uri.fsPath, path.join(dir, "py_listener.py"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LD-4 py:include 链接 range 收窄为末段字面量(join 头/变量段不再画线,解析不变)", async () => {
        const dir = wsTmpDir("ld4-pylink-");
        try {
            fs.writeFileSync(path.join(dir, "tip.launch.xml"), "<launch/>");
            const text = [
                "from launch import LaunchDescription",
                "from launch.actions import IncludeLaunchDescription",
                "from launch.launch_description_sources import AnyLaunchDescriptionSource",
                "from ament_index_python.packages import get_package_share_directory",
                "",
                "def g():",
                "    return LaunchDescription([",
                "        IncludeLaunchDescription(AnyLaunchDescriptionSource(os.path.join(get_package_share_directory('demo_pkg'), 'tip.launch.xml')))",
                "    ])"
            ].join("\n");
            const p = path.join(dir, "main.launch.py");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyDocumentLinkProvider(fakePkgMap(dir));
            const links = await provider.provideDocumentLinks(doc, CTS);
            assert.strictEqual(links.length, 1, `应恰 1 条链接(实际 ${links.length})`);
            // 解析不受收窄影响
            assert.strictEqual(links[0].target?.fsPath, path.join(dir, "tip.launch.xml"));
            // range = 末段字面量引号内内容(第 8 行),不含 os.path.join
            const range = links[0].range;
            const line7 = doc.lineAt(7).text;
            const litIdx = line7.indexOf("'tip.launch.xml'");
            assert.ok(litIdx >= 0, "字面量应位于第 8 行");
            assert.strictEqual(range.start.line, 7);
            assert.strictEqual(range.start.character, litIdx + 1, "链接起点=开引号后");
            assert.strictEqual(range.end.character, litIdx + 1 + "tip.launch.xml".length, "链接终点=闭引号前");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LD-5 hover:$(var 参数声明/include 目标/kwarg 名/yaml pkg 四场景", async () => {
        const dir = wsTmpDir("ld5-hover-");
        try {
            fs.writeFileSync(path.join(dir, "target.launch.xml"), "<launch/>");
            // xml:$(var 参数悬浮(光标在名字尾)+ include file 目标悬浮
            const xmlText = [
                "<launch>",
                '  <arg name="use_sim" default="false"/>',
                '  <param name="x" value="$(var use_sim)"/>',
                '  <include file="target.launch.xml"/>',
                "</launch>"
            ].join("\n");
            const px = path.join(dir, "main.launch.xml");
            fs.writeFileSync(px, xmlText);
            const dx = await vscode.workspace.openTextDocument(px);
            const hx = new LaunchHoverProvider(fakePkgMap(dir), execStub);
            const h1 = await hx.provideHover(dx, lineColOf(xmlText, 2, "use_sim", 7), CTS);
            assert.ok(h1, "$(var 参数悬浮应命中");
            const s1 = (h1!.contents[0] as vscode.MarkdownString).value;
            assert.ok(s1.includes("use_sim") && s1.includes("false"), `应含参数名与默认值(实际 ${s1})`);
            const h2 = await hx.provideHover(dx, lineColOf(xmlText, 3, "target.launch.xml", 4), CTS);
            assert.ok(h2, "include 目标悬浮应命中");
            assert.ok((h2!.contents[0] as vscode.MarkdownString).value.includes(path.join(dir, "target.launch.xml")));
            // py:kwarg 名悬浮(光标在 executable 词尾,Node 调用内)
            const pyText = "Node(package='demo_pkg', executable='n')";
            const pp = path.join(dir, "main.launch.py");
            fs.writeFileSync(pp, pyText);
            const dp = await vscode.workspace.openTextDocument(pp);
            const hp = new LaunchHoverProvider(fakePkgMap(dir), execStub);
            const h3 = await hp.provideHover(dp, lineColOf(pyText, 0, "executable", 10), CTS);
            assert.ok(h3, "kwarg 名悬浮应命中");
            assert.ok((h3!.contents[0] as vscode.MarkdownString).value.includes("Executable name"));
            // yaml:pkg 值位悬浮 → 包目录
            const yText = "launch:\n  - node:\n      pkg: demo_pkg\n";
            const py2 = path.join(dir, "main.launch.yaml");
            fs.writeFileSync(py2, yText);
            const dy = await vscode.workspace.openTextDocument(py2);
            const hy = new LaunchHoverProvider(fakePkgMap(dir), execStub);
            const h4 = await hy.provideHover(dy, lineColOf(yText, 2, "demo_pkg", 4), CTS);
            assert.ok(h4, "yaml pkg 悬浮应命中");
            assert.ok((h4!.contents[0] as vscode.MarkdownString).value.includes(dir), "pkg 悬浮应含包目录");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LD-6 补全信息:pkg 候选 detail=工作区包 · 目录;exec 候选 detail 标包名", async () => {
        const dir = wsTmpDir("ld6-detail-");
        try {
            const text = '<launch>\n  <node pkg=""/>\n</launch>';
            const p = path.join(dir, "main.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 1, 'pkg=""', 5);
            const items = await provider.provideCompletionItems(doc, pos, CTS, invoke);
            const demo = (items ?? []).find(i => (typeof i.label === "string" ? i.label : i.label.label) === "demo_pkg");
            assert.ok(demo, "pkg 值位应含 demo_pkg");
            assert.ok((demo!.detail as string).includes("Workspace package"), `detail 应标来源(实际 ${demo!.detail})`);
            // py exec 候选 detail 标包名(置顶于宿主词级建议碎片)
            const pyText = "Node(package='demo_pkg', executable='')";
            const pp = path.join(dir, "main.launch.py");
            fs.writeFileSync(pp, pyText);
            const dp = await vscode.workspace.openTextDocument(pp);
            const execSrc: LaunchExecSource = { execNames: async () => ["talker"], sourceOf: async () => undefined };
            const pprov = new LaunchPyCompletionProvider(fakePkgMap(dir), execSrc);
            const ppos = lineColOf(pyText, 0, "executable='", 12);
            const pitems = await pprov.provideCompletionItems(dp, ppos, CTS, trig("'"));
            const tk = (pitems ?? []).find(i => (typeof i.label === "string" ? i.label : i.label.label) === "talker");
            assert.ok(tk, "exec 值位应含 talker");
            assert.ok((tk!.detail as string).includes("demo_pkg"), `exec detail 应标包名(实际 ${tk!.detail})`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("RE-3 裸 .launch 后缀:语言绑定为 xml(languages 贡献无点扩展名 endsWith 匹配),补全照常工作", async () => {
        const dir = wsTmpDir("re3-launch-");
        try {
            const text = [
                "<launch>",
                '  <arg name="use_sim" default="false"/>',
                '  <param name="x" value="$(var "/>',
                "</launch>"
            ].join("\n");
            const p = path.join(dir, "demo.launch");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            // 语言绑定实证(RE 批次勘误:LD-3 曾断言裸 .launch 无 xml 语言,系误判——
            // VS Code languagesAssociations endsWithIgnoreCase 匹配无点扩展名 "launch")
            assert.strictEqual(doc.languageId, "xml", `裸 .launch 应绑定 xml(实际 ${doc.languageId})`);
            // 补全在裸 .launch 上照常工作(pattern selector;$(var 参数位 → 同文件声明参数)
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 2, "$(var ", 6);
            const items = await provider.provideCompletionItems(doc, pos, CTS, invoke);
            assert.ok(labels(items).includes("use_sim"), "裸 .launch 补全应命中同文件声明参数");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LE-1/2 py:Node package/executable 值的文件级直达链接(范围=值内容;未命中不链)", async () => {
        const dir = wsTmpDir("le-pylink-");
        try {
            const text = [
                "Node(",
                "    package='demo_pkg',",
                "    executable='talker.cpp',",
                ")",
                "Node(package='nope_pkg', executable='x')",
                "# Node(package='ghost_pkg')"
            ].join("\n");
            const p = path.join(dir, "main.launch.py");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            fs.writeFileSync(path.join(dir, "talker.cpp"), "int main(){}");
            const execSrc: LaunchExecSource = {
                execNames: async () => ["talker.cpp"],
                sourceOf: async () => path.join(dir, "talker.cpp")
            };
            fs.writeFileSync(path.join(dir, "package.xml"), "<package/>");
            const provider = new LaunchPyDocumentLinkProvider(fakePkgMap(dir), execSrc);
            const links = await provider.provideDocumentLinks(doc, CTS);
            const pkgLink = links.find(l => doc.getText(l.range) === "demo_pkg");
            const execLink = links.find(l => doc.getText(l.range) === "talker.cpp");
            assert.ok(pkgLink, "package 值应有链接");
            assert.strictEqual(pkgLink!.target?.fsPath, path.join(dir, "package.xml"), "package 链接应直达 package.xml(优先)");
            assert.ok(execLink, "executable 值应有链接");
            assert.strictEqual(execLink!.target?.fsPath, path.join(dir, "talker.cpp"));
            assert.ok(!links.some(l => doc.getText(l.range) === "nope_pkg"), "未命中包不链");
            assert.ok(!links.some(l => doc.getText(l.range) === "ghost_pkg"), "注释内 Node 不链");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LE-2 xml:node pkg/exec 直达链接(值内容范围,引号不含)", async () => {
        const dir = wsTmpDir("le-xmllink-");
        try {
            const text = '<launch>\n  <node pkg="demo_pkg" exec="talker.cpp"/>\n</launch>';
            const p = path.join(dir, "main.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            fs.writeFileSync(path.join(dir, "talker.cpp"), "int main(){}");
            const execSrc: LaunchExecSource = {
                execNames: async () => ["talker.cpp"],
                sourceOf: async () => path.join(dir, "talker.cpp")
            };
            fs.writeFileSync(path.join(dir, "package.xml"), "<package/>");
            const provider = new LaunchLinkProvider(fakePkgMap(dir), execSrc);
            const links = await provider.provideDocumentLinks(doc, CTS);
            const pkgLink = links.find(l => doc.getText(l.range) === "demo_pkg");
            const execLink = links.find(l => doc.getText(l.range) === "talker.cpp");
            assert.ok(pkgLink && execLink, `pkg/exec 应各有一条链接(实际 ${links.length})`);
            assert.strictEqual(pkgLink!.target?.fsPath, path.join(dir, "package.xml"));
            assert.strictEqual(execLink!.target?.fsPath, path.join(dir, "talker.cpp"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LE-2 yaml:node 块 pkg/exec 直达 + CRLF 夹具范围不漂移", async () => {
        const dir = wsTmpDir("le-yamllink-");
        try {
            const body = [
                "launch:",
                "  - node:",
                "      pkg: demo_pkg",
                "      exec: talker.cpp",
                ""
            ];
            fs.writeFileSync(path.join(dir, "talker.cpp"), "int main(){}");
            const execSrc: LaunchExecSource = {
                execNames: async () => ["talker.cpp"],
                sourceOf: async () => path.join(dir, "talker.cpp")
            };
            fs.writeFileSync(path.join(dir, "package.xml"), "<package/>");
            const provider = new LaunchYamlLinkProvider(fakePkgMap(dir), execSrc);
            // LF
            const pLf = path.join(dir, "lf.launch.yaml");
            fs.writeFileSync(pLf, body.join("\n"));
            const docLf = await vscode.workspace.openTextDocument(pLf);
            const linksLf = await provider.provideDocumentLinks(docLf, CTS);
            const pkgLf = linksLf.find(l => docLf.getText(l.range) === "demo_pkg");
            const execLf = linksLf.find(l => docLf.getText(l.range) === "talker.cpp");
            assert.ok(pkgLf && execLf, `yaml pkg/exec 应各一条链接(实际 ${linksLf.length})`);
            assert.strictEqual(pkgLf!.target?.fsPath, path.join(dir, "package.xml"));
            assert.strictEqual(execLf!.target?.fsPath, path.join(dir, "talker.cpp"));
            // CRLF:同样的内容,范围必须仍落在值内容上(CRLF 盲区修复)
            const pCrlf = path.join(dir, "crlf.launch.yaml");
            fs.writeFileSync(pCrlf, body.join("\r\n"));
            const docCrlf = await vscode.workspace.openTextDocument(pCrlf);
            const linksCrlf = await provider.provideDocumentLinks(docCrlf, CTS);
            const pkgCrlf = linksCrlf.find(l => docCrlf.getText(l.range) === "demo_pkg");
            const execCrlf = linksCrlf.find(l => docCrlf.getText(l.range) === "talker.cpp");
            assert.ok(pkgCrlf && execCrlf, "CRLF 文件范围不应漂移");
            // 带引号的值:范围恒为值内容(不含引号,与 xml/py 统一;LF-1)
            const pQuoted = path.join(dir, "quoted.launch.yaml");
            fs.writeFileSync(pQuoted, [
                "launch:",
                '  - node:',
                '      pkg: "demo_pkg"',
                '      exec: "talker.cpp"',
                ""
            ].join("\r\n"));
            const docQuoted = await vscode.workspace.openTextDocument(pQuoted);
            const linksQuoted = await provider.provideDocumentLinks(docQuoted, CTS);
            const pkgQ = linksQuoted.find(l => docQuoted.getText(l.range) === "demo_pkg");
            const execQ = linksQuoted.find(l => docQuoted.getText(l.range) === "talker.cpp");
            assert.ok(pkgQ && execQ, "引号值的链接范围应为值内容(不含引号)");
            assert.strictEqual(pkgQ!.target?.fsPath, path.join(dir, "package.xml"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it('LH 诊断:yaml 格式+可解析(空白/未知包/未知可执行/include 缺失)+ 合法零误报', async () => {
        const dir = wsTmpDir('lh-diag-');
        try {
            fs.mkdirSync(path.join(dir, 'launch'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'talker.cpp'), 'int main(){}');
            fs.writeFileSync(path.join(dir, 'launch', 'real.launch.xml'), '<launch/>');
            fs.writeFileSync(path.join(dir, 'launch', 'real.launch.xml'), '<launch/>');
            const yamlText = [
                'launch:',
                '  - node:',
                '      pkg: " demo_pkg"',
                '      exec: "py_listener.py"',
                '  - node:',
                '      pkg: ghost_pkg',
                '      exec: ghost_node',
                '  - include:',
                '      file: "missing.launch.xml"',
                '  - node:',
                '      pkg: demo_pkg',
                '      exec: ghost_exec'
            ].join('\n');
            const p = path.join(dir, 'demo.launch.yaml');
            fs.writeFileSync(p, yamlText);
            fs.writeFileSync(path.join(dir, 'py_listener.py'), 'pass');
            const doc = await vscode.workspace.openTextDocument(p);
            const execSrc = { execNames: async () => ['talker.cpp'], sourceOf: async (pkg, name) => name === 'talker.cpp' ? path.join(dir, 'talker.cpp') : undefined };
            const diags = await analyzeLaunchDocument(doc, fakePkgMap(dir), execSrc, CTS);
            const msgs = diags.map(d => d.message);
            assert.ok(msgs.some(m => m.includes('前导或后导空白')), '引号内前导空格应警告: ' + JSON.stringify(msgs));
            assert.ok(msgs.some(m => m.includes('未知包 "ghost_pkg"')), 'ghost_pkg 应警告未知包');
            // exec 存在性仅 pkg 已知时判定(未知包节点的 exec 由 pkg 警告覆盖,不重复提示)
            assert.ok(msgs.some(m => m.includes('未知可执行或未构建 "ghost_exec"')), '合法包下未知 exec 应警告');
            assert.ok(msgs.some(m => m.includes('include 目标不存在')), 'missing.launch.xml 应警告');
            // 合法值零误报:demo_pkg 本身不应有任何诊断;ghost_exec 存在性警告为有意覆盖
            const diagsDemo = diags.filter(d => (d.range.start.line === 10 || d.range.start.line === 11) && d.message.includes('demo_pkg'));
            assert.strictEqual(diagsDemo.length, 0, '合法 pkg 不应警告');
            assert.strictEqual(diags.filter(d => d.range.start.line === 11).length, 1, '合法节点恰 1 条(ghost_exec 存在性)');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});