// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros2-monitor.ts
 * 核心状态页(webview)宿主:面板生命周期 + 消息中枢(consumers/ 层)。
 * 2026-10-03 十二轮拆分:CSS → monitor-css-base/forms.ts,HTML → monitor-html.ts,
 * 数据刷新域 → monitor-refresh.ts,助手启停流程 → monitor-helper-flows.ts;
 * 本文件只保留 launchMonitor(面板创建/复用/销毁)与 webview 消息分发(查询/操作经
 * composeApi.monitorApi 与 terminalRun,回执统一走 postCommandResult)。
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import * as vscode from "vscode";

import { composeApi } from "../../../api";
import { fetchForms, fetchFullParamValues, onHelperHeartbeat, setHelperConnectionCallback, setHelperPushCallback, stopParamHelper } from "../helper/param-helper-client";
import { param_collapse, ingestHelperPush } from "../monitor-api";
import { clearActivePanel, getActivePanel, requestRefresh, setActivePanel } from "./monitor-refresh";
import { setHelperScriptPath, startHelperFlow, stopHelperFlow } from "./monitor-helper-flows";
import { getCoreStatusWebviewContent } from "./monitor-html";

import { getLogger } from "../../../../logger";

/** 核心状态页模块日志 */
const log = getLogger("ros2-monitor");

/** 状态页消费者对象(consumers/ 层专用;查询/操作全部经它) */
const monitorApi = composeApi.monitorApi;

// 常驻状态徽章的数据桥(K 批,2026-10-07):心跳帧独立路径转发活动面板——
// 与投影帧完全分隔(helperHeartbeat 消息无 ready 字段,webview 主分发器按 J 批
// 门槛无视,由 status-badge 自有监听器消费)
onHelperHeartbeat((sample) => {
    const panel = getActivePanel();
    if (panel) {
        void panel.webview.postMessage({ command: "helperHeartbeat", sample });
    }
});

/** POSIX 单引号包裹(JSON 双引号安全;内嵌单引号做 '\'' 转义)——载荷在命令行完整可见可改 */
function shellSingleQuote(text: string): string {
    return "'" + text.replace(/'/g, "'\\''") + "'";
}

/** 动作类命令统一回执:失败 toast(即时可见),成功回执供 webview 行内小字 */
function postCommandResult(panel: vscode.WebviewPanel, kind: string, target: string, r: { ok: boolean; reused?: boolean; error?: string }): void {
    if (!r.ok) {
        log.warn(vscode.l10n.t("{0} {1} failed: {2}", kind, target, r.error));
        void vscode.window.showErrorMessage(vscode.l10n.t("{0} failed: {1}", target, r.error ?? vscode.l10n.t("unknown reason")));
        return;
    }
    void panel.webview.postMessage({
        command: 'commandResult',
        kind,
        target,
        ok: true,
        reused: r.reused === true,
    });
}

function buildWebviewI18nScript(context: vscode.ExtensionContext): string {
    // 期4 方案 B(用户裁定):按 VS Code 显示语言注入 zh-cn 册;其他语言注入空表(前端 t() 回退英文源)。
    const lang = vscode.env.language || "";
    if (!lang.toLowerCase().startsWith("zh")) { return "window.__I18N = {};"; }
    try {
        const bundlePath = path.join(context.extensionUri.fsPath, "l10n", "bundle.l10n.zh-cn.json");
        return "window.__I18N = " + fs.readFileSync(bundlePath, "utf8") + ";";
    } catch (err) {
        log.warn(vscode.l10n.t("Failed to load the zh-cn webview bundle; falling back to English sources: {0}", err instanceof Error ? err.message : String(err)));
        return "window.__I18N = {};";
    }
}

export function launchMonitor(context: vscode.ExtensionContext) {
    // Check if an existing panel exists and reveal it
    const existing = getActivePanel();
    if (existing) {
        log.debug("Status page webview already exists; revealing it (refresh is helper-event driven; no polling to restart)");
        existing.reveal(vscode.ViewColumn.Two);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        "ros2Status",
        vscode.l10n.t("ROS 2 Status"),
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
        }
    );

    // Store reference to the panel
    setActivePanel(panel);
    log.info("Status page webview panel created (event-driven: helper events trigger refresh; if no [webview] frontend-ready log follows, the frontend script did not load or failed to initialize)");

    // 2026-09-30(用户裁定):页开不再自动启动助手——改手动(状态页「启动助手」按钮 startHelper 消息)。
    // 页关即停保留(onDidDispose);脚本路径仍在此注入(startHelperFlow 使用)。
    // DDS 服务直连的实时性优势不变;助手未启动时状态页各区块显示离线/未运行提示。
    setHelperScriptPath(path.join(context.extensionPath, "assets", "ros", "param_helper.py"));

    // 彻底推倒重来:推送帧入库(仓库 markDirty 自动触发投影,无编排);
    // resync 回应的快照也由客户端折算成 graph push 入库;连接翻转 → 立即投影一次
    setHelperPushCallback((frame) => {
        ingestHelperPush(frame);
    });
    setHelperConnectionCallback((connected) => {
        requestRefresh(0);
    });
    // (2026-09-30 用户裁定)此处的 startParamHelper 自动启动已移除:
    const stylesheet = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "assets", "ros", "core-monitor", "style.css")));

    const script = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "dist", "ros2_webview_main.js")));

    panel.webview.html = getCoreStatusWebviewContent(stylesheet, script, buildWebviewI18nScript(context));

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
        async message => {
            // 诊断:每条 webview 消息落日志(默认 Info 不可见,开 Debug 可看全量)
            log.debug(`收到 webview 消息:command=${message?.command ?? "?"}${message?.helperAction ? ` helperAction=${message.helperAction}` : ""}${message?.nodeName ? ` node=${message.nodeName}` : ""}${message?.transition ? ` transition=${message.transition}` : ""}`);
            switch (message.command) {
                case 'webviewReady':
                    // 前端初始化握手:若面板已创建却一直等不到这条,前端脚本加载/执行出了问题。
                    // 2026-09-26:握手即触发一次刷新——竞态修复:助手快时 Socket 连接触发的首刷
                    // 可能早于前端监听器挂好而丢消息,页面会永远停在"正在加载…"
                    log.info(vscode.l10n.t("[webview] frontend ready: {0}", message?.message ?? ""));
                    requestRefresh(0);
                    break;
                case 'webviewLog':
                    // 前端日志转发(webview console 不外显,统一收进扩展"ROS 2"输出通道)
                    {
                        const msg = `[webview] ${message?.message ?? ""}`;
                        if (message?.level === "error") { log.error(msg); }
                        else if (message?.level === "warn") { log.warn(msg); }
                        else if (message?.level === "trace") { log.trace(msg); }
                        else if (message?.level === "debug") { log.debug(msg); }
                        else { log.info(msg); }
                    }
                    break;
                case 'startHelper':
                    startHelperFlow(panel);
                    break;
                case 'stopHelper':
                    stopHelperFlow(panel);
                    break;
                case 'fetchParamValues':
                    // 订阅制(彻底推倒重来):webview 展开节点行 → 节点全名册计入服务端账本
                    // + 回底账入库(param push 此后保鲜);成功自动投影。
                    // 失败显示走投影帧 valueErrors 通道(F2)——paramValuesError 毒帧已删
                    // (J 批:该消息无 ready 字段,曾落入帧分支离线态清空全页+重置指纹)
                    {
                        const { nodeName } = message;
                        monitorApi.param_values({ node: nodeName })
                            .then((r) => {
                                if (r.success) {
                                    log.debug(`参数已订阅:${nodeName}(自动投影)`);
                                } else {
                                    log.warn(`参数值取值失败:${nodeName}(错误行由投影帧显示)`);
                                }
                            })
                            .catch((err) => {
                                log.warn(`参数取值异常:${nodeName} ${err instanceof Error ? err.message : String(err)}`);
                            });
                    }
                    break;
                case 'collapseParamNode':
                    // 收起节点 → 2 秒后按名册退订(防快速收起/展开抖动,裁定 2026-10-06)
                    {
                        const { nodeName } = message;
                        if (typeof nodeName === "string") {
                            param_collapse(nodeName);
                        }
                    }
                    break;
                case 'saveParamToFile':
                    // 截断全值"打开到文件"(彻底推倒重来:落盘归客户端——批量取全值,
                    // 内容寻址命名沿用,同值零重写由内容哈希天然保证)
                    {
                        const { nodeName, paramName } = message;
                        fetchFullParamValues(String(nodeName), [String(paramName)])
                            .then((values) => {
                                const value = values[String(paramName)];
                                const payload = { node: String(nodeName), param: String(paramName), value };
                                const content = JSON.stringify(payload, null, 2) + "\n";
                                const digest = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
                                const filePath = path.join(os.tmpdir(), `rde-param-${digest}.json`);
                                fs.writeFileSync(filePath, content, "utf-8");
                                return vscode.window.showTextDocument(vscode.Uri.file(filePath))
                                    .then(() => log.info(`参数全值已打开:path=${filePath}`));
                            })
                            .catch((err) => {
                                log.error(`参数全值打开失败:${err instanceof Error ? err.message : String(err)}`);
                                void vscode.window.showErrorMessage(`参数全值打开失败:${err instanceof Error ? err.message : String(err)}`);
                            });
                    }
                    break;
                case 'subscribeTopic':
                    // 话题快速订阅(2026-09-26 批次1):普通集成终端跑 ros2 topic echo——
                    // 终端常驻,Ctrl+C 停止后提示符仍在,用户可直接改造命令重跑(任务终端做不到)。
                    {
                        const topic = String(message?.topic ?? "");
                        composeApi.terminalRun({
                            name: `topic:${topic}`,
                            command: `ros2 topic echo ${topic}`,
                            resendOnReuse: false,
                        }).then((r) => postCommandResult(panel, 'subscribe', topic, r));
                    }
                    break;
                case 'getForm':
                    // 服务/动作表单字段树(彻底推倒重来:get_form 按类型串批量;结果回 formResult)
                    {
                        const kind = message.kind === 'action' ? 'action' : 'service';
                        const type = String(message?.type ?? "");
                        const name = String(message?.name ?? "");
                        fetchForms([type])
                            .then((formMap) => {
                                const fields = formMap[type] ?? [];
                                void panel.webview.postMessage({
                                    command: 'formResult', kind, type, name,
                                    fields,
                                });
                            })
                            .catch((err) => {
                                log.warn(`表单内省失败(${kind} ${type}):${err instanceof Error ? err.message : String(err)}`);
                                void panel.webview.postMessage({
                                    command: 'formResult', kind, type, name,
                                    error: err instanceof Error ? err.message : String(err),
                                });
                            });
                    }
                    break;
                case 'callService':
                    // 服务调用(2026-09-26 批次2):前端表单组装的请求对象 → minify JSON 单引号包裹 →
                    // 普通集成终端 ros2 service call(载荷命令行完整可见,Ctrl+C 后可改命令重跑)
                    {
                        const name = String(message?.name ?? "");
                        const type = String(message?.type ?? "");
                        const json = shellSingleQuote(JSON.stringify(message?.args ?? {}));
                        composeApi.terminalRun({
                            name: `service:${name}`,
                            command: `ros2 service call ${name} ${type} ${json}`,
                            resendOnReuse: true,
                        }).then((r) => postCommandResult(panel, 'call', name, r));
                    }
                    break;
                case 'sendGoal':
                    // 动作目标发送(2026-09-26 批次2):Goal 表单对象 → ros2 action send_goal --feedback
                    // (CLI 内部自动包 _SendGoal 壳与 unique_id;反馈流直接进终端)
                    {
                        const name = String(message?.name ?? "");
                        const type = String(message?.type ?? "");
                        const json = shellSingleQuote(JSON.stringify(message?.args ?? {}));
                        composeApi.terminalRun({
                            name: `action:${name}`,
                            command: `ros2 action send_goal ${name} ${type} ${json} --feedback`,
                            resendOnReuse: true,
                        }).then((r) => postCommandResult(panel, 'goal', name, r));
                    }
                    break;
                case 'triggerLifecycleTransition':
                    // 前端直发转换 label(2026-10-06 协议边无 id,transitionId 全链退役);CLI 执行
                    try {
                        const { nodeName, transition } = message;
                        const success = await monitorApi.lifecycle_transition({ node: nodeName, transition });
                        log.debug(`转换执行结果:node=${nodeName}, transition=${transition}, success=${success}`);
                        // 失败时附节点即时真实状态(仓库读数,零请求),前端失败文案可指明"当前状态 X"
                        let currentState: string | undefined;
                        if (!success) {
                            const st = await monitorApi.lifecycle_get({ node: nodeName });
                            currentState = st ?? undefined;
                        }
                        panel.webview.postMessage({
                            command: 'transitionResult',
                            nodeName: nodeName,
                            transition: transition,
                            success: success,
                            currentState,
                        });
                        // 转换回执后立即投影(权威 lifecycle push 也在路上,双保险)
                        requestRefresh(0);
                    } catch (error) {
                        log.error(`触发生命周期转换时出错:${error instanceof Error ? error.message : String(error)}`);
                    }
                    break;
                // 2026-09-26:getParamValues/paramValues 消息链路已删除——参数值改由助手
                // A6 param dump 随每轮刷新数据自带(类型化),前端树直接常显,无需按需取值。
            }
        }
    );

    // 2026-09-26 事件驱动:无轮询链——首次刷新由 Socket 连接建立触发(onConnected → scheduleRefresh(0)),
    // 后续由助手事件(graph_change/param_change)触发;页面关闭即停助手。
    panel.onDidDispose(() => {
        // 2026-09-26:参数助手随页面一起停(常驻进程仅页面展开期间存活)
        stopParamHelper();
        clearActivePanel();
        log.info("状态页 webview 已关闭,助手进程停止");
    });
}
