/**
 * launch 补全核心单测(2026-09-05):上下文判定(py/XML/yaml)+ 候选目录。
 * 纯 TS(import 自 languages/launch/core/launch-completion-core),可无头跑。
 * LC-1 起:launch-args 传递依赖 py-parser(运行时 vscode.Uri)→ 无头时先装 vscode stub。
 */
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

import * as assert from "assert";
import * as core from "../../src/languages/launch/core/launch-completion-core";
import { parsePyString, parsePyStringConcatenation, scanLaunchNodeRefs } from "../../src/languages/launch/parse/launch-py-parser";
import { declaredArgs, declaredArgsPy, declaredArgsXml, declaredArgsYaml } from "../../src/languages/launch/core/launch-args";

/** 取前 atLine+1 行、末行截到 col 的文本(模拟光标位于 col) */
function prefixTo(lines: string[], atLine: number, col: number): string {
    const partial = lines.slice(0, atLine + 1);
    partial[atLine] = partial[atLine].slice(0, col);
    return partial.join("\n");
}

describe("launch-completion core", () => {
    // ---------- Python ----------

    describe("py 上下文", () => {
        it("enclosingPyCall:定位 Node( 调用内", () => {
            const text = "def f():\n    return LaunchDescription([Node(\n        package='abc',\n    )])";
            const offset = text.indexOf("package='abc'") + "package='".length + 2; // 值中间
            const ctx = core.enclosingPyCall(text, offset);
            assert.ok(ctx);
            assert.strictEqual(ctx!.call, "Node");
        });

        it("pyAttrContextAt:Node(package= 值内 → attr=package", () => {
            const text = "Node(\n    package='rd',\n    executable='talker',\n)";
            const offset = text.indexOf("rd") + 2; // 引号值内
            const c = core.pyAttrContextAt(text, offset);
            assert.ok(c);
            assert.strictEqual(c!.attr, "package");
            assert.strictEqual(c!.valueStart, text.indexOf("rd"));
        });

        it("pyAttrContextAt:已闭合 kwarg(光标在闭合引号后)→ undefined", () => {
            const text = "Node(\n    package='rde_py',\n    executable='x',\n)";
            const offset = text.indexOf("executable='x'") + "executable='x'".length;
            assert.strictEqual(core.pyAttrContextAt(text, offset), undefined);
        });

        it("pyAttrContextAt:get_package_share_directory('pkg → package", () => {
            const text = "os.path.join(get_package_share_directory('rde";
            const offset = text.length; // 引号内、未闭合
            const c = core.pyAttrContextAt(text, offset);
            assert.ok(c);
            assert.strictEqual(c!.attr, "package");
        });

        it("pyValueSource:package → pkg;executable → exec(LA-2 接线);name 无源", () => {
            assert.strictEqual(core.pyValueSource("package"), "pkg");
            assert.strictEqual(core.pyValueSource("executable"), "exec");
            assert.strictEqual(core.pyValueSource("name"), undefined);
        });
    });

    describe("py 候选", () => {
        it("pyStructureCandidates:前缀命中目录(大小写不敏感)", () => {
            const items = core.pyStructureCandidates("Nod");
            assert.ok(items.some(i => i.label === "Node"));
            const node = items.find(i => i.label === "Node")!;
            assert.ok(node.insert.includes("package="));
            assert.strictEqual(node.kind, "snippet");
        });
        it("pyStructureCandidates:无命中 → 空", () => {
            assert.strictEqual(core.pyStructureCandidates("zzz_").length, 0);
        });
    });

    // ---------- XML ----------

    describe("XML 上下文", () => {
        it("xmlCursorAt:标签名内(tagName + 父链)", () => {
            const text = "<launch>\n  <node pkg=\"t\">\n    <";
            const c = core.xmlCursorAt(text, text.length);
            assert.ok(c);
            assert.strictEqual(c!.kind, "tagName");
            assert.deepStrictEqual(c!.parents, ["launch", "node"]);
        });

        it("xmlCursorAt:属性值内(attrValue,valueStart 定位)", () => {
            const text = "<launch>\n  <node pkg=\"rd"; // 引号内未闭合
            const offset = text.length;
            const c = core.xmlCursorAt(text, offset);
            assert.ok(c && c.kind === "attrValue");
            assert.strictEqual(c.attr, "pkg");
            assert.strictEqual(c.value, "rd");
            assert.strictEqual(text.slice(c.valueStart, offset), "rd");
        });

        it("xmlCursorAt:find-pkg-share 前缀(file 属性)keep>0", () => {
            const text = '<launch>\n  <include file="$(find-pkg-share '; // 引号内未闭合
            const c = core.xmlCursorAt(text, text.length);
            assert.ok(c && c.kind === "attrValue");
            const v = core.xmlValueSource(c.attr, c.value);
            assert.ok(v && v.source === "pkg" && v.keep > 0);
        });

        it("xmlCursorAt:属性名输入中", () => {
            const text = "<launch>\n  <node pk";
            const c = core.xmlCursorAt(text, text.length);
            assert.ok(c && c.kind === "attrName");
            assert.strictEqual(c.tag, "node");
            assert.strictEqual(c.attrPrefix, "pk");
        });

        it("xmlCursorAt:标签间(text)父链 = 根 launch", () => {
            const t2 = "<launch>\n  <arg name=\"a\" default=\"b\"/>\n  ";
            const c = core.xmlCursorAt(t2, t2.length);
            assert.ok(c && c.kind === "text");
            assert.deepStrictEqual(c.parents, ["launch"]);
        });
    });

    describe("XML 候选", () => {
        it("xmlChildCandidates:launch 下前缀 n → node", () => {
            const items = core.xmlChildCandidates("launch", "n");
            assert.ok(items.some(i => i.label === "node"));
        });
        it("xmlChildCandidates:根(无父)前缀空含 launch", () => {
            const items = core.xmlChildCandidates(undefined, "");
            assert.ok(items.some(i => i.label === "launch"));
        });
        it("xmlAttrCandidates:node 属性含 pkg/exec", () => {
            const attrs = core.xmlAttrCandidates("node", "");
            assert.ok(attrs.some(a => a.label === "pkg"));
            assert.ok(attrs.some(a => a.label === "exec"));
        });
        it("xmlValueSource:output → 枚举;pkg → 包名", () => {
            assert.deepStrictEqual(core.xmlValueSource("output", "sc"), { source: "output" });
            assert.deepStrictEqual(core.xmlValueSource("pkg", "rd"), { source: "pkg", keep: 0 });
        });
    });

    // ---------- YAML ----------

    describe("YAML 上下文", () => {
        it("列表项 '- no' → action(prefix=no)", () => {
            const lines = ["launch:", "  - no"];
            const t = prefixTo(lines, 1, 6);
            const c = core.yamlCursorAt(t, t.length);
            assert.ok(c && c.kind === "action");
            assert.strictEqual(c.prefix, "no");
        });

        it("动作下键区 → key(action=node,prefix=pk)", () => {
            const lines = ["launch:", "  - node:", "      pk"];
            const t = prefixTo(lines, 2, 8);
            const c = core.yamlCursorAt(t, t.length);
            assert.ok(c && c.kind === "key");
            assert.strictEqual(c.action, "node");
            assert.strictEqual(c.keyPrefix, "pk");
        });

        it("node 下 pkg 引号值 → value(package 名源)", () => {
            const lines = ["launch:", "  - node:", '      pkg: "tu'];
            const t = prefixTo(lines, 2, 14);
            const c = core.yamlCursorAt(t, t.length);
            assert.ok(c && c.kind === "value");
            assert.strictEqual(c.key, "pkg");
            assert.strictEqual(c.valuePrefix, "tu");
            const v = core.yamlValueSource(c.key, c.valuePrefix);
            assert.ok(v && v.source === "pkg");
        });

        it("include/file 的 find-pkg-share 前缀 → keep>0", () => {
            const lines = ["launch:", "  - include:", '      file: "$(find-pkg-share '];
            const t = prefixTo(lines, 2, 30);
            const c = core.yamlCursorAt(t, t.length);
            assert.ok(c && c.kind === "value");
            const v = core.yamlValueSource(c.key, c.valuePrefix);
            assert.ok(v && v.source === "pkg" && v.keep > 0);
        });

        it("顶层无 launch: → 根键候选", () => {
            assert.strictEqual(core.hasYamlRootLaunch(""), false);
            assert.strictEqual(core.hasYamlRootLaunch("launch:\n  - node:"), true);
            const roots = core.yamlRootCandidate("launch", true);
            assert.ok(roots.some(i => i.label === "launch"));
        });
    });

    describe("YAML 候选", () => {
        it("yamlActionCandidates:node 片段含 '- node:' 与键缩进", () => {
            const items = core.yamlActionCandidates("no", "      ");
            const node = items.find(i => i.label === "node");
            assert.ok(node);
            assert.ok(node!.insert.includes("- node:\n"));
            assert.ok(node!.insert.includes("pkg: "));
        });
        it("yamlKeyCandidates:node 含 pkg/exec;include 含 file", () => {
            const nodeKeys = core.yamlKeyCandidates("node", "");
            assert.ok(nodeKeys.some(k => k.label === "pkg"));
            assert.ok(nodeKeys.some(k => k.label === "exec"));
            const incKeys = core.yamlKeyCandidates("include", "");
            assert.ok(incKeys.some(k => k.label === "file"));
        });
    });

    // ---------- 包名候选 ----------

    describe("包名候选", () => {
        it("pkgValueCandidates:逐名生成 value 项", () => {
            const items = core.pkgValueCandidates(["a_pkg", "b_pkg"]);
            assert.strictEqual(items.length, 2);
            assert.ok(items.every(i => i.kind === "value"));
            assert.strictEqual(items[0].label, "a_pkg");
        });
    });

    // ---------- 静态 snippet 全量转制(2026-09-07,防功能丢失) ----------

    describe("转制完整性(原 snippets/launch-py|xml.json 内容全量入目录)", () => {
        it("py:整文件模板(ros2launch)仍可达——原前缀命中", () => {
            const items = core.pyStructureCandidates("ros2launch");
            const tpl = items.find(i => i.label.includes("file template"));
            assert.ok(tpl, "launch.py 整文件模板应存在");
            assert.ok(tpl!.insert.includes("def generate_launch_description"));
        });

        it("py:Node 变体(简单/重映射)与标识符命中不冲突", () => {
            const items = core.pyStructureCandidates("Nod");
            assert.ok(items.some(i => i.label === "Node"));
            assert.ok(items.some(i => i.label.includes("(simple)")));
            assert.ok(items.some(i => i.label.includes("(remapping)")));
        });

        it("xml:附加片段含整文件模板(带声明)与变体", () => {
            const extras = core.xmlExtraCandidates("");
            assert.ok(extras.some(i => i.label.includes("XML file template")));
            assert.ok(extras.some(i => i.label.includes("with namespace")));
            assert.ok(extras.some(i => i.label.includes("(block)")));
            assert.ok(extras.some(i => i.label.includes("no default")));
            assert.ok(extras.some(i => i.label.includes("with child args")));
        });

        it("xml:替换项可单取且 label 前缀 $(", () => {
            const subs = core.xmlSubstCandidates();
            assert.ok(subs.length >= 3);
            assert.ok(subs.some(i => i.label.startsWith("$(var")));
            assert.ok(subs.some(i => i.label.startsWith("$(env")));
            assert.ok(subs.some(i => i.label.startsWith("$(find-pkg-share")));
        });

        it("xml:旧 prefix 记忆词命中(ros2findpkg / ros2paramfile)", () => {
            assert.ok(core.xmlExtraCandidates("ros2findpkg").some(i => i.label.startsWith("$(find-pkg-share")));
            assert.ok(core.xmlExtraCandidates("ros2paramfile").some(i => i.label.includes("YAML")));
        });

        it("filterText 纯 ASCII(中文只留 label,不进过滤)", () => {
            const all = [
                ...core.pyStructureCandidates(""),
                ...core.xmlExtraCandidates(""),
                ...core.xmlSubstCandidates()
            ];
            assert.ok(all.length > 0);
            const ascii = /^[\x20-\x7E]*$/;
            for (const c of all) {
                assert.ok(c.filter !== undefined && ascii.test(c.filter),
                    `filter 应纯 ASCII:${c.label} → ${c.filter}`);
                assert.ok((c.filter ?? "").length > 0);
            }
        });

        it("filterText 覆盖结构头部主词(2026-09-08 规则)", () => {
            const pyNode = core.pyStructureCandidates("").find(i => i.label === "Node")!;
            assert.ok(pyNode.filter?.includes("package"), "Node 片段 filter 应含结构头部词 package");
            const paramFrom = core.xmlExtraCandidates("").find(i => i.label.includes("YAML"))!;
            assert.ok(paramFrom.filter?.includes("from"), "param(from) 片段 filter 应含头部词 from");
        });
    });
});


describe("launch 补全 LC 批次(2026-09-27,对标 xacro)", () => {
    // ---------- LC-1 声明提取 ----------

    it("LC-1 declaredArgsPy:名字 + default_value + 掩码注释", () => {
        const text = [
            "import launch",
            "# DeclareLaunchArgument('ghost') 注释里的不算",
            "def g():",
            "    return launch.LaunchDescription([",
            "        DeclareLaunchArgument('use_sim', default_value='false'),",
            "        DeclareLaunchArgument('world'),",
            "    ])",
        ].join("\n");
        const decls = declaredArgsPy(text);
        assert.deepStrictEqual(decls.map(d => d.name), ["use_sim", "world"]);
        assert.strictEqual(decls[0].default, "false");
        assert.strictEqual(decls[1].default, undefined);
        // 名字 offset 指向文档中的名字首字符
        for (const d of decls) {
            assert.strictEqual(text.slice(d.declOffset, d.declOffset + d.name.length), d.name);
        }
    });

    it("LC-1 declaredArgsXml:lezer 属性序无关 + default/value", () => {
        const text = '<launch><arg name="a" default="1"/><arg default="2" name="b"/><arg name="c" value="3"/></launch>';
        const decls = declaredArgsXml(text);
        assert.deepStrictEqual(decls.map(d => d.name), ["a", "b", "c"]);
        assert.strictEqual(decls[0].default, "1");
        assert.strictEqual(decls[1].default, "2");
        assert.strictEqual(decls[2].default, "3");
        assert.ok(decls.every(d => text.slice(d.declOffset, d.declOffset + d.name.length) === d.name));
    });

    it("LC-1 declaredArgsYaml:- arg: 块 name/default", () => {
        const text = [
            "launch:",
            "  - arg:",
            "      name: sim",
            "      default: \"false\"",
            "  - arg:",
            "      name: world",
            "  - node:",
            "      pkg: \"x\""
        ].join("\n");
        const decls = declaredArgsYaml(text);
        assert.deepStrictEqual(decls.map(d => d.name).sort(), ["sim", "world"]);
        const sim = decls.find(d => d.name === "sim")!;
        assert.strictEqual(sim.default, "false");
    });

    // ---------- LC-2 参数引用 ----------

    it("LC-2 argRefCandidates:必传/默认 detail 与声明行 doc", () => {
        const items = core.argRefCandidates([
            { name: "sim", default: "false", declLineText: "DeclareLaunchArgument('sim', default_value='false')" },
            { name: "world" }
        ]);
        assert.strictEqual(items[0].detail, "launch 参数(默认 false)");
        assert.strictEqual(items[1].detail, "launch 参数(必传)");
        assert.ok(items[0].doc && items[0].doc.includes("DeclareLaunchArgument"));
        assert.ok(items.every(i => i.sort === "1_arg"), "参数应排在包名(sort 2)之前");
    });

    it("LC-2 xmlValueSource:$(var 参数位与 $() 命令位;file 规则优先", () => {
        assert.strictEqual(core.xmlValueSource("value", "$(var ").source, "arg-ref");
        assert.strictEqual(core.xmlValueSource("value", "$(var si").source, "arg-ref");
        const cmd = core.xmlValueSource("value", "$(")!;
        assert.strictEqual(cmd.source, "subst-cmd");
        assert.strictEqual((cmd as { prefix: string }).prefix, "");
        const cmd2 = core.xmlValueSource("value", "$(find-")!;
        assert.strictEqual(cmd2.source, "subst-cmd");
        assert.strictEqual((cmd2 as { prefix: string }).prefix, "find-");
        // file 的 find-pkg-share 规则先于命令位
        assert.strictEqual(core.xmlValueSource("file", "$(find-pkg-share ").source, "pkg");
        // 已闭合的 $() 不再是任何位
        assert.strictEqual(core.xmlValueSource("value", "$(var x)tail"), undefined);
    });

    it("LC-2 yamlValueSource:$(var 参数位/$() 命令位/output/bool", () => {
        assert.strictEqual(core.yamlValueSource("value", "$(var ").source, "arg-ref");
        assert.strictEqual(core.yamlValueSource("value", "$(")!.source, "subst-cmd");
        assert.strictEqual(core.yamlValueSource("output", "").source, "output");
        assert.strictEqual(core.yamlValueSource("respawn", "").source, "bool");
        assert.strictEqual(core.yamlValueSource("exec", "").source, "exec");
    });

    it("LC-2 pyValueSource:output/respawn 枚举源", () => {
        assert.strictEqual(core.pyValueSource("output"), "output");
        assert.strictEqual(core.pyValueSource("respawn"), "bool");
    });

    // ---------- LC-3 $() 命令目录 ----------

    it("LC-3 substCommandCandidates:23 命令(LJ-10a Humble 全集)/前缀过滤/插入带尾空格", () => {
        const all = core.substCommandCandidates("");
        assert.strictEqual(all.length, 23);
        assert.ok(all.every(i => i.insert.endsWith(" ")));
        const v = core.substCommandCandidates("v");
        assert.deepStrictEqual(v.map(i => i.label), ["var"]);
        const f = core.substCommandCandidates("find");
        assert.deepStrictEqual(f.map(i => i.label).sort(), ["find-exec", "find-pkg-prefix", "find-pkg-share"]);
        // LJ-10a:ROS1 残留伪项清除(Humble 注册表无此三名)
        assert.ok(!all.some(i => i.label === "optenv" || i.label === "cwd" || i.label === "find"));
    });

    it("LC-3 substCommandPrefixAt / inVarArgPosition 门控判定", () => {
        assert.strictEqual(core.substCommandPrefixAt("$("), "");
        assert.strictEqual(core.substCommandPrefixAt("$(find-"), "find-");
        assert.strictEqual(core.substCommandPrefixAt("$(var "), undefined, "带命令转参数位");
        assert.strictEqual(core.substCommandPrefixAt("$(var x)"), undefined, "已闭合");
        assert.strictEqual(core.inVarArgPosition("$(var "), true);
        assert.strictEqual(core.inVarArgPosition("$(var na"), true);
        assert.strictEqual(core.inVarArgPosition("$(env "), false);
    });

    // ---------- LD-2 尾段 $() 判定与 py 枚举复活(2026-09-30) ----------

    it("LD-2 尾段口径:值中后续 $() 可识别(前段已闭合不影响)", () => {
        assert.strictEqual(core.substCommandPrefixAt("$(find-pkg-share a)/x/$(f"), "f");
        assert.strictEqual(core.substCommandPrefixAt("$(find-pkg-share a)/x/$(var "), undefined, "尾段带命令转参数位");
        assert.strictEqual(core.inVarArgPosition("$(find-pkg-share a)/launch/$(var "), true);
        assert.strictEqual(core.inVarArgPosition("$(find-pkg-share a)/launch/$(var use_si"), true);
        assert.strictEqual(core.varArgTypedWordAt("$(find-pkg-share a)/launch/$(var use_si"), "use_si");
        assert.strictEqual(core.varArgTypedWordAt("$(var "), "");
        assert.strictEqual(core.varArgTypedWordAt("$(var x)"), undefined, "已闭合");
        assert.strictEqual(core.varArgTypedWordAt("$(env x"), undefined, "非 var 命令");
    });

    it("LD-2 xmlValueSource/yamlValueSource:arg-ref 携带 typed(已敲词)", () => {
        assert.deepStrictEqual(
            core.xmlValueSource("value", "$(find-pkg-share a)/x/$(var si"),
            { source: "arg-ref", typed: "si" }
        );
        assert.deepStrictEqual(core.xmlValueSource("value", "$(var "), { source: "arg-ref", typed: "" });
        assert.strictEqual(core.xmlValueSource("value", "$(find a)/$(f")?.source, "subst-cmd");
        assert.deepStrictEqual(
            core.yamlValueSource("value", "$(find a)/x/$(var si"),
            { source: "arg-ref", typed: "si" }
        );
    });

    it("LD-2 pyAttrContextAt:output/respawn 值位(LC-7 py 死路复活)", () => {
        const t1 = "Node(\n    package='demo_pkg',\n    output='sc";
        assert.strictEqual(core.pyAttrContextAt(t1, t1.length)?.attr, "output");
        const t2 = "Node(\n    package='demo_pkg',\n    respawn='Tr";
        assert.strictEqual(core.pyAttrContextAt(t2, t2.length)?.attr, "respawn");
        // 已闭合的 output 不误判
        const t3 = "Node(\n    package='demo_pkg',\n    output='screen',\n)";
        const off3 = t3.indexOf("output='screen'") + "output='screen'".length;
        assert.strictEqual(core.pyAttrContextAt(t3, off3), undefined);
    });

    // ---------- LC-6 py kwarg ----------

    it("LC-6 pyKwargNameContextAt:名位/排除已键入/值位排除", () => {
        const text = "Node(\n    package='demo',\n    na";
        const offset = text.length;
        const ctx = core.pyKwargNameContextAt(text, offset)!;
        assert.strictEqual(ctx.call, "Node");
        assert.strictEqual(ctx.prefix, "na");
        assert.ok(ctx.exclude.has("package"), "已键入 kwarg 应排除");
        // 值位不干扰
        const text2 = "Node(\n    executable='de";
        assert.strictEqual(core.pyKwargNameContextAt(text2, text2.length), undefined);
    });

    it("LC-6 pyKwargCandidates:目录/前缀/排除", () => {
        const items = core.pyKwargCandidates("Node", "", new Set(["package", "executable"]));
        assert.ok(!items.some(i => i.label === "package"));
        assert.ok(items.some(i => i.label === "parameters"));
        const p = core.pyKwargCandidates("Node", "na", new Set());
        assert.deepStrictEqual(p.map(i => i.label), ["name", "namespace"]);
    });

    // ---------- LC-7 枚举 / LC-8 超集 ----------

    it("LC-7 enumValueCandidates", () => {
        const items = core.enumValueCandidates(["screen", "log"], "output 取值");
        assert.deepStrictEqual(items.map(i => i.label), ["screen", "log"]);
        assert.ok(items.every(i => i.detail === "output 取值"));
    });

    it("LC-8 snippetFilterText 超集:符号头保留(`<node pkg=` 可命中)", () => {
        const f = core.snippetFilterText('<node pkg="${1:package_name}" exec="${2:executable_name}" />', "node", ["node"]);
        assert.ok(f.includes("<node pkg="), `filter 应含符号头(实际 ${f})`);
        assert.ok(f.includes("node"));
        // 全 ASCII(既有清洁护栏同口径)
        assert.ok(/^[ -~]*$/.test(f));
    });

    // ---------- LF-0 值扫描器(yaml 双路 + py 字符串) ----------

    describe("parseYamlScalarValue(yaml 双路解析)", () => {
        const p = (line: string, from: number) => core.parseYamlScalarValue(line, from);

        it("双引号:内嵌单引号自然支持,区间含引号", () => {
            const line = '      pkg: "it\'s ok"';
            const s = p(line, 10)!;
            assert.strictEqual(s.kind, "double");
            assert.strictEqual(s.value, "it's ok");
            assert.strictEqual(line.slice(s.contentStart, s.contentEnd), "it's ok");
            assert.strictEqual(line.slice(s.nodeStart, s.nodeEnd), '"it\'s ok"');
        });

        it("双引号:转义 \\\" \\\\ 还原", () => {
            const line = 'exec: "a\\\\b\\"c"';
            const s = p(line, 6)!;
            assert.strictEqual(s.value, 'a\\b"c');
        });

        it("单引号:'' doubling 还原 + 内嵌双引号", () => {
            const line = "pkg: 'it''s \"x\"'";
            const s = p(line, 5)!;
            assert.strictEqual(s.kind, "single");
            assert.strictEqual(s.value, 'it\'s "x"');
        });

        it("裸:中间空格保留、首尾 trim、# 注释截断", () => {
            const line = "exec:   hello  world   # 说明";
            const s = p(line, 5)!;
            assert.strictEqual(s.kind, "bare");
            assert.strictEqual(s.value, "hello  world");
            assert.strictEqual(line.slice(s.contentStart, s.contentEnd), "hello  world");
        });

        it("引号内前导空格严谨保留(值=含空格)", () => {
            const line = 'pkg: " p10_mix_deps_std"';
            const s = p(line, 5)!;
            assert.strictEqual(s.value, " p10_mix_deps_std");
        });

        it("未闭合/纯注释/空 → undefined", () => {
            assert.strictEqual(p('pkg: "abc', 5), undefined);
            assert.strictEqual(p("pkg: # c", 5), undefined);
            assert.strictEqual(p("pkg:   ", 5), undefined);
        });
    });

    describe("parsePyString(py 字符串扫描)", () => {
        const p = (text: string, from: number) => parsePyString(text, from);

        it("双引号转义:\\\" \\\\ 还原,区间不含引号", () => {
            const text = 'Node(package="a\\\\b\\"c")';
            const s = p(text, text.indexOf('"'))!;
            assert.strictEqual(s.quote, '"');
            assert.strictEqual(s.value, 'a\\b"c');
            // 内容切片 = 原样字符(含转义反斜杠),还原值才走 s.value
            assert.strictEqual(text.slice(s.contentStart, s.contentEnd), 'a\\\\b\\"c');
        });

        it("三引号:内含换行与单引号", () => {
            const text = 'Node(package="""p10\nnested \'" q""")';
            const s = p(text, text.indexOf('"'))!;
            assert.strictEqual(s.quote, '"""');
            assert.ok(s.value.includes("\nnested"));
            assert.strictEqual(text.slice(s.contentStart, s.contentEnd), "p10\nnested '\" q");
        });

        it("r-string:无转义处理", () => {
            const text = "Node(executable=r'a\\\\b')";
            const s = p(text, text.indexOf("r'"))!;
            assert.strictEqual(s.raw, true);
            assert.strictEqual(s.value, "a\\\\b");
        });

        it("续行消隐:反斜杠+换行(python 语义保留续行后缩进)", () => {
            const text = "Node(package='a\\\n   b')";
            const s = p(text, text.indexOf("'"))!;
            assert.strictEqual(s.value, "a   b");
        });

        it("未闭合 → undefined", () => {
            assert.strictEqual(p('Node(package="abc)', 13), undefined);
        });
    });

    describe("parsePyStringConcatenation(LI 相邻字面量拼接)", () => {
        const c = (text: string, from: number) => parsePyStringConcatenation(text, from);
        const p = (text: string, from: number) => parsePyString(text, from);

        it("用户实例:双引号 + 续行 + 缩进相邻 → 合并为完整包名", () => {
            const text = [
                'Node(',
                '    package="p10_mix_de" \\',
                '    "ps_std",',
                '    executable="py_listener.py"',
                ')'
            ].join("\n");
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 1);
            assert.strictEqual(refs[0].package, "p10_mix_deps_std");
            assert.strictEqual(refs[0].executable, "py_listener.py");
            // 拼接函数本身:值合并,区间跨全片段
            const s = c(text, text.indexOf('"'))!;
            assert.strictEqual(s.value, "p10_mix_deps_std");
            assert.strictEqual(text.slice(s.contentStart, s.contentEnd), "p10_mix_de\" \\\n    \"ps_std");
        });

        it("拼接:跨注释与多行,值依次合并", () => {
            const text = 'Node(package="a" # c\n "b" \'c\')';
            const s = c(text, text.indexOf('"'))!;
            assert.strictEqual(s.value, "abc");
        });

        it("拼接在非字符串 token 处停止(不做表达式求值)", () => {
            const text = 'Node(package="a" some_var)';
            const s = c(text, text.indexOf('"'))!;
            assert.strictEqual(s.value, "a");
        });

        it("拼接 + 转义片段共存", () => {
            const text = 'Node(package="a\\\\b" "c")';
            const s = c(text, text.indexOf('"'))!;
            // 片段1 "a\\\\b" 转义还原为 a\b,拼接片段2 c
            assert.strictEqual(s.value, "a\\b" + "c");
        });

        it("单字符串场景与 parsePyString 一致", () => {
            const text = 'Node(package="only")';
            const s = c(text, text.indexOf('"'))!;
            assert.strictEqual(s.value, "only");
            assert.strictEqual(p(text, text.indexOf('"'))!.value, "only");
        });
    });
});
