/**
 * 常驻助手围栏测试(2026-10-18 P4,无头单跑)
 *
 * 验证:
 *  - startHelperFlow 环境门:门关 → 一句拒绝(带原因),不进入 starting 播报与 15s 在线等待;
 *  - spawnHelper 环境闸:门关 → 不 spawn(三自愈入口单点),熔断失败回调上抛原因;
 *  - 预检位掩码译码:退出码 100+mask 按位给出哪一项不可用;
 *  - 熔断自动停:预检类退出 → 立即熔断,spawn 不重拉。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/helper-gate.test.js --exit
 */

import * as assert from "assert";
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const state = require("../../src/ros2/environment/state") as {
    _resetForTest(): void;
    setEnv(env: Record<string, string>): void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const helperFlows = require("../../src/ros2/consumers/monitor/page/monitor-helper-flows") as {
    startHelperFlow(panel: unknown): Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("../../src/ros2/consumers/monitor/helper/param-helper-client") as {
    startParamHelper(script: string): number;
    stopParamHelper(): void;
    _resetForTest(): void;
    setParamHelperEnvFacade(facade: { getEnv(): any | undefined; getEnvIssue(): string | null } | undefined): void;
    setParamHelperFailureCallback(cb: ((reason: string) => void) | undefined): void;
    setParamHelperCommandRunner(cr: unknown): void;
    setSocketFactoryForTest(factory: ((path: string, handlers: unknown) => unknown) | undefined): void;
    preflightIssueText(code: number): string;
};

function fakePanel(): { sent: { helperAction: string; message?: string; isRunning?: boolean }[] } {
    const sent: { helperAction: string; message?: string; isRunning?: boolean }[] = [];
    return {
        sent,
        webview: { postMessage: async (m: never) => { sent.push(m); return true; } },
    } as never;
}

describe("常驻助手围栏(P4)", () => {
    beforeEach(function () {
        if (!HEADLESS) { this.skip(); }
        state._resetForTest();
        client._resetForTest();
    });

    afterEach(() => {
        client._resetForTest();
        state._resetForTest();
    });

    it("startHelperFlow 门关 → 一句拒绝(含原因),不进入 starting 播报", async function () {
        if (!HEADLESS) { this.skip(); }
        const panel = fakePanel();
        await helperFlows.startHelperFlow(panel);
        assert.strictEqual(panel.sent.length, 1, "仅一条拒绝消息(无 starting 播报/无 15s 等待)");
        assert.strictEqual(panel.sent[0].helperAction, "error");
        assert.strictEqual(panel.sent[0].isRunning, false);
        assert.ok(String(panel.sent[0].message).includes("cannot start the helper"), "拒绝文案=助手门键");
    });

    it("spawn 环境闸:门关不 spawn,熔断回调上抛原因", async function () {
        if (!HEADLESS) { this.skip(); }
        let spawnCalls = 0;
        let failure = "";
        client.setParamHelperEnvFacade({ getEnv: () => undefined, getEnvIssue: () => "stub-no-env" });
        client.setParamHelperCommandRunner({ exec: async () => undefined, spawn: () => { spawnCalls += 1; throw new Error("should not spawn"); } });
        client.setParamHelperFailureCallback((reason) => { failure = reason; });
        client.setSocketFactoryForTest(() => { throw new Error("no server"); }); // 连接失败 → 自愈入口 → spawn 闸
        client.startParamHelper("/tmp/param_helper.py");
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(spawnCalls, 0, "门关绝不 spawn");
        assert.ok(failure.includes("stub-no-env"), "熔断回调上抛环境原因");
    });

    it("预检位掩码译码:退出码 103 → rclpy + rcl_interfaces 两位齐出", function () {
        if (!HEADLESS) { this.skip(); }
        const text = client.preflightIssueText(103); // 100 + 0x03
        assert.ok(text.includes("103"), "含退出码");
        assert.ok(text.includes("rclpy"), "位 0x01 译码");
        assert.ok(text.includes("rcl_interfaces"), "位 0x02 译码");
        assert.ok(!text.includes("disk_log"), "未置位不译码");
    });

    it("预检类退出 → 立即熔断:spawn 不重拉,failureCallback 上抛译码", async function () {
        if (!HEADLESS) { this.skip(); }
        let spawnCalls = 0;
        let failure = "";
        const handlers: Record<string, (code?: number) => void> = {};
        const fakeProc = {
            on: (ev: string, cb: (code?: number) => void) => { handlers[ev] = cb; },
            stderr: { setEncoding(): void { /* noop */ }, on(): void { /* noop */ } },
            stdout: { setEncoding(): void { /* noop */ }, on(): void { /* noop */ } },
            kill(): void { /* noop */ },
        };
        client.setParamHelperEnvFacade({ getEnv: () => ({ ROS_DISTRO: "humble", ROS_VERSION: "2" }), getEnvIssue: () => null });
        client.setParamHelperCommandRunner({
            exec: async () => undefined,
            spawn: () => { spawnCalls += 1; return fakeProc as never; },
        });
        client.setParamHelperFailureCallback((reason) => { failure = reason; });
        client.setSocketFactoryForTest(() => { throw new Error("no server"); });
        client.startParamHelper("/tmp/param_helper.py");
        assert.strictEqual(spawnCalls, 1, "门开正常 spawn");
        handlers.exit?.(105); // 预检失败退出(位掩码 0x05)
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(spawnCalls, 1, "预检失败立即熔断,不重拉");
        assert.ok(failure.includes("105") && failure.includes("rclpy"), "熔断原因=预检译码");
    });

    it("退出码 116(单 0x10)→ 立即熔断不重拉(2026-10-20 漏接回归锁)", async function () {
        if (!HEADLESS) { this.skip(); }
        // born-bug:路由区间曾写 100..115,116 落进瞬态重拉(3 次后通用文案),位文案永不显示
        assert.ok(client.preflightIssueText(116).includes("disk_log"), "0x10 译码先验");
        let spawnCalls = 0;
        let failure = "";
        const handlers: Record<string, (code?: number) => void> = {};
        const fakeProc = {
            on: (ev: string, cb: (code?: number) => void) => { handlers[ev] = cb; },
            stderr: { setEncoding(): void { /* noop */ }, on(): void { /* noop */ } },
            stdout: { setEncoding(): void { /* noop */ }, on(): void { /* noop */ } },
            kill(): void { /* noop */ },
        };
        client.setParamHelperEnvFacade({ getEnv: () => ({ ROS_DISTRO: "humble", ROS_VERSION: "2" }), getEnvIssue: () => null });
        client.setParamHelperCommandRunner({
            exec: async () => undefined,
            spawn: () => { spawnCalls += 1; return fakeProc as never; },
        });
        client.setParamHelperFailureCallback((reason) => { failure = reason; });
        client.setSocketFactoryForTest(() => { throw new Error("no server"); });
        client.startParamHelper("/tmp/param_helper.py");
        handlers.exit?.(116); // 100 + 0x10:修复前此码走 scheduleRestart
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 20)); // 越过修复前会安排的重拉定时
        assert.strictEqual(spawnCalls, 1, "116 必须立即熔断,绝不重拉");
        assert.ok(failure.includes("116") && failure.includes("disk_log"), "熔断原因含 0x10 位译码");
    });

    it("退出码 131(全位 0x1F)→ 五位齐出+立即熔断(组合码上界)", async function () {
        if (!HEADLESS) { this.skip(); }
        const text = client.preflightIssueText(131); // 100 + 0x1F
        for (const bit of ["rclpy", "rcl_interfaces", "param_helper_lib", "disk_log"]) {
            assert.ok(text.includes(bit), `全位译码含 ${bit}`);
        }
        let spawnCalls = 0;
        let failure = "";
        const handlers: Record<string, (code?: number) => void> = {};
        const fakeProc = {
            on: (ev: string, cb: (code?: number) => void) => { handlers[ev] = cb; },
            stderr: { setEncoding(): void { /* noop */ }, on(): void { /* noop */ } },
            stdout: { setEncoding(): void { /* noop */ }, on(): void { /* noop */ } },
            kill(): void { /* noop */ },
        };
        client.setParamHelperEnvFacade({ getEnv: () => ({ ROS_DISTRO: "humble", ROS_VERSION: "2" }), getEnvIssue: () => null });
        client.setParamHelperCommandRunner({
            exec: async () => undefined,
            spawn: () => { spawnCalls += 1; return fakeProc as never; },
        });
        client.setParamHelperFailureCallback((reason) => { failure = reason; });
        client.setSocketFactoryForTest(() => { throw new Error("no server"); });
        client.startParamHelper("/tmp/param_helper.py");
        handlers.exit?.(131); // 区间上界(100+0x1F)
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(spawnCalls, 1, "上界组合码同样立即熔断");
        assert.ok(failure.includes("131"), "熔断原因=全位译码");
    });
});
