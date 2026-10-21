# [diag] 助手多轮生成-探针循环:每轮清场→起新助手(域 99)→真实 socket 客户端量 8s 心跳→杀掉留痕。
# 目标:钉死「偶发 spin 线程崩溃」——崩了的轮次 stderr 全文落在 /tmp/rde_cycle_N.log。
# 用法: source ROS env; python3 _vm_verify/_hb_cycles.py [轮数,默认 6]
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
ENTRY = os.path.join(REPO, "assets", "ros", "param_helper.py")
SOCK = "/tmp/rde_param_helper.sock"
CYCLES = int(sys.argv[1]) if len(sys.argv) > 1 else 6
DOMAIN = "99"


def kill_helpers():
    subprocess.run(["pkill", "-f", "param_helpe[r].py"], capture_output=True)
    time.sleep(0.6)


def probe(domain, seconds):
    """返回 (verified, heartbeats, pushes, responses, deny_reason)"""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3.0)
    s.connect(SOCK)
    env = {}
    for k in ("ROS_VERSION", "ROS_DISTRO", "RMW_IMPLEMENTATION"):
        v = os.environ.get(k)
        env[k.lower()] = str(v) if v not in (None, "") else "0"
    env["ros_domain_id"] = str(domain)
    hello = {"client": "cycle", "id": 1, "time": int(time.time() * 1000),
             "hello": {"proto": "rde-helper/1", "env": env}}
    s.sendall(json.dumps(hello).encode() + b"\n")
    time.sleep(0.3)
    resync = {"client": "cycle", "id": 2, "time": int(time.time() * 1000),
              "request": {"op": "resync"}}
    s.sendall(json.dumps(resync).encode() + b"\n")
    f = s.makefile("r", encoding="utf-8")
    counts = {"heartbeat": 0, "push": 0, "response": 0, "deny": 0}
    deny = None
    verified = False
    end = time.time() + seconds
    rid = 10

    def keepalive():
        nonlocal rid
        while time.time() < end:
            rid += 1
            try:
                s.sendall(json.dumps({"client": "cycle", "id": rid,
                                      "time": int(time.time() * 1000),
                                      "request": {"op": "ping"}}).encode() + b"\n")
            except OSError:
                return
            time.sleep(2)

    kt = threading.Thread(target=keepalive)
    kt.daemon = True
    kt.start()
    while time.time() < end:
        try:
            line = f.readline()
        except socket.timeout:
            continue
        if line == "":
            break
        try:
            fr = json.loads(line)
        except ValueError:
            continue
        for kind in counts:
            if kind in fr:
                counts[kind] += 1
                if kind == "deny":
                    deny = fr["deny"].get("reason")
                if kind == "response":
                    verified = True
                break
    kt.join(1)
    s.close()
    return verified, counts, deny


rows = []
for cycle in range(1, CYCLES + 1):
    kill_helpers()
    env = dict(os.environ)
    env["ROS_DOMAIN_ID"] = DOMAIN
    err_path = f"/tmp/rde_cycle_{cycle}.log"
    with open(err_path, "wb") as errf:
        proc = subprocess.Popen(["python3", ENTRY], stdout=errf, stderr=errf, env=env)
    bound = False
    end = time.time() + 8
    while time.time() < end:
        if os.path.exists(SOCK):
            bound = True
            break
        if proc.poll() is not None:
            break   # 提前退出=预检失败或崩溃
        time.sleep(0.2)
    if not bound:
        time.sleep(1)
        tail = open(err_path, encoding="utf-8", errors="replace").read()[-300:]
        rows.append((cycle, "未绑定 socket", tail.replace("\n", " ⏐ ")))
        print(f"[cycle {cycle}] FAIL 未绑定: {tail[-160:]}", flush=True)
        proc.kill()
        continue
    verified, counts, deny = probe(DOMAIN, 8.0)
    hb = counts["heartbeat"]
    verdict = "OK" if (verified and hb >= 5) else "异常(疑似 spin 崩溃)"
    rows.append((cycle, verdict, f"verified={verified} hb={hb} pushes={counts['push']} responses={counts['response']}"))
    print(f"[cycle {cycle}] {verdict} hb={hb} pushes={counts['push']} "
          f"responses={counts['response']} deny={deny}", flush=True)
    kill_helpers()

print("\n==== 多轮循环结果 ====")
bad = 0
for cycle, verdict, detail in rows:
    bad += 0 if verdict == "OK" else 1
    print(f"  cycle {cycle}: {verdict}  {detail if verdict != 'OK' else ''}")
print(f"==== {len(rows) - bad}/{len(rows)} OK ====")
sys.exit(1 if bad else 0)
