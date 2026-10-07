/**
 * Ros2ServiceApi 最小单测(2026-08-25)
 *
 * 验证命令查询/状态类的输出解析与错误降级语义(需求 B),不依赖真实 ROS 环境:
 * mock commandRunner.exec 的 stdout,验证解析逻辑;查询类失败 → 容错返回空值。
 *
 * 无头(npx mocha)时通过 _vscode-stub 拦截 require("vscode")(environment 门面依赖 state 的 vscode.EventEmitter);
 * 有头(npm test)走真实 vscode。
 */

import * as assert from "assert";

import { installVscodeStub } from "./_vscode-stub";

// 必须先装 vscode stub 再 require 依赖 vscode 的被测模块(顶层值 import 会提前 require("vscode"),故延迟 require)
installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiMod = require("../../src/ros2/commands/ros2_service_api") as typeof import("../../src/ros2/commands/ros2_service_api");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const monitorApiMod = require("../../src/ros2/consumers/monitor/monitor-api") as typeof import("../../src/ros2/consumers/monitor/monitor-api");

/** fake CommandRunner(注入 ros2_service_api;exec 按用例替换,2026-08-26 组合根注入模式) */
const fakeCommandRunner: any = {
    exec: async () => { throw new Error("exec 未被 mock"); },
    spawn: () => { throw new Error("spawn 未 mock"); },
};
// 注入在 beforeEach(每用例前)执行:ros2_service_api 是模块级单例,
// 多测试文件共享——顶层注入会被后加载文件覆盖,合跑时串味。


/** 记录最近一次 exec 的命令字符串 */
let lastCommand = "";



/** mock exec:resolve 指定 stdout */
function mockExecOk(stdout: string): void {
    // mock 即注入时机:单例被多测试文件共享,必须在此刻重新注入本文件 fake
    apiMod.setCommandRunner(fakeCommandRunner);
    fakeCommandRunner.exec = async (command: string) => {
        lastCommand = command;
        return { stdout, stderr: "", code: 0 };
    };
}

/** mock exec:reject(模拟命令失败) */
function mockExecFail(): void {
    apiMod.setCommandRunner(fakeCommandRunner);
    fakeCommandRunner.exec = async () => {
        const err = new Error("Command failed") as Error & { stderr?: string };
        err.stderr = "模拟错误输出";
        throw err;
    };
}

describe("Ros2ServiceApi 包/接口查询", () => {
    it("pkg_list:每行一个包名", async () => {
        mockExecOk("ament_cmake\naplib\n");
        const result = await apiMod.ros2ServiceApi.pkg_list({});
        assert.deepStrictEqual(result, ["ament_cmake", "aplib"]);
    });

    it("pkg_prefix:返回 trim 后的路径;默认带 --share", async () => {
        mockExecOk("/opt/ros/humble/share/ament_cmake\n");
        const result = await apiMod.ros2ServiceApi.pkg_prefix({ name: "ament_cmake" });
        assert.strictEqual(result, "/opt/ros/humble/share/ament_cmake");
        assert.ok(lastCommand.includes("--share"));
    });

    it("pkg_prefix:shared=false 不带 --share", async () => {
        mockExecOk("/opt/ros/humble\n");
        const result = await apiMod.ros2ServiceApi.pkg_prefix({ name: "ament_cmake", shared: false });
        assert.strictEqual(result, "/opt/ros/humble");
        assert.ok(!lastCommand.includes("--share"));
    });

    it("pkg_executables:每行 'pkg exe',取第二列", async () => {
        mockExecOk("demo_nodes_cpp talker\ndemo_nodes_cpp listener\n");
        const result = await apiMod.ros2ServiceApi.pkg_executables({ name: "demo_nodes_cpp" });
        assert.deepStrictEqual(result, ["talker", "listener"]);
    });

    it("pkg_executables_full:--full-path 每行一个纯路径(LJ-5)", async () => {
        mockExecOk("/opt/ros/humble/lib/demo_nodes_cpp/talker\n/opt/ros/humble/lib/demo_nodes_cpp/listener\n");
        const result = await apiMod.ros2ServiceApi.pkg_executables_full({ name: "demo_nodes_cpp" });
        assert.deepStrictEqual(result, ["/opt/ros/humble/lib/demo_nodes_cpp/talker", "/opt/ros/humble/lib/demo_nodes_cpp/listener"]);
        assert.ok(lastCommand.includes("--full-path"), lastCommand);
    });

    it("pkg_executables_full:失败 → null(LJ-5)", async () => {
        mockExecFail();
        assert.strictEqual(await apiMod.ros2ServiceApi.pkg_executables_full({ name: "x" }), null);
    });

    it("interface_list:每行一个接口", async () => {
        mockExecOk("std_msgs/msg/Header\nstd_msgs/msg/String\n");
        const result = await apiMod.ros2ServiceApi.interface_list({});
        assert.deepStrictEqual(result, ["std_msgs/msg/Header", "std_msgs/msg/String"]);
    });

    it("查询失败:容错返回 null(不抛错;null=失败, 空数组/空串=成功但空)", async () => {
        mockExecFail();
        assert.strictEqual(await apiMod.ros2ServiceApi.pkg_list({}), null);
        assert.strictEqual(await apiMod.ros2ServiceApi.interface_list({}), null);
        assert.strictEqual(await apiMod.ros2ServiceApi.pkg_prefix({ name: "x" }), null);
        assert.strictEqual(await apiMod.ros2ServiceApi.pkg_executables({ name: "x" }), null);
    });

    it("查询成功但空输出:返回 []/''(合法空,与失败 null 区分)", async () => {
        mockExecOk("");
        assert.deepStrictEqual(await apiMod.ros2ServiceApi.pkg_list({}), []);
        assert.deepStrictEqual(await apiMod.ros2ServiceApi.interface_list({}), []);
        assert.deepStrictEqual(await apiMod.ros2ServiceApi.pkg_executables({ name: "x" }), []);
        assert.strictEqual(await apiMod.ros2ServiceApi.pkg_prefix({ name: "x" }), "");
    });
});

describe("Ros2ServiceApi 参数/生命周期", () => {
    it("param_list:过滤 '/' 开头系统参数与 ':' 结尾分组", async () => {
        mockExecOk("/rosout\nuse_sim_time\n/parameter_events:\nparam_a:\n");
        const result = await apiMod.ros2ServiceApi.param_list({ node: "/talker" });
        assert.deepStrictEqual(result, ["use_sim_time"]);
    });

    it("param_get:返回值文本", async () => {
        mockExecOk("Integer value is: 10\n");
        const result = await apiMod.ros2ServiceApi.param_get({ node: "/talker", param: "num" });
        assert.strictEqual(result, "Integer value is: 10");
    });

    it("lifecycle_nodes:过滤 ros2cli 提示行", async () => {
        mockExecOk("/talker\nros2cli daemon is running\n/listener\n");
        const result = await apiMod.ros2ServiceApi.lifecycle_nodes({});
        assert.deepStrictEqual(result, ["/talker", "/listener"]);
    });

    it("lifecycle_get:按标签前缀匹配标准状态", async () => {
        mockExecOk("active [3]\n");
        const result = await apiMod.ros2ServiceApi.lifecycle_get({ node: "/talker" });
        assert.deepStrictEqual(result, { id: 3, label: "active" });
    });

    it("lifecycle_get:未知状态返回 null", async () => {
        mockExecOk("weird_state [9]\n");
        const result = await apiMod.ros2ServiceApi.lifecycle_get({ node: "/talker" });
        assert.strictEqual(result, null);
    });

    it("lifecycle_get:查询失败返回 null", async () => {
        mockExecFail();
        assert.strictEqual(await apiMod.ros2ServiceApi.lifecycle_get({ node: "/talker" }), null);
    });

    it("param/lifecycle 查询失败:返回 null(不抛错)", async () => {
        mockExecFail();
        assert.strictEqual(await apiMod.ros2ServiceApi.param_list({ node: "/x" }), null);
        assert.strictEqual(await apiMod.ros2ServiceApi.param_get({ node: "/x", param: "p" }), null);
        assert.strictEqual(await apiMod.ros2ServiceApi.lifecycle_nodes({}), null);
    });

    it("lifecycle_set:透传节点与转换标签(重设计阶段 2 自数字 id 改标签);失败 reject", async () => {
        mockExecOk("Transitioning successful\n");
        await apiMod.ros2ServiceApi.lifecycle_set({ node: "/talker", transition: "configure" });
        assert.ok(lastCommand.includes("lifecycle set /talker configure"));

        mockExecFail();
        await assert.rejects(apiMod.ros2ServiceApi.lifecycle_set({ node: "/talker", transition: "configure" }));
    });

});

describe("Ros2ServiceApi colcon_list", () => {
    // 2026-09-22:实现用 path.resolve(base, 输出路径) 归一,故期望值也按同一方式算(平台无关;原先写死 "/ws/src/..." 在 Windows 上必失败)
    const resolve = (p: string): string => require("path").resolve("/ws/src", p);

    it("常规模式:每行 'name path'(空格/tab 分隔)", async () => {
        mockExecOk("demo_nodes_cpp /ws/src/demo_nodes_cpp\nmy_pkg\t/ws/src/my_pkg\n");
        const result = await apiMod.ros2ServiceApi.colcon_list({ base_path: "/ws/src" });
        assert.deepStrictEqual(result, [
            { name: "demo_nodes_cpp", path: resolve("/ws/src/demo_nodes_cpp") },
            { name: "my_pkg", path: resolve("/ws/src/my_pkg") },
        ]);
        assert.ok(lastCommand.includes("--base-paths"));
        assert.ok(!lastCommand.includes(" -p"));
    });

    it("packages_only:每行一个路径,包名取 basename", async () => {
        mockExecOk("/ws/src/demo_nodes_cpp\n/ws/src/my_pkg\n");
        const result = await apiMod.ros2ServiceApi.colcon_list({ base_path: "/ws/src", packages_only: true });
        assert.deepStrictEqual(result, [
            { name: "demo_nodes_cpp", path: resolve("/ws/src/demo_nodes_cpp") },
            { name: "my_pkg", path: resolve("/ws/src/my_pkg") },
        ]);
        assert.ok(lastCommand.includes(" -p"));
    });

    it("失败:容错返回 null", async () => {
        mockExecFail();
        assert.strictEqual(await apiMod.ros2ServiceApi.colcon_list({}), null);
    });

    it("成功但空输出:返回 [](合法空,区别于失败 null)", async () => {
        mockExecOk("");
        assert.deepStrictEqual(await apiMod.ros2ServiceApi.colcon_list({}), []);
    });
});
