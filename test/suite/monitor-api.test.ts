/**
 * MonitorApi 最小单测(2026-08-26;2026-10-06 随"彻底推倒重来"信封帧+订阅制重构)
 *
 * 验证状态页消费者对象(monitorApi)的:
 *  - 仓库投影(nodes/topics/services/actions/lifecycle_nodes;全量图推送入库);
 *  - 订阅制参数(param_structure push 入库→懒树;param_values=订阅+基账;param_view 纯投影);
 *  - 生命周期(权威 push 入库 → lifecycle_get/lifecycle_node_info/available_states 仓库读数);
 *  - C 操作(helper_running ping / lifecycle_transition 直发 label 走 CLI)。
 *
 * 不依赖真实 ROS 环境:mock param-helper-client 的函数 + 注入 fake Ros2ServiceApi。
 * 无头(npx mocha)时通过 _vscode-stub 拦截 require("vscode");有头走真实 vscode。
 */

import * as assert from "assert";

import { installVscodeStub } from "./_vscode-stub";

// 必须先装 vscode stub 再 require 依赖 vscode 的被测模块(顶层值 import 会提前 require("vscode"),故延迟 require)
installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const monitorApiMod = require("../../src/ros2/consumers/monitor/monitor-api") as typeof import("../../src/ros2/consumers/monitor/monitor-api");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const paramHelperClientMod = require("../../src/ros2/consumers/monitor/helper/param-helper-client") as typeof import("../../src/ros2/consumers/monitor/helper/param-helper-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const paramTreeBuildMod = require("../../src/ros2/consumers/monitor/helper/param-tree-build") as typeof import("../../src/ros2/consumers/monitor/helper/param-tree-build");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const helperStateMod = require("../../src/ros2/consumers/monitor/helper/helper-state") as typeof import("../../src/ros2/consumers/monitor/helper/helper-state");

/** fake Ros2ServiceApi(注入到 monitorApi;param_list/param_get/lifecycle_set 公共 API 面用) */
function installFakeRos2Service(overrides: Record<string, unknown> = {}): any {
    const fake: any = {
        pkg_list: async () => [],
        pkg_prefix: async () => "",
        pkg_executables: async () => [],
        interface_list: async () => [],
        param_list: async () => [],
        param_get: async () => null,
        lifecycle_nodes: async () => [],
        lifecycle_get: async () => null,
        lifecycle_set: async () => undefined,
        colcon_list: async () => [],
        ...overrides,
    };
    monitorApiMod.setRos2ServiceApi(fake);
    return fake;
}

/** 助手客户端 mock(默认全部抛错:未 mock 的函数走失败降级路径) */
function mockHelper(overrides: Record<string, unknown> = {}): void {
    const defaults: Record<string, unknown> = {
        pingHelper: async () => { throw new Error("ping 未 mock"); },
        getParamValues: async () => { throw new Error("getParamValues 未 mock"); },
        ungetParamValues: async () => { throw new Error("ungetParamValues 未 mock"); },
        resyncSnapshot: async () => { throw new Error("resyncSnapshot 未 mock"); },
    };
    const merged = { ...defaults, ...overrides };
    // 注入缝替换(tsc 具名导入编译为本地绑定,monkey-patch 模块属性不影响调用点)
    (monitorApiMod as any).setHelperClientForTest(merged);
    monitorApiMod._resetGraphCacheForTest();
    helperStateMod.setHelperRunning(true);   // 投影以"在线"为前提
}

/** 推送帧入库助手:模拟服务端 graph 全量推送(节点=全名一列,topics/services=映射) */
function pushGraph(parts: { nodes?: string[]; topics?: Record<string, string>; services?: Record<string, string>; lifecycle?: string[] }): void {
    monitorApiMod.ingestHelperPush({
        kind: "graph",
        nodes: parts.nodes ?? [], topics: parts.topics ?? {},
        services: parts.services ?? {}, lifecycle: parts.lifecycle ?? [],
    });
}

function pushStructure(node: string, params: { name: string; type: string }[]): void {
    monitorApiMod.ingestHelperPush({ kind: "param_structure", node, params });
}

function pushLifecycle(node: string, info: {
    state: string; states: string[];
    edges: { label: string; from: string; to: string }[];
    available: string[];
}): void {
    monitorApiMod.ingestHelperPush({ kind: "lifecycle", node, ...info });
}

describe("MonitorApi A 列表查询(仓库投影)", () => {
    beforeEach(() => mockHelper());

    it("nodes:graph 全量推送入库 → 全名拆 name/namespace;仓库空 → {success:false,data:[]}", async () => {
        pushGraph({ nodes: ["/talker", "/sub/nav"] });
        assert.deepStrictEqual(await monitorApiMod.monitorApi.nodes(), {
            success: true,
            data: [{ name: "talker", namespace: "/" }, { name: "nav", namespace: "/sub/" }],
        });

        monitorApiMod._resetGraphCacheForTest();
        assert.deepStrictEqual(await monitorApiMod.monitorApi.nodes(), { success: false, data: [] });
    });

    it("topics:映射 → 数组;仓库空 → {success:false,data:[]}", async () => {
        pushGraph({ topics: { "/chatter": "std_msgs/msg/String" } });
        assert.deepStrictEqual(await monitorApiMod.monitorApi.topics(), {
            success: true,
            data: [{ name: "/chatter", type: "std_msgs/msg/String" }],
        });

        monitorApiMod._resetGraphCacheForTest();
        assert.deepStrictEqual(await monitorApiMod.monitorApi.topics(), { success: false, data: [] });
    });

    it("services:映射 → 数组;仓库空 → {success:false,data:[]}", async () => {
        pushGraph({ services: { "/get_pose": "sensor_msgs/GetPose" } });
        assert.deepStrictEqual(await monitorApiMod.monitorApi.services(), {
            success: true,
            data: [{ name: "/get_pose", type: "sensor_msgs/GetPose" }],
        });

        monitorApiMod._resetGraphCacheForTest();
        assert.deepStrictEqual(await monitorApiMod.monitorApi.services(), { success: false, data: [] });
    });

    it("actions:classify 从仓库服务清单聚合三件套", async () => {
        pushGraph({ services: {
            "/fibonacci/_action/send_goal": "example_interfaces/action/Fibonacci_SendGoal",
            "/fibonacci/_action/cancel_goal": "action_msgs/srv/CancelGoal",
            "/fibonacci/_action/get_result": "example_interfaces/action/Fibonacci_GetResult",
        } });
        assert.deepStrictEqual(await monitorApiMod.monitorApi.actions(), {
            success: true,
            data: [{ name: "/fibonacci", type: "example_interfaces/action/Fibonacci", verbs: ["cancel_goal", "get_result", "send_goal"] }],
        });

        monitorApiMod._resetGraphCacheForTest();
        assert.deepStrictEqual(await monitorApiMod.monitorApi.actions(), { success: false, data: [] });
    });

    it("lifecycle_nodes:服务端随图推送的权威名单;仓库空 → {success:false,data:[]}", async () => {
        pushGraph({ lifecycle: ["/lc_talker"] });
        assert.deepStrictEqual(await monitorApiMod.monitorApi.lifecycle_nodes(), {
            success: true,
            data: ["/lc_talker"],
        });

        monitorApiMod._resetGraphCacheForTest();
        assert.deepStrictEqual(await monitorApiMod.monitorApi.lifecycle_nodes(), { success: false, data: [] });
    });

    it("param_list:委托 Ros2ServiceApi.param_list;失败 → {success:false,data:[]}(公共 API 面保留)", async () => {
        const fake = installFakeRos2Service({ param_list: async () => ["update_rate"] });
        assert.deepStrictEqual(await monitorApiMod.monitorApi.param_list({ node: "/talker" }), {
            success: true,
            data: ["update_rate"],
        });

        fake.param_list = async () => { throw new Error("fail"); };
        assert.deepStrictEqual(await monitorApiMod.monitorApi.param_list({ node: "/x" }), { success: false, data: [] });
    });

    it("订阅制:名册推送入库→懒树;param_values=订阅+基账;再次展开=重取基账(自愈语义)", async () => {
        // A6a 结构:服务端 paramStructure 推送入库 → 懒树叶子值=null lazy=true
        pushStructure("/talker", [{ name: "use_sim_time", type: "boolean" }, { name: "arm.elbow.max_angle", type: "integer" }]);
        const lazy = await monitorApiMod.monitorApi.param_structure({ node: "/talker" });
        assert.deepStrictEqual((lazy.data as any)["use_sim_time"], { kind: "boolean", value: null, lazy: true });
        assert.deepStrictEqual(((lazy.data as any).arm as any).elbow.max_angle, { kind: "integer", value: null, lazy: true });

        // A6b 展开订阅:按名册点名(计入服务端账本),基账入库并树(懒消失)
        let valueCalls = 0;
        mockHelper({
            getParamValues: async (_n: string, names: string[]) => {
                valueCalls += 1;
                assert.deepStrictEqual(names, ["use_sim_time", "arm.elbow.max_angle"]);
                return { "use_sim_time": false, "arm.elbow.max_angle": 135 };
            },
        });
        pushStructure("/talker", [{ name: "use_sim_time", type: "boolean" }, { name: "arm.elbow.max_angle", type: "integer" }]);
        const valued = await monitorApiMod.monitorApi.param_values({ node: "/talker" });
        assert.deepStrictEqual((valued.data as any)["use_sim_time"], { kind: "boolean", value: false });
        assert.deepStrictEqual(((valued.data as any).arm as any).elbow.max_angle, { kind: "integer", value: 135 });
        await monitorApiMod.monitorApi.param_values({ node: "/talker" });
        assert.strictEqual(valueCalls, 2, "再次展开=重取基账(订阅制无值缓存捷径)");

        // 失败降级:名册未推送 → success:false
        monitorApiMod._resetParamStoreForTest();
        assert.deepStrictEqual(await monitorApiMod.monitorApi.param_structure({ node: "/talker" }), { success: false, data: {} });
        assert.deepStrictEqual(await monitorApiMod.monitorApi.param_values({ node: "/talker" }), { success: false, data: {} });
    });

    it("param push 入库:值就地合并;deleted 就地摘除", async () => {
        mockHelper({
            getParamValues: async () => ({ "use_sim_time": false, "rate": 10 }),
        });
        pushStructure("/talker", [{ name: "use_sim_time", type: "boolean" }, { name: "rate", type: "integer" }]);
        await monitorApiMod.monitorApi.param_values({ node: "/talker" });
        monitorApiMod.ingestHelperPush({
            kind: "param",
            values: { "/talker": { "rate": 20 } },
            deleted: { "/talker": ["use_sim_time"] },
        });
        const view = await monitorApiMod.monitorApi.param_view({ node: "/talker" });
        assert.deepStrictEqual((view.data as any).rate, { kind: "integer", value: 20 });
        assert.deepStrictEqual((view.data as any)["use_sim_time"],
            { kind: "boolean", value: null, lazy: true },
            "deleted 参数应从值缓存摘除(树叶按名册保留,值缺回落懒形态)");
    });

    it("param_view:结构+已缓存值合并,绝不主动取值(刷新取数口)", async () => {
        let valuesCalls = 0;
        mockHelper({
            getParamValues: async () => { valuesCalls += 1; return { "use_sim_time": false }; },
        });
        pushStructure("/talker", [{ name: "use_sim_time", type: "boolean" }]);
        const lazy = await monitorApiMod.monitorApi.param_view({ node: "/talker" });
        assert.deepStrictEqual((lazy.data as any)["use_sim_time"], { kind: "boolean", value: null, lazy: true });
        await monitorApiMod.monitorApi.param_values({ node: "/talker" });
        const merged = await monitorApiMod.monitorApi.param_view({ node: "/talker" });
        assert.deepStrictEqual((merged.data as any)["use_sim_time"], { kind: "boolean", value: false });
        assert.strictEqual(valuesCalls, 1, "param_view 不得主动取值");
    });

    it("projectFrame:仓库投影含 valueErrors(F2:取值失败对 UI 可见,不再静默 '—')", async () => {
        mockHelper({
            getParamValues: async () => { throw new Error("node stuck"); },
        });
        pushStructure("/talker", [{ name: "use_sim_time", type: "boolean" }]);
        await monitorApiMod.monitorApi.param_values({ node: "/talker" });   // 取值失败 → markValueError
        const frame = monitorApiMod.projectFrame() as any;
        assert.ok(frame.valueErrors.includes("/talker"), "投影帧应携带取值失败节点");
    });

    it("projectFrame:graph 全量推送 → 节点全名拆分+生命周期装配+参数树", async () => {
        mockHelper({ getParamValues: async () => ({ "use_sim_time": true }) });
        pushGraph({ nodes: ["/lc_talker"], lifecycle: ["/lc_talker"] });
        pushStructure("/lc_talker", [{ name: "use_sim_time", type: "boolean" }]);
        await monitorApiMod.monitorApi.param_values({ node: "/lc_talker" });   // 展开订阅(节点消失即清镜像,不自动重订阅)
        pushLifecycle("/lc_talker", {
            state: "inactive",
            states: ["unconfigured", "inactive", "active"],
            edges: [{ label: "activate", from: "inactive", to: "active" }],
            available: ["activate"],
        });
        const frame = monitorApiMod.projectFrame() as any;
        assert.deepStrictEqual(frame.nodes, [{ name: "lc_talker", namespace: "/" }]);
        assert.strictEqual(frame.lifecycleNodes.length, 1);
        assert.strictEqual(frame.lifecycleNodes[0].currentState, "inactive");
        assert.deepStrictEqual(frame.lifecycleNodes[0].graph.edges, [
            { label: "activate", fromLabel: "inactive", toLabel: "active" },
        ]);
        assert.deepStrictEqual(frame.parameters["/lc_talker"]["use_sim_time"], { kind: "boolean", value: true });
    });
});

describe("MonitorApi B 单点查询", () => {
    beforeEach(() => mockHelper());

    it("param_get:委托 Ros2ServiceApi.param_get;底层 null/抛错 → null", async () => {
        installFakeRos2Service({ param_get: async () => "Integer value is: 10" });
        assert.strictEqual(await monitorApiMod.monitorApi.param_get({ node: "/talker", param: "n" }), "Integer value is: 10");

        installFakeRos2Service({ param_get: async () => null });
        assert.strictEqual(await monitorApiMod.monitorApi.param_get({ node: "/talker", param: "n" }), null);
        installFakeRos2Service({ param_get: async () => { throw new Error("fail"); } });
        assert.strictEqual(await monitorApiMod.monitorApi.param_get({ node: "/talker", param: "n" }), null);
    });

    it("lifecycle_get:仓库读数(权威 push 下发,零请求);无详情 → null", async () => {
        pushLifecycle("/nav", {
            state: "inactive",
            states: ["unconfigured", "inactive"],
            edges: [],
            available: [],
        });
        assert.strictEqual(await monitorApiMod.monitorApi.lifecycle_get({ node: "/nav" }), "inactive");

        monitorApiMod._resetGraphCacheForTest();
        assert.strictEqual(await monitorApiMod.monitorApi.lifecycle_get({ node: "/nav" }), null);
    });

    it("lifecycle_node_info:权威 push 入库 → 组装 LifecycleNode(标准 4 态并集,边无 id);无详情 → null", async () => {
        pushLifecycle("/nav", {
            state: "inactive",
            states: ["unconfigured", "inactive", "active"],
            edges: [
                { label: "cleanup", from: "inactive", to: "unconfigured" },
                { label: "activate", from: "inactive", to: "active" },
            ],
            available: ["cleanup", "activate"],
        });
        const info = await monitorApiMod.monitorApi.lifecycle_node_info({ node: "/nav" });
        assert.strictEqual(info?.currentState, "inactive");
        assert.deepStrictEqual(info?.availableTransitions, ["cleanup", "activate"]);
        assert.strictEqual(info?.namespace, "/");
        assert.strictEqual(info?.name, "nav");
        assert.ok(info?.graph?.edges.length === 2);
        assert.deepStrictEqual(info?.graph?.edges[0], { label: "cleanup", fromLabel: "inactive", toLabel: "unconfigured" });
        assert.ok(info?.availableStates.includes("finalized"));

        monitorApiMod._resetGraphCacheForTest();   // 清仓库 → 无详情
        assert.strictEqual(await monitorApiMod.monitorApi.lifecycle_node_info({ node: "/nav" }), null);
    });

    it("lifecycle_available_states:仓库可用态 ∪ 标准 4 态;无详情 → 标准 4 态兜底", async () => {
        pushLifecycle("/nav", {
            state: "inactive",
            states: ["unconfigured", "inactive", "active"],
            edges: [],
            available: [],
        });
        const states = await monitorApiMod.monitorApi.lifecycle_available_states({ node: "/nav" });
        assert.ok(states.includes("unconfigured") && states.includes("inactive") && states.includes("active") && states.includes("finalized"));

        monitorApiMod._resetGraphCacheForTest();
        const fallback = await monitorApiMod.monitorApi.lifecycle_available_states({ node: "/nav" });
        assert.deepStrictEqual(fallback.sort(), ["active", "finalized", "inactive", "unconfigured"]);
    });
});

describe("MonitorApi C 操作", () => {
    beforeEach(() => {
        mockHelper();
        installFakeRos2Service();
    });

    it("helper_running:ping 成功 → true;失败 → false", async () => {
        mockHelper({ pingHelper: async () => true });
        assert.strictEqual(await monitorApiMod.monitorApi.helper_running(), true);

        mockHelper({ pingHelper: async () => { throw new Error("boom"); } });
        assert.strictEqual(await monitorApiMod.monitorApi.helper_running(), false);
    });

    it("lifecycle_transition:label 直发 → CLI(协议边无 id,transitionId 全链退役)", async () => {
        const calls: { node: string; transition: string }[] = [];
        installFakeRos2Service({
            lifecycle_set: async (o: { node: string; transition: string }) => { calls.push(o); },
        });
        assert.strictEqual(await monitorApiMod.monitorApi.lifecycle_transition({ node: "/nav", transition: "activate" }), true);
        assert.deepStrictEqual(calls, [{ node: "/nav", transition: "activate" }]);
    });

    it("lifecycle_transition:未知标签 → CLI 拒绝(非零退出码)→ false(拒绝语义在 CLI 退出码)", async () => {
        installFakeRos2Service({
            lifecycle_set: async () => { throw new Error("Command failed: ros2 lifecycle set /nav ghost (exit 1)"); },
        });
        assert.strictEqual(await monitorApiMod.monitorApi.lifecycle_transition({ node: "/nav", transition: "ghost" }), false);
    });
});

describe("param tree(A6,2026-09-26)", () => {
    it("buildParamTree:扁平点分名 → 嵌套树;JSON 值五类归一;截断标记 → array+total", () => {
        const tree = paramTreeBuildMod.buildParamTree({
            "use_sim_time": false,
            "qos_overrides./parameter_events.publisher.depth": 1000,
            "arm.elbow.max_angle": 135,
            "big": { __rde_truncated: true, total: 5000, items: [1, 2] },
            "plain": "hello",
        });
        assert.deepStrictEqual(tree["use_sim_time"], { kind: "boolean", value: false });
        const qos = tree["qos_overrides"] as any;
        assert.deepStrictEqual(qos["/parameter_events"].publisher.depth, { kind: "integer", value: 1000 });
        assert.deepStrictEqual((tree["arm"] as any).elbow.max_angle, { kind: "integer", value: 135 });
        assert.deepStrictEqual(tree["big"], {
            kind: "array",
            value: [
                { kind: "integer", value: 1 },
                { kind: "integer", value: 2 },
            ],
            total: 5000,
        });
        assert.deepStrictEqual(tree["plain"], { kind: "string", value: "hello" });
    });

    it("getParamValues:信封请求帧走 socket(id 匹配),resync 回应=在线;孤儿响应丢弃;断开全拒在飞", async () => {
        const handlersHolder: { cur?: { onConnect(): void; onData(c: Buffer): void; onClose(): void; onError(e: Error): void } } = {};
        const writes: string[] = [];
        paramHelperClientMod.setSocketFactoryForTest((_path, handlers) => {
            handlersHolder.cur = handlers;
            return {
                write: (d: string) => { writes.push(d); },
                destroy: () => undefined,   // 测试手动投递 onClose 模拟断开
            };
        });
        paramHelperClientMod.setParamHelperCommandRunner({
            exec: async () => { throw new Error("unused"); },
            spawn: () => { throw new Error("本用例 connect-first 命中假 socket,不应 spawn"); },
        });
        paramHelperClientMod.startParamHelper("/tmp/param_helper.py");
        // connected 门槛(F 批修):连接完成前请求立即拒绝——不得写进未连接的 socket 黑洞
        await assert.rejects(
            paramHelperClientMod.getParamValues("/talker", ["x"]),
            /Parameter helper is not running/);
        handlersHolder.cur!.onConnect();
        // 连上后自动发 resync(首帧;回应到达=在线)
        const resyncFrame = JSON.parse(writes.find((w) => w.includes('"op":"resync"')) ?? "{}");
        assert.strictEqual(resyncFrame.client, `exthost-${process.pid}`);
        assert.strictEqual(typeof resyncFrame.time, "number");
        assert.strictEqual(typeof resyncFrame.id, "number");
        handlersHolder.cur!.onData(Buffer.from(JSON.stringify({
            service: 42, time: 1791300000, "cl-num": 1,
            response: {
                client: resyncFrame.client, id: resyncFrame.id, time: resyncFrame.time, success: true,
                data: { nodes: ["/talker"], topics: {}, services: {}, lifecycle: [] },
            },
        }) + "\n"));

        // 信封请求帧形状:{client,id,time,request{op,node,names}}
        const pendingGet = paramHelperClientMod.getParamValues("/talker", ["use_sim_time"]);
        const reqFrame = JSON.parse(writes.find((w) => w.includes('"op":"get_param_values"')) ?? "{}");
        assert.strictEqual(reqFrame.client, `exthost-${process.pid}`);
        assert.strictEqual(reqFrame.request.op, "get_param_values");
        assert.strictEqual(reqFrame.request.node, "/talker");
        assert.deepStrictEqual(reqFrame.request.names, ["use_sim_time"]);
        handlersHolder.cur!.onData(Buffer.from(JSON.stringify({
            service: 42, time: 1791300000, "cl-num": 1,
            response: {
                client: reqFrame.client, id: reqFrame.id, time: reqFrame.time, success: true,
                data: { node: { "/talker": { use_sim_time: false } } },
            },
        }) + "\n"));
        assert.deepStrictEqual(await pendingGet, { use_sim_time: false });

        // 孤儿响应(id 失配)必须被丢弃,不得误配;会话断开 → 在飞全拒(不陪 30s 超时)
        const pendingFail = paramHelperClientMod.getParamValues("/gone", ["x"]);
        const failFrame = JSON.parse(writes[writes.length - 1]);
        handlersHolder.cur!.onData(Buffer.from(JSON.stringify({
            service: 42, time: 1, "cl-num": 1,
            response: { client: failFrame.client, id: failFrame.id + 999, time: 1, success: true, data: {} },
        }) + "\n"));
        handlersHolder.cur!.onClose();
        await assert.rejects(pendingFail, /Parameter helper process exited/);

        paramHelperClientMod.stopParamHelper();
        paramHelperClientMod.setSocketFactoryForTest(undefined);
    });
});
