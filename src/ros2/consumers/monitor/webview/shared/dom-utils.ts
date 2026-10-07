// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file dom-utils.ts
 * webview 前端通用 DOM/工具(2026-10-03 十二轮自 ros2_webview_main.ts 拆出):
 * 诊断日志转发、容器清空、数据指纹规范化序列化、节点表格、剪贴板复制、动作反馈小字。
 */

// ==================================================================
// 数据指纹/剪贴板/动作反馈等 DOM 工具(日志转发已于十九轮批3 迁 context.ts;
// 本模块自此零 vscode 依赖,纯 DOM 工具层)
import { t } from "./i18n"; // 2026-10-04 i18n 期4:复制反馈文案(纯查表,仍零 vscode 依赖)
// ==================================================================

// ==================================================================
// 可折叠区块(2026-10-03 十七轮,用户裁定):节点/话题/服务/动作/参数 五大标题行尾 ▾/▸,
// 大系统下可收起不需要的区块;默认全展开,收起状态跨刷新记忆(模块级 Set,重建后恢复)
// ==================================================================
const sectionCollapsed = new Set<string>();

export interface SectionHandle {
    /** 整块根(标题行 + 内容体) */
    root: HTMLElement;
    /** h2 标题行 */
    header: HTMLElement;
    /** 内容体(收起时 display:none) */
    body: HTMLElement;
}

/**
 * 构建一个可折叠区块:标题行(标题 + ⓘ + 可选状态小字占位 + 行尾 ▾/▸ 三角)+ 内容体。
 * 三角点击只翻本地状态与 display,不触发数据重渲染;重建时按 sectionCollapsed 恢复。
 * 十九轮批3(分层微调):infoTip 字符串参数改为**图标节点**注入——通用层不再依赖
 * hover-tip 功能模块(方向倒置根除),各面板自行 buildInfoIcon 传入。
 */
export function buildCollapsibleSection(
    key: string, titleText: string, infoIcon?: HTMLElement, statusClass?: string
): SectionHandle {
    const root = document.createElement("div");
    root.className = "section-block";
    root.dataset.sectionKey = key;

    const header = document.createElement("h2");
    header.className = "section-header";
    const title = document.createElement("span");
    title.textContent = titleText;
    header.appendChild(title);
    if (infoIcon) {
        header.appendChild(infoIcon);
    }
    let status: HTMLElement | undefined;
    if (statusClass) {
        status = document.createElement("span");
        status.className = statusClass;
        header.appendChild(status);
    }

    const body = document.createElement("div");
    body.className = "section-body";

    const toggle = document.createElement("span");
    toggle.className = "section-toggle";
    const apply = () => {
        const collapsed = sectionCollapsed.has(key);
        toggle.textContent = collapsed ? "▸" : "▾";
        body.style.display = collapsed ? "none" : "";
    };
    toggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (sectionCollapsed.has(key)) { sectionCollapsed.delete(key); } else { sectionCollapsed.add(key); }
        apply();
    });
    header.appendChild(toggle);
    apply();

    root.appendChild(header);
    root.appendChild(body);
    return { root, header, body };
}

export function removeAllChildElements(e) {
    while (e.firstChild) {
        e.removeChild(e.firstChild);
    }
};

// ==================================================================
// 顺序稳定·保险二(2026-09-26):数据指纹
// 规范化序列化——对象键递归排序后拼接,数组保序:序列化结果只由"数据本身"决定,
// 与 daemon 返回顺序/子进程完成顺序/键插入顺序无关。指纹相同 ⇒ 数据相同 ⇒ 跳过重渲染。
// (指纹值本身 lastRenderFingerprint 留在消息中枢使用)
// ==================================================================
export function canonicalStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** POSIX 单引号包裹(复制命令用,与宿主执行时的引号规则一致)。
 *  十九轮批1(审计发现真 bug):此前转义串误写 `'\''`(JS 求值为三个引号),参数含 '
 *  时复制出的命令必坏——对齐 ros2-monitor.shellSingleQuote 的正确实现(replacement '\'' ) */
export function shellSingleQuoteForCopy(text: string): string {
    return "'" + text.replace(/'/g, "'\\''") + "'";
}

/** 复制到剪贴板(navigator.clipboard 优先,execCommand 兜底);完成后短暂显示"已复制"再恢复。
 *  2026-09-28 修:按钮现为纯图标(innerHTML=SVG),此前用 textContent 读写——读回空串、赋值抹掉唯一
 *  子节点 SVG,1.5s 后恢复空 ⇒ 图标化为虚有(事件驱动刷新,数据不变永不重绘)。改存/恢复 innerHTML。 */
export function copyCommandToClipboard(button: HTMLElement, text: string): void {
    const done = () => {
        const original = button.innerHTML;
        button.innerHTML = t("Copied");
        setTimeout(() => { button.innerHTML = original; }, 1500);
    };
    const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
    } else {
        fallback();
    }
}

/** 话题区动作反馈行(订阅结果行内回显;渲染重建后由 commandResult 重新写入) */
export function setActionStatus(kind: string, text: string): void {
    const selector = kind === "subscribe" ? ".topic-action-status"
        : (kind === "call" ? ".svc-action-status" : ".goal-action-status");
    const el = document.querySelector(selector);
    if (el) {
        el.textContent = text;
    }
}
