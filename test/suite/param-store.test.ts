/**
 * param-store 单测(2026-10-06 彻底推倒重来,订阅制)。
 * 验证:结构/值两级缓存、param push 就地合并与 deleted 摘除、订阅镜像
 * (展开/收起/prune 保留镜像)、valueError 标记的可见与清除。
 */

import * as assert from "assert";

import { describe, it } from "mocha";

import { ParamStore } from "../../src/ros2/consumers/monitor/helper/param-store";

describe("param-store(订阅制,彻底推倒重来)", () => {
    it("结构缓存:setStructure 命中;setStructure 清除该节点 valueError", () => {
        const s = new ParamStore();
        assert.strictEqual(s.getStructure("/talker"), undefined);
        s.markValueError("/talker");
        s.setStructure("/talker", [{ name: "use_sim_time", type: "boolean" }]);
        assert.deepStrictEqual(s.getStructure("/talker"), [{ name: "use_sim_time", type: "boolean" }]);
        assert.deepStrictEqual(s.valueErrors(), [], "结构重推=数据面恢复,error 应清除");
    });

    it("值缓存:基账 setValues 命中;param push 就地合并,deleted 摘除", () => {
        const s = new ParamStore();
        s.setValues("/talker", { "use_sim_time": false, "rate": 10 });
        s.applyParamPush({ "/talker": { "rate": 20 } }, { "/talker": ["use_sim_time"] });
        assert.deepStrictEqual(s.getValues("/talker"), { "rate": 20 });
        // 未订阅(无值缓存)的节点:push 静默忽略
        s.applyParamPush({ "/ghost": { "x": 1 } }, {});
        assert.strictEqual(s.getValues("/ghost"), undefined);
    });

    it("订阅镜像:展开/收起;节点消失剪枝连镜像一起清(回归不自动重订阅,裁定)", () => {
        const s = new ParamStore();
        s.markExpanded("/talker");
        assert.ok(s.isExpanded("/talker"));
        s.setStructure("/talker", [{ name: "a", type: "boolean" }]);
        s.setValues("/talker", { "a": true });
        s.prune(new Set(["/other"]));   // /talker 消失
        assert.strictEqual(s.getStructure("/talker"), undefined);
        assert.strictEqual(s.getValues("/talker"), undefined);
        assert.ok(!s.isExpanded("/talker"), "镜像应随节点消失一起清(不自动保留订阅)");
        s.markExpanded("/talker");   // 重新展开=重新订阅的唯一起点
        s.markCollapsed("/talker");
        assert.deepStrictEqual(s.expandedList(), []);
    });

    it("valueError:标记可见,clearValueError 清除", () => {
        const s = new ParamStore();
        s.markValueError("/a");
        s.markValueError("/b");
        assert.deepStrictEqual(s.valueErrors().sort(), ["/a", "/b"]);
        s.clearValueError("/a");
        assert.deepStrictEqual(s.valueErrors(), ["/b"]);
        s.invalidateAll();
        assert.deepStrictEqual(s.valueErrors(), []);
        assert.strictEqual(s.getStructure("/c"), undefined);
    });
});
