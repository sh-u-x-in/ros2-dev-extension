// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file param-helper-protocol.ts
 * 常驻助手协议的数据形状(2026-10-06 彻底推倒重来:信封帧协议,纯类型模块零依赖)。
 * 帧=一行 JSON;上行信封 {client,id,time,request{op,...}},下行信封 {service,time,cl-num}
 * + response|heartbeat|push 三选一。无版本握手(插件从未发布,无历史),无事件帧
 * (图全量推/参数订阅推/生命周期权威推);time=各自进程启动时刻(防 pid 复用杀错人)。
 * 协议事实源:assets/ros/彻底推倒重来.MD;服务端形状:param_helper_lib/server.py。
 */

/** 助手服务端 socket 固定路径(共享服务端,多窗口同连一条) */
export const HELPER_SOCKET_PATH = "/tmp/rde_param_helper.sock";

/** 助手锁文件(pid/启动epoch/启动ticks;杀服务端前核对 ticks 防 pid 复用) */
export const HELPER_LOCK_PATH = "/tmp/rde_param_helper.lock";

/** 上行信封(客户端 → 服务端) */
export interface HelperRequestFrame {
    /** 客户端标签(扩展宿主 pid;服务端日志归因用) */
    client: string;
    /** 请求序号(响应按 id 匹配) */
    id: number;
    /** 客户端进程启动时刻(恒定;服务端原样回带) */
    time: number;
    request: {
        op: string;
        node?: string;
        names?: string[];
        types?: string[];
    };
}

/** 下行信封公共部分 */
export interface HelperEnvelope {
    /** 服务端 pid(看门狗 SIGKILL 用) */
    service: number;
    /** 服务端进程启动时刻(识别重启/防 pid 复用) */
    time: number;
    /** 当前连接数 */
    "cl-num": number;
}

/** response 帧(只回发起连接):time 原样带回上行帧的 time */
export interface HelperResponseFrame extends HelperEnvelope {
    response: {
        client: string;
        id: number;
        time: number;
        success: boolean;
        data?: unknown;
        error?: string;
    };
}

/** 服务端每秒心跳(负荷快照;up 由 time 推导故不带) */
export interface HelperHeartbeatFrame extends HelperEnvelope {
    heartbeat: {
        busy: number;
        q: number[];
        inf: number;
        brk: number;
        eq: number;
        rss: number;
    };
}

/** 参数名册条目(param_structure push) */
export interface ParamStructureEntry {
    name: string;
    type: string;
}

/** 生命周期权威详情(lifecycle push;边无 id——转换按钮直发 label) */
export interface HelperLifecycleInfo {
    state: string;
    states: string[];
    edges: { label: string; from: string; to: string }[];
    available: string[];
}

/** push 载荷(广播;param 例外=按订阅账本定向) */
export type HelperPushPayload =
    | {
        kind: "graph";
        /** 节点全名一列(_ros2cli 临时节点已滤) */
        nodes: string[];
        topics: Record<string, string>;
        services: Record<string, string>;
        lifecycle: string[];
    }
    | {
        kind: "param";
        values: Record<string, Record<string, unknown>>;
        deleted: Record<string, string[]>;
    }
    | {
        kind: "param_structure";
        node: string;
        params: ParamStructureEntry[];
    }
    | ({
        kind: "lifecycle";
        node: string;
    } & HelperLifecycleInfo);

/** 下行帧(三选一,靠键分流) */
export type HelperInboundFrame =
    HelperResponseFrame | HelperHeartbeatFrame | { push: HelperPushPayload };

/** 图全量快照(resync 回应 data / graph push) */
export interface HelperGraphSnapshot {
    nodes: string[];
    topics: Record<string, string>;
    services: Record<string, string>;
    lifecycle: string[];
}

/** 账本回显(get/unget_param_values 回应 data):对象=具体值形态,数组=仅名册形态 */
export interface HelperLedgerEcho {
    node: Record<string, Record<string, unknown> | string[]>;
}

/**
 * 表单字段树节点(rosidl SLOT_TYPES walker 产出,形状沿袭):
 *  - primitive:标量(type=boolean/int64/string/…;bound=有界字符串上限)
 *  - array:原语/字符串序列(fixed=固定长度;max=有界序列上限)
 *  - message / message_array:嵌套消息(children=子树 / template=元素模板子树)
 *  - *_unresolved:嵌套类型解析失败(python 绑定缺失等,error 给原因)
 */
export interface HelperFormField {
    kind: "primitive" | "array" | "message" | "message_array"
    | "message_unresolved" | "message_array_unresolved";
    name: string;
    type: string;
    bound?: number | null;
    fixed?: number | null;
    max?: number | null;
    default?: unknown;
    children?: HelperFormField[];
    template?: HelperFormField[];
    error?: string;
}

/** get_form 回应 data:{类型串: 字段树}(srv→Request 树,action→Goal 树) */
export type HelperFormMap = Record<string, HelperFormField[]>;
