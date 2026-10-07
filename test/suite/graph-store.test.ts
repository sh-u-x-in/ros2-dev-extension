/**
 * graph-store 单测(2026-10-06 彻底推倒重来终态:纯持有者)。
 * 验证:无快照 undefined、全量建档(整仓替换)、失效、latest-wins(后到的全量覆盖先到的)。
 */

import * as assert from "assert";

import { describe, it } from "mocha";

import { GraphStore, type GraphSnapshot } from "../../src/ros2/consumers/monitor/helper/graph-store";

function snap(over: Partial<GraphSnapshot> = {}): GraphSnapshot {
    return {
        nodes: ["/talker"],
        topics: { "/chatter": "std_msgs/msg/String" },
        services: { "/talker/list_parameters": "rcl_interfaces/srv/ListParameters" },
        lifecycle: [],
        ...over,
    };
}

describe("graph-store(纯持有者,彻底推倒重来)", () => {
    it("无快照/已失效 → view undefined;建档后 → 快照原样", () => {
        const s = new GraphStore();
        assert.strictEqual(s.valid, false);
        assert.strictEqual(s.view(), undefined);
        s.applyFull(snap());
        assert.strictEqual(s.valid, true);
        assert.deepStrictEqual(s.view()!.nodes, ["/talker"]);
        assert.deepStrictEqual(s.view()!.lifecycle, []);
        s.invalidate();
        assert.strictEqual(s.view(), undefined);
    });

    it("applyFull 整仓替换(全量推图的语义:收到即覆盖,无贴补)", () => {
        const s = new GraphStore();
        s.applyFull(snap());
        s.applyFull(snap({
            nodes: ["/talker", "/listener"],
            topics: { "/chatter": "std_msgs/msg/String", "/tf": "tf2_msgs/msg/TFMessage" },
            services: {},
            lifecycle: ["/lc_talker"],
        }));
        const v = s.view()!;
        assert.deepStrictEqual(v.nodes.sort(), ["/listener", "/talker"]);
        assert.strictEqual(Object.keys(v.topics).length, 2);
        assert.deepStrictEqual(v.lifecycle, ["/lc_talker"]);
    });

    it("节点消失=新快照列表里没有(全量推,无 removed 概念)", () => {
        const s = new GraphStore();
        s.applyFull(snap({ nodes: ["/talker", "/lc_talker"], lifecycle: ["/lc_talker"] }));
        s.applyFull(snap({ nodes: ["/talker"] }));
        assert.deepStrictEqual(s.view()!.nodes, ["/talker"]);
        assert.deepStrictEqual(s.view()!.lifecycle, []);
    });

    it("空图也是合法快照(服务端冷启动建档为空)", () => {
        const s = new GraphStore();
        s.applyFull(snap({ nodes: [], topics: {}, services: {}, lifecycle: [] }));
        assert.strictEqual(s.valid, true);
        assert.deepStrictEqual(s.view()!.nodes, []);
    });
});
