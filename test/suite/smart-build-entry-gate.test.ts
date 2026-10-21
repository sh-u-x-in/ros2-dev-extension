/**
 * smart-build 入口域门测试(2026-10-17,无头单跑)
 *
 * 验证:无可用 ROS 2 环境时,面板命令 ROS2.colcon.build 在入口第一句拒绝并提示原因,
 * 不再让用户陪跑包多选/参数选择两轮弹窗(2026-10-17 用户裁定"键位保持穿透 + 面板早退")。
 * 文案复用 ros_task_runner.colcon_build 终点门槛同键(双语已在册)。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/smart-build-entry-gate.test.js --exit
 * (--exit 必须:被测链经 composeApi 引入的模块持有活句柄,mocha 默认不退出,测试结果本身先已落盘)
 */

import * as assert from "assert";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";

// 必须在 require 被测模块之前安装 vscode stub(被测链顶层 import vscode,无头环境不可解析)
installVscodeStub();

// 无头(桩已装)= true;集成宿主(真实 vscode,会弹真窗)该用例跳过
const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;
const req = createRequire(__filename);

describe("smart-build 入口域门", () => {
    it("无可用 ROS 2 环境 → 入口拒绝:弹环境错误、不取包列表", async function () {
        if (!HEADLESS) { this.skip(); }
        const vsc = req("vscode") as any;
        const errors: unknown[][] = [];
        vsc.window.showErrorMessage = async (...a: unknown[]) => {
            errors.push(a);
            return undefined;
        };
        // 桩 workspace 无 workspaceFolders:补最小形状越过"无工作区"前置检查,直达域门
        (vsc.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: "D:/fake-ws" } }];
        let getPackagesCalled = false;
        const smart = req("../../src/build-tool/package-service/build/smart-build") as {
            runColconBuild(data: unknown): Promise<void>;
        };
        await smart.runColconBuild({
            getBuildPackages: async () => {
                getPackagesCalled = true;
                return [];
            },
        });
        assert.strictEqual(errors.length, 1, "入口一句拒绝(无环境)");
        assert.ok(String(errors[0][0]).includes("No usable ROS 2 environment detected"), "文案 = ros_task_runner 同键");
        assert.strictEqual(getPackagesCalled, false, "不拉包列表(不陪跑弹窗)");
    });

    it("陈旧环境(旧快照+最近采集失败)→ 入口同样拒绝且陈旧原因透传", async function () {
        if (!HEADLESS) { this.skip(); }
        const vsc = req("vscode") as any;
        // 种一个"曾经可用"的快照再置陈旧:旧口径下 getEnvIssue 会判可用放行,P0 后必须关门
        const state = req("../../src/ros2/environment/state") as {
            _resetForTest(): void;
            setEnv(env: Record<string, string>): void;
            markStale(reason: string): void;
        };
        state._resetForTest();
        state.setEnv({ ROS_DISTRO: "humble", ROS_VERSION: "2", PATH: "/usr/bin", AMENT_PREFIX_PATH: "/opt/ros/humble" });
        state.markStale("stale-reason-probe");
        const errors: unknown[][] = [];
        vsc.window.showErrorMessage = async (...a: unknown[]) => {
            errors.push(a);
            return undefined;
        };
        (vsc.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: "D:/fake-ws" } }];
        let getPackagesCalled = false;
        const smart = req("../../src/build-tool/package-service/build/smart-build") as {
            runColconBuild(data: unknown): Promise<void>;
        };
        await smart.runColconBuild({
            getBuildPackages: async () => {
                getPackagesCalled = true;
                return [];
            },
        });
        assert.strictEqual(errors.length, 1, "入口一句拒绝(陈旧环境)");
        assert.ok(String(errors[0][0]).includes("stale-reason-probe"), "陈旧原因透传进提示 {0}");
        assert.strictEqual(getPackagesCalled, false, "不拉包列表(不陪跑弹窗)");
        state._resetForTest();
    });
});
