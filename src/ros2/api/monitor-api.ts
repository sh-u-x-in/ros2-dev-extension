/**
 * @file api/monitor-api.ts
 * MonitorApi 接口 + 类型定义(consumers/monitor 消费者对象契约)。
 * 2026-08-26 收进 api/(接口集中原则):原定义在实现文件 consumers/monitor/monitor-api.ts,
 * 现实现只保留对象与内部逻辑,接口/类型统一从 api/ 取。
 *
 * 12 成员分组(2026-09-26:数据来源单一化 = 常驻助手 DDS 直连;daemon XML-RPC/CLI 链路退役):
 *   A 列表查询(7): nodes / topics / services / actions / lifecycle_nodes / param_list / param_values
 *   B 单点查询(4): param_get / lifecycle_get / lifecycle_node_info / lifecycle_available_states
 *   C 操作(2):    helper_running / lifecycle_transition
 * (2026-09-26 批次2:+A7 actions——Action 在图上表现为 3 个 _action/* 服务,助手侧剥离后独立供数)
 *
 * 设计依据:设计/重构/monitor消费者接口-2026-08-26/DESIGN.md
 */

/* ================================================================== */
/* 类型定义(§6)                                                        */
/* ================================================================== */

export interface NodeInfo {
    name: string;
    namespace: string;
}
export interface TopicInfo {
    name: string;
    type: string;
}
export interface ServiceInfo {
    name: string;
    type: string;
}

/** 动作(op_graph 从服务列表剥离的 Action;<动作>/_action/* 三服务聚合) */
export interface ActionInfo {
    name: string;
    type: string;
    /** 已发现的动作动词(send_goal/cancel_goal/get_result 子集) */
    verbs: string[];
}
export interface ParamValue {
    name: string;
    value: string;
}

/** 参数值视觉类型(五类;2026-09-26 引入,前端按类着色替代 "Integer value is:" 式类型前缀) */
export type ParamValueKind = "integer" | "double" | "boolean" | "string" | "array";

/** 类型化参数值(array 的 value 递归为 ParamTypedValue[],子元素自带类型) */
export interface ParamTypedValue {
    kind: ParamValueKind;
    /** integer/double → number;boolean → boolean;string → string;array → ParamTypedValue[];
     *  **懒叶(重设计阶段 3b)**:值未取 → null(前端渲染"—"),此时 lazy=true */
    value: number | boolean | string | ParamTypedValue[] | null;
    /** 仅懒叶(结构树):值未取,展开节点时经 param_values 取回后替换 */
    lazy?: boolean;
    /** 仅截断数组:助手端 >1000 元素截断时的真实总长(前端追加"…共 N 项") */
    total?: number;
}

/**
 * 参数树(2026-09-26,实测/源码双验证定形):ros2 param dump 把点分参数名按 "." 展开成嵌套
 * YAML 层级(如 qos_overrides./parameter_events.publisher.depth → 四层嵌套),此处原样保真——
 * 分支 = 子映射,叶子 = 类型化值(判别:属性 "kind" 为 string;参数名恰叫 "kind" 时其值为
 * ParamTypedValue 对象,不会被误判)。路径 join(".") 即扁平参数名(拆键的严格逆操作,无损)。
 */
export type ParamTree = { [key: string]: ParamTypedValue | ParamTree };

/**
 * 列表查询结果(2026-08-26 C4 错误策略细化):
 * 区分三种情况——success=true 且 data 空 = 真无数据;success=false = 查询失败(daemon 未跑/命令出错)。
 * 仅 A 组列表查询使用;B/C 组保留原有 null/false/上抛 语义(param_get 失败 → null,不再用空串)。
 */
export interface QueryResult<T> {
    /** true=查询成功(可能空数据);false=查询失败(daemon 未跑/命令出错) */
    success: boolean;
    /** 成功时的真实数据;失败时为空值 */
    data: T;
}

/** 标准 4 态 + 动态状态(节点自定义,get_available_states 报告) */
export type LifecycleStateLabel =
    | "unconfigured" | "inactive" | "active" | "finalized"
    | (string & {});

/** 标准 7 转换 + 动态转换(节点自定义) */
export type LifecycleTransitionLabel =
    | "configure" | "cleanup" | "activate" | "deactivate"
    | "unconfigured_shutdown" | "inactive_shutdown" | "active_shutdown"
    | (string & {});

/** 状态图状态(来自节点 get_transition_graph 边端点;CLI 不暴露状态 id,故以 label 为键) */
export interface LifecycleGraphState {
    label: LifecycleStateLabel;
}

/** 状态图边(转换):label 为键(2026-10-06 协议边无 id,转换按钮直发 label) */
export interface LifecycleGraphEdge {
    label: LifecycleTransitionLabel;
    /** 起点状态 label */
    fromLabel: LifecycleStateLabel;
    /** 终点状态 label */
    toLabel: LifecycleStateLabel;
}

/**
 * 节点完整转换图(2026-08-26 引入;来源:ros2 lifecycle list <node> -a
 * = 节点 get_transition_graph 服务 = transition_map 全量,不随当前状态变)。
 * 结构在节点生命周期内不可变 → 后端按节点缓存(TTL),轮询只刷当前状态。
 */
export interface LifecycleGraph {
    states: LifecycleGraphState[];
    edges: LifecycleGraphEdge[];
}

export interface LifecycleNode {
    name: string;
    namespace: string;
    currentState: LifecycleStateLabel | null;
    /** 当前状态可触发的转换 label(图边 from==当前状态 推导;用于命令面板等 label 消费方) */
    availableTransitions: LifecycleTransitionLabel[];
    /** 节点能力上支持的全部状态(图端点 ∪ 标准 4 态;状态图"方形"节点来源) */
    availableStates: LifecycleStateLabel[];
    /** 完整转换图(主数据源,前端状态图渲染;查询失败 → undefined,前端静态表兜底) */
    graph?: LifecycleGraph;
}

/* ================================================================== */
/* MonitorApi 接口(显式契约,2026-08-26)                                */
/* ================================================================== */

/**
 * 独立 monitor 对象接口(consumers/ 层专用)。
 * 状态页全部查询/操作能力;轮询/渲染留在消费者(monitor)。
 * 2026-09-26:数据来源单一化 = 常驻助手(DDS 服务直连);daemon XML-RPC/CLI 子进程链路退役。
 */
export interface MonitorApi {
    // ── A 列表查询(7;C4 起返回 QueryResult 区分失败)──
    /** A1 运行节点列表(助手 graph;失败 success=false,data=[]) */
    nodes(): Promise<QueryResult<NodeInfo[]>>;
    /** A2 话题列表(助手 graph;失败 success=false,data=[]) */
    topics(): Promise<QueryResult<TopicInfo[]>>;
    /** A3 服务列表(助手 graph;失败 success=false,data=[]) */
    services(): Promise<QueryResult<ServiceInfo[]>>;
    /** A7 动作列表(助手 graph 动作分离;失败 success=false,data=[]) */
    actions(): Promise<QueryResult<ActionInfo[]>>;
    /** A4 生命周期节点名(助手:图服务过滤 get_state;失败 success=false,data=[]) */
    lifecycle_nodes(): Promise<QueryResult<string[]>>;
    /** A5 节点参数名(CLI;失败 success=false,data=[]。2026-09-26 起状态页改用 A6,保留为公共 API 面) */
    param_list(opts: { node: string }): Promise<QueryResult<string[]>>;
    /** A6a 参数结构懒树(重设计阶段 3b:list+类型,叶子 lazy=true 值=null;带缓存,失败 success=false,data={}) */
    param_structure(opts: { node: string }): Promise<QueryResult<ParamTree>>;
    /** A6c 参数视图(结构+已缓存值合并;刷新取数口,**不主动取值**——值只走展开链路+事件保鲜) */
    param_view(opts: { node: string }): Promise<QueryResult<ParamTree>>;
    /** A6b 节点参数树带值(重设计阶段 3b:展开节点时取全部值并入懒树,事件保鲜;失败 success=false,data={}) */
    param_values(opts: { node: string }): Promise<QueryResult<ParamTree>>;

    // ── B 单点查询(4)──
    /** B1 参数值(CLI;失败 → null。页面已不使用,公共 API 面保留) */
    param_get(opts: { node: string; param: string }): Promise<string | null>;
    /** B2 当前状态(助手直连 get_state;失败 → null) */
    lifecycle_get(opts: { node: string }): Promise<LifecycleStateLabel | null>;
    /** B3 节点详情(助手 lifecycle_info 一次打包;可用转换由"图边 from==当前状态"推导;失败 → null) */
    lifecycle_node_info(opts: { node: string }): Promise<LifecycleNode | null>;
    /** B4 节点能力上支持的全部状态(图端点 ∪ 标准 4 态;失败 → 标准 4 态兜底) */
    lifecycle_available_states(opts: { node: string }): Promise<LifecycleStateLabel[]>;

    // ── C 操作(2)──
    /** C2 助手在线判定(ping 常驻助手;失败 → false。2026-09-26 替代原 daemon XML-RPC 探测) */
    helper_running(): Promise<boolean>;
    /**
     * C3 单步转换(CLI 通道 `ros2 lifecycle set`;失败 → false,不抛)。
     * 2026-10-06 起转换直发 label(协议边无 id,transitionId 全链退役)。
     */
    lifecycle_transition(opts: { node: string; transition: LifecycleTransitionLabel }): Promise<boolean>;
    /** 纯推送架构(2026-10-06):仓库状态 → webview ready 帧(同步纯读零 IO;投影器每帧调用) */
    projectFrame(): Record<string, unknown>;
}
