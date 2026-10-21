#!/usr/bin/env python3
"""助手测试夹具:生命周期 talker(节点名 /lc_talker,替代 demo lifecycle_talker)。

零 colcon 依赖,sourced ROS env 下直接 `python3 rde_lc_talker.py` 运行。
标准生命周期全转换链(unconfigured→inactive→active→…),转换回调恒 SUCCESS,
行为完全符合预期——健康版是 32 场景套件的常驻夹具。

模拟挂断(破坏性夹具,UI 超时测试专用):
    RDE_TEST_HANG_SEC=600 python3 rde_lc_talker.py
on_configure 进入即睡指定秒数——执行器被回调挂住,参数/get_state 服务全部
无人应答(复现「助手在线但节点未应答」)。默认 0=完全健康。
SIGINT 安全,退场不留残骸。
"""

import os
import time

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.lifecycle import LifecycleNode
from rclpy.lifecycle import LifecycleState
from rclpy.lifecycle import TransitionCallbackReturn
from std_msgs.msg import String

HANG_SEC = float(os.environ.get("RDE_TEST_HANG_SEC", "0") or 0)


class LifecycleTalker(LifecycleNode):

    def __init__(self):
        super().__init__("lc_talker")
        self.pub = None
        self.timer = None
        self.count = 0
        self.get_logger().info(
            f"构造完成: 当前 unconfigured (RDE_TEST_HANG_SEC={HANG_SEC:g});"
            "用 ros2 lifecycle set /lc_talker <transition> 驱动")

    def on_configure(self, state: LifecycleState) -> TransitionCallbackReturn:
        if HANG_SEC > 0:
            # 破坏性夹具:回调内挂住,执行器停摆,全部服务排队无人应答
            self.get_logger().warn(f"on_configure(): 模拟挂断 {HANG_SEC:g}s")
            time.sleep(HANG_SEC)
        self.pub = self.create_lifecycle_publisher(String, "lc_chatter", 10)
        self.timer = self.create_timer(1.0, self._publish_once)
        self.timer.cancel()  # 先待命, 进入 active 才启动
        self.get_logger().info(f"on_configure(): {state.label} → inactive")
        return TransitionCallbackReturn.SUCCESS

    def on_activate(self, state: LifecycleState) -> TransitionCallbackReturn:
        self.timer.reset()
        self.get_logger().info(f"on_activate(): {state.label} → active, 开始每秒发布")
        return super().on_activate(state)

    def on_deactivate(self, state: LifecycleState) -> TransitionCallbackReturn:
        self.timer.cancel()
        self.get_logger().info(f"on_deactivate(): {state.label} → inactive")
        return super().on_deactivate(state)

    def on_cleanup(self, state: LifecycleState) -> TransitionCallbackReturn:
        self.destroy_timer(self.timer)
        self.timer = None
        self.destroy_lifecycle_publisher(self.pub)
        self.pub = None
        self.get_logger().info(f"on_cleanup(): {state.label} → unconfigured")
        return TransitionCallbackReturn.SUCCESS

    def _publish_once(self):
        self.count += 1
        msg = String()
        msg.data = f"Lifecycle Hello #{self.count}"
        self.pub.publish(msg)
        self.get_logger().info(f"发布: {msg.data}")


def main(args=None):
    rclpy.init(args=args)
    try:
        node = LifecycleTalker()
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
