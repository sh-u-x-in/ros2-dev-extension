#!/usr/bin/env python3
# 常驻助手入口(十九轮批4b 薄启动壳;2026-10-06 彻底推倒重来为信封帧协议)。
#
# 架构一句话:全局唯一助手服务端 + 多窗口客户端,一切帧复用单条固定路径 Unix socket
# (/tmp/rde_param_helper.sock),一行 JSON 一帧:
#   客户端→服务端:首帧 hello 环境指纹握手(P4:proto+ROS_VERSION/DISTRO/DOMAIN_ID/RMW,
#                  服务端不匹配回 deny 并踢除),此后 {client,id,time,request{op}}(resync 紧随/
#                  ping 心跳/订阅制参数/全值/表单);
#   服务端→客户端:{service,time,cl-num}+response(只回发起连接)|heartbeat(1s 带负荷)|push(广播;
#                  图全量/参数名册/生命周期权威;param 按订阅账本定向)|deny(指纹不匹配)。
# 生命周期:flock 抢锁败者立退;连接归零+宽限自退;SIGTERM 立退;任务硬超时自杀重启。
#
# P4 启动预检(2026-10-18):导入/函数对象逐项核验,**位掩码编码退出码 = 100 + mask**——
# TS 侧(param-helper-client exit 分支)按位译码告知用户哪一项不可用,并立即熔断不重拉:
#   0x01 rclpy 导入失败            0x02 rcl_interfaces 导入失败
#   0x04 param_helper_lib 导入失败  0x08 main 不可调用(跨版本行为变化指示)
#   0x10 kernel.disk_log 不可调用(诊断通道丢失;本项降级 stderr-only,不阻断其余报告)
# 详单与模块地图见 param_helper_lib/__init__.py 与各模块 docstring。

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PREFLIGHT_BASE = 100  # 预检退出码基线(避开既有 0=正常/败者、2=任务硬超时)


def _preflight() -> None:
    """启动预检(用户裁定 2026-10-18):位掩码逐项核验,失败即结构化退出。
    顺序注意:kernel 先于 main(kernel 零 rclpy 依赖,disk_log 是本函数自己的报告通道)。"""
    mask = 0
    detail = []
    main_callable = None
    disk_log = None

    try:
        import rclpy  # noqa: F401
    except Exception as e:  # noqa: BLE001 — 预检要按位收集,不能让首个失败炸掉后续
        mask |= 0x01
        detail.append(f"rclpy: {type(e).__name__}: {e}")

    try:
        import rcl_interfaces  # noqa: F401
    except Exception as e:  # noqa: BLE001
        mask |= 0x02
        detail.append(f"rcl_interfaces: {type(e).__name__}: {e}")

    try:
        from param_helper_lib import kernel as _kernel
        from param_helper_lib.main import main as _main
        main_callable = _main
        disk_log = _kernel.disk_log
    except Exception as e:  # noqa: BLE001
        mask |= 0x04
        detail.append(f"param_helper_lib: {type(e).__name__}: {e}")

    # 函数对象核验(防跨版本行为变化:模块在、对象不在/不可调用)
    if main_callable is not None and not callable(main_callable):
        mask |= 0x08
        detail.append("param_helper_lib.main.main is not callable")
    if disk_log is not None and not callable(disk_log):
        mask |= 0x10
        detail.append("kernel.disk_log is not callable")
        disk_log = None  # 诊断通道降级:后续只走 stderr

    if mask:
        # 报告行携带解释器身份(A,2026-10-18):conda/pyenv 前置雷一眼见底——
        # "rclpy 缺失"的真因往往是 PATH 上排在系统解释器前面的其它 python
        line = (f"preflight mask=0x{mask:02x} (" + "; ".join(detail) + ")"
                f" python={sys.executable} ({sys.version.split()[0]})")
        try:
            if disk_log is not None:
                disk_log(f"[预检失败] {line}")
        except Exception:  # noqa: BLE001 — 报告通道自身失败不阻断 stderr 退出
            pass
        sys.stderr.write(f"[rde-helper:error] {line}\n")
        sys.stderr.flush()
        sys.exit(PREFLIGHT_BASE + mask)

    # 成功也留解释器身份(A):每次助手启动都在 /tmp/rde_param_helper.log 可查当时用的哪个 python
    disk_log(f"preflight ok: python={sys.executable} ({sys.version.split()[0]})")


_preflight()

from param_helper_lib.main import main  # noqa: E402


def _ext_version_arg() -> str:
    """扩展版本号(版本治理 2026-10-20,规范=TS 侧 VERSION-CONTROL.md):TS spawn 经
    argv `--ext-version N.N.N` 传入,写进锁文件第 4 字段;缺省/空=占位 "0"(客户端按
    「最旧」处置,会被带版本的客户端杀旧拉新)。取首 token——锁文件是空白分隔行,版本
    自身不许含空白。"""
    args = sys.argv[1:]
    if "--ext-version" in args:
        i = args.index("--ext-version")
        if i + 1 < len(args):
            tokens = args[i + 1].strip().split()
            if tokens:
                return tokens[0]
    return "0"


if __name__ == "__main__":
    try:
        main(ext_version=_ext_version_arg())
    except KeyboardInterrupt:
        pass
