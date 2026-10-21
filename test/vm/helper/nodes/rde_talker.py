#!/usr/bin/env python3
"""助手测试夹具:普通 talker(节点名 /talker,替代 demo_nodes_cpp talker)。

零 colcon 依赖,sourced ROS env 下直接 `python3 rde_talker.py` 运行。
场景依赖面:节点在图 / use_sim_time 参数可读写 / 周期发布话题(图 realism)。
SIGINT 安全(ExternalShutdownException 守卫),退场不留残骸。
"""

import rclpy
from rclpy.executors import ExternalShutdownException
from std_msgs.msg import String


def main(args=None):
    rclpy.init(args=args)
    try:
        node = rclpy.create_node("talker")
        pub = node.create_publisher(String, "chatter", 10)
        count = 0

        def tick():
            nonlocal count
            count += 1
            msg = String()
            msg.data = f"rde fixture talker #{count}"
            pub.publish(msg)

        node.create_timer(1.0, tick)
        node.get_logger().info("rde 测试 talker 就绪(/talker)")
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
