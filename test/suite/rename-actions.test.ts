// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file rename-actions.test.ts
 * 02 工作包重命名【纯动作层】无头单测(2026-09-03)。
 * 覆盖:validatePackageName / package.xml <name> 结构改写 / CMake project() 改写 /
 *       setup.py name= 改写 / 值已一致跳过 / 找不到声明 note。
 * 运行:npm run test-compile && npx mocha out/test/suite/rename-actions.test.js
 */

import * as assert from "assert";
import { planRenameByFolder, validatePackageName } from "../../src/build-tool/package-service/config/write/rename-actions";

const XML = "<package format='3'>\n  <name>old_name</name>\n  <version>0.0.0</version>\n</package>\n";
const CM = "cmake_minimum_required(VERSION 3.8)\nproject(old_name)\nadd_executable(x src/main.cpp)\n";
const PY = "from setuptools import setup\nsetup(name='old_name', version='0.1.0')\n";

describe("rename-actions(02 重命名纯层)", function () {
    it("validatePackageName:合法/大写提示/非法", () => {
        assert.strictEqual(validatePackageName("new_name"), undefined);
        assert.ok(validatePackageName("NewName") && validatePackageName("NewName")!.includes("大写"));
        assert.ok(validatePackageName("1abc"));
        assert.ok(validatePackageName("has Upper"));
        assert.ok(validatePackageName("a-b"));
    });

    it("package.xml <name> 结构改写;值已一致跳过", () => {
        const p = planRenameByFolder("new_name", { packageXml: XML, cmakeText: "", setupPyText: "" });
        assert.strictEqual(p.changed, true);
        assert.strictEqual(p.files.length, 1);
        assert.strictEqual(p.files[0].file, "package.xml");
        assert.match(p.files[0].content!, /<name>new_name<\/name>/);
        // 已一致 → 无改写
        const same = planRenameByFolder("old_name", { packageXml: XML, cmakeText: "", setupPyText: "" });
        assert.strictEqual(same.changed, false);
    });

    it("CMakeLists project() 改写(仅 project 不一致场景:package.xml 已一致)", () => {
        const p = planRenameByFolder("new_name", {
            packageXml: XML.replace("old_name", "new_name"),
            cmakeText: CM,
            setupPyText: "",
        });
        assert.strictEqual(p.changed, true);
        assert.strictEqual(p.files[0].file, "CMakeLists.txt");
        assert.match(p.files[0].content!, /project\(new_name\)/);
        assert.ok(!p.files[0].content!.includes("project(old_name)"));
    });

    it("setup.py name= 改写(单引号/双引号)", () => {
        const p = planRenameByFolder("new_name", { packageXml: "", cmakeText: "", setupPyText: PY });
        assert.strictEqual(p.files[0].file, "setup.py");
        assert.match(p.files[0].content!, /name='new_name'/);
        const p2 = planRenameByFolder("new_name", { packageXml: "", cmakeText: "", setupPyText: PY.replace("'old_name'", '\"old_name\"') });
        assert.match(p2.files[0].content!, /name='new_name'/);
    });

    it("找不到声明 → note 且无写入", () => {
        const p = planRenameByFolder("new_name", { packageXml: "hello world", cmakeText: "no project here", setupPyText: "x=1" });
        assert.strictEqual(p.changed, false);
        assert.ok(p.note);
    });

    it("多文件同时不一致 → 全部改写", () => {
        const p = planRenameByFolder("new_name", { packageXml: XML, cmakeText: CM, setupPyText: PY });
        assert.strictEqual(p.files.length, 3);
        assert.deepStrictEqual(p.files.map((f) => f.file).sort(), ["CMakeLists.txt", "package.xml", "setup.py"]);
    });
});
