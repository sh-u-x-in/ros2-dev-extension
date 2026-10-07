// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file status-badge.ts
 * 常驻状态徽章(K 批,2026-10-07 用户设计):菜单栏"状态"入口(蓝色下划线链接质感),
 * 悬浮框逐帧解读助手心跳(pid/运行时长/连接数/忙任务/队列深度/在飞/熔断/内存)。
 * 数据路径与其他完全分隔:扩展侧心跳订阅 → helperHeartbeat 消息(无 ready 字段,
 * 主分发器按 J 批门槛无视)→ 本模块自有监听器消费、只改自己那一个 DOM 节点——
 * 不触投影帧、不进区块指纹,任何区块重绘与本徽章互不相干。
 */

import { t } from "./shared/i18n";
import { placeTipInViewport } from "./shared/hover-tip";

interface HeartbeatSample {
    pid: number;
    startTimeSec: number;
    receivedAtMs: number;
    cl: number;
    busy?: number;
    q?: number[];
    inf?: number;
    brk?: number;
    eq?: number;
    rss?: number;
}

let latest: HeartbeatSample | undefined;
let hovered = false;

function num(v: number | undefined): string {
    return (Math.round((v ?? 0) * 10) / 10).toString();
}

function fmtUp(sec: number): string {
    const total = Math.max(0, Math.floor(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}h${m}m` : (m > 0 ? `${m}m${s}s` : `${s}s`);
}

const NL = String.fromCharCode(10);   // 换行(.hover-tip 是 pre-line,正确断行)

function decode(s: HeartbeatSample): string {
    const up = fmtUp((Date.now() - s.startTimeSec * 1000) / 1000);
    return [
        t("Helper · pid {0} · up {1} · connections {2}", String(s.pid), up, String(s.cl)),
        t("Busy {0}/6 · In-flight {1} · Event queue {2}", num(s.busy), num(s.inf), num(s.eq)),
        t("Queue depths {0}", JSON.stringify(s.q ?? [])),
        t("Breaker nodes {0} · Memory {1} MB", num(s.brk), num(Math.round((s.rss ?? 0) / 102 * 10) / 10)),
    ].join(NL);
}

/** 新鲜度阈值(用户裁定:灰⇔无合法心跳):心跳 1s/帧,容 3 帧不到即视为静止 */
const STALE_MS = 3500;

/** 状态转换(蓝⇔灰 + 文案):无条件执行——心跳帧到达、新鲜度巡检都走这里,
 *  转换是自动的,不需要鼠标介入(灰⇔唯一裁决=是否有新鲜合法心跳) */
function renderState(badge: HTMLElement, tip: HTMLElement): void {
    const fresh = latest !== undefined && Date.now() - latest.receivedAtMs <= STALE_MS;
    if (!fresh) {
        badge.classList.add("offline");
        tip.textContent = t("Helper offline");
    } else {
        badge.classList.remove("offline");
        tip.textContent = decode(latest);
    }
}

/** 悬浮框整备:状态转换 + 选位(选位仅悬停中有意义,tip 隐藏时是无效功) */
function renderTip(badge: HTMLElement, tip: HTMLElement): void {
    renderState(badge, tip);
    placeTipInViewport(badge, tip, 320);
}

/** 挂载常驻状态徽章(初始化时调用一次):入口文字常驻,悬浮框逐帧解读心跳 */
export function mountStatusBadge(): void {
    const mount = document.getElementById("helper-status-badge");
    if (!mount) {
        return;
    }
    const badge = document.createElement("span");
    // hover-tip-host 必挂:悬浮框可见性=.hover-tip-host:hover .hover-tip 这条 CSS 规则,
    // placeTipInViewport 量完尺寸会把 display 重置回 CSS 默认,漏挂则悬浮框永远出不来
    badge.className = "helper-status-badge hover-tip-host offline";
    badge.textContent = t("Status");
    const tip = document.createElement("span");
    tip.className = "hover-tip";
    tip.textContent = t("Helper offline");
    badge.appendChild(tip);
    badge.addEventListener("mouseenter", () => {
        hovered = true;
        renderTip(badge, tip);
    });
    badge.addEventListener("mouseleave", () => {
        hovered = false;
        tip.style.display = "none";
    });
    mount.appendChild(badge);

    // 独立消息通道:helperHeartbeat(无 ready 字段,主分发器按 J 批门槛无视)
    window.addEventListener("message", (ev) => {
        const msg = ev.data;
        if (msg?.command !== "helperHeartbeat" || typeof msg.sample !== "object") {
            return;
        }
        latest = msg.sample as HeartbeatSample;
        renderState(badge, tip);                  // 蓝⇔灰自动转换(不依赖悬停)
        if (hovered) {
            placeTipInViewport(badge, tip, 320);  // 悬停中:每帧重选位
        }
    });

    // 新鲜度巡检:心跳静默(停止/崩溃/断网)超阈值 → 自动转灰(不依赖悬停)
    window.setInterval(() => {
        renderState(badge, tip);
        if (hovered) {
            placeTipInViewport(badge, tip, 320);
        }
    }, 500);
}
