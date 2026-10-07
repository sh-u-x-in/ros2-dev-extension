#!/usr/bin/env python3
# 常驻助手入口(十九轮批4b 薄启动壳;2026-10-06 彻底推倒重来为信封帧协议)。
#
# 架构一句话:全局唯一助手服务端 + 多窗口客户端,一切帧复用单条固定路径 Unix socket
# (/tmp/rde_param_helper.sock),一行 JSON 一帧:
#   客户端→服务端:{client,id,time,request{op}}(resync 自动首发/ping 心跳/订阅制参数/全值/表单);
#   服务端→客户端:{service,time,cl-num}+response(只回发起连接)|heartbeat(1s 带负荷)|push(广播;
#                  图全量/参数名册/生命周期权威;param 按订阅账本定向)。
# 无握手(accept 即注册);生命周期:flock 抢锁败者立退;连接归零+宽限自退;SIGTERM 立退;
# 任务硬超时自杀重启。
#
# 详单与模块地图见 param_helper_lib/__init__.py 与各模块 docstring。

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from param_helper_lib.main import main  # noqa: E402

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
