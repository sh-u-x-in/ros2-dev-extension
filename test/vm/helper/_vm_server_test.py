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
import signal
import socket
import subprocess
import sys
import threading
import time

SOCK = "/tmp/rde_param_helper.sock"
LOCK = "/tmp/rde_param_helper.lock"
# 仓库根=脚本位置上溯三级(test/vm/helper/ → 仓库根);不依赖 cwd/家目录假设
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
HELPER = os.path.join(REPO, "assets", "ros", "param_helper.py")
NODES_DIR = os.path.join(REPO, "test", "vm", "helper", "nodes")
ENV = dict(os.environ)
# DDS 域偏移(2026-10-19 用户裁定):测试全家桶(助手/夹具节点/ros2 CLI)固定在独立域,
# 与用户活着的环境「不接壤」——夹具节点出入图不与用户节点互相干扰。可用 RDE_TEST_DOMAIN 覆盖。
ENV.setdefault("ROS_DOMAIN_ID", os.environ.get("RDE_TEST_DOMAIN", "99"))
# 回写进程环境:VClient 的 hello 指纹读 os.environ——不同步就会客户端报域 0、
# 服务端域 99,指纹不匹配被自己人 deny(resync 无应答假死)
os.environ["ROS_DOMAIN_ID"] = ENV["ROS_DOMAIN_ID"]

# ---------------------------------------------------------------- 工具


def _wait_proc_gone(pattern, timeout=5.0):
    """轮询等匹配进程消失(真死才算);超时 SIGKILL 兜底再等一拍。
    SHM 卫生的前置(2026-10-20 教训):在 daemon 活着时清段=删它脚下的传输段,
    进程不死但聋透,一切 CLI 图查询秒回空图——X2/X3 假红根源。"""
    end = time.time() + timeout
    while time.time() < end:
        if subprocess.run(["pgrep", "-f", pattern], capture_output=True).returncode != 0:
            return
        time.sleep(0.2)
    subprocess.run(["pkill", "-9", "-f", pattern], capture_output=True)
    time.sleep(0.5)


def clean_slate():
    for p in (SOCK, LOCK):
        try:
            os.unlink(p)
        except OSError:
            pass
    subprocess.run(["pkill", "-f", "param_helpe[r].py"], capture_output=True)
    subprocess.run(["pkill", "-f", "lc_talke[r]"], capture_output=True)
    subprocess.run(["pkill", "-f", "rde_talke[r]"], capture_output=True)
    subprocess.run(["pkill", "-f", "demo_nodes_cp[p]"], capture_output=True)
    # ros2 daemon 复位(2026-10-19;2026-10-20 修模式):humble 的 daemon cmdline 是
    # "--name ros2-daemon"(连字符)——旧模式 _ros2_[d]aemon(下划线)从未命中过,
    # daemon 从未被复位过;双模式并杀兼容新旧版本命名
    for pat in ("ros2-dae[m]on", "_ros2_[d]aemon"):
        subprocess.run(["pkill", "-f", pat], capture_output=True)
    _wait_proc_gone("ros2-dae[m]on")
    _wait_proc_gone("_ros2_[d]aemon", timeout=3.0)
    # SHM 卫生(2026-10-19):被 SIGSTOP/强杀的参与者在 Fast-DDS 共享内存留尸,
    # 污染域内后续参与者的发现/事件路径——daemon 已确认真死(或本就不在),此刻清段安全
    import glob
    for seg in glob.glob("/dev/shm/fastrtps_*") + glob.glob("/dev/shm/fast_datasharing*"):
        try:
            os.unlink(seg)
        except OSError:
            pass
    # daemon 预热:拉起本测试域的新 daemon 并等发现收敛(避免首条 CLI「Node not found」秒败)
    subprocess.run(["ros2", "node", "list"], capture_output=True, timeout=25, env=ENV)
    time.sleep(2.5)


def spawn_helper(extra=None):
    # env=ENV 必传(2026-10-19 教训):助手必须与夹具节点同 DDS 域——漏传=助手域 0、
    # 夹具域 99,互相不可见,所有依赖图推送的场景全灭
    # extra:附加 argv(版本治理场景经 --ext-version 伪造「旧版本助手」)
    args = ["python3", HELPER] + (extra or [])
    return subprocess.Popen(args,
                            stdout=open("/tmp/vtc_out.log", "ab"),
                            stderr=open("/tmp/vtc_err.log", "ab"), env=ENV)


def start_fixture(script_name, extra_env=None):
    """起仓内测试节点(test/vm/helper/nodes/ 独立脚本,python3 直跑零 colcon)。
    与用户工作空间零耦合:不 import 任何工作区/demo 包,节点名与旧 demo 夹具对齐
    (/talker、/listener、/lc_talker),场景断言零改动。
    extra_env:破坏性夹具的注入参数(如 rde_lc_talker 的 RDE_TEST_HANG_SEC)。"""
    env = dict(ENV)
    if extra_env:
        env.update(extra_env)
    return subprocess.Popen(["python3", os.path.join(NODES_DIR, script_name)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)


def ros2(*args, timeout=20):
    return subprocess.run(["ros2", *args], capture_output=True, text=True, env=ENV, timeout=timeout)


def ros2_checked(*args, timeout=20):
    """承重 CLI(2026-10-20 教训):rc!=0 即抛 RuntimeError 带 stderr 尾。
    daemon 聋掉时 CLI 会「Node not found」秒败——不查 rc 的场景会假过(负向断言空洞成立:
    C5/B11/G1-step3)或假错(B5/B10/C2/C6/D7 把 CLI 失败呈报成推送未达)。清理用裸 ros2。"""
    st = ros2(*args, timeout=timeout)
    if st.returncode != 0:
        raise RuntimeError(f"CLI rc={st.returncode}: {(st.stderr or st.stdout or '').strip()[:100]}")
    return st


def helper_alive():
    return subprocess.run(["pgrep", "-f", "param_helpe[r].py"], capture_output=True).returncode == 0


FIXTURE_PATTERNS = ("rde_lc_talke[r]", "rde_talke[r]", "rde_listene[r]", "rde_multi_para[m]",
                    "rde_multi_servic[e]", "rde_action_serve[r]", "rde_frozen_nod[e]",
                    "param_helpe[r].py")


def kill_all_fixtures():
    """全量收尾(2026-10-19 用户裁定:执行完必须无残留):杀光本套件域内全部夹具与助手,
    并清 socket/锁文件。上下场景互不影响的第一道保险。"""
    for pat in FIXTURE_PATTERNS:
        subprocess.run(["pkill", "-f", pat], capture_output=True)
    for p in (SOCK, LOCK):
        try:
            os.unlink(p)
        except OSError:
            pass


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
        # P4 握手:首帧 hello 环境指纹(服务端不匹配回 deny 并断开)——通过后 resync 照旧
        hello_env = {}
        for _k in ("ROS_VERSION", "ROS_DISTRO", "ROS_DOMAIN_ID", "RMW_IMPLEMENTATION"):
            _v = os.environ.get(_k)
            hello_env[_k.lower()] = str(_v) if _v not in (None, "") else "0"
        with self._req_lock:
            hello_id = self._next_id
            self._next_id += 1
        self._send({"client": self.tag, "id": hello_id, "time": self.client_time,
                    "hello": {"proto": "rde-helper/1", "env": hello_env}})
        # resync 首发拿快照(回应到达=在线)
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


def ensure_lc_node(timeout=25.0):
    """D3 前置自愈(flake 实证 2026-10-19):C6 捕获的 lc_pid 偶发指向随后死掉的进程,
    全量跑到 D3 时 /proc 已消失 → SIGSTOP 空枪。冻结前先验活,死了现拉一个新
    lifecycle 节点并刷新 pid。返回 True=节点可用。"""
    if CTX["lc_pid"] and lc_state(CTX["lc_pid"]) is not None:
        return True
    subprocess.run(["pkill", "-f", "rde_lc_talke[r]"], capture_output=True)
    time.sleep(0.5)
    CTX["demos"]["lc"] = start_fixture("rde_lc_talker.py")
    end = time.time() + timeout
    pid = ""
    while time.time() < end and not pid:
        out = subprocess.run(["pgrep", "-f", "rde_lc_talke[r]"],
                             capture_output=True, text=True)
        cands = [p for p in out.stdout.strip().split("\n") if p and lc_state(p) not in (None, "Z")]
        if cands:
            pid = cands[-1]   # 取最高 pid=最新实例
        else:
            time.sleep(0.3)
    if not pid:
        return False
    CTX["lc_pid"] = pid
    time.sleep(2.0)   # 等服务端图事件与参数服务就绪
    return True


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
    """连接即注册:resync 首发,回应=全量快照;信封三字段齐;锁文件四字段(pid/epoch/ticks/版本)"""
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
          and len(lock_fields) == 4 and int(lock_fields[0]) == c.service_pid
          and lock_fields[3] == "0")   # 套件 spawn 不带 --ext-version → 占位 "0"
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
    try:
        ros2_checked("param", "set", "/talker", "use_sim_time", "false")
    except RuntimeError as e:
        return False, f"CLI 改参失败:{e}"
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
    """图一变推全量(无增量):起 listener,graph push 带 /listener,无 added_* 键。
    自清理(2026-10-19 教训):残留的同名节点会让图名集无变化=永远无 push(C1 假死根因)"""
    subprocess.run(["pkill", "-f", "rde_listene[r]"], capture_output=True)
    c = main_client()
    c.pushes.clear()
    CTX["demos"]["listener"] = start_fixture("rde_listener.py")
    fr = c.wait_push("graph", timeout=15,
                     pred=lambda f: "/listener" in (f.get("nodes") or []))
    subprocess.run(["pkill", "-f", "rde_listene[r]"], capture_output=True)
    if fr is None:
        return False, "15s 未收到含 /listener 的 graph push"
    incremental = any(k.startswith("added_") or k.startswith("removed_") for k in fr)
    return not incremental and isinstance(fr.get("topics"), dict), \
        f"全量 nodes={len(fr.get('nodes') or [])} 增量键残留={incremental}"


def sc_c2():
    """转换权威 lifecycle push:configure 后收到 state=inactive 的整包(边无 id)"""
    try:
        ros2_checked("lifecycle", "set", "/lc_talker", "configure")
    except RuntimeError as e:
        return False, f"CLI 转换失败:{e}"
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
    # P4:首帧必须是 hello——缺失=首帧违规 deny 即踢(0ms 假踢,2026-10-19 修)
    hello_env = {}
    for _k in ("ROS_VERSION", "ROS_DISTRO", "ROS_DOMAIN_ID", "RMW_IMPLEMENTATION"):
        _v = os.environ.get(_k)
        hello_env[_k.lower()] = str(_v) if _v not in (None, "") else "0"
    s.sendall(json.dumps({"client": "halfdead", "id": 1, "time": int(time.time() * 1000),
                          "hello": {"proto": "rde-helper/1", "env": hello_env}}).encode() + b"\n")
    buf = s.makefile("r", encoding="utf-8")
    # hello 通过即静默;读到其他帧(push/心跳广播)属正常——只有 deny 才是握手被拒
    try:
        early = buf.readline()
        if early and '"deny"' in early:
            return False, f"握手被拒:{early.strip()[:120]}"
    except socket.timeout:
        pass
    # 已验证后发一帧 ping 证明活过,随后停发——10s 无任何帧=半死踢除
    s.sendall(json.dumps({"client": "halfdead", "id": 2, "time": int(time.time() * 1000),
                          "request": {"op": "ping"}}).encode() + b"\n")
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
    if not ensure_lc_node():
        return False, "lc 节点无法拉起(前置失败)"
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
    b = get_client("winB") or new_client("winB") or new_client("winB")
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
    b = get_client("winB") or new_client("winB")
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
    lc_sigcont()   # 防上一幕遗留冻结(节点存活时解冻;已死由 ensure 现拉)
    if not ensure_lc_node():
        return False, "lc 节点无法拉起(前置失败)"
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


def sc_d8():
    """stderr 断管自退(2026-10-19 僵尸助手钳):扩展宿主重载/关闭会掐断助手 stderr
    读端,旧代码此后任何 warn 级写入抛 BrokenPipeError 无声杀死 housekeeping 线程——
    宽限自退走到一半死掉=僵尸助手(请求应答正常、心跳/自退/踢除全灭,用户侧
    「状态」永远灰)。钳:stderr 读端在宽限窗口中途掐断,自退必须照常完成。"""
    subprocess.run(["pkill", "-f", "param_helpe[r].py"], capture_output=True)
    time.sleep(0.5)
    try:
        os.unlink(SOCK)
    except OSError:
        pass
    proc = subprocess.Popen(["python3", HELPER],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=ENV)
    end = time.time() + 10
    while time.time() < end and not os.path.exists(SOCK):
        time.sleep(0.2)
    if not os.path.exists(SOCK):
        proc.kill()
        return False, "专用助手未能起 Socket(前置失败)"
    c = new_client("d8")
    c.close()              # 断开 → 零客户端宽限 10s 起跑
    time.sleep(2)          # 宽限窗口中途掐断 stderr 读端(模拟扩展宿主死亡)
    try:
        proc.stderr.close()
    except Exception:
        pass
    end = time.time() + 25
    while time.time() < end and proc.poll() is None:
        time.sleep(0.5)
    exited = proc.poll() is not None
    return exited, ("stderr 断管后宽限自退完成(防僵尸钳生效)" if exited
                    else "stderr 断管后 25s 未自退=僵尸(回归!)")


# ---- X 复合并发(2026-10-19 用户裁定):A 固定观察 B + 堵转 + 负载精确 + 域隔离 ----


def ensure_helper():
    """X 系前置:助手不在(D8 收尾自退)就拉一个"""
    if not helper_alive():
        spawn_helper()
        time.sleep(1.0)


def sc_x1():
    """X1 堵转下新接入(A 固定=冻结节点且在途烧灼;B=新客户端接入/新节点入图,必须及时且不传染)"""
    ensure_helper()
    CTX["demos"]["frozen"] = start_fixture("rde_frozen_node.py", {"RDE_FREEZE_AFTER": "0.5"})
    fr = main_client().wait_push("graph", timeout=15,
                                 pred=lambda f: "/frozen_node" in (f.get("nodes") or []))
    if fr is None:
        subprocess.run(["pkill", "-f", "rde_frozen_nod[e]"], capture_output=True)
        return False, "冻结节点未入图(前置失败)"
    time.sleep(1.5)   # 冻结定时器触发,参数服务停摆
    burn = {}

    def fire():
        burn["r"], burn["ms"] = main_client().request(
            "get_param_values", 30, node="/frozen_node", names=["alive"])

    th = threading.Thread(target=fire)
    th.start()
    time.sleep(0.5)   # 烧灼占住该节点单飞闸门(堵转成立)
    t0 = time.time()
    b = new_client("x1b")
    r, ms = b.request("resync", 5)
    join_ms = (time.time() - t0) * 1000
    join_ok = r is not None and r.get("success") and join_ms < 3000
    main_client().pushes.clear()
    t1 = time.time()
    CTX["demos"]["listener"] = start_fixture("rde_listener.py")
    fr2 = main_client().wait_push("graph", timeout=6,
                                  pred=lambda f: "/listener" in (f.get("nodes") or []))
    node_ms = (time.time() - t1) * 1000
    node_ok = fr2 is not None and node_ms < 6000
    th.join(35)
    burn_r = burn.get("r")
    # 有感契约:冻结节点的请求必须「显式失败」(串行拒/服务未发现/超时都算——
    # 冻结节点的图推送任务自己也会挂住闸门,1ms 串行拒正是堵转实验要的形态)
    burn_ok = burn_r is not None and not burn_r.get("success")
    drop_client("x1b")
    subprocess.run(["pkill", "-f", "rde_frozen_nod[e]"], capture_output=True)
    subprocess.run(["pkill", "-f", "rde_listene[r]"], capture_output=True)
    ok = join_ok and node_ok and burn_ok
    return ok, (f"堵转中新客户端接入 {ms:.0f}ms(<3s)/新节点入图推送 {node_ms:.0f}ms(<6s);"
                f"烧灼 {burn['ms']:.0f}ms 失败有感(不静默)")


def sc_x2():
    """X2 堵转下数据流正确性:冻结节点烧灼在途,talker 改参 → 订阅者收到的值必须正确且及时"""
    ensure_helper()
    CTX["demos"]["frozen"] = start_fixture("rde_frozen_node.py", {"RDE_FREEZE_AFTER": "0.5"})
    fr = main_client().wait_push("graph", timeout=15,
                                 pred=lambda f: "/frozen_node" in (f.get("nodes") or []))
    if fr is None:
        subprocess.run(["pkill", "-f", "rde_frozen_nod[e]"], capture_output=True)
        return False, "冻结节点未入图(前置失败)"
    time.sleep(1.5)
    burn = {}

    def fire():
        burn["r"], burn["ms"] = main_client().request(
            "get_param_values", 30, node="/frozen_node", names=["alive"])

    th = threading.Thread(target=fire)
    th.start()
    time.sleep(0.5)
    b = new_client("x2b")
    r0 = request_ok(b, "get_param_values", node="/talker", names=["use_sim_time"])
    if not (r0 and r0.get("success")):
        th.join(35)
        subprocess.run(["pkill", "-f", "rde_frozen_nod[e]"], capture_output=True)
        drop_client("x2b")
        return False, "订阅前置失败"
    b.pushes.clear()
    # CLI 在拥塞/冷启动下可能「Node not found」秒败(发现未收敛)——重试+间隔拉长,至推送到达;
    # rc 逐次留痕(2026-10-20 教训:CLI 全败=零事件零推送,detail 必须交代 CLI 层,不许谎报推送迟到)
    t0 = time.time()
    fr = None
    cli_fail = ""
    for attempt in range(4):
        st = ros2("param", "set", "/talker", "use_sim_time", "true")
        if st.returncode != 0:
            cli_fail = f"CLI 败(第{attempt + 1}次) rc={st.returncode}: {(st.stderr or '').strip()[:60]}"
        fr = b.wait_push("param", timeout=10,
                         pred=lambda f: (f.get("values") or {}).get("/talker", {})
                         .get("use_sim_time") is True)
        if fr is not None:
            break
        time.sleep(3)   # 拉长间隔:等 daemon/发现收敛(用户裁定:单测放宽,结果随负载抖动)
    push_ms = (time.time() - t0) * 1000
    th.join(35)
    burn_r = burn.get("r")
    burn_ok = burn_r is not None and not burn_r.get("success")
    ros2("param", "set", "/talker", "use_sim_time", "false")
    subprocess.run(["pkill", "-f", "rde_frozen_nod[e]"], capture_output=True)
    drop_client("x2b")
    got = ((fr or {}).get("values") or {}).get("/talker", {}).get("use_sim_time")
    ok = fr is not None and push_ms < 40000 and burn_ok
    return ok, (f"堵转中改参推送 {push_ms:.0f}ms(<40s,含重试)实测值={got!r}"
                + (f";{cli_fail}" if cli_fail else "")
                + f";冻结节点烧灼 {burn.get('ms', -1):.0f}ms 失败有感(不静默)")


def sc_x3():
    """X3 生命周期并发:转换链 configure→activate→deactivate(回退/退出)与并发 resync 风暴
    交错——状态推送序必须正确、resync 全成功及时(并发不破坏语义)"""
    ensure_helper()
    subprocess.run(["pkill", "-f", "rde_lc_talke[r]"], capture_output=True)
    CTX["demos"]["lc"] = start_fixture("rde_lc_talker.py")
    fr = main_client().wait_push("graph", timeout=25,
                                 pred=lambda f: "/lc_talker" in (f.get("nodes") or []))
    if fr is None:
        return False, "lc 未回图(前置失败)"
    time.sleep(1.0)
    c = main_client()
    b = new_client("x3b")
    c.pushes.clear()
    out = {"n": 0, "ok": 0}

    def resync_storm():
        for _ in range(3):
            r, _ = b.request("resync", 10)
            out["n"] += 1
            if r is not None and r.get("success"):
                out["ok"] += 1
            time.sleep(0.8)

    th = threading.Thread(target=resync_storm)
    th.start()
    seq_ok = True
    detail = []
    for transition, want in (("configure", "inactive"),
                             ("activate", "active"),
                             ("deactivate", "inactive")):
        # CLI「Node not found」秒败重试(发现未收敛随负载抖动,用户裁定拉长等待)。
        # rc 必须=0 才算 done(2026-10-20 教训:秒败 rc=1 从前被当 done=True,转换从未发生)
        done = False
        cli_err = ""
        for attempt in range(3):
            try:
                st = ros2("lifecycle", "set", "/lc_talker", transition, timeout=15)
                if st.returncode == 0:
                    done = True
                    break
                cli_err = f"rc={st.returncode}:{(st.stderr or '').strip()[:50]}"
            except subprocess.TimeoutExpired:
                cli_err = "CLI 超时"
            time.sleep(3)
        fr = c.wait_push("lifecycle", timeout=15,
                         pred=lambda f: f.get("node") == "/lc_talker" and f.get("state") == want)
        seq_ok = seq_ok and done and fr is not None
        hit = done and fr is not None
        why = "" if hit else (f"(CLI {cli_err})" if not done else "(推送未达)")
        detail.append(f"{transition}→{want}{'✓' if hit else '✗'}{why}")
        time.sleep(2)   # 拉长间隔:等 DDS 状态稳定(用户裁定:单测放宽防抖动)
    th.join()
    drop_client("x3b")
    ok = seq_ok and out["ok"] == out["n"] == 3
    return ok, f"状态序 {detail} 并发 resync {out['ok']}/{out['n']}"


def sc_x4():
    """X4 负载反应正确:心跳 cl-num 随连接数精确变化(4→2),busy 空闲归零,rss 恒正"""
    ensure_helper()
    c = main_client()
    extra = [("x4%d" % i, new_client("x4%d" % i)) for i in range(3)]
    want_full = 1 + len(extra)
    hb = None
    end = time.time() + 5
    while time.time() < end:
        hb = c.heartbeat
        if hb and hb.get("cl") == want_full:
            break
        time.sleep(0.3)
    def cl_now():
        # cl-num 在下行信封上(不在心跳载荷里)——口径同 E1 的 last_envelope
        return (c.last_envelope or {}).get("cl-num")

    cl_up = bool(hb) and cl_now() == want_full
    samples = [cl_now()]
    time.sleep(2.2)   # 空闲两拍:busy 均值归零
    hb2 = c.heartbeat
    idle_ok = bool(hb2) and hb2.get("busy", 1) == 0 and (hb2.get("rss") or 0) > 0
    drop_client(extra[0][0])
    drop_client(extra[1][0])
    hb3 = None
    end = time.time() + 5
    while time.time() < end:
        hb3 = c.heartbeat
        if hb3 and cl_now() == 2:
            break
        time.sleep(0.3)
    cl_down = bool(hb3) and cl_now() == 2
    samples.append(cl_now())
    samples.append(cl_now())
    for tag, _ in extra:
        drop_client(tag)
    ok = cl_up and idle_ok and cl_down
    return ok, f"cl {want_full}→2 精确({cl_up}/{cl_down});busy 空闲归零+rss>0={idle_ok};cl采样={samples}"


def sc_x5():
    """X5 DDS 域隔离负向:域外(98)节点对图完全不可见——隔离正确性(负向断言)"""
    ensure_helper()
    main_client().pushes.clear()
    outside = start_fixture("rde_listener.py", {"ROS_DOMAIN_ID": "98"})
    fr = main_client().wait_push("graph", timeout=8,
                                 pred=lambda f: "/listener" in (f.get("nodes") or []))
    snap, _ = main_client().request("resync", 10)
    nodes = ((snap or {}).get("data") or {}).get("nodes") or []
    invisible = fr is None and "/listener" not in nodes
    subprocess.run(["pkill", "-f", "rde_listene[r]"], capture_output=True)
    return invisible, ("域外节点不可见=隔离生效" if invisible
                       else "域外节点泄漏进图(隔离失效,DDS 域偏移被破坏)")


# ---- 版本治理(规范=src/ros2/consumers/monitor/helper/VERSION-CONTROL.md,冻结文件) ----
# 参考实现:X6/X7/X8 用它演客户端的「杀旧拉新」裁定——TS 侧真实现由 helper-versioning
# 无头套件盖;这里验服务端契约(锁四字段落盘/argv 通道/flock/杀安全)+算法在真进程可行。


def kill_helper():
    """杀现役助手并清 socket/锁(场景内自管,不动全清场)"""
    subprocess.run(["pkill", "-f", "param_helpe[r].py"], capture_output=True)
    time.sleep(0.8)
    for p in (SOCK, LOCK):
        try:
            os.unlink(p)
        except OSError:
            pass


def read_lock_fields():
    try:
        return open(LOCK, encoding="utf-8").read().split()
    except OSError:
        return None


def proc_state(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
            return f.read().rsplit(")", 1)[1].split()[0]
    except (OSError, ValueError, IndexError):
        return None


def proc_alive(pid):
    # 僵尸滤除(D3a 同款教训):本脚本是被杀助手的父进程,SIGKILL 后子进程成 zombie
    # 直到父进程 reap——kill(pid,0) 对 zombie 返回真,/proc state=Z 才是真死判据
    st = proc_state(pid)
    if st is not None:
        return st != "Z"
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def proc_start_ticks(pid):
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as f:
            return f.read().rsplit(")", 1)[1].split()[19]
    except (OSError, ValueError, IndexError):
        return None


def wait_lock_version(want, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        f = read_lock_fields()
        if f and len(f) >= 4 and f[3] == want:
            return True
        time.sleep(0.2)
    return False


def replace_if_older(my_version):
    """规范 §2 参考实现:返回 (verdict, pid)——replaced=已杀旧(待拉新)/yield=让位或禁用/none=无锁"""
    fields = read_lock_fields()
    if not fields or not proc_alive(fields[0]):
        return "none", None

    def parse(v):
        try:
            return tuple(int(x) for x in str(v).split("."))
        except (ValueError, AttributeError):
            return None
    mine = parse(my_version)
    if mine is None:
        return "yield", int(fields[0])          # 治理禁用
    lock_ver = fields[3] if len(fields) >= 4 else None
    lock_p = parse(lock_ver) if lock_ver else None
    do_replace = True if lock_p is None else lock_p < mine
    if not do_replace:
        return "yield", int(fields[0])
    pid = int(fields[0])
    ticks = proc_start_ticks(pid)
    if ticks is not None and str(ticks) != fields[2]:
        return "yield", pid                      # ticks 对账失败=pid 已换人,绝不杀
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return "replaced", pid


def sc_x6():
    """X6 版本治理·杀旧拉新:0.0.4 助手在跑 → 0.0.5 客户端按规范替换 →
    旧 pid 死、新版本锁落盘、新客户端在线"""
    kill_helper()
    CTX["helper"] = spawn_helper(["--ext-version", "0.0.4"])
    if not wait_lock_version("0.0.4"):
        return False, "0.0.4 锁版本未落盘(argv 通道断?)"
    old = read_lock_fields()
    old_pid = int(old[0])
    c = new_client("x6old")
    if not c.online:
        return False, "旧版本助手未服务(x6old 不在线)"
    verdict, killed = replace_if_older("0.0.5")
    if verdict != "replaced" or killed != old_pid:
        return False, f"裁定错误:verdict={verdict} killed={killed}(期望 replaced/{old_pid})"
    end = time.time() + 5
    while time.time() < end and proc_alive(old_pid):
        time.sleep(0.2)
    if proc_alive(old_pid):
        return False, f"旧助手 pid={old_pid} 杀后仍活"
    CTX["helper"] = spawn_helper(["--ext-version", "0.0.5"])
    if not wait_lock_version("0.0.5"):
        return False, "0.0.5 锁版本未落盘"
    c2 = new_client("x6new")
    ok = c2.online and c2.service_pid == int(read_lock_fields()[0])
    return ok, (f"0.0.4(pid={old_pid})被杀✓ → 0.0.5 拉起✓ 锁版本={read_lock_fields()[3]} "
                f"新客户端在线={c2.online} 新 pid={c2.service_pid}")


def sc_x7():
    """X7 版本治理·让位:0.0.6 助手在跑,0.0.5 客户端比对 → 不杀,pid 不变,共享在线"""
    kill_helper()
    CTX["helper"] = spawn_helper(["--ext-version", "0.0.6"])
    if not wait_lock_version("0.0.6"):
        return False, "0.0.6 锁版本未落盘"
    pid_before = int(read_lock_fields()[0])
    c = new_client("x7c")
    verdict, _ = replace_if_older("0.0.5")
    time.sleep(1.0)
    unchanged = verdict == "yield" and read_lock_fields()[0] == str(pid_before) and proc_alive(pid_before)
    ping, _ = c.request("ping", 5)
    ok = unchanged and bool(ping and ping.get("success"))
    return ok, f"0.0.5 遇 0.0.6 服务端:verdict={verdict} pid 不变={unchanged} ping={'ok' if ping and ping.get('success') else '败'}"


def sc_x8():
    """X8 版本治理·legacy:无版本字段(占位 0,=0.0.3- 遗留形态)→ 按最旧替换"""
    kill_helper()
    CTX["helper"] = spawn_helper()   # 不带 --ext-version → 锁版本 "0"
    if not wait_lock_version("0"):
        return False, "占位版本 0 未落盘"
    verdict, _ = replace_if_older("0.0.5")
    if verdict != "replaced":
        return False, f"legacy 锁应按最旧替换,实测 verdict={verdict}"
    CTX["helper"] = spawn_helper(["--ext-version", "0.0.5"])
    ok = wait_lock_version("0.0.5")
    return ok, f"占位 0 → replaced✓ → 0.0.5 落盘={'✓' if ok else '✗'}"


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
    try:
        ros2_checked("param", "set", "/talker", "use_sim_time", "true")
    except RuntimeError as e:
        return False, f"CLI 改参失败,负向断言空洞不成立(杜绝假过):{e}"
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
    subprocess.run(["pkill", "-f", "rde_lc_talke[r]"], capture_output=True)
    fr = c.wait_push("graph", timeout=15, pred=lambda f: "/lc_talker" not in (f.get("nodes") or []))
    if not fr:
        return False, "未收到 lc_talker 消失的 graph push"
    off = log_size()
    CTX["demos"]["lc"] = start_fixture("rde_lc_talker.py")
    fr2 = c.wait_push("graph", timeout=25, pred=lambda f: "/lc_talker" in (f.get("nodes") or []))
    if not fr2:
        return False, "未收到 lc_talker 回归的 graph push"
    # lc_pid 刷新:二进制 exec 需要 1~2s,pgrep 重试直到命中(空 pid=SIGSTOP 空枪,D3a 教训)。
    # 2026-10-19 加固:滤僵尸+1s 存活复验——偶发捕到速死进程会让 D3 全线空枪(flake 实证)
    lc_pid = ""
    end = time.time() + 8
    while time.time() < end and not lc_pid:
        out = subprocess.run(["pgrep", "-f", "rde_lc_talke[r]"], capture_output=True, text=True)
        cands = [p for p in out.stdout.strip().split("\n") if p and lc_state(p) not in (None, "Z")]
        if cands:
            cand = cands[-1]
            time.sleep(1.0)
            if lc_state(cand) not in (None, "Z"):
                lc_pid = cand
        else:
            time.sleep(0.3)
    CTX["lc_pid"] = lc_pid
    time.sleep(1.0)   # 订阅对账 + 权威详情补推
    reconciled = "订阅对账" in log_since(off)
    try:
        ros2_checked("lifecycle", "set", "/lc_talker", "configure")
    except RuntimeError as e:
        return False, f"CLI 转换失败:{e}"
    fr3 = c.wait_push("lifecycle", timeout=12,
                      pred=lambda f: f.get("node") == "/lc_talker" and f.get("state") == "inactive")
    return fr3 is not None and reconciled and bool(lc_pid), \
        (f"回归后转换权威 push {'收到' if fr3 else '未收到'};订阅对账日志={reconciled};"
         f"lc_pid={lc_pid or '未捕获!'}")


def sc_f6():
    """生命周期卡转有感(F6,破坏性夹具 RDE_TEST_HANG_SEC):on_configure 挂住 →
    转换 CLI 超时=有感不静默(绝不假成功),助手不受累(ping 正常)。
    收尾恢复健康 lc(D3 系 SIGSTOP 依赖健康节点,ensure_lc_node 兜底)。"""
    subprocess.run(["pkill", "-f", "rde_lc_talke[r]"], capture_output=True)
    fr = main_client().wait_push("graph", timeout=15,
                                 pred=lambda f: "/lc_talker" not in (f.get("nodes") or []))
    if fr is None:
        return False, "旧 lc 未下线(前置失败)"
    CTX["demos"]["lc"] = start_fixture("rde_lc_talker.py", {"RDE_TEST_HANG_SEC": "8"})
    fr2 = main_client().wait_push("graph", timeout=25,
                                  pred=lambda f: "/lc_talker" in (f.get("nodes") or []))
    if fr2 is None:
        return False, "挂断夹具未回图(前置失败)"
    time.sleep(1.5)
    cli_err = ""
    try:
        st = ros2("lifecycle", "set", "/lc_talker", "configure", timeout=6)
        timed_out = False
        if st.returncode != 0:
            # 秒败(daemon 聋/节点未发现)≠卡转超时——记录原因,红要红得明明白白
            cli_err = (st.stderr or "").strip()[:80]
    except subprocess.TimeoutExpired:
        timed_out = True
    r, _ = main_client().request("ping", 5)
    alive = bool(r and r.get("success"))
    # 收尾:杀挂断体,恢复健康 lc(下一场景依赖)
    subprocess.run(["pkill", "-f", "rde_lc_talke[r]"], capture_output=True)
    CTX["demos"]["lc"] = start_fixture("rde_lc_talker.py")
    main_client().wait_push("graph", timeout=25, pred=lambda f: "/lc_talker" in (f.get("nodes") or []))
    return timed_out and alive, (f"卡转超时有感={timed_out}(绝不假成功);助手不受累={alive}"
                                 + (f";CLI 秒败:{cli_err}" if cli_err else ""))


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
    try:
        ros2_checked("param", "set", "/talker", "use_sim_time", "true")
    except RuntimeError as e:
        return False, f"CLI 改参失败:{e}"
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
    try:
        ros2_checked("param", "set", "/talker", "use_sim_time", "false")
    except RuntimeError as e:
        return False, f"CLI 改参失败,负向断言空洞不成立(杜绝假过):{e}"
    time.sleep(3)
    leak = [f for f in b.pushes if f.get("kind") == "param"]
    cleared = "账本随连接清" in log_since(off)
    return not leak and cleared, f"B 零收={not leak};服务端清账日志={cleared}"


def sc_b12():
    """get_form 未知类型:整条 success=false + error(固化现语义=单类型失败整条失败)"""
    r, _ = main_client().request("get_form", 15, types=["foo/bar/NoSuch"])
    return bool(r and not r.get("success") and r.get("error")), f"error={(r or {}).get('error', '')[:50]}"


def sc_b13():
    """多参数夹具(B13):/multi_param 12 参全类型+点分命名空间,一次取全。
    自清理:残留的同名节点会让图名集无变化=永远无 push(B13 首跑假死根因)"""
    subprocess.run(["pkill", "-f", "rde_multi_para[m]"], capture_output=True)
    CTX["demos"]["multi"] = start_fixture("rde_multi_param.py")
    fr = main_client().wait_push("graph", timeout=15,
                                 pred=lambda f: "/multi_param" in (f.get("nodes") or []))
    if fr is None:
        subprocess.run(["pkill", "-f", "rde_multi_para[m]"], capture_output=True)
        return False, "15s 未收到含 /multi_param 的 graph push"
    time.sleep(1.0)   # 参数服务就绪一拍
    names = ["flag", "level", "ratio", "label", "flags", "levels", "ratios", "labels",
             "group.depth", "group.mode", "group.ratios", "group.flags"]
    r, _ = main_client().request("get_param_values", 15, node="/multi_param", names=names)
    # 回应=账本回显:data.node 以节点名为键,本节点的值映射才是参数字典
    data = (((r or {}).get("data") or {}).get("node") or {}).get("/multi_param") or {}
    got = sorted(data.keys())
    subprocess.run(["pkill", "-f", "rde_multi_para[m]"], capture_output=True)
    ok = bool(r and r.get("success")) and got == sorted(names)
    return ok, f"一次取全 {len(got)}/12" + ("" if ok else f":{got}")


def sc_d7():
    """节点消失清账+回归不自动重订阅(裁定 2026-10-07)"""
    c = main_client()
    r = request_ok(c, "get_param_values", node="/talker", names=["use_sim_time"])
    if not (r and r.get("success")):
        return False, "前置订阅失败"
    subprocess.run(["pkill", "-f", "rde_talke[r]"], capture_output=True)
    fr = c.wait_push("graph", timeout=15, pred=lambda f: "/talker" not in (f.get("nodes") or []))
    if not fr:
        return False, "未收到 talker 消失的 graph push"
    CTX["demos"]["talker"] = start_fixture("rde_talker.py")
    fr2 = c.wait_push("graph", timeout=25, pred=lambda f: "/talker" in (f.get("nodes") or []))
    if not fr2:
        return False, "未收到 talker 回归的 graph push"
    time.sleep(1.5)   # 名册补推
    c.pushes.clear()
    try:
        ros2_checked("param", "set", "/talker", "use_sim_time", "true")
    except RuntimeError as e:
        return False, f"CLI 改参失败,负向半段空洞不成立:{e}"
    time.sleep(3)
    leak = [f for f in c.pushes if f.get("kind") == "param"
            and "use_sim_time" in (f.get("values") or {}).get("/talker", {})]
    if leak:
        return False, "回归后改参数仍收到 push(账目未随节点清/违规自动重订阅)"
    r2 = request_ok(c, "get_param_values", node="/talker", names=["use_sim_time"])
    if not (r2 and r2.get("success")):
        return False, "显式重订失败"
    c.pushes.clear()
    try:
        ros2_checked("param", "set", "/talker", "use_sim_time", "false")
    except RuntimeError as e:
        return False, f"重订后 CLI 改参失败:{e}"
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

    def setv(v):
        """承重改参查 rc(2026-10-20):返回错误串,空串=成功——step3 负向断言若不查 rc,
        daemon 聋时 CLI 秒败=零推送自然成立=假过"""
        try:
            ros2_checked("param", "set", "/talker", "use_sim_time", v)
            return ""
        except RuntimeError as e:
            return str(e)

    c.param_push_count = 0
    err1 = setv("true")
    end = time.time() + 8
    while time.time() < end and c.param_push_count == 0:
        time.sleep(0.2)
    step1 = err1 == "" and c.param_push_count >= 1
    c.collapse("/talker")
    c.param_push_count = 0
    err2 = setv("false")
    end = time.time() + 4
    while time.time() < end and c.param_push_count == 0:
        time.sleep(0.1)
    step2 = err2 == "" and c.param_push_count >= 1
    time.sleep(2.5)   # 防抖到期,已退订
    c.param_push_count = 0
    err3 = setv("true")
    time.sleep(3)
    step3 = err3 == "" and c.param_push_count == 0
    step3_detail = ""
    if not step3:
        if err3:
            step3_detail = f";step3 CLI 败:{err3}"
        else:
            step3_detail = ";step3 收到:" + json.dumps(c.param_push_log[-1], ensure_ascii=False)[:200]
    r2 = c.expand("/talker")
    r2_err = "" if (r2 and r2.get("success")) else f" 重展失败:{(r2 or {}).get('error', '')[:60]}"
    c.param_push_count = 0
    err4 = setv("false")
    end = time.time() + 8
    while time.time() < end and c.param_push_count == 0:
        time.sleep(0.1)
    step4 = err4 == "" and c.param_push_count >= 1
    drop_client("behav1")
    ok = step1 and step2 and step3 and step4 and bool(r2 and r2.get("success"))
    cli_note = "".join(f";set{v}败:{e}" for v, e in
                       (("1", err1), ("2", err2), ("4", err4)) if e)
    return ok, (f"展开收={step1} 防抖窗内收={step2} 退订后零收={step3} 重展收={step4}"
                + cli_note + step3_detail + r2_err)


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
    try:
        ros2_checked("param", "set", "/talker", "use_sim_time", "true")
    except RuntimeError as e:
        return False, f"CLI 改参失败:{e}"
    end = time.time() + 8
    while time.time() < end and c.param_push_count == 0:
        time.sleep(0.1)
    return c.param_push_count >= 1, ("resync 后 push 照收(镜像未动)" if c.param_push_count
                                     else "resync 后收不到 push")


SCENARIOS = [
    ("A1", "连接即注册:resync 快照+信封三字段+锁文件四字段", None, sc_a1),
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
    ("F6", "生命周期卡转有感:configure 挂起→转换超时,助手不受累", None, sc_f6),
    ("B10", "resync 不清账本", None, sc_b10),
    ("B11", "断开清账不泄漏", None, sc_b11),
    ("B12", "get_form 未知类型错误路径", None, sc_b12),
    ("B13", "多参数夹具:12 参一次取全(全类型+点分命名空间)", None, sc_b13),
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
    ("D8", "stderr 断管自退(僵尸助手钳)", None, sc_d8),
    ("X1", "复合·堵转下新接入(A 冻结烧灼;B 客户端/节点及时且不传染)", None, sc_x1),
    ("X2", "复合·堵转下数据流正确性(改参推送及时且值正确)", None, sc_x2),
    ("X3", "复合·生命周期并发(转换链×resync 风暴,状态序正确)", None, sc_x3),
    ("X4", "复合·负载反应正确(cl 精确/busy 归零/rss 恒正)", None, sc_x4),
    ("X5", "复合·DDS 域隔离负向(域外节点不可见)", None, sc_x5),
    ("X6", "复合·版本治理杀旧拉新(锁四字段+ticks 核对+替换后新版本在线)", None, sc_x6),
    ("X7", "复合·版本治理让位(锁版本更新 → 不杀,pid 不变)", None, sc_x7),
    ("X8", "复合·版本治理 legacy(无版本字段 → 按最旧替换)", None, sc_x8),
]


def compile_gate():
    """F(2026-10-18):套件前置 py_compile 硬门——用**当前解释器**编译助手全部 .py,
    防新高版本语法混入(任意一个文件语法超纲,42 场景在起助手之前就红,而非散点假象)。"""
    import py_compile

    lib_dir = os.path.join(REPO, "assets", "ros", "param_helper_lib")
    targets = [HELPER] + sorted(
        os.path.join(lib_dir, f) for f in os.listdir(lib_dir) if f.endswith(".py")
    )
    for path in targets:
        try:
            py_compile.compile(path, doraise=True)
        except py_compile.PyCompileError as e:
            print(f"!! 编译门失败:{path}\n{e}", flush=True)
            sys.exit(1)
    print(f"编译门通过:助手 {len(targets)} 个 .py(py_compile @ {sys.executable.split('/')[-1]})", flush=True)


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

    compile_gate()  # F:py_compile 硬门(失败即退,42 场景不起)
    clean_slate()
    CTX["helper"] = spawn_helper()
    time.sleep(1.0)
    CTX["demos"]["talker"] = start_fixture("rde_talker.py")
    CTX["demos"]["lc"] = start_fixture("rde_lc_talker.py")
    time.sleep(5)
    out = subprocess.run(["pgrep", "-f", "rde_lc_talke[r]"], capture_output=True, text=True)
    CTX["lc_pid"] = out.stdout.strip().split("\n")[0]
    # daemon 聋检测(2026-10-20 教训):夹具已起而 CLI 图查询看不见=daemon 聋,后续一切
    # CLI 承重场景的断言全部 vacuous——开工前显式报警,红要红得知道是环境不是回归。
    # (场景自身的 ros2_checked rc 检查是第二道防线,负向断言场景靠它防假过)
    daemon_ok = False
    for _ in range(3):
        nl = subprocess.run(["ros2", "node", "list"], capture_output=True, text=True,
                            env=ENV, timeout=20)
        if {"/talker", "/lc_talker"} <= set(nl.stdout.split()):
            daemon_ok = True
            break
        time.sleep(3)
    if not daemon_ok:
        print("!! 警告:ros2 daemon 图查询看不见夹具(/talker //lc_talker)——daemon 聋,"
              "CLI 承重场景将红,原因看各场景 detail 的「CLI 败」字样;这是环境病不是助手回归",
              flush=True)
    try:
        new_client("main")
    except BaseException:
        # setup 阶段崩溃(如 resync 被拒)也必须清场——此前 finally 不覆盖这里,残留屡禁不止
        kill_all_fixtures()
        raise

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
        kill_all_fixtures()   # 无残留保险(2026-10-19 用户裁定):执行完必须片甲不留
        sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
