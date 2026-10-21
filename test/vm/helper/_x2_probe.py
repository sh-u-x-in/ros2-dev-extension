#!/usr/bin/env python3
# X2 断点定位探针(诊断工具,不属于正式场景):单循环复刻 sc_x2 核心——
# 冻结节占闸 + 订阅 + CLI 改参,但 ros2 CLI 调用带全量遥测(耗时/退出码/stdout/stderr),
# 并在关键步后抓 helper 磁盘日志尾。用于回答「46s 空窗里 CLI 到底发生了什么」。
# 用法: source /opt/ros/humble/setup.bash && python3 _x2_probe.py [循环次数]

import sys
import threading
import time

from _vm_server_test import (
    CTX, ENV, NODES_DIR, clean_slate, drop_client, helper_alive, log_size,
    new_client, request_ok, ros2, spawn_helper, start_fixture,
)
import subprocess
import os

HELPER_LOG = "/tmp/rde_param_helper.log"


def log_tail(n=25):
    try:
        with open(HELPER_LOG, "r", encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:])
    except OSError as e:
        return f"<log 读失败: {e}>"


def cycle(i):
    print(f"\n======== 循环 {i} ========", flush=True)
    clean_slate()
    helper = spawn_helper()
    time.sleep(1.2)
    talker = start_fixture("rde_talker.py")
    frozen = start_fixture("rde_frozen_node.py", {"RDE_FREEZE_AFTER": "0.5"})
    time.sleep(4)
    print(f"[probe] helper 存活={helper_alive()} talker={talker.pid} frozen={frozen.pid}", flush=True)
    # daemon 视角:它能看见谁(带耗时)
    t0 = time.time()
    nl = subprocess.run(["ros2", "node", "list"], capture_output=True, text=True, env=ENV, timeout=20)
    print(f"[probe] ros2 node list {nl.returncode} {int((time.time()-t0)*1000)}ms → {nl.stdout.strip().splitlines()}", flush=True)
    if nl.stderr.strip():
        print(f"[probe] node list stderr: {nl.stderr.strip()[:300]}", flush=True)

    main = new_client("main")
    # 等 frozen 入图(同 X2 口径)
    fr = main.wait_push("graph", timeout=15, pred=lambda f: "/frozen_node" in (f.get("nodes") or []))
    print(f"[probe] frozen 入图={'✓' if fr else '✗(15s)'}", flush=True)
    time.sleep(1.5)
    burn = {}

    def fire():
        burn["r"], burn["ms"] = main.request("get_param_values", 30, node="/frozen_node", names=["alive"])

    th = threading.Thread(target=fire)
    th.start()
    time.sleep(0.5)
    b = new_client("x2b")
    r0 = request_ok(b, "get_param_values", node="/talker", names=["use_sim_time"])
    print(f"[probe] 订阅前置 success={r0 and r0.get('success')}", flush=True)
    b.pushes.clear()

    # 核心一步:带全量遥测的 CLI 改参
    off = log_size() if "log_size" in dir() else 0
    t0 = time.time()
    st = subprocess.run(["ros2", "param", "set", "/talker", "use_sim_time", "true"],
                        capture_output=True, text=True, env=ENV, timeout=25)
    cli_ms = (time.time() - t0) * 1000
    print(f"[probe] CLI param set: {cli_ms:.0f}ms rc={st.returncode} "
          f"out={st.stdout.strip()[:120]!r} err={st.stderr.strip()[:300]!r}", flush=True)
    fr2 = b.wait_push("param", timeout=10,
                      pred=lambda f: (f.get("values") or {}).get("/talker", {}).get("use_sim_time") is True)
    print(f"[probe] param push={'✓' if fr2 is not None else '✗(10s)'}", flush=True)
    print(f"[probe] ---- helper 日志尾 ----\n{log_tail(30)}", flush=True)

    th.join(35)
    subprocess.run(["pkill", "-f", "rde_frozen_nod[e]"], capture_output=True)
    drop_client("x2b")
    drop_client("main")
    helper.terminate()
    talker.terminate()
    time.sleep(1.0)
    return fr2 is not None


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    greens = 0
    try:
        for i in range(1, n + 1):
            greens += 1 if cycle(i) else 0
    finally:
        clean_slate()
        print(f"\n==== 探针收尾: {greens}/{n} 绿 ====", flush=True)


if __name__ == "__main__":
    main()
