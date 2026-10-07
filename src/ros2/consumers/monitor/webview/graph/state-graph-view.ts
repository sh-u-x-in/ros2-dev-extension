// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file state-graph-view.ts
 * 生命周期状态图 · 视图数据域(2026-10-03 十九轮批4 自 state-graph.ts 拆出,纯数据零 DOM):
 * 官方静态转换表、过渡态/错误边/unknown 语义集合、节点输入契约(StateGraphNode)、
 * 视图组装(buildGraphView:完整图/压缩过渡态/静态表兜底三种形态)。
 * 渲染编排留在 state-graph.ts;布局几何在 state-graph-layout.ts。
 */

import type { GraphEdge } from "./state-graph-layout";

/* ================================================================== */
/* 静态转换表(ROS2 公开标准;仅作状态图结构参考,可用性由实时数据驱动)    */
/* ================================================================== */

/** 标准 4 状态(静态,圆形) */
export const STANDARD_STATES = ["unconfigured", "inactive", "active", "finalized"];

/** 标准 7 转换(label → {from, to}) */
export const STATIC_TRANSITIONS: { label: string; from: string; to: string }[] = [
    { label: "configure", from: "unconfigured", to: "inactive" },
    { label: "cleanup", from: "inactive", to: "unconfigured" },
    { label: "activate", from: "inactive", to: "active" },
    { label: "deactivate", from: "active", to: "inactive" },
    { label: "unconfigured_shutdown", from: "unconfigured", to: "finalized" },
    { label: "inactive_shutdown", from: "inactive", to: "finalized" },
    { label: "active_shutdown", from: "active", to: "finalized" },
];

/** 标准转换 label 集合(用于区分动态转换) */
const STANDARD_TRANSITION_LABELS = new Set(STATIC_TRANSITIONS.map((t) => t.label));

/** 官方过渡态 label(lifecycle_msgs State.msg 常量;默认视图隐藏,完整视图弱化显示) */
export const TRANSITIONAL_STATE_LABELS = new Set(["configuring", "cleaningup", "shuttingdown", "activating", "deactivating", "errorprocessing"]);

/** 框架内部错误处理边 label(rcl 默认状态机;默认视图隐藏,完整视图弱化显示、不可交互) */
const ERROR_TRANSITION_LABELS = new Set(["transition_success", "transition_failure", "transition_error"]);

/** UNKNOWN 伪状态(2026-10-03 十八轮补,用户反馈完整图出现 unknown):
 *  lifecycle_msgs State.UNKNOWN(id=0,构造前伪状态),get_available_states 恒返回;
 *  标准状态机中它无边(构造/析构属生命周期管理,不在 ROS 转换图内),CLI 亦不显示——
 *  十八轮终版(用户追问后精化):不按标签信仰过滤,按数据说话——**仅当 unknown 确实
 *  无边(孤岛)时过滤**;若自定义状态机为其接线则如实保留。用户自定义孤儿状态
 *  (如 missing,同样无边)是真实机器声明,与 unknown 性质不同,一律保留渲染 */
export const PRIMARY_UNKNOWN_LABEL = "unknown";

export interface StateGraphNode {
    /** 节点全名(namespace+name) */
    name: string;
    currentState: string | null;
    availableTransitions: string[];
    availableStates: string[];
    /** 完整转换图(节点 get_transition_graph;2026-08-26 主数据源;缺省 → 静态表兜底) */
    graph?: {
        states: { label: string }[];
        edges: { label: string; fromLabel: string; toLabel: string }[];
    };
    /** 完整图视图(显示官方过渡态与错误边;默认 false = 压缩过渡态的经典视图) */
    showFullGraph?: boolean;
    /** 点击可用边回调(实线;直发转换 label——2026-10-06 协议边无 id) */
    onTransition: (transition: string) => void;
    /** 点击不可用边回调(虚线) */
    onUnavailable?: (transition: string) => void;
}

/**
 * 组装状态图视图数据(2026-08-26):
 *  - 有图(node.graph):以节点真实转换图为数据源。默认视图压缩官方过渡态
 *    (主边 goal 是过渡态时沿 transition_success 出口落到驻留态,重现经典 4 态 7 边),
 *    隐藏错误边;完整视图(showFullGraph)原样展示(过渡态弱化 + 错误边灰点线)。
 *  - 无图:静态表(标准 7 边)+ availableTransitions(实时可用 label)+ 动态转换占位兜底。
 */
export function buildGraphView(node: StateGraphNode): { states: string[]; edges: GraphEdge[] } {
    const avail = new Set(node.availableTransitions || []);
    const graph = node.graph;
    if (graph && graph.edges.length > 0) {
        const isTrans = (label: string) => TRANSITIONAL_STATE_LABELS.has(label);
        const isError = (label: string) => ERROR_TRANSITION_LABELS.has(label);
        const states: string[] = [];
        graph.states.forEach((s) => { if (!states.includes(s.label)) states.push(s.label); });
        // unknown 过滤的条件化(十八轮终版):仅孤岛时滤;有接线则如实保留(数据说话)
        const unknownWired = graph.edges.some((e) =>
            e.fromLabel === PRIMARY_UNKNOWN_LABEL || e.toLabel === PRIMARY_UNKNOWN_LABEL);
        if (node.showFullGraph) {
            // 完整视图:全部状态 + 全部边(含过渡态/错误边;错误边不可交互);孤岛 unknown 过滤
            return {
                states: states.filter((s) => unknownWired || s !== PRIMARY_UNKNOWN_LABEL),
                edges: graph.edges
                    .filter((e) => unknownWired ||
                        (e.fromLabel !== PRIMARY_UNKNOWN_LABEL && e.toLabel !== PRIMARY_UNKNOWN_LABEL))
                    .map((e) => ({
                        from: e.fromLabel, to: e.toLabel,
                        label: e.label, available: e.fromLabel === node.currentState,
                        error: isError(e.label),
                    })),
            };
        }
        // 默认视图:压缩官方过渡态(经 transition_success 出口);错误边/过渡态出发边隐藏;
        // 当前状态若是过渡态(转换进行中/卡 errorprocessing)仍保留节点以显示高亮;
        // unknown 仅孤岛时滤(十八轮终版:有接线如实保留)
        const keepStates = states.filter((s) =>
            (unknownWired || s !== PRIMARY_UNKNOWN_LABEL) && (!isTrans(s) || s === node.currentState));
        const successExit = new Map<string, string>();
        graph.edges.forEach((e) => {
            if (isTrans(e.fromLabel) && e.label === "transition_success") {
                successExit.set(e.fromLabel, e.toLabel);
            }
        });
        const edges: GraphEdge[] = [];
        graph.edges.forEach((e) => {
            if (isError(e.label)) return;
            if (!unknownWired &&
                (e.fromLabel === PRIMARY_UNKNOWN_LABEL || e.toLabel === PRIMARY_UNKNOWN_LABEL)) return;
            if (isTrans(e.fromLabel)) return;
            let to = e.toLabel;
            if (isTrans(to)) {
                const exit = successExit.get(to);
                if (!exit) return;              // 过渡态无成功出口(残缺自定义图)→ 丢弃该边
                to = exit;
            }
            edges.push({ from: e.fromLabel, to, label: e.label, available: e.fromLabel === node.currentState });
        });
        return { states: keepStates, edges };
    }
    // 兜底(无图):静态表 + 动态转换占位
    const allStates = [...STANDARD_STATES];
    (node.availableStates || []).forEach((s) => { if (!allStates.includes(s)) allStates.push(s); });
    const edges: GraphEdge[] = [];
    STATIC_TRANSITIONS.forEach((t) => {
        if (allStates.includes(t.from) && allStates.includes(t.to)) {
            edges.push({ from: t.from, to: t.to, label: t.label, available: avail.has(t.label) });
        }
    });
    (node.availableTransitions || []).forEach((t) => {
        if (!STANDARD_TRANSITION_LABELS.has(t)) {
            // 动态转换:目标状态 = 同名动态状态,或匹配"转换名去掉常见后缀"的状态(calibrate→calibrating)。
            // 找不到明确目标 → 兜底目标 = 转换名(动态占位状态,加入 allStates 渲染,边不消失)。
            let target = allStates.find((s) => s === t);
            if (!target) {
                const stem = t.replace(/_/g, "").replace(/(ed|ing|e)$/i, "");
                target = allStates.find((s) => s.replace(/_/g, "").startsWith(stem) && s !== "finalized");
            }
            if (!target) {
                target = "__dyn_" + t;   // 动态占位目标(下方加入 allStates 渲染)
                allStates.push(target);
            }
            edges.push({ from: node.currentState || "unconfigured", to: target, label: t, available: true });
        }
    });
    return { states: allStates, edges };
}
