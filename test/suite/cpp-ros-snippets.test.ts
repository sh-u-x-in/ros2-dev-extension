/**
 * ROS 2 C++ 片段核心单测(2026-09-07):转制完整性 + 前缀过滤。
 * 纯 TS(import 自 languages/cpp/cpp-ros-snippets-core,零 vscode),可无头跑。
 */
import * as assert from "assert";
import {
    rosCppSnippets,
    rosCppSnippetCandidates,
} from "../../src/languages/cpp/cpp-ros-snippets-core";

describe("cpp-ros-snippets core", () => {
    it("转制完整性:目录 22 条,均含占位符 body", () => {
        const all = rosCppSnippets();
        assert.strictEqual(all.length, 22);
        for (const s of all) {
            assert.ok(s.body.length > 0);
            assert.ok(s.body.join("\n").includes("${"), `body 应含 tabstop:${s.label}`);
        }
    });

    it("前缀过滤:旧 prefix 记忆词命中(ros2node / ros2component / ros2register)", () => {
        assert.ok(rosCppSnippetCandidates("ros2node").some(c => c.label === "Node class template"));
        assert.ok(rosCppSnippetCandidates("ros2component").some(c => c.label === "Component node template"));
        assert.ok(rosCppSnippetCandidates("ros2register").some(c => c.label === "Component registration macro"));
        assert.ok(rosCppSnippetCandidates("ros2actionserver").some(c => c.label === "Action server"));
    });

    it("前缀过滤:英文语义词命中(publisher / log / qos)", () => {
        assert.ok(rosCppSnippetCandidates("publisher").length >= 2);
        assert.ok(rosCppSnippetCandidates("log").length >= 5); // 调试/信息/警告/错误/致命
        assert.ok(rosCppSnippetCandidates("qos").some(c => c.label === "QoS profile"));
    });

    it("前缀过滤:无命中 → 空;空前缀 → 全量", () => {
        assert.strictEqual(rosCppSnippetCandidates("zzz_none_").length, 0);
        assert.strictEqual(rosCppSnippetCandidates("").length, 22);
    });

    it("filterText 纯 ASCII(中文只留 label)", () => {
        const items = rosCppSnippetCandidates("");
        const ascii = /^[\x20-\x7E]*$/;
        for (const i of items) {
            assert.ok(ascii.test(i.filter), `filter 应纯 ASCII:${i.label} → ${i.filter}`);
        }
        assert.ok(items.some(i => i.filter.includes("ros2node")));
    });
});
