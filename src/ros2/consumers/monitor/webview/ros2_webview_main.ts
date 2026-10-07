// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros2_webview_main.ts
 * 状态页 webview 前端 · 入口与消息中枢(webpack entry → dist/ros2_webview_main.js,
 * 经典脚本无顶层导出——webpack 配置注释的 2026-09-09 教训,本文件不得新增 export)。
 * 2026-10-03 十二轮拆分:各区块/表单引擎/悬浮工具分下列模块;本文件保留
 * initializeRos2Monitor(按钮绑定 + window message 唯一分发器 + webviewReady 握手)与 window.onload。
 * 参数区:文件树(2026-09-26);ⓘ 悬浮标注分布各区块旁(2026-09-24)。
 */

import { l10n } from "vscode";

import { t } from "./shared/i18n";

function r2s(err: unknown): string { const e = err instanceof Error ? err : undefined; return e ? (e.message + " | " + (e.stack ?? "")) : String(err); }

import { vscode, sendLog } from "./shared/context";
import { canonicalStringify, removeAllChildElements, setActionStatus } from "./shared/dom-utils";
import { noteTransitionResult, renderNodesSection } from "./panels/lifecycle-panel";
import { resetLifecycleLogs } from "./panels/lifecycle-log";
import { renderTopicsList } from "./panels/topics-panel";
import { renderParameters } from "./panels/param-tree";
import { collectCollapsiblePaths, formKey, formStates, initFormNode, FormFieldDef } from "./forms/form-model";
import { renderServicesList, rerenderServices } from "./forms/form-panel";
import { hydrateStaticInfoIcons } from "./shared/hover-tip";
import { mountStatusBadge } from "./status-badge";

// 区块级指纹(2026-10-07 I 批):数据未变的区块不重建——帧级总指纹的整页重绘退役
// (F5 实测:展开取值失败节点 → 整页 DOM 重建闪一下+滚动锚定失效跳回开头)。
// 三个区块对应三个 DOM 容器:system(#topics,含节点+话题+生命周期)/
// services(#services,含服务+动作)/params(#parameters)。
// system 消费"参数结构在位表"(节点行 ! 徽标 = parameters[node]===null),不消费值——
// 取值往返只动 params 区;结构到位(null→树)同步动 system 区(徽标清除)。
const sectionFingerprints: Record<string, string> = {};

function sectionChanged(key: string, value: unknown): boolean {
    const fp = canonicalStringify(value);
    if (sectionFingerprints[key] === fp) {
        return false;
    }
    sectionFingerprints[key] = fp;
    return true;
}

function resetSectionFingerprints(): void {
    for (const key of Object.keys(sectionFingerprints)) {
        delete sectionFingerprints[key];
    }
}

function initializeRos2Monitor() {
    sendLog("info", t("initializeRos2Monitor started (binding UI events)..."));

    // 全局错误钩子:未捕获异常/未处理 Promise 拒绝回传扩展日志(首次联测定位前端崩溃的关键)
    window.addEventListener("error", (ev) => {
        sendLog("error", `window.onerror:${ev.message ?? "?"} @${ev.filename ?? "?"}:${ev.lineno ?? "?"}`);
    });
    window.addEventListener("unhandledrejection", (ev) => {
        const r = ev.reason;
        sendLog("error", t("Unhandled promise rejection: {0}", r instanceof Error ? (r.message + " | " + (r.stack ?? "")) : String(r)));
    });

    // Initialize menu bar event handlers
    const toggleDaemonBtn = document.getElementById("helper-toggle-btn") as HTMLButtonElement;
    const helperStatusMessage = document.getElementById("helper-status-message") as HTMLSpanElement;

    let isHelperRunning = false;
    // 前端 daemon 状态(上次值;翻转时 info 日志,用于在扩展日志里看到状态演进)
    let prevHelperRunning: boolean | undefined;

    // 状态小字管理:共享清理定时器(防旧定时器误清新文本);
    // 不传 clearAfterMs = 持续显示直到下一条结果消息(starting/stopping 用)。
    let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
    const setStatus = (text: string, clearAfterMs?: number) => {
        helperStatusMessage.textContent = text;
        if (statusClearTimer !== undefined) {
            clearTimeout(statusClearTimer);
            statusClearTimer = undefined;
        }
        if (clearAfterMs !== undefined) {
            statusClearTimer = setTimeout(() => {
                helperStatusMessage.textContent = "";
            }, clearAfterMs);
        }
    };

    toggleDaemonBtn.addEventListener("click", () => {
        sendLog("info", t("Helper button clicked: frontend state isHelperRunning={0} -> sending {1}", isHelperRunning, isHelperRunning ? "stopHelper" : "startHelper"));
        // 确认窗口变长(后端实测在线/离线后才发结果),期间禁用按钮防连点双触发
        toggleDaemonBtn.disabled = true;
        if (isHelperRunning) {
            setStatus(t("Stopping helper…"));
            vscode.postMessage({
                command: 'stopHelper'
            });
        } else {
            setStatus(t("Starting helper…"));
            vscode.postMessage({
                command: 'startHelper'
            });
        }
    });

    // handle message passed from extension to webview
    window.addEventListener("message", (event) => {
        const message = event.data;

        // 处理助手启停控制消息
        if (message.helperAction) {
            const toggleBtn = document.getElementById("helper-toggle-btn") as HTMLButtonElement;

            if (message.helperAction === "error") {
                sendLog("error", t("Helper action error: {0}", message.message ?? ""));
            }

            switch (message.helperAction) {
                case 'starting':
                    // 2026-09-09:启动中不清空——小字持续显示到 started/error 结果为止(后端确认在线后才发结果)
                    setStatus(message.message);
                    // Don't update isHelperRunning yet, wait for 'started'
                    toggleBtn.disabled = true; // 确认期间防连点
                    break;
                case 'started':
                    isHelperRunning = message.isRunning;
                    // 后端已实测在线才发 started → 小字/按钮同一时刻同步(消除"晚一档")
                    setStatus(message.message, 5000);
                    // 立即更新按钮以反映新状态
                    toggleBtn.disabled = false;
                    toggleBtn.textContent = isHelperRunning ? t("Stop Helper") : t("Start Helper");
                    toggleBtn.className = isHelperRunning ? "menu-button stop" : "menu-button";
                    break;
                case 'stopping':
                    // 2026-09-09:停止中不清空,持续到 stopped/error 结果为止
                    setStatus(message.message);
                    // Don't update isHelperRunning yet, wait for 'stopped'
                    toggleBtn.disabled = true; // 确认期间防连点
                    break;
                case 'stopped':
                    isHelperRunning = message.isRunning;
                    // 后端已实测离线才发 stopped → 小字/按钮同步
                    setStatus(message.message, 5000);
                    // 十八轮补九(易失日志):助手停止=旧世代日志作废
                    resetLifecycleLogs();
                    // 立即更新按钮以反映新状态
                    toggleBtn.disabled = false;
                    toggleBtn.textContent = isHelperRunning ? t("Stop Helper") : t("Start Helper");
                    toggleBtn.className = isHelperRunning ? "menu-button stop" : "menu-button";
                    break;
                case 'error':
                    isHelperRunning = message.isRunning;
                    setStatus(message.message, 5000);
                    toggleBtn.disabled = false;
                    toggleBtn.textContent = isHelperRunning ? t("Stop Helper") : t("Start Helper");
                    toggleBtn.className = isHelperRunning ? "menu-button stop" : "menu-button";
                    break;
            }
            if (isHelperRunning !== prevHelperRunning) {
                prevHelperRunning = isHelperRunning;
                sendLog("info", t("Helper frontend state changed: {0} [helperAction={1}]", isHelperRunning ? t("running (button=Stop Helper)") : t("not running (button=Start Helper)"), message.helperAction));
            }
            return;
        }

        // Handle lifecycle transition result messages
        // 2026-08-26②:原 3s toast 已退役(十八轮补四)——回执写入节点终端日志区,持久可追溯
        if (message.command === 'transitionResult') {
            noteTransitionResult(message.nodeName, message.transition || "", !!message.success, message.currentState);
            return;
        }

        // 2026-09-26 批次1:订阅/调用动作回执(行内反馈;动作类消息不参与数据指纹,置于指纹判定之前)
        if (message.command === 'commandResult') {
            const kindText = message.kind === 'subscribe' ? t('Subscribe')
                : (message.kind === 'call' ? t('Service call') : t('Action'));
            const text = message.ok
                ? (message.reused ? t("{0} {1}: focused the existing terminal", kindText, message.target) : t("{0} {1}: already started in a terminal", kindText, message.target))
                : t("{0} {1}: failed ({2})", kindText, message.target, message.message ?? t("unknown reason"));
            setActionStatus(message.kind, text);
            sendLog(message.ok ? "info" : "warn", `commandResult:${text}`);
            return;
        }

        // 2026-09-26 批次2:表单字段树到达(动作类消息不参与数据指纹)→ 更新状态 + 整区重绘
        if (message.command === 'formResult') {
            const key = formKey(message.kind === 'action' ? 'action' : 'service', message.name ?? "")
                + "|" + (message.type ?? "");
            const state = formStates.get(key);
            sendLog("debug", `formResult: key=${key} stateFound=${state !== undefined} fields=${(message.fields ?? []).length} error=${message.error ?? "-"}`);
            if (state) {
                state.loading = false;
                if (message.error) {
                    state.error = String(message.error);
                } else {
                    state.fields = ((message.fields ?? []) as FormFieldDef[]).map(initFormNode);
                    // 2026-09-30 五轮(用户裁定):服务调用表单默认【全收起】——
                    // 字段结构每次到达都按当前树重算可折叠集合并全部置为折叠
                    const out: string[] = [];
                    collectCollapsiblePaths(state.fields, "", out);
                    state.collapsed = new Set<string>(out);
                    // 十三轮补充:字段未到时用户已在行尾点过一键展开/收起 → 到达即套用意图
                    if (state.pendingAllCollapsed === false) {
                        state.collapsed.clear();
                    }
                    delete state.pendingAllCollapsed;
                }
                rerenderServices();
            }
            return;
        }

        // 2026-09-26:paramValues 消息已随「展开取值」链路退役——参数值由助手 param dump 随刷新数据自带

        // 帧消息门槛(J 批修,2026-10-07):无 ready 字段的消息不是投影帧,一律无视——
        // 曾有 paramValuesError(取值失败回执,F2 遗留)落进本分支的离线态:清空三容器+
        // 重置区块指纹+跳顶,下一帧再全量重建 = "展开失败节点整页刷新闪一下跳回开头"
        if (typeof message.ready !== "boolean") {
            return;
        }

        // 十八轮补九(易失日志):助手不在线(崩溃/停止/离线)→ 旧世代日志作废;
        // 助手重启后从这里开始积累新世代
        if (message.ready === false) {
            resetLifecycleLogs();
        }

        // 2026-09-13:页面模板固定包含这三个容器(同下方 toggle-btn 的 as 惯例);断言消除 possibly-null,运行时不变
        const topicsElement = document.getElementById("topics") as HTMLElement;
        const servicesElement = document.getElementById("services") as HTMLElement;
        const parametersElement = document.getElementById("parameters") as HTMLElement;

        // 滚动保持(I 批):本轮有任何区块重建,渲染后恢复视角——上方 DOM 被替换不跳顶
        const scrollY = window.scrollY;
        let rendered = false;

        if (message.ready) {
            // 按刷新数据同步助手按钮状态(幂等轻操作,不参与区块指纹)
            if (typeof message.isHelperRunning === 'boolean') {
                isHelperRunning = message.isHelperRunning;
                const toggleBtn = document.getElementById("helper-toggle-btn") as HTMLButtonElement;
                // 二十一(用户报告启停状态延迟/错误):启停确认窗内(starting/stopping,
                // 按钮 disabled)轮询不覆写按钮——确认窗早期 ping 暂败会把按钮闪回
                // "启动助手",与 starting 播报冲突造成状态误读
                if (!toggleBtn.disabled) {
                    toggleBtn.textContent = isHelperRunning ? t("Stop Helper") : t("Start Helper");
                    toggleBtn.className = isHelperRunning ? "menu-button stop" : "menu-button";
                }
            }
            if (isHelperRunning !== prevHelperRunning) {
                prevHelperRunning = isHelperRunning;
                sendLog("info", t("Helper frontend state changed: {0} [poll ready={1}]", isHelperRunning ? t("running (button=Stop Helper)") : t("not running (button=Start Helper)"), message.ready));
            }

            const nodes = message.nodes || [];
            const topics = message.topics || [];
            const services = message.services || [];

            // 顺序稳定·保险一(2026-09-26):表格数据按名称排序,不随助手发现顺序漂移
            const byFullName = (a: any, b: any) =>
                `${a.namespace ?? ""}${a.name}`.localeCompare(`${b.namespace ?? ""}${b.name}`);
            const byName = (a: any, b: any) => String(a.name).localeCompare(String(b.name));
            const sortedNodes = [...nodes].sort(byFullName);
            const sortedTopics = [...topics].sort(byName);
            const sortedServices = [...services].sort(byName);
            const sortedActions = [...(message.actions || [])].sort(byName);

            // params 区:值 + 失败名单(取值往返——成功或失败——只重建本区块)
            if (sectionChanged("params", { p: message.parameters ?? {}, e: message.valueErrors ?? [] })) {
                try {
                    // valueErrors(纯推送 F2):取值失败节点由投影帧标注,行下显示可见错误提示
                    renderParameters(message.parameters || {}, (message.valueErrors ?? []) as string[]);
                    rendered = true;
                } catch (err) {
                    sendLog("error", t("Parameter render error: {0}", err instanceof Error ? err.message : String(err)));
                }
            }

            // system 区:节点(含生命周期卡片)+ 话题;参数结构在位表驱动节点行 "!" 徽标
            if (sectionChanged("system", {
                n: nodes, t: topics,
                lc: message.lifecycleNodes || [], d: message.lifecycleDiscovered || [],
                st: Object.fromEntries(nodes.map((n: any) => {
                    const fullName = `${n.namespace ?? ""}${n.name}`;
                    return [fullName, message.parameters?.[fullName] !== null && message.parameters?.[fullName] !== undefined];
                })),
            })) {
                removeAllChildElements(topicsElement);
                // 2026-08-26 P1 修复:后端 postMessage 直接传结构化对象数组(非 JSON 字符串)
                try {
                    // 节点区(十七轮):节点行 + 生命周期卡片内联(原独立生命周期区块并入)
                    renderNodesSection(topicsElement, sortedNodes, message.lifecycleNodes || [], message.parameters || {}, message.lifecycleDiscovered || []);
                } catch (err) {
                    sendLog("error", t("Node section render error: {0}", err instanceof Error ? err.message : String(err)));
                }
                // 2026-09-26 批次1:话题表换 flex 行(行尾"订阅"动作)
                renderTopicsList(sortedTopics);
                rendered = true;
            }

            // services 区:服务 + 动作(可展开复合行,表单 + 调用按钮)
            if (sectionChanged("services", { s: services, a: message.actions || [] })) {
                removeAllChildElements(servicesElement);
                renderServicesList(sortedServices, sortedActions);
                rendered = true;
            }

            if (rendered) {
                window.scrollTo(0, scrollY);
            }
        } else {
            // 助手未就绪/未运行时
            resetSectionFingerprints();   // 下次 ready 全量重建
            removeAllChildElements(topicsElement);
            removeAllChildElements(servicesElement);
            removeAllChildElements(parametersElement);

            isHelperRunning = false;
            if (isHelperRunning !== prevHelperRunning) {
                prevHelperRunning = isHelperRunning;
                sendLog("info", t("Helper frontend state changed: not running (button=Start Helper) [poll not-ready]"));
            }
            const toggleBtn = document.getElementById("helper-toggle-btn") as HTMLButtonElement;
            // 二十一:启停确认窗内(按钮 disabled)不覆写——避免 starting/stopping 播报被闪回"启动助手"
            if (!toggleBtn.disabled) {
                toggleBtn.textContent = t("Start Helper");
                toggleBtn.className = "menu-button";
            }

            // 系统信息离线提示(2026-09-26:不再静默空着,明确告知原因;容器已在上方统一清空)
            // (十七轮:生命周期独立区块已并入节点区,离线无需单独隐藏)
            if (topicsElement) {
                const hint = document.createElement("p");
                hint.className = "offline-hint";
                hint.textContent = t("Helper not running — click the button above to start it; nodes / topics / services / parameters will appear here");
                topicsElement.appendChild(hint);
            }
        }
    });
    // 静态 ⓘ(模板直书)接入选位逻辑(I 批:治悬浮框顶出边界)
    hydrateStaticInfoIcons();
    // 常驻状态徽章(K 批):独立数据路径,逐帧解读心跳
    mountStatusBadge();

    sendLog("info", t("initializeRos2Monitor finished: click + message listeners attached; waiting for backend event-driven data"));
    // 初始化握手:后端据此判断前端脚本是否加载成功(见 ros2-monitor.ts case 'webviewReady')
    vscode.postMessage({ command: "webviewReady", message: t("onload -> initializeRos2Monitor completed") });
}

window.onload = () => {
    try {
        initializeRos2Monitor();
    } catch (err) {
        // 顶层兜底:初始化阶段异常(元素缺失/脚本不匹配等)不能静默——尽力回传扩展日志
        // eslint-disable-next-line no-console
        console.error(t("ros2monitor initialization failed:"), err);
        try {
            vscode.postMessage({ command: "webviewLog", level: "error", message: t("Frontend initialization error: {0}", err instanceof Error ? (r2s(err)) : String(err)) });
        } catch {
            // vscode API 不可用时无解,静默
        }
    }
};
