/**
 * launch 补全 LJ 头测(2026-10-01,结构/子列表/join 路径;纯 core,可无头跑)
 *
 * 覆盖:
 *  - LJ-1 XML/YAML 目录对齐官方 Humble frontend parse(属性集/子标签集/新动作);
 *  - LJ-2 YAML 子列表光标态(listKey/listValue)、yamlIncludeFileValue、yamlValueSource path;
 *  - LJ-4 pyJoinPathContextAt / pyKwargListContextAt / parsePyStringOpen。
 */
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

import * as assert from "assert";
import * as core from "../../src/languages/launch/core/launch-completion-core";
import { parsePyString, parsePyStringOpen } from "../../src/languages/launch/parse/launch-py-parser";

describe("launch-completion LJ(2026-10-01 结构/子列表/join 路径)", () => {

    // ---------- LJ-1 XML 目录对齐官方 ----------

    describe("LJ-1 XML 目录", () => {
        it("node 属性全集含 ros_args/exec_name/respawn_delay/emulate_tty/shell/on_exit", () => {
            const names = core.xmlAttrCandidates("node", "").map(c => c.label);
            for (const k of ["ros_args", "exec_name", "respawn_delay", "emulate_tty", "shell", "on_exit"]) {
                assert.ok(names.includes(k), `node 应含 ${k}:${JSON.stringify(names)}`);
            }
        });
        it("executable 属性全集(cmd + 进程属性)", () => {
            const names = core.xmlAttrCandidates("executable", "").map(c => c.label);
            for (const k of ["cmd", "cwd", "respawn", "launch-prefix", "emulate_tty"]) {
                assert.ok(names.includes(k), `executable 应含 ${k}:${JSON.stringify(names)}`);
            }
        });
        it("arg 无 value 属性(官方=name/default/description+choice 子标签)", () => {
            const names = core.xmlAttrCandidates("arg", "").map(c => c.label);
            assert.ok(!names.includes("value"), "arg 不应有 value 属性");
            assert.ok(names.includes("description"));
        });
        it("launch/group 子标签含 timer/set_parameter/set_remap/set_use_sim_time;group 另有 keep", () => {
            const launchKids = core.xmlChildCandidates("launch", "").map(c => c.label);
            for (const t of ["timer", "set_parameter", "set_remap", "set_use_sim_time"]) {
                assert.ok(launchKids.includes(t), `launch 应含 ${t}`);
            }
            const groupKids = core.xmlChildCandidates("group", "").map(c => c.label);
            assert.ok(groupKids.includes("keep"), "group 应含 keep");
        });
        it("arg 子标签 = choice;param 子标签 = param(嵌套);node 子标签含 env", () => {
            assert.deepStrictEqual(core.xmlChildCandidates("arg", "").map(c => c.label), ["choice"]);
            assert.deepStrictEqual(core.xmlChildCandidates("param", "").map(c => c.label), ["param"]);
            assert.ok(core.xmlChildCandidates("node", "").map(c => c.label).includes("env"));
        });
        it("group 属性 scoped/forwarding;timer 属性 period/cancel_on_shutdown", () => {
            assert.ok(core.xmlAttrCandidates("group", "").map(c => c.label).includes("scoped"));
            const timer = core.xmlAttrCandidates("timer", "").map(c => c.label);
            assert.ok(timer.includes("period") && timer.includes("cancel_on_shutdown"));
        });
    });

    // ---------- LJ-1 YAML 动作目录 ----------

    describe("LJ-1 YAML 目录", () => {
        it("新动作 push_ros_namespace/timer/set_parameter/set_remap/set_use_sim_time", () => {
            for (const a of ["push_ros_namespace", "timer", "set_parameter", "set_remap", "set_use_sim_time"]) {
                assert.ok(core.yamlActionCandidates(a.slice(0, 5), "  ").some(c => c.label === a), `应有动作 ${a}`);
            }
        });
        it("node 键全集含 ros_args/respawn_delay/env/launch-prefix;execute_process 键扩充", () => {
            const nodeKeys = core.yamlKeyCandidates("node", "").map(c => c.label);
            for (const k of ["ros_args", "respawn_delay", "env", "launch-prefix", "emulate_tty", "on_exit"]) {
                assert.ok(nodeKeys.includes(k), `node 应含 ${k}`);
            }
            const epKeys = core.yamlKeyCandidates("execute_process", "").map(c => c.label);
            assert.ok(epKeys.includes("env") && epKeys.includes("respawn"));
        });
        it("group 键 scoped/forwarding/keep;arg 键含 choice", () => {
            assert.ok(core.yamlKeyCandidates("group", "").map(c => c.label).includes("scoped"));
            assert.ok(core.yamlKeyCandidates("arg", "").map(c => c.label).includes("choice"));
        });
    });

    // ---------- LJ-2 YAML 子列表 ----------

    describe("LJ-2 YAML 子列表光标态", () => {
        const doc = [
            "launch:",
            "  - node:",
            '      pkg: "demo_pkg"',
            "      remap:",
            "        - from: \"/in\"",
            "          to: \"/out\"",
            ""
        ].join("\n");

        it("remap 下空行 → listKey(待 - 整项片段位)", () => {
            // 空行须带目标缩进(VS Code 自动缩进口径);裸空行(indent 0)按顶层处理
            const text = doc.replace(/\n$/, "") + "\n        ";
            const c = core.yamlCursorAt(text, text.length);
            assert.ok(c && c.kind === "listKey", `应为 listKey:${c && c.kind}`);
            if (c && c.kind === "listKey") {
                assert.strictEqual(c.parentKey, "remap");
                assert.strictEqual(c.dashTyped, false);
                assert.strictEqual(c.action, "node");
            }
        });
        it("remap 下已敲 '- ' → listKey(dashTyped);整项片段按 dashTyped 定 '- ' 前缀", () => {
            const text = doc + "        - ";
            const c = core.yamlCursorAt(text, text.length);
            assert.ok(c && c.kind === "listKey" && c.dashTyped === true);
            const items = core.yamlListItemCandidates("remap", "", " ".repeat(10), true);
            assert.strictEqual(items.length, 1);
            assert.ok(items[0].insert.startsWith("from:"), `应无 "- " 前缀:${items[0].insert}`);
            const itemsNew = core.yamlListItemCandidates("remap", "", " ".repeat(10), false);
            assert.ok(itemsNew[0].insert.startsWith("- from:"), `应带 "- " 前缀:${itemsNew[0].insert}`);
        });
        it("子项键前缀 → 子键候选;- 键: 值 → listValue", () => {
            const keys = core.yamlListItemCandidates("param", "na", " ".repeat(10), true).map(c => c.label);
            assert.ok(keys.includes("name"), `应含 name:${JSON.stringify(keys)}`);
            const text = doc + "        - from: \"x";
            const c = core.yamlCursorAt(text, text.length);
            assert.ok(c && c.kind === "listValue", `应为 listValue:${c && c.kind}`);
            if (c && c.kind === "listValue") {
                assert.strictEqual(c.key, "from");
                assert.strictEqual(c.parentKey, "remap");
                assert.strictEqual(c.valuePrefix, "x");
            }
        });
        it("include 下 arg 子项 name 值位 → listValue 且 action=include", () => {
            const text = [
                "launch:",
                "  - include:",
                '    file: "sub.launch.xml"',
                "    arg:",
                '      - name: "us'
            ].join("\n");
            const c = core.yamlCursorAt(text, text.length);
            assert.ok(c && c.kind === "listValue");
            if (c && c.kind === "listValue") {
                assert.strictEqual(c.parentKey, "arg");
                assert.strictEqual(c.action, "include");
                assert.strictEqual(c.key, "name");
            }
        });
        it("顶层 '- ' 仍为 action(不被列表语境吞)", () => {
            const text = "launch:\n  - ";
            const c = core.yamlCursorAt(text, text.length);
            assert.ok(c && c.kind === "action", `应为 action:${c && c.kind}`);
        });
        it("子项续行(无 -)值位回落普通 value(key/to 类无源 → undefined)", () => {
            const text = "launch:\n  - node:\n      pkg: p\n      remap:\n        - from: \"/a\"\n          to: \"/o";
            const c = core.yamlCursorAt(text, text.length);
            assert.ok(c && c.kind === "value", `应为 value:${c && c.kind}`);
        });
    });

    describe("LJ-2 yamlIncludeFileValue", () => {
        const block = [
            "  - include:",
            '    file: "sub.launch.xml"',
            "    arg:",
            '      - name: "one"',
            '        value: "1"',
            '      - name: "'
        ].join("\n");
        it("第二个兄弟子项向上仍找到 file(跳过 - name:/value: 行)", () => {
            const lineStart = block.lastIndexOf("\n") + 1;
            assert.strictEqual(core.yamlIncludeFileValue(block, lineStart), "sub.launch.xml");
        });
        it("非 include 块 → undefined(动作行边界)", () => {
            const text = "  - node:\n    pkg: x\n    param:\n      - name: \"p";
            const lineStart = text.lastIndexOf("\n") + 1;
            assert.strictEqual(core.yamlIncludeFileValue(text, lineStart), undefined);
        });
    });

    describe("LJ-2 yamlValueSource path", () => {
        it("file 已闭合前缀 → path 源(带原值)", () => {
            const v = core.yamlValueSource("file", "$(find-pkg-share demo_pkg)/laun");
            assert.ok(v && v.source === "path");
        });
        it("file: 空值 → path 源(根层列目录)", () => {
            const v = core.yamlValueSource("file", "");
            assert.ok(v && v.source === "path" && v.prefix === "");
        });
        it("file 未闭合 $( → 非 path(保 pkg 原逻辑)", () => {
            assert.ok(core.yamlValueSource("file", "$(find-pkg-share ")!.source === "pkg");
            assert.strictEqual(core.yamlValueSource("file", "$(find-pkg-share de"), undefined);
        });
        it("非 file 键不受影响(pkg/exec/arg-ref 照旧)", () => {
            assert.ok(core.yamlValueSource("pkg", "")!.source === "pkg");
            assert.ok(core.yamlValueSource("exec", "")!.source === "exec");
            assert.ok(core.yamlValueSource("args", "$(var ")!.source === "arg-ref");
        });
    });

    // ---------- LJ-4 py join 路径 / 列表项 ----------

    describe("LJ-4 pyJoinPathContextAt", () => {
        it("末段未闭合引号 → 当前词", () => {
            const text = "os.path.join(get_package_share_directory('demo_pkg'), 'launch', 'fi";
            const c = core.pyJoinPathContextAt(text, text.length);
            assert.ok(c);
            assert.strictEqual(c!.pkg, "demo_pkg");
            assert.deepStrictEqual(c!.segments, ["launch"]);
            assert.strictEqual(c!.word, "fi");
        });
        it("逗号后空态 → word 空", () => {
            const text = "os.path.join(get_package_share_directory('p'), ";
            const c = core.pyJoinPathContextAt(text, text.length);
            assert.ok(c && c.word === "" && c.segments.length === 0);
        });
        it("闭合引号紧贴光标 → 并入完成段(空态)", () => {
            const text = "os.path.join(get_package_share_directory('p'), 'launch'";
            const c = core.pyJoinPathContextAt(text, text.length);
            assert.ok(c);
            assert.deepStrictEqual(c!.segments, ["launch"]);
            assert.strictEqual(c!.word, "");
        });
        it("变量混入 → undefined(静态口径)", () => {
            const text = "os.path.join(get_package_share_directory('p'), some_var)";
            assert.strictEqual(core.pyJoinPathContextAt(text, text.length), undefined);
        });
        it("首参非 gpsd → undefined;光标在 gpsd 串内 → undefined(归属性值补全)", () => {
            assert.strictEqual(core.pyJoinPathContextAt("os.path.join('a', 'b", 20), undefined);
            const t2 = "os.path.join(get_package_share_directory('de";
            assert.strictEqual(core.pyJoinPathContextAt(t2, t2.length), undefined);
        });
    });

    describe("LJ-4 py 列表项与 parsePyStringOpen", () => {
        it("pyKwargListContextAt:remappings/parameters", () => {
            const t1 = "Node(package='p', executable='e', remappings=[";
            assert.strictEqual(core.pyKwargListContextAt(t1, t1.length), "remappings");
            const t2 = "Node(parameters=[('a', 1), ";
            assert.strictEqual(core.pyKwargListContextAt(t2, t2.length), "parameters");
            const t3 = "Node(package='p', executable='e')";
            assert.strictEqual(core.pyKwargListContextAt(t3, t3.length), undefined);
        });
        it("pyListSnippetCandidates 两类片段", () => {
            assert.ok(core.pyListSnippetCandidates("remappings")[0].insert.includes("from_topic"));
            assert.ok(core.pyListSnippetCandidates("parameters").some(c => c.insert.includes("params.yaml")));
        });
        it("parsePyStringOpen:未闭合容错到末尾(闭合同 parsePyString)", () => {
            const text = "os.path.join('launch', 'fi";
            const cur = parsePyStringOpen(text, text.lastIndexOf("'"))!;
            assert.ok(cur);
            assert.strictEqual(cur.value, "fi");
            assert.strictEqual(cur.nodeEnd, text.length);
            assert.strictEqual(parsePyString(text, text.lastIndexOf("'")), undefined);
            const closed = parsePyStringOpen("'ok'", 0)!;
            assert.strictEqual(closed.value, "ok");
            assert.strictEqual(closed.nodeEnd, 4);
        });
    });

describe("launch-completion LJ-6(2026-10-01 残差动作全集 + 序无关)", () => {

    describe("LJ-6 XML 目录残差", () => {
        it("新标签全集在 launch/group 子标签与片段目录中", () => {
            const kids = core.xmlChildCandidates("launch", "").map(c => c.label);
            for (const t of ["log", "append_env", "unset_env", "reset_env", "reset", "shutdown",
                "ros_timer", "set_parameters_from_file", "node_container", "load_composable_node"]) {
                assert.ok(kids.includes(t), `launch 应含 ${t}:${JSON.stringify(kids)}`);
            }
        });
        it("node_container 属性 = node 全集;load_composable_node = target;log = message", () => {
            assert.ok(core.xmlAttrCandidates("node_container", "").map(c => c.label).includes("pkg"));
            assert.ok(core.xmlAttrCandidates("load_composable_node", "").map(c => c.label).includes("target"));
            assert.ok(core.xmlAttrCandidates("log", "").map(c => c.label).includes("message"));
            assert.ok(core.xmlAttrCandidates("append_env", "").map(c => c.label).includes("separator"));
        });
        it("子实体:executable+env/timer+node/node_container+composable_node/composable_node+extra_arg", () => {
            assert.ok(core.xmlChildCandidates("executable", "").map(c => c.label).includes("env"));
            assert.ok(core.xmlChildCandidates("timer", "").map(c => c.label).includes("node"));
            assert.ok(core.xmlChildCandidates("node_container", "").map(c => c.label).includes("composable_node"));
            const cn = core.xmlChildCandidates("composable_node", "").map(c => c.label);
            assert.ok(cn.includes("param") && cn.includes("remap") && cn.includes("extra_arg"));
        });
        it("composable_node 属性含 plugin;片段目录含新标签", () => {
            assert.ok(core.xmlAttrCandidates("composable_node", "").map(c => c.label).includes("plugin"));
            assert.ok(core.xmlChildCandidates("launch", "").some(c => c.label === "node_container"));
        });
    });

    describe("LJ-6 YAML 目录残差", () => {
        it("新动作候选:append_env/unset_env/reset_env/log/shutdown/reset/ros_timer/set_parameters_from_file/node_container/load_composable_node", () => {
            for (const a of ["append_env", "unset_env", "reset_env", "log", "shutdown", "reset",
                "ros_timer", "set_parameters_from_file", "node_container", "load_composable_node"]) {
                assert.ok(core.yamlActionCandidates(a.slice(0, 4), "  ").some(c => c.label === a), `应有动作 ${a}`);
            }
        });
        it("node_container 键含 composable_node;load_composable_node 键 target;composable_node 子项目录", () => {
            assert.ok(core.yamlKeyCandidates("node_container", "").map(c => c.label).includes("composable_node"));
            assert.ok(core.yamlKeyCandidates("load_composable_node", "").map(c => c.label).includes("target"));
            const cn = core.yamlListItemCandidates("composable_node", "", " ".repeat(10), true);
            assert.ok(cn.length > 0, "composable_node 应有子项目录");
        });
        it("filename 值源 → params-path;变量混入排除", () => {
            assert.ok(core.yamlValueSource("filename", "")!.source === "params-path");
            assert.ok(core.yamlValueSource("filename", "config/p")!.source === "params-path");
            assert.strictEqual(core.yamlValueSource("filename", "$(find-pkg-share "), undefined);
        });
    });

    describe("LJ-6 PY 残差", () => {
        it("结构片段命中新动作", () => {
            for (const [prefix, label] of [["Log", "LogInfo"], ["Shutdown", "Shutdown"], ["Timer", "TimerAction"],
                ["SetParametersFrom", "SetParametersFromFile"], ["LoadComposable", "LoadComposableNodes"]]) {
                assert.ok(core.pyStructureCandidates(prefix).some(c => c.label === label), `${prefix} 应命中 ${label}`);
            }
        });
        it("kwarg 目录:LogInfo.msg/TimerAction.period/SetParametersFromFile.filename", () => {
            const log = core.pyKwargCandidates("LogInfo", "", new Set()).map(c => c.label);
            assert.ok(log.includes("msg"));
            assert.ok(core.pyKwargCandidates("TimerAction", "", new Set()).map(c => c.label).includes("period"));
            assert.ok(core.pyKwargCandidates("SetParametersFromFile", "", new Set()).map(c => c.label).includes("filename"));
        });
        it("pyValueSource filename → params-path", () => {
            assert.strictEqual(core.pyValueSource("filename"), "params-path");
        });
    });

    describe("LJ-6 序无关识别(三通道)", () => {
        it("xml:exec 在前 pkg 在后 → pkg 上下文命中", () => {
            const text = '<node exec="talker" pkg="demo_pkg" name="n"/>';
            const offset = text.indexOf('"talker') + 3; // exec 值内
            assert.strictEqual(core.xmlTagAttrBefore(text, offset, "pkg"), "demo_pkg");
            const text2 = '<node pkg="a" exec="b"/>';
            const offsetInExec = text2.indexOf('"b"') + 1; // exec 值内
            assert.strictEqual(core.xmlTagAttrBefore(text2, offsetInExec, "pkg"), "a", "原有向前口径不回归");
        });
        it("yaml:exec 在前 pkg 在后 → 兄弟键向下命中", () => {
            const text = "launch:\n  - node:\n      exec: \"t\"\n      pkg: \"p\"\n";
            const execLineStart = text.indexOf("      exec:");
            assert.strictEqual(core.yamlSiblingKeyValue(text, execLineStart, "pkg"), "p");
            const text2 = "launch:\n  - node:\n      pkg: \"p\"\n      exec: \"t\"\n";
            assert.strictEqual(core.yamlSiblingKeyValue(text2, text2.indexOf("      exec:"), "pkg"), "p", "向上口径不回归");
        });
        it("yaml:块界止步(下一个兄弟动作不出块乱命中)", () => {
            const text = "launch:\n  - node:\n      exec: \"t\"\n  - node:\n      pkg: \"other\"\n";
            const execLineStart = text.indexOf("      exec:");
            assert.strictEqual(core.yamlSiblingKeyValue(text, execLineStart, "pkg"), undefined);
        });
        it("py:executable 在前 package 在后 → 整调用段命中", () => {
            const text = "Node(executable='talker', package='demo_pkg')";
            const open = text.indexOf("(");
            const offset = text.indexOf("'talker") + 2;
            assert.strictEqual(core.pyStringKwargInCall(text, open, offset, "package"), "demo_pkg");
            const text2 = "Node(package='a', executable='b')";
            assert.strictEqual(core.pyStringKwargInCall(text2, text2.indexOf("("), text2.indexOf("'b'") + 1, "package"), "a", "向前口径不回归");
        });
        it("xml 旧口径:pkg 在前闭合,cursor 在 exec 值内 → 向前命中", () => {
            const text2 = '<node pkg="a" exec="b"/>';
            const offset = text2.indexOf('"b"') + 1; // exec 值内
            assert.strictEqual(core.xmlTagAttrBefore(text2, offset, "pkg"), "a");
        });
    });
});
});

describe("launch-completion LJ-7(2026-10-02 去风暴 + dash 词锚)", () => {

    describe("LJ-7 core:action dashTyped / insert 剥前缀", () => {
        it("yamlCursorAt:空行动作 dashTyped=false;- 已敲 dashTyped=true", () => {
            const t1 = "launch:\n  ";
            const c1 = core.yamlCursorAt(t1, t1.length);
            assert.ok(c1 && c1.kind === "action" && c1.dashTyped === false, JSON.stringify(c1));
            const t2 = "launch:\n  - ";
            const c2 = core.yamlCursorAt(t2, t2.length);
            assert.ok(c2 && c2.kind === "action" && c2.dashTyped === true, JSON.stringify(c2));
        });
        it("yamlActionCandidates:dashTyped=true insert 无 '- ' 前缀;false 保持 '- node:'", () => {
            const stripped = core.yamlActionCandidates("", "    ", true);
            assert.ok(stripped.length > 0);
            for (const c of stripped) {
                assert.ok(!c.insert.startsWith("- "), `剥前缀失败:${c.insert.slice(0, 20)}`);
            }
            const kept = core.yamlActionCandidates("node", "  ", false);
            assert.ok(kept.some(c => c.insert.startsWith("- node:")), "false 应保持 - 前缀");
        });
        it("yamlActionCandidates:两参旧调用(不带 dashTyped)保持 '- ' 前缀(兼容)", () => {
            const legacy = core.yamlActionCandidates("node", "  ");
            assert.ok(legacy.some(c => c.insert.startsWith("- node:")));
        });
    });
});

describe("launch-completion LJ-10(2026-10-03 替换全集 + 事件/生命周期/配置栈)", () => {

    describe("LJ-10a 替换目录全集(VM Humble 终审)", () => {
        it("新命令命中:if/equals/not/and/or/anon/command/find-exec/file-content/filename/param/log_dir", () => {
            for (const [prefix, name] of [["if", "if"], ["equals", "equals"], ["not-eq", "not-equals"],
                ["and", "and"], ["or", "or"], ["an", "anon"], ["command", "command"],
                ["find-e", "find-exec"], ["file-c", "file-content"], ["file", "filename"],
                ["param", "param"], ["log_", "log_dir"], ["launch_log", "launch_log_dir"]]) {
                assert.ok(core.substCommandCandidates(prefix).some(c => c.label === name),
                    `前缀 ${prefix} 应命中 ${name}:${JSON.stringify(core.substCommandCandidates(prefix).map(c => c.label))}`);
            }
        });
        it("布尔件全集 not/and/or/any/all;排除 rolling-only path-join/string-join/string-strip/for-var", () => {
            for (const b of ["not", "and", "or", "any", "all"]) {
                assert.ok(core.substCommandCandidates(b).some(c => c.label === b), `应含 ${b}`);
            }
            for (const roll of ["path-join", "string-join", "string-strip", "for-var"]) {
                assert.ok(!core.substCommandCandidates("").some(c => c.label === roll), `rolling-only ${roll} 不应收录`);
            }
        });
    });

    describe("LJ-10b py 事件/生命周期/配置栈", () => {
        it("结构片段:事件链/优雅关闭/生命周期迁移/OpaqueFunction/参数文件/条件执行", () => {
            const checks: Array<[string, string]> = [
                ["Register", "Event chain (on process exit)"],
                ["OnShutdown", "Event chain (graceful shutdown)"],
                ["EmitEvent", "Lifecycle transition (activate node)"],
                ["OpaqueFunction", "OpaqueFunction full skeleton"],
                ["PathJoinSub", "Node (params file composition)"],
                ["IfCondition", "Node (conditional)"]
            ];
            for (const [prefix, label] of checks) {
                assert.ok(core.pyStructureCandidates(prefix).some(c => c.label === label),
                    `${prefix} 应命中 ${label}`);
            }
        });
        it("kwarg 目录:OnProcessExit/OnProcessIO/EmitEvent/OpaqueCoroutine/UnsetLaunchConfiguration", () => {
            const oe = core.pyKwargCandidates("OnProcessExit", "", new Set()).map(c => c.label);
            assert.ok(oe.includes("target_action") && oe.includes("on_exit"), JSON.stringify(oe));
            const io = core.pyKwargCandidates("OnProcessIO", "", new Set()).map(c => c.label);
            assert.ok(io.includes("on_stdout") && io.includes("on_stderr"));
            assert.ok(core.pyKwargCandidates("EmitEvent", "", new Set()).map(c => c.label).includes("event"));
            const oc = core.pyKwargCandidates("OpaqueCoroutine", "", new Set()).map(c => c.label);
            assert.ok(oc.includes("coroutine") && oc.includes("ignore_context"));
            assert.ok(core.pyKwargCandidates("UnsetLaunchConfiguration", "", new Set()).map(c => c.label).includes("name"));
        });
        it("用户资料伪项不入目录:LogWarn/LogError/ForEach/OnAction(官方不存在)", () => {
            for (const fake of ["LogWarn", "LogError", "ForEach", "OnAction"]) {
                assert.ok(core.pyStructureCandidates(fake).length === 0, `${fake} 不应有结构片段`);
            }
        });
        it("XML/YAML 不收 py-only 实体:lifecycle_node/emit_event(Humble frontend 无)", () => {
            const kids = core.xmlChildCandidates("launch", "").map(c => c.label);
            assert.ok(!kids.includes("lifecycle_node") && !kids.includes("emit_event"), JSON.stringify(kids));
            assert.ok(!core.yamlActionCandidates("lifecycle", "  ").some(c => c.label === "lifecycle_node"));
            assert.ok(!core.yamlActionCandidates("emit", "  ").some(c => c.label === "emit_event"));
        });
    });
});
