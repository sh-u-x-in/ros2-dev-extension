// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file param-helper-client.ts
 * 常驻助手客户端(2026-10-06 彻底推倒重来:信封帧协议)。
 *
 * 架构:全局唯一助手服务端 + 多窗口客户端,一切帧复用一条固定路径 Unix socket,
 * 一行 JSON 一帧。上行信封 {client,id,time,request};下行 response|heartbeat|push。
 * 无握手:连接即注册,连上后自动发 resync(回应=全量图快照,**回应到达=在线**);
 * 心跳=ping(2s,就地秒回);看门狗 5s 无任何帧 → 读锁文件 pid+启动 ticks、
 * 核对 /proc 防 pid 复用杀错人 → SIGKILL 自愈重拉。
 * 连接策略 connect-first 沿袭:先试连现有服务端(可能是别的窗口拉起的),连不上才 spawn;
 * spawn 竞速败者 flock 仲裁自动退出,连接轮询自然命中胜者。
 * 停止语义:仅断开本窗口连接(共享服务端可能有别的窗口在用;零客户端宽限由服务端自管)。
 */

import { l10n } from "vscode";

import * as child_process from "child_process";
import * as fs from "fs";
import * as net from "net";

import { getLogger } from "../../../../logger";
import { setHelperRunning } from "./helper-state";
import type { CommandRunner } from "../../../api";
import {
    HELPER_LOCK_PATH, HELPER_SOCKET_PATH,
    type HelperFormMap, type HelperGraphSnapshot, type HelperInboundFrame,
    type HelperRequestFrame,
} from "./param-helper-protocol";

/** 助手模块日志 */
const log = getLogger("param-helper");

/** 注入的 CommandRunner(spawn 自动注入 ROS env) */
let commandRunner: CommandRunner | undefined;

export function setParamHelperCommandRunner(cr: CommandRunner): void {
    commandRunner = cr;
}

/** 本进程(扩展宿主)启动时刻——上行信封 time 字段,防 pid 复用(裁定 2026-10-06) */
const CLIENT_START_TIME = Date.now();

/** 期望运行标志(stop 后置 false,退出/断开回调据此决定是否重连/重拉) */
let desiredRunning = false;
let scriptPath = "";
let proc: child_process.ChildProcess | undefined;
let procSpawnAt = 0;
let procEverLinked = false;   // 本进程 spawn 后是否成功在线过(判定 SPAWN_WAIT 僵死)
let nextId = 1;
let restartAttempts = 0;
let restartTimer: NodeJS.Timeout | undefined;
let retryTimer: NodeJS.Timeout | undefined;

const REQUEST_TIMEOUT_MS = 30000;
const PING_TIMEOUT_MS = 3000;       // 健康检查短超时(确认窗轮询/保活 ping 均用;不陪长超时)
const SPAWN_WAIT_MS = 15000;        // spawn 后允许的最长在线等待(超时=僵,杀掉走退避)
const PING_INTERVAL_MS = 2000;      // 客户端心跳(ping;服务端 10s 收不到判半死踢除)
const WATCHDOG_STALE_MS = 5000;     // 5s 无任何服务端帧 → 服务端挂死,SIGKILL 自愈
const RESYNC_TIMEOUT_MS = 15000;

interface PendingRequest {
    resolve: (data: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}
const pending = new Map<number, PendingRequest>();

/** 心跳样本(K 批常驻状态徽章,2026-10-07):服务端 1s 心跳帧的解码形态。
 *  数据路径与投影帧完全分隔——不进 monitor-api/区块指纹,仅供状态徽章消费。 */
export interface HelperHeartbeatSample {
    pid: number;
    /** 服务端启动时刻(epoch 秒;up=now-startTime) */
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

const heartbeatListeners = new Set<(s: HelperHeartbeatSample) => void>();
let lastHeartbeat: HelperHeartbeatSample | undefined;

function emitHeartbeat(sample: HelperHeartbeatSample): void {
    lastHeartbeat = sample;
    for (const cb of heartbeatListeners) {
        try { cb(sample); } catch { /* 订阅者异常不影响心跳泵 */ }
    }
}

/** 订阅心跳帧(常驻状态徽章数据源):注册即回放最近一帧(面板晚开不空窗)。
 *  **只承载真实到达的心跳帧**——没有合成离线样本(用户裁定 2026-10-07:灰与不灰的
 *  唯一裁决是是否有合法心跳);静止转灰由消费方按新鲜度自行裁决。返回退订函数。 */
export function onHelperHeartbeat(cb: (s: HelperHeartbeatSample) => void): () => void {
    heartbeatListeners.add(cb);
    if (lastHeartbeat) {
        cb(lastHeartbeat);
    }
    return () => heartbeatListeners.delete(cb);
}

// ---- 共享 socket 会话状态 ----
type SocketHandlers = {
    onConnect: () => void;
    onData: (chunk: Buffer) => void;
    onClose: () => void;
    onError: (err: Error) => void;
};
export interface HelperTestSocket {
    write(data: string): void;
    destroy(): void;
}
type SocketFactory = (path: string, handlers: SocketHandlers) => HelperTestSocket;

function defaultSocketFactory(path: string, handlers: SocketHandlers): HelperTestSocket {
    const s = net.createConnection(path);
    s.on("connect", () => handlers.onConnect());
    s.on("data", (chunk: Buffer) => handlers.onData(chunk));
    s.on("close", () => handlers.onClose());
    s.on("error", (err: Error) => handlers.onError(err));
    return { write: (data) => s.write(data), destroy: () => s.destroy() };
}

let socketFactory: SocketFactory = defaultSocketFactory;

/** 测试缝:注入假 socket 工厂(不真连;测试手动投喂帧) */
export function setSocketFactoryForTest(factory: SocketFactory | undefined): void {
    socketFactory = factory ?? defaultSocketFactory;
}

let sock: HelperTestSocket | undefined;
let connecting = false;         // 一次只挂一个在途连接
let connected = false;          // socket 已完成连接(请求放行门槛;连接中/被拒阶段一律拒绝)
let online = false;             // 在线语义=resync 回应到达(裁定:回应=握手等价物)
let serverPid = 0;
let serverStartTime = 0;        // 服务端启动时刻(下行信封 time)
let lastSocketData = 0;
let frameBuf = "";
let pingTimer: NodeJS.Timeout | undefined;
let resyncInFlight = false;

let helperPushCallback: ((frame: Record<string, unknown>) => void) | undefined;
let helperConnectionCallback: ((connected: boolean) => void) | undefined;

/** 注册推送帧回调(graph/param/paramStructure/lifecycle 直达仓库层) */
export function setHelperPushCallback(cb: (frame: Record<string, unknown>) => void): void {
    helperPushCallback = cb;
}

/** 注册连接状态回调(resync 回应到达=在线;断开=离线;状态页据此触发投影与离线提示) */
export function setHelperConnectionCallback(cb: ((connected: boolean) => void) | undefined): void {
    helperConnectionCallback = cb;
}

/** 启动助手(幂等:已在线或在连则忽略;脚本路径由调用方注入) */
export function startParamHelper(script: string): void {
    scriptPath = script;
    desiredRunning = true;
    if (restartTimer) {
        // 挂起的退避重拉必须与主动启动合并(沿袭):否则定时器到点无条件
        // spawn 会覆盖语义;先清,连接维护循环自行决定 spawn 时机
        clearTimeout(restartTimer);
        restartTimer = undefined;
        restartAttempts = 0;
    }
    if (sock || connecting) {
        return;
    }
    linkTick();
}

/** 停止助手(状态页关闭/手动停止):仅断开本窗口连接——共享服务端可能还有别的
 *  窗口在用,绝不 SIGKILL;零客户端 10s 宽限由服务端自退,退出回调因
 *  desiredRunning=false 不重拉。spawn 出的进程句柄自然收敛。 */
export function stopParamHelper(): void {
    desiredRunning = false;
    log.debug(l10n.t("stop: page closed / manual stop (hadProc={0})", proc !== undefined));
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
    }
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
    }
    stopPing();
    online = false;
    connected = false;
    serverPid = 0;
    serverStartTime = 0;
    frameBuf = "";
    if (sock) {
        const s = sock;
        sock = undefined;
        s.destroy();   // onClose 因 desiredRunning=false 不重连
    }
    connecting = false;
    setHelperRunning(false);
    // 不杀 proc(见上);保留句柄:若服务端仍活着(他窗在用),再次 start 直连即可
    failAllPending(l10n.t("Parameter helper stopped"));
    restartAttempts = 0;
}

// ---- 业务请求:信封打自增 id 走 socket,30s 超时 ----

/** op=get_param_values(node,names):计入订阅账本+回底账。
 *  返回该节点的具体值映射(回应为账本回显,本节点=对象形态)。
 *  串行容忍:撞上"节点串行访问中"(推送占闸)自动重试至多 3 次(瞬态拒绝可重入)。 */
export async function getParamValues(node: string, names: string[]): Promise<Record<string, unknown>> {
    const data = await requestSerialTolerant("get_param_values", { node, names });
    const echo = (data ?? {}) as { node?: Record<string, Record<string, unknown> | string[]> };
    const entry = echo.node?.[node];
    return entry && !Array.isArray(entry) ? entry : {};
}

/** op=unget_param_values(node,names):移出订阅账本,停推变化(fire-and-forget 语义) */
export async function ungetParamValues(node: string, names: string[]): Promise<void> {
    await request("unget_param_values", { node, names });
}

/** op=save_param_values(node,names):截断全值批量(落盘归客户端,服务端只回值) */
export async function fetchFullParamValues(node: string, names: string[]): Promise<Record<string, unknown>> {
    const data = await request("save_param_values", { node, names });
    const map = (data ?? {}) as Record<string, Record<string, unknown>>;
    return map[node] ?? {};
}

/** op=get_form(types):srv→Request 字段树 / action→Goal 字段树(按类型串,一次可多个) */
export async function fetchForms(types: string[]): Promise<HelperFormMap> {
    return (await request("get_form", { types })) as HelperFormMap;
}

/** op=resync:服务端重发全量快照(回应 data=快照;另广播名册/详情补推) */
export async function resyncSnapshot(): Promise<HelperGraphSnapshot> {
    const data = await request("resync", {}, RESYNC_TIMEOUT_MS);
    return (data ?? {}) as HelperGraphSnapshot;
}

/** op=ping:健康检查(启停确认窗/monitor-api.helper_running/2s 保活均用)。
 *  **正经请求**(用户裁定 2026-10-07):计入单一 id 序列、建 pending、回应按 id 匹配——
 *  匹配成功即"服务端可应答"得证;服务端就地秒回,短超时 3s(不陪 30s)。 */
export async function pingHelper(): Promise<boolean> {
    try {
        await request("ping", {}, PING_TIMEOUT_MS);
        return true;
    } catch (err) {
        log.debug(`ping failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/** 串行容忍请求:服务端按节点串行访问(单飞),撞上在途调用被瞬态拒绝时自动重试 */
async function requestSerialTolerant(op: string, req: { node?: string; names?: string[] }, tries = 3): Promise<unknown> {
    let lastErr: unknown;
    for (let i = 0; i <= tries; i++) {
        try {
            return await request(op, req);
        } catch (err) {
            lastErr = err;
            if (!(err instanceof Error) || !err.message.includes("串行")) {
                throw err;
            }
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    throw lastErr;
}

/** 通用请求:已连接的 socket 上打信封发帧,id 匹配响应 + 超时(默认 30s,ping 类 3s)。
 *  门槛=**connected**(socket 完成连接;F 批修:id=9 黑洞的根源就是旧门槛"sock 非空"
 *  把请求放进了连接中/注定被拒的 socket)。resync 正是建立 online 的那一步,
 *  故门槛不能是 online。 */
function request(op: string, req: { node?: string; names?: string[]; types?: string[] }, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!sock || !connected) {
        log.debug(`request reject: op=${op} (socket 未连接)`);
        return Promise.reject(new Error(l10n.t("Parameter helper is not running")));
    }
    const s = sock;
    const id = nextId++;
    const frame: HelperRequestFrame = {
        client: `exthost-${process.pid}`,
        id,
        time: CLIENT_START_TIME,
        request: { op, ...req },
    };
    return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            log.debug(`request timeout: op=${op} id=${id} (${timeoutMs}ms)`);
            reject(new Error(l10n.t("Helper response timed out")));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        log.trace(`request send: op=${op} id=${id}`);
        try {
            s.write(JSON.stringify(frame) + "\n");
        } catch (err) {
            pending.delete(id);
            clearTimeout(timer);
            log.debug(`request write-fail: op=${op} id=${id}: ${err instanceof Error ? err.message : String(err)}`);
            reject(err instanceof Error ? err : new Error(String(err)));
        }
    });
}

// ---- 连接维护:connect-first + spawn 兜底 + flock 竞速容忍 ----

function linkTick(): void {
    retryTimer = undefined;
    if (!desiredRunning || sock || connecting) {
        return;
    }
    if (proc && !procEverLinked && Date.now() - procSpawnAt > SPAWN_WAIT_MS) {
        // spawn 后 15s 仍没在线:进程僵死(启动卡死/环境异常),杀掉走退避
        log.warn("spawn 后长期未连接,SIGKILL 走退避重启");
        killOwnProc();
        scheduleRestart();
        return;
    }
    tryConnectOnce();
}

function tryConnectOnce(): void {
    if (!desiredRunning || sock || connecting) {
        return;
    }
    connecting = true;
    try {
        sock = socketFactory(HELPER_SOCKET_PATH, {
            onConnect: () => onSocketConnected(),
            onData: (chunk) => ingestFrameBytes(chunk),
            onClose: () => onSocketClosed(),
            onError: () => { /* close 事件统一处理 */ },
        });
    } catch (err) {
        connecting = false;
        sock = undefined;
        log.warn(l10n.t("Helper failed to start: {0}", err instanceof Error ? err.message : String(err)));
        if (!proc) {
            spawnHelper();
        }
    }
    // 无进程且连接被拒(ECONNREFUSED→close)的场景由 onSocketClosed 处理:spawn
}

function scheduleRetry(ms: number): void {
    if (retryTimer || !desiredRunning) {
        return;
    }
    retryTimer = setTimeout(() => linkTick(), ms);
}

function onSocketConnected(): void {
    connecting = false;
    connected = true;
    lastSocketData = Date.now();
    online = false;
    log.debug("socket connected,自动发 resync(回应=在线信号)");
    void resyncNow();
}

/** 连接后/resync 补发:回应到达=在线(裁定),data 作 graph 推送帧入库 */
async function resyncNow(): Promise<void> {
    if (resyncInFlight || !sock) {
        return;
    }
    resyncInFlight = true;
    try {
        const snap = await resyncSnapshot();
        setOnline(true);
        log.debug(`resync 快照入库:nodes=${snap.nodes?.length ?? 0}`);
        helperPushCallback?.({ kind: "graph", ...snap });
    } catch (err) {
        log.debug(`resync 失败(连接可能已断):${err instanceof Error ? err.message : String(err)}`);
    } finally {
        resyncInFlight = false;
    }
}

function setOnline(v: boolean): void {
    if (v === online) {
        return;
    }
    online = v;
    setHelperRunning(v);
    if (v) {
        if (proc) {
            procEverLinked = true;
        }
        stopPing();
        pingTimer = setInterval(() => {
            // 保活 ping=正经请求(用户裁定 2026-10-07:单一 id 序列,回应按 id 匹配=可应答性
            // 校验,不再即发即忘产孤儿日志;3s 短超时,失败静默——真挂死由看门狗 5s 处置)
            void request("ping", {}, PING_TIMEOUT_MS).catch((err) => {
                log.debug(`keepalive ping failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, PING_INTERVAL_MS);
    } else {
        stopPing();
    }
    if (helperConnectionCallback) {
        helperConnectionCallback(v);
    }
}

function onSocketClosed(): void {
    const wasOnline = online;
    connecting = false;
    sock = undefined;
    connected = false;
    frameBuf = "";
    stopPing();
    online = false;
    // 无条件全拒在飞请求(F 批修,2026-10-07:id=9 悬挂 30s 的根源——旧实现只在
    // hadHello(曾在线)时全拒,从未在线的 socket 上挂着的请求成了孤儿,悬挂整个超时周期)
    failAllPending(l10n.t("Parameter helper process exited"));
    if (wasOnline) {
        setHelperRunning(false);
        if (helperConnectionCallback) {
            helperConnectionCallback(false);
        }
    }
    if (!desiredRunning) {
        return;
    }
    if (wasOnline) {
        // 会话中断(服务端死/被踢):500ms 后重连(服务端若在宽限自退,本轮拒绝→spawn)
        scheduleRetry(500);
        return;
    }
    if (proc) {
        // 自己的进程还在起(rclpy init 需 1~3s):250ms 轮询连它
        scheduleRetry(250);
    } else {
        // 没有服务端可连:自己拉起(flock 竞速败者会自动退出,胜者服务本窗)
        spawnHelper();
    }
}

function spawnHelper(): void {
    if (proc || sock) {
        // 所有权守卫(沿袭):已有活实例绝不覆盖句柄
        log.debug("spawn: SKIP (a live instance already exists; not overwriting the handle)");
        return;
    }
    if (!commandRunner || !scriptPath) {
        log.warn(l10n.t("Helper cannot start: {0}", !commandRunner ? l10n.t("executor not injected") : l10n.t("scriptPath not injected")));
        scheduleRestart();
        return;
    }
    let procRef: child_process.ChildProcess;
    try {
        procRef = commandRunner.spawn(["python3", scriptPath]);
    } catch (err) {
        log.warn(l10n.t("Helper failed to start: {0}", err instanceof Error ? err.message : String(err)));
        scheduleRestart();
        return;
    }
    proc = procRef;
    procSpawnAt = Date.now();
    procEverLinked = false;
    log.info("Helper process spawned (shared server; flock 竞速败者会自动退出)");
    tryConnectOnce();   // 立即试连一次;失败由 close→轮询接管

    procRef.stderr?.setEncoding("utf8");
    procRef.stderr?.on("data", (chunk: string) => {
        const text = chunk.trim();
        if (!text) {
            return;
        }
        // 助手诊断出口(沿袭):[rde-helper:level] 前缀分级落日志,其余一律 warn
        const prefix = /^\[rde-helper:(warn|error)\]\s?/.exec(text);
        const body = prefix ? text.slice(prefix[0].length) : text;
        if (prefix?.[1] === "error") {
            log.error(`助手 stderr:${body}`);
        } else {
            log.warn(`助手 stderr:${body}`);
        }
    });

    procRef.stdout?.setEncoding("utf8");
    procRef.stdout?.on("data", (chunk: string) => {
        // 哑巴哨兵(重设计沿袭):stdout 约定必须永远为空——出现任何行=杂散输出=bug 信号
        const text = chunk.trim();
        if (text) {
            log.warn(`助手 stdout 杂散输出(协议不走 stdio,此为缺陷信号):${text.slice(0, 200)}`);
        }
    });

    procRef.on("exit", (code) => {
        const wasOwner = proc === procRef;
        if (wasOwner) {
            proc = undefined;
        }
        log.debug(`exit: code=${code} wasOwner=${wasOwner} desiredRunning=${desiredRunning}`);
        if (wasOwner) {
            failAllPending(l10n.t("Parameter helper process exited"));
        }
        if (!desiredRunning || sock) {
            // 已停用,或连接已被别的实例(胜者)服务:无需重生
            return;
        }
        if (code === 0) {
            // flock 败者/零客户端自退:胜者应已就绪,直接重连(不走退避)
            scheduleRetry(500);
        } else {
            log.warn(`参数助手进程退出(code=${code}),退避重拉`);
            scheduleRestart();
        }
    });

    procRef.on("error", (err) => {
        // spawn ENOENT 等失败只发 error 不发 exit:不清句柄会留下僵尸 proc
        log.debug(`error: ${err.message} wasOwner=${proc === procRef}`);
        log.warn(`参数助手进程错误:${err.message}`);
        if (proc === procRef) {
            proc = undefined;
            failAllPending(l10n.t("Parameter helper process error"));
            if (desiredRunning) {
                scheduleRestart();
            }
        }
    });
}

function killOwnProc(): void {
    if (proc) {
        try { proc.kill("SIGKILL"); } catch { /* 已退忽略 */ }
    }
}

function scheduleRestart(): void {
    restartAttempts += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(restartAttempts - 1, 5));
    if (restartTimer) {
        clearTimeout(restartTimer);
    }
    log.debug(`restart scheduled: attempt#${restartAttempts} delay=${delay}ms`);
    restartTimer = setTimeout(() => {
        restartTimer = undefined;
        if (desiredRunning && !sock && !proc) {
            spawnHelper();
        }
    }, delay);
}

function failAllPending(message: string): void {
    pending.forEach((p) => {
        clearTimeout(p.timer);
        p.reject(new Error(message));
    });
    pending.clear();
}

/** 客户端状态快照(排障用) */
export function describeHelperState(): string {
    return `proc=${proc ? "有" : "无"}, sock=${sock ? (online ? "在线" : "已连未在线") : "未连"}`
        + `, desiredRunning=${desiredRunning}, 重启尝试=${restartAttempts}, 服务端 pid=${serverPid || "?"}`;
}

// ---- 帧摄入与路由 ----

function ingestFrameBytes(chunk: Buffer): void {
    lastSocketData = Date.now();
    frameBuf += chunk.toString("utf8");
    let idx = frameBuf.indexOf("\n");
    while (idx >= 0) {
        const line = frameBuf.slice(0, idx).trim();
        frameBuf = frameBuf.slice(idx + 1);
        idx = frameBuf.indexOf("\n");
        if (!line) {
            continue;
        }
        let frame: HelperInboundFrame;
        try {
            frame = JSON.parse(line) as HelperInboundFrame;
        } catch {
            // 服务端私有 fd 上不该有坏帧;出现即日志留证(不中断连接)
            log.warn(`助手帧 JSON 非法:${line.slice(0, 200)}`);
            continue;
        }
        handleFrame(frame);
    }
}

function handleFrame(f: HelperInboundFrame): void {
    if ("response" in f && f.response) {
        const resp = f.response;
        serverPid = Number(f.service) || serverPid;
        serverStartTime = Number(f.time) || serverStartTime;
        const id = Number(resp.id);
        const p = Number.isFinite(id) ? pending.get(id) : undefined;
        if (!p) {
            // 孤儿响应检测(沿袭):ping 回应/断线期间迟到响应落这里
            log.trace(`响应 id=${resp.id} 无 pending 匹配(孤儿响应:ping 回应/迟到),已丢弃`);
            return;
        }
        pending.delete(id);
        clearTimeout(p.timer);
        log.trace(`response matched: id=${id} success=${resp.success}`);
        if (resp.success) {
            p.resolve(resp.data);
        } else {
            p.reject(new Error(String(resp.error ?? l10n.t("Helper returned failure"))));
        }
        return;
    }
    if ("heartbeat" in f && f.heartbeat) {
        serverPid = Number(f.service) || serverPid;
        serverStartTime = Number(f.time) || serverStartTime;
        const hb = f.heartbeat;
        emitHeartbeat({
            pid: serverPid, startTimeSec: serverStartTime,
            receivedAtMs: Date.now(), cl: Number(f["cl-num"]) || 0,
            busy: hb.busy, q: hb.q, inf: hb.inf, brk: hb.brk, eq: hb.eq, rss: hb.rss,
        });
        return;
    }
    if ("push" in f && f.push) {
        // 推送帧:直达仓库层(monitor-api 的 ingestHelperPush)
        helperPushCallback?.(f.push as unknown as Record<string, unknown>);
        return;
    }
    // 未知形状:忽略(前向兼容留位)
}

function stopPing(): void {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = undefined;
    }
}

// ---- pid 复用防护(裁定 2026-10-06):杀前核对进程启动 ticks ----

/** 读 /proc/<pid>/stat 的进程启动时刻(clock ticks since boot,第 22 字段);读不到=null */
function readProcStartTicks(pid: number): number | null {
    try {
        const text = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
        const afterComm = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/);
        return Number(afterComm[19]) || null;
    } catch {
        return null;
    }
}

/** 锁文件三字段 {pid, epoch, ticks};读不到=null */
function readLockFile(): { pid: number; ticks: number } | null {
    try {
        const parts = fs.readFileSync(HELPER_LOCK_PATH, "utf-8").trim().split(/\s+/);
        const pid = Number(parts[0]) || 0;
        const ticks = Number(parts[2]) || 0;
        return pid > 0 ? { pid, ticks } : null;
    } catch {
        return null;
    }
}

/** 处决挂死服务端(看门狗路径):pid 来源=锁文件;**杀前核对启动 ticks**——
 *  对不上=pid 已被别的新进程顶用,绝不下手(裁定:防 pid 复用永久杜绝杀错人)。
 *  该服务端可能不是本窗 spawn 的(共享),杀它=所有窗口一起自愈。 */
function killForeignServer(): void {
    const lock = readLockFile();
    if (!lock) {
        killOwnProc();
        return;
    }
    if (lock.ticks > 0) {
        const actual = readProcStartTicks(lock.pid);
        if (actual !== null && actual !== lock.ticks) {
            log.warn(`锁文件 pid=${lock.pid} 启动 ticks 不匹配(记 ${lock.ticks}/实 ${actual})=pid 已换人,不杀`);
            killOwnProc();
            return;
        }
    }
    try {
        process.kill(lock.pid, "SIGKILL");
        log.warn(`已 SIGKILL 服务端 pid=${lock.pid}(自愈;ticks 核对通过)`);
    } catch { /* 已死忽略 */ }
    killOwnProc();
}

/** 看门狗:在线连接 5s 无任何帧(ping 无逐帧应答设计;心跳 1s 一发即生命体征)→
 *  服务端挂死,核对 pid 后 SIGKILL 触发自愈重拉 */
setInterval(() => {
    if (sock && online && desiredRunning && Date.now() - lastSocketData > WATCHDOG_STALE_MS) {
        log.warn("Helper heartbeat lost (>5 s); SIGKILL triggers self-heal");
        killForeignServer();
        sock?.destroy();
    }
}, 1000);
