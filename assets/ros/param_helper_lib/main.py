# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手 main(彻底推倒重来 2026-10-06):flock 仲裁→rclpy 初始化/GC 调优/节点与
订阅创建→全部线程组装(executor spin/图差分/client 清扫/worker 池×6/任务看门狗)
→server.run 阻塞于 accept 主循环。
信封帧协议:上行 {client,id,time,request{op}};下行 response/heartbeat/push;
无握手(accept 即注册),resync 由客户端连上后自觉先发。
退出路径:SIGTERM(扩展 stop)/零客户端宽限自退(server)/任务硬超时自杀(worker)。"""

import gc
import queue
import threading

import rclpy
from rcl_interfaces.msg import ParameterEvent
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node

from . import events, ros_domain, server, worker
from .events import event_sender_loop, graph_diff_loop, on_parameter_event
from .kernel import (
    HELPER_NODE_NAME, WORKER_COUNT, WORKER_QUEUE_MAX, disk_log, register_sigterm,
)
from .ros_domain import client_cleanup_loop


def main():
    # 冷启动仲裁:抢锁败者立即退出(扩展端 spawn 后轮询连接,自然命中抢到锁的胜者)
    if not server.acquire_lock():
        disk_log("flock 被占:已有服务端实例,败者退出")
        return
    register_sigterm()
    disk_log("main: 启动(服务端形态,信封帧协议)")
    rclpy.init()
    # GC 调优(2026-09-27 沿袭):差分/事件每周期产出数万临时对象,默认 gen0 阈值 700
    # 反复触发全代回收造成停顿;调大阈值 + 冻结启动期对象进永久代
    gc.set_threshold(50000, 50, 50)
    gc.collect()
    gc.freeze()
    node = Node(HELPER_NODE_NAME)
    executor = SingleThreadedExecutor()
    executor.add_node(node)
    ros_domain.node = node
    ros_domain.executor = executor

    # 事件总线:参数原生事件订阅(executor 线程回调只入队)
    node.create_subscription(ParameterEvent, "/parameter_events", on_parameter_event, 10)

    worker_queues = [queue.Queue(maxsize=WORKER_QUEUE_MAX) for _ in range(WORKER_COUNT)]

    def dispatch(conn, client_pid, client_time, rid, op, req):
        def respond(ok, data=None, error=None):
            server.send_response(conn, client_pid, client_time, rid, ok, data, error)
        worker.dispatch(worker_queues, respond, rid, op, req, conn)

    def telemetry():
        return {"busy": worker.busy_count,
                "q": [q.qsize() for q in worker_queues],
                "inf": ros_domain.total_inflight(),
                "brk": len(ros_domain.breaker_until),
                "eq": events.event_queue.qsize(),
                "rss": server.read_rss_kb()}

    worker.init_workers(worker_queues)   # 队列注入(推送域 submit 与派发共用)
    threads = [
        threading.Thread(target=executor.spin, daemon=True),
        threading.Thread(target=graph_diff_loop, daemon=True),
        threading.Thread(target=client_cleanup_loop, daemon=True),
        threading.Thread(target=event_sender_loop, daemon=True),
        threading.Thread(target=worker.watchdog_loop, daemon=True),
    ]
    for i, q in enumerate(worker_queues):
        threads.append(threading.Thread(target=worker.worker_loop, args=(q, i), daemon=True))
    for t in threads:
        t.start()
    disk_log(f"main: 全部线程已起({len(threads)}),进入 accept 主循环")

    # 阻塞于服务端 accept 主循环(永不返回;退出路径全部走 os._exit)
    server.run(dispatch, telemetry)
