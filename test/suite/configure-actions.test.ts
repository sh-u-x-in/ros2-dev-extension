// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file configure-actions.test.ts
 * 01 一键配置【纯动作层】无头单测(2026-09-03)。
 * 覆盖:角色识别 / launch(install 幂等)/ msg·srv·action 接口链(CMakeLists+package.xml)/
 *       python console_scripts 三分支整文改写 / cpp 骨架 / 不支持类型与缺失 buildType。
 * 运行:npm run test-compile && npx mocha out/test/suite/configure-actions.test.js
 */

import * as assert from "assert";
import {
    detectRole,
    planConfigure,
    ConfigurePackage,
    BuildTexts,
    stampComment,
    stampSnippet,
    stampTimestamp,
} from "../../src/build-tool/package-service/config/write/configure-actions";

const PKG: ConfigurePackage = { name: "demo", dir: "/ws/src/demo", buildType: "ament_cmake" };
const PY_PKG: ConfigurePackage = { name: "pydemo", dir: "/ws/src/pydemo", buildType: "ament_python" };

const empty: BuildTexts = { cmakeText: "", setupPyText: "", packageXmlText: "" };

const CM_BASE = "cmake_minimum_required(VERSION 3.8)\nproject(demo)\n";
const CM_WITH_LAUNCH = CM_BASE + "install(DIRECTORY launch DESTINATION share/${PROJECT_NAME})\n";
const CM_WITH_INTERFACE = CM_BASE
    + "find_package(rosidl_default_generators REQUIRED)\n"
    + "rosidl_generate_interfaces(${PROJECT_NAME}\n  \"msg/Foo.msg\"\n)\n"
    + "ament_export_dependencies(rosidl_default_runtime)\n";
const XML = "<package format='3'>\n  <name>demo</name>\n  <version>0.0.0</version>\n  <export></export>\n</package>\n";
const XML_WITH_IF = XML.replace("</package>", "  <buildtool_depend>rosidl_default_generators</buildtool_depend>\n  <exec_depend>rosidl_default_runtime</exec_depend>\n  <member_of_group>rosidl_interface_packages</member_of_group>\n</package>");
const SETUP_PLAIN = "from setuptools import setup\nsetup(name='pydemo', version='0.1.0')\n";
const SETUP_WITH_LIST = "from setuptools import setup\nsetup(name='pydemo', version='0.1.0', entry_points={'console_scripts': ['old = mod.old:main']})\n";

describe("configure-actions(01 一键配置纯层)", function () {
    it("detectRole:launch/msg/srv/action/python/shell/cpp/unknown", () => {
        assert.strictEqual(detectRole("launch/demo.launch.py"), "launch");
        assert.strictEqual(detectRole("launch/bot.launch.xml"), "launch");
        assert.strictEqual(detectRole("msg/Foo.msg"), "msg");
        assert.strictEqual(detectRole("srv/GetInfo.srv"), "srv");
        assert.strictEqual(detectRole("action/Move.action"), "action");
        assert.strictEqual(detectRole("scripts/run.py"), "python");
        assert.strictEqual(detectRole("scripts/start.sh"), "shell");
        assert.strictEqual(detectRole("src/main.cpp"), "cpp");
        assert.strictEqual(detectRole("include/demo/header.hpp"), "cpp");
        assert.strictEqual(detectRole("README.md"), "unknown");
    });

    it("launch(ament_cmake):未装 launch → 追加 install(DIRECTORY launch);再跑幂等", () => {
        const t: BuildTexts = { ...empty, cmakeText: CM_BASE };
        const p1 = planConfigure(PKG, "launch/demo.launch.py", t);
        assert.strictEqual(p1.role, "launch");
        assert.strictEqual(p1.already, false);
        assert.match(p1.writes[0].content, /install\(DIRECTORY launch/);
        assert.doesNotMatch(p1.writes[0].content, /# \[rde-ros-2 一键配置\]/);
        assert.match(p1.writes[0].content, /# \[rde-ros-2 generated\]/);
        const t2: BuildTexts = { ...empty, cmakeText: CM_WITH_LAUNCH };
        assert.strictEqual(planConfigure(PKG, "launch/demo.launch.py", t2).already, true);
    });

    it("msg(ament_cmake):接口链(CMakeLists+package.xml);已配幂等", () => {
        const t: BuildTexts = { cmakeText: CM_BASE, setupPyText: "", packageXmlText: XML };
        const p1 = planConfigure(PKG, "msg/Foo.msg", t);
        assert.strictEqual(p1.role, "msg");
        assert.strictEqual(p1.already, false);
        const cmakeWrite = p1.writes.find((w) => w.file === "CMakeLists.txt");
        const xmlWrite = p1.writes.find((w) => w.file === "package.xml");
        assert.ok(cmakeWrite);
        assert.match(cmakeWrite!.content, /find_package\(rosidl_default_generators REQUIRED\)/);
        assert.match(cmakeWrite!.content, /rosidl_generate_interfaces/);
        assert.match(cmakeWrite!.content, /msg\/Foo\.msg/);
        assert.ok(xmlWrite);
        assert.match(xmlWrite!.content, /member_of_group>rosidl_interface_packages/);
        assert.match(xmlWrite!.content, /<buildtool_depend>rosidl_default_generators<\/buildtool_depend> <!-- rde-ros-2 generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->/);
        assert.doesNotMatch(xmlWrite!.content, /<!-- 构建工具: /);
        // 幂等:应用后的文本
        const appliedCmake = CM_BASE
            + "\n# [rde-ros-2 一键配置] 接口生成依赖\nfind_package(rosidl_default_generators REQUIRED)\n"
            + "# [rde-ros-2 一键配置] 生成接口\nrosidl_generate_interfaces(${PROJECT_NAME}\n  \"msg/Foo.msg\"\n)\n"
            + "ament_export_dependencies(rosidl_default_runtime)\n";
        const t2: BuildTexts = { cmakeText: appliedCmake, setupPyText: "", packageXmlText: XML_WITH_IF };
        assert.strictEqual(planConfigure(PKG, "msg/Foo.msg", t2).already, true);
    });

    it("msg:两处落点——find_package 入依赖区;rosidl 块(继承模板 DEPENDENCIES)落接口区 ## 头之下", () => {
        const tpl = CM_BASE
            + "find_package(rclcpp REQUIRED)\n"
            + "## 生成 msg/srv/action 文件夹中的接口\n"
            + "# find_package(rosidl_default_generators REQUIRED)\n"
            + "# rosidl_generate_interfaces(${PROJECT_NAME}\n"
            + '#   "msg/MyMsg.msg"\n'
            + "#   DEPENDENCIES std_msgs\n"
            + "# )\n"
            + "# ament_export_dependencies(rosidl_default_runtime)\n"
            + "ament_package()\n";
        const t: BuildTexts = { cmakeText: tpl, setupPyText: "", packageXmlText: XML };
        const p = planConfigure(PKG, "msg/Foo.msg", t);
        const cm = p.writes.find((w) => w.file === "CMakeLists.txt")!.content;
        // find_package 落依赖区(rclcpp 之后),不得进接口模板区
        assert.ok(cm.indexOf("find_package(rclcpp REQUIRED)") < cm.indexOf("find_package(rosidl_default_generators REQUIRED)"));
        assert.ok(cm.indexOf("find_package(rosidl_default_generators REQUIRED)") < cm.indexOf("## 生成 msg/srv/action 文件夹中的接口"));
        // 活跃 rosidl 块在 ## 头之下、注释代码之上;继承模板 DEPENDENCIES
        const iHdr = cm.indexOf("## 生成 msg/srv/action 文件夹中的接口");
        const iActive = cm.indexOf("rosidl_generate_interfaces(${PROJECT_NAME} #");
        const iCmt = cm.indexOf("# find_package(rosidl_default_generators REQUIRED)");
        assert.ok(iHdr < iActive && iActive < iCmt, "新块应在 ## 头下、注释代码上:\n" + cm);
        assert.ok(cm.includes("  DEPENDENCIES std_msgs"));
        assert.strictEqual(cm.split("\n").filter((l) => l.startsWith("rosidl_generate_interfaces(")).length, 1);
        const xmlW = p.writes.find((w) => w.file === "package.xml")!.content;
        assert.match(xmlW, /<buildtool_depend>rosidl_default_generators<\/buildtool_depend> <!-- rde-ros-2 generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->/);
    });

    it("srv 二次追加:并入既有 rosidl 块(DEPENDENCIES 前),不重复开块;幂等", () => {
        const tpl = CM_BASE + "find_package(rclcpp REQUIRED)\n"
            + "find_package(rosidl_default_generators REQUIRED)\n"
            + 'rosidl_generate_interfaces(${PROJECT_NAME}\n  "msg/MyMsg.msg"\n  DEPENDENCIES std_msgs\n)\n'
            + "ament_export_dependencies(rosidl_default_runtime)\n";
        const t: BuildTexts = { cmakeText: tpl, setupPyText: "", packageXmlText: XML_WITH_IF };
        const p = planConfigure(PKG, "srv/GetInfo.srv", t);
        const cm = p.writes.find((w) => w.file === "CMakeLists.txt")!.content;
        assert.strictEqual(cm.split("\n").filter((l) => l.startsWith("rosidl_generate_interfaces(")).length, 1, "不得重复开 rosidl 块");
        const lines = cm.split("\n");
        const iM = lines.indexOf('  "msg/MyMsg.msg"');
        const iS = lines.findIndex((l) => l.startsWith('  "srv/GetInfo.srv"'));
        const iD = lines.indexOf("  DEPENDENCIES std_msgs");
        assert.ok(iM >= 0 && iS > iM && iS < iD, cm);
        const t2: BuildTexts = { cmakeText: cm, setupPyText: "", packageXmlText: XML_WITH_IF };
        assert.strictEqual(planConfigure(PKG, "srv/GetInfo.srv", t2).already, true);
    });

    it("python(ament_cmake):install(PROGRAMS);幂等", () => {
        const t: BuildTexts = { ...empty, cmakeText: CM_BASE };
        const p1 = planConfigure(PKG, "scripts/run.py", t);
        assert.strictEqual(p1.role, "python");
        assert.match(p1.writes[0].content, /install\(PROGRAMS # \[rde-ros-2 generated\]/);
        assert.match(p1.writes[0].content, /  scripts\/run\.py # \[rde-ros-2 generated\]/);
        assert.match(p1.writes[0].content, /  DESTINATION lib\/\$\{PROJECT_NAME\}/);
        const t2: BuildTexts = { ...empty, cmakeText: CM_BASE + "install(PROGRAMS scripts/run.py DESTINATION lib/${PROJECT_NAME})\n" };
        assert.strictEqual(planConfigure(PKG, "scripts/run.py", t2).already, true);
    });

    it("python(ament_cmake) 二次配置:并进既有 PROGRAMS 块(不另开块);幂等", () => {
        const first = planConfigure(PKG, "scripts/run.py", { ...empty, cmakeText: CM_BASE });
        const t2: BuildTexts = { ...empty, cmakeText: first.writes[0].content };
        const p2 = planConfigure(PKG, "scripts/extra.py", t2);
        assert.strictEqual(p2.already, false);
        const out = p2.writes[0].content;
        assert.strictEqual((out.match(/install\(PROGRAMS/g) || []).length, 1, "不应另开第二个 PROGRAMS 块");
        assert.ok(out.includes("  scripts/run.py") && out.includes("  scripts/extra.py"), out);
        const t3: BuildTexts = { ...empty, cmakeText: out };
        assert.strictEqual(planConfigure(PKG, "scripts/run.py", t3).already, true);
        assert.strictEqual(planConfigure(PKG, "scripts/extra.py", t3).already, true);
    });

    it("launch:create 注释模板存在 → 新块落在 ## 说明头之下、注释代码之上", () => {
        const cm = CM_BASE + "## DIRECTORY: 安装整个目录 (递归复制)\n# install(DIRECTORY launch\n#   DESTINATION share/${PROJECT_NAME})\n";
        const p = planConfigure(PKG, "launch/demo.launch.py", { ...empty, cmakeText: cm });
        const out = p.writes[0].content;
        const iHdr = out.indexOf("## DIRECTORY");
        const iNew = out.indexOf("install(DIRECTORY launch #");
        const iCmt = out.indexOf("# install(DIRECTORY launch");
        assert.ok(iHdr >= 0 && iNew >= 0 && iCmt >= 0);
        assert.ok(iHdr < iNew && iNew < iCmt, "新块应在 ## 头之下、注释代码之上:\n" + out);
    });

    it("python(ament_python):无 entry_points → setup() 尾部补参数(整文改写);再次幂等", () => {
        const t: BuildTexts = { ...empty, setupPyText: SETUP_PLAIN };
        const p1 = planConfigure(PY_PKG, "pydemo/talker.py", t, { name: "talker", module: "pydemo.talker", func: "main" });
        assert.strictEqual(p1.writes.length, 1);
        assert.strictEqual(p1.writes[0].mode, "replace");
        assert.match(p1.writes[0].content, /entry_points=\{'console_scripts'/);
        assert.match(p1.writes[0].content, /'talker = pydemo\.talker:main'/);
        const p2 = planConfigure(PY_PKG, "pydemo/talker.py", { ...empty, setupPyText: p1.writes[0].content }, { name: "talker", module: "pydemo.talker", func: "main" });
        assert.strictEqual(p2.already, true);
    });

    it("python(ament_python):已有 console_scripts 列表 → 列表内插入;缺目标 → note", () => {
        const t: BuildTexts = { ...empty, setupPyText: SETUP_WITH_LIST };
        const p1 = planConfigure(PY_PKG, "pydemo/extra.py", t, { name: "extra", module: "pydemo.extra", func: "main" });
        assert.strictEqual(p1.writes[0].mode, "replace");
        assert.match(p1.writes[0].content, /'extra = pydemo\.extra:main'/);
        assert.match(p1.writes[0].content, /'old = mod\.old:main'/);
        const p2 = planConfigure(PY_PKG, "pydemo/extra.py", t);
        assert.ok(p2.note);
        assert.strictEqual(p2.writes.length, 0);
    });

    it("python(ament_python):参数间夹整行中文注释(真实 setup.py 形态)→ 列表内插入,不重复补 entry_points;二次并入;幂等", () => {
        const SETUP = [
            "from setuptools import find_packages, setup",
            "",
            "# 包名 (与 package.xml 的 <name> 一致)",
            "package_name = 'pydemo'",
            "",
            "setup(",
            "    name=package_name,",
            "    version='0.0.0',",
            "    ##########",
            "    ## 模块收集 ##",
            "    ##########",
            "    # 收集 pydemo/ 目录下的 Python 模块",
            "    packages=find_packages(exclude=['test']),",
            "    ##########",
            "    ## 节点可执行入口 ##",
            "    ##########",
            "    # console_scripts 定义命令名与模块函数入口",
            "    # 格式: '命令名 = 模块路径.函数名'",
            "    entry_points={",
            "        'console_scripts': [",
            "            'old = pydemo.old:main',",
            "        ],",
            "        # 新增节点示例:",
            "        # 'node_name = pydemo.node:main',",
            "    },",
            ")",
            "",
        ].join("\n");
        const t: BuildTexts = { ...empty, setupPyText: SETUP };
        const p1 = planConfigure(PY_PKG, "pydemo/extra.py", t, { name: "extra", module: "pydemo.extra", func: "main" });
        const out1 = p1.writes[0].content;
        assert.strictEqual((out1.match(/entry_points/g) || []).length, 1, "不得重复补 entry_points:\n" + out1);
        assert.match(out1, /'extra = pydemo\.extra:main'/);
        assert.match(out1, /'old = pydemo\.old:main'/);
        const t2: BuildTexts = { ...empty, setupPyText: out1 };
        const p2 = planConfigure(PY_PKG, "pydemo/other.py", t2, { name: "other", module: "pydemo.other", func: "main" });
        const out2 = p2.writes[0].content;
        assert.strictEqual((out2.match(/entry_points/g) || []).length, 1, "二次配置不得新增 entry_points:\n" + out2);
        assert.match(out2, /'other = pydemo\.other:main'/);
        assert.ok(out2.indexOf("'old") < out2.indexOf("'extra") && out2.indexOf("'extra") < out2.indexOf("'other"));
        // 追加条目应自带尾逗号 + 行内扩展生成标注;不再对整文件 import 行打标
        const extraLine1 = out1.split("\n").find((l) => l.includes("'extra = pydemo.extra:main'"))!;
        assert.ok(/, # \[rde-ros-2 generated\]/.test(extraLine1), "追加条目应自带尾逗号+行内标注:\n" + extraLine1);
        assert.ok(extraLine1.trimStart().startsWith("'extra"), "条目应单行独立:\n" + extraLine1);
        assert.ok(!/from setuptools[^\n]*# \[rde-ros-2 generated\]/.test(out1), "不应再对整文件 import 行打标:\n" + out1);
        // 第二次追加为纯行插入:上一次追加的行必须原样
        const extraLine2 = out2.split("\n").find((l) => l.includes("'extra = pydemo.extra:main'"))!;
        assert.strictEqual(extraLine2, extraLine1, "纯行追加不应改写既有条目行");
        const t3: BuildTexts = { ...empty, setupPyText: out2 };
        assert.strictEqual(planConfigure(PY_PKG, "pydemo/extra.py", t3, { name: "extra", module: "pydemo.extra", func: "main" }).already, true);
    });

    it("cpp(ament_cmake):add_executable 骨架;幂等", () => {
        const t: BuildTexts = { ...empty, cmakeText: CM_BASE };
        const p1 = planConfigure(PKG, "src/main.cpp", t);
        assert.strictEqual(p1.role, "cpp");
        assert.match(p1.writes[0].content, /add_executable\(main src\/main\.cpp\)/);
        const t2: BuildTexts = { ...empty, cmakeText: CM_BASE + "add_executable(main src/main.cpp)\n" };
        assert.strictEqual(planConfigure(PKG, "src/main.cpp", t2).already, true);
    });

    it("cpp(ament_cmake):骨架 + 目标并入 install(TARGETS)(Q2);二次 cpp 并入同一 TARGETS 块", () => {
        const t: BuildTexts = { ...empty, cmakeText: CM_BASE };
        const p1 = planConfigure(PKG, "src/main.cpp", t);
        const out = p1.writes[0].content;
        assert.ok(out.includes("add_executable(main src/main.cpp)"), out);
        assert.ok(out.includes("install(TARGETS"), out);
        assert.ok(out.includes("  main"), out);
        const t2: BuildTexts = { ...empty, cmakeText: out };
        const p2 = planConfigure(PKG, "src/talker.cpp", t2);
        const out2 = p2.writes[0].content;
        assert.strictEqual((out2.match(/install\(TARGETS/g) || []).length, 1, "不应另开第二个 TARGETS 块");
        assert.ok(out2.includes("  main") && out2.includes("  talker"), out2);
    });

    it("python(ament_python):entry_points=<标识符>(模块级变量/类型注解)→ 加法式合并表达式,变量零改动;二次纯行;幂等", () => {
        const SETUP = [
            "from typing import Dict, List",
            "entry_points: Dict[str, List[str]] = {",
            "    'console_scripts': [",
            "        'old = p.old:main',",
            "    ],",
            "},",
            "setup(name='p', entry_points=entry_points)",
            "",
        ].join("\n");
        const t: BuildTexts = { ...empty, setupPyText: SETUP };
        const p1 = planConfigure(PY_PKG, "pydemo/extra.py", t, { name: "extra", module: "pydemo.extra", func: "main" });
        const out1 = p1.writes[0].content;
        assert.ok(out1.includes("entry_points={\n"), "调用点应改为加法合并表达式:\n" + out1);
        assert.ok(out1.includes("**entry_points,"), "应含变量展开:\n" + out1);
        assert.ok(out1.includes('"console_scripts": entry_points["console_scripts"] + ['), out1);
        assert.ok(out1.includes("'extra = pydemo.extra:main', # [rde-ros-2 generated"), out1);
        assert.strictEqual((out1.match(/^entry_points: Dict\[str, List\[str\]\] = {/m) || []).length, 1, "变量定义行应零改动:\n" + out1);
        const t2: BuildTexts = { ...empty, setupPyText: out1 };
        const p2 = planConfigure(PY_PKG, "pydemo/other.py", t2, { name: "other", module: "pydemo.other", func: "main" });
        const out2 = p2.writes[0].content;
        assert.strictEqual((out2.match(/\*\*entry_points/g) || []).length, 1, "不得叠加第二层展开:\n" + out2);
        assert.ok(out2.includes("'other = pydemo.other:main', # [rde-ros-2 generated"), out2);
        const l1 = out1.split("\n").find((l) => l.includes("'extra = pydemo.extra:main'"));
        const l2 = out2.split("\n").find((l) => l.includes("'extra = pydemo.extra:main'"));
        assert.ok(!!l1 && l1 === l2, "二次追加不得改写上次行");
        const t3: BuildTexts = { ...empty, setupPyText: out2 };
        assert.strictEqual(planConfigure(PY_PKG, "pydemo/extra.py", t3, { name: "extra", module: "pydemo.extra", func: "main" }).already, true);
    });

    it("不支持:未知类型 / buildType 缺失", () => {
        assert.ok(planConfigure(PKG, "notes.txt", empty).note);
        assert.ok(planConfigure({ name: "x", dir: "/x", buildType: undefined }, "src/a.cpp", empty).note);
    });
});

const NOW = new Date(2026, 8, 3, 19, 46, 0); // 2026-09-03 19:46:00

describe("stamp 扩展生成标志", function () {
    it("时间戳精确到分(补零)", () => {
        assert.strictEqual(stampTimestamp(NOW), "2026-09-03 19:46");
        assert.strictEqual(stampTimestamp(new Date(2026, 0, 5, 9, 7, 30)), "2026-01-05 09:07");
    });

    it("cmake/setup 行尾注释文案", () => {
        assert.strictEqual(stampComment("cmake", NOW), "# [rde-ros-2 generated] 2026-09-03 19:46");
        assert.strictEqual(stampComment("setup", NOW), "# [rde-ros-2 generated] 2026-09-03 19:46");
    });

    it("package.xml 独立 XML 注释行", () => {
        assert.strictEqual(stampComment("packageXml", NOW), "<!-- rde-ros-2 generated 2026-09-03 19:46 -->");
    });

    it("单行片段:内容行尾追加(补一个空格)", () => {
        const out = stampSnippet("cmake", "install(DIRECTORY launch DESTINATION share/${PROJECT_NAME})", NOW);
        assert.ok(out.endsWith(") # [rde-ros-2 generated] 2026-09-03 19:46"));
    });

    it("多行片段:标志贴首个非空内容行行尾,其余行原样", () => {
        const out = stampSnippet("cmake", [
            "install(DIRECTORY launch",
            "  DESTINATION share/${PROJECT_NAME}",
            ")",
            "",
        ].join("\n"), NOW);
        const lines = out.split("\n");
        assert.ok(lines[0].endsWith("launch # [rde-ros-2 generated] 2026-09-03 19:46"), lines[0]);
        assert.strictEqual(lines[1], "  DESTINATION share/${PROJECT_NAME}");
        assert.strictEqual(lines[2], ")");
    });

    it("首内容行已带扩展生成标注 → 不再叠加(标注幂等)", () => {
        const out = stampSnippet("cmake", "from setuptools import setup # [rde-ros-2 generated] 2026-09-03 22:13\n", NOW);
        assert.ok(!out.includes("2026-09-03 22:13 # [rde-ros-2 generated]"), "不应在同行叠加第二个标注:\n" + out);
        assert.ok(out.includes("# [rde-ros-2 generated] 2026-09-03 22:13"));
    });

    it("片段以空行开头 → 跳过到首个非空行", () => {
        const out = stampSnippet("cmake", [
            "",
            "# [rde-ros-2 一键配置] 安装 launch 目录",
            "install(DIRECTORY launch)",
        ].join("\n"), NOW);
        const lines = out.split("\n");
        assert.strictEqual(lines[1], "# [rde-ros-2 一键配置] 安装 launch 目录");
        assert.ok(lines[2].endsWith("# [rde-ros-2 generated] 2026-09-03 19:46"));
    });

    it("package.xml:片段后追加独立注释行(自动补换行)", () => {
        const out = stampSnippet("packageXml",
            "  <buildtool_depend>rosidl_default_generators</buildtool_depend>\n"
            + "  <exec_depend>rosidl_default_runtime</exec_depend>\n", NOW);
        assert.ok(out.endsWith("<!-- rde-ros-2 generated 2026-09-03 19:46 -->\n"));
    });

    it("空/纯空白片段原样返回", () => {
        assert.strictEqual(stampSnippet("cmake", "", NOW), "");
        assert.strictEqual(stampSnippet("cmake", "  \n\n", NOW), "  \n\n");
    });
});
