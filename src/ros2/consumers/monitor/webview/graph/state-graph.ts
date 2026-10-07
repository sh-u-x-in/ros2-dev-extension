/**
 * @file state-graph.ts
 * 生命周期状态图 · 自绘 SVG 渲染编排(webview 前端,无 vscode API)。
 * 2026-08-26 自 consumers/monitor/webview/ros2_webview_main.ts 抽离(该文件过长);
 * 2026-10-03 十二轮再拆:布局/几何/测宽域移入 state-graph-layout.ts;
 * 2026-10-03 十九轮批4 再拆:静态表/语义集合/视图组装(StateGraphNode/buildGraphView)
 * 移入 state-graph-view.ts,本文件保留 SVG 渲染编排(renderStateGraphSVG)。
 * 设计依据:设计/重构/monitor消费者接口-2026-08-26/DESIGN.md §1.7(视觉编码)。
 *
 * 视觉编码:
 *   圆形 = 标准状态(静态,ROS2 内置 4 态)
 *   方形 = 动态状态(节点自定义,get_available_states)
 *   绿实线 = 当前可选转换(可点击执行)
 *   灰实线 = 图中存在但当前不可选(点击提示)      // ⑪:原灰虚线(6,4)
 *   灰虚线 = 框架内部错误边(仅完整视图,不可交互)  // ⑪:原灰点线(2,3)
 *   高亮(填充+粗描边) = 当前状态
 */

import { t } from "../shared/i18n";

import {
    computeLayoutWithDagre, makeEdgePath, measureLabelWidth, planAnchors, trimPathEnd,
    LaidEdge, NODE_H, NODE_W, MARKER_ID,
} from "./state-graph-layout";
import {
    buildGraphView, PRIMARY_UNKNOWN_LABEL, STANDARD_STATES,
    TRANSITIONAL_STATE_LABELS, StateGraphNode,
} from "./state-graph-view";

/* ================================================================== */
/* SVG 构建 helpers                                                   */
/* ================================================================== */

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
}

/** 状态节点盒:圆形=标准 / 方形=动态;过渡态(完整视图)弱化;高亮=当前 */
function makeStateNodeSVG(state: string, isCurrent: boolean, isDynamic: boolean, isTransitional = false): SVGElement {
    const rx = isDynamic ? "8" : String(NODE_H / 2);  // 方形圆角 / 圆形
    const g = svgEl("g", { transform: "" });
    const rect = svgEl("rect", {
        width: String(NODE_W), height: String(NODE_H), rx, ry: rx,
        fill: isCurrent ? "#264f78" : (isTransitional ? "#2b2b2b" : "#333"),
        stroke: isCurrent ? "#3794ff" : (isDynamic ? "#b486f0" : (isTransitional ? "#8a8a8a" : "#6c757d")),
        "stroke-width": isCurrent ? "3" : "2",
        "stroke-dasharray": isTransitional ? "4,3" : (isDynamic ? "5,3" : "none"),
        opacity: isTransitional ? "0.8" : "1",
    });
    g.appendChild(rect);
    const text = svgEl("text", {
        x: String(NODE_W / 2), y: String(NODE_H / 2),
        "text-anchor": "middle", "dominant-baseline": "central",
        fill: isCurrent ? "#fff" : "#ddd",
        "font-size": "12", "font-weight": isCurrent ? "bold" : "normal",
    });
    text.textContent = state;
    g.appendChild(text);
    return g;
}

export function renderStateGraphSVG(node: StateGraphNode, container: HTMLElement): void {
    // 2026-08-26:图数据优先(主数据源);无图 → 静态表 + availableTransitions 兜底
    const built = buildGraphView(node);
    const allStates = built.states;
    const edges = built.edges;

    const { nodes: pos, edges: laidEdges, W, H, ox, oy } = computeLayoutWithDagre(allStates, node.currentState, edges);
    // 2026-08-26⑨:锚点顺序打点(弧长参数化 + 短路径优先 + D_min 远离;替代 ⑥ 的索引中点)
    const anchors = planAnchors(laidEdges, ox, oy);

    const svg = svgEl("svg", {
        width: String(W), height: String(H),
        viewBox: "0 0 " + W + " " + H,
        style: "max-width:100%;display:block;",
    });

    // hover 高亮(2026-08-26 用户定稿):可用边"蓝色描边"——下层蓝色粗线(hover 显示),主箭头为绿色
    // 2026-08-26④:halo 线改由 CSS(.sg-avail:hover)驱动——静态 SVG(本地 index.html)与真实 webview 均生效;蓝箭头改回绿箭头(本就是"绿箭头+蓝描边")
    // z-order 契约(2026-08-26③):绘制顺序 = defs → 边 → 节点 → label(最后),文字永远在路线/节点之上;
    // label 白底框(.sg-label-bg)+ 黑字(pointer-events:none),密集/长字段时仍可识别为整体。
    const hoverStyle = svgEl("style", {});
    // 2026-08-26⑧:绿线 hover(蓝 halo 线+蓝箭头边缘)由 JS 驱动(蓝 marker 不在 g 子树,CSS 管不到);
    // 灰线 hover:降低灰度(变白) + `.sg-edge-main` 命中 class;点击/悬停范围由 `.sg-edge-hit`(宽 6,同绿线 halo)承担。
    hoverStyle.textContent = ".sg-avail{cursor:pointer}"
        + ".sg-unavail{opacity:.55}.sg-unavail:hover{opacity:.85}"
        + ".sg-unavail:hover .sg-edge-main{stroke:#e8e8e8}"
        // 2026-08-26⑩:钉死 label 字体(与 canvas 测量共用同一字体栈,宽度才测得到);font-size 交给
        // text 属性(9/10px),CSS 不再写死 10px(否则会覆盖 error 边的 9px 属性)。
        + ".sg-label{fill:#fff;stroke:#000;stroke-width:1;paint-order:stroke;font-family:var(--vscode-font-family, \"Segoe UI\", \"DejaVu Sans\", sans-serif);pointer-events:none}"
        + ".sg-label-bg{fill:none;stroke:#fff;stroke-width:1;pointer-events:none}"
        + ".sg-leader{stroke:#cfcfcf;stroke-width:1;stroke-dasharray:3,2;pointer-events:none}"
        // 2026-08-26⑩:圆点加黑色描边(与文字"白字黑描边"同构)——贴白框/白字时不再"白对白"看不清。
        + ".sg-leader-dot{fill:#cfcfcf;stroke:#000;stroke-width:0.8;paint-order:stroke;pointer-events:none}";
    svg.appendChild(hoverStyle);

    // 箭头 marker(每 svg 实例唯一 id,避免多图共享箭头错乱)
    // 2026-08-26②④:灰(不可用/错误边,共享)+ 绿(可用边主箭头,共享);
    // markerUnits=userSpaceOnUse(2026-08-26④):箭头大小不随 stroke-width 缩放,修复点线(宽1)箭头偏小。
    const markerBase = MARKER_ID + "-" + (node.name.replace(/[^a-zA-Z0-9]/g, "_") || "n");
    const grayMarkerId = markerBase + "-gray";
    const defs = svgEl("defs", {});
    // 2026-08-26⑬:共享灰箭头仅错误边使用(不可交互,无 hover);可选/不可选边各自独立箭头——
    // marker 内容不在 g 子树内、CSS 管不到,共享会导致 hover 一条边全校箭头变色(⑫ 遗留问题)。
    {
        const m = svgEl("marker", {
            // 2026-08-26⑭⑰:refX=2.5 → 基部在路径末端前 2px,线端叠进箭头 2px(消除贴合缝)
            id: grayMarkerId, viewBox: "0 0 10 10", refX: "2.5", refY: "5",
            markerWidth: "8", markerHeight: "8", orient: "auto-start-reverse",
            markerUnits: "userSpaceOnUse",
        });
        const mp = svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#6c757d" });
        m.appendChild(mp);
        defs.appendChild(m);
    }
    svg.appendChild(defs);

    // 收集 label 到最后统一画(最上层,不被边挡住);先画所有边 path
    const labelTasks: { text: SVGElement; x: number; y: number }[] = [];

    laidEdges.forEach((e: LaidEdge, idx: number) => {
        if (!e.points || e.points.length < 2) return;
        const pts = e.points.map((p) => ({ x: p.x + ox, y: p.y + oy }));
        const g = svgEl("g", { class: e.error ? "sg-err" : (e.available ? "sg-avail" : "sg-unavail") });
        // 2026-08-26⑭⑰:主边(含 halo)末端裁 6px + 箭头 refX=2.5 → 箭头基部在线端前 2px,
        // 线端**叠进箭头基部 2px**(被不透明箭头盖住,消除"边对边"贴合的反锯齿缝);
        // 箭头尖端仍在原端点(线不会露出箭头之外)。
        const d = makeEdgePath(trimPathEnd(pts, 6));
        // 2026-08-26⑬:每边独立箭头 marker(error 边仍共享灰箭头):
        //  - 可用边:绿箭头带蓝色描边(stroke-opacity 0 常态隐藏,hover 时显示)——箭头"参与"蓝色高亮,形状仍是三角形;
        //  - 不可选边:独立灰箭头,hover 只变自己(修 ⑫ 全部灰箭头一起变白的问题)。
        const edgeMarkerId = e.error ? grayMarkerId : (markerBase + (e.available ? "-green-" : "-gray-uniq-") + idx);
        let edgeArrow: SVGElement | null = null;
        if (!e.error) {
            const m = svgEl("marker", {
                // 2026-08-26⑭⑰:refX=2.5(基部在线端前 2px)+ 主边裁 6px → 线端叠进箭头 2px
                id: edgeMarkerId, viewBox: "0 0 10 10", refX: "2.5", refY: "5",
                markerWidth: "8", markerHeight: "8", orient: "auto-start-reverse",
                markerUnits: "userSpaceOnUse",
            });
            edgeArrow = svgEl("path", {
                d: "M 0 0 L 10 5 L 0 10 z",
                fill: e.available ? "#28a745" : "#6c757d",
            });
            m.appendChild(edgeArrow);
            defs.appendChild(m);
        }
        if (e.available && !e.error) {
            // 2026-08-26⑧⑫⑬⑭⑮⑯:蓝色 halo 线 = 主边同款路径(已裁 8px 到箭头基部)→ rim 与箭头无缝对接;
            // 绿箭头加**同心蓝 rim(重心相同)**:蓝三角以绿箭头重心(8/3,0)为中心放大 1.5 倍——
            // 基边 x=-1.333 y∈[-6,6]、顶点 (10.667,0),三边均匀外扩 ~1.2~1.33px(尖端也带蓝边),
            // 不是"顶点固定向后膨胀"。挂在 halo 路径末端(先画、绿箭头盖其上),随 halo opacity 一起显隐。
            const blueRimId = markerBase + "-blue-" + idx;
            const bm = svgEl("marker", {
                // ⑯⑰:绿箭头 refX=2.5 后,蓝 rim 同步 refX=3.333 → 仍与绿箭头重心重合
                id: blueRimId, viewBox: "0 0 12 12", refX: "3.333", refY: "6",
                markerWidth: "12", markerHeight: "12", orient: "auto-start-reverse",
                markerUnits: "userSpaceOnUse",
            });
            const bp = svgEl("path", { d: "M 0 0 L 12 6 L 0 12 z", fill: "#3794ff" });
            bm.appendChild(bp);
            defs.appendChild(bm);
            const halo = svgEl("path", {
                d, fill: "none", class: "halo-line",
                stroke: "#3794ff", "stroke-width": "6", "stroke-dasharray": "none", opacity: "0",
                "marker-end": "url(#" + blueRimId + ")",
            });
            g.appendChild(halo);
            g.addEventListener("mouseenter", () => halo.setAttribute("opacity", "0.55"));
            g.addEventListener("mouseleave", () => halo.setAttribute("opacity", "0"));
        }
        if (!e.available && !e.error) {
            // 不可用边命中层:宽 6(与绿线 halo 同宽),扩大 hover/点击判定范围;hover 时经 CSS 变白
            const hit = svgEl("path", {
                d, fill: "none", class: "sg-edge-hit",
                stroke: "#fff", "stroke-width": "6", "stroke-dasharray": "none", opacity: "0",
            });
            g.appendChild(hit);
            // 2026-08-26⑬:灰线 hover 白色高亮同步**本边**箭头(独立 marker;⑫ 共享时全校箭头一起变白)
            if (edgeArrow) {
                g.addEventListener("mouseenter", () => edgeArrow!.setAttribute("fill", "#e8e8e8"));
                g.addEventListener("mouseleave", () => edgeArrow!.setAttribute("fill", "#6c757d"));
            }
        }
        const path = svgEl("path", {
            d, fill: "none", class: "sg-edge-main",
            stroke: e.error ? "#777" : (e.available ? "#28a745" : "#9e9e9e"),
            "stroke-width": e.error ? "1" : "2",
            // 2026-08-26⑪:不可选边灰实线(原 6,4 虚线);错误边灰虚线(原 2,3 点线)
            "stroke-dasharray": e.error ? "4,3" : "none",
            "marker-end": "url(#" + edgeMarkerId + ")",
        });
        g.appendChild(path);
        if (e.error) {
            g.setAttribute("title", e.label + t(" (framework-internal transition; cannot be triggered manually)"));
        } else if (e.available) {
            g.onclick = () => node.onTransition(e.label);
            g.setAttribute("title", t("Trigger transition:") + e.label);
        } else {
            g.onclick = () => { if (node.onUnavailable) node.onUnavailable(e.label); };
            g.setAttribute("title", e.label + t(" currently unavailable"));
        }
        svg.appendChild(g);
        // 记录 label 锚点(2026-08-26⑤;⑥修正;⑨顺序打点):锚点是渲染曲线上的点
        // (Q 平滑以折线点为控制点,曲线只经过相邻中点),由 planAnchors 按弧长
        // 参数化 + 短路径优先顺序打点全局规划,圆点落在曲线上且互相远离。
        const anchor = anchors[idx];
        labelTasks.push({ text: null as unknown as SVGElement, x: anchor.x, y: anchor.y });
    });

    // 节点(边之后画,entity块);同样平移;__dyn_ 占位状态显示为转换名(动态方形)
    pos.forEach((p, state) => {
        const display = state.startsWith("__dyn_") ? state.replace("__dyn_", "") : state;
        const isTransitional = TRANSITIONAL_STATE_LABELS.has(state);
        const isDynamic = !STANDARD_STATES.includes(state) || state.startsWith("__dyn_");
        const g = makeStateNodeSVG(display, state === node.currentState, isDynamic, isTransitional);
        // 2026-08-26②:全部节点补 tooltip(角色 + 当前标记;过渡态/动态态/标准态)
        const role = isTransitional ? t("transitional state") : (isDynamic ? t("dynamic state") : t("standard state"));
        const curMark = state === node.currentState ? t(" · current state") : "";
        g.setAttribute("title", display + " (" + role + ")" + curMark);
        g.setAttribute("transform", "translate(" + (p.x + ox) + "," + (p.y + oy) + ")");
        svg.appendChild(g);
    });

    // label 最后统一画(最上层,不被边/节点挡)
    // 2026-08-26③:统一防重叠——label↔label / label↔节点框(含节点文字)/ label↔路径段(排除自身边);
    // 候选位置先下移后上移,全部冲突回原位(白描边兜底)。
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const nodeRects: { x: number; y: number; w: number; h: number }[] = [];
    pos.forEach((p, state) => {
        nodeRects.push({ x: p.x + ox, y: p.y + oy, w: NODE_W, h: NODE_H });
    });
    /** label 框(中心 cx,基线 y,高 h)与障碍是否冲突
     * 2026-08-26④:撤销"label↔路径段"主动避让(大图上偏离路径过大);仅避让 label↔label 与 label↔节点框。
     * 路径贴近交给白框(.sg-label-bg)视觉区分,不做几何偏移。 */
    function labelCollides(cx: number, cy: number, w: number, h: number, selfEdge: number): boolean {
        const box = { x: cx - w / 2, y: cy - h / 2, w, h };
        // 已放 label(含内边距 4)
        for (const pl of placed) {
            if (Math.abs(pl.x - cx) < (pl.w + w) / 2 + 4 && Math.abs(pl.y - cy) < (pl.h + h) / 2 + 4) return true;
        }
        // 节点框(含内边距 2;同时保护节点内文字)
        for (const n of nodeRects) {
            if (box.x < n.x + n.w + 2 && box.x + box.w + 2 > n.x && box.y < n.y + n.h + 2 && box.y + box.h + 2 > n.y) return true;
        }
        // 2026-08-26⑦:避开**其他边**的引线圆点(锚点)——字段不得压住别条边的圆点/引线起点
        // (自身锚点排除:引线从自身锚点接框边缘,允许贴近)
        for (let j = 0; j < labelTasks.length; j++) {
            if (j === selfEdge) continue;
            const a = labelTasks[j];
            if (!a) continue;
            const dx = Math.max(a.x - (cx + w / 2), (cx - w / 2) - a.x, 0);
            const dy = Math.max(a.y - (cy + h / 2), (cy - h / 2) - a.y, 0);
            if (Math.hypot(dx, dy) < 8) return true;
        }
        // 2026-08-26⑩:自身锚点必须位于框外(外扩 4px = 圆点半径 2.2 + 描边 1 + 余量)
        // ——"圆点永不被自己的白框遮挡"的不变式(与 ⑦ 的"别边锚点 8px"互补)。
        const selfA = labelTasks[selfEdge];
        if (selfA) {
            const M = 4;
            if (selfA.x > box.x - M && selfA.x < box.x + box.w + M
                && selfA.y > box.y - M && selfA.y < box.y + box.h + M) return true;
        }
        return false;
    }
    laidEdges.forEach((e, i) => {
        if (!labelTasks[i]) return;
        const anchor = labelTasks[i];   // 边路由中点(真实路径上的点)
        const isErr = !!e.error;
        const fontSize = isErr ? 9 : 10;
        // 2026-08-26⑩:宽度 = 精确测量(浏览器 canvas / Node 回退档位)+ 左右各 2px 内边距
        const w = measureLabelWidth(e.label, fontSize) + 4, h = fontSize + 3;
        // 2026-08-26⑤:label 放锚点四周空白(8 方向两圈),引线(leader)指向锚点;全忙回退锚点上方。
        const hw2 = w / 2;
        const candidateOffsets: Array<[number, number]> = [
            [0, -20], [0, 20],
            [-hw2 - 12, -12], [hw2 + 12, -12],
            [-hw2 - 12, 12], [hw2 + 12, 12],
            [0, -42], [0, 42],
            [-hw2 - 12, 0], [hw2 + 12, 0],
            [0, -64], [0, 64],
        ];
        let cx = anchor.x, cy = anchor.y - 20;
        for (const [dx, dy] of candidateOffsets) {
            const tx = anchor.x + dx, ty = anchor.y + dy;
            if (!labelCollides(tx, ty, w, h, i)) { cx = tx; cy = ty; break; }
        }
        // 引线(leader):锚点(路径上)→ label 框边缘;锚点处小圆点标记所属路径
        const dxv = cx - anchor.x, dyv = cy - anchor.y;
        const dist = Math.hypot(dxv, dyv);
        // 2026-08-26⑩:锚点位于字段框(外扩 4px)之外才画引线+圆点——保证圆点绝不被白框盖住
        // (与 labelCollides 的"自身锚点框外"不变式配套,兜底全忙回退等未过筛位置)。
        const boxL = cx - w / 2, boxT = cy - h / 2;
        const anchorOut = anchor.x < boxL - 4 || anchor.x > boxL + w + 4
            || anchor.y < boxT - 4 || anchor.y > boxT + h + 4;
        if (anchorOut && dist > 0.5) {
            const ux = dxv / dist, uy = dyv / dist;
            // 2026-08-26⑥:射线→矩形边界求最近交点(上/下/左/右四个边缘取正最小):
            // 锚点在框上方 → 引线接框上边缘;下方 → 下边缘(即"上/下引出点",不再穿框绕路)。
            let t = Infinity;
            const ts: number[] = [];
            if (ux > 0) ts.push((cx - w / 2 - anchor.x) / ux);
            else if (ux < 0) ts.push((cx + w / 2 - anchor.x) / ux);
            if (uy > 0) ts.push((cy - h / 2 - anchor.y) / uy);
            else if (uy < 0) ts.push((cy + h / 2 - anchor.y) / uy);
            for (const tv of ts) if (tv > 0) t = Math.min(t, tv);
            if (Number.isFinite(t) && t > 0) {
                const ex = anchor.x + ux * t, ey = anchor.y + uy * t;
                const leader = svgEl("path", {
                    d: "M " + anchor.x + " " + anchor.y + " L " + ex + " " + ey,
                    fill: "none", class: "sg-leader",
                });
                svg.appendChild(leader);
                const dot = svgEl("circle", { cx: String(anchor.x), cy: String(anchor.y), r: "2.2", class: "sg-leader-dot" });
                svg.appendChild(dot);
            }
        }
        // 字段:白框(透明底)+ 白字黑描边(任意背景可读)
        const bg = svgEl("rect", {
            x: String(cx - w / 2), y: String(cy - h / 2),
            width: String(w), height: String(h), rx: "2",
            class: "sg-label-bg",
        });
        svg.appendChild(bg);
        const text = svgEl("text", {
            x: String(cx), y: String(cy + h / 2 - 2),
            "text-anchor": "middle",
            class: "sg-label",
            "font-size": String(fontSize),
        });
        text.textContent = e.label;
        svg.appendChild(text);
        placed.push({ x: cx, y: cy, w, h });
    });

    container.appendChild(svg as unknown as Node);
}
