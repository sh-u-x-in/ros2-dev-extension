/**
 * ROS 2 Python 片段核心单测(2026-09-07):转制完整性 + 前缀过滤 + launch.py 排除。
 * 纯 TS(import 自 languages/python/py-ros-snippets-core,零 vscode),可无头跑。
 */
import * as assert from "assert";
import {
    rosPySnippets,
    rosPySnippetCandidates,
    isLaunchPyPath,
} from "../../src/languages/python/py-ros-snippets-core";

describe("py-ros-snippets core", () => {
    it("转制完整性:目录 19 条,均含占位符 body", () => {
        const all = rosPySnippets();
        assert.strictEqual(all.length, 19);
        for (const s of all) {
            assert.ok(s.body.length > 0);
            assert.ok(s.body.join("\n").includes("${"), `body 应含 tabstop:${s.label}`);
        }
    });

    it("前缀过滤:旧 prefix 记忆词命中(ros2pub / ros2node / ros2qos)", () => {
        assert.ok(rosPySnippetCandidates("ros2pub").some(c => c.label.includes("Publisher")));
        assert.ok(rosPySnippetCandidates("ros2node").some(c => c.label === "Node class template"));
        assert.ok(rosPySnippetCandidates("ros2qos").some(c => c.label === "QoS profile"));
        assert.ok(rosPySnippetCandidates("ros2actionclient").some(c => c.label === "Action client"));
    });

    it("前缀过滤:英文语义词命中(publisher / log)", () => {
        assert.ok(rosPySnippetCandidates("publisher").length >= 2);
        assert.ok(rosPySnippetCandidates("log").length >= 5); // 调试/信息/警告/错误/致命
    });

    it("前缀过滤:无命中 → 空", () => {
        assert.strictEqual(rosPySnippetCandidates("zzz_none_").length, 0);
    });

    it("launch.py 排除判定", () => {
        assert.ok(isLaunchPyPath("/a/b/rde_demo.launch.py"));
        assert.ok(isLaunchPyPath("C:\\ws\\foo.launch.py"));
        assert.ok(!isLaunchPyPath("/a/b/rde_node.py"));
        assert.ok(!isLaunchPyPath("/a/b/test.py"));
    });

    it("'.' 触发空前缀 → 全量(provider 层依赖此列出成员片段)", () => {
        assert.strictEqual(rosPySnippetCandidates("").length, 19);
    });

    it("filterText 纯 ASCII(中文只留 label)", () => {
        const items = rosPySnippetCandidates("");
        const ascii = /^[\x20-\x7E]*$/;
        for (const i of items) {
            assert.ok(ascii.test(i.filter), `filter 应纯 ASCII:${i.label} → ${i.filter}`);
        }
        assert.ok(items.some(i => i.filter.includes("ros2node")));
    });
});
