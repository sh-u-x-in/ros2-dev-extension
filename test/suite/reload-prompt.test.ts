/**
 * 重载提示测试(2026-10-18 P2,无头单跑)
 *
 * 验证 reload-prompt 纯 UI 策略层:
 *  - 门关提示:连续失败 < 阈值(2)不弹;达阈值弹一次;冷却内不重复;过冷却再弹;
 *  - noteSuccess 清挂起态(冷却时间戳保留);
 *  - 按钮选「Reload Window」→ executeCommand("workbench.action.reloadWindow");
 *  - 换根提示与门关提示共用冷却。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/reload-prompt.test.js --exit
 */

import * as assert from "assert";
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

interface Harness {
    warnings: { message: string; items: string[] }[];
    executed: string[];
    setWarningResult: (r: string | undefined) => void;
}

function harness(): Harness {
    const vsc = require("vscode") as any;
    const h: Harness = { warnings: [], executed: [], setWarningResult: () => undefined };
    if (!vsc.commands) {
        vsc.commands = {};
    }
    vsc.commands.executeCommand = (id: string) => {
        h.executed.push(id);
        return Promise.resolve();
    };
    vsc.window.showWarningMessage = (message: string, ...items: string[]) => {
        h.warnings.push({ message, items });
        return Promise.resolve((h as any)._result); // 必须 Promise(生产实现为 async;裸串会让 .then 抛错)
    };
    (h as any)._result = undefined;
    h.setWarningResult = (r: string | undefined) => {
        (h as any)._result = r;
    };
    return h;
}

/* eslint-disable @typescript-eslint/no-var-requires */
describe("reload-prompt(重载提示,P2)", () => {
    let rp: {
        noteFailure(streak: number, reason: string, envEverUsable: boolean): void;
        noteSuccess(): void;
        noteRootChanged(prev: string | undefined, next: string | undefined): void;
        RELOAD_PROMPT_THRESHOLD: number;
        RELOAD_PROMPT_COOLDOWN_MS: number;
        _setNowForTest(fn: () => number): void;
        _resetForTest(): void;
    };
    let clock: number;

    beforeEach(function () {
        if (!HEADLESS) { this.skip(); }
        clock = 1_000_000;
        rp = require("../../src/ros2/environment/reload-prompt") as typeof rp;
        rp._resetForTest();
        rp._setNowForTest(() => clock);
        harness();
    });

    afterEach(function () {
        if (!HEADLESS) { return; }
        rp._resetForTest();
    });

    it("阈值前(连续失败 1 次)不弹", () => {
        const h = harness();
        rp.noteFailure(1, "reason-1", true);
        assert.strictEqual(h.warnings.length, 0, "未达阈值不弹");
    });

    it("达阈值(2 次)弹一次,文案含原因与按钮;冷却内不重复;过冷却再弹", async () => {
        const h = harness();
        rp.noteFailure(2, "reason-2", true);
        assert.strictEqual(h.warnings.length, 1, "达阈值弹一次");
        assert.ok(h.warnings[0].message.includes("reason-2"), "文案含最近失败原因");
        assert.ok(h.warnings[0].items.includes("Reload Window"), "按钮 = Reload Window");
        await new Promise((r) => setImmediate(r)); // 通知关闭(in-flight 解除)= 用户未选任何按钮
        clock += 1000; // 冷却内
        rp.noteFailure(3, "reason-3", true);
        assert.strictEqual(h.warnings.length, 1, "冷却内不重复弹");
        clock += rp.RELOAD_PROMPT_COOLDOWN_MS + 1000; // 过冷却
        rp.noteFailure(4, "reason-4", true);
        assert.strictEqual(h.warnings.length, 2, "过冷却再弹");
        assert.ok(h.warnings[1].message.includes("reason-4"));
    });

    it("选「Reload Window」→ executeCommand(workbench.action.reloadWindow)", async () => {
        const h = harness();
        h.setWarningResult("Reload Window");
        rp.noteFailure(2, "r", true);
        await new Promise((r) => setImmediate(r)); // .then 回调为微任务,先冲刷再断言
        assert.deepStrictEqual(h.executed, ["workbench.action.reloadWindow"], "触发窗口重载");
    });

    it("从未成功采集(envEverUsable=false)→ 不弹且不消耗冷却(2026-10-19 误报根治回归锁)", () => {
        const h = harness();
        rp.noteFailure(2, "reason-x", false);
        assert.strictEqual(h.warnings.length, 0, "从未可用=稳态,不发「此前可用」误报");
        rp.noteFailure(3, "reason-y", false);
        assert.strictEqual(h.warnings.length, 0, "连续失败也不弹(门优先于阈值)");
        rp.noteFailure(4, "reason-z", true); // 此后真实可用过再损坏 → 立即可弹(冷却未被消费)
        assert.strictEqual(h.warnings.length, 1);
        assert.ok(h.warnings[0].message.includes("reason-z"));
    });

    it("双按钮契约:[Reload Window, Later](2026-10-19 文案与实现脱节回归锁)", () => {
        const h = harness();
        rp.noteFailure(2, "r", true);
        assert.strictEqual(h.warnings.length, 1);
        assert.deepStrictEqual(h.warnings[0].items, ["Reload Window", "Later"]);
    });

    it("选「Later」→ 不执行重载命令,仅解除挂起态", async () => {
        const h = harness();
        h.setWarningResult("Later");
        rp.noteFailure(2, "r", true);
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(h.executed, [], "稍后不触发任何命令");
        assert.deepStrictEqual(h.warnings.map((w) => w.message).length, 1);
    });

    it("noteSuccess 清挂起态,不影响冷却时间戳(成功后冷却内仍不弹)", () => {
        const h = harness();
        rp.noteFailure(2, "r", true);
        assert.strictEqual(h.warnings.length, 1);
        rp.noteSuccess();
        clock += 1000;
        rp.noteFailure(3, "r2", true);
        assert.strictEqual(h.warnings.length, 1, "成功不清冷却——冷却内仍不弹");
    });

    it("换根提示与门关提示共用冷却", async () => {
        const h = harness();
        rp.noteFailure(2, "r", true);
        assert.strictEqual(h.warnings.length, 1, "门关提示先弹");
        await new Promise((r) => setImmediate(r)); // 通知关闭(in-flight 解除)
        clock += 1000;
        rp.noteRootChanged("/old", "/new");
        assert.strictEqual(h.warnings.length, 1, "共用冷却:换根不重复弹");
        clock += rp.RELOAD_PROMPT_COOLDOWN_MS + 1000;
        rp.noteRootChanged("/old", "/new");
        assert.strictEqual(h.warnings.length, 2, "过冷却换根可弹");
        assert.ok(h.warnings[1].message.includes("/old") && h.warnings[1].message.includes("/new"), "换根文案含前后根");
    });
});
