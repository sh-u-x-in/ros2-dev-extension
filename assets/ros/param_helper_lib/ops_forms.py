# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""常驻助手表单内省域(彻底推倒重来 2026-10-06):get_form(types[]) 按**类型串**查询——
srv 类型回 Request 字段树,action 类型回 Goal 字段树(类型串含 /action/ 判定);
名字→类型的翻译在客户端(图里就有类型串,动作类型由客户端聚合),服务端不做图查询。
rosidl SLOT_TYPES walker 内核沿袭。"""

import array

import rosidl_parser.definition as _rpdef

_FORM_MAX_DEPTH = 8


def _json_value(value):
    """rosidl 实例值 → JSON 原生(消息实例→字典、字节序列/array/numpy→列表、标量直传)"""
    if isinstance(value, (bytes, bytearray, array.array)):
        return list(value)
    if type(value).__module__ == "numpy":
        return value.tolist() if hasattr(value, "tolist") else value.item()
    if isinstance(value, (list, tuple)):
        return [_json_value(v) for v in value]
    if getattr(value, "__slots__", None) is not None and hasattr(value, "SLOT_TYPES"):
        try:
            return {slot[1:]: _json_value(getattr(value, slot))
                    for slot in value.__slots__}
        except Exception:  # noqa: BLE001 — 非常规消息实例,退回字符串
            pass
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    return str(value)


def _message_fields(msg_cls, depth):
    """消息类 → 字段树(每项 {kind,name,type,...,default};实例提供默认值)"""
    inst = msg_cls()
    out = []
    for slot, slot_type in zip(msg_cls.__slots__, msg_cls.SLOT_TYPES):
        out.append(_field_entry(slot[1:], slot_type, getattr(inst, slot), depth))
    return out


def _field_entry(name, slot_type, default, depth):
    is_array = isinstance(slot_type, (_rpdef.Array, _rpdef.BoundedSequence, _rpdef.UnboundedSequence))
    value_type = slot_type.value_type if is_array else slot_type
    fixed = slot_type.size if is_array and isinstance(slot_type, _rpdef.Array) else None
    maximum = slot_type.maximum_size if is_array and isinstance(slot_type, _rpdef.BoundedSequence) else None

    if isinstance(value_type, _rpdef.BasicType):
        entry = {"kind": "array" if is_array else "primitive", "name": name,
                 "type": value_type.typename, "fixed": fixed, "max": maximum,
                 "default": _json_value(default)}
        return entry
    if isinstance(value_type, _rpdef.AbstractWString):
        return _string_entry(name, "wstring", value_type, is_array, fixed, maximum, default)
    if isinstance(value_type, _rpdef.AbstractString):
        return _string_entry(name, "string", value_type, is_array, fixed, maximum, default)

    # 嵌套消息:NamespacedType(pkg/msg/Name)按名解析;NamedType(同包引用)按 rosidl 语义
    # 解析到 本包/msg/名字(L 批,2026-10-07 用户裁定:必须解析,不再一律标 unresolved——
    # 生成层原生支持同包引用,产物与普通消息无异,此前标 unresolved 是标签构造偷懒)
    if isinstance(value_type, _rpdef.NamespacedType):
        full = "/".join(value_type.namespaced_name())
    else:
        full = f"{pkg}/msg/{str(getattr(value_type, 'name', 'unknown'))}"
    kind = "message_array" if is_array else "message"
    entry = {"kind": kind, "name": name, "type": full, "fixed": fixed, "max": maximum,
             "default": _json_value(default)}
    if depth >= _FORM_MAX_DEPTH:
        entry["error"] = "嵌套过深,停止展开"
        return entry
    try:
        from rosidl_runtime_py.utilities import get_message
        children = _message_fields(get_message(full), depth + 1)
        if is_array:
            entry["template"] = children
        else:
            entry["children"] = children
    except Exception as e:  # noqa: BLE001 — 单字段解析失败不拖垮整棵树(python 绑定缺失等)
        entry["kind"] = kind + "_unresolved"
        entry["error"] = str(e)
    return entry


def _string_entry(name, label, value_type, is_array, fixed, maximum, default):
    bound = getattr(value_type, "maximum_size", None)
    entry = {"kind": "array" if is_array else "primitive", "name": name, "type": label,
             "fixed": fixed, "max": maximum, "default": _json_value(default)}
    if not is_array and bound is not None:
        entry["bound"] = bound
    return entry


def op_get_form(req, conn):
    """op=get_form(types[]):按类型串批量内省,回应={类型串: 字段树}。
    action 判据=类型串含 /action/(rosidl codegen 保证动作类型都在 <pkg>/action/ 下)。"""
    out = {}
    for type_str in (req.get("types") or []):
        type_str = str(type_str)
        if "/action/" in type_str:
            from rosidl_runtime_py.utilities import get_action
            act = get_action(type_str)
            out[type_str] = _message_fields(act.Goal, 0)
        else:
            from rosidl_runtime_py.utilities import get_service
            srv = get_service(type_str)
            out[type_str] = _message_fields(srv.Request, 0)
    return out
