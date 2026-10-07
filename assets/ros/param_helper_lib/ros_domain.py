# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手 ROS 域(十九轮批4b):node/executor 共享句柄、client 缓存与生命周期管理、
ros_call(异步+超时重试)、墓碑清扫与闲置 TTL 兜底。
共享可变句柄(node/executor)由 main() 启动时赋值到本模块,其余线程此后只读访问。"""

import os
import threading
import time

from rclpy.node import Node

from .kernel import (
    CLIENT_IDLE_TTL_SEC, REQUEST_TIMEOUT_SEC,
    WAIT_SERVICE_SEC, disk_log, helper_log,
)

# ---- 共享句柄(main() 启动时赋值;executor 线程 spin 此后只读) ----
node: Node  # type: ignore[assignment]
executor = None

# ---- client 缓存(观察者效应治理的核心数据结构) ----
clients_lock = threading.Lock()
clients = {}
client_last_used = {}
client_inflight = {}
# 自我端点登记(2026-09-27 观察者效应治理):client 服务全名 → target 节点名。
# 图语义"服务存在 = 有 server 或有 client",自己的 client 会把服务名顶进自己读的图;
# 对外输出(graph/lifecycle_nodes/差分)统一按"自我 client 且 target 节点已不存在"过滤——
# 只滤死 target:target 还活着说明真 server 存在,参数服务入口必须保留可调用
own_service_targets: dict = {}
# 节点熔断器(用户裁定节奏 2026-10-06):ros_call 对某节点超时/服务未发现 → 冷却 30s 内
# 后续调用**立即失败**;冷却过期后下一次尝试按正常首次触达给满 10s(探测帽已裁撤),
# 成功即恢复、失败再入冷却——10s 等待/30s 熔断,以此往复。键=canon 节点全名。
BREAKER_COOLDOWN_SEC = 30.0
breaker_until: dict = {}
# 节点串行访问(用户裁定 2026-10-06"单点卡死绝不扩散"的字面落实):同一节点任一时刻
# 至多 1 个在途 ros_call——卡住节点最多烧 1 个 worker(10s 一轮),后续同节点请求
# (含推送任务)**立即拒绝**不排队;推送幂等可重触发,拒绝即跳过零损失。
node_busy: set = set()
_busy_lock = threading.Lock()


def _canon_node(name):
    """节点全名归一:统一前导斜杠(/foo、foo/、foo → /foo)——登记与"target 是否存活"
    比较两侧共用,避免客户端传参格式差异导致活节点参数服务被误当僵尸滤掉"""
    stripped = name.strip("/")
    return "/" + stripped if stripped else "/"


def _client_key(target, suffix):
    """client 缓存键:target 归一(与墓碑清扫/僵尸过滤的节点全集口径一致)"""
    return (_canon_node(target), suffix)


def get_client(target, srv_type, suffix):
    key = _client_key(target, suffix)
    with clients_lock:
        client = clients.get(key)
        if client is not None:
            client_last_used[key] = time.monotonic()
            return client
    # 慢路径(create_client 走 DDS 发现,毫秒级)在锁外执行,不阻塞差分/清理;
    # 竞争败者自毁多余实例
    new_client = node.create_client(srv_type, target + suffix)
    with clients_lock:
        existing = clients.get(key)
        if existing is not None:
            try:
                node.destroy_client(new_client)
            except Exception:  # noqa: BLE001 — 败者自毁失败仅泄漏一个实体,不影响正确性
                pass
            client_last_used[key] = time.monotonic()
            return existing
        clients[key] = new_client
        own_service_targets[_canon_node(target) + suffix] = _canon_node(target)
        client_last_used[key] = time.monotonic()
        return new_client


def _destroy_client(key):
    """统一销毁:锁内摘字典与登记簿,锁外 destroy_client(避免持锁调 rclpy)。
    锁内二次校验 in-flight——调用方都是"锁外预筛、锁外销毁",预筛到销毁之间
    其他线程可能走完 get_client+inflight++ 拿到该 client,不校验会误杀在用 client"""
    with clients_lock:
        if client_inflight.get(key, 0) > 0:
            return  # 挑出 stale 后被抢用:放弃本次销毁,交由 TTL/下轮差分兜底
        client = clients.pop(key, None)
        client_last_used.pop(key, None)
        client_inflight.pop(key, None)
        own_service_targets.pop(key[0] + key[1], None)
    if client is not None:
        try:
            node.destroy_client(client)
        except Exception as e:  # noqa: BLE001 — 销毁失败留痕即可
            helper_log("warn", f"client destroy failed {key}: {e}")


def ros_call(target, srv_type, suffix, request, timeout=REQUEST_TIMEOUT_SEC):
    """异步发起 + 事件等待;超时显式 remove_pending_request 释放 DDS 资源。
    全程持有 in-flight 计数——清理/清扫循环据其跳过在用 client(防误杀,2026-09-27 真接线)。
    **节点串行访问**(用户裁定 2026-10-06):同一节点任一时刻至多 1 个在途调用——
    卡住的节点其一切服务都会卡住,不分类访问就会同时烧 3~4 个线程;单飞后卡死节点
    最多占 1 个 worker,后续同节点调用(含推送任务)**立即拒绝**不排队,推送拒绝=跳过。
    **熔断节奏**(用户裁定 2026-10-06):10s 等待 → 失败开断 30s → 冷却后下一次按正常
    首次触达给满 10s(探测帽裁撤)→ 以此往复;成功即摘账。键=canon 节点全名。"""
    key = _client_key(target, suffix)
    bkey = _canon_node(target)   # 熔断/串行键=节点级
    until = breaker_until.get(bkey, 0)
    now = time.monotonic()
    if now < until:
        disk_log(f"ros_call {target}{suffix} 熔断快失败(剩余 {until - now:.0f}s)")
        raise RuntimeError(f"节点疑似卡死/离线,熔断中(剩余 {until - now:.0f}s 后重试)")
    with _busy_lock:
        if bkey in node_busy:
            disk_log(f"ros_call {target}{suffix} 串行跳过(已有在途调用)")
            raise RuntimeError("节点串行访问中(已有请求在途),本次跳过")
        node_busy.add(bkey)
    client = get_client(target, srv_type, suffix)
    with clients_lock:
        client_inflight[key] = client_inflight.get(key, 0) + 1
    try:
        wt0 = time.monotonic()
        # 首触上限 3s(P2):3s 都发现不了的服务本就异常,快速失败入熔断,
        # 不再陪卡死节点烧满 10s(响应等待仍用 timeout=10s,慢而活着的节点需要它)
        if not client.wait_for_service(timeout_sec=WAIT_SERVICE_SEC):
            breaker_until[bkey] = time.monotonic() + BREAKER_COOLDOWN_SEC
            disk_log(f"ros_call {target}{suffix} 服务未发现(等了 {WAIT_SERVICE_SEC}s) → 节点熔断 {BREAKER_COOLDOWN_SEC:.0f}s")
            raise RuntimeError("服务未发现(节点不存在或未就绪)")
        # 慢服务发现留痕(十八轮埋点沿袭):正常毫秒级,秒级=DDS 发现收敛/节点半死
        ws_ms = (time.monotonic() - wt0) * 1000.0
        if ws_ms > 1000.0:
            disk_log(f"ros_call {target}{suffix} wait_for_service 耗时 {ws_ms:.0f}ms(慢发现)")
        done = threading.Event()
        outcome = {}

        def on_done(future):
            try:
                outcome["resp"] = future.result()
            except Exception as e:  # noqa: BLE001
                outcome["error"] = str(e)
            done.set()

        future = client.call_async(request)
        future.add_done_callback(on_done)
        if not done.wait(timeout):
            # 响应超时(转换回调阻塞期,节点执行器忙,一切服务排队)→ 开节点级熔断
            try:
                client.remove_pending_request(future)
            except Exception:
                pass
            breaker_until[bkey] = time.monotonic() + BREAKER_COOLDOWN_SEC
            disk_log(f"ros_call {target}{suffix} 响应超时({timeout}s) → 节点熔断 {BREAKER_COOLDOWN_SEC:.0f}s")
            raise RuntimeError("服务响应超时(节点不存在或未就绪)")
        if "error" in outcome:
            raise RuntimeError(outcome["error"])
        if bkey in breaker_until:
            disk_log(f"ros_call {target}{suffix} 熔断恢复(节点响应正常)")
            breaker_until.pop(bkey, None)
        return outcome["resp"]
    finally:
        with _busy_lock:
            node_busy.discard(bkey)
        with clients_lock:
            client_inflight[key] = client_inflight.get(key, 0) - 1


def sweep_clients_for_removed_nodes(removed_nodes):
    """墓碑清扫(2026-09-27):节点从图里消失 → 立即销毁指向它的缓存 client。
    ROS 2 图语义"服务存在 = 有 server 或有 client"——自己的 client 会把死节点的
    参数/生命周期服务名顶在图里形成僵尸条目(实机实验证实,挂留至 TTL);
    in-flight>0 的跳过(防图抖动误杀在用 client,漏网的由 TTL 兜底)"""
    if not removed_nodes:
        return
    dead = set(removed_nodes)
    with clients_lock:
        stale = [key for key in list(clients.keys())
                 if key[0] in dead and client_inflight.get(key, 0) == 0]
        # 熔断账本同步清(节点都没了,冷却记录无意义;节点级键=canon 全名)
        for n in dead:
            breaker_until.pop(n, None)
    for key in stale:
        _destroy_client(key)
    if stale:
        disk_log(f"墓碑清扫:节点消失,销毁 {len(stale)} 个缓存 client(节点 {sorted({k[0] for k in stale})})")


def total_inflight():
    """在飞 ros_call 总数(遥测帧 inf 字段)"""
    with clients_lock:
        return sum(client_inflight.values())


def graceful_exit(code):
    """干净退场(F5 实测僵尸窗口收口):先 rclpy 干净退出——destroy_node/shutdown 会向
    DDS 发参与者 dispose,对端**立即**把本节点从图里摘掉;再 os._exit 硬退——解释器
    终局清理会与仍在 DDS C 层调用中的守护线程竞态(十八轮实证偶发 SIGABRT),必须绕开。
    兜底:shutdown 若被卡死线程拖住,2s 定时器强杀,退场绝不超时。
    进程死透后无任何"ROS 缓存"残留——client 缓存/熔断账本/订阅全在进程内,随进程湮灭。"""
    def _hard():
        os._exit(code)
    watchdog = threading.Timer(2.0, _hard)
    watchdog.daemon = True
    watchdog.start()
    try:
        if node is not None:
            node.destroy_node()
    except Exception as e:  # noqa: BLE001 — 半死状态下销毁失败不强求,定时器兜底
        disk_log(f"graceful_exit: destroy_node 失败({e}),硬退兜底")
    try:
        import rclpy
        if rclpy.ok():
            rclpy.shutdown()
    except Exception as e:  # noqa: BLE001
        disk_log(f"graceful_exit: rclpy.shutdown 失败({e}),硬退兜底")
    disk_log(f"graceful_exit: DDS dispose 已发,硬退 code={code}")
    _hard()


def client_cleanup_loop():
    """闲置 TTL 兜底清理(主通道=墓碑清扫);in-flight>0 的跳过(防误杀)。
    重设计增补(P10):顺带清扫三处慢性泄漏中的两处——breaker_until 里过期>5min
    的残留条目(节点永不恢复时条目只增不减)、缓存已销毁但计数残留的
    client_inflight 零键(第三处泄漏=旧 save 落盘缓存,已随落盘归客户端清场)。"""
    while True:
        time.sleep(60)
        with clients_lock:
            now = time.monotonic()
            stale = [key for key, last in client_last_used.items()
                     if now - last > CLIENT_IDLE_TTL_SEC and client_inflight.get(key, 0) == 0]
            dead_breakers = [k for k, until in breaker_until.items() if now - until > 300.0]
            orphan_inflight = [k for k, v in client_inflight.items() if v <= 0 and k not in clients]
            for k in dead_breakers:
                breaker_until.pop(k, None)
            for k in orphan_inflight:
                client_inflight.pop(k, None)
        if dead_breakers or orphan_inflight:
            disk_log(f"泄漏清扫:breaker 残留 {len(dead_breakers)} 条,"
                     f"inflight 零键 {len(orphan_inflight)} 个")
        for key in stale:
            _destroy_client(key)
