/**
 * 环境组件对账(reconcile desired-state)测试(2026-10-18 P2,无头单跑)
 *
 * 验证 activate.reconcileRosComponents 幂等期望态语义:
 *  - 首次不可用 → 清空(无可装配),再刷跳过;首次可用 → 装配一次,再刷跳过(修"可用期外部变化重建状态栏");
 *  - 可用→不可用翻转 → 回收(监控 dispose);不可用→可用 → 装配;
 *  - disposeEnvSubscriptions 清态后再刷可重新装配。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/env-reconcile.test.js --exit
 */

import * as assert from "assert";
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const state = require("../../src/ros2/environment/state") as {
    _resetForTest(): void;
    setEnv(env: Record<string, string>): void;
    markStale(reason: string): void;
    clearStale(): void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const envCollect = require("../../src/ros2/environment/env-collect") as {
    collectEnvironmentSnapshot(): Promise<{ env?: Record<string, string>; reason?: string }>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activate = require("../../src/ros2/environment/activate") as {
    refreshEnvironment(context: unknown): Promise<boolean>;
    reconcileRosComponents(context: unknown, opts?: { lockHeld?: boolean }): Promise<boolean>;
    disposeEnvSubscriptions(): void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRosApiDeps } = require("../../src/ros2/api/ros-api-deps") as {
    setRosApiDeps(deps: { activateCoreMonitor(): { dispose(): void } }): void;
};

const VALID_ENV = (): Record<string, string> => ({
    ROS_DISTRO: "humble",
    ROS_VERSION: "2",
    AMENT_PREFIX_PATH: "/opt/ros/humble",
    PATH: "/usr/bin",
});

describe("环境组件对账 reconcile desired-state(P2)", () => {
    const envCollectAny = envCollect as unknown as { collectEnvironmentSnapshot: unknown };
    const originalCollect = envCollectAny.collectEnvironmentSnapshot;
    let assembled = 0;
    let disposed = 0;
    const fakeContext = { subscriptions: [] as unknown[] };

    function stubCollect(outcome: { env?: Record<string, string>; reason?: string }): void {
        envCollectAny.collectEnvironmentSnapshot = async () => outcome;
    }

    beforeEach(function () {
        if (!HEADLESS) { this.skip(); }
        state._resetForTest();
        assembled = 0;
        disposed = 0;
        setRosApiDeps({
            activateCoreMonitor: () => {
                assembled += 1;
                return { dispose: () => { disposed += 1; } };
            },
        });
        stubCollect({ env: VALID_ENV() });
    });

    afterEach(() => {
        envCollectAny.collectEnvironmentSnapshot = originalCollect;
        activate.disposeEnvSubscriptions();
        state._resetForTest();
    });

    it("首次不可用 → 清空态;再刷跳过(不动手)", async function () {
        if (!HEADLESS) { this.skip(); }
        stubCollect({ reason: "stub-down" });
        const first = await activate.refreshEnvironment(fakeContext);
        assert.strictEqual(first, true, "首次对账动手(置清空态)");
        assert.strictEqual(assembled, 0, "不可用不装配");
        const second = await activate.refreshEnvironment(fakeContext);
        assert.strictEqual(second, false, "已处于期望态(不可用已清)→ 跳过");
        assert.strictEqual(assembled, 0);
    });

    it("首次可用 → 装配一次;再刷跳过(可用期外部变化不重建状态栏)", async function () {
        if (!HEADLESS) { this.skip(); }
        const first = await activate.refreshEnvironment(fakeContext);
        assert.strictEqual(first, true, "首次装配");
        assert.strictEqual(assembled, 1);
        const second = await activate.refreshEnvironment(fakeContext);
        assert.strictEqual(second, false, "已装配 → 跳过");
        assert.strictEqual(assembled, 1, "可用期重复刷新不重建状态栏");
    });

    it("可用→不可用翻转 → 回收(monitor dispose);不可用→可用 → 再装配", async function () {
        if (!HEADLESS) { this.skip(); }
        await activate.refreshEnvironment(fakeContext); // 装配
        assert.strictEqual(assembled, 1);
        stubCollect({ reason: "stub-outage" });
        state.setEnv(VALID_ENV());
        state.markStale("stub-outage"); // 旧快照 + 失败 = 陈旧关门
        const flipped = await activate.refreshEnvironment(fakeContext);
        assert.strictEqual(flipped, true, "翻转动手");
        assert.strictEqual(disposed, 1, "状态栏被回收");
        stubCollect({ env: VALID_ENV() });
        state.clearStale();
        const recovered = await activate.refreshEnvironment(fakeContext);
        assert.strictEqual(recovered, true, "恢复动手");
        assert.strictEqual(assembled, 2, "重新装配");
    });

    it("disposeEnvSubscriptions 清态 → 再刷可重新装配", async function () {
        if (!HEADLESS) { this.skip(); }
        await activate.refreshEnvironment(fakeContext);
        assert.strictEqual(assembled, 1);
        activate.disposeEnvSubscriptions();
        const again = await activate.refreshEnvironment(fakeContext);
        assert.strictEqual(again, true, "清态后重新对账装配");
        assert.strictEqual(assembled, 2);
    });
});
