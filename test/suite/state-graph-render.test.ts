/**
 * 状态图渲染契约测试(2026-08-26③)
 *
 * 无头验证 state-graph.ts 渲染输出(最小 DOM stub 驱动,无需浏览器/VS Code):
 *  - z-order 契约:文字(label)最后绘制 → 路线(path)/节点(rect)永远不遮挡文字;
 *  - 基本数量:节点数 = 状态数、顶层 label 数 = 可见边数;
 *  - label 样式含 pointer-events:none(点击文字穿透到下方边,不拦截转换触发)。
 */

import * as assert from "assert";

/* 最小 DOM stub(renderStateGraphSVG 用到的 DOM API 子集) */
function makeNode(tag: string): any {
    return {
        tag,
        attrs: {} as Record<string, string>,
        children: [] as any[],
        _text: "",
        onclick: null,
        listeners: {} as Record<string, Function>,
        setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); },
        getAttribute(k: string) { return this.attrs[k]; },
        appendChild(c: any) { this.children.push(c); return c; },
        addEventListener(t: string, f: Function) { this.listeners[t] = f; },
        get textContent() { return this._text; },
        set textContent(v: unknown) { this._text = String(v); },
    };
}
(global as any).document = { createElementNS: (_ns: string, tag: string) => makeNode(tag) };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sg = require("../../src/ros2/consumers/monitor/webview/graph/state-graph") as typeof import("../../src/ros2/consumers/monitor/webview/graph/state-graph");

/** 官方默认 25 边图(dashing→rolling 一致;用于断言数量与顺序) */
const DEFAULT_STATES = [
    "unconfigured", "inactive", "active", "finalized",
    "configuring", "cleaningup", "shuttingdown", "activating", "deactivating", "errorprocessing",
];
const DEFAULT_EDGES = [
    { label: "configure", fromLabel: "unconfigured", toLabel: "configuring" },
    { label: "transition_success", fromLabel: "configuring", toLabel: "inactive" },
    { label: "transition_failure", fromLabel: "configuring", toLabel: "unconfigured" },
    { label: "transition_error", fromLabel: "configuring", toLabel: "errorprocessing" },
    { label: "cleanup", fromLabel: "inactive", toLabel: "cleaningup" },
    { label: "transition_success", fromLabel: "cleaningup", toLabel: "unconfigured" },
    { label: "transition_failure", fromLabel: "cleaningup", toLabel: "inactive" },
    { label: "transition_error", fromLabel: "cleaningup", toLabel: "errorprocessing" },
    { label: "activate", fromLabel: "inactive", toLabel: "activating" },
    { label: "transition_success", fromLabel: "activating", toLabel: "active" },
    { label: "transition_failure", fromLabel: "activating", toLabel: "inactive" },
    { label: "transition_error", fromLabel: "activating", toLabel: "errorprocessing" },
    { label: "deactivate", fromLabel: "active", toLabel: "deactivating" },
    { label: "transition_success", fromLabel: "deactivating", toLabel: "inactive" },
    { label: "transition_failure", fromLabel: "deactivating", toLabel: "active" },
    { label: "transition_error", fromLabel: "deactivating", toLabel: "errorprocessing" },
    { label: "shutdown", fromLabel: "unconfigured", toLabel: "shuttingdown" },
    { label: "shutdown", fromLabel: "inactive", toLabel: "shuttingdown" },
    { label: "shutdown", fromLabel: "active", toLabel: "shuttingdown" },
    { label: "transition_success", fromLabel: "shuttingdown", toLabel: "finalized" },
    { label: "transition_failure", fromLabel: "shuttingdown", toLabel: "finalized" },
    { label: "transition_error", fromLabel: "shuttingdown", toLabel: "errorprocessing" },
    { label: "transition_success", fromLabel: "errorprocessing", toLabel: "unconfigured" },
    { label: "transition_failure", fromLabel: "errorprocessing", toLabel: "finalized" },
    { label: "transition_error", fromLabel: "errorprocessing", toLabel: "finalized" },
];

function makeGraph(states: string[], edges: any[]) {
    return { states: states.map((s) => ({ label: s })), edges };
}

function render(node: any): any {
    const container = makeNode("div");
    sg.renderStateGraphSVG(node, container);
    return container.children[0]; // svg
}

/** 断言 z-order:svg 顶层所有 g(边/节点)必须排在第一个 text(label)之前 */
function assertZOrder(svg: any, expectG: number, expectText: number): void {
    const gIdx: number[] = [];
    const textIdx: number[] = [];
    svg.children.forEach((c: any, i: number) => {
        if (c.tag === "g") gIdx.push(i);
        if (c.tag === "text") textIdx.push(i);
    });
    assert.strictEqual(gIdx.length, expectG, "g 数(边 + 节点)");
    assert.strictEqual(textIdx.length, expectText, "顶层 label 数 = 可见边数");
    assert.ok(gIdx.length > 0 && textIdx.length > 0, "应有边与 label");
    assert.ok(
        Math.max(...gIdx) < Math.min(...textIdx),
        `z-order 契约被破坏:g@[${gIdx.join(",")}] text@[${textIdx.join(",")}]——路线/节点画在了文字上层`
    );
}

describe("状态图渲染契约(state-graph.ts)", () => {
    it("默认视图:边→节点→文字 顺序;4 节点 7 边 7 label;label 可点击穿透", () => {
        const svg = render({
            name: "/talker",
            currentState: "inactive",
            availableTransitions: [],
            availableStates: [],
            graph: makeGraph(DEFAULT_STATES, DEFAULT_EDGES),
            showFullGraph: false,
            onTransition: () => {},
        });
        assert.strictEqual(svg.children[0].tag, "style");
        assert.strictEqual(svg.children[1].tag, "defs");
        assertZOrder(svg, 7 + 4, 7);   // 压缩视图:7 边 g + 4 节点 g,7 个 label
        const styleText = svg.children[0]._text;
        assert.ok(styleText.includes("pointer-events:none"), "label 样式应含 pointer-events:none(点击穿透)");
    });

    it("完整视图:25 边 + 10 态全量;25 label 仍最后绘制", () => {
        const svg = render({
            name: "/talker",
            currentState: "inactive",
            availableTransitions: [],
            availableStates: [],
            graph: makeGraph(DEFAULT_STATES, DEFAULT_EDGES),
            showFullGraph: true,
            onTransition: () => {},
        });
        assertZOrder(svg, 25 + 10, 25);
    });

    it("无图兜底(静态表):不抛错;4 节点 7 边 7 label;文字仍最后", () => {
        const svg = render({
            name: "/talker",
            currentState: "inactive",
            availableTransitions: ["activate", "cleanup"],
            availableStates: ["recovering"],
            onTransition: () => {},
        });
        assertZOrder(svg, 7 + 5, 7);   // 兜底:7 边 g + 5 节点 g(4 标准 + availableStates 的 recovering)
    });

    it("点击回调透传转换 label(可用边挂 onclick;协议边无 id,label 直发)", () => {
        const calls: string[] = [];
        const svg = render({
            name: "/talker",
            currentState: "inactive",
            availableTransitions: [],
            availableStates: [],
            graph: makeGraph(["unconfigured", "inactive", "active", "finalized"], [
                { label: "configure", fromLabel: "unconfigured", toLabel: "inactive" },
                { label: "activate", fromLabel: "inactive", toLabel: "active" },
            ]),
            showFullGraph: false,
            onTransition: (t: string) => calls.push(t),
        });
        const edgeG = svg.children.find((c: any) => c.tag === "g" && c.attrs.class === "sg-avail");
        assert.ok(edgeG && typeof edgeG.onclick === "function", "可用边应挂 onclick");
        edgeG.onclick();
        assert.deepStrictEqual(calls, ["activate"], "应透传转换 label");
    });
});