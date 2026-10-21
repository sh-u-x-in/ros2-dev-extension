/**
 * ROS 2 接口名(.msg/.srv/.action 文件基名)合规判定——rosidl 语义镜像
 *
 * 事实源:ros2/rosidl rosidl_adapter/parser.py(rolling eb927ae,humble 同逻辑):
 *  - VALID_MESSAGE_NAME_PATTERN = ^[A-Z][A-Za-z0-9]*$:大写字母开头,仅 ASCII 字母数字,
 *    下划线/连字符/点/非 ASCII 一律不合法
 *  - is_valid_message_name 校验前先剥 'Sample_' 前缀一次(单次,不循环),再按
 *    [_Request, _Response, _Goal, _Result, _Feedback] 顺序逐个判断——命中即剥且**不 break**,
 *    多段后缀会连环剥除(Foo_Goal_Request → Foo_Goal → Foo → 合法);'_Event' 不参与剥离
 *  - srv/action 并不直接校验基名:parse_service_string / parse_action_string 用
 *    基名+_Request/_Response、基名+_Goal/_Result/_Feedback 构造消息名后走同一判定,
 *    因此这里的判定按接口种类感知,与构建期行为逐位对齐(如 Foo_Request.srv 实际编译失败)
 */

import * as path from "path";

/** rosidl 官方消息名模式原文(诊断提示文案复用) */
export const ROSIDL_MESSAGE_NAME_PATTERN = "^[A-Z][A-Za-z0-9]*$";

/** 接口文件种类(.msg→msg / .srv→srv / .action→action;其它 → undefined) */
export function interfaceKindOf(fileName: string): "msg" | "srv" | "action" | undefined {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === ".msg") { return "msg"; }
    if (ext === ".srv") { return "srv"; }
    if (ext === ".action") { return "action"; }
    return undefined;
}

const MESSAGE_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const SAMPLE_PREFIX = "Sample_";
const GENERATION_SUFFIXES = ["_Request", "_Response", "_Goal", "_Result", "_Feedback"] as const;

/** is_valid_message_name 镜像:剥前缀一次 → 按序逐个剥后缀(不 break)→ 全串匹配 */
export function isRosidlValidMessageName(name: string): boolean {
    let stripped = name.startsWith(SAMPLE_PREFIX) ? name.slice(SAMPLE_PREFIX.length) : name;
    for (const suffix of GENERATION_SUFFIXES) {
        if (stripped.endsWith(suffix)) {
            stripped = stripped.slice(0, stripped.length - suffix.length);
        }
    }
    return MESSAGE_NAME_PATTERN.test(stripped);
}

/** 按接口种类判定文件基名是否合规(与 rosidl 构建期同判:srv/action 校验构造后的消息名) */
export function isRosidlCompliantInterfaceName(
    kind: "msg" | "srv" | "action",
    basename: string
): boolean {
    if (kind === "srv") {
        return isRosidlValidMessageName(basename + "_Request")
            && isRosidlValidMessageName(basename + "_Response");
    }
    if (kind === "action") {
        return isRosidlValidMessageName(basename + "_Goal")
            && isRosidlValidMessageName(basename + "_Result")
            && isRosidlValidMessageName(basename + "_Feedback");
    }
    return isRosidlValidMessageName(basename);
}
