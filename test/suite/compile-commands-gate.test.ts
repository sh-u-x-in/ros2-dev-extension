/**
 * compile_commands 合并写入口双守卫测试(2026-10-18 P1+P5,双宿主可跑)
 *
 * 验证 mergeCompileCommands 入口:
 *  - 无工作区根 → 不写盘且不把目标解析成相对路径误写宿主 cwd(真 bug 回归锁);
 *  - 环境门关(无 env / 陈旧)→ 零写盘;
 *  - 门开 → build/<pkg>/compile_commands.json 合并写出 build/compile_commands.json。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/compile-commands-gate.test.js --exit
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const state = require("../../src/ros2/environment/state") as {
    _resetForTest(): void;
    setEnv(env: Record<string, string>): void;
    markStale(reason: string): void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeCompileCommands } = require("../../src/ros2/environment/compile-commands") as {
    mergeCompileCommands(workspaceRoot: string): void;
};

/** 轮询等待合并链落地(mergeChain 私有,以产物文件出现为准) */
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (cond()) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
}

describe("compile_commands 合并写入口双守卫(P1+P5)", () => {
    let wsRoot: string;

    beforeEach(() => {
        state._resetForTest();
        wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-merge-"));
        fs.mkdirSync(path.join(wsRoot, "build", "pkg_a"), { recursive: true });
        fs.writeFileSync(
            path.join(wsRoot, "build", "pkg_a", "compile_commands.json"),
            JSON.stringify([{ directory: wsRoot, command: "cc -c a.cpp", file: "a.cpp" }]),
            "utf-8"
        );
    });

    afterEach(() => {
        state._resetForTest();
        fs.rmSync(wsRoot, { recursive: true, force: true });
    });

    it("无工作区根 → 不写盘(相对路径误写宿主 cwd 真 bug 回归锁)", async () => {
        const before = fs.existsSync("build/compile_commands.json"); // 宿主 cwd 相对路径(误写目标旧形态)
        mergeCompileCommands("");
        await new Promise((r) => setTimeout(r, 150));
        assert.strictEqual(fs.existsSync("build/compile_commands.json"), before, "不得在宿主 cwd 造出 build/compile_commands.json");
    });

    it("门关(无 env)→ 零写盘", async () => {
        mergeCompileCommands(wsRoot);
        const appeared = await waitFor(() => fs.existsSync(path.join(wsRoot, "build", "compile_commands.json")), 400);
        assert.strictEqual(appeared, false, "门关零写盘");
    });

    it("门关(陈旧)→ 零写盘", async () => {
        state.setEnv({ ROS_DISTRO: "humble", ROS_VERSION: "2", PATH: "/usr/bin", AMENT_PREFIX_PATH: "/opt/ros/humble" });
        state.markStale("stale-cc-probe");
        mergeCompileCommands(wsRoot);
        const appeared = await waitFor(() => fs.existsSync(path.join(wsRoot, "build", "compile_commands.json")), 400);
        assert.strictEqual(appeared, false, "陈旧即关门,零写盘");
    });

    it("门开 → 合并写出,内容为各包条目并集", async () => {
        state.setEnv({ ROS_DISTRO: "humble", ROS_VERSION: "2", PATH: "/usr/bin", AMENT_PREFIX_PATH: "/opt/ros/humble" });
        mergeCompileCommands(wsRoot);
        const appeared = await waitFor(() => fs.existsSync(path.join(wsRoot, "build", "compile_commands.json")));
        assert.strictEqual(appeared, true, "门开合并写盘");
        const merged = JSON.parse(fs.readFileSync(path.join(wsRoot, "build", "compile_commands.json"), "utf-8")) as unknown[];
        assert.strictEqual(merged.length, 1, "单包一条目");
        assert.strictEqual((merged[0] as { file: string }).file, "a.cpp");
    });
});
