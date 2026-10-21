/**
 * 统一命令围栏包装器测试(2026-10-18 P1,无头单跑)
 *
 * 验证 registerGatedCommand 四块语义:
 *  - 门关 → 一句拒绝、handler 不执行;
 *  - 门开 → handler 执行、实参透传(旧 ensureErrorMessageOnException 不转发参数的先例教训);
 *  - handler 抛错 → 异常统一弹窗(侧边栏 8 注册点此前无错误出口的补齐语义);
 *  - GATE_REFUSALS 各域文案 → 原因 {0} 透传(l10n 桩做替换,断言原因串包含)。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/gated-command.test.js --exit
 */

import * as assert from "assert";
import { installVscodeStub } from "./_vscode-stub";

// 必须在 require 被测模块之前安装 vscode stub(被测模块顶层 import vscode,无头环境不可解析)
installVscodeStub();

// 无头(桩已装)= true;集成宿主(真实 vscode,会弹真窗)该组用例跳过
const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

interface Captured {
    id: string;
    handler: (...args: any[]) => unknown;
}

/** 装好桩并捕获 registerGatedCommand 内部的 registerCommand 调用(不经 executeCommand,宿主无关) */
async function capture(): Promise<{ vsc: any; captured: Captured[]; errors: unknown[][] }> {
    const vsc = require("vscode") as any;
    const captured: Captured[] = [];
    const errors: unknown[][] = [];
    if (!vsc.commands) {
        vsc.commands = {}; // 无头桩未提供 commands 命名空间时补最小形状
    }
    vsc.commands.registerCommand = (id: string, handler: (...args: any[]) => unknown) => {
        captured.push({ id, handler });
        return { dispose(): void { /* noop */ } };
    };
    vsc.window.showErrorMessage = async (...a: unknown[]) => {
        errors.push(a);
        return undefined;
    };
    return { vsc, captured, errors };
}

/* eslint-disable @typescript-eslint/no-var-requires */
describe("registerGatedCommand(统一命令围栏,P1)", () => {
    it("门关 → 一句拒绝,handler 不执行", async function () {
        if (!HEADLESS) { this.skip(); }
        const { captured, errors } = await capture();
        const { registerGatedCommand } = require("../../src/commands/gated-command") as {
            registerGatedCommand(id: string, opts: { getIssue(): string | null; refuse(issue: string): string }, handler: (...args: any[]) => unknown): unknown;
        };
        let ran = false;
        registerGatedCommand("TEST.gated.refuse", { getIssue: () => "stub-issue", refuse: (i) => `refused:${i}` }, async () => { ran = true; });
        assert.strictEqual(captured.length, 1, "内部仍走 vscode.commands.registerCommand");
        await captured[0].handler();
        assert.strictEqual(ran, false, "门关不进 handler");
        assert.strictEqual(errors.length, 1, "一句拒绝");
        assert.strictEqual(String(errors[0][0]), "refused:stub-issue", "拒绝文案 = 域 refuse 注入结果");
    });

    it("门开 → handler 执行且实参透传", async function () {
        if (!HEADLESS) { this.skip(); }
        const { captured, errors } = await capture();
        const { registerGatedCommand } = require("../../src/commands/gated-command") as {
            registerGatedCommand(id: string, opts: { getIssue(): string | null; refuse(issue: string): string }, handler: (...args: any[]) => unknown): unknown;
        };
        const seen: unknown[][] = [];
        registerGatedCommand("TEST.gated.pass", { getIssue: () => null, refuse: (i) => i }, async (...args: unknown[]) => { seen.push(args); });
        await captured[0].handler({ source: "activeEditor" }, 42);
        assert.strictEqual(errors.length, 0, "门开无拒绝弹窗");
        assert.strictEqual(seen.length, 1, "handler 恰执行一次");
        assert.deepStrictEqual(seen[0], [{ source: "activeEditor" }, 42], "实参透传(顺序与个数不变)");
    });

    it("handler 抛错 → 异常统一弹窗", async function () {
        if (!HEADLESS) { this.skip(); }
        const { captured, errors } = await capture();
        const { registerGatedCommand } = require("../../src/commands/gated-command") as {
            registerGatedCommand(id: string, opts: { getIssue(): string | null; refuse(issue: string): string }, handler: (...args: any[]) => unknown): unknown;
        };
        registerGatedCommand("TEST.gated.throw", { getIssue: () => null, refuse: (i) => i }, async () => {
            throw new Error("stub-boom");
        });
        await captured[0].handler();
        assert.strictEqual(errors.length, 1, "异常落错误出口");
        assert.strictEqual(String(errors[0][0]), "stub-boom");
    });

    it("GATE_REFUSALS 五域文案 → 原因 {0} 透传(键 = 既有执行层同键)", async function () {
        if (!HEADLESS) { this.skip(); }
        const { GATE_REFUSALS } = require("../../src/commands/gated-command") as {
            GATE_REFUSALS: Record<string, (issue: string) => string>;
        };
        const lines = Object.entries(GATE_REFUSALS).map(([name, fn]) => `${name}=${fn("STUB-ISSUE")}`);
        assert.strictEqual(lines.length, 5, "五域:build/execute/rosdep/tests/terminal");
        for (const line of lines) {
            assert.ok(line.includes("STUB-ISSUE"), `${line.split("=")[0]} 文案应含原因 {0} 透传`);
            assert.ok(line.includes("No usable ROS 2 environment detected"), "统一前缀(执行层同键)");
        }
    });
});
