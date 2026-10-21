/**
 * 助手版本治理测试(2026-10-20,规范=VERSION-CONTROL.md 冻结文件;无头单跑)
 *
 * 验证:
 *  - 比较真值表(§2):旧→替换 / 相等与更新→共享让位 / 锁不可解析→视为最旧 / 我方不可解析→治理禁用;
 *  - 数值比较(非字典序):0.0.10 > 0.0.9;
 *  - 杀旧拉新全流程:临时锁文件 + pid 探活 + SIGKILL 记录 + spawn argv 带 --ext-version;
 *  - 让位:锁版本更新 → 零 SIGKILL;
 *  - legacy:三字段旧锁 → 替换;治理禁用:未注入版本 → 绝不杀;
 *  - 跨语言契约:argv 传输通道在 Python 源码在册(提取失败=显式红)。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/helper-versioning.test.js --exit
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const versioning = require("../../src/ros2/consumers/monitor/helper/param-helper-versioning") as {
    parseExtensionVersion(v: string | undefined): [number, number, number] | null;
    shouldReplaceServer(lockVersion: string | undefined, myVersion: string | undefined): boolean;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("../../src/ros2/consumers/monitor/helper/param-helper-client") as {
    startParamHelper(script: string): number;
    _resetForTest(): void;
    setParamHelperExtensionVersion(v: string | undefined): void;
    setParamHelperLockPathForTest(p: string | undefined): void;
    setParamHelperCommandRunner(cr: unknown): void;
    setParamHelperFailureCallback(cb: ((reason: string) => void) | undefined): void;
    setSocketFactoryForTest(factory: ((path: string, handlers: unknown) => unknown) | undefined): void;
};

interface KillRecord { pid: number; sig: string | number }

/** process.kill 打桩(对齐真实语义:死 pid 的信号 0 探测=**抛 ESRCH**,不是返回假——
 *  isPidAlive 只认异常;SIGKILL 记录不上真进程,绝不误杀宿主机) */
function stubProcessKill(): { records: KillRecord[]; restore(): void } {
    const records: KillRecord[] = [];
    const orig = process.kill.bind(process);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).kill = (pid: number, sig: string | number = 0) => {
        if (sig === 0 || sig === undefined) {
            if (records.some((r) => r.pid === pid && r.sig === "SIGKILL")) {
                const e = new Error(`kill ESRCH (${pid})`) as NodeJS.ErrnoException;
                e.code = "ESRCH";
                throw e;
            }
            return true;
        }
        records.push({ pid, sig });
        return true;
    };
    return { records, restore: () => { (process as any).kill = orig; } };
}

function fakeProc(): unknown {
    return {
        on(): void { /* noop */ },
        stderr: { setEncoding(): void { /* noop */ }, on(): void { /* noop */ } },
        stdout: { setEncoding(): void { /* noop */ }, on(): void { /* noop */ } },
        kill(): void { /* noop */ },
    };
}

/** 杀旧拉新流程公共装配:临时锁文件 + 版本注入 + 桩;返回 wait(毫秒) 与状态容器 */
function harness(lockContent: string | null, myVersion: string | undefined): {
    records: KillRecord[]; restore(): void; cleanup(): void;
    spawnArgv: string[][]; failures: string[];
} {
    const { records, restore } = stubProcessKill();
    const spawnArgv: string[][] = [];
    const failures: string[] = [];
    let lockPath: string | undefined;
    if (lockContent !== null) {
        lockPath = path.join(os.tmpdir(), `rde-lock-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
        fs.writeFileSync(lockPath, lockContent + "\n", "utf-8");
    }
    client.setParamHelperLockPathForTest(lockPath);
    client.setParamHelperExtensionVersion(myVersion);
    client.setParamHelperCommandRunner({
        exec: async () => undefined,
        spawn: (argv: string[]) => { spawnArgv.push(argv); return fakeProc() as never; },
    });
    client.setParamHelperFailureCallback((reason: string) => { failures.push(reason); });
    client.setSocketFactoryForTest(() => { throw new Error("no server"); });
    return {
        records,
        restore,
        cleanup: () => {
            if (lockPath) {
                try { fs.unlinkSync(lockPath); } catch { /* 已清 */ }
            }
            restore();
        },
        spawnArgv,
        failures,
    };
}

describe("助手版本治理(VERSION-CONTROL.md)", () => {
    beforeEach(function () {
        if (!HEADLESS) { this.skip(); }
        client._resetForTest();
    });

    afterEach(() => {
        client._resetForTest();
    });

    it("比较真值表:旧→替换 / 等与新→让位 / 锁不可解析→最旧 / 我方不可解析→禁用", function () {
        if (!HEADLESS) { this.skip(); }
        const R = versioning.shouldReplaceServer;
        assert.strictEqual(R("0.0.4", "0.0.5"), true, "锁旧→替换");
        assert.strictEqual(R("0.0.5", "0.0.5"), false, "相等→共享");
        assert.strictEqual(R("0.0.6", "0.0.5"), false, "锁新→让位");
        assert.strictEqual(R("1.0.0", "0.99.99"), false, "主版本新→让位");
        assert.strictEqual(R(undefined, "0.0.5"), true, "三字段旧锁(undefined)→视为最旧");
        assert.strictEqual(R("0", "0.0.5"), true, "占位 0→视为最旧");
        assert.strictEqual(R("garbage", "0.0.5"), true, "锁不可解析→视为最旧");
        assert.strictEqual(R("0.0.4", undefined), false, "我方未注入→治理禁用");
        assert.strictEqual(R("0.0.4", "not.a.version"), false, "我方不可解析→治理禁用");
        assert.strictEqual(R("0.0.9", "0.0.10"), true, "数值比较:0.0.10>0.0.9(非字典序)");
        assert.deepStrictEqual(versioning.parseExtensionVersion(" 0.2.3 "), [0, 2, 3], "容忍首尾空白");
        assert.strictEqual(versioning.parseExtensionVersion("0.0"), null, "两段→不可解析");
    });

    it("杀旧拉新全流程:探活→SIGKILL 旧 pid→spawn argv 带 --ext-version", async function () {
        if (!HEADLESS) { this.skip(); }
        const h = harness("4242 1700000000 123456 0.0.4", "0.0.5");
        try {
            client.startParamHelper("/tmp/param_helper.py");
            await new Promise((r) => setTimeout(r, 600));   // tick1 杀旧(即时)+retry 300ms→tick2 connect 拒→spawn
            assert.ok(h.records.some((r) => r.pid === 4242 && r.sig === "SIGKILL"), "旧 pid 4242 被 SIGKILL");
            assert.ok(h.spawnArgv.length >= 1, "杀后走 spawn 路径");
            const last = h.spawnArgv[h.spawnArgv.length - 1];
            assert.deepStrictEqual(last.slice(-2), ["--ext-version", "0.0.5"], "spawn argv 带版本号");
            assert.deepStrictEqual(h.failures, [], "替换流程不触发熔断");
        } finally {
            h.cleanup();
        }
    });

    it("让位:锁版本更新 → 零 SIGKILL,照常 spawn 兜底路径", async function () {
        if (!HEADLESS) { this.skip(); }
        const h = harness("4242 1700000000 123456 0.0.6", "0.0.5");
        try {
            client.startParamHelper("/tmp/param_helper.py");
            await new Promise((r) => setTimeout(r, 600));
            assert.deepStrictEqual(h.records.filter((r) => r.sig === "SIGKILL"), [], "让位:绝不 SIGKILL");
            assert.ok(h.spawnArgv.length >= 1, "旧客户端自愈照常(连接被拒→spawn)");
        } finally {
            h.cleanup();
        }
    });

    it("legacy 三字段旧锁 → 按最旧替换", async function () {
        if (!HEADLESS) { this.skip(); }
        const h = harness("4242 1700000000 123456", "0.0.5");
        try {
            client.startParamHelper("/tmp/param_helper.py");
            await new Promise((r) => setTimeout(r, 600));
            assert.ok(h.records.some((r) => r.pid === 4242 && r.sig === "SIGKILL"), "无版本字段(0.0.3- 遗留)→替换");
        } finally {
            h.cleanup();
        }
    });

    it("治理禁用:未注入版本 → 锁再旧也绝不杀", async function () {
        if (!HEADLESS) { this.skip(); }
        const h = harness("4242 1700000000 123456 0.0.1", undefined);
        try {
            client.startParamHelper("/tmp/param_helper.py");
            await new Promise((r) => setTimeout(r, 600));
            assert.deepStrictEqual(h.records.filter((r) => r.sig === "SIGKILL"), [], "未注入版本=治理禁用,绝不杀");
        } finally {
            h.cleanup();
        }
    });

    it("跨语言契约:--ext-version argv 通道在 Python 源码在册(提取失败=显式红)", function () {
        if (!HEADLESS) { this.skip(); }
        const ROOT = path.resolve(__dirname, "..", "..", "..");   // out/test/suite → 仓根(契约套件同款)
        const entry = fs.readFileSync(path.join(ROOT, "assets", "ros", "param_helper.py"), "utf-8");
        assert.ok(entry.includes('"--ext-version"'), "param_helper.py 必须解析 --ext-version argv(锁文件版本唯一入口)");
        assert.ok(entry.includes("ext_version="), "main(ext_version=...) 传参在册");
        const acquire = fs.readFileSync(path.join(ROOT, "assets", "ros", "param_helper_lib", "server.py"), "utf-8");
        assert.ok(acquire.includes("def acquire_lock(ext_version"), "acquire_lock 必须接收版本参数(锁文件第 4 字段唯一写入点)");
    });
});
