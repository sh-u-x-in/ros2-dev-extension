#!/usr/bin/env python3
"""助手测试夹具:动作服务器(节点名 /action_server,example_interfaces/action/Fibonacci)。

动作类型与 get_form 场景同源(表单内省可测)。执行回调逐 1s 回馈,
目标 order 被钳到 [0, 10] 防滥用。零 colcon,sourced env 下直跑。
"""

import time

import rclpy
from rclpy.action import ActionServer
from rclpy.executors import ExternalShutdownException
from example_interfaces.action import Fibonacci


def main(args=None):
    rclpy.init(args=args)
    try:
        node = rclpy.create_node("action_server")

        def execute(goal_handle):
            order = max(0, min(10, goal_handle.request.order))
            fb = Fibonacci.Feedback()
            fb.sequence = []
            for i in range(order):
                fb.sequence.append(i if i < 2 else fb.sequence[-1] + fb.sequence[-2])
                goal_handle.publish_feedback(fb)
                time.sleep(1.0)
            goal_handle.succeed()
            result = Fibonacci.Result()
            result.sequence = fb.sequence
            return result

        ActionServer(node, Fibonacci, "action_server/fibonacci", execute)
        node.get_logger().info("rde 动作服务器夹具就绪(/action_server,Fibonacci)")
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
