/**
 * classify 单测(2026-10-06 重设计阶段 2:图分类自助手 Python 迁入扩展侧,
 * 此前 Python 无测试 rig,迁入后进 npm test 体系)。
 *
 * 验证:动作三件套聚合(类型剥 _SendGoal/verbs 排序)、名字带 _action 不误伤、
 * 多类型串逐个判据。(2026-10-07:生命周期发现用例随 detectLifecycleNodes 墓碑删除——
 * 名单改由服务端随图推送。)
 *
 * 纯函数零依赖,无需 vscode stub。
 */

import * as assert from "assert";

import { describe, it } from "mocha";

import { separateActions } from "../../src/ros2/consumers/monitor/helper/classify";

describe("classify(图分类,重设计阶段 2 自助手迁入)", () => {
    it("separateActions:动作三件套聚成一个动作,类型剥 _SendGoal,verbs 排序", () => {
        const { services, actions } = separateActions([
            { name: "/fibonacci/_action/send_goal", type: "example_interfaces/action/Fibonacci_SendGoal" },
            { name: "/fibonacci/_action/cancel_goal", type: "action_msgs/srv/CancelGoal" },
            { name: "/fibonacci/_action/get_result", type: "example_interfaces/action/Fibonacci_GetResult" },
            { name: "/talker/describe_parameters", type: "rcl_interfaces/srv/DescribeParameters" },
        ]);
        assert.deepStrictEqual(services, [
            { name: "/talker/describe_parameters", type: "rcl_interfaces/srv/DescribeParameters" },
        ]);
        assert.deepStrictEqual(actions, [
            { name: "/fibonacci", type: "example_interfaces/action/Fibonacci", verbs: ["cancel_goal", "get_result", "send_goal"] },
        ]);
    });

    it("separateActions:名字带 _action 但类型不符的普通服务不误伤(双判据)", () => {
        const { services, actions } = separateActions([
            { name: "/my_action_service", type: "std_srvs/srv/Empty" },
        ]);
        assert.deepStrictEqual(actions, []);
        assert.deepStrictEqual(services, [{ name: "/my_action_service", type: "std_srvs/srv/Empty" }]);
    });

    it("separateActions:cancel_goal 排第一不污染类型(通用 CancelGoal 只贡献动词)", () => {
        const { services, actions } = separateActions([
            { name: "/fibonacci/_action/cancel_goal", type: "action_msgs/srv/CancelGoal" },
            { name: "/fibonacci/_action/send_goal", type: "example_interfaces/action/Fibonacci_SendGoal" },
            { name: "/fibonacci/_action/get_result", type: "example_interfaces/action/Fibonacci_GetResult" },
        ]);
        assert.deepStrictEqual(services, []);
        assert.deepStrictEqual(actions, [
            { name: "/fibonacci", type: "example_interfaces/action/Fibonacci", verbs: ["cancel_goal", "get_result", "send_goal"] },
        ]);
    });

    it("separateActions:仅有 cancel_goal(残缺)→ 不判为动作,服务回归清单", () => {
        const { services, actions } = separateActions([
            { name: "/fibonacci/_action/cancel_goal", type: "action_msgs/srv/CancelGoal" },
        ]);
        assert.deepStrictEqual(actions, []);
        assert.deepStrictEqual(services, [
            { name: "/fibonacci/_action/cancel_goal", type: "action_msgs/srv/CancelGoal" },
        ]);
    });

    it("separateActions:多类型串逐个过判据,但残缺集不判为动作(总判定,用户裁定 2026-10-07)", () => {
        const { services, actions } = separateActions([
            { name: "/a/_action/send_goal", type: "x/Foo_SendGoal, other/Bar" },
        ]);
        assert.deepStrictEqual(actions, [], "三件不齐=不算动作");
        assert.deepStrictEqual(services, [
            { name: "/a/_action/send_goal", type: "x/Foo_SendGoal, other/Bar" },
        ], "残缺候选的服务原样回归普通服务清单");
    });

    it("separateActions:仅有 cancel_goal(残缺)→ 不判为动作,服务回归清单", () => {
        const { services, actions } = separateActions([
            { name: "/fibonacci/_action/cancel_goal", type: "action_msgs/srv/CancelGoal" },
        ]);
        assert.deepStrictEqual(actions, []);
        assert.deepStrictEqual(services, [
            { name: "/fibonacci/_action/cancel_goal", type: "action_msgs/srv/CancelGoal" },
        ]);
    });

    it("separateActions:三件齐备才判定为动作(总判定,2/3 残缺不算)", () => {
        const { services, actions } = separateActions([
            { name: "/fibonacci/_action/send_goal", type: "example_interfaces/action/Fibonacci_SendGoal" },
            { name: "/fibonacci/_action/cancel_goal", type: "action_msgs/srv/CancelGoal" },
        ]);
        assert.deepStrictEqual(actions, [], "2/3 残缺不算动作");
        assert.deepStrictEqual(services.map((x) => x.name).sort(), [
            "/fibonacci/_action/cancel_goal",
            "/fibonacci/_action/send_goal",
        ]);
    });
});
