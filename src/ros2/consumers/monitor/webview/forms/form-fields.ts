// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file form-fields.ts
 * 服务调用/动作发送表单 · 字段交互层(2026-10-03 十二轮自 ros2_webview_main.ts 拆出):
 * 类型灰字、输入查询、textarea 自增高、光标工具、校验错误标记(红描边+!徽标)、
 * 键盘模型 attachFormInputKeys(Enter 流转/Shift+Enter 新建/退格回退删除/方向键流转)。
 */

import { l10n } from "vscode";

import { t } from "../shared/i18n";

import {
    collectCollapsiblePaths, FormArrayContext, FormNode, ServiceFormState,
    initFormNode, isBoolType, isIntType, isNumericType,
} from "./form-model";
import { attachHoverTip } from "../shared/hover-tip";

export function appendTypeDim(parent: HTMLElement, type: string, pushRight = false): void {
    const dim = document.createElement("span");
    dim.className = "form-ftype";
    dim.textContent = type;
    // pushRight(2026-10-03 十五轮,用户裁定):基本行类型标识 margin-left:auto 推到行尾右缘,
    // 与复合组头行尾簇的视觉节奏对齐(否则紧贴输入框,像悬在行中间)
    if (pushRight) { dim.style.marginLeft = "auto"; }
    parent.appendChild(dim);
}

function formInputsIn(root: ParentNode): Array<HTMLInputElement | HTMLTextAreaElement> {
    return Array.prototype.slice.call(root.querySelectorAll(".form-input")) as Array<HTMLInputElement | HTMLTextAreaElement>;
}

/** 多行 textarea 高度自增(Enter 换行后跟随内容长高)。
 *  2026-09-29 修坍缩:元素未入 DOM 时 scrollHeight≈0,写入 height:"0px" 即永久坍缩——
 *  离线时跳过(保持 rows=1 原生高度),渲染完成后由统一补调长高。 */
export function autoGrowTextarea(ta: HTMLTextAreaElement): void {
    if (!ta.isConnected) { return; }
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
}

function caretToEnd(el: HTMLInputElement | HTMLTextAreaElement | undefined): void {
    if (!el) { return; }
    el.focus();
    try {
        const len = String(el.value ?? "").length;
        el.setSelectionRange(len, len);
    } catch { /* checkbox 无 setSelectionRange */ }
}

/** 调用/复制前的内容校验(输入阶段完全不设防);errors 带字段路径,空数组=通过 */
/** 校验错误(2026-09-29 重设计):path = 字段 fpath(与 data-fpath 同构,用于定位红框),
 *  message = 人读详情(作为徽标悬浮文案) */
export interface FormFieldError { path: string; message: string; }

/** 清除标记:红描边类 + 徽标(重校验/成功时调用) */
export function clearFormErrors(root: ParentNode): void {
    root.querySelectorAll(".form-input-invalid").forEach((el) => el.classList.remove("form-input-invalid"));
    root.querySelectorAll(".form-error-badge").forEach((el) => el.remove());
}

/** 按错误列表标记:输入框红描边 + 旁边红色圆形感叹号徽标(悬浮 = 详情) */
export function markFormErrors(root: ParentNode, errors: readonly FormFieldError[]): void {
    clearFormErrors(root);
    for (const e of errors) {
        const input = root.querySelector(`[data-fpath="${CSS.escape(e.path)}"]`);
        if (!input) { continue; }
        input.classList.add("form-input-invalid");
        const badge = document.createElement("span");
        badge.className = "form-error-badge";
        badge.textContent = "!";
        attachHoverTip(badge, e.message);
        input.insertAdjacentElement("afterend", badge);
    }
}

export function validateFormNodes(nodes: FormNode[], prefix: string, errors: FormFieldError[]): void {
    for (const n of nodes) {
        const label = prefix ? `${prefix}.${n.def.name}` : n.def.name;
        if (n.def.kind === "primitive") {
            const s = String(n.value ?? "").trim();
            if (isIntType(n.def.type) && s !== "" && !/^-?\d+$/.test(s)) {
                errors.push({ path: label, message: t("\"{0}\" is not a valid {1}", s, n.def.type) });
            } else if (/^(float32|float64|double)$/.test(n.def.type) && s !== "" && !Number.isFinite(Number(s))) {
                errors.push({ path: label, message: t("\"{0}\" is not a valid {1}", s, n.def.type) });
            } else if (typeof n.def.bound === "number" && s.length > n.def.bound) {
                errors.push({ path: label, message: t("Length {0} exceeds the limit {1}", s.length, n.def.bound) });
            }
        } else if (n.def.kind === "array") {
            (n.items ?? []).forEach((it, i) => {
                const s = String(it ?? "").trim();
                const iLabel = `${label}[${i}]`;
                if (isIntType(n.def.type) && s !== "" && !/^-?\d+$/.test(s)) {
                    errors.push({ path: iLabel, message: t("\"{0}\" is not a valid {1}", s, n.def.type) });
                } else if (/^(float32|float64|double)$/.test(n.def.type) && s !== "" && !Number.isFinite(Number(s))) {
                    errors.push({ path: iLabel, message: t("\"{0}\" is not a valid {1}", s, n.def.type) });
                }
            });
        } else if (n.def.kind === "message") {
            validateFormNodes(n.children ?? [], label, errors);
        } else if (n.def.kind === "message_array") {
            (n.elements ?? []).forEach((el, i) => validateFormNodes(el, `${label}[${i}]`, errors));
        }
    }
}

/** 键盘(2026-09-27):Enter 下一输入;Shift+Enter 数组当前元素/项后新建(焦点入新对象首字段);
 *  退格光标在开头:元素内先回退到上一输入尾(不删字符),对象首字段为空时删除整个对象;
 *  基本数组项为空时删除该项;固定长度数组结构操作禁用。输入本身零拦截。 */
/** isBool(2026-09-28 五修):bool 仍是框选 checkbox——键盘同质化:聚焦后 Backspace/Delete
 *  勾选→取消(转为假);未勾选分两境:①bool 数组项 = 向下删(删除后焦点停同下标,下一项
 *  顶上来,连续按一路向下);②普通 bool 字段(如 ParameterValue.bool_value)= 向上回退链——
 *  落到上一个输入的尾(integer_value(头)→布尔→type(尾),与文本空退格同一条链);
 *  空格不拦截(原生切换=取反);Enter/Shift+Enter 与文本输入同一流程。 */
export function attachFormInputKeys(
    input: HTMLInputElement | HTMLTextAreaElement,
    rerender: () => void,
    arrCtx: FormArrayContext | undefined,
    isBool = false,
    multiline = false,
    state?: ServiceFormState,
): void {
    input.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key !== "Enter" && ev.key !== "Backspace" && ev.key !== "Delete"
            && ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") { return; }
        const areaEl = input.closest(".form-area");
        if (!areaEl) { return; }
        const all = formInputsIn(areaEl);
        const idx = all.indexOf(input);
        // 方向键流转(2026-09-29 二修,用户明确:全表单条目按列表排布,跳转有序/固定/可测,
        // 不限于数组、不越出数组一说废除):光标在任一输入头部按 ← → 上一个输入的尾;
        // 在尾部按 → → 下一个输入的头;checkbox 无光标概念,左右均直接流转。DOM 序 = 全表单唯一顺序。
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
            if (isBool) {
                ev.preventDefault();
                const tgt = ev.key === "ArrowLeft" ? all[idx - 1] : all[idx + 1];
                if (tgt) { caretToEnd(tgt); }
                return;
            }
            const atHead = input.selectionStart === 0 && input.selectionEnd === 0;
            const atTail = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
            if (ev.key === "ArrowLeft" && atHead) {
                const prev = all[idx - 1];
                if (prev) { ev.preventDefault(); caretToEnd(prev); }
                return;
            }
            if (ev.key === "ArrowRight" && atTail) {
                const next = all[idx + 1];
                if (next) { ev.preventDefault(); caretToEnd(next); }
                return;
            }
            return;   // 文本内部:原生移动光标
        }
        if (isBool && (ev.key === "Backspace" || ev.key === "Delete")) {
            ev.preventDefault();
            const box = input as HTMLInputElement;
            if (box.checked) {
                box.checked = false;
                box.dispatchEvent(new Event("change"));
                return;
            }
            // 未勾选分两境(2026-09-28 五修 用户明确):
            // ①bool 数组项 → 向下删:删除该项,焦点停同下标(下一项顶上来,连续按一路向下删)
            if (arrCtx && arrCtx.kind === "item" && !arrCtx.fixed) {
                arrCtx.arrayNode.items?.splice(arrCtx.index, 1);
                rerender();
                const after = formInputsIn(areaEl);
                const tgt = after[Math.min(idx, after.length - 1)];
                if (tgt) { caretToEnd(tgt); }
                return;
            }
            // ②普通 bool 字段 → 向上回退链:落到上一个输入的尾
            //   (integer_value(头)→布尔→type(尾),与文本空退格同一条链)
            const prev = all[idx - 1];
            if (prev) { caretToEnd(prev); }
            return;
        }
        if (ev.key === "Enter") {
            if (multiline && !ev.shiftKey) {
                return; // 多行字符串框(2026-09-29):Enter = 真实换行(原生),不再跳下一元素
            }
            ev.preventDefault();
            if (ev.shiftKey) {
                if (!arrCtx) { return; }
                const n = arrCtx.arrayNode;
                const capped = (count: number) => arrCtx.fixed === true || (n.def.max !== null && count >= (n.def.max ?? 0));
                if (arrCtx.kind === "element") {
                    const count = n.elements?.length ?? 0;
                    if (capped(count)) { return; }
                    n.elements = n.elements ?? [];
                    n.elements.splice(arrCtx.index + 1, 0, (n.def.template ?? []).map(initFormNode));
                    // 新建元素内部组默认全收起(2026-09-30 五轮,与 A 键一致)
                    if (state) {
                        const newEl = n.elements[arrCtx.index + 1];
                        const inner: string[] = [];
                        collectCollapsiblePaths(newEl, `${arrCtx.arrPath}[${arrCtx.index + 1}]`, inner);
                        inner.forEach((p) => state.collapsed.add(p));
                        // 十三轮补充(用户裁定):新条目本身不收起(同下标旧元素曾被收起时),
                        // 让创建可见;内部组仍默认全收起
                        state.collapsed.delete(`${arrCtx.arrPath}[${arrCtx.index + 1}]`);
                    }
                } else {
                    const count = n.items?.length ?? 0;
                    if (capped(count)) { return; }
                    n.items = n.items ?? [];
                    n.items.splice(arrCtx.index + 1, 0, isBoolType(n.def.type) ? false : "");
                }
                rerender();
                // 新对象/新项插入在当前元素之后:焦点 = 当前元素最后一个输入的下一位
                const elDiv = input.closest(".form-element");
                const elInputs = elDiv ? formInputsIn(elDiv) : [input];
                const lastIdx = all.indexOf(elInputs[elInputs.length - 1]);
                caretToEnd(formInputsIn(areaEl)[lastIdx + 1]);
                return;
            }
            const next = all[idx + 1];
            if (next) { caretToEnd(next); }
            return;
        }
        // Backspace:仅光标在开头时介入;字段内容非空不拦截
        if (input.selectionStart !== 0 || input.selectionEnd !== 0 || input.value !== "") { return; }
        if (!arrCtx) {
            // 普通字段(非数组成员)空删除 → 同样向上走一格(全条目列表语义一致,2026-09-29 二修)
            ev.preventDefault();
            const prev = all[idx - 1];
            if (prev) { caretToEnd(prev); }
            return;
        }
        const n = arrCtx.arrayNode;
        if (arrCtx.kind === "item") {
            if (arrCtx.fixed) {
                // 固定长度(不可删):空删除 = 导航到上一个输入(向上,全局列表序,
                // 可一路跨出数组;2026-09-29 二修)
                ev.preventDefault();
                const prev = all[idx - 1];
                if (prev) { caretToEnd(prev); }
                return;
            }
            ev.preventDefault();
            n.items?.splice(arrCtx.index, 1);
            rerender();
            const after = formInputsIn(areaEl);
            caretToEnd(after[Math.max(0, idx - 1)] ?? after[idx]);
            return;
        }
        // 元素字段:元素内存在上一个输入 → 光标跳到其尾部(本次不删字符)
        const elDiv = input.closest(".form-element");
        const elInputs = elDiv ? formInputsIn(elDiv) : [];
        const inIdx = elInputs.indexOf(input);
        if (inIdx > 0) {
            ev.preventDefault();
            caretToEnd(elInputs[inIdx - 1]);
            return;
        }
        // 元素第一个字段且为空 → 删除整个对象
        ev.preventDefault();
        n.elements?.splice(arrCtx.index, 1);
        rerender();
        const after = formInputsIn(areaEl);
        caretToEnd(after[Math.max(0, idx - 1)] ?? after[idx]);
    });
}
