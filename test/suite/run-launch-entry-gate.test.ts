/**
 * run/launch/单包构建 入口环境早退测试(2026-10-18 P1+P5,无头单跑)
 *
 * 验证三个执行体的入口门(三入口汇流处):
 *  - smart-run.runRosExecutable(面板)/runExecutableFromTree(侧边栏 ▶)
 *  - smart-launch.runRosLaunchFile(面板)/launchFileFromTree(侧边栏 ▶)
 *  - single-package.buildSinglePackageByName(右键 Release/Debug + 侧边栏构建此包)
 * 门关(无 env / 陈旧)→ 一句拒绝 + 数据源零取数 + 选择记忆零写盘(修双弹窗链:入口早退后
 * notifyStaleIfNeeded 路径不再到达);门开 → 进入选择链(QuickPick 队列空 = 用户取消,干净返回)。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/run-launch-entry-gate.test.js --exit
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const state = require("../../src/ros2/environment/state") as {
    _resetForTest(): void;
    setEnv(env: Record<string, string>): void;
    markStale(reason: string): void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stateFile = require("../../src/build-tool/package-service/share/state-file") as {
    getStateFilePath(): string;
    setStateStorageRoot(dir: string | undefined): void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const smartRun = require("../../src/build-tool/package-service/run/smart-run") as {
    runRosExecutable(data: unknown): Promise<void>;
    runExecutableFromTree(req: { pkg: string; executable: string }): Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const smartLaunch = require("../../src/build-tool/package-service/run/smart-launch") as {
    runRosLaunchFile(data: unknown): Promise<void>;
    launchFileFromTree(req: { pkg: string; name: string; installPath: string }): Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const singlePackage = require("../../src/build-tool/package-service/build/single-package") as {
    buildSinglePackageByName(data: unknown, name: string, variant?: string): Promise<void>;
};

/** 计数假数据源:任何取数都记一笔(入口门应保证零取数) */
function fakeData(): { calls: Record<string, number>; listPackages: () => Promise<string[]>; launchFiles: () => Promise<string[]>; getBuildPackages: () => Promise<string[]>; ownersOfSource: () => Promise<unknown>; launchFileOfSource: () => Promise<undefined> } {
    const calls: Record<string, number> = {};
    const bump = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; return []; };
    return {
        calls,
        listPackages: async () => bump("listPackages"),
        launchFiles: async () => bump("launchFiles"),
        getBuildPackages: async () => bump("getBuildPackages"),
        ownersOfSource: async () => bump("ownersOfSource"),
        launchFileOfSource: async () => { bump("launchFileOfSource"); return undefined; },
    };
}

describe("run/launch/单包构建 入口环境早退(P1+P5)", () => {
    let wsRoot: string;
    let storageRoot: string;
    let errors: unknown[][];
    let vsc: any;

    beforeEach(function () {
        if (!HEADLESS) { this.skip(); }
        state._resetForTest();
        wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "entry-gate-"));
        storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "entry-gate-storage-"));
        stateFile.setStateStorageRoot(storageRoot); // 零写盘断言的观察点(2026-10-21 转入地下模型)
        vsc = require("vscode") as any;
        errors = [];
        vsc.window.showErrorMessage = async (...a: unknown[]) => { errors.push(a); return undefined; };
        vsc.window.showWarningMessage = async (...a: unknown[]) => { errors.push(a); return undefined; };
        vsc.window.showInformationMessage = async () => undefined;
        vsc.window.showQuickPick = async () => undefined; // 队列空 = 取消(门开用例走到选择链即取消返回)
        (vsc.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: wsRoot } }];
    });

    afterEach(function () {
        if (!wsRoot) { return; } // 集成宿主 beforeEach 已整组跳过,未建临时目录
        state._resetForTest();
        stateFile.setStateStorageRoot(undefined);
        fs.rmSync(wsRoot, { recursive: true, force: true });
        fs.rmSync(storageRoot, { recursive: true, force: true });
    });

    it("无 env:面板 run → 一句拒绝,listPackages 零取数,记忆零写盘", async function () {
        if (!HEADLESS) { this.skip(); }
        const data = fakeData();
        await smartRun.runRosExecutable(data);
        assert.strictEqual(errors.length, 1, "入口一句拒绝");
        assert.ok(String(errors[0][0]).includes("cannot execute"), "run 域拒绝文案(execute 键)");
        assert.strictEqual((data.calls.listPackages ?? 0), 0, "不取包列表(不陪跑两轮选择)");
        assert.strictEqual(fs.existsSync(stateFile.getStateFilePath()), false, "选择记忆零写盘");
    });

    it("无 env:侧边栏 ▶ run → 一句拒绝(树入口同门)", async function () {
        if (!HEADLESS) { this.skip(); }
        await smartRun.runExecutableFromTree({ pkg: "demo", executable: "node" });
        assert.strictEqual(errors.length, 1);
        assert.ok(String(errors[0][0]).includes("cannot execute"));
    });

    it("陈旧环境(旧快照+采集失败):面板 launch → 一句拒绝且陈旧原因透传,launchFiles 零取数", async function () {
        if (!HEADLESS) { this.skip(); }
        state.setEnv({ ROS_DISTRO: "humble", ROS_VERSION: "2", PATH: "/usr/bin", AMENT_PREFIX_PATH: "/opt/ros/humble" });
        state.markStale("stale-entry-probe");
        const data = fakeData();
        await smartLaunch.runRosLaunchFile(data);
        assert.strictEqual(errors.length, 1, "陈旧即关门(P0 判据)");
        assert.ok(String(errors[0][0]).includes("stale-entry-probe"), "陈旧原因透传");
        assert.strictEqual((data.calls.launchFiles ?? 0), 0, "不扫 launch 清单");
        assert.strictEqual(fs.existsSync(stateFile.getStateFilePath()), false, "选择记忆零写盘");
    });

    it("无 env:侧边栏 ▶ launch → 一句拒绝(树入口同门)", async function () {
        if (!HEADLESS) { this.skip(); }
        await smartLaunch.launchFileFromTree({ pkg: "demo", name: "demo.launch.py", installPath: `${wsRoot}/install/demo` });
        assert.strictEqual(errors.length, 1);
        assert.ok(String(errors[0][0]).includes("cannot execute"));
    });

    it("无 env:单包构建 → 一句拒绝且 getBuildPackages 零取数(三入口汇流单点)", async function () {
        if (!HEADLESS) { this.skip(); }
        const data = fakeData();
        await singlePackage.buildSinglePackageByName(data, "demo_pkg", "release");
        assert.strictEqual(errors.length, 1);
        assert.ok(String(errors[0][0]).includes("cannot build"), "build 域拒绝文案");
        assert.strictEqual((data.calls.getBuildPackages ?? 0), 0, "不取包表(前检/记忆展开都在门后)");
    });

    it("门开:种可用环境后 ▶ run 进入选择链(QuickPick 取消干净返回,零拒绝弹窗)", async function () {
        if (!HEADLESS) { this.skip(); }
        state.setEnv({ ROS_DISTRO: "humble", ROS_VERSION: "2", PATH: "/usr/bin", AMENT_PREFIX_PATH: "/opt/ros/humble" });
        await smartRun.runExecutableFromTree({ pkg: "demo", executable: "node" });
        assert.strictEqual(errors.length, 0, "门开放行(取消于参数选择,非拒绝)");
    });
});
