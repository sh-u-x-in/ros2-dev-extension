// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file param-tree.ts
 * 状态页参数区 · 文件树(2026-10-03 十二轮自 ros2_webview_main.ts 拆出;2026-09-26 按实测
 * dump 格式重构:ros2 param dump 把点分参数名按 "." 展开成嵌套层级(源码 insert_dict 逐段拆键),
 * 树即参数真实结构,原样保真渲染)。展开集合/最近数据缓存内聚本模块。
 * 值五类着色常显;截断数组带"打开完整内容"落盘入口;单链分支压缩为面包屑。
 */

import { t } from "../shared/i18n";

import { vscode } from "../shared/context";
import { ICON_COLLAPSE, ICON_EXPAND } from "../shared/icons";
import { attachHoverTip, buildInfoIcon } from "../shared/hover-tip";
import { buildCollapsibleSection, removeAllChildElements } from "../shared/dom-utils";

// 展开状态(2026-09-26 文件树语义:记录"被展开的项",初始空 = 整树收起,点一层开一层;
// 键:节点层 = 节点名;分支/叶子层 = "节点名|路径.路径"——join(".") 是 dump 拆键的严格逆操作,无损;
// 事件驱动重渲染经此恢复)
const paramTreeExpanded = new Set<string>();

/** 类型化参数值(叶子;与后端 api/monitor-api.ts 的 ParamTypedValue 一致;webview 侧本地定义,避免跨包 import) */
interface ParamTypedValue {
    kind: "integer" | "double" | "boolean" | "string" | "array";
    /** 懒叶(重设计阶段 3b 统一懒):值未取 → null,渲染 "—" */
    value: number | boolean | string | ParamTypedValue[] | null;
    /** 仅懒叶:结构树里的占位叶子 */
    lazy?: boolean;
    /** 仅截断数组:助手端真实总长 */
    total?: number;
}
/** 参数树(与后端 ParamTree 一致:分支 = 子映射;叶子 = 带字符串 "kind") */
type ParamTree = { [key: string]: ParamTypedValue | ParamTree };

const isTypedLeaf = (v: ParamTypedValue | ParamTree): v is ParamTypedValue =>
    typeof (v as ParamTypedValue).kind === "string";

/** 递归数叶子参数个数(节点/文件夹头计数) */
function countParamLeaves(tree: ParamTree): number {
    let n = 0;
    for (const key of Object.keys(tree)) {
        const v = tree[key];
        n += isTypedLeaf(v) ? 1 : countParamLeaves(v);
    }
    return n;
}

/** 五类视觉色(2026-10-03 浅色适配:硬编码深色调色板 → charts 主题变量随明暗切换,色相不变;
 *  绿=整数 黄=浮点 蓝=布尔 橙=字符串 紫=数组;子元素按自身类型递归着色) */
const PARAM_KIND_COLORS: { [kind: string]: string } = {
    integer: "var(--vscode-charts-green, #b5cea8)",
    double: "var(--vscode-charts-yellow, #dcdcaa)",
    boolean: "var(--vscode-charts-blue, #569cd6)",
    string: "var(--vscode-charts-orange, #ce9178)",
    array: "var(--vscode-charts-purple, #a78bfa)",
};

/** 渲染类型化值:按五类着色;数组渲染 [a, b] 且子元素递归;布尔 true/false,字符串原样不加引号;
 *  懒叶(值未取)渲染灰色 "—"——展开节点行时宿主自动取值刷新;
 *  节点取值失败(errored)时懒叶 "—" 标红(裁定 2026-10-07:错误态与未取值视觉可分) */
function renderTypedValue(container: HTMLElement, tv: ParamTypedValue, errored = false): void {
    if (tv.lazy === true) {
        const lazySpan = document.createElement("span");
        lazySpan.style.color = errored
            ? "var(--vscode-errorForeground)"
            : "var(--vscode-descriptionForeground)";
        lazySpan.textContent = "—";
        container.appendChild(lazySpan);
        return;
    }
    if (tv.kind === "array") {
        // 数组括号/逗号加粗(2026-09-26:仅两个字符太单薄,加粗提升存在感)
        const punctuation = (text: string) => {
            const span = document.createElement("span");
            span.style.color = PARAM_KIND_COLORS.array;
            span.style.fontWeight = "bold";
            span.textContent = text;
            container.appendChild(span);
        };
        punctuation("[");
        const arr = tv.value as ParamTypedValue[];
        arr.forEach((el, i) => {
            if (i > 0) {
                punctuation(", ");
            }
            renderTypedValue(container, el);
        });
        punctuation("]");
        if (tv.total !== undefined) {
            // 助手端截断的大数组(>1000):标注真实总长
            const totalSpan = document.createElement("span");
            totalSpan.style.color = PARAM_KIND_COLORS.array;
            totalSpan.textContent = t("… {0} items in total", tv.total);
            container.appendChild(totalSpan);
        }
        return;
    }
    const span = document.createElement("span");
    span.style.color = PARAM_KIND_COLORS[tv.kind] ?? "var(--vscode-foreground)";
    span.textContent = tv.kind === "boolean" ? (tv.value ? "true" : "false") : String(tv.value);
    container.appendChild(span);
}

/** 最近一次参数数据([+]/[-] 改展开集合后显式重绘用;与指纹跳渲染互不干扰) */
let lastParamData: { [node: string]: ParamTree | null } | null = null;
/** 最近一次取值失败名单(rerenderParams 回放用;I 批修:一键展开/收起后错误行不再消失) */
let lastValueErrors: string[] = [];

function rerenderParams(): void {
    if (lastParamData !== null) {
        renderParameters(lastParamData, lastValueErrors);
    }
}

/** 收集子树内全部条目键(分支+叶子;[+] 一键展开用) */
function collectEntryKeys(nodeName: string, path: string, tree: ParamTree): string[] {
    const out: string[] = [];
    for (const key of Object.keys(tree)) {
        const childPath = path ? `${path}.${key}` : key;
        out.push(`${nodeName}|${childPath}`);
        const v = tree[key];
        if (!isTypedLeaf(v)) {
            out.push(...collectEntryKeys(nodeName, childPath, v));
        }
    }
    return out;
}

/**
 * 单链压缩(2026-09-26,参考 VS Code compact folders):某层只有唯一子且唯一子还是分支时,
 * 沿链合并段名为一条面包屑(如 qos_overrides >/parameter_events > publisher,
 * ">" 分隔符白色加粗,有意不用"."——太小不显眼)。唯一子是叶子时不吞,
 * 叶子保持自己的条目(值子行挂它名下)。
 */
function compressChain(key: string, startPath: string, value: ParamTree): { segs: string[]; terminal: ParamTree; terminalPath: string } {
    const segs = [key];
    let terminal = value;
    let terminalPath = startPath;
    for (;;) {
        const keys = Object.keys(terminal);
        if (keys.length !== 1) {
            break;
        }
        const onlyKey = keys[0];
        const onlyVal = terminal[onlyKey];
        if (isTypedLeaf(onlyVal)) {
            break;
        }
        segs.push(onlyKey);
        terminalPath = `${terminalPath}.${onlyKey}`;
        terminal = onlyVal;
    }
    return { segs, terminal, terminalPath };
}

/** 参数数据:节点 → 参数树(嵌套层级原样保真);null = 该节点 dump 失败(前端显示失败提示);
 *  valueErrors(纯推送 F2):取值失败节点(结构在、值没取到)——行下显示可见错误提示,
 *  不再静默 "—";值缓存就位后投影帧不再携带,提示自然消失 */
export function renderParameters(parameters: { [node: string]: ParamTree | null }, valueErrors: string[] = []) {
    const paramsElement = document.getElementById("parameters");
    if (!paramsElement) return;
    lastParamData = parameters;
    lastValueErrors = valueErrors;
    const valueErrorSet = new Set(valueErrors);
    removeAllChildElements(paramsElement);

    // 十七轮:参数区块可折叠(标题行尾 ▾/▸,状态跨刷新记忆)
    const section = buildCollapsibleSection(
        "parameters", t("Parameters"),
        buildInfoIcon(t("File tree: node -> parameter hierarchy (single-chain folders merge into breadcrumbs with > separators); collapsed by default, click to expand level by level. The child row under a parameter name is its value; [+] at row end expands descendants, [-] on the node row collapses all.\nValues are colored by type: green=integer, yellow=float, blue=boolean, orange=string, purple=array/brackets (children colored by their own type); very long arrays are not rendered whole - click \"Open full content\" to dump to disk and view.\nData is pushed by the resident helper, event-driven (parameter changes appear in real time).")),
    );
    paramsElement.appendChild(section.root);

    const tree = document.createElement("div");
    tree.className = "param-tree";

    // 节点层字典序排序(顺序恒定,不随助手返回顺序漂移)
    const nodeNames = Object.keys(parameters).sort((a, b) => a.localeCompare(b));
    for (const nodeName of nodeNames) {
        const paramTree = parameters[nodeName];

        // 节点层:flex 行 = 名称 + 独立计数 span(间距≥两个空格宽,避免误读为名称一部分) + 行尾 [+] [-]
        const nodeItem = document.createElement("div");
        nodeItem.className = "param-tree-node";

        const nodeHeader = document.createElement("div");
        nodeHeader.className = "param-tree-node-header";

        const labelSpan = document.createElement("span");
        const countSpan = document.createElement("span");
        countSpan.className = "param-tree-count";
        const setHeaderState = (expandedFlag: boolean) => {
            labelSpan.textContent = `${expandedFlag ? "▾" : "▸"} ${nodeName}`;
            countSpan.textContent = paramTree === null ? t("(failed to fetch parameters)") : `(${countParamLeaves(paramTree)})`;
        };
        const expanded = paramTreeExpanded.has(nodeName);
        setHeaderState(expanded);
        nodeHeader.appendChild(labelSpan);
        nodeHeader.appendChild(countSpan);

        const actions = document.createElement("span");
        actions.className = "param-tree-actions";
        const plusBtn = document.createElement("span");
        plusBtn.className = "param-tree-btn";
        plusBtn.innerHTML = ICON_EXPAND;
        attachHoverTip(plusBtn, t("Expand all descendants"));   // 十一轮:原生 title 系统级延迟 → 自绘即时悬浮
        plusBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (paramTree === null) {
                return;
            }
            paramTreeExpanded.add(nodeName);
            collectEntryKeys(nodeName, "", paramTree).forEach((k) => paramTreeExpanded.add(k));
            rerenderParams();
        });
        const minusBtn = document.createElement("span");
        minusBtn.className = "param-tree-btn";
        minusBtn.innerHTML = ICON_COLLAPSE;
        attachHoverTip(minusBtn, t("Collapse everything"));
        minusBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            paramTreeExpanded.delete(nodeName);
            if (paramTree !== null) {
                collectEntryKeys(nodeName, "", paramTree).forEach((k) => paramTreeExpanded.delete(k));
            }
            rerenderParams();
        });
        actions.appendChild(plusBtn);
        actions.appendChild(minusBtn);
        nodeHeader.appendChild(actions);
        nodeItem.appendChild(nodeHeader);

        // 子层:缩进 + 树参考线;文件树语义——默认收起,点击条目逐层展开
        const children = document.createElement("div");
        children.className = "param-tree-children";
        if (!expanded) {
            children.style.display = "none";
        }
        nodeHeader.addEventListener("click", () => {
            const nowExpanded = !paramTreeExpanded.has(nodeName);
            if (nowExpanded) {
                paramTreeExpanded.add(nodeName);
                // 懒取值(重设计阶段 3b 统一懒):展开节点行 → 请宿主取该节点全部值
                // (宿主有值缓存则直接回缓存并刷新;未取过才走一次助手往返)
                vscode.postMessage({ command: "fetchParamValues", nodeName });
            } else {
                paramTreeExpanded.delete(nodeName);
                // 订阅制(彻底推倒重来):收起 → 通知宿主,2 秒后退订该节点参数变化
                // (防快速收起/展开抖动;宿主侧计时,裁定 2026-10-06)
                vscode.postMessage({ command: "collapseParamNode", nodeName });
            }
            setHeaderState(nowExpanded);
            children.style.display = nowExpanded ? "" : "none";
        });

        if (paramTree === null) {
            const failRow = document.createElement("p");
            failRow.className = "offline-hint";
            failRow.textContent = t("Failed to fetch parameters (helper unavailable or the node's parameter service did not respond; see the extension log)");
            children.appendChild(failRow);
        } else {
            if (valueErrorSet.has(nodeName)) {
                // F2(纯推送):取值失败回执——可见错误提示替代静默 "—";重试=再次展开
                const errRow = document.createElement("p");
                errRow.className = "offline-hint";
                errRow.textContent = t("Parameter values failed to fetch (the node may be stuck); expand again to retry");
                children.appendChild(errRow);
            }
            renderParamBranch(children, nodeName, "", paramTree, valueErrorSet.has(nodeName));
        }

        nodeItem.appendChild(children);
        tree.appendChild(nodeItem);
    }

    if (!tree.hasChildNodes()) {
        const empty = document.createElement("p");
        empty.className = "param-tree-empty";
        empty.textContent = t("No nodes with parameters right now");
        section.body.appendChild(empty);
    }

    section.body.appendChild(tree);
}

/**
 * 渲染参数树的一层(2026-09-26 四点 UI):条目头 flex 行 = 面包屑标签 + 独立计数 span
 * (间距≥两空格;计数按条目性质区分——2026-10-03 十六轮用户定义:往下展开**直接是值**的
 * 基本数据行不显计数,嵌套数据行(下挂子条目)显 (N) 叶子数)+ 行尾 [][-] 一键展开/收起;
 * 单链分支压缩为面包屑("> " 分隔,白色加粗,唯一子是叶子时不吞——叶子恒为独立条目);
 * path 为到当前层的点分路径(join(".") 即扁平参数名,与节点名拼合作展开键,
 * 同时是"打开到文件"的参数名)。
 */
function renderParamBranch(container: HTMLElement, nodeName: string, path: string, tree: ParamTree, errored: boolean): void {
    const keys = Object.keys(tree).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
        const value = tree[key];
        const childPath = path ? `${path}.${key}` : key;
        const entry = document.createElement("div");
        entry.className = "param-tree-branch";

        const entryHeader = document.createElement("div");
        entryHeader.className = "param-tree-branch-header";

        const labelSpan = document.createElement("span");
        const countSpan = document.createElement("span");
        countSpan.className = "param-tree-count";

        const sub = document.createElement("div");
        sub.className = "param-tree-children";

            if (isTypedLeaf(value)) {
                // 叶子条目:▸ 名称(2026-10-03 十六轮,用户裁定:不显 (1)——单值计数无信息量),
                // 展开后值子行(五色);截断数组带"打开完整内容"入口
                const collapseKey = `${nodeName}|${childPath}`;
                const setHeaderState = (expandedFlag: boolean) => {
                    labelSpan.textContent = `${expandedFlag ? "▾" : "▸"} ${key}`;
                };
                const expanded = paramTreeExpanded.has(collapseKey);
                setHeaderState(expanded);
                entryHeader.appendChild(labelSpan);
            if (!expanded) {
                sub.style.display = "none";
            }
            entryHeader.addEventListener("click", () => {
                const nowExpanded = !paramTreeExpanded.has(collapseKey);
                if (nowExpanded) {
                    paramTreeExpanded.add(collapseKey);
                } else {
                    paramTreeExpanded.delete(collapseKey);
                }
                setHeaderState(nowExpanded);
                sub.style.display = nowExpanded ? "" : "none";
            });

            const valueRow = document.createElement("div");
            valueRow.className = "param-tree-value-row";
            renderTypedValue(valueRow, value, errored);
            if (value.total !== undefined) {
                const openBtn = document.createElement("span");
                openBtn.className = "param-open-file";
                openBtn.textContent = t("Open full content ({0} items)", value.total);
                openBtn.title = t("Dump all values to a temporary JSON file and open it in the editor (not rendered on the page)");
                openBtn.addEventListener("click", () => {
                    vscode.postMessage({ command: 'saveParamToFile', nodeName, paramName: childPath });
                });
                valueRow.appendChild(openBtn);
            }
            sub.appendChild(valueRow);
        } else {
            // 分支条目:单链压缩为面包屑(> 分隔白色加粗),行尾 [+] 一键展开全部子孙
            const chain = compressChain(key, childPath, value);
            const collapseKey = `${nodeName}|${chain.terminalPath}`;
            const setHeaderState = (expandedFlag: boolean) => {
                labelSpan.textContent = `${expandedFlag ? "▾" : "▸"} `;
                chain.segs.forEach((seg, i) => {
                    if (i > 0) {
                        const sep = document.createElement("span");
                        sep.className = "param-tree-sep";
                        sep.textContent = " >";
                        labelSpan.appendChild(sep);
                    }
                    const segSpan = document.createElement("span");
                    segSpan.textContent = seg;
                    labelSpan.appendChild(segSpan);
                });
                countSpan.textContent = `(${countParamLeaves(chain.terminal)})`;
            };
            const expanded = paramTreeExpanded.has(collapseKey);
            setHeaderState(expanded);
            entryHeader.appendChild(labelSpan);
            entryHeader.appendChild(countSpan);
            if (!expanded) {
                sub.style.display = "none";
            }
            entryHeader.addEventListener("click", () => {
                const nowExpanded = !paramTreeExpanded.has(collapseKey);
                if (nowExpanded) {
                    paramTreeExpanded.add(collapseKey);
                } else {
                    paramTreeExpanded.delete(collapseKey);
                }
                setHeaderState(nowExpanded);
                sub.style.display = nowExpanded ? "" : "none";
            });

                const actions = document.createElement("span");
                actions.className = "param-tree-actions";
                const plusBtn = document.createElement("span");
                plusBtn.className = "param-tree-btn";
                plusBtn.innerHTML = ICON_EXPAND;
                attachHoverTip(plusBtn, t("Expand all descendants"));
                plusBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    paramTreeExpanded.add(collapseKey);
                    collectEntryKeys(nodeName, chain.terminalPath, chain.terminal).forEach((k) => paramTreeExpanded.add(k));
                    rerenderParams();
                });
                // 一键收起(2026-10-03 十六轮,用户裁定):分支条目与节点行同规格,[+][-] 成对在行尾
                const minusBtn = document.createElement("span");
                minusBtn.className = "param-tree-btn";
                minusBtn.innerHTML = ICON_COLLAPSE;
                attachHoverTip(minusBtn, t("Collapse all descendants"));
                minusBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    paramTreeExpanded.delete(collapseKey);
                    collectEntryKeys(nodeName, chain.terminalPath, chain.terminal).forEach((k) => paramTreeExpanded.delete(k));
                    rerenderParams();
                });
                actions.appendChild(plusBtn);
                actions.appendChild(minusBtn);
                entryHeader.appendChild(actions);

            renderParamBranch(sub, nodeName, chain.terminalPath, chain.terminal, errored);
        }

        entry.appendChild(entryHeader);
        entry.appendChild(sub);
        container.appendChild(entry);
    }
}
