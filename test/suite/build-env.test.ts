/**
 * build-env 单测(2026-09-22 新增,构建专用环境)。
 *
 * 无头可跑:npx mocha out/test/suite/build-env.test.js
 * 被测模块零 vscode 依赖(只依赖 host/fs 的 getWorkspaceRoot 与 env-compare 的纯函数)→ 但 host/fs 会 require vscode,
 * 故仍先装 stub 再 require。
 *
 * 覆盖:剔除本工作区条目(install 各布局 / build/develop 注入)、**保留其它工作区与系统**(防"剔过头"这一真正的毒)、
 * 过滤后为空 → 整键删除、非路径变量不动、标量前缀变量、空工作区根与空环境、Windows 分隔符(*用 path.delimiter 构造*)、
 * 以及"不修改原快照"这一不变量。
 */

import * as assert from "assert";
import * as path from "path";

import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../../src/ros2/environment/build-env") as typeof import("../../src/ros2/environment/build-env");

const WS = process.platform === "win32" ? "C:\\ws" : "/ws";
const OTHER = process.platform === "win32" ? "C:\\other_ws" : "/other_ws";
const SYS = process.platform === "win32" ? "C:\\opt\\ros\\humble" : "/opt/ros/humble";
const D = path.delimiter;
const join = (...p: string[]): string => p.join(path.sep === "\\" ? "\\" : "/");

describe("build-env:剔除本工作区条目(构建专用环境)", () => {
    it("isolated:从 AMENT_PREFIX_PATH 剔掉 <ws>/install/<pkg>,系统与其它工作区保留", () => {
        const env = {
            AMENT_PREFIX_PATH: [join(WS, "install", "p10"), join(OTHER, "install", "foo"), SYS].join(D),
        };
        const out = mod.stripWorkspaceEntries(env, WS);
        assert.deepStrictEqual(out.AMENT_PREFIX_PATH.split(D), [join(OTHER, "install", "foo"), SYS]);
    });

    it("merged:方案是 <ws>/install 本身时同样剔除(前缀+子路径匹配)", () => {
        const env = {
            AMENT_PREFIX_PATH: [WS, join(WS, "install"), SYS].join(D),
            CMAKE_PREFIX_PATH: join(WS, "install"),
        };
        const out = mod.stripWorkspaceEntries(env, WS);
        assert.strictEqual(out.AMENT_PREFIX_PATH, SYS, "工作区根与 <ws>/install 都剔掉");
        assert.strictEqual(out.CMAKE_PREFIX_PATH, undefined, "过滤后为空 → 整键删除");
    });

    it("COLCON_PREFIX_PATH 等于 <ws>/install → 整键删除(不留空串)", () => {
        const out = mod.stripWorkspaceEntries({ COLCON_PREFIX_PATH: join(WS, "install") }, WS);
        assert.strictEqual("COLCON_PREFIX_PATH" in out, false);
    });

    it("PATH/PYTHONPATH:剔 <ws>/install 与 <ws>/build(develop 注入),系统条目保留", () => {
        const env = {
            PATH: [join(WS, "install", "p10", "bin"), "/usr/bin", join(WS, "build", "ggg")].join(D),
            PYTHONPATH: [join(WS, "build", "ggg"), "/usr/lib/python3/dist-packages"].join(D),
        };
        const out = mod.stripWorkspaceEntries(env, WS);
        assert.deepStrictEqual(out.PATH.split(D), ["/usr/bin"]);
        assert.deepStrictEqual(out.PYTHONPATH.split(D), ["/usr/lib/python3/dist-packages"]);
    });

    it("标量前缀变量 AMENT_CURRENT_PREFIX 落在工作区内 → 删除;落在外部 → 保留", () => {
        assert.strictEqual(
            "AMENT_CURRENT_PREFIX" in mod.stripWorkspaceEntries({ AMENT_CURRENT_PREFIX: join(WS, "install", "x") }, WS),
            false);
        assert.strictEqual(
            mod.stripWorkspaceEntries({ AMENT_CURRENT_PREFIX: SYS }, WS).AMENT_CURRENT_PREFIX, SYS);
    });

    it("非路径型变量一律不动(ROS_DISTRO / 普通字符串 / 含路径的说明文本)", () => {
        const env = {
            ROS_DISTRO: "humble",
            ROS_VERSION: "2",
            SOME_NOTE: `see ${WS}/install/p10 for details`,
        };
        const out = mod.stripWorkspaceEntries(env, WS);
        assert.deepStrictEqual(out, env);
    });

    it("边界:工作区根为空 → 原样浅拷贝;环境为空/undefined → 空对象", () => {
        const env = { AMENT_PREFIX_PATH: SYS };
        assert.deepStrictEqual(mod.stripWorkspaceEntries(env, ""), env);
        assert.deepStrictEqual(mod.stripWorkspaceEntries(undefined, WS), {});
    });

    it("不修改原快照(运行/调试用的 getEnv 保持原样)", () => {
        const env = { AMENT_PREFIX_PATH: [join(WS, "install", "p"), SYS].join(D) };
        const before = env.AMENT_PREFIX_PATH;
        mod.stripWorkspaceEntries(env, WS);
        assert.strictEqual(env.AMENT_PREFIX_PATH, before);
    });

    it("Windows 分隔符由 path.delimiter 决定(用本机分隔符构造即可跨平台)", () => {
        const env = { AMENT_PREFIX_PATH: [join(WS, "install", "p"), SYS].join(D) };
        const out = mod.stripWorkspaceEntries(env, WS);
        assert.strictEqual(out.AMENT_PREFIX_PATH, SYS);
        assert.strictEqual(out.AMENT_PREFIX_PATH.includes(D), false, "只剩一条时不应残留分隔符");
    });
});
