#!/usr/bin/env python3
"""助手测试夹具:listener(节点名 /listener,替代 demo_nodes_cpp listener)。

零 colcon 依赖,sourced ROS env 下直接 `python3 rde_listener.py` 运行。
场景依赖面:节点在图(依赖判定);订阅 /chatter 计数(日志可见,不参与断言)。
SIGINT 安全,退场不留残骸。
"""

import rclpy
from rclpy.executors import ExternalShutdownException
from std_msgs.msg import String


def main(args=None):
    rclpy.init(args=args)
    try:
        node = rclpy.create_node("listener")
        count = 0

        def on_msg(msg):
            nonlocal count
            count += 1
            if count % 10 == 1:
                node.get_logger().info(f"已收 {count} 条(最新: {msg.data})")

        node.create_subscription(String, "chatter", on_msg, 10)
        node.get_logger().info("rde 测试 listener 就绪(/listener)")
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
