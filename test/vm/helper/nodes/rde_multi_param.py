#!/usr/bin/env python3
"""助手测试夹具:多参数节点(节点名 /multi_param)。

12 个参数覆盖全部参数类型与点分命名空间(基本/数组/字符串/字节),
供订阅/批量取值/参数树点分层级的常态化验证。零 colcon,sourced env 下直跑。
"""

import rclpy
from rclpy.executors import ExternalShutdownException


def main(args=None):
    rclpy.init(args=args)
    try:
        node = rclpy.create_node("multi_param")
        decl = [
            ("flag", True),
            ("level", 3),
            ("ratio", 0.5),
            ("label", "rde-fixture"),
            ("flags", [True, False, True]),
            ("levels", [1, 2, 3]),
            ("ratios", [0.1, 0.2]),
            ("labels", ["a", "b"]),
            ("group.depth", 2),
            ("group.mode", "nested"),
            ("group.ratios", [9.9, 8.8, 7.7]),
            ("group.flags", [False, True]),
        ]
        for name, value in decl:
            node.declare_parameter(name, value)
        node.get_logger().info(f"rde 多参数夹具就绪(/multi_param):{len(decl)} 参全类型")
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
