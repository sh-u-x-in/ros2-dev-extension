#!/usr/bin/env python3
"""助手测试夹具:冻结节点(节点名 /frozen_node)——「普通节点卡死」破坏性夹具。

行为:启动后先正常存活 RDE_FREEZE_AFTER 秒(默认 8,服务充分就绪),随后在定时器
回调里永久 sleep——执行器被回调挂住,参数/服务全部排队无人应答,即「普通节点的卡转」。
用于验证助手侧超时/熔断/「节点未应答」呈报的感与不静默。零 colcon,sourced env 直跑。
"""

import os
import time

import rclpy
from rclpy.executors import ExternalShutdownException

FREEZE_AFTER = float(os.environ.get("RDE_FREEZE_AFTER", "8") or 0)


def main(args=None):
    rclpy.init(args=args)
    try:
        node = rclpy.create_node("frozen_node")
        node.declare_parameter("alive", True)
        start = time.monotonic()
        frozen = {"done": False}

        def freeze():
            if frozen["done"] or time.monotonic() - start < FREEZE_AFTER:
                return
            frozen["done"] = True
            node.get_logger().warn(f"冻结开始(执行器挂住,全部服务停摆)@{FREEZE_AFTER:g}s")
            time.sleep(float("inf"))  # 永久挂住执行器;进程仍存活可 SIGINT

        node.create_timer(0.5, freeze)
        node.get_logger().info(f"rde 冻结节夹具就绪(/frozen_node):{FREEZE_AFTER:g}s 后冻结")
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
