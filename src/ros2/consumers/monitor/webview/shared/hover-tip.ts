// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file hover-tip.ts
 * 即时悬浮提示(2026-10-03 十二轮自 ros2_webview_main.ts 拆出):
 * placeTipInViewport(瞬时选位/自适应宽)+ attachHoverTip(动作按钮零延迟悬浮)+
 * buildInfoIcon(ⓘ 区块标注)。七~十轮迭代史见 placeTipInViewport 注释。
 */

/** 悬浮框瞬时选位(2026-10-03 七轮立,八轮两向冗余收口,九轮按内容收窄,均用户裁定):
 *  死的固定宽在贴右缘/偏右图标处必出界,溢出量=框自身左缘偏移(固定偏移差)——悬停瞬间
 *  按当时页面宽现算:向右铺得下就右铺,否则向空间大的一侧铺,maxWidth=所选侧空间
 *  (呼吸边 10px/下限 80px),边框恒在页面内;九轮:实测不折行自然宽,want=min(自然宽,
 *  期望宽)——短于一行按内容收窄消除右侧空白,长于一行才封到期望宽折行;测量以临时
 *  display:block+pre 读精确框宽(十轮:getBoundingClientRect 取小数,offsetWidth 取整
 *  差亚像素会挤落末字),两套 tip 均 border-box */
export function placeTipInViewport(host: HTMLElement, tipEl: HTMLElement, desired: number): void {
    tipEl.style.display = "block";
    tipEl.style.whiteSpace = "pre";
    tipEl.style.width = "auto";
    tipEl.style.maxWidth = "none";
    // 十轮:必须 getBoundingClientRect(带小数)。offsetWidth 取整会差亚像素——按取整值写宽,
    // 内容差零点几px放不下,末字被挤下折行(用户截图"行)"孤行即此因);+2px 冗余双保险
    const natural = tipEl.getBoundingClientRect().width;   // 不折行整框宽(border-box 含内边距),多行提示=最长行
    tipEl.style.display = "";
    tipEl.style.whiteSpace = "";
    tipEl.style.width = "";
    tipEl.style.maxWidth = "";
    const want = Math.min(Math.ceil(natural) + 2, desired);
    const vw = document.documentElement.clientWidth;
    const rect = host.getBoundingClientRect();
    const MARGIN = 10;           // 距页面边缘呼吸边(用户裁定:再多一点点)
    const MINW = 80;             // 极窄面板下限兜底
    const toRight = Math.max(vw - rect.left - MARGIN, MINW);
    const toLeft = Math.max(rect.right - MARGIN, MINW);
    if (toRight >= want || toRight >= toLeft) {
        tipEl.style.left = "0px";    // 向右铺:锚图标左缘(默认形态)
        tipEl.style.right = "auto";
        tipEl.style.maxWidth = `${toRight}px`;
    } else {
        tipEl.style.left = "auto";   // 向左铺:锚图标右缘
        tipEl.style.right = "0px";
        tipEl.style.maxWidth = `${toLeft}px`;
    }
    tipEl.style.width = `${want}px`; // 短提示按内容收窄(九轮);maxWidth 兜底折行
    // 终检钳制(K 批补丁 4,2026-10-07):**解析式,不量落点**——上一版量 getBoundingClientRect
    // 会把上次的 translateX 算进去,0.5px 阈值+500ms 巡检=检出/回退交替的周期性摆动
    // (用户 F5 实测"边框有滚动条+周期性摆动")。最终位置解析可算:锚边 ± want,
    // 对可用视口(clientWidth 已扣纵向滚动条)钳制,无反馈回路,落下去就不动;
    // 且钳制用 translateX 视觉校正,不产生布局出界——横向滚动条随之消失。
    const hostRect = host.getBoundingClientRect();
    const leftAnchored = tipEl.style.left === "auto";   // 左铺:右缘锚 host 右,向左伸
    const finalL = leftAnchored ? hostRect.right - want : hostRect.left;
    let shift = 0;
    if (finalL + want > vw - MARGIN) {
        shift = (vw - MARGIN) - (finalL + want);
    } else if (finalL < MARGIN) {
        shift = MARGIN - finalL;
    }
    tipEl.style.transform = shift !== 0 ? `translateX(${shift}px)` : "";
}

/** 即时悬浮提示(2026-09-29):与 ⓘ 同视觉;原生 title 有系统级延迟,动作类按钮/徽标统一走此机制 */
export function attachHoverTip(el: HTMLElement, tip: string): void {
    el.dataset.tipBound = "1";
    el.classList.add("hover-tip-host");
    const tipEl = document.createElement("span");
    tipEl.className = "hover-tip";
    tipEl.textContent = tip;
    el.appendChild(tipEl);
    el.addEventListener("mouseenter", () => placeTipInViewport(el, tipEl, 300));
}

/** ⓘ 悬浮标注(2026-09-24:替代原"使用说明"折叠块,说明悬浮在对应区块旁);420 期望宽与 CSS 同源 */
export function buildInfoIcon(tip: string): HTMLElement {
    const icon = document.createElement("span");
    icon.dataset.tipBound = "1";
    icon.className = "info-icon";
    icon.textContent = "ⓘ";
    const tipEl = document.createElement("span");
    tipEl.className = "info-tip";
    tipEl.textContent = tip;
    icon.appendChild(tipEl);
    icon.addEventListener("mouseenter", () => placeTipInViewport(icon, tipEl, 420));
    return icon;
}

/** 静态 HTML 里的 ⓘ 接入选位逻辑(I 批,2026-10-07):页面模板直书的 ⓘ(助手按钮旁/
 *  系统信息标题旁)只有 CSS :hover 显隐——固定 420px 从图标左缘起铺,面板窄时直接顶出
 *  边界,从未接过 placeTipInViewport 的边界自适应(区块内 ⓘ 是 buildInfoIcon 产物才有)。
 *  此处给无主图标挂上同款 mouseenter;buildInfoIcon 产物带 tipBound 标记自动跳过。 */
export function hydrateStaticInfoIcons(): void {
    document.querySelectorAll<HTMLElement>(".info-icon").forEach((icon) => {
        if (icon.dataset.tipBound === "1") {
            return;
        }
        const tip = icon.querySelector<HTMLElement>(".info-tip");
        if (!tip) {
            return;
        }
        icon.dataset.tipBound = "1";
        icon.addEventListener("mouseenter", () => placeTipInViewport(icon, tip, 420));
    });
}
