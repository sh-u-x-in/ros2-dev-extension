// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-core-classify.test.ts
 * scan/ignore-classify 分类纯函数 + package-scan 扫描范围判定单元测试(2026-09-06 §12.2/§12.10):
 *  - classifyIgnoreReason:same-dir / ancestor / overlap / 根自身是包 / 多阻挡"自根向下首个"优先级;
 *  - classifyEntries:hasColconIgnore 与 ignoredBy 一致派生;
 *  - isDirScanExcluded:点目录 / 内置产物目录名 / buildExcludeFolders 路径。
 * 纯 TS(classify 零运行时依赖;package-scan 经 walk 依赖 vscode → 先装 stub 再 require)。
 */

import * as assert from "assert";
import * as path from "path";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";
import type { PackageScanEntry } from "../../src/build-tool/package-core/scan/package-scan";

// classify 模块只 import type(编译期擦除),无运行时 vscode 依赖,可直接导入
const { classifyIgnoreReason, classifyEntries, isVisibleEntry } =
    require("../../src/build-tool/package-core/scan/ignore-classify") as typeof import("../../src/build-tool/package-core/scan/ignore-classify");

// package-scan(含 isDirScanExcluded)经 walk → vscode → 无头先装 stub 再 require
installVscodeStub();
const req = createRequire(__filename);
const { isDirScanExcluded } = req("../../src/build-tool/package-core/scan/package-scan") as typeof import("../../src/build-tool/package-core/scan/package-scan");

// 与实现同一形态:path.normalize(win 反斜杠)比较键
const norm = (p: string): string => path.normalize(p);

describe("package-core ignore-classify(池 × M 分类,§12.2)", () => {
    const R = "/ws";
    const markers = (list: string[]) => new Set(list.map(norm));
    const pkgs = (list: string[]) => new Set(list.map(norm));

    it("无标记无包祖先 → undefined(visible)", () => {
        assert.strictEqual(classifyIgnoreReason("/ws/src/a", markers([]), pkgs(["/ws/src/b"]), R), undefined);
    });

    it("自身 COLCON_IGNORE → same-dir(即使自身也是合法包,标记优先)", () => {
        assert.strictEqual(classifyIgnoreReason("/ws/src/a", markers(["/ws/src/a"]), pkgs(["/ws/src/a"]), R), "same-dir");
    });

    it("祖先 COLCON_IGNORE → ancestor(整棵子树)", () => {
        assert.strictEqual(classifyIgnoreReason("/ws/src/v/x/y", markers(["/ws/src/v"]), pkgs([]), R), "ancestor");
    });

    it("根自身是合法包 → 其下全部 overlap;根包自身可见", () => {
        const allPkgs = pkgs(["/ws", "/ws/src/a"]);
        assert.strictEqual(classifyIgnoreReason("/ws/src/a", markers([]), allPkgs, R), "overlap");
        assert.strictEqual(classifyIgnoreReason("/ws", markers([]), allPkgs, R), undefined);
    });

    it("嵌套合法包(非根)→ 子包 overlap", () => {
        assert.strictEqual(
            classifyIgnoreReason("/ws/src/outer/inner", markers([]), pkgs(["/ws/src/outer", "/ws/src/outer/inner"]), R),
            "overlap",
        );
    });

    it("多阻挡:自根向下第一个阻挡者生效(先于更深阻挡)", () => {
        // 祖先 src/v 有标记;更深 src/v/outer 是合法包 → 浅层标记先挡 → ancestor
        assert.strictEqual(
            classifyIgnoreReason("/ws/src/v/outer/inner", markers(["/ws/src/v"]), pkgs(["/ws/src/v/outer"]), R),
            "ancestor",
        );
        // 祖先无标记但 src/v/outer 是包 → overlap
        assert.strictEqual(
            classifyIgnoreReason("/ws/src/v/outer/inner", markers([]), pkgs(["/ws/src/v/outer"]), R),
            "overlap",
        );
    });

    it("同目录同时是包且有标记、上方无阻挡 → same-dir(标记优先于自身是包)", () => {
        assert.strictEqual(
            classifyIgnoreReason("/ws/src/x", markers(["/ws/src/x"]), pkgs(["/ws/src/x"]), R),
            "same-dir",
        );
    });

    it("classifyEntries:hasColconIgnore 与 ignoredBy 一致派生(only same-dir 置 true)", () => {
        const mk = (dir: string, valid = true): PackageScanEntry => ({
            dir, name: "n", buildType: "ament_python", hasColconIgnore: false, parentIsSrc: true, isValid: valid,
        });
        const out = classifyEntries(
            [mk("/ws/src/a"), mk("/ws/src/v/b"), mk("/ws/src/outer/inner"), mk("/ws/src/v")],
            ["/ws/src/v", "/ws/src/a"],
            R,
        );
        const byDir = new Map(out.map((e) => [e.dir, e]));
        assert.strictEqual(byDir.get("/ws/src/a")!.ignoredBy, "same-dir");
        assert.strictEqual(byDir.get("/ws/src/a")!.hasColconIgnore, true);
        assert.strictEqual(byDir.get("/ws/src/v/b")!.ignoredBy, "ancestor");
        assert.strictEqual(byDir.get("/ws/src/v/b")!.hasColconIgnore, false);
        // /ws/src/outer 本身不是包(未在列表)→ inner 无阻挡 → visible
        assert.strictEqual(byDir.get("/ws/src/outer/inner")!.ignoredBy, undefined);
        assert.strictEqual(byDir.get("/ws/src/v")!.ignoredBy, "same-dir");
        // visible 谓词
        assert.ok(out.filter((e) => e.dir === "/ws/src/outer/inner").every(isVisibleEntry));
        assert.ok(!out.filter((e) => e.dir === "/ws/src/v/b").some(isVisibleEntry));
    });

    it("isDirScanExcluded:点目录 / 内置产物名 / 配置排除路径(§12.10-B)", () => {
        const ex = ["/ws/vendor2"];
        const cases: Array<[string, boolean]> = [
            ["/ws/src/a", false],
            ["/ws/src/.hidden/a", true],     // 点目录任意层级
            ["/ws/src/a/.gh/x", true],
            ["/ws/a/install/b", true],       // 内置产物名任意层级
            ["/ws/node_modules/pkg", true],
            ["/ws/vendor2/deep", true],      // buildExcludeFolders
            ["/ws", false],
        ];
        for (const [dir, expect] of cases) {
            assert.strictEqual(isDirScanExcluded("/ws", dir, ex), expect, `dir=${dir}`);
        }
    });
});
