# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手事件总线(彻底推倒重来 2026-10-06):服务端数据面心脏。
①带类型图差分(0.5/1/3s 自适应)只用于检测"变没变"——变了就广播**全量 graph push**,
无增量无版本号(图快照毫秒级,全量推省掉两端对账机器);节点消失=列表里没了,
同时清各连接账目与详情推送标记;
②参数原生事件(/parameter_events)回调只入队原始消息,发送线程转换后按各连接
订阅账本过滤**定向推 param 帧**(没订阅的连接收不到);参数增删→广播 param_structure;
③transition_event→**权威 lifecycle push**(转换图整包,边无 id)——轻量状态事件删除,
权威重推即通知,最后一次永远是对的;
④resync=快照数据经回应返回(ops._op_resync 调 ensure_graph/build_graph_snapshot/
push_auxiliaries),连接早于首轮差分的竞态在 ensure_graph 内联建档兜底。
门铃(DDS 图变更事件)经 Humble rclpy 探针验证不可用,自适应轮询即终态方案(沿袭)。"""

import queue
import threading
import time

import rclpy.qos
from rcl_interfaces.msg import ParameterEvent
from lifecycle_msgs.msg import TransitionEvent

from . import ros_domain, server, worker
from .kernel import GRAPH_DIFF_INTERVAL_SEC, HELPER_NODE_BASE, disk_log, helper_log
from .ops_lifecycle import op_lifecycle_info
from .ops_params import value_to_json, op_param_structure
from .ros_domain import (
    _canon_node, clients_lock, own_service_targets,
    sweep_clients_for_removed_nodes,
)

LIFECYCLE_MARKER_TYPE = "lifecycle_msgs/srv/GetState"
LIFECYCLE_MARKER_SUFFIX = "/get_state"

event_queue: queue.Queue = queue.Queue(maxsize=1000)
# 可见图快照:name → 类型串(nodes 为 name → namespace);None=尚未建档
last_graph: dict = {"nodes": None, "topics": None, "services": None}
_subs_lock = threading.Lock()
_lifecycle_subs: dict = {}   # 节点全名 → subscription(transition_event 订阅账本)
_lifecycle_info_pushed: set = set()   # 已推送过详情的生命周期节点(未推=待推;转换后重推)


def _typed_diff(prev, current):
    """名字→类型 字典差分 → (added{名字:类型}, removed[名字], changed{名字:新类型})"""
    added = {n: t for n, t in current.items() if n not in prev}
    removed = sorted(n for n in prev if n not in current)
    changed = {n: t for n, t in current.items() if n in prev and prev[n] != t}
    return added, removed, changed


def check_graph_change():
    """差分定时(独立线程):可见图快照对比;有变化→全量 graph push 广播。
    快照先行落账(last_graph)再推——任何随后到来的 resync 读缓存必见新数据。"""
    try:
        with clients_lock:
            own_targets = dict(own_service_targets)
        node_entries = ros_domain.node.get_node_names_and_namespaces()
        current_nodes = {}
        for entry in node_entries:
            fullname = _canon_node(entry[1] + entry[0])
            # 过滤:助手自身 + ros2 CLI 临时节点(用户裁定 2026-10-06:_ros2cli_* 朝生暮死,
            # 是终端命令的影子,追它们的尸体只会白烧 wait_for_service——不进图、不触发推送)
            if entry[0].startswith(HELPER_NODE_BASE) or entry[0].startswith("_ros2cli"):
                continue
            current_nodes[fullname] = entry[1]
        current_topics = {t[0]: ", ".join(t[1]) for t in ros_domain.node.get_topic_names_and_types()}
        # 助手自托管的参数服务(describe/get/list/set_parameters 等)同滤——不滤则空场时
        # 观察者效应把 6 条 /rde_param_helper_* 服务顶进图(F5 实测,2026-10-07)
        own_prefix = "/" + HELPER_NODE_BASE
        current_services = {s[0]: ", ".join(s[1]) for s in ros_domain.node.get_service_names_and_types()
                            if not s[0].startswith(own_prefix)
                            and not (s[0] in own_targets and own_targets[s[0]] not in current_nodes)
                            and not s[0].startswith("/_ros2cli")}
    except Exception as e:  # noqa: BLE001 — 差分失败本轮跳过,但必须留痕
        helper_log("warn", f"graph diff query failed: {e}")
        return

    prev = last_graph
    if prev["nodes"] is None or prev["topics"] is None or prev["services"] is None:
        prev.update({"nodes": current_nodes, "topics": current_topics, "services": current_services})
        return   # 初次建档不推(连接方 resync 会取到;避免半档快照外出)

    added_nodes, removed_nodes, _ = _typed_diff(prev["nodes"], current_nodes)
    added_topics, removed_topics, changed_topics = _typed_diff(prev["topics"], current_topics)
    added_services, removed_services, changed_services = _typed_diff(prev["services"], current_services)
    if not (added_nodes or removed_nodes or added_topics or removed_topics
            or changed_topics or added_services or removed_services or changed_services):
        return
    prev.update({"nodes": current_nodes, "topics": current_topics, "services": current_services})
    disk_log("图变化 " + " ".join(
        f"{k}={len(v) if isinstance(v, (list, dict)) else v}"
        for k, v in (("added_nodes", added_nodes), ("removed_nodes", removed_nodes),
                     ("added_topics", added_topics), ("removed_topics", removed_topics),
                     ("changed_topics", changed_topics), ("added_services", added_services),
                     ("removed_services", removed_services), ("changed_services", changed_services))))
    sweep_clients_for_removed_nodes(removed_nodes)
    for n in removed_nodes:
        server.ledger_drop_node(n)          # 账目随节点清(裁定⑤服务端侧)
        _lifecycle_info_pushed.discard(n)   # 消失的生命周期节点清详情推送标记
    for n in added_nodes:
        _push_param_structure(n)            # 新节点推参数名册
    server.broadcast_push({"kind": "graph", **build_graph_snapshot()})


def ensure_graph():
    """连接早于首轮差分的竞态兜底:快照未建档就立即差分一次(resync 入口调用)"""
    if last_graph["nodes"] is None and ros_domain.node is not None:
        check_graph_change()


def build_graph_snapshot():
    """全量图快照(读差分缓存,毫秒级):节点全名一列(滤助手自身)+
    topics/services 名字→类型映射 + 生命周期节点全名清单"""
    nodes_all = last_graph["nodes"] or {}
    topics = last_graph["topics"] or {}
    services = last_graph["services"] or {}
    nodes = sorted(n for n in nodes_all if not n[len("/"):].startswith(HELPER_NODE_BASE))
    return {"nodes": nodes, "topics": topics, "services": services,
            "lifecycle": sorted(_lifecycle_nodes_of(services))}


def push_auxiliaries():
    """resync 后的逐帧补推:每个节点的参数名册 + 每个生命周期节点的权威详情(均广播)"""
    for fullname in (last_graph["nodes"] or {}):
        if not fullname[len("/"):].startswith(HELPER_NODE_BASE):
            _push_param_structure(fullname)
    for lc in sorted(_lifecycle_nodes_of(last_graph["services"] or {})):
        _push_lifecycle_info(lc)


def _lifecycle_nodes_of(services):
    """服务快照 → 生命周期节点全名集合(GetState 标记 + /get_state 后缀,判据与扩展 classify 同)"""
    out = set()
    for name, t in services.items():
        if LIFECYCLE_MARKER_TYPE in t and name.endswith(LIFECYCLE_MARKER_SUFFIX):
            out.add(name[: -len(LIFECYCLE_MARKER_SUFFIX)])
    return out


# ---- 推送域:服务端主动取数并广播 ----

def _breaker_open(target):
    """熔断在账即跳过(用户裁定 2026-10-07"不管了"):该节点曾失败,开断期间一切服务端
    主动调用跳过、冷却期满也**不自动重试**——没有用户触发就不花任何力气;
    账只在成功的用户查询后清除(ros_call 成功摘账)或节点消失时被墓碑清扫清掉,
    届时推送自然恢复。"""
    return _canon_node(target) in ros_domain.breaker_until


def _submit_push(op_func, req, on_ok):
    """推送任务提交(串行闸门容忍,用户裁定 2026-10-06 的配套):撞上同节点在途调用
    被串行闸门拒绝时延迟重投(0.5s×至多 5 次)——推送幂等可重触发,重投零损失;
    熔断等其他失败不重试(等下个触发源:节点出现/参数增删/转换/resync)。"""
    attempts = 0

    def _done(ok, data=None, error=None):
        nonlocal attempts
        if ok:
            on_ok(data)
            return
        if "串行" in (error or "") and attempts < 5:
            attempts += 1
            timer = threading.Timer(0.5, lambda: worker.submit(op_func, req, _done))
            timer.daemon = True
            timer.start()

    worker.submit(op_func, req, _done)


def _push_param_structure(target):
    """取某节点参数名册(list+types)并广播;失败(含熔断快失败)静默——
    重试由触发源驱动:节点出现/参数增删/resync 都会再触发。"""
    if _breaker_open(target):
        return
    _submit_push(op_param_structure, {"node": target},
                 lambda data: server.broadcast_push(
                     {"kind": "param_structure", "node": target, "params": data}))


def _map_lifecycle_wire(info):
    """op_lifecycle_info 结果 → 线路形状(边无 id,最后一次永远是对的)"""
    return {"state": info["currentState"]["label"],
            "states": [s["label"] for s in info["states"]],
            "edges": [{"label": e["label"], "from": e["fromLabel"], "to": e["toLabel"]}
                      for e in info["edges"]],
            "available": list(info["availableTransitions"])}


def _push_lifecycle_info(target):
    """取某生命周期节点三连详情并广播权威 lifecycle 帧;成功才推
    (熔断在账直接跳过,冷却期满也不自动尝试);转换事件后也会重推一次。"""
    if _breaker_open(target):
        return
    def _on_ok(data):
        _lifecycle_info_pushed.add(target)
        server.broadcast_push({"kind": "lifecycle", "node": target,
                               **_map_lifecycle_wire(data)})

    _submit_push(op_lifecycle_info, {"node": target}, _on_ok)


def on_parameter_event(msg):
    """/parameter_events 原生订阅(executor 线程回调):**只入队原始 ParameterValue,
    不做任何转换**——转换与账本过滤都在 event_sender_loop(执行器线程专管服务响应回调)。
    助手自身与 _ros2cli 临时节点的事件直接丢弃(2026-10-07):图过滤挡不住事件路径,
    cli 节点的参数宣告会触发名册补推 → 白烧 3s wait_for_service(F 批 C5 实测)。"""
    try:
        if not (msg.changed_parameters or msg.new_parameters or msg.deleted_parameters):
            return
        node = _canon_node(msg.node)
        if node.startswith("/" + HELPER_NODE_BASE) or node.startswith("/_ros2cli"):
            return
        disk_log(f"参数事件 node={node} changed={len(msg.changed_parameters)}"
                 f" new={len(msg.new_parameters)} deleted={len(msg.deleted_parameters)}")
        event_queue.put({"kind": "param_raw", "node": node,
                         "changed": [(p.name, p.value) for p in msg.changed_parameters],
                         "new": [(p.name, p.value) for p in msg.new_parameters],
                         "deleted": [p.name for p in msg.deleted_parameters]})
    except queue.Full:
        # 事件队列溢出:无 events_lost 补丁接口(裁定),丢帧由客户端周期 resync 兜底
        helper_log("warn", "event queue full; dropped one parameter event")
    except Exception as e:  # noqa: BLE001 — 事件失败不影响主流程,但必须留痕
        helper_log("warn", f"parameter event handling failed: {e}")


def _distribute_param_push(node, changed_pairs, deleted_names):
    """param push 定向分发:逐连接按其账本过滤(没订阅的连接收不到任何字节)"""
    for conn, held in server.iter_ledger_entries(node):
        values = {n: v for n, v in changed_pairs if n in held}
        deleted_hit = [n for n in deleted_names if n in held]
        if not values and not deleted_hit:
            continue
        server.send_to(conn, {"kind": "param",
                              "values": {node: values} if values else {},
                              "deleted": {node: deleted_hit} if deleted_hit else {}})


def _on_transition_event(node_full):
    """~/transition_event 回调(executor 线程,只入队):权威详情重推的触发器"""
    def _cb(msg):
        try:
            event_queue.put({"kind": "transition", "node": node_full})
        except queue.Full:
            pass   # 转换推送丢弃可接受(下一轮差分/重同步兜底)
        except Exception as e:  # noqa: BLE001
            helper_log("warn", f"transition event handling failed: {e}")
    return _cb


def _reconcile_lifecycle_subs():
    """transition_event 订阅账本对账:期望集合=当前可见图里的生命周期节点;
    新节点挂订阅(传感器 QoS:pub 侧 best-effort 也兼容),消失节点摘除。
    由 graph_diff_loop 每轮调用(判据轻:集合比对)。"""
    if last_graph["services"] is None or ros_domain.node is None:
        return
    desired = _lifecycle_nodes_of(last_graph["services"])
    with _subs_lock:
        stale = [n for n in _lifecycle_subs if n not in desired]
        fresh = [n for n in desired if n not in _lifecycle_subs]
        for n in stale:
            sub = _lifecycle_subs.pop(n)
            try:
                ros_domain.node.destroy_subscription(sub)
            except Exception as e:  # noqa: BLE001 — 摘除失败留痕,下轮再试
                helper_log("warn", f"transition_event unsubscribe failed ({n}): {e}")
        for n in fresh:
            try:
                # 签名=(msg_type, topic, callback, qos);传感器 QoS:pub 侧 best-effort 也兼容
                sub = ros_domain.node.create_subscription(
                    TransitionEvent,
                    n + "/transition_event",
                    _on_transition_event(n),
                    rclpy.qos.qos_profile_sensor_data)
                _lifecycle_subs[n] = sub
            except Exception as e:  # noqa: BLE001 — 单节点订阅失败不拖垮差分(下轮对账重试)
                helper_log("warn", f"transition_event subscribe failed ({n}): {e}")
        # 推送域:新认出的生命周期节点推权威详情
        for n in fresh:
            _push_lifecycle_info(n)
        if fresh or stale:
            disk_log(f"transition_event 订阅对账:+{len(fresh)}/-{len(stale)}"
                     f"(当前 {len(_lifecycle_subs)} 个)")


def graph_diff_loop():
    """差分独立线程:每轮 快照对比→(有变化全量推)→订阅对账;周期按图规模自适应
    (小 0.5s / 中 1s / 大 3s),源头控制对象产出与 GC 压力。"""
    period = GRAPH_DIFF_INTERVAL_SEC
    while True:
        time.sleep(period)
        check_graph_change()
        _reconcile_lifecycle_subs()
        nodes = len(last_graph["nodes"]) if last_graph["nodes"] is not None else 0
        services = len(last_graph["services"]) if last_graph["services"] is not None else 0
        size = nodes + services
        period = 0.5 if size < 50 else (1.0 if size < 200 else 3.0)


def event_sender_loop():
    """事件推专线程:从 event_queue 消费→转换→分发。
    param_raw:转换后按账本定向推;增删(名册变)重推 param_structure;
    transition:重推权威 lifecycle 详情(推送即通知)。"""
    while True:
        item = event_queue.get()
        kind = item.get("kind")
        if kind == "param_raw":
            try:
                changed = []
                for name, pv in item["changed"] + item["new"]:
                    try:
                        changed.append((name, value_to_json(pv)))
                    except Exception as e:  # noqa: BLE001 — 单项转换失败只降级该项
                        helper_log("warn", f"param value convert failed ({name}): {e}")
                _distribute_param_push(item["node"], changed, item["deleted"])
                if item["new"] or item["deleted"]:
                    # 参数名册变了 → 广播 param_structure(值由客户端按订阅关系收)
                    _push_param_structure(item["node"])
            except Exception as e:  # noqa: BLE001 — 单事件失败不拖垮发送线程
                helper_log("warn", f"param event handling failed: {e}")
        elif kind == "transition":
            try:
                _push_lifecycle_info(item["node"])
            except Exception as e:  # noqa: BLE001
                helper_log("warn", f"transition repush failed: {e}")
        # 未知 kind:忽略(前向兼容留位)
