// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file form-render.ts
 * 服务调用/动作发送表单 · 渲染层(2026-10-03 十二轮自 ros2_webview_main.ts 拆出):
 * 组头折叠方块、局部一键展开/收起、消息组/消息数组/基本数组/标量行的 DOM 构建。
 * 行尾簇顺序(十三轮重排后)= 计数 → 一键展开 → 一键收起。
 */

import { l10n } from "vscode";

import { t } from "../shared/i18n";

import { ICON_COLLAPSE, ICON_EXPAND } from "../shared/icons";
import { attachHoverTip } from "../shared/hover-tip";
import {
    collectCollapsiblePaths, countBasicRows, FormArrayContext, FormNode, ServiceFormState,
    initFormNode, isBoolType, isIntType, isNumericType, isStringType,
} from "./form-model";
import { appendTypeDim, attachFormInputKeys, autoGrowTextarea } from "./form-fields";

/** 复合组头名字旁的基本行计数(2026-10-03 十三轮,用户裁定):括号 (N),与名字两空格间距 */
function headCountSpan(n: FormNode): HTMLElement {
    const span = document.createElement("span");
    span.className = "form-head-count";
    span.textContent = `(${countBasicRows([n])})`;
    return span;
}

    /** 局部一键展开/收起(2026-09-30 五轮二):作用于本组及全部子孙层级(组头行尾区);
     *  selfPath(2026-10-03 十三轮补充三):宿主自身路径一并纳入——元素收起态点 ⊕ 也能
     *  立即展开自身+内部(旧版只清内部路径,元素自身仍在 collapsed 集合 → 毫无反应) */
    function localExpandCollapseButtons(
        state: ServiceFormState, rerender: () => void, nodes: FormNode[], prefix: string, selfPath?: string
    ): HTMLElement[] {
        const mk = (icon: string, tip: string, collapse: boolean): HTMLElement => {
            const b = document.createElement("span");
            b.className = "form-key-btn form-key-neutral";
            b.innerHTML = icon;
            attachHoverTip(b, tip);
            b.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const out: string[] = selfPath ? [selfPath] : [];
                collectCollapsiblePaths(nodes, prefix, out);
                out.forEach((p) => { if (collapse) { state.collapsed.add(p); } else { state.collapsed.delete(p); } });
                rerender();
            });
            return b;
        };
        return [
            mk(ICON_EXPAND, t("Expand subtree: expand all levels inside this group"), false),
            mk(ICON_COLLAPSE, t("Collapse subtree: collapse this group and everything inside it"), true),
        ];
    }

/** 折叠方块(2026-09-30 四轮,用户裁定):蓝色方块包三角做强调,触发区仅此方块 ——
 *  整条组头点击易误触(展开某字段误点折叠)。方块独立监听,header 其余区域纯展示。 */
function groupToggle(state: ServiceFormState, path: string, collapsed: boolean, rerender: () => void): HTMLElement {
    const toggle = document.createElement("span");
    toggle.className = "form-group-toggle";
    toggle.textContent = collapsed ? "▸" : "▾";
    toggle.title = collapsed ? t("Expand this group") : t("Collapse this group");
    toggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (state.collapsed.has(path)) { state.collapsed.delete(path); } else { state.collapsed.add(path); }
        rerender();
    });
    return toggle;
}

export function renderFormFields(container: HTMLElement, nodes: FormNode[], rerender: () => void, prefix: string, arrCtx: FormArrayContext | undefined, state: ServiceFormState): void {
    for (const n of nodes) {
        container.appendChild(buildFormEntry(n, rerender, prefix, arrCtx, state));
    }
}

function buildFormEntry(n: FormNode, rerender: () => void, prefix: string, arrCtx: FormArrayContext | undefined, state: ServiceFormState): HTMLElement {
    const ownPath = prefix ? `${prefix}.${n.def.name}` : n.def.name;
    const def = n.def;
    if (def.kind === "message_unresolved" || def.kind === "message_array_unresolved") {
        const row = document.createElement("div");
        row.className = "form-error-row";
        row.textContent = t("{0} ({1}): failed to parse the field structure{2}", def.name, def.type, def.error ? " — " + def.error : "");
        return row;
    }
    if (def.kind === "primitive") { return buildPrimitiveRow(n, rerender, ownPath, arrCtx, state); }
    if (def.kind === "array") { return buildArrayEntry(n, rerender, ownPath, state); }
    if (def.kind === "message") {
        // 2026-09-29 批次 C:组头可折叠(用户裁定:复杂类型全展开眼花缭乱)
        const collapsed = state.collapsed.has(ownPath);
        const group = document.createElement("div");
        group.className = "form-group";
        const header = document.createElement("div");
        header.className = "form-group-header";
        header.textContent = def.name;
        header.insertBefore(groupToggle(state, ownPath, collapsed, rerender), header.firstChild);
        // 名字旁基本行计数(2026-10-03 十三轮,用户裁定)
        header.appendChild(headCountSpan(n));
        // 行尾簇:类型 → 一键展开 → 一键收起(2026-09-30 五轮二;行序=十三轮裁定)
        const headerEnd = document.createElement("span");
        headerEnd.className = "form-header-end";
        appendTypeDim(headerEnd, def.type);
        const locals = localExpandCollapseButtons(state, rerender, [n], prefix);
        locals.forEach((b) => headerEnd.appendChild(b));
        header.appendChild(headerEnd);
        group.appendChild(header);
        if (collapsed) { return group; }
        const kids = document.createElement("div");
        kids.className = "form-group-children";
        renderFormFields(kids, n.children ?? [], rerender, ownPath, arrCtx, state);
        group.appendChild(kids);
        return group;
    }
    // message_array:元素组 + [+ 添加元素](有界封顶)/ [×] 移除;元素内字段带数组上下文(键盘语义)
    // 2026-09-29 批次 C:组头可折叠(有元素时),折叠态显示元素计数
    n.elements = n.elements ?? [];
    // 2026-09-30 五轮二:折叠方块/计数恒显示(不再随元素数出现/消失,消除增删时的跳动)
    const arrCollapsed = state.collapsed.has(ownPath);
    const group = document.createElement("div");
    group.className = "form-group";
        const header = document.createElement("div");
        header.className = "form-group-header";
        header.textContent = def.name;
        header.insertBefore(groupToggle(state, ownPath, arrCollapsed, rerender), header.firstChild);
        // 行头:名字旁基本行计数 + A(2026-10-03 十三轮,用户裁定:添加高频,名字旁顺手)
        header.appendChild(headCountSpan(n));
        if (!(typeof def.max === "number" && n.elements.length >= def.max)) {
            const addBtn = document.createElement("span");
            addBtn.className = "form-key-btn form-key-add";
            addBtn.textContent = "A";
            addBtn.title = t("Add element: append using the field template (Shift+Enter inside an element field also works)");
            addBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                n.elements!.push((def.template ?? []).map(initFormNode));
                // 新建元素内部组默认全收起(2026-09-30 五轮,用户裁定;复杂结构不递归展开)
                const newIdx = n.elements!.length - 1;
                const inner: string[] = [];
                collectCollapsiblePaths(n.elements![newIdx], `${ownPath}[${newIdx}]`, inner);
                inner.forEach((p) => state.collapsed.add(p));
                // 十三轮补充(用户裁定):数组收起时创建只见计数跳变——自动展开数组并保证新条目
                // 自身不收起,让"创建"直观可见;元素内部组仍保持全收起
                state.collapsed.delete(ownPath);
                state.collapsed.delete(`${ownPath}[${newIdx}]`);
                rerender();
            });
            header.appendChild(addBtn);
        }
        // 行尾簇:类型 → 元素个数 → 一键展开 → 一键收起(十三轮行序)
        const headerEnd = document.createElement("span");
        headerEnd.className = "form-header-end";
        appendTypeDim(headerEnd, `${def.type}[]`);
        const cnt = document.createElement("span");
        cnt.className = "form-group-count";
        cnt.textContent = t("{0} items", n.elements.length);
        headerEnd.appendChild(cnt);
        const locals = localExpandCollapseButtons(state, rerender, [n], prefix);
        locals.forEach((b) => headerEnd.appendChild(b));
        header.appendChild(headerEnd);
    group.appendChild(header);
    if (arrCollapsed) { return group; }
    const list = document.createElement("div");
    list.className = "form-group-children";
    n.elements.forEach((el, i) => {
        const elPath = `${ownPath}[${i}]`;
        const elCollapsed = state.collapsed.has(elPath);
        const wrap = document.createElement("div");
        wrap.className = "form-element";
        const elHead = document.createElement("div");
        elHead.className = "form-element-header";
        // 行头(2026-10-03 十三轮补充四,用户裁定):方框 → 序号 → (N)基本行计数(与下标一空格)
        // → 删除;行尾一键展开/收起
        const elToggle = groupToggle(state, elPath, elCollapsed, rerender);
        elHead.appendChild(elToggle);
        const idxText = document.createElement("span");
        idxText.textContent = `[${i}]`;
        elHead.appendChild(idxText);
        const elCount = document.createElement("span");
        elCount.className = "form-head-count";
        elCount.style.marginLeft = "6px";   // 与下标一空格间距(组头 (N) 为两空格 12px)
        elCount.textContent = `(${countBasicRows(el)})`;
        elHead.appendChild(elCount);
        const rm = document.createElement("span");
        rm.className = "form-key-btn form-key-del";
        rm.textContent = "D";
        rm.title = t("Delete this element");
        rm.addEventListener("click", (ev) => {
            ev.stopPropagation();
            n.elements!.splice(i, 1);
            rerender();
        });
        elHead.appendChild(rm);
        // 元素宿主的一键展开/收起(十三轮补充三):selfPath=elPath——收起态点击也立即生效;
        // 包一层 form-header-end(十三轮补充四):与数组头行尾簇同 gap/右推,上下两列图标对齐
        const elEnd = document.createElement("span");
        elEnd.className = "form-header-end";
        const elLocals = localExpandCollapseButtons(state, rerender, el, elPath, elPath);
        elLocals.forEach((b) => elEnd.appendChild(b));
        elHead.appendChild(elEnd);
        wrap.appendChild(elHead);
        // 元素间贯穿分隔线(2026-09-29 二修):必须在收起 early-return 之前——收起元素也要画线,
        // 否则相邻收起元素之间边界消失(十三轮补充三,用户裁定:恒显示)
        if (i > 0) {
            const sep = document.createElement("div");
            sep.className = "form-element-sep";
            list.appendChild(sep);
        }
        list.appendChild(wrap);
        if (elCollapsed) {
            return; // 收起:内部字段/子组全部不渲染,数据零丢失
        }
        const kids = document.createElement("div");
        kids.className = "form-group-children";
        renderFormFields(kids, el, rerender, `${ownPath}[${i}]`, { arrayNode: n, kind: "element", index: i, arrPath: ownPath }, state);
        wrap.appendChild(kids);
    });
    group.appendChild(list);
    return group;
}

function buildPrimitiveRow(n: FormNode, rerender: () => void, fpath: string, arrCtx: FormArrayContext | undefined, state: ServiceFormState): HTMLElement {
    const def = n.def;
    const row = document.createElement("div");
    row.className = "form-row";
    const label = document.createElement("span");
    label.className = "form-label";
    label.textContent = def.name;
    row.appendChild(label);
    const input = document.createElement("input");
    input.className = "form-input";
    input.dataset.fpath = fpath;
    if (isBoolType(def.type)) {
        // 2026-09-28 二修(用户裁定):对外仍是框选 checkbox(鼠标点击=取反);键盘同质化——
        // 聚焦后 Backspace/Delete 勾选→取消成假,已取消再按→跳下一输入(语义见 attachFormInputKeys)
        input.type = "checkbox";
        input.checked = n.value === true;
        input.addEventListener("change", () => { n.value = input.checked; });
        attachFormInputKeys(input, rerender, arrCtx, true, false, state);
    } else if (isStringType(def.type)) {
        // 2026-09-29(用户裁定):字符串字段 = 多行 textarea —— Enter 输入真实换行(不再跳下一
        // 元素);Shift+Enter 建元素/退格空删/方向键流转照旧;跳字段用 Tab 或方向键
        const ta = document.createElement("textarea");
        ta.className = "form-input form-input-text";
        ta.rows = 1;
        ta.dataset.fpath = fpath;
        ta.value = String(n.value ?? "");
        ta.addEventListener("input", () => { n.value = ta.value; autoGrowTextarea(ta); });
        attachFormInputKeys(ta, rerender, arrCtx, false, true, state);
        autoGrowTextarea(ta);
        row.appendChild(ta);
        // 类型标识行尾(2026-10-03 十三轮,十五轮起右推到行缘)
        appendTypeDim(row, def.type + (def.bound ? `<=${def.bound}` : ""), true);
        return row;
    } else {
        // 输入阶段不设防(2026-09-27):统一 text + inputMode 软提示,校验只在调用/复制时
        input.type = "text";
        if (isNumericType(def.type)) { input.inputMode = isIntType(def.type) ? "numeric" : "decimal"; }
        input.value = String(n.value ?? "");
        input.addEventListener("input", () => { n.value = input.value; });
        attachFormInputKeys(input, rerender, arrCtx, false, false, state);
    }
    row.appendChild(input);
    // 类型标识行尾(2026-10-03 十三轮):名字 → 输入框 → 类型;十五轮右推到行缘
    appendTypeDim(row, def.type + (def.bound ? `<=${def.bound}` : ""), true);
    return row;
}

function buildArrayEntry(n: FormNode, rerender: () => void, fpath: string, state: ServiceFormState): HTMLElement {
    const def = n.def;
    n.items = n.items ?? [];
    // 2026-09-30 五轮二:折叠方块/计数恒显示(不随元素数出现消失,消除增删跳动)
    const arrCollapsed = state.collapsed.has(fpath);
    const wrap = document.createElement("div");
    wrap.className = "form-group";
        const header = document.createElement("div");
        header.className = "form-group-header";
        header.textContent = def.name;
        header.insertBefore(groupToggle(state, fpath, arrCollapsed, rerender), header.firstChild);
        // 行头:名字旁基本行计数 + A(2026-10-03 十三轮,用户裁定:添加高频,名字旁顺手)
        header.appendChild(headCountSpan(n));
        if (typeof def.fixed !== "number"
            && !(typeof def.max === "number" && (n.items?.length ?? 0) >= def.max)) {
            const add = document.createElement("span");
            add.className = "form-key-btn form-key-add";
            add.textContent = "A";
            add.title = t("Add element (or press Shift+Enter in a field to create one)");
            add.addEventListener("click", (ev) => {
                ev.stopPropagation();
                n.items?.push(isBoolType(def.type) ? false : "");
                // 十三轮补充(用户裁定):数组收起时创建不可见 → 自动展开露出新行
                state.collapsed.delete(fpath);
                rerender();
            });
            header.appendChild(add);
        }
        // 行尾簇:类型 → 元素个数(固定并入计数,四轮)→ 一键展开 → 一键收起(十三轮行序)
        const headerEnd = document.createElement("span");
        headerEnd.className = "form-header-end";
        appendTypeDim(headerEnd, `${def.type}[]${typeof def.max === "number" ? ` ≤${def.max}` : ""}`);
        const cnt = document.createElement("span");
        cnt.className = "form-group-count";
        cnt.textContent = typeof def.fixed === "number" ? t("{0} fixed items", def.fixed) : t("{0} items", n.items.length);
        headerEnd.appendChild(cnt);
        // 局部展开/收起(收起 = 隐藏元素行,数据保留;与消息数组口径一致)
        const exp = document.createElement("span");
        exp.className = "form-key-btn form-key-neutral";
        exp.innerHTML = ICON_EXPAND;
        attachHoverTip(exp, t("Expand locally: show all element rows in this array"));
        exp.addEventListener("click", (ev) => {
            ev.stopPropagation();
            state.collapsed.delete(fpath);
            rerender();
        });
        headerEnd.appendChild(exp);
        const col = document.createElement("span");
        col.className = "form-key-btn form-key-neutral";
        col.innerHTML = ICON_COLLAPSE;
        attachHoverTip(col, t("Collapse locally: hide all element rows in this array"));
        col.addEventListener("click", (ev) => {
            ev.stopPropagation();
            state.collapsed.add(fpath);
            rerender();
        });
        headerEnd.appendChild(col);
        header.appendChild(headerEnd);
    wrap.appendChild(header);
    if (arrCollapsed) { return wrap; }
    n.items.forEach((val, i) => {
        const row = document.createElement("div");
        row.className = "form-row";
        const idx = document.createElement("span");
        idx.className = "form-ftype";
        idx.textContent = `[${i}]`;
        row.appendChild(idx);
        const input = document.createElement("input");
        input.className = "form-input";
        input.dataset.fpath = `${fpath}[${i}]`;
        let field: HTMLInputElement | HTMLTextAreaElement = input;
        if (isBoolType(def.type)) {
            // 2026-09-28 二修:仍是框选 checkbox(鼠标取反)+ 键盘同质化(语义同 buildPrimitiveRow)
            input.type = "checkbox";
            input.checked = val === true;
            input.addEventListener("change", () => { if (n.items) { n.items[i] = input.checked; } });
            attachFormInputKeys(input, rerender, { arrayNode: n, kind: "item", index: i, arrPath: fpath, fixed: typeof def.fixed === "number" }, true, false, state);
        } else if (isStringType(def.type)) {
            // 2026-09-29:字符串项 = 多行 textarea(Enter 换行,语义同 buildPrimitiveRow)
            const ta = document.createElement("textarea");
            ta.className = "form-input form-input-text";
            ta.rows = 1;
            ta.dataset.fpath = `${fpath}[${i}]`;
            ta.value = String(val ?? "");
            ta.addEventListener("input", () => { if (n.items) { n.items[i] = ta.value; } autoGrowTextarea(ta); });
            attachFormInputKeys(ta, rerender, { arrayNode: n, kind: "item", index: i, arrPath: fpath, fixed: typeof def.fixed === "number" }, false, true, state);
            autoGrowTextarea(ta);
            field = ta;
        } else {
            input.type = "text";
            if (isNumericType(def.type)) { input.inputMode = isIntType(def.type) ? "numeric" : "decimal"; }
            input.value = String(val ?? "");
            input.addEventListener("input", () => { if (n.items) { n.items[i] = input.value; } });
            attachFormInputKeys(input, rerender, { arrayNode: n, kind: "item", index: i, arrPath: fpath, fixed: typeof def.fixed === "number" }, false, false, state);
        }
        if (typeof def.fixed !== "number") {
            const rm = document.createElement("span");
            rm.className = "form-key-btn form-key-del";
            rm.textContent = "D";
            rm.title = t("Delete this element");
            rm.addEventListener("click", (ev) => {
                ev.stopPropagation();
                n.items?.splice(i, 1);
                rerender();
            });
            // 2026-09-29:行内顺序 [N] → D → 输入框(D 与标号相邻,与复杂数组 [i] D 同排布)
            row.appendChild(rm);
            row.appendChild(field);
        } else {
            row.appendChild(field);
        }
        wrap.appendChild(row);
    });
    return wrap;
}
