/**
 * launch 补全 LJ 集成测试(2026-10-01,电子宿主,夹具在工作区内)
 *
 * 覆盖:yaml include file 路径单层 + "/" 续层、yaml include arg 跨文件参数名(LC-5 yaml 版)、
 *       yaml remap/param 子列表(listKey 整项片段 / param from 参数文件路径)、
 *       yaml 新动作(push_ros_namespace)、xml param from 参数文件过滤、
 *       LJ-3 值数据面(exec doc=源文件、包名工作区置顶)、LJ-4 py join 末段路径 + remappings 项。
 * 注入与光标口径同 LC 集成文件(fake PackageMap / lineColOf)。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
    LaunchPyCompletionProvider,
    LaunchXmlCompletionProvider,
    LaunchYamlCompletionProvider,
    LaunchExecSource,
    InstallTruthExecSource
} from "../../src/languages/launch/ui/launch-completion";
import { resolveExecTargetUri } from "../../src/languages/launch/ui/launch-definition-provider";
import { analyzeLaunchDocument } from "../../src/languages/launch/ui/launch-diagnostic-provider";
import type { PackageMap } from "../../src/languages/shared/package-map";

const CTS = new vscode.CancellationTokenSource().token;
const invoke: vscode.CompletionContext = { triggerKind: vscode.CompletionTriggerKind.Invoke, triggerCharacter: undefined };
const trig = (ch: string): vscode.CompletionContext => ({ triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: ch });

function fakePkgMap(fixtureDir: string): PackageMap {
    return {
        getPackageNames: () => ["demo_pkg", "aaa_sys_pkg"],
        getWorkspaceEntries: () => [{ name: "demo_pkg", dir: fixtureDir }],
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

const execStub: LaunchExecSource = {
    execNames: async () => undefined,
    sourceOf: async () => undefined
};

describe("launch 补全 LJ 集成(2026-10-01)", () => {

    it("LJ-2 yaml:include file 空值 → 目录+launch 文件单层;'/' 触发续层", async () => {
        const dir = wsTmpDir("lj-yaml-path-");
        try {
            fs.mkdirSync(path.join(dir, "launch"));
            fs.writeFileSync(path.join(dir, "launch", "sub.launch.xml"), "<launch/>");
            fs.writeFileSync(path.join(dir, "launch", "notes.txt"), "x");
            const text = ["launch:", "  - include:", '    file: "'].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 2, "file: \"", 7);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, invoke)) ?? [];
            const names = labels(items);
            assert.ok(names.includes("launch/"), `应含目录 launch/:${JSON.stringify(names)}`);
            assert.ok(!names.includes("notes.txt"), "非 launch 文件应被过滤");
            // 选中目录后 "/" 续层 → launch 文件(新文件名:openTextDocument 同 URI 有内容缓存)
            const text2 = ["launch:", "  - include:", '    file: "launch/'].join("\n");
            const p2 = path.join(dir, "demo2.launch.yaml");
            fs.writeFileSync(p2, text2);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const pos2 = lineColOf(text2, 2, "launch/", 7);
            const items2 = (await provider.provideCompletionItems(doc2, pos2, CTS, trig("/"))) ?? [];
            assert.ok(labels(items2).includes("sub.launch.xml"), `"/" 续层应给 launch 文件:${JSON.stringify(labels(items2))}`);
            assert.ok(!labels(items2).includes("notes.txt"), "续层同样过滤非 launch 文件");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-2 yaml:include arg 子项 name 值位 → 目标文件声明的参数名(跨文件)", async () => {
        const dir = wsTmpDir("lj-yaml-incarg-");
        try {
            fs.writeFileSync(path.join(dir, "sub.launch.xml"),
                '<launch>\n  <arg name="use_sim" default="false"/>\n  <arg name="world"/>\n</launch>');
            const text = [
                "launch:",
                "  - include:",
                '    file: "sub.launch.xml"',
                "    arg:",
                '      - name: "'
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 4, 'name: "', 7);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig('"'))) ?? [];
            const names = labels(items);
            assert.ok(names.includes("use_sim"), `应含跨文件参数 use_sim:${JSON.stringify(names)}`);
            assert.ok(names.includes("world"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-2 yaml:remap 子列表整项片段;param 子项 from → 参数文件路径", async () => {
        const dir = wsTmpDir("lj-yaml-sub-");
        try {
            fs.mkdirSync(path.join(dir, "config"));
            fs.writeFileSync(path.join(dir, "config", "params.yaml"), "a: 1\n");
            const text = [
                "launch:",
                "  - node:",
                '      pkg: "demo_pkg"',
                "      remap:",
                "        - "
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 4, "- ", 2);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig("-"))) ?? [];
            const item = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "remap 项");
            assert.ok(item, `remap 下应给整项片段:${JSON.stringify(labels(items))}`);
            assert.ok((item!.insertText as vscode.SnippetString).value.startsWith("from:"), "已敲 - 不应重复带 '- '");
            // param 子项 from: 根层列目录(config/);"/" 续层出 params.yaml(新文件名避同 URI 缓存)
            const text2 = [
                "launch:",
                "  - node:",
                '      pkg: "demo_pkg"',
                "      param:",
                '        - from: "'
            ].join("\n");
            const p2 = path.join(dir, "demo2.launch.yaml");
            fs.writeFileSync(p2, text2);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const pos2 = lineColOf(text2, 4, 'from: "', 7);
            const items2 = (await provider.provideCompletionItems(doc2, pos2, CTS, trig('"'))) ?? [];
            assert.ok(labels(items2).includes("config/"), `param from 应列目录:${JSON.stringify(labels(items2))}`);
            const text3 = [
                "launch:",
                "  - node:",
                '      pkg: "demo_pkg"',
                "      param:",
                '        - from: "config/'
            ].join("\n");
            const p3 = path.join(dir, "demo3.launch.yaml");
            fs.writeFileSync(p3, text3);
            const doc3 = await vscode.workspace.openTextDocument(p3);
            const pos3 = lineColOf(text3, 4, "config/", 7);
            const items3 = (await provider.provideCompletionItems(doc3, pos3, CTS, trig("/"))) ?? [];
            const names3 = labels(items3);
            assert.ok(names3.includes("params.yaml"), `续层应出 params.yaml:${JSON.stringify(names3)}`);
            assert.ok(!names3.some(n => n.includes("launch")), "launch 命名不应混入参数文件列表");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-2/LJ-1 yaml:push_ros_namespace 动作候选", async () => {
        const dir = wsTmpDir("lj-yaml-act-");
        try {
            const text = ["launch:", "  - push_ros_namespac"].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 1, "push_ros_namespac", 17);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, invoke)) ?? [];
            assert.ok(labels(items).includes("push_ros_namespace"), JSON.stringify(labels(items)));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-2 xml:param from 值 → 参数文件过滤(yaml only;'/' 续层)", async () => {
        const dir = wsTmpDir("lj-xml-param-");
        try {
            fs.mkdirSync(path.join(dir, "config"));
            fs.writeFileSync(path.join(dir, "config", "params.yaml"), "a: 1\n");
            fs.writeFileSync(path.join(dir, "sub.launch.xml"), "<launch/>");
            const text = '<launch>\n  <node pkg="demo_pkg" exec="n">\n    <param from=""/>\n  </node>\n</launch>';
            const p = path.join(dir, "demo.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 2, 'from="', 6);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig('"'))) ?? [];
            assert.ok(labels(items).includes("config/"), `根层应列目录:${JSON.stringify(labels(items))}`);
            assert.ok(!labels(items).includes("sub.launch.xml"), "launch 文件不应混入");
            const text2 = '<launch>\n  <node pkg="demo_pkg" exec="n">\n    <param from="config/"/>\n  </node>\n</launch>';
            const p2 = path.join(dir, "demo2.launch.xml");
            fs.writeFileSync(p2, text2);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const pos2 = lineColOf(text2, 2, 'config/', 7);
            const items2 = (await provider.provideCompletionItems(doc2, pos2, CTS, trig("/"))) ?? [];
            assert.ok(labels(items2).includes("params.yaml"), `续层应出参数文件:${JSON.stringify(labels(items2))}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-3:包名候选行内标工作区/系统+悬浮完整路径;exec 行内相对路径+悬浮绝对路径", async () => {
        const dir = wsTmpDir("lj-values-");
        try {
            const text = '<launch>\n  <node pkg="demo_pkg" exec=""/>\n</launch>';
            const p = path.join(dir, "demo.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const execSrc: LaunchExecSource = {
                execNames: async () => ["talker"],
                sourceOf: async () => path.join(dir, "src", "talker.cpp")
            };
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execSrc);
            const pos = lineColOf(text, 1, 'pkg="demo_pkg"', 5);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig('"'))) ?? [];
            const ws = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "demo_pkg");
            const sys = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "aaa_sys_pkg");
            assert.ok(ws && sys, `应有两包:${JSON.stringify(labels(items))}`);
            assert.strictEqual(ws!.sortText, "2_a", "工作区包应置顶");
            assert.strictEqual(sys!.sortText, "2_z", "系统包应垫底");
            // 包候选:行内 description = 工作区包/系统包;悬浮 = 完整包路径
            assert.strictEqual((ws!.label as vscode.CompletionItemLabel).description, "Workspace package", "行内应标工作区包");
            assert.strictEqual((sys!.label as vscode.CompletionItemLabel).description, "System package", "行内应标系统包");
            assert.strictEqual(ws!.detail, "Workspace package");
            const wsDoc = (ws!.documentation as vscode.MarkdownString).value;
            assert.ok(wsDoc.includes(dir), `工作区包悬浮应含完整路径:${wsDoc}`);
            // exec 值位:行内 = 包内相对路径;悬浮 = 完整绝对路径
            const pos2 = lineColOf(text, 1, 'exec="', 6);
            const items2 = (await provider.provideCompletionItems(doc, pos2, CTS, trig('"'))) ?? [];
            const talker = items2.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "talker");
            assert.ok(talker, `应出可执行名:${JSON.stringify(labels(items2))}`);
            assert.strictEqual(talker!.detail, "demo_pkg", "顶部栏标所属包");
            const talkerLabel = talker!.label as vscode.CompletionItemLabel;
            assert.strictEqual(talkerLabel.description, "src/talker.cpp", "行内应为包内相对路径");
            assert.ok(talker!.documentation !== undefined, "exec 候选应带源文件 doc");
            const docText = (talker!.documentation as vscode.MarkdownString).value;
            assert.ok(docText.replace(/\\/g, "").includes("demo_pkg包的src/talker.cpp"), `悬浮应为 包名包的相对路径 文案:${docText}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-3:无 pkg 上下文 exec 候选经 ownersOf 反查;行内相对路径兜底包名", async () => {
        const dir = wsTmpDir("lj-exec-own-");
        try {
            const text = '<launch>\n  <node exec=""/>\n</launch>';
            const p = path.join(dir, "demo.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const execSrc: LaunchExecSource = {
                execNames: async () => ["talker", "listener"],
                sourceOf: async () => path.join(dir, "scripts", "talker.py"),
                ownersOf: async (n) => [n === "talker" ? "demo_pkg" : "zzz_pkg"]
            };
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execSrc);
            const pos = lineColOf(text, 1, 'exec="', 6);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig('"'))) ?? [];
            const talker = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "talker");
            const listener = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "listener");
            assert.ok(talker && listener, JSON.stringify(labels(items)));
            assert.strictEqual(talker!.detail, "demo_pkg", "ownersOf 反查应标包");
            assert.strictEqual((talker!.label as vscode.CompletionItemLabel).description, "scripts/talker.py", "有源 → 行内相对路径");
            // listener 属 zzz_pkg(fake get 未命中)→ 相对化失败兜底包名
            assert.strictEqual((listener!.label as vscode.CompletionItemLabel).description, "zzz_pkg", "无源/跨包 → 兜底包名");
            const docText = (talker!.documentation as vscode.MarkdownString).value;
            assert.ok(docText.replace(/\\/g, "").includes("demo_pkg包的scripts/talker.py"), `悬浮应为 包名包的相对路径 文案:${docText}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-4 py:os.path.join 末段路径(Invoke)与 '/' 续层;remappings 项 snippet", async () => {
        const dir = wsTmpDir("lj-py-join-");
        try {
            fs.mkdirSync(path.join(dir, "launch"));
            fs.writeFileSync(path.join(dir, "launch", "sub.launch.py"), "x");
            const text = [
                "from launch import LaunchDescription",
                "from launch.actions import IncludeLaunchDescription",
                "from launch.launch_description_sources import PythonLaunchDescriptionSource",
                "from ament_index_python.packages import get_package_share_directory",
                "import os",
                "",
                "def g():",
                "    return IncludeLaunchDescription(PythonLaunchDescriptionSource(",
                "        os.path.join(get_package_share_directory('demo_pkg'), '')))"
            ].join("\n");
            const p = path.join(dir, "demo.launch.py");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 8, "), ''", 4); // 末段空串内(引号触发后全量列)
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig("'"))) ?? [];
            assert.ok(labels(items).includes("launch/"), `join 末段应列目录:${JSON.stringify(labels(items))}`);
            // "/" 续层:当前段含目录分隔('launch/su';新文件名避同 URI 缓存)
            const text2 = text.replace("''", "'launch/su");
            const p2 = path.join(dir, "demo2.launch.py");
            fs.writeFileSync(p2, text2);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const pos2 = lineColOf(text2, 8, "'launch/su", 10);
            const items2 = (await provider.provideCompletionItems(doc2, pos2, CTS, trig("/"))) ?? [];
            assert.ok(labels(items2).includes("sub.launch.py"), `"/" 续层应列文件:${JSON.stringify(labels(items2))}`);
            // remappings=[ 项 snippet
            const text3 = [
                "from launch_ros.actions import Node",
                "def g():",
                "    return Node(package='demo_pkg', executable='n', remappings=["
            ].join("\n");
            const p3 = path.join(dir, "demo3.launch.py");
            fs.writeFileSync(p3, text3);
            const doc3 = await vscode.workspace.openTextDocument(p3);
            const pos3 = lineColOf(text3, 2, "remappings=[", 12);
            const items3 = (await provider.provideCompletionItems(doc3, pos3, CTS, trig("'"))) ?? [];
            assert.ok(labels(items3).includes("重映射项"), `remappings=[ 应给项片段:${JSON.stringify(labels(items3))}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe("LJ-5 系统包可执行接电(2026-10-01)", () => {
    it("execNames/sourceOf CLI 兜底:名单/安装路径/呈现/跳转落点", async () => {
        const dir = wsTmpDir("lj5-cli-");
        try {
            const installPath = path.join(dir, "opt", "lib", "sys_pkg", "sys_tool");
            fs.mkdirSync(path.dirname(installPath), { recursive: true });
            fs.writeFileSync(installPath, "#!/usr/bin/env python3");
            const pm = fakePkgMap(dir);
            (pm as any).executablesOf = async (pkg: string) => pkg === "sys_pkg"
                ? [{ name: "sys_tool", path: installPath }]
                : undefined;
            const exec = new InstallTruthExecSource(pm);
            assert.deepStrictEqual(await exec.execNames("sys_pkg"), ["sys_tool"], "工作区未命中应 CLI 兜底名单");
            assert.strictEqual(await exec.sourceOf("sys_pkg", "sys_tool"), installPath, "sourceOf 应兜底安装路径");
            const text = '<launch>\n  <node pkg="sys_pkg" exec=""/>\n</launch>';
            const p = path.join(dir, "demo.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(pm, exec);
            const pos = lineColOf(text, 1, 'exec="', 6);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig("\""))) ?? [];
            const tool = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "sys_tool");
            assert.ok(tool, JSON.stringify(labels(items)));
            assert.strictEqual((tool!.label as vscode.CompletionItemLabel).description, "sys_pkg", "系统包行内兜底包名");
            const docText = ((tool!.documentation as vscode.MarkdownString).value).replace(/\\/g, "");
            assert.ok(docText.includes("sys_pkg包的sys_tool"), `悬浮文案:${docText}`);
            const uri = await resolveExecTargetUri(exec, "sys_pkg", "sys_tool");
            assert.ok(uri && uri.fsPath === installPath, "跳转应落 CLI 安装路径");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("诊断:CLI 兜底命中 → 不再误报未知可执行", async () => {
        const dir = wsTmpDir("lj5-diag-");
        try {
            const pm = fakePkgMap(dir);
            (pm as any).executablesOf = async () => [{ name: "talker", path: "/opt/ros/humble/lib/x/talker" }];
            const exec = new InstallTruthExecSource(pm);
            const text = 'launch:\n  - node:\n      pkg: demo_pkg\n      exec: "talker"\n';
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const diags = await analyzeLaunchDocument(doc, pm, exec, CTS);
            const bad = diags.filter(d => d.message.includes("未知可执行"));
            assert.strictEqual(bad.length, 0, `CLI 命中不应误报:${JSON.stringify(diags.map(d => d.message))}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

describe("LJ-6 残差动作全集 + 序无关(2026-10-01)", () => {

    it("yaml:node_container exec 值(pkg 写在 exec 之后,序无关)→ 可执行名", async () => {
        const dir = wsTmpDir("lj6-container-");
        try {
            const execSrc: LaunchExecSource = {
                execNames: async () => ["component_container"],
                sourceOf: async () => undefined
            };
            const text = [
                "launch:",
                "  - node_container:",
                '      exec: "',
                '      pkg: "rclcpp_components"'
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execSrc);
            const pos = lineColOf(text, 2, 'exec: "', 7);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig('"'))) ?? [];
            assert.ok(labels(items).includes("component_container"),
                `exec 在前 pkg 在后应命中(LJ-6 序无关):${JSON.stringify(labels(items))}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("yaml:set_parameters_from_file filename → 参数文件路径('/' 续层)", async () => {
        const dir = wsTmpDir("lj6-paramfile-");
        try {
            fs.mkdirSync(path.join(dir, "config"));
            fs.writeFileSync(path.join(dir, "config", "params.yaml"), "a: 1\n");
            const text = [
                "launch:",
                "  - set_parameters_from_file:",
                '    filename: "config/'
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 2, "config/", 7);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig("/"))) ?? [];
            assert.ok(labels(items).includes("params.yaml"), `filename 应列参数文件:${JSON.stringify(labels(items))}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("xml:node_container exec 值(pkg 在后,序无关)→ 可执行名", async () => {
        const dir = wsTmpDir("lj6-xml-container-");
        try {
            const execSrc: LaunchExecSource = {
                execNames: async () => ["component_container"],
                sourceOf: async () => undefined
            };
            const text = '<launch>\n  <node_container exec="" pkg="rclcpp_components" name="c"/>\n</launch>';
            const p = path.join(dir, "demo.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(fakePkgMap(dir), execSrc);
            const pos = lineColOf(text, 1, 'exec="', 6);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig('"'))) ?? [];
            assert.ok(labels(items).includes("component_container"), JSON.stringify(labels(items)));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("py:SetParametersFromFile(filename= → 参数文件路径", async () => {
        const dir = wsTmpDir("lj6-py-paramfile-");
        try {
            fs.mkdirSync(path.join(dir, "config"));
            fs.writeFileSync(path.join(dir, "config", "params.yaml"), "a: 1\n");
            const text = [
                "from launch_ros.actions import SetParametersFromFile",
                "def g():",
                "    return SetParametersFromFile(filename='config/')"
            ].join("\n");
            const p = path.join(dir, "demo.launch.py");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 2, "config/", 7);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig("/"))) ?? [];
            assert.ok(labels(items).includes("params.yaml"), `filename= 应列参数文件:${JSON.stringify(labels(items))}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
});

describe("LJ-7 去风暴 + resolve 懒取 + dash 词锚(2026-10-02)", () => {

    /** 带计数的 fake:get 计数(断言零调用),resolvePackageDir 计数(带缓存语义,模拟真实 PackageMap) */
    function makeCountingPkgMap(fixtureDir: string): { pm: PackageMap; getCalls: () => number; resolveCalls: () => number } {
        let getCalls = 0;
        let resolveCalls = 0;
        const resolved = new Map<string, vscode.Uri>();
        const pm = fakePkgMap(fixtureDir);
        (pm as any).get = (p: string) => {
            getCalls++;
            return p === "demo_pkg" ? vscode.Uri.file(fixtureDir) : undefined;
        };
        (pm as any).resolvePackageDir = async (p: string) => {
            const hit = resolved.get(p);
            if (hit) {
                return hit; // 真实语义:目录已缓存直接返回,不再计数
            }
            resolveCalls++;
            const dir = p === "aaa_sys_pkg" ? vscode.Uri.file(path.join(fixtureDir, "opt", "aaa_sys_pkg")) : undefined;
            if (dir) {
                resolved.set(p, dir);
            }
            return dir;
        };
        return { pm, getCalls: () => getCalls, resolveCalls: () => resolveCalls };
    }

    it("LJ-9:包名补全零 get 调用;resolve 驻留门——驻留 0.5s 才取,驻留期内取消零取数,重复走缓存", async () => {
        const dir = wsTmpDir("lj9-dwell-");
        try {
            const { pm, getCalls, resolveCalls } = makeCountingPkgMap(dir);
            const text = '<launch>\n  <node pkg="" />\n</launch>';
            const p = path.join(dir, "demo.launch.xml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchXmlCompletionProvider(pm, execStub);
            const pos = lineColOf(text, 1, 'pkg="', 5);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig('"'))) ?? [];
            assert.strictEqual(getCalls(), 0, `包名补全期间不应有任何 get 调用(风暴根除),实际 ${getCalls()}`);
            const sys = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "aaa_sys_pkg");
            const ws = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "demo_pkg");
            assert.ok(sys && ws, JSON.stringify(labels(items)));
            assert.strictEqual(sys!.documentation, undefined, "系统候选 provide 阶段应无文档");
            assert.ok(ws!.documentation !== undefined, "工作区包应保留免费目录文档");
            // 驻留门·取消路径:resolve 触发后立即取消(模拟快速浏览离开)→ 零取数
            const cancelled = new vscode.CancellationTokenSource();
            const p1 = provider.resolveCompletionItem(sys!, cancelled.token);
            cancelled.cancel();
            const r1 = await p1;
            assert.strictEqual(resolveCalls(), 0, "驻留期内取消应零取数");
            assert.strictEqual(r1.documentation, undefined, "被取消的 resolve 不应带文档");
            // 驻留路径:不取消 → 0.5s 后取一次
            const r2 = await provider.resolveCompletionItem(sys!, CTS);
            assert.strictEqual(resolveCalls(), 1, "驻留满应懒取一次");
            assert.ok(r2.documentation !== undefined, "驻留 resolve 应带目录文档");
            // 重复 resolve:缓存语义下零新增取数
            await provider.resolveCompletionItem(r2, CTS);
            assert.strictEqual(resolveCalls(), 1, "重复 resolve 应走缓存");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-7b yaml:'- ' 后触发(listKey)→ range 空于光标且 insert 无 '- ' 前缀(词锚)", async () => {
        const dir = wsTmpDir("lj7-dash-lk-");
        try {
            const text = [
                "launch:",
                "  - node:",
                '      pkg: "demo_pkg"',
                "      param:",
                "        - "
            ].join("\n");
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 4, "- ", 2);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, invoke)) ?? [];
            const item = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "param 项");
            assert.ok(item, `应出 param 项:${JSON.stringify(labels(items))}`);
            const r = item!.range as vscode.Range;
            assert.ok(r.start.character === r.end.character && r.start.character === pos.character,
                `range 应为光标处空区间:${JSON.stringify(r)}`);
            assert.ok(!(item!.insertText as vscode.SnippetString).value.startsWith("- "),
                "insert 不应带 '- ' 前缀(- 保留在原文)");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-7b yaml:顶层 '- ' 动作触发 → range 空于光标且 insert 剥前缀;'- n' 只锚已敲词", async () => {
        const dir = wsTmpDir("lj7-dash-act-");
        try {
            const text = "launch:\n  - ";
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 1, "- ", 2);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, invoke)) ?? [];
            const node = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "node");
            assert.ok(node, `顶层 '- ' 应出动作片段:${JSON.stringify(labels(items))}`);
            const r = node!.range as vscode.Range;
            assert.ok(r.start.character === r.end.character && r.start.character === pos.character,
                `range 应为空区间:${JSON.stringify(r)}`);
            assert.ok(!(node!.insertText as vscode.SnippetString).value.startsWith("- "),
                "insert 应剥 '- ' 前缀");
            // '- n':range 只锚 n
            const text2 = "launch:\n  - n";
            const p2 = path.join(dir, "demo2.launch.yaml");
            fs.writeFileSync(p2, text2);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const pos2 = lineColOf(text2, 1, "n", 1);
            const items2 = (await provider.provideCompletionItems(doc2, pos2, CTS, invoke)) ?? [];
            const node2 = items2.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "node");
            assert.ok(node2, JSON.stringify(labels(items2)));
            const r2 = node2!.range as vscode.Range;
            assert.strictEqual(r2.start.character, pos2.character - 1, "range 应只锚已敲词 n");
            assert.ok(!(node2!.insertText as vscode.SnippetString).value.startsWith("- "));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-7b yaml:'-' 无空格触发 → insert 前补一个空格(分隔符兜底)", async () => {
        const dir = wsTmpDir("lj7-dash-nospace-");
        try {
            const text = "launch:\n  -";
            const p = path.join(dir, "demo.launch.yaml");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchYamlCompletionProvider(fakePkgMap(dir), execStub);
            const pos = new vscode.Position(1, 3);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, trig("-"))) ?? [];
            const node = items.find(i => (typeof i.label === "string" ? i.label : i.label.label) === "node");
            assert.ok(node, JSON.stringify(labels(items)));
            assert.ok((node!.insertText as vscode.SnippetString).value.startsWith(" "),
                "insert 应前补空格避免 -node: 黏连");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("LJ-10:py 结构命中新骨架(事件链/OpaqueFunction);OnProcessExit kwarg 目录", async () => {
        const dir = wsTmpDir("lj10-py-");
        try {
            const text = "from launch.actions import Regist";
            const p = path.join(dir, "demo.launch.py");
            fs.writeFileSync(p, text);
            const doc = await vscode.workspace.openTextDocument(p);
            const provider = new LaunchPyCompletionProvider(fakePkgMap(dir), execStub);
            const pos = lineColOf(text, 0, "Regist", 6);
            const items = (await provider.provideCompletionItems(doc, pos, CTS, invoke)) ?? [];
            assert.ok(labels(items).includes("Event chain (on process exit)"),
                `结构应命中事件链骨架:${JSON.stringify(labels(items))}`);
            // OnProcessExit 调用内 kwarg 名位 → target_action/on_exit
            const text2 = "from launch.event_handlers import OnProcessExit\nRegisterEventHandler(OnProcessExit(";
            const p2 = path.join(dir, "demo2.launch.py");
            fs.writeFileSync(p2, text2);
            const doc2 = await vscode.workspace.openTextDocument(p2);
            const pos2 = new vscode.Position(1, text2.split("\n")[1].length);
            const items2 = (await provider.provideCompletionItems(doc2, pos2, CTS, invoke)) ?? [];
            const names2 = labels(items2);
            assert.ok(names2.includes("target_action") && names2.includes("on_exit"),
                `OnProcessExit 内应出 kwarg 目录:${JSON.stringify(names2)}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
