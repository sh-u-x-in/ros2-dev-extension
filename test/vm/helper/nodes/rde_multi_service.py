#!/usr/bin/env python3
"""助手测试夹具:多服务节点(节点名 /multi_service,3 个服务)。

服务用 example_interfaces 通用类型(与 get_form 场景同源),供「节点服务面」
与图服务计数的常态化验证。零 colcon,sourced env 下直跑。
"""

import rclpy
from rclpy.executors import ExternalShutdownException
from example_interfaces.srv import AddTwoInts, SetBool, Trigger


def main(args=None):
    rclpy.init(args=args)
    try:
        node = rclpy.create_node("multi_service")

        def add(req, resp):
            resp.sum = req.a + req.b
            return resp

        def set_bool(req, resp):
            resp.success = req.data
            resp.message = "flag updated"
            return resp

        def trigger(req, resp):
            resp.success = True
            resp.message = "reset done"
            return resp

        node.create_service(AddTwoInts, "multi_service/add", add)
        node.create_service(SetBool, "multi_service/set_flag", set_bool)
        node.create_service(Trigger, "multi_service/reset", trigger)
        node.get_logger().info("rde 多服务夹具就绪(/multi_service):add/set_flag/reset")
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
