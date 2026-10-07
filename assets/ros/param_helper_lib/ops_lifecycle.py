# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手生命周期域(彻底推倒重来 2026-10-06):op_lifecycle_get 已随订阅制删除
(状态只经权威 lifecycle push 下发);留守 op_lifecycle_info=推送域内部函数
(events 经 worker.submit 调用),三问并行(P3):get_state/get_available_states/
get_transition_graph 三次独立服务调用并发发起,等待时间 3×→1×;
吃常驻 client 缓存与熔断红利;转换执行在扩展 CLI(协议只读不写)。"""

import time

from lifecycle_msgs.srv import GetAvailableStates, GetAvailableTransitions, GetState

from .kernel import disk_log
from .ros_domain import ros_call


def op_lifecycle_info(req):
    """三问串行(2026-10-06 节点串行访问裁定的连坐:并行三问会被自家第一问的
    单飞闸门挡住两问):健康时三问各毫秒级(总耗~10ms 无感);卡住时第一问烧满 10s
    开熔断,后两问熔断快失败——总耗从"多线程各烧 10s"收敛为"单线程一次 10s"。"""
    target = req.get("node", "")
    t0 = time.monotonic()
    current_resp = ros_call(target, GetState, "/get_state", GetState.Request())
    states_resp = ros_call(target, GetAvailableStates, "/get_available_states",
                           GetAvailableStates.Request())
    graph_resp = ros_call(target, GetAvailableTransitions, "/get_transition_graph",
                          GetAvailableTransitions.Request())

    current = {"id": int(current_resp.current_state.id), "label": str(current_resp.current_state.label)}
    states = [{"id": int(s.id), "label": str(s.label)} for s in states_resp.available_states]
    edges = [{"id": int(td.transition.id), "label": str(td.transition.label),
              "fromLabel": str(td.start_state.label), "toLabel": str(td.goal_state.label)}
             for td in graph_resp.available_transitions]
    available = [e["label"] for e in edges if e["fromLabel"] == current["label"]]
    # 埋点沿袭:三问总耗时(信息链健康度一眼可见)
    disk_log(f"lifecycle_info {target} → state={current['label']} states={len(states)}"
             f" edges={len(edges)} avail={available}"
             f"({(time.monotonic() - t0) * 1000:.0f}ms, 串行三问)")
    return {"currentState": current, "states": states, "edges": edges, "availableTransitions": available}
