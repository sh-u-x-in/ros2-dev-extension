// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file param-helper-client.ts
 * 常驻助手客户端(2026-10-06 彻底推倒重来:信封帧协议)。
 *
 * 架构:全局唯一助手服务端 + 多窗口客户端,一切帧复用一条固定路径 Unix socket,
 * 一行 JSON 一帧。**上行首帧=hello 环境指纹握手**(P4:proto+ROS_VERSION/DISTRO/DOMAIN_ID/RMW,
 * 服务端不匹配回 deny 并踢除——客户端收到 deny 置失败态停连),此后上行信封
 * {client,id,time,request};下行 response|heartbeat|push|deny。连上后自动发 resync
 * (回应=全量图快照,**回应到达=在线**);心跳=ping(2s,就地秒回);看门狗 5s 无任何帧 →
 * 读锁文件 pid+启动 ticks、核对 /proc 防 pid 复用杀错人 → SIGKILL 自愈重拉。
 * 连接策略 connect-first 沿袭:先试连现有服务端(可能是别的窗口拉起的),连不上才 spawn;
 * spawn 竞速败者 flock 仲裁自动退出,连接轮询自然命中胜者。
 * P4 围栏:spawn 前环境门(门关绝不 spawn)+ 失败熔断(瞬态 3 次/预检码 100+掩码立即;
 * 熔断自动停 desiredRunning 并上抛原因——重试风暴根治),停止语义不变。
 */

import { l10n } from "vscode";

import * as child_process from "child_process";
import * as fs from "fs";
import * as net from "net";

import { getLogger } from "../../../../logger";
import { setHelperRunning } from "./helper-state";
import type { CommandRunner } from "../../../api";
import {
    HELLO_ENV_KEYS, HELLO_ENV_SOURCES, HELPER_LOCK_PATH, HELPER_PROTO_VERSION, HELPER_SOCKET_PATH,
    type HelperFormMap, type HelperGraphSnapshot, type HelperHelloEnv, type HelperHelloFrame,
    type HelperInboundFrame, type HelperRequestFrame,
} from "./param-helper-protocol";
import { shouldReplaceServer } from "./param-helper-versioning";

/** 助手模块日志 */
const log = getLogger("param-helper");

/** 注入的 CommandRunner(spawn 自动注入 ROS env) */
let commandRunner: CommandRunner | undefined;

export function setParamHelperCommandRunner(cr: CommandRunner): void {
    commandRunner = cr;
}

/** 注入的本扩展版本(版本治理:比对锁文件第 4 字段,裁杀旧拉新;规范=VERSION-CONTROL.md。
 *  不注入/不可解析=治理禁用,绝不杀——组合根漏注是安全态而非故障态) */
let extensionVersion: string | undefined;

export function setParamHelperExtensionVersion(v: string | undefined): void {
    extensionVersion = v;
}

/** 测试缝:重定向锁文件路径(默认 /tmp/rde_param_helper.lock;无头测试指临时文件) */
let lockPathOverride: string | undefined;

export function setParamHelperLockPathForTest(p: string | undefined): void {
    lockPathOverride = p;
}

/** 注入的环境门面(P4:hello 指纹取 env;spawn 闸查 getEnvIssue——client 零 ros2 直连,组合根注入) */
let envFacade: { getEnv(): any | undefined; getEnvIssue(): string | null } | undefined;

export function setParamHelperEnvFacade(facade: { getEnv(): any | undefined; getEnvIssue(): string | null }): void {
    envFacade = facade;
}

/** 注入的失败回调(P4 熔断自动停):熔断/门拒/握手拒绝时上抛原因,状态页转 postMessage 到页面 */
let failureCallback: ((reason: string) => void) | undefined;

export function setParamHelperFailureCallback(cb: ((reason: string) => void) | undefined): void {
    failureCallback = cb;
}

/** 熔断线(瞬态 spawn 失败连续次数;预检失败不走此线——退出码 100+掩码立即熔断) */
const TRANSIENT_BREAKER_LIMIT = 3;
let breakerTripped = false;

/** 启动代数(2026-10-18):start/stop 各 +1——旧 startHelperFlow 确认窗据此识别
 *  「已被更新的启动/停止接管」而静默退出,不再发覆盖新流程的误导文案
 *  (红队验证 CONFIRMED:failureCallback 的 error 会重开按钮,15s 窗口内重入真实可达) */
let startGeneration = 0;
/** 熔断首因与其发生代数(trip 幂等=首因优先;探针 helperFailureSignal 按(代,因)判读) */
let tripReason: string | undefined;
let tripGeneration = 0;
/** socket 会话身份(2026-10-18 加固):onConnect/onData/onClose 闭包据此丢弃换代后的
 *  迟到事件——stop/trip 后旧 socket 的异步 close/残帧不得清掉新会话状态或污染 frameBuf */
let currentSession: object | undefined;

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
const HEARTBEAT_DEAD_MS = 10000;    // 在线但 10 拍心跳不到 → 服务端广播层死(僵尸助手),SIGKILL 自愈
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
    lastHeartbeatAtMs = Date.now();
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
let lastHeartbeatAtMs: number | undefined;   // 最近一次心跳帧到达(2026-10-19:看门狗心跳维度)
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

/** 启动助手(幂等:已在线或在连则忽略;脚本路径由调用方注入)。
 *  P4:显式用户动作=熔断复位(计数/标志清零,重新开始计数)。
 *  返回本次启动代数(配 helperFailureSignal(gen) 做确认窗快速失败探针)。 */
export function startParamHelper(script: string): number {
    startGeneration += 1;
    scriptPath = script;
    desiredRunning = true;
    breakerTripped = false;
    tripReason = undefined;
    tripGeneration = 0;
    restartAttempts = 0;
    if (restartTimer) {
        // 挂起的退避重拉必须与主动启动合并(沿袭):否则定时器到点无条件
        // spawn 会覆盖语义;先清,连接维护循环自行决定 spawn 时机
        clearTimeout(restartTimer);
        restartTimer = undefined;
    }
    if (sock || connecting) {
        return startGeneration;
    }
    linkTick();
    return startGeneration;
}

/** 停止助手(状态页关闭/手动停止):仅断开本窗口连接——共享服务端可能还有别的
 *  窗口在用,绝不 SIGKILL;零客户端 10s 宽限由服务端自退,退出回调因
 *  desiredRunning=false 不重拉。spawn 出的进程句柄自然收敛。 */
export function stopParamHelper(): void {
    desiredRunning = false;
    // 代数前进:在途 start 确认窗据此识别「已被停止接管」而静默退出
    startGeneration += 1;
    breakerTripped = false;
    tripReason = undefined;
    tripGeneration = 0;
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
        }, timeoutMs); // P4 修:此前写死 REQUEST_TIMEOUT_MS,ping 3s/resync 15s 全部退化为 30s
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
    // 版本治理(2026-10-20,规范=VERSION-CONTROL.md):只有「无自有进程、要去连现成
    // 服务端」时比对锁文件版本——比我旧/不可解析 → 杀旧(pid 探活+killForeignServer 内
    // ticks 核对防 pid 复用误杀)后重排队,连接被拒路径自然拉起本版本;比我新/相等 →
    // 让位/共享。单向淘汰=多客户端跨版本共存无杀拉震荡。杀后旧锁残留磁盘:下一 tick
    // pid 探活失败直接放行 connect,不会循环杀。
    if (!proc) {
        const lock = readLockFile();
        if (lock && isPidAlive(lock.pid) && shouldReplaceServer(lock.version, extensionVersion)) {
            log.info(`发现旧版本助手服务端(锁版本=${lock.version ?? "无字段"}),杀旧拉新(本版本=${extensionVersion})`);
            killForeignServer();
            scheduleRetry(300);
            return;
        }
    }
    tryConnectOnce();
}

function tryConnectOnce(): void {
    if (!desiredRunning || sock || connecting) {
        return;
    }
    connecting = true;
    // 会话身份必须在 socketFactory 调用前分配(假 socket 工厂可能同步回调 connect)
    const session: object = {};
    currentSession = session;
    try {
        sock = socketFactory(HELPER_SOCKET_PATH, {
            onConnect: () => { if (currentSession === session) { onSocketConnected(); } },
            onData: (chunk) => { if (currentSession === session) { ingestFrameBytes(chunk); } },
            onClose: () => { if (currentSession === session) { onSocketClosed(); } },
            onError: () => { /* close 事件统一处理 */ },
        });
    } catch (err) {
        currentSession = undefined;
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
    // P4:首帧 hello 环境指纹握手(服务端不匹配回 deny → tripFailure 停连),通过后 resync 照旧
    sendHello();
    log.debug("socket connected, hello sent,自动发 resync(回应=在线信号)");
    void resyncNow();
}

/** 组客户端环境指纹(未设归一 "0",与服务端口径一致;键=HELLO_ENV_KEYS 查表派生,
 *  禁手写裸键——2026-10-18 短键名恒 deny 事故的根治点;导出供契约测试) */
export function buildHelloEnv(): HelperHelloEnv {
    const env = envFacade?.getEnv() ?? {};
    const s = (v: unknown): string => (v === undefined || v === null || v === "") ? "0" : String(v);
    const out = {} as HelperHelloEnv;
    for (const key of HELLO_ENV_KEYS) {
        out[key] = s(env[HELLO_ENV_SOURCES[key]]);
    }
    return out;
}

/** 发 hello 首帧(P4;无响应帧——通过即静默,不匹配走 deny 下行) */
function sendHello(): void {
    if (!sock) {
        return;
    }
    // 帧走 HelperHelloFrame 类型收口:hello 字段名/嵌套有编译期约束,漂移在编译期暴露
    const frame: HelperHelloFrame = {
        client: `exthost-${process.pid}`,
        id: nextId++,
        time: CLIENT_START_TIME,
        hello: { proto: HELPER_PROTO_VERSION, env: buildHelloEnv() },
    };
    try {
        sock.write(JSON.stringify(frame) + "\n");
    } catch (err) {
        log.warn(`hello write-fail: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** 连接后/resync 补发:回应到达=在线(裁定),data 作 graph 推送帧入库。
 *  续体守卫(2026-10-18):await 期间会话可能已换代(trip/stop/重连)——
 *  旧快照不得置在线、不得覆盖新会话的图数据。 */
async function resyncNow(): Promise<void> {
    if (resyncInFlight || !sock) {
        return;
    }
    const session = currentSession;
    resyncInFlight = true;
    try {
        const snap = await resyncSnapshot();
        if (currentSession !== session || !connected) {
            log.debug("resync 快照丢弃(会话已换代/连接已断)");
            return;
        }
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
        lastHeartbeatAtMs = Date.now(); // 在线起点重置心跳计时(首拍 1s 内应到)
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
    // P4 环境闸:门关(含陈旧)绝不 spawn——tryConnectOnce 异常/onSocketClosed/退避到点
    // 三个自愈入口全部汇于此,单点覆盖;失败即熔断停(不退避,重试风暴根治)
    const envIssue = envFacade?.getEnvIssue() ?? null;
    if (envIssue !== null) {
        tripFailure(l10n.t("No usable ROS 2 environment detected; cannot start the helper. Reason: {0}", envIssue));
        return;
    }
    if (!commandRunner || !scriptPath) {
        log.warn(l10n.t("Helper cannot start: {0}", !commandRunner ? l10n.t("executor not injected") : l10n.t("scriptPath not injected")));
        scheduleRestart();
        return;
    }
    let procRef: child_process.ChildProcess;
    try {
        // --ext-version:版本治理的传输通道(规范=VERSION-CONTROL.md;服务端写进锁文件
        // 第 4 字段)。走 argv 而非 spawn env——CommandRunner 的 options.env 是整体替换
        // 不是合并,搭车会把 ROS env 抽掉。
        procRef = commandRunner.spawn(["python3", scriptPath, "--ext-version", extensionVersion || "0"]);
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
        if (!wasOwner) {
            // 非属主 exit(句柄已被更新进程顶替):迟到事件绝不给新启动记失败/熔断
            return;
        }
        if (!desiredRunning || sock) {
            // 已停用,或连接已被别的实例(胜者)服务:无需重生
            return;
        }
        if (code === 0) {
            // flock 败者/零客户端自退:胜者应已就绪,直接重连(不走退避)
            scheduleRetry(500);
            return;
        }
        if (code !== null && code >= 100 && code <= 100 + PREFLIGHT_MASK_ALL) {
            // P4:Python 启动预检失败(位掩码=环境/rclpy 类问题,重试无益)→ 立即熔断。
            // 区间必须盖满 100+0x1F=131:曾写 100..115,含 0x10 位的 16 个组合码(116..131)
            // 漏接落进瞬态重拉(违背「预检立即熔断不重拉」,位文案也永不显示),2026-10-20 补钉
            tripFailure(preflightIssueText(code));
            return;
        }
        log.warn(`参数助手进程退出(code=${code}),退避重拉`);
        scheduleRestart();
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
    if (breakerTripped) {
        return;
    }
    restartAttempts += 1;
    if (restartAttempts >= TRANSIENT_BREAKER_LIMIT) {
        // P4 熔断自动停:瞬态失败连续达线 → 停止重拉,原因上抛(状态行),用户修好后再次点击重来
        tripFailure(l10n.t("Helper start abandoned after {0} failed spawn attempts; fix the environment and click Start again.", String(restartAttempts)));
        return;
    }
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

/** Python 预检位掩码全宽(位定义见 assets/ros/param_helper.py:0x01 rclpy/0x02 rcl_interfaces/
 *  0x04 lib/0x08 main/0x10 disk_log)——退出码路由区间=100+全宽,防上界写死漏接组合码 */
const PREFLIGHT_MASK_ALL = 0x01 | 0x02 | 0x04 | 0x08 | 0x10;

/** 预检退出码译码(P4 位掩码;100+mask,位定义见 assets/ros/param_helper.py) */
export function preflightIssueText(code: number): string {
    const mask = code - 100;
    const parts: string[] = [];
    if (mask & 0x01) {
        parts.push(l10n.t("rclpy is missing or broken (ROS 2 Python bindings)"));
    }
    if (mask & 0x02) {
        parts.push(l10n.t("rcl_interfaces is missing or broken"));
    }
    if (mask & 0x04) {
        parts.push(l10n.t("param_helper_lib failed to import (damaged installation?)"));
    }
    if (mask & 0x08) {
        parts.push(l10n.t("param_helper_lib.main is not callable (cross-version drift?)"));
    }
    if (mask & 0x10) {
        parts.push(l10n.t("kernel.disk_log is not callable (cross-version drift?)"));
    }
    return l10n.t("Helper preflight failed (exit code {0}): {1}", String(code), parts.join("; ") || l10n.t("unknown preflight bits"));
}

/** P4 熔断自动停:停一切重连/重拉,desiredRunning 复位,原因经 failureCallback 上抛状态页。
 *  幂等=首因优先(链式失败里第一个原因通常是根因);frameBuf/serverPid/serverStartTime
 *  一并清残(2026-10-18 加固:残帧不拼接新会话,状态快照不报陈旧 pid)。 */
function tripFailure(reason: string): void {
    if (breakerTripped) {
        return;
    }
    breakerTripped = true;
    tripReason = reason;
    tripGeneration = startGeneration;
    desiredRunning = false;
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
    connecting = false;
    frameBuf = "";
    serverPid = 0;
    serverStartTime = 0;
    if (sock) {
        const s = sock;
        sock = undefined;
        s.destroy(); // onClose 因 desiredRunning=false 不重连
    }
    setHelperRunning(false);
    failAllPending(l10n.t("Parameter helper stopped"));
    log.warn(l10n.t("Helper failure breaker tripped: {0}", reason));
    failureCallback?.(reason);
}

/** 失败信号(启动确认窗快速失败探针,2026-10-18):
 *  - {kind:"tripped",reason}:本代启动已被熔断(首因;页面已经 failureCallback 收到同文);
 *  - {kind:"superseded"}:已有更新的 start/stop 接管(旧确认窗应静默退出,不再发任何文案);
 *  - undefined:无信号,继续等待。 */
export function helperFailureSignal(generation: number): { kind: "tripped"; reason: string } | { kind: "superseded" } | undefined {
    if (startGeneration !== generation) {
        return { kind: "superseded" };
    }
    if (breakerTripped && tripGeneration === generation) {
        return { kind: "tripped", reason: tripReason ?? "" };
    }
    return undefined;
}

/** 测试隔离缝:清空全部模块级状态(含 stop 不覆盖的熔断/proc/注入缝/心跳回放)。 */
export function _resetForTest(): void {
    stopParamHelper();
    startGeneration = 0;
    breakerTripped = false;
    tripReason = undefined;
    tripGeneration = 0;
    currentSession = undefined;
    scriptPath = "";
    proc = undefined;
    procSpawnAt = 0;
    procEverLinked = false;
    restartAttempts = 0;
    desiredRunning = false;
    nextId = 1;
    lastSocketData = 0;
    resyncInFlight = false;
    frameBuf = "";
    serverPid = 0;
    serverStartTime = 0;
    online = false;
    connected = false;
    connecting = false;
    sock = undefined;
    lastHeartbeat = undefined;
    lastHeartbeatAtMs = undefined;
    heartbeatListeners.clear();
    commandRunner = undefined;
    envFacade = undefined;
    failureCallback = undefined;
    helperPushCallback = undefined;
    helperConnectionCallback = undefined;
    socketFactory = defaultSocketFactory;
    extensionVersion = undefined;
    lockPathOverride = undefined;
    setHelperRunning(false);
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
    if ("deny" in f && f.deny) {
        // P4:hello 指纹不匹配/首帧违规——服务端已发 deny 并踢除;置失败态停连(熔断语义)。
        // reason 由服务端给全量明细(2026-10-18 起含失配键),此处原样透传不加工
        tripFailure(l10n.t("Helper connection rejected: {0}", String(f.deny.reason)));
        return;
    }
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

/** 锁文件字段 {pid, epoch, ticks, version};version=第 4 字段(0.0.3- 遗留锁缺失=undefined);
 *  读不到文件=null */
function readLockFile(): { pid: number; ticks: number; version: string | undefined } | null {
    try {
        const parts = fs.readFileSync(lockPathOverride ?? HELPER_LOCK_PATH, "utf-8").trim().split(/\s+/);
        const pid = Number(parts[0]) || 0;
        const ticks = Number(parts[2]) || 0;
        return pid > 0 ? { pid, ticks, version: parts[3] } : null;
    } catch {
        return null;
    }
}

/** pid 探活(信号 0):ESRCH=不存在;EPERM=存在但无权(视为活) */
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
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
 *  服务端挂死,核对 pid 后 SIGKILL 触发自愈重拉。
 *  心跳维度(2026-10-19 僵尸助手实证):请求应答正常(ping 每 2s 刷新帧计时)但
 *  心跳/推送广播全死的服务端,帧计时永远新鲜——加 10s 无心跳帧这一独立维度,
 *  广播层死也能自愈(僵尸助手=housekeeping 线程死于 stderr 断管的服务端) */
setInterval(() => {
    if (!sock || !online || !desiredRunning) {
        return;
    }
    const framesStale = Date.now() - lastSocketData > WATCHDOG_STALE_MS;
    const beatsDead = lastHeartbeatAtMs !== undefined
        && Date.now() - lastHeartbeatAtMs > HEARTBEAT_DEAD_MS;
    if (!framesStale && !beatsDead) {
        return;
    }
    if (beatsDead && !framesStale) {
        log.warn("Helper broadcast layer lost (>10 s online, responses alive, zero heartbeat frames); SIGKILL triggers self-heal");
    } else {
        log.warn("Helper heartbeat lost (>5 s); SIGKILL triggers self-heal");
    }
    killForeignServer();
    sock?.destroy();
}, 1000);
