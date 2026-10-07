# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手服务端(彻底推倒重来 2026-10-06):单固定路径 Unix socket,信封帧协议。
职责:flock 冷启动仲裁、accept 即注册连接(无握手)、上行信封解析与派发、
response 只回发起连接、push 广播与 param 定向推送(按订阅账本过滤)、
服务端每秒心跳(带负荷,加权采样)、半死连接清理(ping 超时)、零客户端宽限自退。
帧=一行 JSON;上行信封 {client,id,time,request{op,...}},
下行信封 {service,time,cl-num} + response|heartbeat|push 三选一。
无版本握手(插件从未发布,无历史);pid 复用防护靠 time(启动时刻)字段。"""

import fcntl
import json
import os
import queue
import socket
import threading
import time

from .kernel import (
    CLIENT_STALE_SEC, GRACE_EXIT_SEC, LOCK_PATH, MAX_FRAME_BYTES,
    SEND_QUEUE_MAX, SOCKET_PATH, TELEMETRY_INTERVAL_SEC,
    TELEMETRY_SAMPLE_INTERVAL_SEC, disk_log, helper_log,
)

# ---- 进程级状态 ----
_START_WALL = time.time()      # 服务端启动时刻(下行信封 time 字段;客户端据此推算 up/识别重启)
_lock_fd = None
_clients: dict = {}            # conn → {label, client_time, last_seen, sendq, alive, ledger}
_clients_lock = threading.Lock()
_ever_connected = False
_zero_since = None             # 连接数归零的起始时刻(宽限计时)

# 由 main() 注入:dispatch(conn, client_pid, client_time, rid, op, req)——业务请求进池的入口
_dispatch = None
# 由 main() 注入:() → dict——遥测业务字段(busy/q/inf/brk/eq/rss)
_telemetry_provider = None


def acquire_lock():
    """flock 非阻塞抢锁;抢到=本进程是服务端,抢不到=已有服务端在跑,调用方应立即退出。
    锁文件记 pid/启动epoch/进程启动ticks——客户端杀进程前按启动 ticks 核对,防 pid 复用杀错人。
    flock 进程死亡内核自动释放——锁永远不会陈旧。"""
    global _lock_fd
    fd = os.open(LOCK_PATH, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return False
    _lock_fd = fd
    os.ftruncate(fd, 0)
    os.write(fd, f"{os.getpid()} {int(time.time())} {_proc_start_ticks()}\n".encode("utf-8"))
    return True


def _proc_start_ticks():
    """本进程启动时刻(clock ticks since boot;/proc/self/stat 第 22 字段);读不到=0"""
    try:
        with open("/proc/self/stat", "r", encoding="utf-8") as f:
            return int(f.read().rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return 0


def _cleanup():
    """退出前摘 socket 文件(失败静默——下次启动按尸体清理)"""
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass


def _kick(conn, reason):
    """踢除连接:shutdown 唤醒读线程,close 让写线程的 sendall 失败;账本随连接条目湮灭"""
    with _clients_lock:
        entry = _clients.pop(conn, None)
    try:
        conn.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        conn.close()
    except OSError:
        pass
    if entry is not None:
        entry["alive"] = False
        disk_log(f"客户端踢除({reason};标签={entry.get('label')},"
                 f"剩余连接 {len(_clients)})")


def _envelope():
    """下行信封:service=pid,time=服务端启动时刻,cl-num=当前连接数(发送时点)"""
    with _clients_lock:
        cl = len(_clients)
    return {"service": os.getpid(), "time": _START_WALL, "cl-num": cl}


def send_response(conn, client_pid, client_time, rid, ok, data=None, error=None):
    """response 帧只回发起连接;time 原样带回上行帧的 time(客户端启动时刻)。
    连接已死/找不到=响应随连接消亡(客户端超时兜底),静默。"""
    response = {"client": client_pid, "id": rid, "time": client_time, "success": bool(ok)}
    if ok:
        if data is not None:
            response["data"] = data
    else:
        response["error"] = error if error else "unknown error"
    payload = _envelope()
    payload["response"] = response
    with _clients_lock:
        entry = _clients.get(conn)
    if entry is None:
        return
    try:
        entry["sendq"].put_nowait(payload)
    except queue.Full:
        _kick(conn, "发送队列满(慢客户端)")


def send_to(conn, push_payload):
    """定向推送(param 按订阅账本过滤后逐连接发);队列满丢弃(自愈=resync)"""
    with _clients_lock:
        entry = _clients.get(conn)
    if entry is None:
        return
    payload = _envelope()
    payload["push"] = push_payload
    try:
        entry["sendq"].put_nowait(payload)
    except queue.Full:
        pass   # 不踢人:半死清理/零宽限自然处理;丢帧由 resync 自愈


def broadcast_push(push_payload):
    """push 广播(graph/param_structure/lifecycle);每连接独立队列(慢客户端只丢自己)"""
    with _clients_lock:
        entries = list(_clients.values())
    if not entries:
        return
    payload = _envelope()
    payload["push"] = push_payload
    for entry in entries:
        try:
            entry["sendq"].put_nowait(payload)
        except queue.Full:
            pass


def send_heartbeat(hb_payload):
    """每秒心跳广播(负荷快照;up 由 time 推导,ver 已随增量协议退役)"""
    with _clients_lock:
        entries = list(_clients.values())
    if not entries:
        return
    payload = _envelope()
    payload["heartbeat"] = hb_payload
    for entry in entries:
        try:
            entry["sendq"].put_nowait(payload)
        except queue.Full:
            pass


# ---- 订阅账本(参数订阅制;按连接记,裁定⑤) ----

def ledger_subscribe(conn, node, names):
    """把点名参数计入该连接的账本"""
    with _clients_lock:
        entry = _clients.get(conn)
        if entry is None:
            return
        entry["ledger"].setdefault(node, set()).update(names)


def ledger_unsubscribe(conn, node, names):
    """把点名参数移出该连接的账本;节点条目空了就连节点一起摘"""
    with _clients_lock:
        entry = _clients.get(conn)
        if entry is None:
            return
        held = entry["ledger"].get(node)
        if held is not None:
            held -= set(names)
            if not held:
                entry["ledger"].pop(node, None)


def ledger_snapshot(conn, values_node=None, values_map=None):
    """账本回显({"node": {全名: 名单}});values_node 的条目替换为 values_map(具体值形态)——
    get_param_values 回应:本节点=对象(这次问了值),他节点=数组(在册没问值);两形态等价"""
    with _clients_lock:
        entry = _clients.get(conn)
        ledger = {n: sorted(s) for n, s in entry["ledger"].items()} if entry else {}
    if values_node is not None:
        ledger[values_node] = values_map if values_map is not None else []
    return {"node": ledger}


def iter_ledger_entries(node):
    """[(conn, 该连接在册参数名集合)]——param push 按账本过滤的遍历口"""
    with _clients_lock:
        return [(conn, set(entry["ledger"].get(node, ())))
                for conn, entry in _clients.items()]


def ledger_drop_node(node):
    """节点从图消失:全部连接的该节点账目自动清(裁定⑤的服务端侧)"""
    with _clients_lock:
        dropped = sum(1 for entry in _clients.values() if entry["ledger"].pop(node, None) is not None)
    if dropped:
        disk_log(f"节点消失清账:{node}({dropped} 条连接的账目)")


def _writer_loop(conn, entry):
    """每连接写线程:序列化(不占 worker)+帧上限检查+sendall。
    队列 5s 取不到且连接已死→退出;sendall 失败→交由读线程注销。"""
    while True:
        try:
            payload = entry["sendq"].get(timeout=5.0)
        except queue.Empty:
            if not entry["alive"]:
                return
            continue
        try:
            line = json.dumps(payload, ensure_ascii=False)
            encoded = line.encode("utf-8")
            if len(encoded) > MAX_FRAME_BYTES:
                if "response" in payload:
                    response = payload["response"]
                    response["success"] = False
                    response.pop("data", None)
                    response["error"] = "响应超过单帧上限,请缩小查询范围"
                    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                else:
                    disk_log(f"丢弃超限帧({'push' if 'push' in payload else 'heartbeat'})"
                             f"({len(encoded)}B)")
                    continue
            conn.sendall(encoded + b"\n")
        except Exception:
            return   # 连接已死;读线程的 recv 会感知并注销
        finally:
            entry["sendq"].task_done()


def _reader_loop(conn, entry):
    """每连接读线程:行缓冲→上行信封解析→派发。任何有效帧刷新 last_seen 并登记标签;
    无握手、无首帧约束(resync 由客户端自觉先发)。断开→注销(账本随条目湮灭)。"""
    global _zero_since
    buf = ""
    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            buf += data.decode("utf-8", errors="replace")
            if len(buf) > MAX_FRAME_BYTES + 1048576:
                break   # 无换行的垃圾洪流,防护性断开
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue   # 单行坏帧忽略(协议在我们的私有 fd 上,外物进不来)
                if not isinstance(frame, dict):
                    continue
                client_pid = str(frame.get("client", "?"))
                now = time.monotonic()
                with _clients_lock:
                    entry["label"] = client_pid
                    entry["client_time"] = frame.get("time")
                    entry["last_seen"] = now
                req = frame.get("request")
                if not isinstance(req, dict):
                    continue
                if _dispatch is not None:
                    _dispatch(conn, client_pid, frame.get("time"),
                              frame.get("id"), req.get("op"), req)
                # 其他形状:忽略(前向兼容留位)
    except Exception as e:   # noqa: BLE001 — 连接级异常=断开,不影响服务端
        disk_log(f"连接读线程异常退出: {type(e).__name__}: {e}")
    finally:
        with _clients_lock:
            was = _clients.pop(conn, None)
            count = len(_clients)
            if count == 0 and _ever_connected and _zero_since is None:
                _zero_since = time.monotonic()
        if was is not None:
            was["alive"] = False
            disk_log(f"客户端断开:标签={was.get('label')}(剩余连接 {count};账本随连接清)")
        try:
            conn.close()
        except OSError:
            pass


# ---- 加权遥测采样(用户裁定沿袭):六项指标 20ms 记一次,1s 发布取窗口均值 ----
AVERAGED_KEYS = ("busy", "q", "inf", "brk", "eq", "rss")
_sample_lock = threading.Lock()
_sample_sums: dict = {}
_sample_n = 0
_last_snapshot: dict = {}   # 最新原始快照(窗口还没采到时发布回退用,≤20ms 陈旧可接受)


def _reset_samples():
    global _sample_n
    with _sample_lock:
        _sample_sums.clear()
        _sample_n = 0


def _record_sample(snap):
    global _sample_n
    with _sample_lock:
        _sample_n += 1
        for k in AVERAGED_KEYS:
            v = snap.get(k)
            if isinstance(v, list):
                acc = _sample_sums.setdefault(k, [])
                while len(acc) < len(v):
                    acc.append(0.0)
                for i, x in enumerate(v):
                    acc[i] += x
            elif isinstance(v, (int, float)):
                _sample_sums[k] = _sample_sums.get(k, 0.0) + v


def _take_averages():
    """取窗口均值并清零积累;n=0 返回空(调用方回退瞬时快照)"""
    global _sample_sums, _sample_n
    with _sample_lock:
        n, sums = _sample_n, _sample_sums
        _sample_sums = {}
        _sample_n = 0
    if n == 0:
        return {}
    out = {}
    for k, s in sums.items():
        if isinstance(s, list):
            out[k] = [round(x / n, 2) for x in s]
        else:
            out[k] = round(s / n, 2)
    return out


def _sampler_loop():
    """加权采样线程(20ms):只记六项均值指标;零客户端不采样不积累"""
    while True:
        time.sleep(TELEMETRY_SAMPLE_INTERVAL_SEC)
        with _clients_lock:
            has = bool(_clients)
        if not has:
            _reset_samples()
            continue
        if _telemetry_provider is None:
            continue
        try:
            snap = _telemetry_provider()
        except Exception:  # noqa: BLE001 — 单拍失败跳过,不影响均值
            continue
        _last_snapshot.clear()
        _last_snapshot.update(snap)
        _record_sample(snap)


def _housekeeping_loop():
    """1s 巡检:半死连接清理(ping 超 CLIENT_STALE_SEC)+ 心跳发布 + 零客户端宽限自退。
    心跳=加权发布:六项负荷取 20ms 采样窗口均值,窗口没采到回退瞬时快照保证字段齐。"""
    global _zero_since
    while True:
        time.sleep(TELEMETRY_INTERVAL_SEC)
        now = time.monotonic()
        with _clients_lock:
            stale = [c for c, e in _clients.items()
                     if now - e["last_seen"] > CLIENT_STALE_SEC]
        for conn in stale:
            _kick(conn, f"ping 超时>{CLIENT_STALE_SEC:.0f}s(半死)")
        with _clients_lock:
            has_clients = bool(_clients)
        if has_clients and _telemetry_provider is not None:
            averages = _take_averages()
            if averages:
                send_heartbeat(averages)
            else:
                send_heartbeat({k: _last_snapshot[k] for k in AVERAGED_KEYS
                                if k in _last_snapshot})
        with _clients_lock:
            zero = not _clients and _ever_connected
            zero_for = (now - _zero_since) if (_zero_since is not None) else 0
        if zero and zero_for > GRACE_EXIT_SEC:
            helper_log("warn", "零客户端宽限耗尽,服务端自退(扩展端会在需要时重启)")
            disk_log(f"零客户端>{GRACE_EXIT_SEC:.0f}s → 干净退场 (pid={os.getpid()})")
            _cleanup()
            from . import ros_domain
            ros_domain.graceful_exit(0)


def read_rss_kb():
    """当前进程 RSS(kB);读不到=0。遥测内存占用字段。"""
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return 0


def run(dispatch, telemetry_provider):
    """服务端主入口(阻塞,accept 线程永不返回):bind+listen+accept 即注册。
    dispatch:main 注入 (conn, client_pid, client_time, rid, op, req)"""
    global _dispatch, _telemetry_provider, _ever_connected, _zero_since
    _dispatch = dispatch
    _telemetry_provider = telemetry_provider
    if os.path.exists(SOCKET_PATH):
        # 能走到这里=锁在我们手里,socket 文件必是上具尸体(ECONNREFUSED 类),直接清
        try:
            os.unlink(SOCKET_PATH)
        except OSError:
            pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    server.listen(8)
    disk_log(f"服务端就绪:{SOCKET_PATH} (pid={os.getpid()}, 信封帧协议,"
             f"启动时刻={_START_WALL})")
    threading.Thread(target=_sampler_loop, daemon=True).start()
    threading.Thread(target=_housekeeping_loop, daemon=True).start()
    while True:
        conn, _addr = server.accept()
        entry = {"label": "?", "client_time": None, "last_seen": time.monotonic(),
                 "sendq": queue.Queue(maxsize=SEND_QUEUE_MAX), "alive": True, "ledger": {}}
        with _clients_lock:
            _clients[conn] = entry
            count = len(_clients)
            _ever_connected = True
            _zero_since = None
        disk_log(f"客户端接入(标签待首帧;连接数 {count})")
        threading.Thread(target=_writer_loop, args=(conn, entry), daemon=True).start()
        threading.Thread(target=_reader_loop, args=(conn, entry), daemon=True).start()
