# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手内核层:常量/磁盘日志(常驻句柄+轮转)/诊断出口/SIGTERM。
所有模块的日志与常量统一从此导入;信号注册(register_sigterm)由 main() 显式调用。
彻底推倒重来(2026-10-06):信封帧协议与服务端常量在此定稿;版本握手/世代/逐实例
心跳路径随旧协议删除——pid 复用防护靠 time(启动时刻)字段与锁文件启动 ticks。"""

import os
import signal
import sys
import tempfile
import threading
import time

# ---- 协议/服务端常量(彻底推倒重来 2026-10-06) ----
SOCKET_PATH = "/tmp/rde_param_helper.sock"   # 固定知名路径(单口)
LOCK_PATH = "/tmp/rde_param_helper.lock"     # flock 仲裁(内记 pid/启动epoch/启动ticks)
MAX_FRAME_BYTES = 20 * 1024 * 1024   # 单帧上限=防爆炸断路器(超限 resp 转错误/事件丢弃)
SEND_QUEUE_MAX = 64                  # 每连接发送队列上限(帧数;满=踢除慢客户端)
GRACE_EXIT_SEC = 10.0                # 零客户端宽限(连接全断后等这么久才自退)
CLIENT_STALE_SEC = 10.0              # 半死判定(客户端 ping 2s 一发,10s=连缺 5 次)
TELEMETRY_INTERVAL_SEC = 1.0         # 服务端心跳发布周期(带负荷)
TELEMETRY_SAMPLE_INTERVAL_SEC = 0.02  # 遥测加权采样周期(20ms 记一次,1s 发布窗口均值——
                                      # 用户裁定:瞬时快照把尖峰定格成整秒状态,均值才反映负载曲线)
TASK_WARN_SEC = 40.0                 # 内层看门狗:任务超长警告阈值
TASK_HARD_SEC = 120.0                # 内层看门狗:硬上限→自杀重启(Python 杀不死线程)
GRAPH_DIFF_INTERVAL_SEC = 0.5        # 差分起步周期(按图规模自适应 0.5/1/3)

# ---- 业务常量 ----
TRUNCATE_LIMIT = 1000
WORKER_COUNT = 6              # 4→6(重设计 P2/E4:多卡死首触并发的容量余量)
WORKER_QUEUE_MAX = 256
REQUEST_TIMEOUT_SEC = 10.0    # 单 attempt 响应等待(双 attempt=2×)
WAIT_SERVICE_SEC = 3.0        # wait_for_service 上限(3s 发现不了=异常,失败即熔断)
CLIENT_IDLE_TTL_SEC = 60.0    # 闲置兜底 TTL(主通道=节点消失即墓碑清扫)
# 节点名带启动毫秒时间戳——多用户(A/B 窗口)各自拉起时不同名;过滤用前缀互滤
HELPER_NODE_BASE = "rde_param_helper"
HELPER_NODE_NAME = f"{HELPER_NODE_BASE}_{int(time.time() * 1000)}"

# ---- 磁盘日志:常驻句柄+锁+轮转(原逐行 open/write/close 3 系统调用→1;
#      每行仍 flush——崩溃回溯是这个日志的存在理由,不能缓冲掉尾部) ----
HELPER_DISK_LOG = os.path.join(tempfile.gettempdir(), "rde_param_helper.log")
_LOG_ROTATE_BYTES = 5 * 1024 * 1024
_log_lock = threading.Lock()
_log_file = None
_log_writes = 0


def _log_write_line(line):
    global _log_file, _log_writes
    if _log_file is None:
        _log_file = open(HELPER_DISK_LOG, "a", encoding="utf-8")
    _log_file.write(line)
    _log_file.flush()
    _log_writes += 1
    if _log_writes >= 64:   # 轮转检查降频:每 64 行看一次体量
        _log_writes = 0
        if _log_file.tell() > _LOG_ROTATE_BYTES:
            _log_file.close()
            try:
                os.replace(HELPER_DISK_LOG, HELPER_DISK_LOG + ".1")
            except OSError:
                pass
            _log_file = open(HELPER_DISK_LOG, "a", encoding="utf-8")


def disk_log(message):
    """独立调试日志:逐条追加 HELPER_DISK_LOG,扩展不读取;失败静默(不影响主流程)。
    每行带 pid——多扩展宿主并行时日志可归因(新架构下多窗口共享一个服务端,
    pid 归因用于区分"服务端自己"与历史实例的行)。"""
    try:
        with _log_lock:
            _log_write_line(time.strftime("[%Y-%m-%d %H:%M:%S] ")
                            + f"[pid={os.getpid()}] " + message + "\n")
    except OSError:
        pass


def helper_log(level, msg):
    """诊断出口:错误/警告写 stderr(扩展按 [rde-helper:level] 前缀分级落输出面板),
    同时落独立调试日志——从进程出生即存在(早于 socket 服务)。"""
    disk_log(f"[{level}] {msg}")
    sys.stderr.write(f"[rde-helper:{level}] {msg}\n")
    sys.stderr.flush()


def _on_sigterm(_signum, _frame):
    """SIGTERM → 干净退场(DDS dispose 即时摘图)后硬退;多线程形态下解释器终局
    清理不可靠(偶发 SIGABRT),所以从不裸 rclpy.shutdown 到底。迟导入防循环。"""
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass
    from . import ros_domain
    ros_domain.graceful_exit(0)


def register_sigterm():
    """SIGTERM 处理器注册(main() 显式调用;包导入零副作用)"""
    signal.signal(signal.SIGTERM, _on_sigterm)
