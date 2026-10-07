// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file form-panel.ts
 * 服务调用/动作发送 · 区块层(2026-10-03 十二轮自 ros2_webview_main.ts 拆出):
 * 表单区域构建、状态惰性创建(getForm 一次性拉取)、服务/动作复合行(展开即渲染表单)、
 * 服务/动作区整区重绘(焦点存活:重建前后按字段路径恢复光标)。
 * 交互走整区重绘(参数树同款架构):click 只改集合 + rerenderServices(),
 * 绝不做局部 body swap——局部重建依赖闭包持有的旧 DOM,是"点了没反应"的根源。
 */

import { l10n } from "vscode";

import { t } from "../shared/i18n";

import { vscode } from "../shared/context";
import { ICON_COLLAPSE, ICON_COPY, ICON_EXEC, ICON_EXPAND } from "../shared/icons";
import { attachHoverTip, buildInfoIcon } from "../shared/hover-tip";
import { buildCollapsibleSection, copyCommandToClipboard, removeAllChildElements, shellSingleQuoteForCopy } from "../shared/dom-utils";
import {
    assembleObject, collectCollapsiblePaths, formKey, formStates, svcExpanded,
    ServiceFormState,
} from "./form-model";
import {
    autoGrowTextarea, clearFormErrors, markFormErrors,
    validateFormNodes, FormFieldError,
} from "./form-fields";
import { renderFormFields } from "./form-render";

function buildFormArea(state: ServiceFormState): HTMLElement {
    const area = document.createElement("div");
    area.className = "form-area";
    if (state.loading) {
        const hint = document.createElement("p");
        hint.className = "offline-hint";
        hint.textContent = t("Parsing field structure…");
        area.appendChild(hint);
        return area;
    }
    if (state.error) {
        const hint = document.createElement("p");
        hint.className = "form-error-row";
        hint.textContent = t("Failed to parse field structure: {0} (an empty request {} can still be sent)", state.error);
        area.appendChild(hint);
        return area;
    }
    const body = document.createElement("div");
    const rebuild = (): void => {
        removeAllChildElements(body);
        if (state.fields) {
            renderFormFields(body, state.fields, rebuild, "", undefined, state);
        }
        // 2026-09-30 四轮:局部重渲染(折叠/增删元素)后补 textarea 自增高 ——
        // 构建期子树未入 DOM(isConnected 守卫跳过),rAF 时必已挂载,按内容恢复高度
        requestAnimationFrame(() => {
            body.querySelectorAll("textarea.form-input").forEach((ta) => { autoGrowTextarea(ta as HTMLTextAreaElement); });
        });
    };
    rebuild();
    // (2026-09-28)空态提示句删除:用法说明下沉到 A/D 键钮的悬浮(title)
    area.appendChild(body);
    return area;
}

function ensureFormState(kind: "service" | "action", target: string, type: string): ServiceFormState {
    const key = formKey(kind, target) + "|" + type;   // 与行状态键同式(含类型)
    let state = formStates.get(key);
    if (!state) {
        state = { kind, target, type, loading: true, collapsed: new Set<string>() };
        formStates.set(key, state);
        vscode.postMessage({ command: "getForm", kind, type, name: target });
    }
    return state;
}

/** 单条服务/动作行:▸ 名称 + 类型(行尾);展开时**构建期直接渲染表单内容**。
 *  交互走整区重绘(参数树同款架构):click 只改集合 + rerenderServices(),
 *  绝不做局部 body swap——局部重建依赖闭包持有的旧 DOM,是"点了没反应"的根源。
 *  布局(2026-09-27 用户裁定):调用/复制按钮在上方,填写内容在下方。 */
function buildInvocableRow(kind: "service" | "action", name: string, type: string, extra: string, buttonLabel: string): HTMLElement {
    const key = formKey(kind, name) + "|" + type;   // 同名多类型拆分后,状态键按类型区分
    const row = document.createElement("div");
    row.className = "svc-row";
    const header = document.createElement("div");
    header.className = "svc-header";
    const caret = document.createElement("span");
    caret.className = "svc-caret";
    const label = document.createElement("span");
    label.className = "entry-name";
    label.textContent = name;
    const typeDim = document.createElement("span");
    typeDim.className = "entry-type";
    // 动词清单移入悬浮说明(用户裁定 2026-10-07):多动作时行尾动词串完全多余。
    // 挂在类型文字上而非整行 header——header 上还有 [+]/[-] 各自的悬浮说明,
    // 挂整行会双框同弹(F5 实测)
    typeDim.textContent = type;
    header.appendChild(caret);
    header.appendChild(label);
    header.appendChild(typeDim);
    row.appendChild(header);
    if (extra) {
        attachHoverTip(typeDim, t("Action service verbs discovered on the graph: {0}", extra));
    }

    // 一键展开/收起在服务行尾(2026-10-03 十三轮,用户裁定):类型之后,**恒显示**(十三轮补充:
    // 不再等展开——未展开行点击 = 登记意图 pendingAllCollapsed,字段到达时套用;有字段立即生效);
    // stopPropagation 防误触发行折叠(服务与动作行共用此构建器,一并生效)
    const applyCollapseIntent = (collapse: boolean): void => {
        ensureFormState(kind, name, type);
        const st = formStates.get(key)!;
        if (st.fields) {
            if (collapse) {
                const out: string[] = [];
                collectCollapsiblePaths(st.fields, "", out);
                st.collapsed = new Set<string>(out);
            } else {
                st.collapsed.clear();
            }
        } else {
            st.pendingAllCollapsed = collapse;
        }
        rerenderServices();
    };
    const exp = document.createElement("span");
    exp.className = "form-key-btn form-key-neutral";
    exp.innerHTML = ICON_EXPAND;
    attachHoverTip(exp, t("Expand all: expand every collapsible group in the current form"));
    exp.addEventListener("click", (ev) => {
        ev.stopPropagation();
        applyCollapseIntent(false);
    });
    const col = document.createElement("span");
    col.className = "form-key-btn form-key-neutral";
    col.innerHTML = ICON_COLLAPSE;
    attachHoverTip(col, t("Collapse all: collapse every collapsible group in the current form (message groups / non-empty arrays / fixed arrays)"));
    col.addEventListener("click", (ev) => {
        ev.stopPropagation();
        applyCollapseIntent(true);
    });
    header.appendChild(exp);
    header.appendChild(col);

    const expanded = svcExpanded.has(key);
    caret.textContent = expanded ? "▾" : "▸";

    header.addEventListener("click", () => {
        const nowExpanded = !svcExpanded.has(key);
        if (nowExpanded) {
            svcExpanded.add(key);
            ensureFormState(kind, name, type);
        } else {
            svcExpanded.delete(key);
        }
        rerenderServices();
    });

    if (expanded) {
        ensureFormState(kind, name, type);
        const state = formStates.get(key)!;
        const body = document.createElement("div");
        body.className = "svc-body";
        // 调用/复制在上方,填写内容在下方(2026-09-27 用户裁定)
        const actionsLine = document.createElement("div");
        actionsLine.className = "form-actions-line";
        const runForm = (): { args: Record<string, unknown>; errors: FormFieldError[] } => {
            const errors: FormFieldError[] = [];
            if (state.fields) { validateFormNodes(state.fields, "", errors); }
            // 2026-09-29 校验重设计:错误 = 输入框红描边 + 红色圆形感叹号徽标(悬浮 = 详情),
            // 取代红字长行;通过时清标记
            clearFormErrors(body);
            if (errors.length > 0) { markFormErrors(body, errors); }
            return { args: state.fields ? assembleObject(state.fields) : {}, errors };
        };
        // 2026-09-30 四轮(用户裁定):复制在前,终端在后
        const copyBtn = document.createElement("span");
        copyBtn.className = "param-open-file";
        copyBtn.innerHTML = ICON_COPY;
        attachHoverTip(copyBtn, t("Copy the full command of the current call (arguments from the current form values)"));
        copyBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const { args, errors } = runForm();
            if (errors.length > 0) { return; }
            const json = shellSingleQuoteForCopy(JSON.stringify(args));
            const cmd = kind === "service"
                ? `ros2 service call ${name} ${type} ${json}`
                : `ros2 action send_goal ${name} ${type} ${json} --feedback`;
            copyCommandToClipboard(copyBtn, cmd);
        });
        actionsLine.appendChild(copyBtn);
        const callBtn = document.createElement("button");
        callBtn.className = "form-call-btn";
        callBtn.innerHTML = ICON_EXEC;
        attachHoverTip(callBtn, t("{0}: execute in a regular integrated terminal (the command is visible, editable and rerunnable)", buttonLabel));
        callBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const { args, errors } = runForm();
            if (errors.length > 0) { return; }
            vscode.postMessage({
                command: kind === "service" ? "callService" : "sendGoal",
                name, type, args,
            });
        });
        actionsLine.appendChild(callBtn);
        // (2026-09-28)ros2 service call / send_goal 说明字删除——终端语义已在调用/复制按钮的悬浮里
        // (一键展开/收起已于十三轮移至服务行尾)
        body.appendChild(actionsLine);
        body.appendChild(buildFormArea(state));
        row.appendChild(body);
    }
    return row;
}

/** 最近一次服务/动作数据(整区重绘用;指纹不变时不重灌,交互重绘读这里) */
let lastServicesData: any[] = [];
let lastActionsData: any[] = [];

/** 服务/动作区整区重绘(参数树 rerenderParams 同款;数据刷新/点击展开/表单回执都走这里)。
 *  焦点存活:重建前记录活动输入的字段路径与光标位置,重建后恢复(数据刷新打字不丢焦点) */
export function rerenderServices(): void {
    const servicesElement = document.getElementById("services");
    if (!servicesElement) { return; }
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const saved = active && active.dataset && active.dataset.fpath
        ? { fpath: active.dataset.fpath, s: active.selectionStart, e: active.selectionEnd }
        : undefined;
    removeAllChildElements(servicesElement);

    // 十七轮:服务/动作两区块可折叠(标题行尾 ▾/▸,状态跨刷新记忆)
    const svcSection = buildCollapsibleSection(
        "services", "服务",
        buildInfoIcon(t("Real-time service list; click a row to expand the invocation form (field structure auto-parsed by the resident helper from the service type; defaults pre-filled). Action rows: terminal icon = run ros2 service call in a regular integrated terminal (persistent; command visible, editable and rerunnable); copy icon = copy the full command; expand/collapse all = expand or collapse all field groups (all collapsed by default; group header ▸/▾ blocks can be toggled individually). Just fill in values - no manual quote escaping needed (handled automatically during assembly); input is not validated, validation happens when you click call/copy - error fields get a red outline + red ! badge, hover the badge for details. Keyboard: Enter inserts a newline in string fields (multi-line), moves to the next field for numeric; Shift+Enter creates a new array element; Backspace in an empty field goes up, deleting the whole object when the first field is empty.")),
        "svc-action-status",
    );
    servicesElement.appendChild(svcSection.root);
    const svcList = document.createElement("div");
    svcList.className = "entry-list";
    for (const s of lastServicesData) {
        svcList.appendChild(buildInvocableRow("service", s.name, s.type, "", "调用"));
    }
    if (lastServicesData.length === 0) {
        const empty = document.createElement("p");
        empty.className = "param-tree-empty";
        empty.textContent = t("No invocable services");
        svcList.appendChild(empty);
    }
    svcSection.body.appendChild(svcList);

    const actSection = buildCollapsibleSection(
        "actions", "动作",
        buildInfoIcon(t("Actions appear on the graph as three services: send_goal / cancel_goal / get_result, stripped from the service list; this expands a Goal form per target (defaults pre-filled); Send = ros2 action send_goal --feedback (the CLI wraps the _SendGoal shell and unique_id), feedback streams to the terminal. Keyboard and validation rules match services (Enter newline in strings / next field for numeric; Shift+Enter creates array elements; Backspace in empty field goes up; validation on send/copy, error fields get red outline + ! badge).")),
        "goal-action-status",
    );
    servicesElement.appendChild(actSection.root);
    const actList = document.createElement("div");
    actList.className = "entry-list";
    for (const a of lastActionsData) {
        actList.appendChild(buildInvocableRow("action", a.name, a.type, (a.verbs ?? []).join("/"), "发送目标"));
    }
    if (lastActionsData.length === 0) {
        const empty = document.createElement("p");
        empty.className = "param-tree-empty";
        empty.textContent = t("No running action servers");
        actList.appendChild(empty);
    }
    actSection.body.appendChild(actList);

    // 2026-09-29(附带问题 1):全部入 DOM 后统一补调自增高——此前 autoGrow 在构建期(未入 DOM)
    // 被跳过/量出 0,重渲染后带内容的 textarea 坍缩不可见,被误认为空白表单
    servicesElement.querySelectorAll("textarea.form-input").forEach((ta) => {
        autoGrowTextarea(ta as HTMLTextAreaElement);
    });

    if (saved) {
        const el = servicesElement.querySelector(`[data-fpath="${saved.fpath}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
        if (el) {
            el.focus();
            try { el.setSelectionRange(saved.s ?? 0, saved.e ?? 0); } catch { /* checkbox */ }
        }
    }
}

/** 多类型服务拆分(用户裁定 2026-10-07):同名不同类型的服务条目按类型拆成多条,
 *  每条如同一个正常的独立条目(各自的类型展示/表单/状态键,DDS 误配不再是"整串类型
 *  打进内省必败"的盲点) */
function splitServiceEntries(services: any[]): { name: string; type: string }[] {
    const out: { name: string; type: string }[] = [];
    for (const s of services) {
        const types = String(s.type ?? "").split(", ").filter(Boolean);
        for (const t of types) {
            out.push({ name: String(s.name), type: t });
        }
    }
    return out;
}

/** 数据到达入口:存数据 + 整区重绘(仅指纹变化时被调用) */
export function renderServicesList(services: any[], actions: any[]): void {
    lastServicesData = splitServiceEntries(services);
    lastActionsData = actions;
    // 2026-09-29(附带问题 2):服务/动作从列表消失 → 对应表单状态清空。
    // 此前 formStates 只写不清:消失再出现会原样带回旧输入,叠加重渲染后 textarea 坍缩,
    // 用户误以为空白直接调用/复制,造成误导。仍在线的目标状态保留(重渲染不丢)。
    const present = new Set<string>();
    for (const s of lastServicesData) { present.add(formKey("service", s.name) + "|" + s.type); }
    for (const a of actions) { present.add(formKey("action", a.name) + "|" + a.type); }
    for (const key of [...formStates.keys()]) {
        if (!present.has(key)) { formStates.delete(key); }
    }
    rerenderServices();
}
