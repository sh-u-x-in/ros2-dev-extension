/**
 * distro-templates 测试(无头 mocha):发行版路径模板注册表 + 版本发现(观测优先,表兜底)
 *
 * 验证(2026-09-28 VD,差异事实源=手工重设计/gen-静态路径核实-2026-09-15.md):
 *  - 模板表覆盖全部 KNOWN 发行版且无 rolling(2026-09-28 用户裁定维持排除);humble 行即 HUMBLE_PATH_TEMPLATE
 *  - resolveDistroTemplate:已知查行,未知/rolling/undefined 回落 DEFAULT
 *  - observePythonAbi:PYTHONPATH 里 /opt/ros 系统段优先、任意段兜底;非整段不认;无 env → undefined
 *  - resolveDistroConfig:观测覆盖行内 ABI 且 cmakePythonPurelib 的 ABI 段连带替换(iron+noble 场景);
 *    未知发行版/无 env 整体回落 DEFAULT(观测不组合,R2)
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/distro-templates.test.js
 */

import * as assert from "assert";
import * as path from "path";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";

// state.ts(取 KNOWN_ROS2_DISTROS 断言表覆盖)顶层 import vscode → 无头环境先装 stub
installVscodeStub();
const req = createRequire(__filename);
const dt = req("../../src/build-tool/package-service/config/gen/distro-templates") as any;
const utils = req("../../src/build-tool/package-service/config/gen/intellisense-utils") as any;
const state = req("../../src/ros2/environment/state") as any;

describe("distro-templates 发行版模板与版本发现", () => {

    describe("模板表", () => {
        it("覆盖全部 KNOWN 发行版且不含 rolling;humble 行即 HUMBLE_PATH_TEMPLATE;关键行形态正确", () => {
            for (const d of state.KNOWN_ROS2_DISTROS) {
                assert.ok(dt.DISTRO_PATH_TEMPLATES[d], `KNOWN 发行版 ${d} 应有模板行`);
            }
            assert.strictEqual(Object.keys(dt.DISTRO_PATH_TEMPLATES).length, state.KNOWN_ROS2_DISTROS.size, "表键应与 KNOWN 集合精确一致");
            assert.ok(!("rolling" in dt.DISTRO_PATH_TEMPLATES), "rolling 按 2026-09-28 裁定维持排除");
            assert.strictEqual(dt.DISTRO_PATH_TEMPLATES.humble, utils.HUMBLE_PATH_TEMPLATE);
            assert.strictEqual(dt.DISTRO_PATH_TEMPLATES.iron.pythonAbi, "python3.10");
            assert.strictEqual(dt.DISTRO_PATH_TEMPLATES.iron.cmakePythonPurelib, "lib/python3.10/site-packages");
            assert.strictEqual(dt.DISTRO_PATH_TEMPLATES.jazzy.pythonAbi, "python3.12");
            assert.strictEqual(dt.DISTRO_PATH_TEMPLATES.jazzy.cmakePythonPurelib, "lib/python3.12/site-packages");
            assert.strictEqual(dt.DISTRO_PATH_TEMPLATES.dashing.pythonAbi, "python3.6");
            assert.strictEqual(dt.DISTRO_PATH_TEMPLATES.dashing.cmakePythonPurelib, "local/lib/python3.6/dist-packages");
        });

        it("resolveDistroTemplate:已知发行版查行;rolling/未知/undefined 回落 DEFAULT", () => {
            assert.strictEqual(dt.resolveDistroTemplate("jazzy"), dt.DISTRO_PATH_TEMPLATES.jazzy);
            assert.strictEqual(dt.resolveDistroTemplate("humble"), utils.HUMBLE_PATH_TEMPLATE);
            assert.strictEqual(dt.resolveDistroTemplate("rolling"), utils.DEFAULT_PATH_TEMPLATE);
            assert.strictEqual(dt.resolveDistroTemplate("unknown-distro"), utils.DEFAULT_PATH_TEMPLATE);
            assert.strictEqual(dt.resolveDistroTemplate(undefined), utils.DEFAULT_PATH_TEMPLATE);
        });
    });

    describe("observePythonAbi 观测", () => {
        it("优先 /opt/ros 系统段;无系统段取任意段兜底;无 ABI 段/无 env → undefined", () => {
            const humble = { PYTHONPATH: ["/opt/ros/humble/lib/python3.10/site-packages", "/opt/ros/humble/local/lib/python3.10/dist-packages"].join(path.delimiter) };
            assert.strictEqual(dt.observePythonAbi(humble), "python3.10");
            const ironNoble = { PYTHONPATH: ["/home/u/ws/build/x", "/opt/ros/iron/lib/python3.12/site-packages"].join(path.delimiter) };
            assert.strictEqual(dt.observePythonAbi(ironNoble), "python3.12");
            // 无 /opt/ros 段 → 任意段兜底(venv 等)
            assert.strictEqual(dt.observePythonAbi({ PYTHONPATH: "/home/u/.venv/lib/python3.11/site-packages" }), "python3.11");
            // Windows 反斜杠路径同样可观测(落点无版本段时自然观测不到,见手稿 §5)
            assert.strictEqual(dt.observePythonAbi({ PYTHONPATH: "C:\\opt\\ros\\humble\\lib\\python3.10\\site-packages" }), "python3.10");
            // 非整段(python3.10abc)不认
            assert.strictEqual(dt.observePythonAbi({ PYTHONPATH: "/opt/ros/humble/lib/python3.10abc/site-packages" }), undefined);
            assert.strictEqual(dt.observePythonAbi({ PYTHONPATH: "/ws/build/x" }), undefined);
            assert.strictEqual(dt.observePythonAbi({}), undefined);
            assert.strictEqual(dt.observePythonAbi(undefined), undefined);
        });
    });

    describe("resolveDistroConfig 组合", () => {
        it("观测覆盖行内 ABI 且 cmakePythonPurelib 的 ABI 段连带替换(iron+noble 场景)", () => {
            const env = { ROS_DISTRO: "iron", PYTHONPATH: ["/opt/ros/iron/lib/python3.12/site-packages"].join(path.delimiter) };
            const cfg = dt.resolveDistroConfig(env);
            assert.strictEqual(cfg.abiSource, "observed");
            assert.strictEqual(cfg.distro, "iron");
            assert.deepStrictEqual(cfg.tpl, { distro: "iron", pythonAbi: "python3.12", cmakePythonPurelib: "lib/python3.12/site-packages" });
        });

        it("观测 = 表值 → 同值(humble 零行为变化);无观测 → 表值(table)", () => {
            const env = { ROS_DISTRO: "humble", PYTHONPATH: ["/opt/ros/humble/local/lib/python3.10/dist-packages"].join(path.delimiter) };
            const cfg = dt.resolveDistroConfig(env);
            assert.strictEqual(cfg.abiSource, "observed");
            assert.deepStrictEqual(cfg.tpl, { distro: "humble", pythonAbi: "python3.10", cmakePythonPurelib: "local/lib/python3.10/dist-packages" });
            const ironNoAbi = { ROS_DISTRO: "iron", PYTHONPATH: "/ws/build/x" };
            const got = dt.resolveDistroConfig(ironNoAbi);
            assert.strictEqual(got.abiSource, "table");
            assert.strictEqual(got.tpl.pythonAbi, "python3.10");
            assert.strictEqual(got.tpl.cmakePythonPurelib, "lib/python3.10/site-packages");
        });

        it("purelib 形态沿用表行、仅 ABI 段替换(humble 行 + 观测 3.12 → local/lib/python3.12/dist-packages)", () => {
            const env = { ROS_DISTRO: "humble", PYTHONPATH: ["/opt/ros/humble/lib/python3.12/site-packages"].join(path.delimiter) };
            const cfg = dt.resolveDistroConfig(env);
            assert.strictEqual(cfg.tpl.pythonAbi, "python3.12");
            assert.strictEqual(cfg.tpl.cmakePythonPurelib, "local/lib/python3.12/dist-packages");
        });

        it("未知发行版/rolling/无 env → 整体 DEFAULT,观测不参与组合(R1/R2)", () => {
            const noble = { PYTHONPATH: ["/opt/ros/rolling/lib/python3.12/site-packages"].join(path.delimiter) };
            assert.deepStrictEqual(dt.resolveDistroConfig({ ROS_DISTRO: "rolling", ...noble }),
                { tpl: utils.DEFAULT_PATH_TEMPLATE, abiSource: "default", distro: "rolling" });
            assert.deepStrictEqual(dt.resolveDistroConfig({ ROS_DISTRO: "mystery", ...noble }),
                { tpl: utils.DEFAULT_PATH_TEMPLATE, abiSource: "default", distro: "mystery" });
            assert.deepStrictEqual(dt.resolveDistroConfig(undefined),
                { tpl: utils.DEFAULT_PATH_TEMPLATE, abiSource: "default", distro: undefined });
            assert.deepStrictEqual(dt.resolveDistroConfig({}),
                { tpl: utils.DEFAULT_PATH_TEMPLATE, abiSource: "default", distro: undefined });
        });
    });

    describe("includeLayout 头文件布局分派(create 域消费)", () => {
        it("humble~lyrical=double;dashing~galactic=single;未知/rolling/undefined=double 兜底", () => {
            for (const d of ["humble", "iron", "jazzy", "kilted", "lyrical"]) {
                assert.strictEqual(dt.resolveIncludeLayout(d), "double", d);
            }
            for (const d of ["dashing", "eloquent", "foxy", "galactic"]) {
                assert.strictEqual(dt.resolveIncludeLayout(d), "single", d);
            }
            assert.strictEqual(dt.resolveIncludeLayout("rolling"), "double");
            assert.strictEqual(dt.resolveIncludeLayout(undefined), "double");
            // 表键与模板表同覆盖(9 发行版)
            assert.deepStrictEqual(Object.keys(dt.DISTRO_INCLUDE_LAYOUT).sort(), Object.keys(dt.DISTRO_PATH_TEMPLATES).sort());
        });
    });
});
// 修改时间:2026-09-28(VD-3 建档:模板表覆盖/回落/观测提取/组合覆盖与不组合语义,9 例)
