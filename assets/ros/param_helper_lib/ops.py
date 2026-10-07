# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手 op 注册表(彻底推倒重来 2026-10-06):仅保留"客户端意图触发"的操作——
订阅制参数取值(get/unget_param_values)、截断全值(save_param_values)、
表单内省(get_form)、重同步(resync)。图/参数名册/生命周期详情已转为服务端主动推送,
不在注册表;ping 在分发层就地秒回空 data,不入表。
op 签名统一 (req, conn)——订阅类 op 需要连接以记账;推送域任务经 worker.submit 包装为
无连接形态调用。"""

from .ops_forms import op_get_form
from .ops_params import (
    op_get_param_values, op_save_param_values, op_unget_param_values,
)


def _op_resync(req, conn):
    """op=resync:回应=全量图快照(读差分缓存,毫秒级);随后参数名册/生命周期详情
    经池逐帧补推(广播)。延迟导入防循环(events→worker→ops)。"""
    from . import events
    events.ensure_graph()
    data = events.build_graph_snapshot()
    events.push_auxiliaries()
    return data


OPS = {
    "resync": _op_resync,
    "get_param_values": op_get_param_values,
    "unget_param_values": op_unget_param_values,
    "save_param_values": op_save_param_values,
    "get_form": op_get_form,
}
