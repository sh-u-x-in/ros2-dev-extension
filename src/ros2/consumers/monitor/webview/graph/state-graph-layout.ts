/**
 * @file state-graph-layout.ts
 * 生命周期状态图 · 布局与几何域(2026-10-03 十二轮自 state-graph.ts 拆出):
 * dagre 布局引擎(节点坐标/边路由)、边路径生成与末端裁剪、渲染曲线采样与弧长参数化、
 * 锚点顺序打点规划、label 文字宽度测量(canvas + Node 回退档位)。
 * 纯计算域,不建 DOM(测宽探测 canvas 除外);渲染编排留在 state-graph.ts。
 */

import * as dagre from "dagre";

/* ================================================================== */
/* 布局常量                                                           */
/* ================================================================== */

export const NODE_W = 110;      // 节点盒宽
export const NODE_H = 44;       // 节点盒高
export const MARKER_ID = "sg-arrow";

/* ================================================================== */
/* 锚点规划常量(2026-08-26⑨:顺序打点)                                 */
/* ================================================================== */
/** 锚点弧长占比窗口(0=源端,1=接收端):50% ±20%;太靠近节点字段放不下/难辨认 */
const ANCHOR_S_MIN = 0.30;
const ANCHOR_S_MAX = 0.70;
const ANCHOR_S_STEP = 0.01;   // 候选扫描步长([0.30,0.70] 共 41 个候选)
const ANCHOR_D_MIN = 14;      // 锚点最小两两间距 px(圆点 r=2.2 + 引线可读间隙)

/** 图边模型(由 state-graph.ts buildGraphView 组装) */
export interface GraphEdge {
    from: string;
    to: string;
    label: string;
    available: boolean;
    /** 框架内部错误边(transition_success/failure/error;仅完整视图显示,不可交互) */
    error?: boolean;
}

/** dagre 算好的边路由点(带坐标),渲染层按其连平滑曲线 */
export interface LaidEdge extends GraphEdge {
    points: { x: number; y: number }[];
}

/**
 * 用 dagre 布局:节点/边注册到 dagre 图 → layout() 计算坐标与边路由(points)。
 * 关键:边路由用 dagre 的 edge.points(已避免重叠/交叉),而非自起点到终点画大曲线。
 */
export function computeLayoutWithDagre(
    states: string[], currentState: string | null, transitions: GraphEdge[]
): { nodes: Map<string, { x: number; y: number }>; edges: LaidEdge[]; W: number; H: number; ox: number; oy: number } {
    // multigraph(2026-08-26⑤):同起终点多重边(如 shuttingdown→finalized 的 success/failure)
    // 用唯一 name 键独立布线,不再相互覆盖。
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90, marginx: 10, marginy: 10 });
    g.setDefaultEdgeLabel(() => ({}));
    states.forEach((s) => g.setNode(s, { width: NODE_W, height: NODE_H }));
    // 2026-08-26⑤:同起终点多重边(如 shuttingdown→finalized 的 success/failure)默认被覆盖成一条;
    // 用唯一 name 键注册,每条边独立布线,字段/引线各归其边。
    transitions.forEach((e, idx) => g.setEdge(e.from, e.to, { label: e.label }, "e" + idx));
    dagre.layout(g);

    const pos = new Map<string, { x: number; y: number }>();
    g.nodes().forEach((id) => {
        const n = g.node(id);
        pos.set(id, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 });
    });
    const laidEdges: LaidEdge[] = transitions.map((e, idx) => {
        const ep = g.edge({ v: e.from, w: e.to, name: "e" + idx }) as { points?: { x: number; y: number }[] };
        // dagre 给的 points 在原布局坐标;无 points 则退回两端点
        const pts = (ep.points && ep.points.length ? ep.points : [
            { x: (pos.get(e.from)?.x || 0) + NODE_W, y: (pos.get(e.from)?.y || 0) + NODE_H / 2 },
            { x: pos.get(e.to)?.x || 0, y: (pos.get(e.to)?.y || 0) + NODE_H / 2 },
        ]);
        return { ...e, points: pts };
    });
    // 真实包围盒:节点 + 边路由点(超出 dagre graph 尺寸的部分,如跨层 label/折线)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pos.forEach((p) => {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    });
    laidEdges.forEach((e) => e.points.forEach((pt) => {
        minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
    }));
    const PAD = 40;
    const W = (maxX - minX) + PAD * 2;
    const H = (maxY - minY) + PAD * 2;
    const ox = -minX + PAD;   // 平移:把内容移入正坐标区
    const oy = -minY + PAD;
    return { nodes: pos, edges: laidEdges, W, H, ox, oy };
}

/**
 * 边路由:平滑曲线连接 dagre 的路由点(points)。
 * 相邻点之间用"中点弯曲"的贝塞尔,避免直角转折;首末段水平衔接节点。
 */
export function makeEdgePath(points: { x: number; y: number }[]): string {
    if (points.length < 2) return "";
    if (points.length === 2) {
        const [a, b] = points;
        // 水平直线(同层节点,无路由点)
        return "M " + a.x + " " + a.y + " L " + b.x + " " + b.y;
    }
    // 多段:中点贝塞尔平滑(每段用相邻中点做控制点)
    let d = "M " + points[0].x + " " + points[0].y;
    for (let i = 1; i < points.length - 1; i++) {
        const p = points[i], next = points[i + 1];
        const mx = (p.x + next.x) / 2, my = (p.y + next.y) / 2;
        d += " Q " + p.x + " " + p.y + " " + mx + " " + my;
    }
    const last = points[points.length - 1];
    d += " L " + last.x + " " + last.y;
    return d;
}

/** 2026-08-26⑭:沿末段把路径缩短 trimLen px(= 箭头基部位置;refX=0 箭头自基部向前伸展,
 * 线到箭头为止、不会露出箭头之外);末段过短则直接去掉末点。 */
export function trimPathEnd(pts: { x: number; y: number }[], trimLen: number): { x: number; y: number }[] {
    const out = pts.slice();
    if (out.length >= 2) {
        const la = out[out.length - 2], lb = out[out.length - 1];
        const seg = Math.hypot(lb.x - la.x, lb.y - la.y);
        if (seg > 0.5) {
            const k = (seg - Math.min(trimLen, seg * 0.8)) / seg;
            out[out.length - 1] = { x: la.x + (lb.x - la.x) * k, y: la.y + (lb.y - la.y) * k };
        } else {
            out.pop();
        }
    }
    return out;
}

/* ================================================================== */
/* 锚点规划(2026-08-26⑨ 用户定稿:顺序打点)                             */
/* 背景:锚点=经过点索引中点 q[floor(n/2)](⑥)对高扇入节点系统性偏向      */
/* 接收端(25 边图实测弧长占比 70~91%)且沿共用走廊聚团;顺序打点按"短路径  */
/* 先占位 + 沿曲线远离最近锚点"全局规划;圆点仍严格落在渲染曲线上(不变式)。*/
/* ================================================================== */

/** 渲染曲线(Q 贝塞尔 + 末段直线)采样为折线,供弧长参数化(每 Q 段 12 采样) */
function sampleRenderedCurve(pts: { x: number; y: number }[]): { x: number; y: number }[] {
    const n = pts.length;
    if (n < 3) return pts.slice();
    // 曲线经过点:q[0]=p0, q[i]=mid(p_i,p_{i+1}) (i=1..n-2), q[n-1]=p_{n-1};
    // Q 段 i 从 q[i-1] 到 q[i]、控制点 p_i;末段 q[n-2]→q[n-1] 为直线。
    const out: { x: number; y: number }[] = [pts[0]];
    for (let i = 1; i <= n - 2; i++) {
        const from = out[out.length - 1];
        const ctrl = pts[i];
        const to = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
        for (let t = 1; t <= 12; t++) {
            const k = t / 12, u = 1 - k;
            out.push({ x: u * u * from.x + 2 * u * k * ctrl.x + k * k * to.x, y: u * u * from.y + 2 * u * k * ctrl.y + k * k * to.y });
        }
    }
    out.push(pts[n - 1]);
    return out;
}

/** 弧长查找表:采样点 + 累积长度;按占比 s(0=源端,1=接收端)取曲线点 */
interface CurveLUT { pts: { x: number; y: number }[]; cum: number[]; total: number; }
function buildCurveLUT(pts: { x: number; y: number }[]): CurveLUT {
    const sp = sampleRenderedCurve(pts);
    const cum: number[] = [0];
    for (let i = 1; i < sp.length; i++) cum.push(cum[i - 1] + Math.hypot(sp[i].x - sp[i - 1].x, sp[i].y - sp[i - 1].y));
    return { pts: sp, cum, total: cum[cum.length - 1] };
}
function curvePointAt(lut: CurveLUT, s: number): { x: number; y: number } {
    const target = Math.max(0, Math.min(1, s)) * lut.total;
    for (let i = 1; i < lut.cum.length; i++) {
        if (lut.cum[i] >= target) {
            const seg = lut.cum[i] - lut.cum[i - 1];
            const t = seg > 0 ? (target - lut.cum[i - 1]) / seg : 0;
            return { x: lut.pts[i - 1].x + (lut.pts[i].x - lut.pts[i - 1].x) * t, y: lut.pts[i - 1].y + (lut.pts[i].y - lut.pts[i - 1].y) * t };
        }
    }
    const last = lut.pts[lut.pts.length - 1];
    return { x: last.x, y: last.y };
}

/**
 * 顺序打点(2026-08-26⑨):
 *  1) 每条边弧长参数化,按"曲线总长升序"处理——短路径可调范围小,先占位;
 *  2) 每条边在 s∈[0.30,0.70] 扫描候选(步长 0.01),取"与已放锚点最小距离最大"者
 *     (并列取最贴近 0.5)——即"按最近锚点走远离方向"的全局形式,不卡局部最优;
 *  3) 软失败(全候选均 <D_min,如并行窄走廊):仍停在最大净空处;不做二次松弛。
 */
export function planAnchors(edges: LaidEdge[], ox: number, oy: number): { x: number; y: number }[] {
    const luts = edges.map((e) => buildCurveLUT(e.points.map((p) => ({ x: p.x + ox, y: p.y + oy }))));
    const order = luts.map((l, i) => ({ i, total: l.total }))
        .sort((a, b) => a.total - b.total || a.i - b.i);
    const placed: { x: number; y: number }[] = [];
    const anchors: { x: number; y: number }[] = new Array(edges.length);
    const N = Math.round((ANCHOR_S_MAX - ANCHOR_S_MIN) / ANCHOR_S_STEP);
    for (const { i } of order) {
        const lut = luts[i];
        let bestS = 0.5, bestZ = -1;
        for (let k = 0; k <= N; k++) {
            const s = ANCHOR_S_MIN + k * ANCHOR_S_STEP;
            const p = curvePointAt(lut, s);
            let z = Infinity;
            for (const q of placed) z = Math.min(z, Math.hypot(p.x - q.x, p.y - q.y));
            if (z > bestZ + 1e-9 || (Math.abs(z - bestZ) <= 1e-9 && Math.abs(s - 0.5) < Math.abs(bestS - 0.5))) {
                bestZ = z; bestS = s;
            }
        }
        const anchor = curvePointAt(lut, bestS);
        anchors[i] = anchor;
        placed.push(anchor);
    }
    return anchors;
}

/* ================================================================== */
/* label 宽度测量(2026-08-26⑩)                                        */
/* 浏览器:canvas measureText 整串精确测量(含 kerning,按 label+字号缓存); */
/* Node/DOM stub(渲染脚本):字符宽度档位回退(em 占比 × fontSize)。        */
/* 前提:.sg-label 已钉死字体栈(state-graph.ts 内联 SVG <style>),测量与渲染同一字体。              */
/* ================================================================== */
/** label 字体栈(与 .sg-label CSS 的 var(--vscode-font-family, ...) 回退一致) */
const LABEL_FONT_STACK = '"Segoe UI", "DejaVu Sans", sans-serif';
const labelWidthCache = new Map<string, number>();
let labelMeasureCtx: CanvasRenderingContext2D | null | undefined;  // undefined=未探测

/** label 文本宽度(不含内边距;调用方加 4px=左右各 2) */
export function measureLabelWidth(label: string, fontSize: number): number {
    if (labelMeasureCtx === undefined) {
        try {
            const el = document.createElement("canvas") as HTMLCanvasElement;
            labelMeasureCtx = typeof el.getContext === "function" ? el.getContext("2d") : null;
        } catch { labelMeasureCtx = null; }
    }
    if (labelMeasureCtx) {
        const key = label + "@" + fontSize;
        const hit = labelWidthCache.get(key);
        if (hit !== undefined) return hit;
        labelMeasureCtx.font = fontSize + "px " + LABEL_FONT_STACK;
        const w = labelMeasureCtx.measureText(label).width;
        labelWidthCache.set(key, w);
        return w;
    }
    // 回退:字符宽度档位(em 占比 × fontSize;窄 i/l/j/f/r/数字/标点,宽 m/w/@ 等,CJK 全宽 1em)
    let w = 0;
    for (const ch of label) {
        const c = ch.charCodeAt(0);
        if (c > 0x2e80) w += fontSize;                                        // CJK 全宽
        else if (c === 0x20) w += 0.3 * fontSize;                             // 空格
        else if ('ijlfrIJLFT1.,:;!|"()[]-'.indexOf(ch) >= 0) w += 0.32 * fontSize;   // 窄
        else if ("mwMW@%&".indexOf(ch) >= 0) w += 0.78 * fontSize;            // 宽
        else w += 0.52 * fontSize;                                            // 常规
    }
    return w;
}
