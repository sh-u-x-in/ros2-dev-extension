// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file monitor-api.ts
 * 状态页数据层(2026-10-06 彻底推倒重来终态:信封帧 + 订阅制 + 全量推图)。
 *
 * 数据真相 = 服务端;本模块持有三份客户端仓库——
 *   graphStore(纯持有者:图一变服务端推全量,resync 回应同款)、
 *   paramStore(结构/值两级缓存 + 展开中节点订阅镜像)、
 *   lifecycleStore(生命周期权威详情,lifecycle push 直接覆盖);
 * 本模块只做【入库(push 帧 → store)+ 投影(store → ready 帧)】,没有拉取编排。
 * 参数=订阅制:展开节点 → get_param_values(全名册计入服务端账本+回底账),
 * 收起 2 秒后 unget 退订;节点回归由镜像驱动重订阅;每 5 分钟周期 resync 保险带。
 */

import { l10n } from "vscode";

import { getLogger } from "../../../logger";

import {
    getParamValues,
    pingHelper,
    resyncSnapshot,
    ungetParamValues,
} from "./helper/param-helper-client";
import type {
    HelperLifecycleInfo,
} from "./helper/param-helper-protocol";
import type { GraphSnapshot } from "./helper/graph-store";
import { GraphStore } from "./helper/graph-store";
import type { ParamStructureEntry } from "./helper/param-store";
import { ParamStore } from "./helper/param-store";
import { buildLazyTree, mergeValuesIntoLazyTree } from "./helper/param-tree-build";
import { separateActions } from "./helper/classify";
import { getHelperRunning } from "./helper/helper-state";

/** monitor-api 模块日志 */
const log = getLogger("monitor-api");

/**
 * 助手客户端注入缝(沿袭):默认绑定 param-helper-client 实现;
 * 【测试专用】setHelperClientForTest 替换为 fake。
 */
let helperClient: {
    pingHelper: typeof pingHelper;
    getParamValues: typeof getParamValues;
    ungetParamValues: typeof ungetParamValues;
    resyncSnapshot: typeof resyncSnapshot;
} = { pingHelper, getParamValues, ungetParamValues, resyncSnapshot };

/** 【测试专用】注入 fake 助手客户端 */
export function setHelperClientForTest(client: Partial<typeof helperClient>): void {
    helperClient = { ...helperClient, ...client };
}

/* ================================================================== */
/* 客户端仓库(纯推送架构的本地真相投影)                                  */
/* ================================================================== */

/** 本地图仓库:纯持有者(全量进门,无增量) */
const graphStore = new GraphStore();

/** 参数仓库:结构(推送填充)+ 值(订阅基线+param push 保鲜)+ 展开镜像 */
const paramStore = new ParamStore();

/** 生命周期权威详情仓库:lifecycle push 直接覆盖(最后一次永远是对的) */
const lifecycleStore = new Map<string, HelperLifecycleInfo>();

/** 仓库变更监听(投影器注册;入库后触发 ready 帧投影) */
type StoreListener = () => void;
const storeListeners: StoreListener[] = [];

export function onStoresChanged(listener: StoreListener): () => void {
    storeListeners.push(listener);
    return () => {
        const i = storeListeners.indexOf(listener);
        if (i >= 0) { storeListeners.splice(i, 1); }
    };
}

function markDirty(): void {
    for (const l of storeListeners) {
        try { l(); } catch { /* 投影器异常不影响入库 */ }
    }
}

/* ================================================================== */
/* 入库:一切推送帧的唯一入口(无事件帧——事件机随增量协议退役)             */
/* ================================================================== */

/**
 * 推送帧入库(graph/param/paramStructure/lifecycle)。
 * graph:整仓替换 + 存活剪枝 + 展开镜像重订阅(服务端账本可能已随节点消失清账)。
 */
export function ingestHelperPush(frame: Record<string, unknown>): void {
    switch (frame.kind) {
        case "graph": {
            const snap = frame as unknown as GraphSnapshot;
            graphStore.applyFull(snap);
            const present = new Set(snap.nodes ?? []);
            // 剪枝含展开镜像(用户裁定:节点消失即清,回归不自动重订阅);
            // 服务端账本按连接自清(节点消失/断连),两端一致
            paramStore.prune(present);
            for (const node of [...lifecycleStore.keys()]) {
                if (!present.has(node)) { lifecycleStore.delete(node); }
            }
            break;
        }
        case "param": {
            const values = (frame.values ?? {}) as Record<string, Record<string, unknown>>;
            const deleted = (frame.deleted ?? {}) as Record<string, string[]>;
            paramStore.applyParamPush(values, deleted);
            for (const node of [...Object.keys(values), ...Object.keys(deleted)]) {
                paramStore.clearValueError(node);
            }
            break;
        }
        case "param_structure": {
            const node = String(frame.node ?? "");
            const entries = frame.params as ParamStructureEntry[] | undefined;
            if (node && Array.isArray(entries)) {
                paramStore.setStructure(node, entries);
                // 展开中但值未到(展开时名册未到/节点回归):名册一到立即补订阅
                if (paramStore.isExpanded(node) && !paramStore.getValues(node)) {
                    void ensureSubscription(node);
                }
            }
            break;
        }
        case "lifecycle": {
            const node = String(frame.node ?? "");
            if (node && typeof frame.state === "string") {
                lifecycleStore.set(node, {
                    state: String(frame.state),
                    states: (frame.states ?? []) as string[],
                    edges: (frame.edges ?? []) as { label: string; from: string; to: string }[],
                    available: (frame.available ?? []) as string[],
                });
            }
            break;
        }
        default:
            break;   // 未知 kind:忽略(前向兼容留位)
    }
    markDirty();
}

/** 订阅节点:按名册点名 get_param_values(服务端计入账本+回底账),值入库 */
async function ensureSubscription(node: string): Promise<void> {
    const entries = paramStore.getStructure(node);
    if (!entries || entries.length === 0) {
        return;   // 名册未到:零订阅(paramStructure push 到货时按镜像补订)
    }
    try {
        const flat = await helperClient.getParamValues(node, entries.map((e) => e.name));
        paramStore.setValues(node, flat);
        paramStore.clearValueError(node);
        markDirty();
    } catch (err) {
        paramStore.markValueError(node);
        markDirty();
        log.debug(l10n.t("subscribe values({0}) failed: {1}", node, err instanceof Error ? err.message : String(err)));
    }
}

/* ================================================================== */
/* 订阅生命周期:展开即订,收起 2 秒后退订(裁定 2026-10-06)               */
/* ================================================================== */

const UNSUBSCRIBE_DELAY_MS = 2000;   // 收起后等 2 秒再退订(防快速收起/展开抖动)
const collapseTimers = new Map<string, NodeJS.Timeout>();

function cancelCollapseTimer(node: string): void {
    const t = collapseTimers.get(node);
    if (t) {
        clearTimeout(t);
        collapseTimers.delete(node);
    }
}

/** 展开节点:取消挂起的退订,标记镜像(取值由 param_values 驱动) */
export function param_expand(node: string): void {
    paramStore.markExpanded(node);
    cancelCollapseTimer(node);
}

/** 收起节点:2 秒后按名册退订(服务端账本按参数名移出) */
export function param_collapse(node: string): void {
    paramStore.markCollapsed(node);
    cancelCollapseTimer(node);
    const timer = setTimeout(() => {
        collapseTimers.delete(node);
        const names = paramStore.getStructure(node)?.map((e) => e.name);
        if (names && names.length > 0) {
            void helperClient.ungetParamValues(node, names).catch((err) => {
                log.debug(l10n.t("unsubscribe({0}) failed: {1}", node, err instanceof Error ? err.message : String(err)));
            });
        }
    }, UNSUBSCRIBE_DELAY_MS);
    collapseTimers.set(node, timer);
}

/* ================================================================== */
/* 周期 resync 保险带(裁定:觉得不对/隔一阵子重发 resync,一条原语管一切恢复) */
/* ================================================================== */

const PERIODIC_RESYNC_MS = 300000;   // 5 分钟
let lastResyncAt = 0;

/** 重同步:resync 回应=全量快照,走 graph 入库(服务端另广播名册/详情补推);5s 节流 */
export function requestResyncSnapshot(reason: string): void {
    const now = Date.now();
    if (now - lastResyncAt < 5000) {
        return;
    }
    lastResyncAt = now;
    log.debug(l10n.t("resync requested ({0})", reason));
    void helperClient.resyncSnapshot()
        .then((snap) => { ingestHelperPush({ kind: "graph", ...snap }); })
        .catch((err) => {
            log.debug(l10n.t("resync failed: {0}", err instanceof Error ? err.message : String(err)));
        });
}

const periodicTimer = setInterval(() => {
    if (getHelperRunning()) {
        requestResyncSnapshot("periodic");
    }
}, PERIODIC_RESYNC_MS);
if (typeof periodicTimer.unref === "function") {
    periodicTimer.unref();
}

/* ================================================================== */
/* 投影:仓库状态 → webview ready 帧(纯函数,零 IO)                      */
/* ================================================================== */

/** 标准 4 态(兜底:图端点未覆盖时保证主态可见) */
const STANDARD_STATE_LABELS = ["unconfigured", "inactive", "active", "finalized"];

/** 全名 → {name, namespace}(与旧 B3 相同形状;服务端现在交全名一列) */
function splitFullname(fullname: string): { name: string; namespace: string } {
    const cut = fullname.lastIndexOf("/");
    return { name: fullname.slice(cut + 1), namespace: fullname.slice(0, cut + 1) || "/" };
}

/** 组装 LifecycleNode(与旧 B3 相同形状,数据源改为仓库;边无 id) */
function assembleLifecycleNode(fullName: string, info: HelperLifecycleInfo) {
    const states = [...info.states];
    for (const s of STANDARD_STATE_LABELS) {
        if (!states.includes(s)) {
            states.push(s);
        }
    }
    const { name, namespace } = splitFullname(fullName);
    return {
        name,
        namespace,
        currentState: info.state,
        availableTransitions: info.available,
        availableStates: states,
        graph: {
            states: info.states.map((label) => ({ label })),
            edges: info.edges.map((e) => ({
                label: e.label,
                fromLabel: e.from,
                toLabel: e.to,
            })),
        },
    };
}

/** 投影:仓库 → ready 帧(同步纯读;图/参数/生命周期全部来自仓库,零 IO) */
export function projectFrame(): Record<string, unknown> {
    const running = getHelperRunning();
    if (!running) {
        return { ready: false, isHelperRunning: false, lifecycleNodes: [] };
    }
    const raw = graphStore.view();
    const valueErrors = paramStore.valueErrors();
    if (!raw) {
        // 已在线但快照未到(毫秒级窗口):空帧,不闪"未运行"提示;取值失败标记仍要可见
        return { ready: true, isHelperRunning: true, nodes: [], topics: [], services: [],
                 actions: [], parameters: {}, lifecycleNodes: [], lifecycleDiscovered: [], valueErrors };
    }
    const { services: separatedServices, actions } = separateActions(
        Object.entries(raw.services).map(([name, type]) => ({ name, type })));
    const lifecycleNames = raw.lifecycle ?? [];
    const nodes = (raw.nodes ?? []).map(splitFullname);
    const parameters: { [node: string]: ReturnType<typeof buildLazyTree> | null } = {};
    for (const fullname of raw.nodes ?? []) {
        const entries = paramStore.getStructure(fullname);
        parameters[fullname] = entries
            ? mergeWithCached(fullname, entries)
            : null;   // 结构未推到(慢节点):沿用旧"获取失败"显示语义
    }
    const lifecycleNodes = lifecycleNames
        .map((n) => {
            const info = lifecycleStore.get(n);
            return info ? assembleLifecycleNode(n, info) : null;
        })
        .filter((x) => x !== null);
    return {
        ready: true,
        isHelperRunning: true,
        nodes,
        topics: Object.entries(raw.topics).map(([name, type]) => ({ name, type })),
        services: separatedServices,
        actions,
        parameters,
        lifecycleNodes,
        lifecycleDiscovered: lifecycleNames,
        valueErrors,
    };
}

function mergeWithCached(fullName: string, entries: ParamStructureEntry[]) {
    const flat = paramStore.getValues(fullName);
    return flat ? mergeValuesIntoLazyTree(buildLazyTree(entries), flat) : buildLazyTree(entries);
}

/* ================================================================== */
/* 命令域查询注入(param_list/param_get 公共 API 面)                     */
/* ================================================================== */

import type { Ros2ServiceApi } from "../../api";
import type {
    MonitorApi,
    QueryResult,
    NodeInfo,
    TopicInfo,
    ServiceInfo,
    ActionInfo,
    ParamTree,
    LifecycleStateLabel,
    LifecycleTransitionLabel,
    LifecycleNode,
} from "../../api";

/**
 * 命令域查询实例(注入;compose 组装时经 setRos2ServiceApi 注入 Ros2ServiceApi 实现)。
 * 未注入时降级兜底(空值,不崩);依赖方向:monitor-api → api 类型(无环)。
 */
let ros2Service: Ros2ServiceApi = {
    pkg_list: async () => [],
    pkg_prefix: async () => "",
    pkg_executables: async () => [],
    pkg_executables_full: async () => [],
    interface_list: async () => [],
    param_list: async () => [],
    param_get: async () => "",
    lifecycle_nodes: async () => [],
    lifecycle_get: async () => ({ id: -1, label: "" }),
    lifecycle_set: async (_opts: { node: string; transition: string }) => undefined,
    colcon_list: async () => [],
};

/** 注入命令域查询实例(compose 组装时调用;替换降级兜底) */
export function setRos2ServiceApi(api: Ros2ServiceApi): void {
    ros2Service = api;
}

/* ================================================================== */
/* A. 列表查询(全部 = 仓库投影,同步数据包 Promise 壳)                   */
/* ================================================================== */

/** A1 运行节点列表(仓库投影;未就绪 ok=false) */
async function nodes(): Promise<QueryResult<NodeInfo[]>> {
    try {
        const raw = graphStore.view();
        if (!raw) {
            return { success: false, data: [] };
        }
        return { success: true, data: (raw.nodes ?? []).map(splitFullname) };
    } catch (err) {
        log.debug(`A1 nodes() failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: [] };
    }
}

/** A2 话题列表(仓库投影) */
async function topics(): Promise<QueryResult<TopicInfo[]>> {
    try {
        const raw = graphStore.view();
        if (!raw) {
            return { success: false, data: [] };
        }
        return { success: true, data: Object.entries(raw.topics).map(([name, type]) => ({ name, type })) };
    } catch (err) {
        log.debug(`A2 topics() failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: [] };
    }
}

/** A3 服务列表(仓库投影) */
async function services(): Promise<QueryResult<ServiceInfo[]>> {
    try {
        const raw = graphStore.view();
        if (!raw) {
            return { success: false, data: [] };
        }
        return { success: true, data: Object.entries(raw.services).map(([name, type]) => ({ name, type })) };
    } catch (err) {
        log.debug(`A3 services() failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: [] };
    }
}

/** A7 动作列表(classify 从仓库服务清单聚合) */
async function actions(): Promise<QueryResult<ActionInfo[]>> {
    try {
        const raw = graphStore.view();
        if (!raw) {
            return { success: false, data: [] };
        }
        const entries = Object.entries(raw.services).map(([name, type]) => ({ name, type }));
        return { success: true, data: separateActions(entries).actions };
    } catch (err) {
        log.debug(`A7 actions() failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: [] };
    }
}

/** A4 生命周期节点名列表(服务端随图推送的权威名单) */
async function lifecycle_nodes(): Promise<QueryResult<string[]>> {
    try {
        const raw = graphStore.view();
        if (!raw) {
            return { success: false, data: [] };
        }
        return { success: true, data: raw.lifecycle ?? [] };
    } catch (err) {
        log.debug(`A4 lifecycle_nodes() failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: [] };
    }
}

/** A5 节点参数名列表(委托 Ros2ServiceApi.param_list;公共 API 面保留) */
async function param_list(opts: { node: string }): Promise<QueryResult<string[]>> {
    try {
        const data = await ros2Service.param_list(opts);
        if (data === null) {
            return { success: false, data: [] };
        }
        return { success: true, data };
    } catch (err) {
        log.debug(`A5 param_list(${opts.node}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: [] };
    }
}

/**
 * A6a 参数结构懒树(仓库投影;结构由服务端推送,这里只读)。
 */
async function param_structure(opts: { node: string }): Promise<QueryResult<ParamTree>> {
    try {
        const entries = paramStore.getStructure(opts.node);
        if (!entries) {
            return { success: false, data: {} };
        }
        return { success: true, data: buildLazyTree(entries) };
    } catch (err) {
        log.debug(`A6a param_structure(${opts.node}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: {} };
    }
}

/**
 * A6c 参数视图(结构 + 已缓存值合并;纯投影,零 IO)。
 */
async function param_view(opts: { node: string }): Promise<QueryResult<ParamTree>> {
    try {
        const entries = paramStore.getStructure(opts.node);
        if (!entries) {
            return { success: false, data: {} };
        }
        const flat = paramStore.getValues(opts.node);
        const data = flat
            ? mergeValuesIntoLazyTree(buildLazyTree(entries), flat)
            : buildLazyTree(entries);
        return { success: true, data };
    } catch (err) {
        log.debug(`A6 param_view(${opts.node}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: {} };
    }
}

/**
 * A6b 展开订阅+取值(订阅制核心:节点计入服务端账本+回底账;
 * 成功入库后 param push 保鲜;失败标记 valueError 供 UI 显示)。
 */
async function param_values(opts: { node: string }): Promise<QueryResult<ParamTree>> {
    param_expand(opts.node);
    try {
        const entries = paramStore.getStructure(opts.node);
        if (!entries || entries.length === 0) {
            // 名册未到(慢节点/刚回归):标记失败可见,镜像已记——名册 push 到货自动补订阅
            paramStore.markValueError(opts.node);
            markDirty();
            return { success: false, data: {} };
        }
        const flat = await helperClient.getParamValues(opts.node, entries.map((e) => e.name));
        paramStore.setValues(opts.node, flat);
        paramStore.clearValueError(opts.node);
        markDirty();
        return { success: true, data: mergeValuesIntoLazyTree(buildLazyTree(entries), flat) };
    } catch (err) {
        paramStore.markValueError(opts.node);
        markDirty();
        log.debug(`A6b param_values(${opts.node}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, data: {} };
    }
}

/* ================================================================== */
/* B. 单点查询                                                            */
/* ================================================================== */

/** B1 参数值(委托 Ros2ServiceApi.param_get;失败 → null。公共 API 面保留) */
async function param_get(opts: { node: string; param: string }): Promise<string | null> {
    try {
        return await ros2Service.param_get(opts);
    } catch (err) {
        log.debug(`B1 param_get(${opts.node}.${opts.param}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

/** B2 当前状态(仓库读数——状态只经权威 push 下发,零请求) */
async function lifecycle_get(opts: { node: string }): Promise<LifecycleStateLabel | null> {
    const info = lifecycleStore.get(opts.node);
    return info ? (info.state as LifecycleStateLabel) : null;
}

/**
 * B3 节点详情(仓库投影:详情由服务端权威 push 覆盖)。
 * 语义沿用:仓库无该节点详情 → 整体 null。
 */
async function lifecycle_node_info(opts: { node: string }): Promise<LifecycleNode | null> {
    const info = lifecycleStore.get(opts.node);
    if (!info) {
        return null;
    }
    const assembled = assembleLifecycleNode(opts.node, info);
    return {
        name: assembled.name,
        namespace: assembled.namespace,
        currentState: assembled.currentState as LifecycleStateLabel,
        availableTransitions: assembled.availableTransitions as LifecycleTransitionLabel[],
        availableStates: assembled.availableStates as LifecycleStateLabel[],
        graph: assembled.graph,
    };
}

/** B4 节点能力上支持的全部状态(仓库 ∪ 标准 4 态;无详情 → 标准 4 态兜底) */
async function lifecycle_available_states(opts: { node: string }): Promise<LifecycleStateLabel[]> {
    const info = lifecycleStore.get(opts.node);
    if (!info) {
        return [...STANDARD_STATE_LABELS];
    }
    const states: LifecycleStateLabel[] = info.states.map((s) => s as LifecycleStateLabel);
    for (const s of STANDARD_STATE_LABELS) {
        if (!states.includes(s)) {
            states.push(s);
        }
    }
    return states;
}

/* ================================================================== */
/* C. 操作(2 个成员函数)                                                */
/* ================================================================== */

/** C2 助手在线判定(ping 常驻助手;失败 → false) */
async function helper_running(): Promise<boolean> {
    try {
        return await helperClient.pingHelper();
    } catch (err) {
        log.debug(`C2 helper_running() failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/**
 * C3 单步转换(CLI 通道 `ros2 lifecycle set <node> <label>`;拒绝=非零退出码→reject→false)。
 * 转换直发 label(边无 id 协议,transitionId 全链退役)。
 */
async function lifecycle_transition(opts: { node: string; transition: LifecycleTransitionLabel }): Promise<boolean> {
    const node = opts.node;
    try {
        await ros2Service.lifecycle_set({ node, transition: opts.transition });
        log.debug(`C3 lifecycle_transition(${node}, ${opts.transition}) -> succeeded`);
        return true;
    } catch (err) {
        log.debug(`C3 lifecycle_transition(${node}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/** 独立 monitor 对象:状态页全部查询/操作能力(投影/渲染留在 monitor-refresh 与前端) */
export const monitorApi: MonitorApi = {
    // A 列表查询
    nodes,
    topics,
    services,
    actions,
    lifecycle_nodes,
    param_list,
    param_structure,
    param_view,
    param_values,
    // B 单点查询
    param_get,
    lifecycle_get,
    lifecycle_node_info,
    lifecycle_available_states,
    // C 操作
    helper_running,
    lifecycle_transition,
    projectFrame,
};

/** 【测试专用】清空全部仓库(单测切换 mock 后避免读到旧数据) */
export function _resetGraphCacheForTest(): void {
    graphStore.invalidate();
    paramStore.invalidateAll();
    lifecycleStore.clear();
}

/** 【测试专用】清空参数仓库(结构+值+镜像;单测切换 mock 后避免读到旧缓存) */
export function _resetParamStoreForTest(): void {
    paramStore.invalidateAll();
}
