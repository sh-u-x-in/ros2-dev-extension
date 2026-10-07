/**
 * preflight-warnings 单测(2026-09-22;同日随模式枚举化重写)。
 *
 * 无头可跑:npx mocha out/test/suite/preflight-warnings.test.js
 * 模块顶层 import vscode(用 workspace.getConfiguration / window.showWarningMessage)→ 先装 stub。
 *
 * 覆盖:三选一模式解析(含旧布尔兼容)、类别过滤(on/off/ignore-silent-noop)、默认值、键名/按钮文案。
 * 不覆盖"弹窗与按钮点击"本身(stub 无 window.showWarningMessage),由集成宿主人工验证。
 */

import * as assert from "assert";

import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../../src/build-tool/package-service/build/preflight-warnings") as typeof import("../../src/build-tool/package-service/build/preflight-warnings");

describe("preflight-warnings:模式与类别过滤(纯函数)", () => {
    it("三选一解析:on / off / ignore-silent-noop;非法值/缺省 → on", () => {
        assert.strictEqual(mod.preflightModeFrom("on"), "on");
        assert.strictEqual(mod.preflightModeFrom("off"), "off");
        assert.strictEqual(mod.preflightModeFrom("ignore-silent-noop"), "ignore-silent-noop");
        assert.strictEqual(mod.preflightModeFrom(undefined), "on", "缺省 → on");
        assert.strictEqual(mod.preflightModeFrom("garbage"), "on", "非法值 → on(不猜关闭)");
    });

    it("off:三类全关;on:三类全开", () => {
        for (const kind of ["layout", "conflict", "silent-noop"] as const) {
            assert.strictEqual(mod.shouldShowPreflight(kind, "off"), false, `${kind} 在 off 下应静默`);
            assert.strictEqual(mod.shouldShowPreflight(kind, "on"), true, `${kind} 在 on 下应提示`);
        }
    });

    it("ignore-silent-noop:只关「形态静默无效」,布局与硬冲突仍提示", () => {
        assert.strictEqual(mod.shouldShowPreflight("silent-noop", "ignore-silent-noop"), false);
        assert.strictEqual(mod.shouldShowPreflight("layout", "ignore-silent-noop"), true);
        assert.strictEqual(mod.shouldShowPreflight("conflict", "ignore-silent-noop"), true);
    });

    it("默认(未配置)→ on;键名与「不再提示」按钮文案固定", () => {
        assert.strictEqual(mod.getPreflightMode(), "on");
        assert.strictEqual(mod.PREFLIGHT_WARNINGS_SETTING, "build.preflightWarnings");
        assert.strictEqual(mod.PREFLIGHT_MUTE_LABEL, "Don't warn about this again");
    });
});
