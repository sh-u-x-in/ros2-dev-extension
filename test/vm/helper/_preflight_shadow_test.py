#!/usr/bin/env python3
"""预检遮蔽矩阵(F1-F5+F6 多位累积,2026-10-19):遮蔽导入面/更改对象性质,
断言助手预检必须「有感」——退出码=100+对应位、stderr 带结构化 mask 行,绝不静默。

遮蔽手段(由入口 param_helper.py 的 sys.path 结构决定):
  - rclpy / rcl_interfaces:PYTHONPATH 前插影子模块(真身在 site-packages,影子必胜);
  - param_helper_lib:入口把自身目录钉在 sys.path[0],PYTHONPATH 遮不动——
    改用「孤儿目录」:把入口拷到无 lib 的目录起跑(0x04)/配残缺 lib(0x08/0x10)。
退出码位定义(P4):0x01 rclpy / 0x02 rcl_interfaces / 0x04 lib 导入 /
  0x08 main 非可调用 / 0x10 kernel.disk_log 非可调用。

运行(VM 内,需 ROS env):python3 _preflight_shadow_test.py
"""

import os
import shutil
import subprocess
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
ENTRY = os.path.join(REPO, "assets", "ros", "param_helper.py")
BASE = 100

results = []


def run_entry(env_extra=None, entry=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(["python3", entry or ENTRY], capture_output=True,
                       text=True, timeout=30, env=env)
    return p.returncode, p.stderr


def shadow_dir(tag):
    d = f"/tmp/rde_shadow_{tag}"
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)
    return d


def with_pythonpath(d):
    return {"PYTHONPATH": d + os.pathsep + os.environ.get("PYTHONPATH", "")}


def check(name, expect_mask, code, err):
    ok = (code == BASE + expect_mask
          and f"preflight mask=0x{expect_mask:02x}" in err
          and "[rde-helper:error]" in err)
    results.append((name, ok, f"exit={code}(期望 {BASE + expect_mask}) mask行={'有' if 'preflight mask=' in err else '无'}"))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} exit={code} 期望={BASE + expect_mask}", flush=True)


def case_f1():
    """F1 遮蔽 rclpy:影子模块导入即炸 → 0x01。
    传递位:param_helper_lib/__init__ 链式 import main(其内 import rclpy)
    → rclpy 遮蔽时 lib 连带 0x04,故精确退出码=100+0x05(实测钉死的契约)。"""
    d = shadow_dir("rclpy")
    with open(os.path.join(d, "rclpy.py"), "w", encoding="utf-8") as f:
        f.write("raise ImportError('rclpy shadowed broken by rde fixture')\n")
    code, err = run_entry(with_pythonpath(d))
    check("F1 遮蔽 rclpy 导入炸 → 100+0x05(0x01+传递 0x04)", 0x05, code, err)


def case_f2():
    """F2 遮蔽 rcl_interfaces:影子包导入即炸 → 0x02。
    传递位:rclpy 内部 import rcl_interfaces(连带 0x01)+lib 链(0x04)
    → 精确退出码=100+0x07(实测钉死的契约)。"""
    d = shadow_dir("rclif")
    pkg = os.path.join(d, "rcl_interfaces")
    os.makedirs(pkg, exist_ok=True)
    with open(os.path.join(pkg, "__init__.py"), "w", encoding="utf-8") as f:
        f.write("raise ImportError('rcl_interfaces shadowed broken by rde fixture')\n")
    code, err = run_entry(with_pythonpath(d))
    check("F2 遮蔽 rcl_interfaces 导入炸 → 100+0x07(0x01+0x02+传递 0x04)", 0x07, code, err)


def case_f3():
    """F3 孤儿目录起跑:param_helper_lib 缺失 → 0x04(入口 sys.path[0] 保护,PYTHONPATH 遮不动)"""
    d = shadow_dir("lonely")
    shutil.copy(ENTRY, os.path.join(d, "param_helper.py"))
    code, err = run_entry(entry=os.path.join(d, "param_helper.py"))
    check("F3 孤儿目录 lib 缺失 → 100+0x04", 0x04, code, err)


def shadow_lib(d, main_body, kernel_body):
    pkg = os.path.join(d, "param_helper_lib")
    os.makedirs(pkg, exist_ok=True)
    open(os.path.join(pkg, "__init__.py"), "w").close()
    with open(os.path.join(pkg, "main.py"), "w", encoding="utf-8") as f:
        f.write(main_body)
    with open(os.path.join(pkg, "kernel.py"), "w", encoding="utf-8") as f:
        f.write(kernel_body)
    shutil.copy(ENTRY, os.path.join(d, "param_helper.py"))
    return os.path.join(d, "param_helper.py")


def case_f4():
    """F4 更改对象性质:param_helper_lib.main 变非可调用 → 0x08(有感,不静默)"""
    d = shadow_dir("noncallable_main")
    entry = shadow_lib(d, "main = 123\n", "def disk_log(msg):\n    pass\n")
    code, err = run_entry(entry=entry)
    check("F4 main 变非可调用 → 100+0x08", 0x08, code, err)


def case_f5():
    """F5 更改对象性质:kernel.disk_log 变非可调用 → 0x10(诊断通道丢失必须有感)"""
    d = shadow_dir("noncallable_disklog")
    entry = shadow_lib(d, "def main():\n    pass\n", "disk_log = 123\n")
    code, err = run_entry(entry=entry)
    check("F5 disk_log 变非可调用 → 100+0x10", 0x10, code, err)


def case_f6():
    """F6 双遮蔽累积:rclpy+rcl_interfaces 同时失效 → 0x01|0x02+传递 0x04=0x07。
    与 F2 同码:双重遮蔽并不比单遮蔽多丢位(位收集不因首败中断)"""
    d = shadow_dir("double")
    with open(os.path.join(d, "rclpy.py"), "w", encoding="utf-8") as f:
        f.write("raise ImportError('shadowed')\n")
    pkg = os.path.join(d, "rcl_interfaces")
    os.makedirs(pkg, exist_ok=True)
    with open(os.path.join(pkg, "__init__.py"), "w", encoding="utf-8") as f:
        f.write("raise ImportError('shadowed')\n")
    code, err = run_entry(with_pythonpath(d))
    check("F6 双遮蔽位累积 → 100+0x07(同 F2,位不翻倍)", 0x07, code, err)


def main():
    t0 = time.time()
    for fn in (case_f1, case_f2, case_f3, case_f4, case_f5, case_f6):
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            results.append((fn.__name__, False, f"EXC {type(e).__name__}: {e}"))
            print(f"[FAIL] {fn.__name__} EXC {type(e).__name__}: {e}", flush=True)
    print("\n==== 遮蔽矩阵结果 ====")
    fails = 0
    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail if not ok else ''}")
        fails += 0 if ok else 1
    print(f"==== {len(results) - fails}/{len(results)} PASS ({time.time() - t0:.0f}s) ====")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
