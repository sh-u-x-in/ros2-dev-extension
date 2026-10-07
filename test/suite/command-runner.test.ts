/**
 * CommandRunner 最小单测(2026-08-25)
 *
 * 验证统一命令原语(需求 A6)的核心语义,不依赖真实 ROS 环境:
 * - exec 成功:返回 { stdout, stderr, code: 0 }
 * - exec 非零退出码:reject,错误携带已解码 stdout/stderr/code
 * - exec 超时:reject,错误 timedout = true
 * - spawn:返回子进程句柄,可收集输出
 *
 * 无头(npx mocha)时通过 _vscode-stub 拦截 require("vscode")(state.ts 依赖 vscode.EventEmitter);
 * 有头(npm test)走真实 vscode。
 */

import * as assert from "assert";

import { installVscodeStub } from "./_vscode-stub";

// 必须先装 vscode stub 再 require 依赖 vscode 的被测模块(顶层值 import 会提前 require("vscode"),故延迟 require)
installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const commandRunnerMod = require("../../src/ros2/environment/command-runner") as typeof import("../../src/ros2/environment/command-runner");

/** 超时判定用短命令:node 挂起指定毫秒(测试进程环境必有 node) */
const HANG_SCRIPT = "setTimeout(() => {}, 10000)";

describe("CommandRunner.exec", () => {
    it("成功:返回 { stdout, stderr, code: 0 }", async () => {
        const result = await commandRunnerMod.exec(`node -e "console.log('hello')"`);
        assert.strictEqual(result.code, 0);
        assert.strictEqual(result.stdout.trim(), "hello");
        assert.strictEqual(typeof result.stderr, "string");
    });

    it("非零退出码:reject 且错误携带已解码 stdout/stderr/code", async () => {
        try {
            await commandRunnerMod.exec(`node -e "console.error('boom'); process.exit(3)"`);
            assert.fail("应 reject");
        } catch (err) {
            const e = err as { code: number | null; stdout: string; stderr: string; timedout: boolean };
            assert.strictEqual(e.code, 3);
            assert.strictEqual(e.stdout.trim(), "");
            assert.strictEqual(e.stderr.trim(), "boom");
            assert.strictEqual(e.timedout, false);
        }
    });

    it("超时:reject 且 timedout = true(默认 30s 可被 options.timeoutMs 覆盖)", async () => {
        const t0 = Date.now();
        try {
            await commandRunnerMod.exec(`node -e "${HANG_SCRIPT}"`, { timeoutMs: 200 });
            assert.fail("应因超时 reject");
        } catch (err) {
            const e = err as { timedout: boolean };
            assert.strictEqual(e.timedout, true);
        }
        assert.ok(Date.now() - t0 < 5000, "应远早于挂起脚本自身时长返回");
    });

    it("cwd 生效:在指定目录执行 pwd", async () => {
        // 用 node 输出 process.cwd() 避免平台差异(cmd 的 cd 语义)
        const cwd = process.cwd();
        const result = await commandRunnerMod.exec(`node -e "console.log(process.cwd())"`, { cwd });
        assert.strictEqual(result.stdout.trim(), cwd);
    });
});

describe("CommandRunner.spawn", () => {
    it("返回子进程句柄并产生输出(流式收集)", async () => {
        const child = commandRunnerMod.spawn(["node", "-e", "process.stdout.write('streamed')"]);
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        const exitCode = await new Promise<number | null>((resolve) => {
            child.on("close", (code) => resolve(code));
        });
        assert.strictEqual(exitCode, 0);
        assert.strictEqual(out, "streamed");
    });

    it("超时 kill:timeoutMs 指定后自动终止", async () => {
        const child = commandRunnerMod.spawn(["node", "-e", HANG_SCRIPT], { timeoutMs: 200 });
        const exitCode = await new Promise<number | null>((resolve) => {
            child.on("close", (code) => resolve(code));
        });
        assert.strictEqual(exitCode, null); // 被 kill(无正常退出码)
    });
});
