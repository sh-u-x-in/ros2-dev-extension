// Licensed under the MIT License.

/**
 * @file run-readiness.test.ts
 * 一键运行「安装侧就绪性拆分」纯函数测试(2026-10-13 方案甲,用户裁定)。
 *
 * 背景:跳转表全部来自 build 侧(有编译无安装也放行,而侧边栏 = install 侧观察、什么都不显示,
 * 两套证据矛盾);splitOwnerReadiness 按**侧边栏同一行口径**(lib 区 installed 可执行行)
 * 把属主分为 runnable / compiledNotInstalled,供上层给出两种不同警告。
 * 无头运行:npm run test-compile && npx mocha out/test/suite/run-readiness.test.js
 */

import * as assert from "assert";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";

// 必须在 require 被测模块之前安装 vscode stub(被测模块顶层 import vscode,无头环境不可解析)
installVscodeStub();
const req = createRequire(__filename);
const rds = req("../../src/build-tool/package-service/run/run-data-source") as any;

/** 造一行(lib 区可执行 installed 行的合理默认) */
const row = (over: Record<string, unknown> = {}) => ({
    area: "lib", name: "talker", status: "installed", executable: true, ...over,
});
const view = (pkg: string, rows: Record<string, unknown>[]) => ({ pkg, rows });

describe("splitOwnerReadiness(方案甲:一键运行安装侧就绪预检)", () => {
    // 2026-10-13 泛型透传:属主携带的额外字段(如 executable/installPath/srcPath)原样进结果侧
    it("lib 区 installed 可执行行命中 → runnable(与侧边栏同源)", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], [view("p", [row()])]);
        assert.deepStrictEqual(out.runnable, [{ pkg: "p", name: "talker", executable: "talker" }]);
        assert.deepStrictEqual(out.compiledNotInstalled, []);
    });

    it("无任何行(编译了但压根无安装规则)→ compiledNotInstalled", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], [view("p", [])]);
        assert.deepStrictEqual(out.runnable, []);
        assert.deepStrictEqual(out.compiledNotInstalled, [{ pkg: "p", name: "talker", executable: "talker" }]);
    });

    it("行 status=missing(有安装规则但 install 侧没看到)→ compiledNotInstalled", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], [view("p", [row({ status: "missing" })])]);
        assert.deepStrictEqual(out.runnable, []);
        assert.deepStrictEqual(out.compiledNotInstalled, [{ pkg: "p", name: "talker", executable: "talker" }]);
    });

    it("行存在但非可执行(library 行等)→ compiledNotInstalled", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], [view("p", [row({ executable: false })])]);
        assert.deepStrictEqual(out.runnable, []);
        assert.deepStrictEqual(out.compiledNotInstalled, [{ pkg: "p", name: "talker", executable: "talker" }]);
    });

    it("views=null(中心未就绪)→ 保守全部 runnable(不因判不了而拦截)", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], null);
        assert.deepStrictEqual(out.runnable, [{ pkg: "p", name: "talker", executable: "talker" }]);
        assert.deepStrictEqual(out.compiledNotInstalled, []);
    });

    it("混合多属主 → 按就绪性正确分层", () => {
        const owners = [
            { pkg: "p", name: "talker", executable: "talker" },
            { pkg: "p", name: "ghost", executable: "ghost" },
            { pkg: "q", name: "listener", executable: "listener" },
        ];
        const views = [
            view("p", [row({ name: "talker" }), row({ name: "ghost", status: "missing" })]),
            view("q", [row({ name: "listener" })]),
        ];
        const out = rds.splitOwnerReadiness(owners, views);
        assert.deepStrictEqual(out.runnable, [
            { pkg: "p", name: "talker", executable: "talker" },
            { pkg: "q", name: "listener", executable: "listener" },
        ]);
        assert.deepStrictEqual(out.compiledNotInstalled, [{ pkg: "p", name: "ghost", executable: "ghost" }]);
    });
});

describe("陈旧附加警告纯函数(2026-10-13:附加不阻碍/状态栏 4 秒/30 秒冷却)", () => {
    it("isStale: 双存在且源严格更新 → true;相等/安装更新/缺一侧 → false", () => {
        assert.strictEqual(rds.isStale(2000, 1000), true, "源比安装新 = 陈旧");
        assert.strictEqual(rds.isStale(1000, 1000), false, "相等(symlink 穿透等时)不警");
        assert.strictEqual(rds.isStale(1000, 2000), false, "安装更新不警");
        assert.strictEqual(rds.isStale(undefined, 1000), false, "源缺失不警(装好的那份即唯一真相)");
        assert.strictEqual(rds.isStale(2000, undefined), false, "安装缺失不警(前序闸门已拦)");
        assert.strictEqual(rds.isStale(undefined, undefined), false);
    });

    it("shouldNotifyStale: 无记录可弹;30 秒窗口内不弹;窗口外可弹;常量 = 用户裁定值", () => {
        assert.strictEqual(rds.shouldNotifyStale(undefined, 1_000_000), true, "无记录 = 首弹");
        assert.strictEqual(rds.shouldNotifyStale(1_000_000, 1_000_000 + rds.STALE_NOTIFY_COOLDOWN_MS - 1), false, "窗口内不弹");
        assert.strictEqual(rds.shouldNotifyStale(1_000_000, 1_000_000 + rds.STALE_NOTIFY_COOLDOWN_MS), true, "窗口外可弹");
        assert.strictEqual(rds.STALE_NOTIFY_COOLDOWN_MS, 30_000, "冷却 30 秒(用户裁定)");
        // 2026-10-14:状态栏 4 秒常量随"警告气泡+不再显示按钮"改版废除(STALE_STATUSBAR_TIMEOUT_MS 已删)
        assert.ok(typeof rds.STALE_MUTE_LABEL === "string" && rds.STALE_MUTE_LABEL.length > 0, "静音按钮标签应为非空串");
    });

    it("键名锁:ROS2.run.staleWarning(照 preflight 键名锁先例)", () => {
        assert.strictEqual(rds.RUN_STALE_WARNING_SETTING, "run.staleWarning");
    });

    it("notifyStaleIfNeeded 静默路径不抛错(源/安装缺一 = 不警;无头 stub 下不触达气泡 API)", () => {
        assert.doesNotThrow(() => rds.notifyStaleIfNeeded("run", "p", "n", undefined, undefined));
        assert.doesNotThrow(() => rds.notifyStaleIfNeeded("launch", "p", "n", undefined, undefined));
    });
});
