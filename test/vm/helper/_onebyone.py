# [diag] 逐拍 runner:每次单跑一个场景,跑完立刻读环境(进程/节点图/助手存活性)
# 用法: source ROS env; python3 _vm_verify/_onebyone.py A1 B1 C1 ... (缺省=全序列)
import subprocess
import sys
import time

SUITE = "test/vm/helper/_vm_server_test.py"
ALL = ["A1", "A2", "B3", "B7", "B13", "C1", "C2", "C6", "F6",
       "D1", "D3a", "D3b", "D3c", "D8", "X1", "X2", "X3", "X4", "X5"]
sids = sys.argv[1:] or ALL


def env_snapshot():
    procs = subprocess.run(
        ["pgrep", "-af", "param_helpe[r].py|rde_lc_talke[r]|rde_talke[r]|rde_listene[r]|rde_frozen_nod[e]"],
        capture_output=True, text=True)
    nodes = subprocess.run(["ros2", "node", "list"], capture_output=True, text=True, timeout=15)
    return (procs.stdout.strip().replace("\n", " ⏐ ") or "(无进程)",
            nodes.stdout.strip().replace("\n", " ") or "(无节点)")


for sid in sids:
    print(f"\n========== 单跑 {sid} ==========", flush=True)
    r = subprocess.run(["python3", SUITE, "--only", sid],
                       capture_output=True, text=True, timeout=300)
    got = False
    for line in r.stdout.splitlines():
        if line.startswith("[PASS]") or line.startswith("[FAIL]"):
            got = True
            print(line, flush=True)
    if not got:
        print("[runner] 场景无结果行——stdout 尾:", r.stdout.splitlines()[-3:] if r.stdout else "空", flush=True)
        print("[runner] stderr 尾:", (r.stderr or "").splitlines()[-8:], flush=True)
    time.sleep(1.5)   # 等收尾清场落定
    procs, nodes = env_snapshot()
    print(f"[env] 进程: {procs}", flush=True)
    print(f"[env] 节点: {nodes}", flush=True)
