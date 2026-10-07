# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手参数域(彻底推倒重来 2026-10-06):订阅制取值(get_param_values=计入
连接账本+回底账与账本回显)、退订(unget_param_values)、截断全值批量
(save_param_values,落盘归客户端,服务端只回值)、参数名册结构(op_param_structure,
推送域内部函数)。rcl 参数值 → JSON 原生转换(含截断标记)。"""

from rcl_interfaces.srv import GetParameters, GetParameterTypes, ListParameters

from . import server
from .kernel import TRUNCATE_LIMIT, disk_log
from .ros_domain import _canon_node, ros_call

# 数组类型的原始序列提取与逐项转换器(2026-09-27:先判长再转换,截断场景省 90% 转换)
_ARRAY_SOURCES = {
    5: lambda pv: pv.byte_array_value,
    6: lambda pv: pv.bool_array_value,
    7: lambda pv: pv.integer_array_value,
    8: lambda pv: pv.double_array_value,
    9: lambda pv: pv.string_array_value,
}
_ARRAY_CONVERTERS = {
    5: int,
    6: bool,
    7: int,
    8: float,
    9: lambda v: v,
}

# rcl 参数类型码 → 显示类型(懒加载结构树用;与 value_to_json 五类对齐)
_TYPE_CODES = {1: "boolean", 2: "integer", 3: "double", 4: "string",
               5: "array", 6: "array", 7: "array", 8: "array", 9: "array"}


def op_param_structure(req):
    """op=param_structure(node)→ [{name,type}](重设计阶段 3b:懒加载的"结构"半边,
    只报名册不取值;值由 param_values 按需取,事件保鲜)"""
    target = req.get("node", "")
    names = ros_call(target, ListParameters, "/list_parameters", ListParameters.Request()).result.names
    types = ros_call(target, GetParameterTypes, "/get_parameter_types",
                     GetParameterTypes.Request(names=names)).types
    out = [{"name": name, "type": _TYPE_CODES.get(code, "string")}
           for name, code in zip(names, types)]
    disk_log(f"param_structure {target} → {len(out)} 项")
    return out


def op_get_param_values(req, conn):
    """op=get_param_values(node,names[]):点名参数计入该连接订阅账本+回底账。
    回应=账本回显:本节点=具体值形态(对象),他节点=名册形态(数组)——
    返回了具体值的节点必然在轮询,两形态等价。截断规则照旧(标记见 value_to_json)。"""
    target = _canon_node(req.get("node", ""))
    names = [str(n) for n in (req.get("names") or [])]
    server.ledger_subscribe(conn, target, names)
    values = {}
    if names:
        resp_values = ros_call(target, GetParameters, "/get_parameters",
                               GetParameters.Request(names=names)).values
        values = {name: value_to_json(pv) for name, pv in zip(names, resp_values)}
    disk_log(f"get_param_values {target} → {len(names)} 项(订阅+底账)")
    return server.ledger_snapshot(conn, values_node=target, values_map=values)


def op_unget_param_values(req, conn):
    """op=unget_param_values(node,names[]):点名参数移出订阅账本,停推变化。
    回应=移出后的账本回显(全名册形态——这次没问值)。"""
    target = _canon_node(req.get("node", ""))
    names = [str(n) for n in (req.get("names") or [])]
    server.ledger_unsubscribe(conn, target, names)
    disk_log(f"unget_param_values {target} → {len(names)} 项(退订)")
    return server.ledger_snapshot(conn)


def op_save_param_values(req, conn):
    """op=save_param_values(node,names[]):截断上限的解法——按参数名批量取**完整值**
    (不截断);回应={节点: {参数名: 全值}}。落盘写文件归客户端(裁定 2026-10-06,
    旧服务端落盘/内容寻址/同值零写盘随之清场),单帧上限是唯一护栏。"""
    target = _canon_node(req.get("node", ""))
    names = [str(n) for n in (req.get("names") or [])]
    if not names:
        return {target: {}}
    resp_values = ros_call(target, GetParameters, "/get_parameters",
                           GetParameters.Request(names=names)).values
    out = {name: value_to_json(pv, untruncated=True) for name, pv in zip(names, resp_values)}
    disk_log(f"save_param_values {target} → {len(out)} 项全值")
    return {target: out}


def value_to_json(pv, untruncated=False):
    t = pv.type
    if t == 1:
        return bool(pv.bool_value)
    if t == 2:
        return int(pv.integer_value)
    if t == 3:
        return float(pv.double_value)
    if t == 4:
        return pv.string_value
    src_fn = _ARRAY_SOURCES.get(t)
    if src_fn is None:
        return None
    src = src_fn(pv)
    convert = _ARRAY_CONVERTERS[t]
    # 先判长再转换:截断场景只转换前 TRUNCATE_LIMIT 项(原实现全量转换后再切片,大数组白做)
    if not untruncated and len(src) > TRUNCATE_LIMIT:
        return {"__rde_truncated": True, "total": len(src),
                "items": [convert(v) for v in src[:TRUNCATE_LIMIT]]}
    return [convert(v) for v in src]
