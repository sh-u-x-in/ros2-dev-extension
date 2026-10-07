/**
 * RosTaskRunner 纯函数单测(2026-08-25;2026-09-22 随模板接线收窄;2026-09-25 run/launch 同批收窄)
 *
 * 验证「参数 → 命令行」纯函数(toInstallTypeFlags / toRosdepCommand / toDoctorCommand),
 * 零 vscode 依赖,不触发真实任务执行。
 * ⚠️ `toColconBuildCommand` 已删除(2026-09-22):扩展自己的 colcon 命令一律由设置模板展开(见 share 单测);
 * ⚠️ `toRos2RunCommand` / `toRos2LaunchCommand` 已删除(2026-09-25):ros2 run/launch 同样收成
 *    "调用方(run/share-spec.ts)按设置模板展开整条 argv,本层只执行" —— 展开用例见 ros-run-spec.test.ts。
 * 薄执行壳(runShellTask)不在无头环境验证(依赖 vscode.tasks.executeTask,属有头集成范围)。
 *
 * 无头(npx mocha)时通过 _vscode-stub 拦截 require("vscode")(模块顶层 import 门面/host);
 * 有头(npm test)走真实 vscode。
 */

import * as assert from "assert";

import { installVscodeStub } from "./_vscode-stub";

// 必须先装 vscode stub 再 require 被测模块(顶层 import 会提前 require("vscode"),故延迟 require)
installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require("../../src/ros2/commands/ros_task_runner") as typeof import("../../src/ros2/commands/ros_task_runner");

describe("RosTaskRunner 纯函数:toInstallTypeFlags(2026-09-16 拆轴:形态×布局)", () => {
    it("四象限映射:实体+分包=无参数;符号/合并各出一枚;两轴可叠加", () => {
        assert.deepStrictEqual(runner.toInstallTypeFlags({ method: "copy", layout: "isolated" }), []);
        assert.deepStrictEqual(runner.toInstallTypeFlags({ method: "symlink", layout: "isolated" }), ["--symlink-install"]);
        assert.deepStrictEqual(runner.toInstallTypeFlags({ method: "copy", layout: "merged" }), ["--merge-install"]);
        assert.deepStrictEqual(runner.toInstallTypeFlags({ method: "symlink", layout: "merged" }), ["--symlink-install", "--merge-install"]);
    });
});

describe("RosTaskRunner 纯函数:rosdep/doctor", () => {
    it("toRosdepCommand:默认 --from-paths src;workspace 覆盖", () => {
        assert.deepStrictEqual(runner.toRosdepCommand(), ["install", "--from-paths", "src", "--ignore-src", "-r", "-y"]);
        assert.deepStrictEqual(runner.toRosdepCommand({ workspace: "/ws/src" }), ["install", "--from-paths", "/ws/src", "--ignore-src", "-r", "-y"]);
    });

    it("toDoctorCommand:ros2 doctor", () => {
        assert.deepStrictEqual(runner.toDoctorCommand(), ["doctor"]);
    });
});
