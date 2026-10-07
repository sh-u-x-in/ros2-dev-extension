# Copyright (c) Microsoft Corporation. All rights reserved.

"""常驻助手 worker 池与帧分发(彻底推倒重来 2026-10-06):
最小负载优先派发(队列最短槽先派,坏节点不扩散)沿袭;
op 签名统一 (req, conn)——订阅类 op(get/unget_param_values)需要连接以记账,
推送域任务经 submit 包装为无连接形态;响应经注入的 respond 闭包回发起连接
(信封在 server 层组装,序列化在连接写线程,不占 worker);
ping 就地应答空 data 不排队;内层任务看门狗(超长警告/硬上限自杀)沿袭。"""

import os
import queue
import threading
import time

from .kernel import TASK_HARD_SEC, TASK_WARN_SEC, disk_log, helper_log
from .ops import OPS

busy_lock = threading.Lock()
busy_count = 0  # 正在执行的业务任务数(遥测字段)
# 各 worker 执行中任务数(派发权重的一半;队列深度只反映"排队",不反映"正在执行"——
# 卡死任务执行期间其队列为空,按队列深度派发会把新请求全部塌缩到同一个 worker 上排队,
# 其余 worker 闲置(单点扩散,D3a 场景实测抓获)。派发权重 = 队列深度 + 执行中任务数)
_worker_busy: list = []


def init_workers(queues):
    """main() 组装时注入队列并定长在飞计数槽(线程起前;此后只读/各 worker 只动自己槽位)"""
    global _queues, _worker_busy
    _queues = queues
    _worker_busy = [0] * len(queues)


def _pick_worker(worker_queues):
    """最小负载优先:选 (队列深度 + 执行中任务数) 最小的 worker。
    只看队列深度的缺陷(实测):执行中的任务不占队列,20s 卡死任务执行期间其槽位
    "看起来空闲",后续请求全部塌缩排队到同一个 worker,其余 worker 闲置——单点扩散。"""
    best = 0
    best_load = _worker_busy[0] + worker_queues[0].qsize()
    for i in range(1, len(worker_queues)):
        load = _worker_busy[i] + worker_queues[i].qsize()
        if load < best_load:
            best, best_load = i, load
        if best_load == 0:
            break   # 真空闲槽(无执行无排队),先到先得
    return best

# 内层看门狗账本:tid → [起始时刻, op 名, 节点, 已警告]
_active: dict = {}
_active_lock = threading.Lock()
_next_tid = 0


# ---- 服务端主动任务(推送域):服务端自己往池里投任务并广播结果 ----


def submit(op_func, req, on_done):
    """推送域任务:投进最短队列,完成后 on_done(ok, data, error) 回调。
    op 统一包装为 (req, conn) 形态(推送任务无连接,conn=None);
    与客户端请求共用池与熔断;on_done 里做 broadcast(在 worker 线程,经发送队列排队)。"""
    def _task(r, _conn):
        return op_func(r)
    idx = _pick_worker(_queues)
    try:
        _queues[idx].put_nowait((None, _task, req, None, time.monotonic(), on_done))
    except queue.Full:
        helper_log("warn", f"submit queue full; dropped server task {op_func.__name__}")


def dispatch(worker_queues, respond, rid, op, req, conn):
    """server 读线程 → 池 的唯一入口。ping 就地应答空 data 不排队(积压再重,
    客户端健康检查永远秒回);未知 op 报错;队列满立即回过载。
    respond(ok, data, error) 已由 main 绑定 (conn, client_pid, client_time, rid)。"""
    if op == "ping":
        respond(True)
        return
    op_func = OPS.get(op)
    if op_func is None:
        helper_log("warn", f"unknown op: {op} (rid={rid}; usually a stale client)")
        respond(False, error="未知 op:" + str(op))
        return
    idx = _pick_worker(worker_queues)
    try:
        worker_queues[idx].put_nowait((rid, op_func, req, conn, time.monotonic(), respond))
    except queue.Full:
        respond(False, error="系统过载,请稍后重试")


def worker_loop(task_queue, idx):
    global busy_count
    while True:
        rid, task, req, conn, queued_at, respond = task_queue.get()
        # 排队等待 >1s 留痕(同槽被慢 op 占住的隐性停顿,沿袭埋点)
        queue_wait_ms = (time.monotonic() - queued_at) * 1000.0
        if queue_wait_ms > 1000.0:
            disk_log(f"排队等待 {queue_wait_ms:.0f}ms:rid={rid} op={getattr(task, '__name__', '?')}"
                     + (f" node={req.get('node')}" if isinstance(req, dict) and req.get("node") else "")
                     + f"(worker#{idx} 占用)")
        with busy_lock:
            busy_count += 1
            _worker_busy[idx] += 1
        tid = _register_task(task, req)
        try:
            data = task(req, conn)
            respond(True, data=data)
            disk_log(f"任务 {getattr(task, '__name__', '?')} ok" + (f" rid={rid}" if rid is not None else "(推送)"))
        except Exception as e:  # noqa: BLE001 — 单任务失败不致死;错误随 respond 回客户端/被推送域丢弃
            helper_log("warn", f"op={getattr(task, '__name__', '?')} failed rid={rid}: {e}")
            disk_log(f"任务 {getattr(task, '__name__', '?')} 失败:{e}")
            respond(False, error=str(e))
        finally:
            with _active_lock:
                _active.pop(tid, None)
            with busy_lock:
                busy_count -= 1
                _worker_busy[idx] -= 1
            task_queue.task_done()


def _register_task(task, req):
    global _next_tid
    with _active_lock:
        _next_tid += 1
        tid = _next_tid
        _active[tid] = [time.monotonic(), getattr(task, "__name__", "?"),
                        req.get("node") if isinstance(req, dict) else None, False]
    return tid


def watchdog_loop():
    """内层任务看门狗(独立线程,1s 扫描):>TASK_WARN_SEC 警告一次(哪个 op 哪个节点
    卡了多长,磁盘日志留案底);>TASK_HARD_SEC 硬上限自杀 os._exit——卡死的线程
    本身救不了,让整个进程干净地死、由扩展的退避重启还世,好过永远占住一个 worker。"""
    while True:
        time.sleep(1.0)
        now = time.monotonic()
        with _active_lock:
            for tid, entry in _active.items():
                elapsed = now - entry[0]
                if elapsed > TASK_HARD_SEC:
                    helper_log("error",
                               f"task hard-timeout: op={entry[1]} node={entry[2]}"
                               f" {elapsed:.0f}s > {TASK_HARD_SEC:.0f}s → self-exit(2)")
                    disk_log(f"看门狗:任务硬超时 op={entry[1]} node={entry[2]}"
                             f" {elapsed:.0f}s → 干净退场尝试+2s 硬退兜底 (pid={os.getpid()})")
                    from . import ros_domain
                    ros_domain.graceful_exit(2)   # 卡死线程救不了,但图摘除尽力而为
                    os._exit(2)
                if elapsed > TASK_WARN_SEC and not entry[3]:
                    entry[3] = True
                    helper_log("warn",
                               f"task long-running: op={entry[1]} node={entry[2]}"
                               f" {elapsed:.0f}s (>{TASK_WARN_SEC:.0f}s, monitoring)")
                    disk_log(f"看门狗:任务超长 op={entry[1]} node={entry[2]} {elapsed:.0f}s")
