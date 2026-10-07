#!/usr/bin/env python3
# 服务端能力虚拟测试客户端(场景驱动,2026-10-06 彻底推倒重来协议配套)。
# 用法(VM 内,需 ROS env):
#   python3 _vm_server_test.py --list          # 列出全部场景
#   python3 _vm_server_test.py --all           # 跑全部场景
#   python3 _vm_server_test.py --only A1,D3a   # 跑指定场景
# 结构:VClient 虚拟客户端(信封/resync 首发/ping 心跳/id 匹配/push·心跳收集)+ 场景注册表 + 报告。
# 教训内置:makefile 先关、ping 心跳必发(2s,停发 10s 被半死踢除)、pkill [r] 括号防自匹配、
#           request 加锁保并发 id 唯一、写锁防帧交错。
# 协议:上行信封 {client,id,time,request{op,...}};下行 {service,time,cl-num}+response|heartbeat|push;
#       无握手(连接即注册),resync 由客户端连上后首发,回应=全量图快照。

import json
import os
import socket
import subprocess
import sys
import threading
import time

SOCK = "/tmp/rde_param_helper.sock"
LOCK = "/tmp/rde_param_helper.lock"
HELPER = os.path.expanduser("~/rde-ros-2/assets/ros/param_helper.py")
ENV = dict(os.environ)

# ---------------------------------------------------------------- 工具


def clean_slate():
    for p in (SOCK, LOCK):
        try:
            os.unlink(p)
        except OSError:
            pass
    subprocess.run(["pkill", "-f", "param_helpe[r].py"], capture_output=True)
    subprocess.run(["pkill", "-f", "lifecycle_talke[r]"], capture_output=True)
    subprocess.run(["pkill", "-f", "demo_nodes_cp[p]"], capture_output=True)
    time.sleep(0.5)


def spawn_helper():
    return subprocess.Popen(["python3", HELPER],
                            stdout=open("/tmp/vtc_out.log", "ab"),
                            stderr=open("/tmp/vtc_err.log", "ab"))


def start_node(pkg, exe):
    return subprocess.Popen(["ros2", "run", pkg, exe],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=ENV)


def ros2(*args, timeout=20):
    return subprocess.run(["ros2", *args], capture_output=True, text=True, env=ENV, timeout=timeout)


def helper_alive():
    return subprocess.run(["pgrep", "-f", "param_helpe[r].py"], capture_output=True).returncode == 0


# ---------------------------------------------------------------- 虚拟客户端


class VClient:
    """虚拟客户端:一条连接 = 连上即发 resync(自动首发)+ ping 心跳(2s)+
    id 匹配请求(可并发)+ push/heartbeat 收集。在线=首条回应到达。"""

    def __init__(self, tag, timeout=15.0):
        end = time.time() + timeout
        self.sock = None
        while time.time() < end and self.sock is None:
            if os.path.exists(SOCK):
                try:
                    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    s.settimeout(2.0)
                    s.connect(SOCK)
                    self.sock = s
                except OSError:
                    time.sleep(0.2)
            else:
                time.sleep(0.2)
        if self.sock is None:
            raise RuntimeError(f"[{tag}] 连不上服务端")
        self.tag = tag
        self.f = self.sock.makefile("r", encoding="utf-8")
        self.alive = True
        self.client_time = int(time.time() * 1000)   # 客户端启动时刻(防 pid 复用语义)
        self.online = False
        self.service_pid = None    # 下行信封 service(服务端 pid)
        self.service_time = None   # 下行信封 time(服务端启动时刻)
        self.last_envelope = None
        self.heartbeat = None      # 最近一帧心跳
        self.snapshot = None       # resync 回应的 data(全量图快照)
        self.pushes = []           # 全部 push 帧
        self._push_cond = threading.Condition()
        self._pending = {}
        self._pending_lock = threading.Lock()
        self._req_lock = threading.Lock()   # 并发 request 的 id 分配+发送原子性
        self._write_lock = threading.Lock()  # sendall 写锁(帧不可交错)
        self._next_id = 1
        self._ping_id = 100000     # ping 走独立号段:回应无 pending 匹配=孤儿,静默丢弃
        self._closed = False
        threading.Thread(target=self._reader, daemon=True).start()
        # 连接即注册,无首帧约束;resync 首发拿快照(回应到达=在线)
        self.snapshot, _ = self.request("resync", 15)
        self.online = self.snapshot is not None and self.snapshot.get("success") is True
        if not self.online:
            raise RuntimeError(f"[{tag}] resync 未获快照")
        threading.Thread(target=self._ping_loop, daemon=True).start()

    def _send(self, obj):
        # 写锁:ping 线程与请求线程并发 sendall 会交错字节写坏帧(帧边界被破坏)
        with self._write_lock:
            self.sock.sendall(json.dumps(obj).encode("utf-8") + b"\n")

    def _ping_loop(self):
        while self.alive and not self._closed:
            try:
                with self._req_lock:
                    rid = self._ping_id
                    self._ping_id += 1
                self._send({"client": self.tag, "id": rid, "time": self.client_time,
                            "request": {"op": "ping"}})
            except Exception:
                return
            time.sleep(2)

    def _reader(self):
        try:
            while self.alive and not self._closed:
                line = self.f.readline()
                if not line:
                    self.alive = False
                    return
                try:
                    fr = json.loads(line)
                except ValueError:
                    continue
                self.last_envelope = {"service": fr.get("service"), "time": fr.get("time"),
                                      "cl-num": fr.get("cl-num")}
                self.service_pid = fr.get("service")
                self.service_time = fr.get("time")
                if "response" in fr:
                    resp = fr["response"]
                    with self._pending_lock:
                        box = self._pending.pop(resp.get("id"), None)
                    if box is not None:
                        box["frame"] = resp
                        box["done"].set()
                elif "heartbeat" in fr:
                    self.heartbeat = fr["heartbeat"]
                elif "push" in fr:
                    with self._push_cond:
                        self.pushes.append(fr["push"])
                        self._push_cond.notify_all()
                    self._on_push(fr["push"])
        except (OSError, ValueError):
            self.alive = False

    def request(self, op, timeout=30.0, node=None, names=None, types=None, extra=None):
        """发请求并等响应(可多线程并发调用);返回 (内层 response 帧|None, 耗时 ms)。
        响应帧:{client,id,time,success,data|error};time=原样带回的上行 time。"""
        req = {"op": op}
        if node is not None:
            req["node"] = node
        if names is not None:
            req["names"] = names
        if types is not None:
            req["types"] = types
        if extra:
            req.update(extra)
        with self._req_lock:
            if not self.alive or self._closed:
                return {"client": self.tag, "id": -1, "time": self.client_time,
                        "success": False, "error": "connection-closed"}, 0.0
            rid = self._next_id
            self._next_id += 1
            box = {"done": threading.Event(), "frame": None}
            with self._pending_lock:
                self._pending[rid] = box
            t0 = time.time()
            try:
                self._send({"client": self.tag, "id": rid, "time": self.client_time,
                            "request": req})
            except Exception as e:
                with self._pending_lock:
                    self._pending.pop(rid, None)
                return {"client": self.tag, "id": rid, "time": self.client_time,
                        "success": False, "error": f"send-fail:{e}"}, (time.time() - t0) * 1000
        box["done"].wait(timeout)
        ms = (time.time() - t0) * 1000
        if not box["done"].is_set():
            with self._pending_lock:
                self._pending.pop(rid, None)
            return None, ms
        return box["frame"], ms

    def wait_push(self, kind, timeout=10.0, pred=None):
        end = time.time() + timeout
        with self._push_cond:
            while time.time() < end:
                for fr in self.pushes:
                    if fr.get("kind") == kind and (pred is None or pred(fr)):
                        return fr
                self._push_cond.wait(timeout=min(0.5, max(0.05, end - time.time())))
            return None

    def _on_push(self, push):
        pass   # 行为层覆写:push 分发钩子

    def close(self):
        self._closed = True
        self.alive = False
        try:
            self.f.close()   # 先关 makefile(持 fd 副本),服务端才能看到断开
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------- 上下文

CTX = {"helper": None, "clients": {}, "demos": {}, "lc_pid": None}


def new_client(tag):
    c = VClient(tag)
    CTX["clients"][tag] = c
    return c


def get_client(tag):
    return CTX["clients"].get(tag)


def drop_client(tag):
    c = CTX["clients"].pop(tag, None)
    if c:
        c.close()


def request_ok(c, op, timeout=15, tries=6, **kw):
    """串行闸门容忍重试:撞上'节点串行访问中'(推送占闸)时稍候重试——契约=瞬态拒绝可重入"""
    r = None
    for _ in range(tries):
        r, _ms = c.request(op, timeout, **kw)
        if r is not None and (r.get("success") or "串行" not in (r.get("error") or "")):
            return r
        time.sleep(0.5)
    return r


class BehavioralClient(VClient):
    """行为客户端(2026-10-07 场景设计):模拟真实 TS 客户端的行为契约,底座协议机器原样沿袭。
    expand=按名册全订+镜像;collapse=镜像移除+2s 后 unget(防抖,与 TS 客户端一致);
    param push 按展开镜像自动入库(收/不收断言基于 param_push_count 与入库状态)。"""

    UNSUB_DELAY_S = 2.0   # 收起防抖,与 TS 客户端 collapseParamNode 的 2s 一致

    def __init__(self, tag, timeout=15.0):
        super().__init__(tag, timeout)
        self.expanded = set()       # 展开镜像(节点全名)
        self.param_values = {}      # 镜像入库:node → {name: value}
        self.param_push_count = 0   # 收到的 param push 计数(收/不收断言用)
        self.param_push_log = []    # 收到的 param push 流水(排障用)
        self._unget_timers = {}

    def _on_push(self, push):
        if push.get("kind") != "param":
            return
        self.param_push_log.append(push)
        self.param_push_count += 1
        for node, changed in (push.get("values") or {}).items():
            if node in self.expanded:
                self.param_values.setdefault(node, {}).update(changed)
        for node, names in (push.get("deleted") or {}).items():
            if node in self.expanded:
                flat = self.param_values.setdefault(node, {})
                for n in names:
                    flat.pop(n, None)

    def _roster(self, node):
        """名册来源=param_structure push(辅助推送阶段已到);兜底=已入库值的键"""
        for fr in reversed(self.pushes):
            if fr.get("kind") == "param_structure" and fr.get("node") == node:
                return [p["name"] for p in fr.get("params") or []]
        return sorted((self.param_values.get(node) or {}).keys())

    def expand(self, node, timeout=15):
        # 名册等待:结构推送是异步的,初始可为空——最多等 4s(真实客户端同样等名册到才订阅)
        end = time.time() + 4
        while time.time() < end and not self._roster(node):
            time.sleep(0.1)
        r = request_ok(self, "get_param_values", timeout=timeout, node=node,
                       names=self._roster(node))
        self._cancel_unget(node)
        self.expanded.add(node)
        if r and r.get("success"):
            entry = ((r.get("data") or {}).get("node") or {}).get(node)
            if isinstance(entry, dict):
                self.param_values.setdefault(node, {}).update(entry)
        return r

    def collapse(self, node):
        self.expanded.discard(node)
        t = threading.Timer(self.UNSUB_DELAY_S, lambda: self._unget_now(node))
        t.daemon = True
        t.start()
        self._unget_timers[node] = t

    def _cancel_unget(self, node):
        t = self._unget_timers.pop(node, None)
        if t:
            t.cancel()

    def _unget_now(self, node):
        names = self._roster(node)
        if names:
            request_ok(self, "unget_param_values", timeout=10, node=node, names=names)
        self.param_values.pop(node, None)


def main_client():
    c = CTX["clients"].get("main")
    if c is None or not c.alive:
        drop_client("main")
        c = new_client("main")
    return c


def lc_sigstop():
    subprocess.run(["kill", "-STOP", CTX["lc_pid"]])


def lc_sigcont():
    subprocess.run(["kill", "-CONT", CTX["lc_pid"]])


def lc_state(pid):
    """/proc/<pid>/stat 的进程状态(T=已停止/冻结);进程不存在 → None"""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
            return f.read().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError, ValueError):
        return None


def wait_lc_state(pid, want, timeout=3.0):
    """等待进程进入期望状态(冻结/解冻确定性守卫:SIGSTOP/SIGCONT 空枪在这里响亮失败)"""
    end = time.time() + timeout
    while time.time() < end:
        if lc_state(pid) == want:
            return True
        time.sleep(0.05)
    return lc_state(pid) == want


# ---------------------------------------------------------------- 场景

def sc_a1():
    """连接即注册:resync 首发,回应=全量快照;信封三字段齐;锁文件三字段(pid/epoch/ticks)"""
    c = main_client()
    try:
        lock_fields = open(LOCK, encoding="utf-8").read().split()
    except OSError:
        lock_fields = []
    env = c.last_envelope or {}
    ok = (c.online and c.snapshot is not None
          and isinstance(env.get("service"), int) and env["service"] > 0
          and isinstance(env.get("time"), (int, float)) and env["time"] > 0
          and isinstance(env.get("cl-num"), int) and env["cl-num"] >= 1
          and len(lock_fields) == 3 and int(lock_fields[0]) == c.service_pid)
    return ok, (f"pid={env.get('service')} 启动时刻={env.get('time')} cl={env.get('cl-num')} "
                f"锁文件={lock_fields}")


def sc_a2():
    """三客户端并发:各自 resync 快照+ping,互不干扰"""
    oks = []
    for tag in ("multi1", "multi2", "multi3"):
        c = new_client(tag)
        r, _ = c.request("ping", 5)
        oks.append(c.online and bool(r and r.get("success")))
    for tag in ("multi1", "multi2", "multi3"):
        drop_client(tag)
    return all(oks), f"3 会话 resync+ping={oks}"


def sc_a3():
    """断开重连:同一服务端继续服务(启动时刻不变,重启识别语义)"""
    before = main_client().service_time
    drop_client("main")
    c = main_client()
    r, _ = c.request("ping", 5)
    return bool(r and r.get("success")) and c.service_time == before, \
        f"启动时刻 {before}→{c.service_time}"


def sc_a4():
    """resync 后辅助推送:每节点 param_structure + 生命周期节点 lifecycle(广播)"""
    c = main_client()
    ps = c.wait_push("param_structure", 10)
    lc = c.wait_push("lifecycle", 10)
    ps_ok = bool(ps) and isinstance(ps.get("node"), str) and isinstance(ps.get("params"), list)
    lc_ok = bool(lc) and lc.get("node") == "/lc_talker" and "state" in lc and "edges" in lc
    return ps_ok and lc_ok, (f"param_structure node={ps.get('node') if ps else None} "
                             f"lifecycle node={lc.get('node') if lc else None} state={lc.get('state') if lc else None}")


def sc_b1():
    r, ms = main_client().request("ping", 5)
    return bool(r and r.get("success") and "data" not in r) and ms < 50, f"{ms:.0f}ms data={'data' in r}"


def sc_b2():
    """resync 快照字段:节点全名一列/topics/services 映射/lifecycle 名单"""
    snap = ((main_client().snapshot or {}).get("data") or {})
    nodes = snap.get("nodes") or []
    topics = snap.get("topics") or {}
    services = snap.get("services") or {}
    lifecycle = snap.get("lifecycle") or []
    ok = ("/talker" in nodes and "/lc_talker" in nodes
          and "/chatter" in topics and isinstance(topics, dict)
          and any("/talker/" in s or "/lc_talker/" in s for s in services)
          and "/lc_talker" in lifecycle
          and not any(s.startswith("/rde_param_helper") for s in services))
    return ok, f"nodes={nodes} topics={len(topics)} services={len(services)} lifecycle={lifecycle}"


def sc_b3():
    """订阅基线+账本回显(对象形态):get_param_values 计入账本,回应含具体值"""
    r, ms = request_ok(main_client(), "get_param_values", node="/talker",
                       names=["use_sim_time"]), 0.0
    d = (r or {}).get("data") or {}
    talker = (d.get("node") or {}).get("/talker")
    ok = (bool(r and r.get("success")) and isinstance(talker, dict)
          and "use_sim_time" in talker and r.get("client") == "main"
          and r.get("time") == main_client().client_time)
    return ok, f"底账={talker} 回带time={r.get('time') == main_client().client_time} {ms:.0f}ms"


def sc_b4():
    """退订+账本回显(数组形态):unget 一部分参数,剩余的以名册形态回显"""
    c = main_client()
    r1 = request_ok(c, "get_param_values", node="/talker",
                    names=["use_sim_time", "qos_overrides./tf.publisher.depth"])
    if not (r1 and r1.get("success")):
        return False, f"前置订阅失败:{(r1 or {}).get('error', '')[:40]}"
    r2 = request_ok(c, "unget_param_values", node="/talker",
                    names=["qos_overrides./tf.publisher.depth"])
    d = (r2 or {}).get("data") or {}
    talker = (d.get("node") or {}).get("/talker")
    ok = bool(r2 and r2.get("success")) and isinstance(talker, list) and talker == ["use_sim_time"]
    return ok, f"退订后回显={talker}(数组形态)"


def sc_b5():
    """param push 定向(核心新能力):订阅者收到值变化,未订阅连接零推送"""
    a = get_client("subA") or new_client("subA")
    b = get_client("subB") or new_client("subB")
    r = request_ok(a, "get_param_values", node="/talker", names=["use_sim_time"])
    if not (r and r.get("success")):
        return False, f"前置订阅失败:{(r or {}).get('error', '')[:60]}"
    a.pushes.clear()
    b.pushes.clear()
    ros2("param", "set", "/talker", "use_sim_time", "false")
    pa = a.wait_push("param", timeout=8,
                     pred=lambda fr: "use_sim_time" in ((fr.get("values") or {}).get("/talker") or {}))
    time.sleep(2.5)   # 给未订阅连接留出"如果会推也该到了"的窗口
    pb = any(fr.get("kind") == "param" for fr in b.pushes)
    val = ((pa or {}).get("values") or {}).get("/talker", {}).get("use_sim_time")
    return pa is not None and val is False and not pb, \
        f"订阅者收到 use_sim_time={val};未订阅者收到 param push={pb}"


def sc_b6():
    """save_param_values 批量全值:回应={节点:{参数:全值}},无路径字段"""
    r = request_ok(main_client(), "save_param_values", node="/talker",
                   names=["use_sim_time"])
    d = (r or {}).get("data") or {}
    ok = bool(r and r.get("success")) and isinstance(d.get("/talker"), dict) \
        and "use_sim_time" in d["/talker"] and isinstance(d["/talker"]["use_sim_time"], bool)
    return ok, f"全值={d}"


def sc_b7():
    """get_form 双形态:srv→Request 字段树,action→Goal 字段树"""
    r, _ = main_client().request("get_form", 20,
                                 types=["example_interfaces/srv/AddTwoInts",
                                        "example_interfaces/action/Fibonacci"])
    d = (r or {}).get("data") or {}
    srv_ok = isinstance(d.get("example_interfaces/srv/AddTwoInts"), list) \
        and len(d.get("example_interfaces/srv/AddTwoInts") or []) >= 2
    act_ok = isinstance(d.get("example_interfaces/action/Fibonacci"), list) \
        and len(d.get("example_interfaces/action/Fibonacci") or []) >= 1
    return srv_ok and act_ok, f"srv 字段={len(d.get('example_interfaces/srv/AddTwoInts') or [])} " \
                              f"action 字段={len(d.get('example_interfaces/action/Fibonacci') or [])}"


def sc_b8():
    r, _ = main_client().request("__nope__", 5)
    return bool(r and not r.get("success")), f"error={(r or {}).get('error', '')[:40]}"


def sc_b9():
    """并发 5 resync(大负载),乱序应答按 id 各自匹配"""
    c = main_client()
    out = {}

    def one(i):
        r, _ = c.request("resync", 20)
        out[i] = r
    ths = [threading.Thread(target=one, args=(i,)) for i in range(5)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    ok = all(out.get(i, {}).get("success") for i in range(5))
    same = len({json.dumps(out[i].get("data", {}).get("nodes"), sort_keys=True)
                for i in range(5) if out.get(i)}) == 1
    return ok and same, f"5/5 ok={ok} 快照一致={same}"


def sc_c1():
    """图一变推全量(无增量):起 listener,graph push 带 /listener,无 added_* 键"""
    c = main_client()
    c.pushes.clear()
    CTX["demos"]["listener"] = start_node("demo_nodes_cpp", "listener")
    fr = c.wait_push("graph", timeout=15,
                     pred=lambda f: "/listener" in (f.get("nodes") or []))
    if fr is None:
        return False, "15s 未收到含 /listener 的 graph push"
    incremental = any(k.startswith("added_") or k.startswith("removed_") for k in fr)
    return not incremental and isinstance(fr.get("topics"), dict), \
        f"全量 nodes={len(fr.get('nodes') or [])} 增量键残留={incremental}"


def sc_c2():
    """转换权威 lifecycle push:configure 后收到 state=inactive 的整包(边无 id)"""
    ros2("lifecycle", "set", "/lc_talker", "configure")
    fr = main_client().wait_push("lifecycle", timeout=12,
                                 pred=lambda f: f.get("node") == "/lc_talker"
                                 and f.get("state") == "inactive")
    if fr is None:
        return False, "12s 未收到 inactive 权威推送"
    edges_ok = all("label" in e and "from" in e and "to" in e and "id" not in e
                   for e in fr.get("edges") or [])
    return edges_ok and "available" in fr, \
        f"state={fr.get('state')} 边无id={edges_ok} available={fr.get('available')}"


def sc_e1():
    hb = main_client().heartbeat
    if not hb:
        time.sleep(1.5)
        hb = main_client().heartbeat
    need = ["busy", "q", "inf", "brk", "eq", "rss"]
    stale = ["up", "ver", "gen", "p", "cl"]
    ok = bool(hb) and all(k in hb for k in need) and hb.get("rss", 0) > 0 \
        and len(hb.get("q", [])) == 6 and all(k not in hb for k in stale)
    env = main_client().last_envelope or {}
    return ok and env.get("cl-num", 0) >= 1, \
        f"{ {k: (hb or {}).get(k) for k in need} } 信封cl={env.get('cl-num')}"


def sc_d1():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2.0)
    s.connect(SOCK)
    # 只发一帧 ping 证明活过,随后停发——10s 无任何帧=半死踢除
    s.sendall(json.dumps({"client": "halfdead", "id": 1, "time": int(time.time() * 1000),
                          "request": {"op": "ping"}}).encode() + b"\n")
    buf = s.makefile("r", encoding="utf-8")
    buf.readline()   # ping 回应
    t0 = time.time()
    kicked = False
    while time.time() - t0 < 14:   # 循环读到 EOF=被踢(心跳广播每 1s 一帧会先到)
        try:
            line = buf.readline()
        except socket.timeout:
            continue   # 2s 无数据=未被踢,继续等
        if line == "":
            kicked = True
            break
    ms = (time.time() - t0) * 1000
    buf.close()
    s.close()
    r, _ = main_client().request("ping", 5)
    return kicked and 8000 <= ms <= 15000 and bool(r and r.get("success")), \
        f"踢除 {ms:.0f}ms(8~15s);发 ping 的主会话无恙={bool(r and r.get('success'))}"


def sc_d3a():
    """卡死窗口内隔离(用户裁定核心,串行契约):坏请求烧 1 个 worker(~10s),
    同节点第二发被串行闸门立即拒绝(不排队),好请求(本连接+异客户端)全程毫秒级,
    坏请求超时后熔断开启,再来的同节点请求快失败"""
    lc_sigstop()
    if not wait_lc_state(CTX["lc_pid"], "T"):
        lc_sigcont()
        return False, f"SIGSTOP 未生效(pid={CTX['lc_pid']} state={lc_state(CTX['lc_pid'])})——lc_pid 失效"
    main_c = main_client()
    stuck = {}

    def fire(c, key):
        r, ms = c.request("get_param_values", 45, node="/lc_talker", names=["use_sim_time"])
        stuck[key] = (r, ms)

    t1 = threading.Thread(target=fire, args=(main_c, "main"))
    t1.start()
    time.sleep(1.0)   # 坏#1 已占住 lc_talker 单飞闸门(worker 烧 10s)
    # ① 同连接好请求(表单内省,不碰节点)
    r1, ms1 = main_c.request("get_form", 15, types=["example_interfaces/srv/AddTwoInts"])
    # ② 异客户端:同节点第二发 → 串行闸门立即拒绝
    b = get_client("winB") or new_client("winB")
    r2, ms2 = b.request("get_param_values", 15, node="/lc_talker", names=["use_sim_time"])
    # ③ 异客户端好请求(resync 读缓存)
    r3, ms3 = b.request("resync", 15)
    in_flight = "main" not in stuck   # 坏#1 仍在烧
    serial = (r2 is not None and not r2.get("success") and ms2 < 2000
              and "串行" in (r2.get("error") or ""))
    good = (r1 is not None and r1.get("success") and ms1 < 2000
            and r3 is not None and r3.get("success") and ms3 < 2000)
    detail = (f"好请求 {ms1:.0f}ms/{ms3:.0f}ms;同节点第二发 {ms2:.0f}ms 串行拒;"
              f"坏#1 在途={in_flight}")
    t1.join(50)
    burn_ms = stuck.get("main", (None, 0))[1]
    first_burn = (stuck.get("main", (None,))[0] is not None
                  and not stuck["main"][0].get("success") and 8000 <= burn_ms <= 20000)
    # 熔断已开:再来一发快失败
    r4, ms4 = main_c.request("get_param_values", 5, node="/lc_talker", names=["use_sim_time"])
    breaker = r4 is not None and not r4.get("success") and ms4 < 1000
    return good and serial and in_flight and first_burn and breaker, \
        (detail + f";坏#1 {burn_ms:.0f}ms 开熔断;熔断快失败 {ms4:.0f}ms")


def sc_d3b():
    """熔断链:冷却内快失败(主+异窗共享)→ 好节点隔离 → 解冻 → 冷却过期探测成功(帽内)→ 摘除"""
    c = main_client()
    r, ms = c.request("get_param_values", 5, node="/lc_talker", names=["use_sim_time"])
    fast1 = r is not None and not r.get("success") and ms < 1000
    b = get_client("winB")
    r2, ms2 = b.request("get_param_values", 5, node="/lc_talker", names=["use_sim_time"])
    shared = r2 is not None and not r2.get("success") and ms2 < 1000
    r3, ms3 = b.request("get_form", 15, types=["example_interfaces/srv/AddTwoInts"])
    isolated = r3 is not None and r3.get("success")
    lc_sigcont()   # 解冻:节点恢复
    if not wait_lc_state(CTX["lc_pid"], "S", timeout=3.0):
        return False, f"SIGCONT 未生效(pid={CTX['lc_pid']} state={lc_state(CTX['lc_pid'])})"
    time.sleep(31)   # 等冷却过期(冷却后首触=正常 10s 帽,健康节点毫秒级应答)
    r4, ms4 = c.request("get_param_values", 15, node="/lc_talker", names=["use_sim_time"])
    probe_ok = r4 is not None and r4.get("success") and ms4 <= 11000
    r5, ms5 = c.request("get_param_values", 5, node="/lc_talker", names=["use_sim_time"])
    cleared = r5 is not None and r5.get("success") and ms5 < 500
    ok = fast1 and shared and isolated and probe_ok and cleared
    return ok, (f"快失败 {ms:.0f}ms/共享 {ms2:.0f}ms/隔离 {ms3:.0f}ms/"
                f"冷却后首触 {ms4:.0f}ms(≤10s 帽)/摘除后 {ms5:.0f}ms")


def sc_d3c():
    """串行契约:6 并发同节点 → 第 1 发烧满 10s,其余 5 发被串行闸门秒拒,好请求毫秒级。
    前置:D3b 留下的熔断可能仍在冷却——先解冻+成功请求一次(摘熔断),再重新 SIGSTOP。"""
    lc_sigcont()
    if not wait_lc_state(CTX["lc_pid"], "S", timeout=3.0):
        return False, f"SIGCONT 未生效(pid={CTX['lc_pid']} state={lc_state(CTX['lc_pid'])})"
    end = time.time() + 40
    cleared = False
    while time.time() < end:
        r, _ = main_client().request("get_param_values", 12, node="/lc_talker",
                                     names=["use_sim_time"])
        if r is not None and r.get("success"):
            cleared = True
            break
        time.sleep(1)
    if not cleared:
        return False, "40s 内未能摘熔断(前置失败)"
    lc_sigstop()
    if not wait_lc_state(CTX["lc_pid"], "T"):
        lc_sigcont()
        return False, f"SIGSTOP 未生效(pid={CTX['lc_pid']} state={lc_state(CTX['lc_pid'])})"
    c = main_client()
    results = {}

    def fire(i):
        r, ms = c.request("get_param_values", 45, node="/lc_talker", names=["use_sim_time"])
        results[i] = (r, ms)
    ths = []
    for i in range(6):
        t = threading.Thread(target=fire, args=(i,))
        t.start()
        ths.append(t)
        time.sleep(0.05)
    t0 = time.time()
    r_good, _ = c.request("get_form", 10, types=["example_interfaces/srv/AddTwoInts"])
    good_ms = (time.time() - t0) * 1000
    for t in ths:
        t.join()
    vals = list(results.values())
    burns = [ms for (r, ms) in vals if ms > 2000]
    rejects = [(r, ms) for (r, ms) in vals if ms <= 2000]
    one_burn = (len(burns) == 1 and 8000 <= burns[0] <= 20000
                and results[0][0] is not None and not results[0][0].get("success"))
    five_reject = (len(rejects) == 5 and all(
        r is not None and not r.get("success") and "串行" in (r.get("error") or "")
        for (r, _ms) in rejects))
    lc_sigcont()
    return one_burn and five_reject and r_good is not None and r_good.get("success") and good_ms < 2000, \
        (f"1 发烧 {burns[0] if burns else 0:.0f}ms;{len(rejects)} 发秒拒(串行);"
         f"好请求 {good_ms:.0f}ms")


def sc_d4():
    h = CTX.get("helper")
    if h and h.poll() is None:
        h.kill()   # SIGKILL:socket 文件残留=尸体
    time.sleep(0.5)
    drop_client("main")
    CTX["helper"] = spawn_helper()
    c = main_client()
    r, ms = c.request("ping", 15)
    return bool(r and r.get("success")), f"新服务端接管尸体 socket,ping {ms:.0f}ms(新 pid={c.service_pid})"


def sc_d5():
    h = CTX.get("helper")
    if h and h.poll() is None:
        h.kill()
    time.sleep(0.5)
    for t in list(CTX["clients"]):
        drop_client(t)
    p1, p2 = spawn_helper(), spawn_helper()
    time.sleep(3)
    alive = [p for p in (p1, p2) if p.poll() is None]
    CTX["helper"] = alive[0] if alive else spawn_helper()
    c = main_client()
    r, _ = c.request("ping", 10)
    return len(alive) == 1 and bool(r and r.get("success")), \
        f"双 spawn 存活={len(alive)} 服务={'ok' if r and r.get('success') else 'fail'}"


def sc_d6():
    h = CTX.get("helper")
    for t in list(CTX["clients"]):
        drop_client(t)
    if not h or h.poll() is not None:
        return False, "服务端已不在(异常)"
    t0 = time.time()
    h.wait(timeout=25)
    secs = time.time() - t0
    return 8.0 <= secs <= 24.0, f"全部断开后 {secs:.1f}s 自退(宽限≈10s,非立即)"


# ---- 新增场景辅助:服务端磁盘日志窗口读取 ----

def log_size():
    try:
        return os.path.getsize("/tmp/rde_param_helper.log")
    except OSError:
        return 0


def log_since(off):
    try:
        with open("/tmp/rde_param_helper.log", "rb") as f:
            f.seek(off)
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def sc_c5():
    """ros2cli 临时节点过滤:瞬时 _ros2cli 不进图、不推名册、不白烧超时"""
    c = main_client()
    c.pushes.clear()
    off = log_size()
    ros2("param", "set", "/talker", "use_sim_time", "true")
    time.sleep(5)   # cli 生灭 + 若干差分周期
    cli_in_log = "_ros2cli" in log_since(off)
    bad_nodes, bad_services, bad_ps = [], [], []
    for fr in c.pushes:
        if fr.get("kind") == "graph":
            bad_nodes += [n for n in fr.get("nodes") or [] if n.startswith("_ros2cli")]
            bad_services += [sv for sv in fr.get("services") or {} if sv.startswith("_ros2cli")]
        if fr.get("kind") == "param_structure" and str(fr.get("node", "")).startswith("_ros2cli"):
            bad_ps.append(fr.get("node"))
    ok = not bad_nodes and not bad_services and not bad_ps and not cli_in_log
    return ok, (f"push 中 cli 节点={len(bad_nodes)} 服务={len(bad_services)} 名册={len(bad_ps)};"
                f"日志含 _ros2cli={cli_in_log}")


def sc_c6():
    """生命周期订阅对账生死循环:kill→消失→重启→回归→转换仍推"""
    c = main_client()
    subprocess.run(["pkill", "-f", "lifecycle_talke[r]"], capture_output=True)
    fr = c.wait_push("graph", timeout=15, pred=lambda f: "/lc_talker" not in (f.get("nodes") or []))
    if not fr:
        return False, "未收到 lc_talker 消失的 graph push"
    off = log_size()
    CTX["demos"]["lc"] = start_node("lifecycle", "lifecycle_talker")
    fr2 = c.wait_push("graph", timeout=25, pred=lambda f: "/lc_talker" in (f.get("nodes") or []))
    if not fr2:
        return False, "未收到 lc_talker 回归的 graph push"
    # lc_pid 刷新:二进制 exec 需要 1~2s,pgrep 重试直到命中(空 pid=SIGSTOP 空枪,D3a 教训)
    lc_pid = ""
    end = time.time() + 8
    while time.time() < end and not lc_pid:
        out = subprocess.run(["pgrep", "-f", "lib/lifecycle/lifecycle_talke[r]"], capture_output=True, text=True)
        lc_pid = out.stdout.strip().split("\n")[0]
        if not lc_pid:
            time.sleep(0.3)
    CTX["lc_pid"] = lc_pid
    time.sleep(1.0)   # 订阅对账 + 权威详情补推
    reconciled = "订阅对账" in log_since(off)
    ros2("lifecycle", "set", "/lc_talker", "configure")
    fr3 = c.wait_push("lifecycle", timeout=12,
                      pred=lambda f: f.get("node") == "/lc_talker" and f.get("state") == "inactive")
    return fr3 is not None and reconciled and bool(lc_pid), \
        (f"回归后转换权威 push {'收到' if fr3 else '未收到'};订阅对账日志={reconciled};"
         f"lc_pid={lc_pid or '未捕获!'}")


def sc_b10():
    """resync 不清账本:订阅 → resync → 改参数仍收到 push,账本回显一致"""
    c = main_client()
    r0 = request_ok(c, "get_param_values", node="/talker", names=["use_sim_time"])
    if not (r0 and r0.get("success")):
        return False, "前置订阅失败"
    before = sorted(((r0.get("data") or {}).get("node") or {}).keys())
    r1 = request_ok(c, "resync")
    if not (r1 and r1.get("success")):
        return False, "resync 失败"
    r2 = request_ok(c, "get_param_values", node="/talker", names=["use_sim_time"])
    after = sorted(((r2.get("data") or {}).get("node") or {}).keys())
    if before != after:
        return False, f"账本回显变化:{before} → {after}"
    c.pushes.clear()
    ros2("param", "set", "/talker", "use_sim_time", "true")
    fr = c.wait_push("param", timeout=8,
                     pred=lambda f: "use_sim_time" in (f.get("values") or {}).get("/talker", {}))
    return fr is not None, "resync 后 push 仍送达(账本保留)" if fr else "resync 后收不到 push(账本被清)"


def sc_b11():
    """断开清账不泄漏:A 订阅后断开,改参数不惊动任何未订阅客户端"""
    a = get_client("leakA") or new_client("leakA")
    b = get_client("leakB") or new_client("leakB")
    r = request_ok(a, "get_param_values", node="/talker", names=["use_sim_time"])
    if not (r and r.get("success")):
        return False, "前置订阅失败"
    off = log_size()
    drop_client("leakA")
    time.sleep(1)
    b.pushes.clear()
    ros2("param", "set", "/talker", "use_sim_time", "false")
    time.sleep(3)
    leak = [f for f in b.pushes if f.get("kind") == "param"]
    cleared = "账本随连接清" in log_since(off)
    return not leak and cleared, f"B 零收={not leak};服务端清账日志={cleared}"


def sc_b12():
    """get_form 未知类型:整条 success=false + error(固化现语义=单类型失败整条失败)"""
    r, _ = main_client().request("get_form", 15, types=["foo/bar/NoSuch"])
    return bool(r and not r.get("success") and r.get("error")), f"error={(r or {}).get('error', '')[:50]}"


def sc_d7():
    """节点消失清账+回归不自动重订阅(裁定 2026-10-07)"""
    c = main_client()
    r = request_ok(c, "get_param_values", node="/talker", names=["use_sim_time"])
    if not (r and r.get("success")):
        return False, "前置订阅失败"
    subprocess.run(["pkill", "-f", "demo_nodes_cpp/talke[r]"], capture_output=True)
    subprocess.run(["pkill", "-f", "run demo_nodes_cpp talke[r]"], capture_output=True)
    fr = c.wait_push("graph", timeout=15, pred=lambda f: "/talker" not in (f.get("nodes") or []))
    if not fr:
        return False, "未收到 talker 消失的 graph push"
    CTX["demos"]["talker"] = start_node("demo_nodes_cpp", "talker")
    fr2 = c.wait_push("graph", timeout=25, pred=lambda f: "/talker" in (f.get("nodes") or []))
    if not fr2:
        return False, "未收到 talker 回归的 graph push"
    time.sleep(1.5)   # 名册补推
    c.pushes.clear()
    ros2("param", "set", "/talker", "use_sim_time", "true")
    time.sleep(3)
    leak = [f for f in c.pushes if f.get("kind") == "param"
            and "use_sim_time" in (f.get("values") or {}).get("/talker", {})]
    if leak:
        return False, "回归后改参数仍收到 push(账目未随节点清/违规自动重订阅)"
    r2 = request_ok(c, "get_param_values", node="/talker", names=["use_sim_time"])
    if not (r2 and r2.get("success")):
        return False, "显式重订失败"
    c.pushes.clear()
    ros2("param", "set", "/talker", "use_sim_time", "false")
    fr3 = c.wait_push("param", timeout=8,
                      pred=lambda f: "use_sim_time" in (f.get("values") or {}).get("/talker", {}))
    return fr3 is not None, "回归后零推送(账已清)+显式重订后恢复" if fr3 else "显式重订后仍收不到"


def sc_g1():
    """行为客户端全链路:展开即订→push 保鲜→收起 2s 防抖两侧→重展恢复"""
    c = BehavioralClient("behav1")
    CTX["clients"]["behav1"] = c
    r = c.expand("/talker")
    if not (r and r.get("success")):
        return False, "expand 失败"
    c.param_push_count = 0
    ros2("param", "set", "/talker", "use_sim_time", "true")
    end = time.time() + 8
    while time.time() < end and c.param_push_count == 0:
        time.sleep(0.2)
    step1 = c.param_push_count >= 1
    c.collapse("/talker")
    c.param_push_count = 0
    ros2("param", "set", "/talker", "use_sim_time", "false")
    end = time.time() + 4
    while time.time() < end and c.param_push_count == 0:
        time.sleep(0.1)
    step2 = c.param_push_count >= 1
    time.sleep(2.5)   # 防抖到期,已退订
    c.param_push_count = 0
    ros2("param", "set", "/talker", "use_sim_time", "true")
    time.sleep(3)
    step3 = c.param_push_count == 0
    step3_detail = ""
    if not step3:
        step3_detail = ";step3 收到:" + json.dumps(c.param_push_log[-1], ensure_ascii=False)[:200]
    r2 = c.expand("/talker")
    r2_err = "" if (r2 and r2.get("success")) else f" 重展失败:{(r2 or {}).get('error', '')[:60]}"
    c.param_push_count = 0
    ros2("param", "set", "/talker", "use_sim_time", "false")
    end = time.time() + 8
    while time.time() < end and c.param_push_count == 0:
        time.sleep(0.1)
    step4 = c.param_push_count >= 1
    drop_client("behav1")
    ok = step1 and step2 and step3 and step4 and bool(r2 and r2.get("success"))
    return ok, (f"展开收={step1} 防抖窗内收={step2} 退订后零收={step3} 重展收={step4}"
                + step3_detail + r2_err)


def sc_g2():
    """行为客户端 × 重同步:展开态下 resync,镜像未动则推送照收"""
    c = get_client("behav2") or BehavioralClient("behav2")
    CTX["clients"]["behav2"] = c
    if "/talker" not in c.expanded:
        r = c.expand("/talker")
        if not (r and r.get("success")):
            return False, "expand 失败"
    r = request_ok(c, "resync")
    if not (r and r.get("success")):
        return False, "resync 失败"
    c.param_push_count = 0
    ros2("param", "set", "/talker", "use_sim_time", "true")
    end = time.time() + 8
    while time.time() < end and c.param_push_count == 0:
        time.sleep(0.1)
    return c.param_push_count >= 1, ("resync 后 push 照收(镜像未动)" if c.param_push_count
                                     else "resync 后收不到 push")


SCENARIOS = [
    ("A1", "连接即注册:resync 快照+信封三字段+锁文件三字段", None, sc_a1),
    ("A2", "三客户端并发 resync+ping", None, sc_a2),
    ("A3", "断开重连,服务端启动时刻不变", None, sc_a3),
    ("A4", "resync 后辅助推送:名册+生命周期广播", None, sc_a4),
    ("B1", "ping 就地秒回空 data", None, sc_b1),
    ("B2", "resync 快照字段(全名/映射/lifecycle/无幽灵服务)", None, sc_b2),
    ("B3", "订阅基线+账本回显(对象形态)+time 回带", None, sc_b3),
    ("B4", "unget 退订+账本回显(数组形态)", None, sc_b4),
    ("B5", "param push 定向:订阅者收/未订阅者零收", None, sc_b5),
    ("B6", "save_param_values 批量全值(无路径)", None, sc_b6),
    ("B7", "get_form srv+action 双形态", None, sc_b7),
    ("B8", "未知 op 错误响应", None, sc_b8),
    ("B9", "并发 5 resync 乱序应答 id 匹配", None, sc_b9),
    ("C1", "图一变推全量(无增量键)", ("listener",), sc_c1),
    ("C2", "转换权威 lifecycle push(边无 id)", None, sc_c2),
    ("C5", "ros2cli 临时节点过滤(不进图/不推名册/不白烧)", None, sc_c5),
    ("C6", "生命周期订阅对账(生死循环)", None, sc_c6),
    ("B10", "resync 不清账本", None, sc_b10),
    ("B11", "断开清账不泄漏", None, sc_b11),
    ("B12", "get_form 未知类型错误路径", None, sc_b12),
    ("D7", "节点消失清账+回归不自动重订阅", None, sc_d7),
    ("G1", "行为客户端全链路(展开/防抖两侧/重展)", None, sc_g1),
    ("G2", "行为客户端 × 重同步", None, sc_g2),
    ("E1", "心跳负荷字段齐全(无 up/ver 残留)", None, sc_e1),
    ("D1", "半死客户端 10s 踢除", None, sc_d1),
    ("D3a", "卡死窗口内隔离(串行契约:1 烧/秒拒/好请求毫秒级)", None, sc_d3a),
    ("D3b", "熔断链:快失败/共享/隔离/冷却后满帽首触/摘除", None, sc_d3b),
    ("D3c", "串行契约:6 并发同节点 → 1 烧 5 秒拒", None, sc_d3c),
    ("D4", "尸体 socket 接管", None, sc_d4),
    ("D5", "flock 竞速双 spawn 恰活一", None, sc_d5),
    ("D6", "零客户端宽限自退(收尾)", None, sc_d6),
]


def main():
    argv = sys.argv[1:]
    if "--list" in argv:
        print("场景计划:")
        for sid, name, _dep, _fn in SCENARIOS:
            print(f"  {sid}: {name}")
        return
    only = None
    if "--only" in argv:
        only = {x.strip().upper() for x in argv[argv.index("--only") + 1].split(",")}
    run_all = "--all" in argv or only is None

    clean_slate()
    CTX["helper"] = spawn_helper()
    time.sleep(1.0)
    CTX["demos"]["talker"] = start_node("demo_nodes_cpp", "talker")
    CTX["demos"]["lc"] = start_node("lifecycle", "lifecycle_talker")
    time.sleep(5)
    out = subprocess.run(["pgrep", "-f", "lib/lifecycle/lifecycle_talke[r]"], capture_output=True, text=True)
    CTX["lc_pid"] = out.stdout.strip().split("\n")[0]
    new_client("main")

    rows = []
    try:
        for sid, name, _dep, fn in SCENARIOS:
            if not run_all and only and sid.upper() not in only:
                continue
            t0 = time.time()
            try:
                ok, detail = fn()
            except Exception as e:  # noqa: BLE001
                ok, detail = False, f"EXC {type(e).__name__}: {e}"
            rows.append((sid, name, ok, detail, time.time() - t0))
            print(f"[{'PASS' if ok else 'FAIL'}] {sid} {name} ({time.time() - t0:.1f}s) {detail}", flush=True)
    finally:
        fails = [r for r in rows if not r[2]]
        print("\n==== 场景结果 ====")
        for sid, name, ok, _detail, _secs in rows:
            print(f"  {'PASS' if ok else 'FAIL'}  {sid}  {name}")
        print(f"==== {len(rows) - len(fails)}/{len(rows)} PASS ====")
        lc_sigcont()
        sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
