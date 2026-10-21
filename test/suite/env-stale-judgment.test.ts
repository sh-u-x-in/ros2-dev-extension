/**
 * 环境判据底座测试(2026-10-18 P0,双宿主可跑)
 *
 * 三块语义:
 * - state:getEnvIssue 真值表(无 env / 陈旧 / 名册外发行版 / 版本非 2 / 可用)与
 *   陈旧标志(markStale / clearStale / _resetForTest)——修「失败保留旧快照不发事件 ⇒
 *   失效环境被全部门永久放行」的陈真链;
 * - source:采集失败置陈旧 + 可用→不可用翻转边沿补发 onEnvChanged、连续失败不重复发、
 *   陈旧后采集成功(快照内容不变)靠翻转边沿补发恢复事件、可用期快照不变不发(既有语义保持)。
 *   采集成败经 env-collect 模块导出属性打桩(tsc CommonJS 调用点属性查找),无子进程、双宿主确定;
 * - env-collect:ros2 PATH 存在性探针纯函数(PATH 键缺失 / 命中 / 未命中 / Path 键 win32 大小写形态)。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/env-stale-judgment.test.js --exit
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { installVscodeStub } from "./_vscode-stub";

// 必须先装 vscode stub 再 require 依赖 vscode 的被测模块(顶层值 import 会提前 require("vscode"),故延迟 require)
installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const state = require("../../src/ros2/environment/state") as typeof import("../../src/ros2/environment/state");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const envCollect = require("../../src/ros2/environment/env-collect") as {
    probeRos2Executable(env: Record<string, string>): string | null;
    collectEnvironmentSnapshot(): Promise<{ env?: Record<string, string>; reason?: string }>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const source = require("../../src/ros2/environment/source") as {
    sourceRosAndWorkspace(): Promise<void>;
    envVerdictFlipped(prevUsable: boolean, nextUsable: boolean): boolean;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const reloadPrompt = require("../../src/ros2/environment/reload-prompt") as { _resetForTest(): void };

/** 有效快照(过 getEnvIssue 三道校验 + 探针不影响:探针只打桩层不进真采集) */
const VALID_ENV = (): Record<string, string> => ({
    ROS_DISTRO: "humble",
    ROS_VERSION: "2",
    AMENT_PREFIX_PATH: "/opt/ros/humble",
    PATH: "/usr/bin:/bin",
});

/* ------------------------------------------------------------------ */
/* getEnvIssue 真值表 + 陈旧标志(state)                                */
/* ------------------------------------------------------------------ */

describe("getEnvIssue 真值表与陈旧标志(P0)", () => {
    beforeEach(() => state._resetForTest());
    afterEach(() => state._resetForTest());

    it("无 env → 不可用(未采集分支,与陈旧原因无关)", () => {
        state.markStale("STALE-MARKER");
        const issue = state.getEnvIssue();
        assert.ok(issue !== null, "无 env 必不可用");
        assert.ok(!issue.includes("STALE-MARKER"), "无 env 走未采集分支,不落陈旧分支");
    });

    it("env 有效 + 陈旧标志 → 不可用且原因透传(④ 陈旧分支)", () => {
        state.setEnv(VALID_ENV());
        assert.strictEqual(state.getEnvIssue(), null, "置陈旧前应判可用");
        state.markStale("STALE-MARKER");
        const issue = state.getEnvIssue();
        assert.ok(issue !== null, "陈旧后必须关门(修陈真链)");
        assert.ok(issue.includes("STALE-MARKER"), "陈旧原因经 {0} 透传");
    });

    it("clearStale 后回落按 env 判定(恢复即开门)", () => {
        state.setEnv(VALID_ENV());
        state.markStale("STALE-MARKER");
        state.clearStale();
        assert.strictEqual(state.getEnvIssue(), null);
    });

    it("名册外发行版 → 不可用且发行版名透传(既有分支不回归)", () => {
        const env = VALID_ENV();
        env.ROS_DISTRO = "fakedistro";
        state.setEnv(env);
        const issue = state.getEnvIssue();
        assert.ok(issue !== null);
        assert.ok(issue.includes("fakedistro"), "发行版名经 {0} 透传");
    });

    it("ROS_VERSION 非 2 → 不可用(既有分支不回归)", () => {
        const env = VALID_ENV();
        env.ROS_VERSION = "9";
        state.setEnv(env);
        assert.ok(state.getEnvIssue() !== null);
    });

    it("_resetForTest 清陈旧标志", () => {
        state.setEnv(VALID_ENV());
        state.markStale("STALE-MARKER");
        state._resetForTest();
        state.setEnv(VALID_ENV());
        assert.strictEqual(state.getEnvIssue(), null, "重置后陈旧不残留");
    });
});

/* ------------------------------------------------------------------ */
/* source 采集失败/恢复的陈旧与边沿事件                                 */
/* ------------------------------------------------------------------ */

describe("source 采集失败陈旧化与翻转边沿事件(P0)", () => {
    const envCollectAny = envCollect as unknown as { collectEnvironmentSnapshot: unknown };
    const originalCollect = envCollectAny.collectEnvironmentSnapshot;
    let fired = 0;
    let disp: { dispose(): void };

    /** 打桩采集成败(tsc CommonJS 输出为调用点属性查找,替换模块导出即生效) */
    function stubCollect(outcome: { env?: Record<string, string>; reason?: string }): void {
        envCollectAny.collectEnvironmentSnapshot = async () => outcome;
    }

    beforeEach(() => {
        state._resetForTest();
        reloadPrompt._resetForTest(); // P2:提示层模块态(冷却/in-flight)不跨用例泄漏
        fired = 0;
        disp = state.onEnvChanged(() => { fired++; });
    });

    afterEach(() => {
        envCollectAny.collectEnvironmentSnapshot = originalCollect;
        disp.dispose();
        state._resetForTest();
        reloadPrompt._resetForTest();
    });

    it("初始无 env 首次采集失败:不发事件(无可用→不可用翻转),判定走未采集分支", async () => {
        stubCollect({ reason: "stub-first-fail" });
        await source.sourceRosAndWorkspace();
        assert.strictEqual(fired, 0, "首次失败非翻转边沿,不发事件");
        const issue = state.getEnvIssue();
        assert.ok(issue !== null);
        assert.ok(!issue.includes("stub-first-fail"), "无 env 走未采集分支而非陈旧分支");
    });

    it("可用→失败→再失败:首轮恰发一次事件(陈旧原因透传),连续失败不再发(无风暴)", async () => {
        state.setEnv(VALID_ENV());
        assert.strictEqual(state.getEnvIssue(), null);
        stubCollect({ reason: "stub-outage" });
        await source.sourceRosAndWorkspace();
        assert.strictEqual(fired, 1, "可用→不可用翻转边沿补发事件(修失败不发事件)");
        const issue = state.getEnvIssue();
        assert.ok(issue !== null && issue.includes("stub-outage"), "陈旧原因透传");
        await source.sourceRosAndWorkspace();
        assert.strictEqual(fired, 1, "连续失败不重复发(无事件风暴)");
        assert.ok(state.getEnvIssue() !== null, "持续失败持续关门");
    });

    it("陈旧后采集成功且快照内容不变:靠翻转边沿补发恢复事件,陈旧清除判定回可用", async () => {
        state.setEnv(VALID_ENV());
        stubCollect({ reason: "stub-outage" });
        await source.sourceRosAndWorkspace();
        assert.strictEqual(fired, 1);
        stubCollect({ env: VALID_ENV() });   // 与旧快照同内容:externalChanged=false,翻转边沿必须兜住
        await source.sourceRosAndWorkspace();
        assert.strictEqual(fired, 2, "陈旧→可用翻转边沿补发恢复事件");
        assert.strictEqual(state.getEnvIssue(), null, "恢复即开门");
    });

    it("可用期间采集成功且快照不变:不发事件(既有语义保持)", async () => {
        state.setEnv(VALID_ENV());
        stubCollect({ env: VALID_ENV() });
        await source.sourceRosAndWorkspace();
        assert.strictEqual(fired, 0);
        assert.strictEqual(state.getEnvIssue(), null);
    });

    it("envVerdictFlipped 真值表:仅异或为真", () => {
        assert.strictEqual(source.envVerdictFlipped(true, true), false);
        assert.strictEqual(source.envVerdictFlipped(false, false), false);
        assert.strictEqual(source.envVerdictFlipped(true, false), true);
        assert.strictEqual(source.envVerdictFlipped(false, true), true);
    });
});

/* ------------------------------------------------------------------ */
/* ros2 PATH 存在性探针(env-collect)                                   */
/* ------------------------------------------------------------------ */

describe("ros2 PATH 存在性探针(P0)", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ros2-probe-"));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("快照缺 PATH 键 → 失败原因", () => {
        const reason = envCollect.probeRos2Executable({});
        assert.ok(reason !== null && reason.length > 0);
    });

    it("PATH 目录命中 ros2 可执行 → 通过", () => {
        const name = process.platform === "win32" ? "ros2.cmd" : "ros2";
        fs.writeFileSync(path.join(tmp, name), "");
        assert.strictEqual(envCollect.probeRos2Executable({ PATH: tmp }), null);
    });

    it("PATH 目录存在但无 ros2 → 失败原因", () => {
        const reason = envCollect.probeRos2Executable({ PATH: tmp });
        assert.ok(reason !== null && reason.length > 0);
    });

    it("Path 键(Windows 大小写形态)同样识别", () => {
        const name = process.platform === "win32" ? "ros2.exe" : "ros2";
        fs.writeFileSync(path.join(tmp, name), "");
        assert.strictEqual(envCollect.probeRos2Executable({ Path: tmp }), null);
    });
});
