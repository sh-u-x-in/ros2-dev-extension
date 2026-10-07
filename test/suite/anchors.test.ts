import * as assert from "assert";
import {
    findMatchingClose,
    findCallOpen,
    classifyRegions,
    findSetupCall,
    insertItemAtContainerTail,
    insertListItemCanonical,
    findConsoleScriptsList,
    consoleListHasItem,
    findCommandParens,
    insertSnippetCmake,
    findPackageCloseTag,
    insertBeforePackageClose,
    nameTagSpan,
    indexLines,
    isCommentOnlyLine,
    commentTextOfLine,
    commentRuns,
    topLevelArgRanges,
    findKwargSpan,
    scanActiveCalls,
    locateCmakeInsert,
    findActiveCallByArgs,
    cmakeAppendArgToBlock,
    locateCmakeTemplateCodeAnchor,
    locateXmlDepInsert,
    insertXmlDepElement,
    depElementLine,
    XML_DEP_KINDS,
} from "../../src/build-tool/package-service/config/write/anchors";

// (c) MIT
// anchors 定位层无头单测(2026-09-03):括号跨行配对 / 注释·字符串·bracket arg 干扰 / 容器尾插入 / xml 锚点 / 行·kwarg 定位。
// 运行:npm run test-compile && npx mocha out/test/suite/anchors.test.js

describe("anchors python 扫描(python)", function () {
    it("setup() 跨行配对:忽略注释与字符串内的括号", () => {
        const text = [
            "from setuptools import setup",
            "setup(",
            "    name='demo',",
            "    # comment ) (",
            "    entry_points={'console_scripts': ['a = m:main']},",
            ")",
            "",
        ].join("\n");
        const pair = findSetupCall(text);
        assert.ok(pair);
        assert.strictEqual(text[pair!.closeIndex], ")");
        assert.strictEqual(pair!.closeIndex, text.lastIndexOf(")"));
    });

    it("三引号字符串内的 ) 不干扰配对", () => {
        const text = "doc = '''a ) ( b'''\nsetup(\n  name='p',\n)\n";
        const pair = findSetupCall(text);
        assert.ok(pair);
        const docClose = text.indexOf("''')");
        assert.ok(pair!.closeIndex > docClose, "close 应在三引号之后");
        assert.strictEqual(text[pair!.closeIndex], ")");
    });

    it("容器尾插入:非空列表补逗号、空容器不加逗号;括号仍平衡", () => {
        const list = "scripts = ['a']\n";
        const o = list.indexOf("[");
        const c = list.indexOf("]");
        // 单行容器 → 内联插入(不强制转多行)
        const next = insertItemAtContainerTail(list, o, c, "'b'");
        assert.ok(next.includes("['a', 'b']"), next);
        assert.strictEqual(findMatchingClose(next, next.indexOf("["), "python"), next.lastIndexOf("]"));

        const empty = "d = {}\n";
        const eo = empty.indexOf("{");
        const ec = empty.indexOf("}");
        const nextE = insertItemAtContainerTail(empty, eo, ec, "'k': 1");
        assert.ok(nextE.includes("{'k': 1}") || nextE.includes("'k': 1"));
        assert.ok(!/"\{\s*,\s*'k'/.test(nextE), "空容器不应产生孤立逗号");
        assert.strictEqual(findMatchingClose(nextE, nextE.indexOf("{"), "python"), nextE.lastIndexOf("}"));
    });

    it("已有尾随逗号时不重复补逗号", () => {
        const text = "entry_points={'console_scripts': ['old = m:main',]}\n";
        const o = text.indexOf("[");
        const c = text.indexOf("]");
        const next = insertItemAtContainerTail(text, o, c, "'new = n:main'");
        assert.ok(!next.includes("',,\n"), "不应出现双逗号");
        assert.ok(next.includes("'new = n:main'"));
        assert.strictEqual(findMatchingClose(next, next.indexOf("["), "python"), next.lastIndexOf("]"));
    });
});

describe("anchors cmake 扫描(cmake)", function () {
    it("跨行命令:引号与注释里的 ) 不干扰配对", () => {
        const text = [
            "ament_target_dependencies(",
            "  talker",
            '  "rclcpp )"',
            "  # comment )",
            ")",
            "",
        ].join("\n");
        const pair = findCommandParens(text, "ament_target_dependencies");
        assert.ok(pair);
        assert.strictEqual(text[pair!.closeIndex], ")");
        assert.strictEqual(pair!.closeIndex, text.lastIndexOf(")"));
    });

    it("bracket 注释与 bracket 参数内的括号被跳过", () => {
        const c1 = "#[==[ ) ( ]==]\nproject(demo)\n";
        const p1 = findCommandParens(c1, "project");
        assert.ok(p1);
        assert.strictEqual(c1[p1!.closeIndex], ")");
        const c2 = "set(X [[ a ) b ]])\n";
        const p2 = findCommandParens(c2, "set");
        assert.ok(p2);
        assert.strictEqual(c2[p2!.closeIndex], ")");
        assert.ok(p2!.closeIndex > c2.indexOf("]]"));
    });

    it("insertSnippetCmake 插到 ament_package() 之前;无 ament_package 则尾追加", () => {
        const text = "cmake_minimum_required(VERSION 3.8)\nproject(demo)\n\nament_package()\n";
        const next = insertSnippetCmake(text, "install(DIRECTORY launch DESTINATION share/demo)\n");
        const ap = text.indexOf("ament_package()");
        const apN = next.indexOf("ament_package()");
        assert.ok(next.indexOf("install(DIRECTORY launch") < apN, "snippet 应在 ament_package 之前");
        void ap;
        const noAment = "project(demo)\n";
        const tail = insertSnippetCmake(noAment, "install(PROGRAMS x)\n");
        assert.ok(tail.endsWith("install(PROGRAMS x)\n"));
    });
});

describe("anchors xml(package.xml)", function () {
    it("</package> 前锚点插入(根闭合标签之后绝不落内容)", () => {
        const xml = "<package format='3'>\n  <name>demo</name>\n</package>\n";
        const deps = "  <buildtool_depend>rosidl_default_generators</buildtool_depend>\n";
        const next = insertBeforePackageClose(xml, deps);
        assert.ok(next.includes(deps));
        assert.ok(next.indexOf(deps) < next.indexOf("</package>"));
        assert.ok(next.indexOf("</package>") === next.lastIndexOf("</package>"));
        // close tag 缺失 → 原样返回
        assert.strictEqual(insertBeforePackageClose("<p>", "x"), "<p>");
    });

    it("name 内容跨度", () => {
        const xml = "<package><name>demo</name></package>";
        const span = nameTagSpan(xml);
        assert.ok(span);
        assert.strictEqual(xml.slice(span!.start, span!.end), "demo");
    });
});

describe("anchors/lines(行与注释 run)", function () {
    it("注释行判定与行索引", () => {
        const text = "a = 1\n# 注释\nx = '# not a comment'\n";
        const lines = indexLines(text);
        assert.strictEqual(lines.length, 3);
        assert.strictEqual(isCommentOnlyLine(text, lines[1], "python"), true);
        assert.strictEqual(isCommentOnlyLine(text, lines[0], "python"), false);
        assert.strictEqual(isCommentOnlyLine(text, lines[2], "python"), false); // 字符串里的 # 不是注释
        assert.strictEqual(commentTextOfLine(text, lines[1], "python"), "注释");
    });

    it("commentRuns:横幅连续组被聚合为一条 run", () => {
        const text = "####\n## 依赖查找 ##\n####\n\nfind_package(ament_cmake REQUIRED)\n";
        const runs = commentRuns(text, "cmake");
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(runs[0].startLine, 0);
        assert.strictEqual(runs[0].endLine, 2);
        // run 覆盖横幅区(start..end 含三行横幅,不含其后代码行)
        const banner = text.slice(runs[0].startOffset, runs[0].endOffset);
        assert.ok(banner.includes("依赖查找"));
        assert.ok(!banner.includes("find_package"));
    });

    it("python:顶层参数按逗号切分(kwarg 块),忽略嵌套与字符串内逗号", () => {
        const text = [
            "setup(",
            "    name='p',",
            "    entry_points={'console_scripts': ['a = m:main']},",
            "    data_files=[('share/p/launch', glob('launch/*.launch.py'))],",
            ")",
            "",
        ].join("\n");
        const pair = findSetupCall(text);
        assert.ok(pair);
        const ranges = topLevelArgRanges(text, pair!.openIndex, pair!.closeIndex);
        assert.strictEqual(ranges.length, 3, "name/entry_points/data_files 三个顶层参数");
        const ep = findKwargSpan(text, pair!.openIndex, "entry_points");
        assert.ok(ep);
        assert.ok(text.slice(ep!.start, ep!.end).includes("'a = m:main'"));
        const df = findKwargSpan(text, pair!.openIndex, "data_files");
        assert.ok(df);
        assert.ok(text.slice(df!.start, df!.end).includes("launch"));
        assert.strictEqual(findKwargSpan(text, pair!.openIndex, "install_requires"), undefined);
    });

    it("python:kwarg 前有整行中文注释 → findKwargSpan 仍命中(真实 setup.py 形态,§3.3)", () => {
        const text = [
            "setup(",
            "    name='p',",
            "    ##########",
            "    ## 数据文件 ##",
            "    ##########",
            "    # 收集 demo 模块 (排除 test/)",
            "    data_files=[('share/p/launch', glob('launch/*.launch.py'))],",
            "    ##########",
            "    ## 节点入口 ##",
            "    ##########",
            "    # console_scripts 定义命令名与模块函数入口",
            "    entry_points={'console_scripts': ['a = m:main']},",
            ")",
            "",
        ].join("\n");
        const pair = findSetupCall(text);
        assert.ok(pair);
        const ep = findKwargSpan(text, pair!.openIndex, "entry_points");
        assert.ok(ep, "注释头之后仍应命中 entry_points");
        assert.ok(text.slice(ep!.start, ep!.end).includes("'a = m:main'"));
        const df = findKwargSpan(text, pair!.openIndex, "data_files");
        assert.ok(df, "注释头之后仍应命中 data_files");
    });
});

describe("cmake-locate 活跃命令扫描", function () {
    it("跳过注释模板;只收 code 区命令", () => {
        const text = [
            "project(demo)",
            "## 依赖查找 (对应 package.xml 的 <depend>) ##",
            "# find_package(std_msgs REQUIRED)",
            "find_package(rclcpp REQUIRED)",
            "# install(PROGRAMS scripts/my_node.py",
            "#   DESTINATION lib/${PROJECT_NAME})",
            "install(DIRECTORY launch",
            "  DESTINATION share/${PROJECT_NAME})",
            "ament_package()",
            "",
        ].join("\n");
        const calls = scanActiveCalls(text);
        const names = calls.map((c) => c.name);
        assert.deepStrictEqual(names, ["project", "find_package", "install", "ament_package"]);
    });

    it("跨行命令括号配对完整;字符串内括号不干扰", () => {
        const text = [
            "install(TARGETS talker listener",
            "  DESTINATION lib/${PROJECT_NAME})",
            "set(MSG \"a ) b\")",
        ].join("\n");
        const calls = scanActiveCalls(text);
        const install = calls.find((c) => c.name === "install");
        assert.ok(install);
        const seg = text.slice(install!.openIndex, install!.closeIndex);
        assert.ok(seg.includes("DESTINATION"));
        assert.ok(!seg.includes("set"));
    });
});

describe("cmake-locate L1/L2/L3 定位", function () {
    it("L1 deps:有活跃 find_package → 最后活跃调用之后新行起", () => {
        const text = [
            "project(demo)",
            "find_package(ament_cmake REQUIRED)",
            "find_package(rclcpp REQUIRED)",
            "## 标准消息类型 (使用 std_msgs 时启用)",
            "# find_package(std_msgs REQUIRED)",
            "ament_package()",
            "",
        ].join("\n");
        const r = locateCmakeInsert(text, "deps")!;
        assert.strictEqual(r.level, 1);
        const after = text.slice(0, r.insertAt);
        assert.ok(after.endsWith("find_package(rclcpp REQUIRED)\n"));
        assert.ok(!after.includes("ament_package()"));
    });

    it("L2 install:无活跃但有注释模板 → 模板 run 起点上方", () => {
        const text = [
            "project(demo)",
            "#############",
            "## 安装 ##",
            "#############",
            "",
            "# TARGETS: 安装 CMake 编译产物",
            "# install(TARGETS Mycpp_node",
            "#   DESTINATION lib/${PROJECT_NAME})",
            "",
            "## PROGRAMS: 安装现成的可执行文件/脚本",
            "# install(PROGRAMS scripts/my_node.py",
            "#   DESTINATION lib/${PROJECT_NAME})",
            "",
            "ament_package()",
            "",
        ].join("\n");
        const r = locateCmakeInsert(text, "install")!;
        assert.strictEqual(r.level, 2);
        // 插到首个含 install 模板的注释 run 之前(不落在 ament_package 前文件尾)
        const before = text.slice(0, r.insertAt);
        assert.ok(before.includes("## 安装 ##"));
        assert.ok(!before.includes("# install(TARGETS"));
    });

    it("L2 interfaces:rosidl 注释模板整段为锚", () => {
        const text = [
            "project(demo)",
            "## 生成 msg/srv/action 文件夹中的接口",
            "# find_package(rosidl_default_generators REQUIRED)",
            "# rosidl_generate_interfaces(${PROJECT_NAME}",
            "#   \"msg/MyMsg.msg\"",
            "# )",
            "# ament_export_dependencies(rosidl_default_runtime)",
            "ament_package()",
            "",
        ].join("\n");
        const r = locateCmakeInsert(text, "interfaces")!;
        assert.strictEqual(r.level, 2);
        const before = text.slice(0, r.insertAt);
        assert.ok(before.endsWith("project(demo)\n"));
        // 不会落到 ament_package() 前(注释模板更靠前,优先模板锚)
        assert.ok(!before.includes("ament_package()"));
    });

    it("L3:无活跃无模板 → ament_package() 之前;无 ament_package → 文件尾", () => {
        const withAp = "project(demo)\nset(X 1)\nament_package()\n";
        const r1 = locateCmakeInsert(withAp, "install")!;
        assert.strictEqual(r1.level, 3);
        assert.ok(withAp.slice(0, r1.insertAt).endsWith("set(X 1)\n"));

        const noAp = "project(demo)\nset(X 1)\n";
        const r2 = locateCmakeInsert(noAp, "install")!;
        assert.strictEqual(r2.level, 3);
        assert.strictEqual(r2.insertAt, noAp.length);
    });

    it("空文本 → undefined", () => {
        assert.strictEqual(locateCmakeInsert("", "install"), undefined);
        assert.strictEqual(locateCmakeInsert("  \n\n", "install"), undefined);
    });
});

describe("anchors xml 多类插入(lezer 定位,2026-09-04)", function () {
    it("5 类以上依赖类别表齐全", () => {
        assert.ok(XML_DEP_KINDS.length >= 5);
        for (const k of ["buildtool_depend", "build_depend", "build_export_depend", "exec_depend", "depend", "member_of_group"]) {
            assert.ok(XML_DEP_KINDS.includes(k as any), "缺类别 " + k);
        }
    });

    it("同类元素聚在一起 → 插到同类尾部(exec_depend 加在 launch_ros 后)", () => {
        const xml = [
            "<package format='3'>",
            "  <name>demo</name>",
            "  <exec_depend>std_msgs</exec_depend>",
            "  <exec_depend>launch_ros</exec_depend>",
            "  <export><build_type>ament_cmake</build_type></export>",
            "</package>",
            "",
        ].join("\n");
        const at = locateXmlDepInsert(xml, "exec_depend");
        const next = insertXmlDepElement(xml, "exec_depend", "sensor_msgs");
        assert.ok(next.includes("<exec_depend>sensor_msgs</exec_depend>"));
        // 同类追加:位于 launch_ros 之后、export 之前
        const posLaunch = next.indexOf("launch_ros");
        const posNew = next.indexOf("sensor_msgs");
        const posExport = next.indexOf("<export>");
        assert.ok(posNew > posLaunch && posNew < posExport);
        assert.ok(at > xml.indexOf("launch_ros"));
    });

    it("无同类依赖 → 依赖区末尾;空 package.xml → 根闭合前", () => {
        const xml = "<package format='3'>\n  <name>demo</name>\n  <export><build_type>ament_cmake</build_type></export>\n</package>\n";
        const next = insertXmlDepElement(xml, "exec_depend", "rclcpp");
        const posNew = next.indexOf("rclcpp");
        const posExport = next.indexOf("<export>");
        assert.ok(posNew > 0 && posNew < posExport, "无同类依赖时应插到 export 前");
        // 根闭合前
        const empty = "<package format='3'>\n</package>\n";
        const nextE = insertXmlDepElement(empty, "depend", "x");
        assert.ok(nextE.indexOf("x") < nextE.indexOf("</package>"));
    });

    it("注释里出现同名字符串不误命中(lezer 树天然跳过注释)", () => {
        const xml = [
            "<package format='3'>",
            "  <name>demo</name>",
            "  <!-- <exec_depend>fake</exec_depend> 注释示例 -->",
            "  <export/>",
            "</package>",
            "",
        ].join("\n");
        const next = insertXmlDepElement(xml, "exec_depend", "real_dep");
        // 注释文本原样保留(含 fake 字样),但新元素是真实 Element 且落在根闭合前
        assert.ok(next.includes("<!-- <exec_depend>fake</exec_depend> 注释示例 -->"));
        assert.ok(next.includes("<exec_depend>real_dep</exec_depend>"));
        assert.ok(next.indexOf("<exec_depend>real_dep</exec_depend>") < next.indexOf("</package>"));
    });

    it("depElementLine 生成正确缩进行", () => {
        assert.strictEqual(depElementLine("exec_depend", "std_msgs"), "  <exec_depend>std_msgs</exec_depend>");
    });
});

describe("cmake 块内追加(2026-09-04 垂直规范形态)", function () {
    const S1 = "# [rde-ros-2 扩展生成] 2026-09-03 21:57";

    function installCall(text: string, hint: string): { openIndex: number; closeIndex: number; name: string } {
        const c = findActiveCallByArgs(text, "install", hint);
        if (!c) { throw new Error("未找到 install(" + hint + ")"); }
        return c;
    }

    it("单行紧凑 PROGRAMS(尾随 stamp)→ 垂直化并追加;旧 stamp 上移到头行,新行带新 stamp", () => {
        const text = "install(PROGRAMS scripts/extra.py DESTINATION lib/${PROJECT_NAME}) # [rde-ros-2 扩展生成] 2026-09-03 21:57\n";
        const call = installCall(text, "PROGRAMS");
        const r = cmakeAppendArgToBlock(text, call, "scripts/second.py", { stamp: S1 });
        assert.strictEqual(r.reason, undefined);
        assert.strictEqual(r.already, false);
        assert.strictEqual(r.converted, true);
        assert.ok(r.text.includes("install(PROGRAMS # [rde-ros-2 扩展生成] 2026-09-03 21:57"), r.text);
        assert.ok(r.text.includes("  scripts/extra.py\n"), r.text);
        assert.ok(r.text.includes("  scripts/second.py # [rde-ros-2 扩展生成] 2026-09-03 21:57"), r.text);
        assert.ok(r.text.includes("  DESTINATION lib/${PROJECT_NAME}"), r.text);
        assert.ok(r.text.includes("\n)\n"), r.text);
        // ')' 前的残留注释已被移走:旧尾行不再出现 "# [rde-ros-2"
        assert.ok(!/PROJECT_NAME\}\) #/.test(r.text));
    });

    it("两行紧凑 PROGRAMS → 垂直化追加;幂等命中不改文本", () => {
        const text = "install(PROGRAMS scripts/py_node.py\n  DESTINATION lib/${PROJECT_NAME})\n";
        const call = installCall(text, "PROGRAMS");
        const r1 = cmakeAppendArgToBlock(text, call, "scripts/extra.py", { stamp: S1 });
        assert.ok(r1.text.includes("install(PROGRAMS\n  scripts/py_node.py\n  scripts/extra.py # [rde-ros-2 扩展生成] 2026-09-03 21:57\n  DESTINATION lib/${PROJECT_NAME}\n)"), r1.text);
        // 幂等:已含 extra.py
        const call2 = installCall(r1.text, "PROGRAMS");
        const r2 = cmakeAppendArgToBlock(r1.text, call2, "scripts/extra.py", { stamp: S1 });
        assert.strictEqual(r2.already, true);
        assert.strictEqual(r2.text, r1.text);
    });

    it("已垂直 PROGRAMS 块:converted=false 纯追加,插到 DESTINATION 行前", () => {
        const text = [
            "install(PROGRAMS",
            "  scripts/a.py",
            "  DESTINATION lib/${PROJECT_NAME}",
            ")",
            "",
        ].join("\n");
        const call = installCall(text, "PROGRAMS");
        const r = cmakeAppendArgToBlock(text, call, "scripts/b.py");
        assert.strictEqual(r.converted, false);
        const lines = r.text.split("\n");
        assert.ok(lines.includes("  scripts/a.py") && lines.includes("  scripts/b.py"));
        const iA = lines.indexOf("  scripts/a.py");
        const iB = lines.indexOf("  scripts/b.py");
        const iD = lines.indexOf("  DESTINATION lib/${PROJECT_NAME}");
        assert.ok(iA < iB && iB < iD, "b 应在 a 后、DESTINATION 前");
    });

    it("rosidl:在既有块内、DEPENDENCIES 行之前追加第二个文件", () => {
        const text = [
            "rosidl_generate_interfaces(${PROJECT_NAME}",
            '  "msg/MyMsg.msg"',
            "  DEPENDENCIES std_msgs",
            ")",
            "",
        ].join("\n");
        const call = findActiveCallByArgs(text, "rosidl_generate_interfaces")!;
        const r = cmakeAppendArgToBlock(text, call, '"srv/MySrv.srv"', { stamp: S1 });
        assert.strictEqual(r.already, false);
        assert.strictEqual(r.converted, false);
        const lines = r.text.split("\n");
        assert.ok(lines.includes('  "msg/MyMsg.msg"'));
        assert.ok(lines.includes('  "srv/MySrv.srv" # [rde-ros-2 扩展生成] 2026-09-03 21:57'));
        const iM = lines.indexOf('  "msg/MyMsg.msg"');
        const iS = lines.findIndex((l) => l.startsWith('  "srv/MySrv.srv"'));
        const iD = lines.indexOf("  DEPENDENCIES std_msgs");
        assert.ok(iM < iS && iS < iD);
    });

    it("rosidl 紧凑(文件挤在头行)→ 垂直化后追加", () => {
        const text = 'rosidl_generate_interfaces(${PROJECT_NAME} "msg/MyMsg.msg")\n';
        const call = findActiveCallByArgs(text, "rosidl_generate_interfaces")!;
        const r = cmakeAppendArgToBlock(text, call, '"srv/MySrv.srv"', { stamp: S1 });
        assert.strictEqual(r.converted, true);
        assert.ok(r.text.includes('rosidl_generate_interfaces(${PROJECT_NAME}\n  "msg/MyMsg.msg"\n  "srv/MySrv.srv"'), r.text);
        assert.ok(r.text.endsWith(")\n"), r.text);
    });

    it("install TARGETS 追加目标名", () => {
        const text = "install(TARGETS talker listener\n  DESTINATION lib/${PROJECT_NAME})\n";
        const call = installCall(text, "TARGETS");
        const r = cmakeAppendArgToBlock(text, call, "mycpp_node");
        assert.strictEqual(r.already, false);
        assert.ok(r.text.includes("install(TARGETS\n  talker\n  listener\n  mycpp_node\n  DESTINATION lib/${PROJECT_NAME}\n)"), r.text);
        // 幂等
        const call2 = installCall(r.text, "TARGETS");
        const r2 = cmakeAppendArgToBlock(r.text, call2, "mycpp_node");
        assert.strictEqual(r2.already, true);
    });

    it("不支持:空块 / DIRECTORY 媒介 / 非追加型命令", () => {
        assert.ok(cmakeAppendArgToBlock("install()\n", { name: "install", openIndex: 7, closeIndex: 8 }, "x").reason);
        assert.ok(cmakeAppendArgToBlock("install(DIRECTORY launch DESTINATION share/x)\n",
            installCall("install(DIRECTORY launch DESTINATION share/x)\n", "DIRECTORY"), "launch2").reason);
        const ae = "add_executable(talker src/talker.cpp)\n";
        const c = { name: "add_executable", openIndex: ae.indexOf("("), closeIndex: ae.indexOf(")") };
        assert.ok(cmakeAppendArgToBlock(ae, c, "x").reason);
    });
});

describe("locateCmakeTemplateCodeAnchor(## 头不参与匹配)", function () {
    it("返回模板 run 中首条被注释代码行的行首(不在 ## 说明头上方)", () => {
        const text = [
            "project(demo)",
            "## 生成 msg/srv/action 文件夹中的接口",
            "# find_package(rosidl_default_generators REQUIRED)",
            "# rosidl_generate_interfaces(${PROJECT_NAME}",
            '#   "msg/MyMsg.msg"',
            "# )",
            "# ament_export_dependencies(rosidl_default_runtime)",
            "ament_package()",
            "",
        ].join("\n");
        const at = locateCmakeTemplateCodeAnchor(text, "rosidl_generate_interfaces")!;
        const before = text.slice(0, at);
        assert.ok(before.includes("## 生成 msg/srv/action 文件夹中的接口"), "## 头应留在新块上方");
        assert.ok(!before.includes("# find_package"), "插入点应在首条代码注释(find_package)之前");
        assert.strictEqual(at, text.indexOf("# find_package"));
    });

    it("install DIRECTORY 模板:锚在注释代码行,argHint 过滤生效", () => {
        const text = [
            "project(demo)",
            "## DIRECTORY: 安装整个目录 (递归复制, 不编译)",
            "# install(DIRECTORY launch",
            "#   DESTINATION share/${PROJECT_NAME})",
            "## PROGRAMS: 脚本",
            "# install(PROGRAMS scripts/a.py",
            "#   DESTINATION lib/${PROJECT_NAME})",
            "",
        ].join("\n");
        const at = locateCmakeTemplateCodeAnchor(text, "install", "DIRECTORY launch")!;
        assert.strictEqual(at, text.indexOf("# install(DIRECTORY launch"));
        const none = locateCmakeTemplateCodeAnchor(text, "install", "DIRECTORY include");
        assert.strictEqual(none, undefined);
    });
});

describe("anchors xml 行尾内联标注(2026-09-04 定稿)", function () {
    it("元素行尾内联标注;export 行缩进保留,无多余空行", () => {
        const xml = "<package format='3'>\n  <name>demo</name>\n  <export></export>\n</package>\n";
        const next = insertXmlDepElement(xml, "exec_depend", "rclcpp", undefined, "<!-- rde-ros-2 扩展生成 2026-09-04 01:30 -->");
        const iC = next.indexOf("<!-- rde-ros-2 扩展生成 2026-09-04 01:30 -->");
        const iE = next.indexOf("<exec_depend>rclcpp</exec_depend>");
        assert.ok(iE >= 0 && iC > iE, "标注应内联在元素行尾:\n" + next);
        assert.ok(next.includes("<exec_depend>rclcpp</exec_depend> <!-- rde-ros-2 扩展生成 2026-09-04 01:30 -->"), next);
        assert.ok(next.includes("  <export></export>"), "export 缩进应保留:\n" + next);
        assert.ok(!next.includes("<!--\n"), "不得出现独立注释行:\n" + next);
    });
});

describe("python 规范列表尾插(insertListItemCanonical,2026-09-04)", function () {
    const STAMP = "# [rde-ros-2 扩展生成] 2026-09-04 00:55";

    function listPair(text) {
        const o = text.indexOf("[", text.indexOf("console_scripts"));
        const c = findMatchingClose(text, o, "python");
        return { o, c };
    }

    it("create 风格(每条带尾逗号)→ 追加条目自带尾逗号+行内标注,既有行零改动", () => {
        const text = [
            "    entry_points={",
            "        'console_scripts': [",
            "            'talker = m.talker:main',",
            "            'listener = m.listener:main',",
            "        ],",
            "    },",
            "",
        ].join("\n");
        const p = listPair(text);
        const out1 = insertListItemCanonical(text, p.o, p.c, "'extra = m.extra:main'", { stamp: STAMP });
        assert.ok(out1.includes("'extra = m.extra:main', # [rde-ros-2 扩展生成] 2026-09-04 00:55"), out1);
        assert.ok(out1.includes("'talker = m.talker:main',"), out1);
        const p2 = listPair(out1);
        const out2 = insertListItemCanonical(out1, p2.o, p2.c, "'another = m.another:main'", { stamp: STAMP });
        const extraLine1 = out1.split("\n").find((l) => l.includes("'extra = m.extra:main'"))!;
        const extraLine2 = out2.split("\n").find((l) => l.includes("'extra = m.extra:main'"))!;
        assert.strictEqual(extraLine2, extraLine1, "第二次追加不应改写上一次追加的行");
        assert.ok(out2.includes("'another = m.another:main', # [rde-ros-2 扩展生成] 2026-09-04 00:55"), out2);
        // 括号仍平衡
        const o2 = out2.indexOf("[", out2.indexOf("console_scripts"));
        const c2 = findMatchingClose(out2, o2, "python");
        assert.ok(c2 > o2, "列表括号应平衡:\n" + out2);
    });

    it("末行缺尾逗号(旧式)→ 补一次逗号后再插入;补后不再改动", () => {
        const text = [
            "entry_points={",
            "  'console_scripts': [",
            "    'a = m.a:main'",
            "  ],",
            "},",
            "",
        ].join("\n");
        const p = listPair(text);
        const out1 = insertListItemCanonical(text, p.o, p.c, "'b = m.b:main'", { stamp: STAMP });
        assert.ok(out1.includes("'a = m.a:main',"), out1);
        assert.ok(out1.includes("'b = m.b:main', # [rde-ros-2 扩展生成] 2026-09-04 00:55"), out1);
        const p2 = listPair(out1);
        const out2 = insertListItemCanonical(out1, p2.o, p2.c, "'c = m.c:main'");
        const a1 = out1.split("\n").find((l) => l.includes("'a = m.a:main'"))!;
        const a2 = out2.split("\n").find((l) => l.includes("'a = m.a:main'"))!;
        assert.strictEqual(a2, a1);
    });

    it("单行内联列表 → 规范多行(不产生重复闭括号/括号平衡)", () => {
        const text = "setup(name='p', entry_points={'console_scripts': ['a = m.a:main']})\n";
        const p = listPair(text);
        const out = insertListItemCanonical(text, p.o, p.c, "'b = m.b:main'", { stamp: STAMP });
        assert.ok(out.includes("'b = m.b:main', # [rde-ros-2 扩展生成] 2026-09-04 00:55"), out);
        assert.ok(!out.includes("]]"), out);
        const o = out.indexOf("[", out.indexOf("console_scripts"));
        const c = findMatchingClose(out, o, "python");
        assert.ok(c > o, "列表括号应平衡:\n" + out);
        assert.ok(out.includes("})\n") || out.includes("]})\n"), out);
    });

    it("空列表([])→ 直接落条目行", () => {
        const text = "entry_points={'console_scripts': []}\n";
        const p = listPair(text);
        const out = insertListItemCanonical(text, p.o, p.c, "'a = m.a:main'", { stamp: STAMP });
        assert.ok(out.includes("'a = m.a:main', # [rde-ros-2 扩展生成] 2026-09-04 00:55"), out);
    });
});

describe("python entry_points 外部变量字典定位(2026-09-04)", function () {
    const TYPED = [
        "from typing import Dict, List",
        "entry_points: Dict[str, List[str]] = {",
        "    'console_scripts': [",
        "        'talker = p.talker:main',",
        "    ],",
        "},",
        "setup(name='p', entry_points=entry_points)",
        "",
    ].join("\n");
    it("findConsoleScriptsList 命中外部变量字典的 console_scripts 列表", () => {
        const hit = findConsoleScriptsList(TYPED);
        assert.ok(hit, "应命中变量字典");
        assert.ok(TYPED.slice(hit!.lb, hit!.rb).includes("talker = p.talker:main"));
        assert.strictEqual(consoleListHasItem(TYPED, hit!.lb, hit!.rb, "'talker = p.talker:main'"), true);
        assert.strictEqual(consoleListHasItem(TYPED, hit!.lb, hit!.rb, "'extra = p.extra:main'"), false);
        assert.strictEqual(consoleListHasItem(TYPED, hit!.lb, hit!.rb, "'extra = p.extra:main',"), false);
    });
    it("内联 kwarg 形态同样命中", () => {
        const inline = "setup(name='p', entry_points={'console_scripts': ['a = m.a:main']})\n";
        const hit = findConsoleScriptsList(inline);
        assert.ok(hit);
    });
});
