// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file form-model.ts
 * 服务调用/动作发送表单 · 模型层(2026-10-03 十二轮自 ros2_webview_main.ts 拆出):
 * 字段树/状态树类型、ROS 类型谓词、默认值初始化与回填、状态树 → 请求 JSON 组装、
 * 可折叠路径收集。纯数据域零 DOM;依赖方向 form-model ← form-fields ← form-render ← form-panel。
 * 状态按 "kind|目标名" 常驻 Map:刷新重建后展开与已填值原样恢复。
 */

// ==================================================================
// 服务调用 / 动作发送(2026-09-26 批次2):可展开复合行 + 递归表单。
// 数据流:展开 → getForm(助手运行时内省字段树)→ formResult 建状态树 → 表单渲染;
// 输入事件回写状态树(不刮 DOM);调用 → 组装 JSON → callService / sendGoal。
// ==================================================================
export interface FormFieldDef {
    kind: "primitive" | "array" | "message" | "message_array"
    | "message_unresolved" | "message_array_unresolved";
    name: string;
    type: string;
    bound?: number | null;
    fixed?: number | null;
    max?: number | null;
    default?: unknown;
    children?: FormFieldDef[];
    template?: FormFieldDef[];
    error?: string;
}

export interface FormNode {
    def: FormFieldDef;
    /** primitive 标量(checkbox 存 boolean,其余存字符串,组装时按类型转换) */
    value?: string | boolean;
    /** array 的元素原始值 */
    items?: (string | boolean)[];
    /** message 子节点 */
    children?: FormNode[];
    /** message_array 已添加元素(每组 = template 的 FormNode 副本) */
    elements?: FormNode[][];
}

export interface ServiceFormState {
    kind: "service" | "action";
    target: string;
    type: string;
    loading: boolean;
    error?: string;
    fields?: FormNode[];
    /** 折叠中的组(fpath 集合,2026-09-29 批次 C);重渲染后折叠状态保持 */
    collapsed: Set<string>;
    /** 字段未到时登记的一键展开/收起意图(十三轮补充):true=全收起 false=全展开;
     *  formResult 到达套用后清除——图标恒显后,未展开行也能先定调 */
    pendingAllCollapsed?: boolean;
}

export const formStates = new Map<string, ServiceFormState>();
export const svcExpanded = new Set<string>();
export const formKey = (kind: string, target: string): string => `${kind}|${target}`;

export const isBoolType = (type: string): boolean => type === "boolean" || type === "bool";
export const isIntType = (type: string): boolean => /^(u?int(8|16|32|64)|byte|char)$/.test(type);
export const isNumericType = (type: string): boolean => isIntType(type) || /^(float32|float64|double)$/.test(type);
export const isStringType = (type: string): boolean => type === "string" || type === "wstring";

function toScalarInput(v: unknown, type: string): string | boolean {
    if (isBoolType(type)) { return v === true; }
    if (v === null || v === undefined) { return ""; }
    return String(v);
}

export function initFormNode(def: FormFieldDef): FormNode {
    const node: FormNode = { def };
    if (def.kind === "primitive") {
        node.value = toScalarInput(def.default, def.type);
    } else if (def.kind === "array") {
        const arr = Array.isArray(def.default) ? def.default : [];
        node.items = arr.map((v) => toScalarInput(v, def.type));
        if (typeof def.fixed === "number") {
            while (node.items.length < def.fixed) {
                node.items.push(isBoolType(def.type) ? false : "");
            }
        }
    } else if (def.kind === "message") {
        node.children = (def.children ?? []).map(initFormNode);
        if (def.default && typeof def.default === "object" && !Array.isArray(def.default)) {
            assignFromObject(node.children, def.default as Record<string, unknown>);
        }
    } else if (def.kind === "message_array") {
        node.elements = [];
        const arr = Array.isArray(def.default) ? def.default : [];
        for (const obj of arr) {
            const el = (def.template ?? []).map(initFormNode);
            if (obj && typeof obj === "object") {
                assignFromObject(el, obj as Record<string, unknown>);
            }
            node.elements.push(el);
        }
    }
    return node;
}

/** 已填值/默认对象回填状态树(按字段名对齐;缺失键保持初始化默认) */
function assignFromObject(nodes: FormNode[], obj: Record<string, unknown>): void {
    for (const n of nodes) {
        const v = obj ? obj[n.def.name] : undefined;
        if (v === undefined || v === null) { continue; }
        if (n.def.kind === "primitive") {
            n.value = toScalarInput(v, n.def.type);
        } else if (n.def.kind === "array" && Array.isArray(v)) {
            n.items = v.map((x) => toScalarInput(x, n.def.type));
        } else if (n.def.kind === "message" && typeof v === "object") {
            assignFromObject(n.children ?? [], v as Record<string, unknown>);
        } else if (n.def.kind === "message_array" && Array.isArray(v)) {
            n.elements = v.map((o) => {
                const el = (n.def.template ?? []).map(initFormNode);
                if (o && typeof o === "object") {
                    assignFromObject(el, o as Record<string, unknown>);
                }
                return el;
            });
        }
    }
}

/** 表单值 → 请求 JSON(按字段类型转换;unresolved 字段跳过,缺失由服务端报错、见终端) */
function scalarToTyped(v: string | boolean | undefined, type: string): unknown {
    if (isBoolType(type)) { return v === true; }
    const s = String(v ?? "").trim();
    if (s === "") { return isNumericType(type) ? 0 : ""; }
    if (isIntType(type)) {
        const num = Number(s);
        return Number.isFinite(num) ? Math.trunc(num) : 0;
    }
    if (/^(float32|float64|double)$/.test(type)) {
        const num = Number(s);
        return Number.isFinite(num) ? num : 0;
    }
    return s;
}

export function assembleObject(nodes: FormNode[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const n of nodes) {
        const v = assembleNode(n);
        if (v !== undefined) { out[n.def.name] = v; }
    }
    return out;
}

function assembleNode(n: FormNode): unknown {
    switch (n.def.kind) {
        case "primitive": return scalarToTyped(n.value, n.def.type);
        case "array": return (n.items ?? []).map((v) => scalarToTyped(v, n.def.type));
        case "message": return assembleObject(n.children ?? []);
        case "message_array": return (n.elements ?? []).map((el) => assembleObject(el));
        default: return undefined;
    }
}

/** 数组元素字段的键盘上下文(Shift+Enter 建对象 / 退格删对象的目标数组) */
export interface FormArrayContext {
    arrayNode: FormNode;
    kind: "element" | "item";
    /** kind=element: 元素下标;kind=item: 项下标 */
    index: number;
    /** 数组自身的字段路径(如 parameters) */
    arrPath: string;
    /** 固定长度数组:结构操作(新建/删除)禁用 */
    fixed?: boolean;
}

/** 基本行计数(2026-10-03 十三轮,用户裁定):宿主内全部可输入行,嵌套全算——
 *  primitive=1;array=每项一个输入行(items.length);message=递归 children;
 *  message_array=逐元素递归;unresolved=0。与「元素个数」语义不同(一个复杂元素含多行)。
 *  渲染时从状态树现算,增删行走整区重渲染自动同步,零监听。 */
export function countBasicRows(nodes: FormNode[]): number {
    let n = 0;
    for (const node of nodes) {
        switch (node.def.kind) {
            case "primitive": n += 1; break;
            case "array": n += node.items?.length ?? 0; break;
            case "message": n += countBasicRows(node.children ?? []); break;
            case "message_array": for (const el of node.elements ?? []) { n += countBasicRows(el); } break;
            default: break;
        }
    }
    return n;
}

/** 可折叠组的路径收集(一键展开/收起用):message 全收;message_array/array 有内容或固定才收 */
export function collectCollapsiblePaths(nodes: FormNode[], prefix: string, out: string[]): void {
    for (const n of nodes) {
        const ownPath = prefix ? `${prefix}.${n.def.name}` : n.def.name;
        if (n.def.kind === "message") {
            out.push(ownPath);
            collectCollapsiblePaths(n.children ?? [], ownPath, out);
        } else if (n.def.kind === "message_array") {
            out.push(ownPath);
            (n.elements ?? []).forEach((el, i) => {
                const elPath = `${ownPath}[${i}]`;
                out.push(elPath); // 元素自身也是可折叠单元(2026-09-30 五轮二)
                collectCollapsiblePaths(el, elPath, out);
            });
        } else if (n.def.kind === "array") {
            out.push(ownPath);
        }
    }
}
