#!/usr/bin/env python3
# 退出路径僵尸窗口实测(2026-10-07):SIGTERM(graceful_exit)vs SIGKILL(无退场)两种死法下,
# 助手节点在 `ros2 node list`(ros2 daemon 路径,与用户查询口径一致)里的存活时长。
# 用法(VM 内,需 ROS env): python3 _exit_probe.py
# 结论口径:graceful 应亚秒~秒级消失;SIGKILL 则要看 DDS 租约(Fast DDS 默认可能数十秒)。

import json
import os
import signal
import socket
import subprocess
import sys
import time

SOCK = "/tmp/rde_param_helper.sock"
LOCK = "/tmp/rde_param_helper.lock"
HELPER = os.path.expanduser("~/rde-ros-2/assets/ros/param_helper.py")
ENV = dict(os.environ)
NODE_PREFIX = "/rde_param_helper"


def sh(args, timeout=20):
    return subprocess.run(args, capture_output=True, text=True, env=ENV, timeout=timeout)


def helper_nodes_in_graph():
    """ros2 node list --no-daemon(直读 DDS,无 daemon 缓存,量真实收敛);
    用户平时的 ros2 node list 走 daemon,会在真实收敛之上再叠加缓存滞后"""
    r = sh(["ros2", "node", "list", "--no-daemon"], timeout=15)
    return [n.strip() for n in r.stdout.splitlines() if n.strip().startswith(NODE_PREFIX)]


def clean():
    for p in (SOCK, LOCK):
        try:
            os.unlink(p)
        except OSError:
            pass
    sh(["pkill", "-f", "param_helpe[r].py"])
    time.sleep(0.5)


def spawn():
    return subprocess.Popen(["python3", HELPER],
                            stdout=open("/tmp/exit_probe_out.log", "ab"),
                            stderr=open("/tmp/exit_probe_err.log", "ab"))


def connect_resync(timeout=15):
    """等 socket 就绪、连上、发 resync(让助手完全进入工作态),返回 socket"""
    end = time.time() + timeout
    s = None
    while time.time() < end and s is None:
        if os.path.exists(SOCK):
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(2.0)
                s.connect(SOCK)
            except OSError:
                s = None
                time.sleep(0.2)
        else:
            time.sleep(0.2)
    if s is None:
        raise RuntimeError("连不上服务端")
    req = {"client": "exitprobe", "id": 1, "time": int(time.time() * 1000),
           "request": {"op": "resync"}}
    s.sendall(json.dumps(req).encode() + b"\n")
    f = s.makefile("r", encoding="utf-8")
    f.readline()   # resync 回应
    return s


def measure(kill_signal):
    """起助手→在线→发信号→轮询 ros2 node list 直到助手消失;返回耗时秒"""
    clean()
    h = spawn()
    end = time.time() + 15
    while time.time() < end and not os.path.exists(SOCK):
        time.sleep(0.1)
    s = connect_resync()
    visible = helper_nodes_in_graph()
    if not visible:
        s.close()
        return None, f"发信号前 node list 就看不到助手(异常):{helper_nodes_in_graph()}"
    t0 = time.time()
    h.send_signal(kill_signal)
    elapsed = None
    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(0.3)
        if not helper_nodes_in_graph():
            elapsed = time.time() - t0
            break
    s.close()
    try:
        h.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    return elapsed, f"存活 {visible}"


def main():
    print("== 场景 1: SIGTERM(扩展 stop 路径 → graceful_exit) ==", flush=True)
    e1, d1 = measure(signal.SIGTERM)
    print(f"结果: {d1} → 图消失耗时 {e1 if e1 is not None else '120s 未消失!'}", flush=True)

    print("== 场景 2: SIGKILL(客户端看门狗/强杀路径 → 无退场) ==", flush=True)
    e2, d2 = measure(signal.SIGKILL)
    print(f"结果: {d2} → 图消失耗时 {e2 if e2 is not None else '120s 未消失!'}", flush=True)

    clean()
    print("==== 完成 ====")


if __name__ == "__main__":
    main()
