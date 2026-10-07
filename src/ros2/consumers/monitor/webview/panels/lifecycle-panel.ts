// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file lifecycle-panel.ts
 * 状态页生命周期区(2026-10-03 十二轮自 ros2_webview_main.ts 拆出):
 * 生命周期节点卡片(状态图 SVG + 缩放/拖移/Ctrl+滚轮)+ 转换触发 + 转换结果提示。
 * transitionResults 缓存内聚本模块:消息中枢经 noteTransitionResult 写入并即时上屏。
 */

import { l10n } from "vscode";

import { t } from "../shared/i18n";

import { vscode } from "../shared/context";
import { renderStateGraphSVG } from "../graph/state-graph";
import { buildCollapsibleSection } from "../shared/dom-utils";
import { attachHoverTip, buildInfoIcon } from "../shared/hover-tip";
import { sendLog } from "../shared/context";
import {
    appendLifecycleLog, buildLifecycleLogBox, pruneLifecycleLogs, scrollLifecycleLogToEnd,
} from "./lifecycle-log";

// ==================================================================
// 节点区(2026-10-03 十七轮,用户裁定):生命周期独立区块取消,并入节点区——
// 生命周期节点行尾 ▸/▾,展开 = 原生命周期卡片(状态图+迁移);折叠不渲染 SVG(大系统省渲染);
// 展开集合与t("Full graph")开关均模块级记忆,跨刷新恢复
// ==================================================================
const lifecycleExpanded = new Set<string>();
// 完整图开关(2026-10-03 十八轮补三,用户裁定):从区块级改为**每节点**属性——
// 勾选只重刷该节点自己的卡片,不重塑其他生命周期节点;按节点记忆,跨刷新保留
const nodeFullGraph = new Map<string, boolean>();
// 十八轮(用户裁定,VM 实测背书):转换进行中守卫——慢回调(demo activate 实测 2011ms)期间
// 重复点击会产生排队的第二次 ChangeState(必失败出红字),且 UI 无任何"转换中"反馈
const transitionsInFlight = new Set<string>();
// 十八轮:生命周期详情缓存——慢回调超时(>10s×2)时 op_lifecycle_info 失败,节点会从载荷
// 蒸发(三角/卡片消失,转换完成后又回来);刷新失败时沿用上次已知信息,防闪烁
const lifecycleInfoCache = new Map<string, any>();
// 二十二轮:各条目的查询时刻(Date.now())——时间序原则:覆盖前按时刻判定,旧快照不覆盖新快照
const lifecycleInfoFetchedAt = new Map<string, number>();

/** 节点行级失败反馈(二十一,用户裁定:采用服务表单同款红色感叹徽标 + 悬浮详情;
 *  位置 = 节点名右手边,不再用行尾长文案顶出三角;4s 自清;卡片收起时兜底可见) */
function setRowTransientStatus(nodeName: string, text: string): void {
    document.querySelectorAll(".node-item").forEach((item) => {
        const name = item.querySelector(".entry-name")?.textContent;
        if (name !== nodeName) { return; }
        const row = item.querySelector(".node-row") as HTMLElement | null;
        const nameSpan = row?.querySelector(".entry-name") as HTMLElement | null;
        if (!row || !nameSpan) { return; }
        let badge = row.querySelector(".node-error-badge") as HTMLElement | null;
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "form-error-badge node-error-badge";
            badge.textContent = "!";
            nameSpan.insertAdjacentElement("afterend", badge);
        }
        attachHoverTip(badge, text);
        if (badge.dataset.timer) { clearTimeout(Number(badge.dataset.timer)); }
        badge.dataset.timer = String(setTimeout(() => { badge!.remove(); }, 4000));
    });
}

/** 挂载生命周期视图:状态图卡片 + 独立终端日志区(卡片在上,日志在下;
 *  日志区限高滚动,追加不再推图)。
 *  十八轮补七(用户实证双终端):挂载前先清本节点**全局**所有残留日志区——
 *  完整图就地重建等路径只删卡片时,旧日志区会成孤儿累积;按 data-node-name 清光保证唯一 */
function mountLifecycleView(item: HTMLElement, info: any, fullName: string): void {
    document.querySelectorAll(`.lifecycle-log[data-node-name="${fullName}"]`).forEach((el) => el.remove());
    item.querySelector(".lifecycle-node")?.remove();
    item.appendChild(buildLifecycleCard(info, fullName));
    item.appendChild(buildLifecycleLogBox(fullName));
    requestAnimationFrame(() => {
        const w = graphWraps[fullName];
        const st = graphZoomState[fullName];
        if (w && st) { w.scrollLeft = st.sx; w.scrollTop = st.sy; }
        // 二十一(用户反馈:刷新后闪烁回行头):日志区入 DOM 后滚到最新一条
        scrollLifecycleLogToEnd(fullName);
    });
}

/** 卸载生命周期视图(收起:卡片与日志区一并移除;日志仍在内存,展开即回放) */
function unmountLifecycleView(item: HTMLElement, fullName: string): void {
    item.querySelector(".lifecycle-node")?.remove();
    document.querySelectorAll(`.lifecycle-log[data-node-name="${fullName}"]`).forEach((el) => el.remove());
}

/** 完整图开关切换后就地重建该节点卡片(十八轮补三:每节点属性,勾选只重刷自己) */
function rebuildOneLifecycleCard(fullName: string): void {
    document.querySelectorAll(".node-item").forEach((item) => {
        if (item.querySelector(".entry-name")?.textContent !== fullName) { return; }
        const info = lifecycleInfoCache.get(fullName);
        if (!info) { return; }
        item.querySelector(".lifecycle-node")?.remove();
        mountLifecycleView(item as HTMLElement, info, fullName);
    });
}

export function renderNodesSection(container: HTMLElement, nodes: any[], lifecycleInfos: any[], parameters?: { [node: string]: unknown }, lifecycleDiscovered?: string[]): void {
    const section = buildCollapsibleSection("nodes", t("Nodes"),
        buildInfoIcon(t("Currently running nodes; lifecycle node rows expand (▸/▾) into a state graph - click a green available edge to trigger a transition. The \"Full graph\" checkbox on the card header shows official transitional states and error-handling edges (for diagnostics; affects only this node).")));
    container.appendChild(section.root);

    const list = document.createElement("div");
    list.className = "entry-list";

    // 生命周期映射:全名 → 详情(全名拼接:namespace 惯例自带结尾"/",直接相接);
    // 十八轮:本刷新失败的节点沿用上次已知信息(缓存),避免三角/卡片蒸发闪烁
    const lifecycleByName = new Map<string, any>();
    // 二十二轮:查询时刻戳(时间序原则落地)——缓存覆盖前按时刻判定,旧快照永不覆盖新快照;
    // 当前单刷新源下恒为新,防御未来多刷新源的乱序回写
    const now = Date.now();
    for (const info of lifecycleInfos) {
        if (!info) { continue; }
        const fullName = info.namespace
            ? (info.namespace.endsWith("/") ? info.namespace + info.name : info.namespace + "/" + info.name)
            : info.name;
        lifecycleByName.set(fullName, info);
        const prevAt = lifecycleInfoFetchedAt.get(fullName);
        if (prevAt !== undefined && prevAt > now) {
            // 已存条目的查询时刻晚于本轮(防御未来并发刷新源):保留更新数据
            lifecycleByName.set(fullName, lifecycleInfoCache.get(fullName));
            continue;
        }
        lifecycleInfoCache.set(fullName, info);
        lifecycleInfoFetchedAt.set(fullName, now);
    }

    // 发现清单(二十一):助手本轮发现的生命周期节点全名——"在册但无详情"=本轮
    // 详情获取失败(含从未成功,缓存无底),节点行挂 ! 徽标
    const discovered = new Set(lifecycleDiscovered || []);

    // 顺序稳定·保险一(2026-09-26):行按节点全名排序,不随助手发现顺序漂移
    const items = nodes
        .filter((node: any) => !!node)
        .map((node: any) => ({
            node,
            fullName: node.namespace
                ? (node.namespace.endsWith("/") ? node.namespace + node.name : node.namespace + "/" + node.name)
                : node.name,
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));

    // 十八轮补九(易失日志):节点真正消失(不在本轮节点清单)才清 info 缓存/时刻戳与日志,
    // info 刷新失败不清(沿用上次已知信息)
    const presentFullnames = new Set(items.map((it) => it.fullName));
    for (const key of [...lifecycleInfoCache.keys()]) {
        if (!presentFullnames.has(key)) {
            lifecycleInfoCache.delete(key);
            lifecycleInfoFetchedAt.delete(key);
        }
    }
    pruneLifecycleLogs(presentFullnames);

    for (const { fullName } of items) {
        const info = lifecycleByName.get(fullName) ?? lifecycleInfoCache.get(fullName);
        const item = document.createElement("div");
        item.className = "node-item";
        const row = document.createElement("div");
        row.className = "entry-row node-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "entry-name";
        nameSpan.textContent = fullName;
        row.appendChild(nameSpan);
        // 二十一(用户报告:数据级失败无徽标通道;补:发现但详情失败——含从未成功——也不漏)
        // 节点行 ! 徽标(常驻,随刷新重建):①本轮参数获取失败;②在册生命周期节点本轮
        // 详情获取失败(discovered 有它/lifecycleByName 无它)。悬浮显示原因
        const isLifecycle = discovered.has(fullName);
        const infoFailed = isLifecycle && !lifecycleByName.has(fullName);
        const paramFailed = parameters !== undefined && parameters[fullName] === null;
        if (infoFailed || paramFailed) {
            const reasons: string[] = [];
            if (paramFailed) { reasons.push(t("Parameter query failed this round (helper online but the node did not respond)")); }
            if (infoFailed) { reasons.push(t("Lifecycle info fetch failed this round (the node may be stuck); no state graph available")); }
            const badge = document.createElement("span");
            badge.className = "form-error-badge node-error-badge";
            badge.textContent = "!";
            attachHoverTip(badge, reasons.join("\n"));
            row.appendChild(badge);
        }
        item.appendChild(row);
        if (!info) {
            list.appendChild(item);   // 普通节点:纯显示行,无三角
            continue;
        }
        // 生命周期节点:行尾 ▸/▾,展开 = 原生命周期卡片(折叠态不渲染 SVG)
        const expanded = lifecycleExpanded.has(fullName);
        const toggle = document.createElement("span");
        toggle.className = "node-toggle";
        toggle.textContent = expanded ? "▾" : "▸";
        toggle.title = expanded ? t("Collapse the lifecycle state graph") : t("Expand the lifecycle state graph");
        const actions = document.createElement("span");
        actions.className = "param-tree-actions";
        actions.appendChild(toggle);
        row.appendChild(actions);
        if (expanded) {
            mountLifecycleView(item as HTMLElement, info, fullName);
        }
        toggle.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (lifecycleExpanded.has(fullName)) {
                lifecycleExpanded.delete(fullName);
                unmountLifecycleView(item as HTMLElement, fullName);
                toggle.textContent = "▸";
                toggle.title = t("Expand the lifecycle state graph");
            } else {
                lifecycleExpanded.add(fullName);
                mountLifecycleView(item as HTMLElement, info, fullName);
                toggle.textContent = "▾";
                toggle.title = t("Collapse the lifecycle state graph");
            }
        });
        list.appendChild(item);
    }
    if (items.length === 0) {
        const empty = document.createElement("p");
        empty.className = "param-tree-empty";
        empty.textContent = t("No running nodes right now");
        section.body.appendChild(empty);
    }
    section.body.appendChild(list);
}

/** 生命周期卡片(原 renderLifecycleNodes 卡片体原样迁入):状态徽章/状态图/缩放/迁移结果 */
function buildLifecycleCard(node: any, fullName: string): HTMLElement {
    const nodeDiv = document.createElement("div");
    nodeDiv.className = "lifecycle-node";
    // 2026-08-26②:卡片标记节点全名,供转换结果消息定位
    nodeDiv.setAttribute("data-node-name", fullName);

    // Node header with name and state
    const headerDiv = document.createElement("div");
    headerDiv.className = "lifecycle-node-header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "node-name";
    nameSpan.textContent = fullName;

    const stateSpan = document.createElement("span");
    stateSpan.className = `node-state state-${node.currentState}`;
    stateSpan.textContent = node.currentState;

    // 2026-08-26⑫:右侧组 = 状态 + 每节点完整图开关 + 缩放工具条(保持 flex 布局)
    const rightGroup = document.createElement("div");
    rightGroup.className = "node-header-right";
    rightGroup.appendChild(stateSpan);
    // 每节点「完整图」开关(十八轮补三,用户裁定:分支属性,勾选只重刷此卡)
    const fullLabel = document.createElement("label");
    fullLabel.className = "sg-toggle";
    fullLabel.title = t("Show official transitional states and error-handling edges (for diagnostics; affects only this node)");
    const fullCheck = document.createElement("input");
    fullCheck.type = "checkbox";
    fullCheck.checked = nodeFullGraph.get(fullName) ?? false;
    fullCheck.addEventListener("change", () => {
        nodeFullGraph.set(fullName, fullCheck.checked);
        rebuildOneLifecycleCard(fullName);   // 勾选立即换装,不等数据刷新
    });
    fullLabel.appendChild(fullCheck);
    fullLabel.appendChild(document.createTextNode(t("Full graph")));
    rightGroup.appendChild(fullLabel);
    headerDiv.appendChild(nameSpan);
    headerDiv.appendChild(rightGroup);
    nodeDiv.appendChild(headerDiv);

    // 十八轮补四:终端日志区不再内嵌卡片——由 mountLifecycleView 作为独立兄弟块渲染在图下方
    // 2026-08-26 状态图(自绘 SVG;替代按钮式;DESIGN.md §1.7);完整图 = 每节点属性
    renderStateGraphSVG({
        name: fullName,
        currentState: node.currentState,
        availableTransitions: node.availableTransitions || [],
        availableStates: node.availableStates || [],
        graph: node.graph,
        showFullGraph: nodeFullGraph.get(fullName) ?? false,
        onTransition: (transition) => triggerTransition(fullName, transition),
    }, nodeDiv);

    // 2026-08-26⑫:缩放(方案一,简单版)——滚动容器 + −/＋/复位;状态按节点名存,重建后恢复
    const graphSvg = nodeDiv.querySelector("svg") as SVGSVGElement | null;
    if (graphSvg) setupGraphZoom(nodeDiv, graphSvg, fullName);

    // 十八轮:转换仍在进行中(重建发生在转换等待期)→ 日志区补"执行中"一行(历史已回放)
    if (transitionsInFlight.has(fullName)) {
        appendLifecycleLog(fullName, "转换执行中…", "pending");
    }

    return nodeDiv;
}

// ==================================================================
// 2026-08-26⑫:状态图缩放(方案一,简单版)
// 每卡状态图包一层 .svg-zoom-wrap(overflow:auto,max-height:300px):
//  - 默认自适应宽度(max-width:100%,与旧行为一致);
//  - 放大/复位 = 改 SVG 的 CSS 尺寸(矢量放大,不重算布局);2026-09-26 批次3 另支持
//    拖动背景平移(pointer 拖拽改 scroll,拖过不触发边点击)与 Ctrl+滚轮以光标为锚点缩放;
//  - 缩放与滚动位置按 node.name 缓存;滚动重建后经 rAF 恢复(必须等卡片入 DOM,
//    内联恢复时未入文档无布局,scrollLeft 赋值会被钳 0 → 每次刷新回左上角)。
// ==================================================================
const graphZoomState: { [node: string]: { z: number; sx: number; sy: number } } = {};
const graphWraps: { [node: string]: HTMLDivElement } = {};

function setupGraphZoom(nodeDiv: HTMLElement, svg: SVGSVGElement, nodeName: string): void {
    graphZoomState[nodeName] = graphZoomState[nodeName] || { z: 1, sx: 0, sy: 0 };

    // 滚动容器:内容超出时出现横向/纵向滑条
    const wrap = document.createElement("div");
    wrap.className = "svg-zoom-wrap";
    if (svg.parentNode) svg.parentNode.insertBefore(wrap, svg);
    wrap.appendChild(svg);
    graphWraps[nodeName] = wrap;
    wrap.addEventListener("scroll", () => {
        const st = graphZoomState[nodeName];
        if (st) { st.sx = wrap.scrollLeft; st.sy = wrap.scrollTop; }
    });

    // ── 拖动平移(批次3):按住背景拖拽改 scroll;位移>3px 才判定拖动并捕获指针,
    //    未过阈值的点按不捕获、不拦截 → 状态边点击完全不受影响;拖过的 click 在捕获阶段拦截。
    let dragStart: { x: number; y: number; l: number; t: number } | null = null;
    let dragMoved = false;
    wrap.style.cursor = "grab";
    wrap.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) { return; }
        dragStart = { x: ev.clientX, y: ev.clientY, l: wrap.scrollLeft, t: wrap.scrollTop };
        dragMoved = false;
    });
    wrap.addEventListener("pointermove", (ev) => {
        if (!dragStart) { return; }
        const dx = ev.clientX - dragStart.x;
        const dy = ev.clientY - dragStart.y;
        if (!dragMoved && Math.hypot(dx, dy) <= 3) { return; }
        if (!dragMoved) {
            dragMoved = true;
            wrap.style.cursor = "grabbing";
            try { wrap.setPointerCapture(ev.pointerId); } catch { /* 已释放 */ }
        }
        wrap.scrollLeft = dragStart.l - dx;
        wrap.scrollTop = dragStart.t - dy;
    });
    const endDrag = (ev: PointerEvent): void => {
        if (!dragStart) { return; }
        dragStart = null;
        wrap.style.cursor = "grab";
        try { wrap.releasePointerCapture(ev.pointerId); } catch { /* 已释放 */ }
    };
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);
    wrap.addEventListener("click", (ev) => {
        if (dragMoved) {
            dragMoved = false;
            ev.stopPropagation();
            ev.preventDefault();
        }
    }, true);

    // ── Ctrl+滚轮缩放(批次3):以光标为锚点(缩放前后光标下的内容点保持不动;
    //    z=1 边界 CSS 宽度自适应截断,锚点做 best-effort);±0.25 与按钮同档。
    wrap.addEventListener("wheel", (ev: WheelEvent) => {
        if (!ev.ctrlKey) { return; }
        ev.preventDefault();
        const st = graphZoomState[nodeName];
        if (!st) { return; }
        const oldZ = st.z;
        const newZ = Math.max(0.5, Math.min(4, Math.round((oldZ + (ev.deltaY < 0 ? 0.25 : -0.25)) * 4) / 4));
        if (newZ === oldZ) { return; }
        const rect = wrap.getBoundingClientRect();
        const ox = ev.clientX - rect.left;
        const oy = ev.clientY - rect.top;
        const sl = wrap.scrollLeft;
        const stp = wrap.scrollTop;
        applyGraphZoom(svg, nodeName, newZ);
        const k = newZ / oldZ;
        wrap.scrollLeft = (sl + ox) * k - ox;
        wrap.scrollTop = (stp + oy) * k - oy;
    }, { passive: false });

    // 工具条:卡片头部右侧(状态徽章旁)
    const right = nodeDiv.querySelector(".node-header-right") as HTMLElement | null;
    if (right) {
        const tools = document.createElement("div");
        tools.className = "svg-zoom-tools";
        const mkBtn = (label: string, title: string, onClick: () => void) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.title = title;
            b.addEventListener("click", onClick);
            tools.appendChild(b);
        };
        mkBtn("−", t("Zoom out (step 0.25)"), () => applyGraphZoom(svg, nodeName, (graphZoomState[nodeName]?.z ?? 1) - 0.25));
        mkBtn("＋", t("Zoom in (step 0.25)"), () => applyGraphZoom(svg, nodeName, (graphZoomState[nodeName]?.z ?? 1) + 0.25));
        mkBtn(t("Reset"), t("Restore adaptive width"), () => applyGraphZoom(svg, nodeName, 1));
        right.appendChild(tools);
    }

    // 缩放恢复(仅改 CSS 尺寸,未入 DOM 也安全);滚动位置由挂载助手的 rAF 统一恢复
    applyGraphZoom(svg, nodeName, graphZoomState[nodeName].z);
}

function applyGraphZoom(svg: SVGSVGElement, nodeName: string, z: number): void {
    const st = graphZoomState[nodeName];
    // 缩放容器(卡片内滚动包裹层)——缩放时冻结像素宽,复位时解冻(十八轮补六:
    // 用户反馈缩放时"宽会变"——svg 显式宽一旦超出,布局宽随之漂移;钉死容器即钉死卡片)
    const wrap = svg.parentElement as HTMLElement | null;
    if (!st || !wrap) return;
    z = Math.max(0.5, Math.min(4, Math.round(z * 4) / 4));
    // 二十一-1(用户实证:放大状态交互后图空白):卡片构建期尚未入 DOM,clientWidth=0
    // 会被冻结成 width:0px → 图整体不可见;记下 z 并延迟一帧,挂载有布局后再应用
    if (z !== 1 && (!wrap.isConnected || wrap.clientWidth === 0)) {
        st.z = z;
        requestAnimationFrame(() => applyGraphZoom(svg, nodeName, z));
        return;
    }
    if (z === 1) {
        svg.style.width = "";
        svg.style.height = "";
        svg.style.maxWidth = "100%";   // 默认行为:自适应宽度
        wrap.style.width = "";
    } else {
        if (!wrap.style.width) {
            wrap.style.width = `${wrap.clientWidth}px`;   // 冻结当前布局宽(box-sizing 默认 content-box,clientWidth 含 padding)
        }
        const baseW = Number(svg.getAttribute("width")) || 0;
        const baseH = Number(svg.getAttribute("height")) || 0;
        svg.style.maxWidth = "none";
        svg.style.width = Math.round(baseW * z) + "px";
        svg.style.height = Math.round(baseH * z) + "px";
    }
    st.z = z;
}

function triggerTransition(nodeName: string, transition: string) {
    // 十八轮:转换进行中忽略重复点击(慢回调期间排队的第二次 ChangeState 必失败,徒增失败红字)
    if (transitionsInFlight.has(nodeName)) {
        sendLog("trace", `triggerTransition:节点 ${nodeName} 转换进行中,忽略重复点击(${transition})`);
        return;
    }
    transitionsInFlight.add(nodeName);
    appendLifecycleLog(nodeName, `转换 ${transition} 执行中…`, "pending");
    sendLog("trace", `triggerTransition:node=${nodeName}, transition=${transition}`);
    vscode.postMessage({
        command: 'triggerLifecycleTransition',
        nodeName: nodeName,
        transition: transition
    });
}

// 2026-08-26② 转换结果 toast 已于十八轮补四退役:改终端式日志区(lifecycleLogs,持久可追溯)

/** 转换结果到达(消息中枢 transitionResult 消息):清进行中守卫,写入节点日志区(持久可追溯);
 *  失败时附节点即时真实状态(后端补查,1ms)——典型拒绝原因=界面状态过期,文案指明 */
export function noteTransitionResult(nodeName: string, transition: string, success: boolean, currentState?: string): void {
    transitionsInFlight.delete(nodeName);
    let text: string;
    if (success) {
        text = `转换 ${transition} 成功`;
    } else if (currentState) {
        text = `转换 ${transition} 失败(节点当前:${currentState};界面已过期则点击后自动刷新)`;
    } else {
        text = `转换 ${transition} 失败`;
    }
    sendLog("debug", `transitionResult: node=${nodeName}, ${text}`);
    appendLifecycleLog(nodeName, text, success ? "success" : "error");
    if (!success) {
        // 卡片收起(日志区不可见)时失败也要可见——节点行暂态红字
        setRowTransientStatus(nodeName, text);
        return;
    }
    // 成功即乐观更新——从缓存的图边取 goal 态,就地换装卡片,图谱 0ms 翻转
    // (权威 lifecycle push 随后覆盖;日志区是独立兄弟块,换装不触碰,历史与滚动位置原样保留)
    const cached = lifecycleInfoCache.get(nodeName) as any;
    const current = typeof cached?.currentState === "string" ? cached.currentState : cached?.currentState?.label;
    const edge = (cached?.graph?.edges ?? []).find((e: any) => e.label === transition && e.fromLabel === current);
    if (edge) {
        cached.currentState = edge.toLabel;
        cached.availableTransitions = (cached.graph?.edges ?? [])
            .filter((e: any) => e.fromLabel === edge.toLabel)
            .map((e: any) => e.label);
        const item = document.querySelector(`.lifecycle-node[data-node-name="${nodeName}"]`)?.parentElement;
        if (item) {
            item.querySelector(".lifecycle-node")?.remove();
            const logBox = item.querySelector(`.lifecycle-log[data-node-name="${nodeName}"]`);
            if (logBox) {
                item.insertBefore(buildLifecycleCard(cached, nodeName), logBox);
            } else {
                item.appendChild(buildLifecycleCard(cached, nodeName));
            }
        }
    }
}
