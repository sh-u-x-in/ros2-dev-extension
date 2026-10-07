/**
 * launch 补全核心(纯 TS,零 vscode 依赖,可无头单测)
 *
 * 为三种 launch 格式(.launch.py / .launch / .launch.yaml)提供:
 *  - 结构目录(常用函数/标签/动作/属性/键)
 *  - 光标上下文判定(py 调用内 kwarg / XML 标签·属性 / YAML 列表项·键·值)
 *  - 候选生成(结构 snippet / 包名值 / 枚举值),统一为 Candidate(与 vscode 解耦)
 *
 * 数据基准:官方 ROS 2 launch 格式(docs.ros.org Humble),2026-09-05 建;
 * 值补全:包名(PackageMap 名单)+ 可执行名(2026-09-25 LA-2 接线,名单经 install-truth
 * ExecutableResolver,见 launch-completion.ts;pkg 上下文 = 同调用/标签/动作块内字面量)。
 */

// LF-2:py 值提取经 parse 层字符串扫描器(转义感知);core→parse 单向依赖(与 launch-args 同规)
// LJ-4:parsePyStringOpen = 未闭合容错版(join 末段当前词)
import { l10n } from "vscode";

import { parsePyStringConcatenation, parsePyStringOpen } from "../parse/launch-py-parser";

// ---------- 候选统一形态 ----------

export type CandidateKind = "snippet" | "value" | "property" | "enum";

export interface Candidate {
    /** 显示标签(亦是默认 filterText) */
    label: string;
    /** 插入文本(SnippetString 友好:可含 ${1:…} 占位) */
    insert: string;
    detail?: string;
    doc?: string;
    /** 参与匹配的附加词(原 snippet prefix 记忆词等) */
    filter?: string;
    kind: CandidateKind;
    /** 排序前缀(数字越大越靠前;vscode sortText 字典序,用反序编码) */
    sort: string;
}

function snippet(label: string, insert: string, detail: string, doc?: string): Candidate {
    return { label, insert, detail, doc, kind: "snippet", sort: "1" };
}
function value(label: string): Candidate {
    return { label, insert: label, kind: "value", sort: "2" };
}
function property(label: string, detail: string): Candidate {
    return { label, insert: label, kind: "property", sort: "3", detail };
}
function enumItem(label: string, detail: string): Candidate {
    return { label, insert: label, kind: "enum", sort: "2", detail };
}

/**
 * 结构头部 tokens(2026-09-08):取 insert 开头(去 import/from 头、${…} 占位、引号值、标点)的
 * 前几个标识符——filterText 应以"插入结构的前半段主词"为主(如 `<env name="…" …/>` → env name)。
 */
function headTokens(insert: string, max = 3): string[] {
    const lines = insert.split("\n").filter(l => l.trim().length > 0);
    let start = 0;
    while (start < lines.length && /^\s*(?:from|import)\b/.test(lines[start])) {
        start++;
    }
    const head = lines.slice(start).join("\n").slice(0, 100);
    const cleaned = head
        .replace(/\$\{[^}]*\}/g, " ")
        .replace(/"[^"]*"/g, " ")
        .replace(/'[^']*'/g, " ")
        .replace(/[{}()[\]=\-]/g, " ");
    const words = cleaned.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g) ?? [];
    const out: string[] = [];
    for (const w of words) {
        if (!out.includes(w)) {
            out.push(w);
        }
        if (out.length >= max) {
            break;
        }
    }
    return out;
}

/**
 * 纯 ASCII 过滤词(2026-09-08 演进):结构头部主词 + keywords + label 英文词;剔除中文——
 * 中文只留在显示 label,不进 filterText;filter 以插入结构前半段为主、关键词兜底。
 */
function latinFilter(insert: string, label: string, keywords: string[]): string {
    const fromLabel = label.match(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g) ?? [];
    return Array.from(new Set([...headTokens(insert), ...keywords, ...fromLabel])).join(" ");
}

// ---------- LC-8 filterText 超集(2026-09-27,移植 xacro snippetHeadLiteral/snippetWordTokens) ----------

/** 符号头字面量(≤48 字符):首非空行去 ${…}/$n 占位与引号值后**保留符号**的 ASCII 片段(如 `<node pkg=`) */
function snippetHeadLiteral(insert: string, maxChars = 48): string {
    for (const raw of insert.split("\n")) {
        const line = raw.trim();
        if (!line) { continue; }
        const cleaned = line
            .replace(/\$\{[^}]*\}/g, " ")
            .replace(/\$\d+/g, " ")
            .replace(/"[^"]*"/g, "")
            .replace(/'[^']*'/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/[^ -~]/g, "")
            .trim();
        if (!/[A-Za-z]/.test(cleaned)) { continue; }
        return cleaned.slice(0, maxChars).replace(/[\s/>]+$/g, "");
    }
    return "";
}

/** 词流(≤8 词):去 ${…}/引号值后的标识符流(纯数字跳过) */
function snippetWordTokens(insert: string, max = 8): string[] {
    const out: string[] = [];
    for (const raw of insert.split("\n")) {
        if (out.length >= max) { break; }
        const cleaned = raw.replace(/\$\{[^}]*\}/g, " ").replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
        for (const w of cleaned.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
            if (/^\d+$/.test(w)) { continue; }
            if (!out.includes(w)) { out.push(w); }
            if (out.length >= max) { break; }
        }
    }
    return out;
}

/** 片段 filterText 超集:符号头字面量 + 词流 + keywords(纯 ASCII;原词与带符号输入都可子序列命中) */
export function snippetFilterText(insert: string, label: string, keywords: string[]): string {
    const fromLabel = label.match(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g) ?? [];
    const head = snippetHeadLiteral(insert);
    const words = snippetWordTokens(insert);
    return Array.from(new Set([...(head ? [head] : []), ...words, ...keywords, ...fromLabel])).join(" ");
}

// ---------- Python(.launch.py) ----------

/** 领域调用名(结构补全 + kwarg 值补全共用;LJ-6 残差 + LJ-10b 事件/生命周期/配置栈全集,
 *  对齐 Humble launch.actions + event_handlers + launch_ros.actions 官方 __init__) */
const PY_ACTION_CALLS = [
    "Node", "LifecycleNode", "ComposableNodeContainer", "ComposableNode",
    "IncludeLaunchDescription", "DeclareLaunchArgument", "GroupAction",
    "ExecuteProcess", "PushRosNamespace", "SetParameter", "LaunchDescription",
    "LaunchConfiguration", "OpaqueFunction",
    // LJ-6:官方注册表残差(launch.actions + launch_ros.actions)
    "LogInfo", "Shutdown", "TimerAction", "RosTimer",
    "SetEnvironmentVariable", "AppendEnvironmentVariable", "UnsetEnvironmentVariable",
    "ResetEnvironmentVariable", "SetLaunchConfiguration", "ResetLaunchConfigurations",
    "SetParametersFromFile", "LoadComposableNodes",
    // LJ-10b:事件驱动 / 协程 / 配置栈(官方 __init__ 终审)
    "RegisterEventHandler", "UnregisterEventHandler",
    "OnProcessStart", "OnProcessExit", "OnProcessIO", "OnShutdown", "OnExecutionComplete",
    "OnIncludeLaunchDescription",
    "EmitEvent", "OpaqueCoroutine", "ExecuteLocal",
    "PushEnvironment", "PopEnvironment",
    "PushLaunchConfigurations", "PopLaunchConfigurations", "UnsetLaunchConfiguration"
];

/** Python 结构片段定义(原 prefix 并入 keywords,保留肌肉记忆;label 中文/标识符混排但 detail 全中文) */
export interface PySnippetDef {
    label: string;
    /** 触发记忆词(原 snippet prefix 等;参与 filterText) */
    keywords?: string[];
    /** 保真多行 body(原 snippets/launch-py.json 转制,含 ${…} tabstop/选项) */
    body: string[];
    detail: string;
}

/** Python 结构片段目录(2026-09-07 由原 snippets/launch-py.json 全量转制,12 条保真) */
const PY_SNIPPETS: ReadonlyArray<PySnippetDef> = [
    {
        label: l10n.t("launch.py file template"), keywords: ["ros2launch", "template"],
        body: [
            "from launch import LaunchDescription",
            "from launch_ros.actions import Node",
            "",
            "",
            "def generate_launch_description():",
            "\treturn LaunchDescription([",
            "\t\t${0}",
            "\t])"
        ],
        detail: l10n.t("ROS 2 Python launch file skeleton (with generate_launch_description entry)")
    },
    {
        label: "Node", keywords: ["ros2launchnode", "node"],
        body: [
            "Node(",
            "\tpackage='${1:package_name}',",
            "\texecutable='${2:executable_name}',",
            "\tname='${3:node_name}',",
            "\tnamespace='${4}',",
            "\tparameters=[${5}],",
            "\toutput='${6|screen,log|}',",
            "),",
            "\${0}"
        ],
        detail: l10n.t("launch Node (full arguments)")
    },
    {
        label: l10n.t("Node (simple)"), keywords: ["ros2node", "node"],
        body: [
            "Node(",
            "\tpackage='${1:package_name}',",
            "\texecutable='${2:executable_name}',",
            "\tname='${3:node_name}',",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Simple launch Node (package/executable/name only)")
    },
    {
        label: l10n.t("Node (remapping)"), keywords: ["ros2launchremap", "node", "remap"],
        body: [
            "Node(",
            "\tpackage='${1:package_name}',",
            "\texecutable='${2:executable_name}',",
            "\tname='${3:node_name}',",
            "\tremappings=[",
            "\t\t('${4:from_topic}', '${5:to_topic}'),",
            "\t],",
            "),",
            "\${0}"
        ],
        detail: l10n.t("launch Node with topic remappings")
    },
    {
        label: "IncludeLaunchDescription", keywords: ["ros2launchinclude", "include"],
        body: [
            "from launch.actions import IncludeLaunchDescription",
            "from launch.launch_description_sources import PythonLaunchDescriptionSource",
            "from ament_index_python.packages import get_package_share_directory",
            "import os",
            "",
            "IncludeLaunchDescription(",
            "\tPythonLaunchDescriptionSource(",
            "\t\tos.path.join(",
            "\t\t\tget_package_share_directory('${1:package_name}'),",
            "\t\t\t'launch',",
            "\t\t\t'${2:launch_file.launch.py}'",
            "\t\t)",
            "\t),",
            "\tlaunch_arguments={",
            "\t\t'${3:arg_name}': '${4:arg_value}'",
            "\t}.items(),",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Include another launch file (with import and launch_arguments)")
    },
    {
        label: "DeclareLaunchArgument", keywords: ["ros2launcharg", "arg"],
        body: [
            "from launch.actions import DeclareLaunchArgument",
            "",
            "DeclareLaunchArgument(",
            "\t'${1:arg_name}',",
            "\tdefault_value='${2:default_value}',",
            "\tdescription='${3:Description of the argument}'",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Declare launch argument")
    },
    {
        label: "LaunchConfiguration", keywords: ["ros2launchgetarg", "var", "arg"],
        body: [
            "from launch.substitutions import LaunchConfiguration",
            "",
            "LaunchConfiguration('${1:arg_name}'),",
            "\${0}"
        ],
        detail: l10n.t("Get launch argument value (substitution)")
    },
    {
        label: "ExecuteProcess", keywords: ["ros2launchexec", "exec"],
        body: [
            "from launch.actions import ExecuteProcess",
            "",
            "ExecuteProcess(",
            "\tcmd=['${1:command}', '${2:arg1}', '${3:arg2}'],",
            "\toutput='${4|screen,log|}',",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Execute an arbitrary process")
    },
    {
        label: "ComposableNodeContainer", keywords: ["ros2composable", "composition"],
        body: [
            "from launch_ros.actions import ComposableNodeContainer",
            "from launch_ros.descriptions import ComposableNode",
            "",
            "ComposableNodeContainer(",
            "\tname='${1:container_name}',",
            "\tnamespace='',",
            "\tpackage='rclcpp_components',",
            "\texecutable='component_container',",
            "\tcomposable_node_descriptions=[",
            "\t\tComposableNode(",
            "\t\t\tpackage='${2:package_name}',",
            "\t\t\tplugin='${3:namespace::ClassName}',",
            "\t\t\tname='${4:node_name}',",
            "\t\t),",
            "\t],",
            "\toutput='screen',",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Composable node container")
    },
    {
        label: "GroupAction", keywords: ["ros2launchgroup", "group"],
        body: [
            "from launch.actions import GroupAction",
            "from launch_ros.actions import PushRosNamespace",
            "",
            "GroupAction(",
            "\tactions=[",
            "\t\tPushRosNamespace('${1:namespace}'),",
            "\t\t${0}",
            "\t]",
            "),"
        ],
        detail: l10n.t("launch GroupAction")
    },
    {
        label: "SetParameter", keywords: ["ros2launchparam", "param"],
        body: [
            "from launch.actions import SetParameter",
            "",
            "SetParameter(name='${1:param_name}', value='${2:param_value}'),",
            "\${0}"
        ],
        detail: l10n.t("Set launch configuration (global)")
    },
    {
        label: "LifecycleNode", keywords: ["ros2lifecycle", "lifecycle"],
        body: [
            "from launch_ros.actions import LifecycleNode",
            "",
            "LifecycleNode(",
            "\tpackage='${1:package_name}',",
            "\texecutable='${2:executable_name}',",
            "\tname='${3:node_name}',",
            "\tnamespace='${4}',",
            "\toutput='screen',",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Lifecycle node")
    },
    {
        label: "LaunchDescription", keywords: ["launch", "ld"],
        body: [
            "LaunchDescription([${1}$0])"
        ],
        detail: l10n.t("LaunchDescription container")
    },
    {
        label: "PushRosNamespace", keywords: ["ros2ns", "namespace"],
        body: [
            "PushRosNamespace('${1:namespace}'),",
            "\${0}"
        ],
        detail: l10n.t("Push ROS namespace (use inside GroupAction)")
    },
    // LJ-6 残差动作片段(官方 expose 注册表补齐)
    {
        label: "LogInfo", keywords: ["ros2log", "log"],
        body: [
            "from launch.actions import LogInfo",
            "",
            "LogInfo(msg='${1:message}'),",
            "\${0}"
        ],
        detail: l10n.t("Emit launch log")
    },
    {
        label: "SetEnvironmentVariable", keywords: ["ros2setenv", "env"],
        body: [
            "from launch.actions import SetEnvironmentVariable",
            "",
            "SetEnvironmentVariable(name='${1:ENV_NAME}', value='${2:value}'),",
            "\${0}"
        ],
        detail: l10n.t("Set environment variable")
    },
    {
        label: "AppendEnvironmentVariable", keywords: ["ros2appendenv", "env"],
        body: [
            "from launch.actions import AppendEnvironmentVariable",
            "",
            "AppendEnvironmentVariable(name='${1:ENV_NAME}', value='${2:value}'),",
            "\${0}"
        ],
        detail: l10n.t("Append environment variable (prepend/separator optional)")
    },
    {
        label: "UnsetEnvironmentVariable", keywords: ["ros2unsetenv", "env"],
        body: [
            "from launch.actions import UnsetEnvironmentVariable",
            "",
            "UnsetEnvironmentVariable(name='${1:ENV_NAME}'),",
            "\${0}"
        ],
        detail: l10n.t("Unset environment variable")
    },
    {
        label: "Shutdown", keywords: ["ros2shutdown"],
        body: [
            "from launch.actions import Shutdown",
            "",
            "Shutdown(reason='${1:reason}'),",
            "\${0}"
        ],
        detail: l10n.t("Shutdown the launch")
    },
    {
        label: "TimerAction", keywords: ["ros2timer", "timer"],
        body: [
            "from launch.actions import TimerAction",
            "",
            "TimerAction(period=${1:5.0}, actions=[",
            "\t${0}",
            "]),"
        ],
        detail: l10n.t("Timer-triggered child actions")
    },
    {
        label: "SetLaunchConfiguration", keywords: ["ros2setconfig", "let"],
        body: [
            "from launch.actions import SetLaunchConfiguration",
            "",
            "SetLaunchConfiguration(name='${1:name}', value='${2:value}'),",
            "\${0}"
        ],
        detail: l10n.t("Set launch config (py-style let)")
    },
    {
        label: "SetParametersFromFile", keywords: ["ros2paramfile", "param"],
        body: [
            "from launch_ros.actions import SetParametersFromFile",
            "",
            "SetParametersFromFile('${1:params.yaml}'),",
            "\${0}"
        ],
        detail: l10n.t("Load global parameters from file")
    },
    {
        label: "LoadComposableNodes", keywords: ["ros2composable", "composition", "load"],
        body: [
            "from launch_ros.actions import LoadComposableNodes",
            "from launch_ros.descriptions import ComposableNode",
            "",
            "LoadComposableNodes(",
            "\ttarget_container_name='${1:container_name}',",
            "\tcomposable_nodes=[",
            "\t\tComposableNode(",
            "\t\t\tpackage='${2:package_name}',",
            "\t\t\tplugin='${3:ns::Class}',",
            "\t\t\tname='${4:node_name}',",
            "\t\t),",
            "\t],",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Load components into a running container")
    },
    // LJ-10b:组合骨架(用户结构树蓝本,官方 Humble API 终审)
    {
        label: l10n.t("Event chain (on process exit)"), keywords: ["ros2event", "event", "handler", "onexit"],
        body: [
            "from launch.actions import RegisterEventHandler",
            "from launch.event_handlers import OnProcessExit",
            "",
            "RegisterEventHandler(",
            "\tOnProcessExit(",
            "\t\ttarget_action=${1:node},",
            "\t\ton_exit=[${2:next_action}],",
            "\t)",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Run follow-up actions when a node exits (event chain)")
    },
    {
        label: l10n.t("Event chain (graceful shutdown)"), keywords: ["ros2event", "event", "shutdown"],
        body: [
            "from launch.actions import RegisterEventHandler",
            "from launch.event_handlers import OnShutdown",
            "",
            "RegisterEventHandler(OnShutdown(on_shutdown=[${1:action}])),",
            "\${0}"
        ],
        detail: l10n.t("Run save-type actions on shutdown event")
    },
    {
        label: l10n.t("Lifecycle transition (activate node)"), keywords: ["ros2lifecycle", "lifecycle", "transition", "emit"],
        body: [
            "from launch.actions import EmitEvent",
            "from launch.events import matches_action",
            "from launch_ros.events.lifecycle import ChangeState",
            "from lifecycle_msgs.msg import Transition",
            "",
            "EmitEvent(ChangeState(",
            "\tlifecycle_node_matcher=matches_action(${1:lifecycle_node}),",
            "\ttransition_id=Transition.TRANSITION_ACTIVATE,",
            "))",
            "\${0}"
        ],
        detail: l10n.t("Emit a lifecycle transition event (e.g. activate)")
    },
    {
        label: l10n.t("OpaqueFunction full skeleton"), keywords: ["ros2opaque", "opaque", "function"],
        body: [
            "from launch.actions import OpaqueFunction",
            "",
            "",
            "def ${1:launch_setup}(context, *args, **kwargs):",
            "\t${2:entities = []}",
            "\treturn entities",
            "",
            "",
            "def generate_launch_description():",
            "\treturn LaunchDescription([",
            "\t\tOpaqueFunction(function=${1:launch_setup}),",
            "\t])"
        ],
        detail: l10n.t("User function generates actions at runtime (OpaqueFunction full skeleton)")
    },
    {
        label: l10n.t("Node (params file composition)"), keywords: ["ros2paramfile", "param", "pathjoinsubstitution", "findpkgshare"],
        body: [
            "from launch_ros.actions import Node",
            "from launch.substitutions import PathJoinSubstitution",
            "from launch_ros.substitutions import FindPackageShare",
            "",
            "Node(",
            "\tpackage='${1:package_name}',",
            "\texecutable='${2:executable_name}',",
            "\tparameters=[",
            "\t\tPathJoinSubstitution([",
            "\t\t\tFindPackageShare('${1:package_name}'), 'config', '${3:params.yaml}',",
            "\t\t]),",
            "\t],",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Load in-package params file (PathJoinSubstitution composition)")
    },
    {
        label: l10n.t("Node (conditional)"), keywords: ["ros2condition", "condition", "if", "ifcondition"],
        body: [
            "from launch.conditions import IfCondition",
            "from launch.substitutions import LaunchConfiguration",
            "",
            "Node(",
            "\tpackage='${1:package_name}',",
            "\texecutable='${2:executable_name}',",
            "\tcondition=IfCondition(LaunchConfiguration('${3:use_sim}')),",
            "),",
            "\${0}"
        ],
        detail: l10n.t("Enable node conditionally on a launch argument (IfCondition)")
    },
];

/** 光标上下文:最近包围 offset 的领域调用(含 get_package_share_directory) */
export interface PyCallContext {
    /** 调用名(不含括号) */
    call: string;
    /** '(' 的 offset */
    open: number;
}

const PY_CALL_RE = new RegExp(
    "\\b(" + PY_ACTION_CALLS.concat(["get_package_share_directory"]).join("|") + ")\\s*\\(",
    "g"
);

/** open 起的括号深度到 offset 前(>0 = 在调用参数区内) */
function parenDepthTo(text: string, open: number, offset: number): number {
    let depth = 0;
    for (let i = open; i < offset; i++) {
        const c = text[i];
        if (c === "(") { depth++; } else if (c === ")") { depth--; }
    }
    return depth;
}

/** 找最近包围 offset 的领域调用(括号配对粗判:open 到 offset 间深度>0 即视为在内) */
export function enclosingPyCall(text: string, offset: number): PyCallContext | undefined {
    PY_CALL_RE.lastIndex = 0;
    let best: PyCallContext | undefined;
    let m: RegExpExecArray | null;
    while ((m = PY_CALL_RE.exec(text)) !== null) {
        if (m.index >= offset) { break; }
        const open = m.index + m[0].length - 1; // '(' 位置
        if (parenDepthTo(text, open, offset) > 0) {
            best = { call: m[1], open };
        }
    }
    return best;
}

/**
 * 正在编辑的属性 kwarg 判定:光标位于某领域调用内、且所在"参数尾段"是
 * `attr = '值前缀` 或 `attr = '` 形态 → 返回属性名与值范围起点。
 * get_package_share_directory('…') 特判为 attr='package'。
 */
export interface PyAttrContext {
    call: string;
    attr: string;
    /** 值内容起点(引号后);替换范围 = [valueStart, offset) */
    valueStart: number;
}

const PY_ATTR_TAIL_RE = /(?:^|[\s,])(package|executable|name|output|respawn|filename)\s*=\s*(['"]?)([^'",\n]*)$/;

export function pyAttrContextAt(text: string, offset: number): PyAttrContext | undefined {
    const ctx = enclosingPyCall(text, offset);
    if (!ctx) {
        return undefined;
    }
    if (ctx.call === "get_package_share_directory") {
        // get_package_share_directory('pkg…' — 首参字符串即包名
        const seg = text.slice(ctx.open + 1, offset);
        const m = seg.match(/^\s*['"]?([^'"]*)$/);
        if (!m) {
            return undefined;
        }
        const leading = seg.slice(0, seg.length - m[1].length);
        if (/^\s*['"]?$/.test(leading)) {
            return { call: ctx.call, attr: "package", valueStart: ctx.open + 1 + leading.length };
        }
        return undefined;
    }
    if (ctx.call === "LaunchConfiguration") {
        // LC-2:LaunchConfiguration('arg…' — 首参字符串即 launch 参数名
        const seg = text.slice(ctx.open + 1, offset);
        const m = seg.match(/^\s*['"]?([^'"]*)$/);
        if (!m) {
            return undefined;
        }
        const leading = seg.slice(0, seg.length - m[1].length);
        if (/^\s*['"]?$/.test(leading)) {
            return { call: ctx.call, attr: "arg-ref", valueStart: ctx.open + 1 + leading.length };
        }
        return undefined;
    }
    // kwarg 值:因 $ 锚定在 offset(=seg 末尾),只有"光标正位于该 kwarg 值内"时整段
    // 才是 纯值形态 才可匹配——已闭合的 kwarg(引号后跟逗号/换行)天然失败 → 不打扰
    const seg = text.slice(ctx.open + 1, offset);
    const m = seg.match(PY_ATTR_TAIL_RE);
    if (!m) {
        return undefined;
    }
    return {
        call: ctx.call,
        attr: m[1],
        valueStart: offset - m[3].length,
    };
}

/** py 结构补全:前缀命中过滤词即提供;filter = 结构头部主词 + keywords + label 英文词(纯 ASCII) */
export function pyStructureCandidates(prefix: string): Candidate[] {
    const p = prefix.toLowerCase();
    const out: Candidate[] = [];
    for (const s of PY_SNIPPETS) {
        const insert = s.body.join("\n");
        const hay = latinFilter(insert, s.label, s.keywords ?? []).toLowerCase();
        if (!hay.includes(p)) {
            continue;
        }
        const c = snippet(s.label, insert, s.detail);
        c.filter = snippetFilterText(insert, s.label, s.keywords ?? []);
        out.push(c);
    }
    return out;
}

/** py kwarg 值补全:package → 包名;executable → 可执行名(LA-2);output/respawn → 枚举(LC-7);
 *  filename → 参数文件路径(LJ-6,set_parameters_from_file) */
export function pyValueSource(attr: string): "pkg" | "exec" | "output" | "bool" | "params-path" | undefined {
    if (attr === "package") { return "pkg"; }
    if (attr === "executable") { return "exec"; }
    if (attr === "output") { return "output"; }
    if (attr === "respawn") { return "bool"; }
    if (attr === "filename") { return "params-path"; }
    return undefined;
}

/**
 * 领域调用内已闭合的字符串 kwarg 值(py 可执行补全的 pkg 上下文):
 * `Node(package='demo_pkg', executable='…')` → cursor 在 executable 值内时取到 'demo_pkg'。
 * 只认字面量(变量/LaunchConfiguration 不解,与 include 静默口径一致)。
 * LF-2:值提取改经 parsePyString(转义感知;取 attr= 的最后一次出现),闭合要求不变(与旧口径一致)。
 * LJ-6 序无关:光标之前未命中时**向后**在整个调用段内找(executable= 写在 package= 之前也能命中;
 * 当前正在编辑的属性其值未闭合,向后/向前提取自然失败,不受影响)。
 */
export function pyStringKwargInCall(text: string, open: number, offset: number, attr: string): string | undefined {
    const seg = text.slice(open + 1, offset);
    const re = new RegExp("\\b" + attr + "\\s*=\\s*", "g");
    let lastStart = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg)) !== null) {
        lastStart = m.index + m[0].length;
        re.lastIndex = m.index + 1;
    }
    if (lastStart >= 0) {
        const ps = parsePyStringConcatenation(seg, lastStart);
        if (ps) {
            return ps.value;
        }
    }
    // LJ-6:向后找(整个调用段 = open 至配对右括号)
    let depth = 1;
    let callEnd = text.length;
    for (let i = open + 1; i < text.length; i++) {
        const c = text[i];
        if (c === "(") { depth++; } else if (c === ")") {
            depth--;
            if (depth === 0) {
                callEnd = i;
                break;
            }
        }
    }
    const seg2 = text.slice(open + 1, callEnd);
    const re2 = new RegExp("\\b" + attr + "\\s*=\\s*", "g");
    while ((m = re2.exec(seg2)) !== null) {
        const valueStart = m.index + m[0].length;
        if (open + 1 + valueStart >= offset) {
            const ps = parsePyStringConcatenation(seg2, valueStart);
            if (ps) {
                return ps.value;
            }
        }
        re2.lastIndex = m.index + 1;
    }
    return undefined;
}

/** 可执行名值候选(名单经 install-truth ExecutableResolver.namesOf/allNames,LA-2) */
export function execValueCandidates(names: readonly string[]): Candidate[] {
    return names.map(value);
}

// ---------- LJ-4 os.path.join 末段路径 / remappings·parameters 列表项(2026-10-01) ----------

/** os.path.join( 的路径补全上下文:首参 = get_package_share_directory('字面量') 已闭合 */
export interface PyJoinPathContext {
    pkg: string;
    /** 已闭合的中间段(字符串字面量值,支持相邻拼接) */
    segments: string[];
    /** 当前段已敲部分(引号未闭合;无引号空态 = "") */
    word: string;
    /** 当前段替换起点(绝对 offset 语义) */
    wordStart: number;
}

const PY_JOIN_RE = /\bos\.path\.join\s*\(/g;

/**
 * os.path.join(get_package_share_directory('pkg'), 'a', 'b␣') 的末段路径语境(LJ-4):
 * 光标须在 join 参数区内;首参必须为已闭合 gpsd('字面量');中间段全为字符串字面量
 * (变量/表达式混入 → undefined,与 include 静默口径一致);当前段未闭合容错(parsePyStringOpen)。
 */
export function pyJoinPathContextAt(text: string, offset: number): PyJoinPathContext | undefined {
    PY_JOIN_RE.lastIndex = 0;
    let best: number | undefined;
    let m: RegExpExecArray | null;
    while ((m = PY_JOIN_RE.exec(text)) !== null) {
        if (m.index >= offset) { break; }
        const open = m.index + m[0].length - 1;
        if (parenDepthTo(text, open, offset) > 0) {
            best = open;
        }
    }
    if (best === undefined) {
        return undefined;
    }
    const seg = text.slice(best + 1, offset);
    const first = seg.match(/^\s*get_package_share_directory\s*\(\s*(['"])([^'"]*)\1\s*\)\s*,?/);
    if (!first) {
        return undefined;
    }
    let i = first[0].length;
    const segments: string[] = [];
    for (;;) {
        while (i < seg.length && (seg[i] === " " || seg[i] === "\t" || seg[i] === "," || seg[i] === "\n" || seg[i] === "\r")) {
            i++;
        }
        if (i >= seg.length) {
            return { pkg: first[2], segments, word: "", wordStart: best + 1 + seg.length };
        }
        const open = parsePyStringOpen(seg, i);
        if (open && open.nodeEnd === seg.length) {
            if (open.contentEnd === open.nodeEnd - 1) {
                // 已闭合且光标紧贴闭引号:并入完成段(可能相邻拼接),继续到空态
                const closed = parsePyStringConcatenation(seg, i);
                if (closed) {
                    segments.push(closed.value);
                    i = closed.nodeEnd;
                    continue;
                }
            }
            // 未闭合 = 当前词
            return { pkg: first[2], segments, word: open.value, wordStart: best + 1 + open.contentStart };
        }
        const closed = parsePyStringConcatenation(seg, i);
        if (!closed) {
            return undefined; // 变量/表达式混入
        }
        segments.push(closed.value);
        i = closed.nodeEnd;
    }
}

/**
 * 领域调用的列表 kwarg 项位(LJ-4):remappings=[ / parameters=[ 内 → 返回列表语义。
 * (括号未闭合即在内;不含 ] 的尾段判定与 PY_ATTR_TAIL_RE 同款"光标在值内"口径。)
 */
export function pyKwargListContextAt(text: string, offset: number): "remappings" | "parameters" | undefined {
    const ctx = enclosingPyCall(text, offset);
    if (!ctx) {
        return undefined;
    }
    const seg = text.slice(ctx.open + 1, offset);
    // [^\]]:JS 里 [^]] 会解析成"任意字符+字面 ]"(Annex B 的 [^] 任意类),必须转义
    if (/remappings\s*=\s*\[[^\]]*$/.test(seg)) {
        return "remappings";
    }
    if (/parameters\s*=\s*\[[^\]]*$/.test(seg)) {
        return "parameters";
    }
    return undefined;
}

/** 列表 kwarg 项片段候选(LJ-4):remappings = 重映射元组;parameters = 参数文件 / 内联字典 */
export function pyListSnippetCandidates(kind: "remappings" | "parameters"): Candidate[] {
    if (kind === "remappings") {
        return [snippet("重映射项", "('${1:from_topic}', '${2:to_topic}'),", "话题重映射对")];
    }
    return [
        snippet("参数文件项", "'${1:params.yaml}',", "参数 YAML 文件路径"),
        snippet("内联参数项", "{'${1:param_name}': '${2:value}'},", "内联参数字典")
    ];
}

// ---------- LC-2 参数引用 / LC-3 $() 命令 / LC-7 枚举(2026-09-27) ----------

/** 参数引用候选(LC-2;decls = launch-args 声明;detail=默认值,doc=声明行) */
export function argRefCandidates(
    decls: ReadonlyArray<{ name: string; default?: string; declLineText?: string }>
): Candidate[] {
    return decls.map((d) => {
        const c = value(d.name);
        c.detail = d.default !== undefined ? `launch 参数(默认 ${d.default})` : "launch 参数(必传)";
        c.sort = "1_arg";
        if (d.declLineText) {
            c.doc = d.declLineText;
        }
        return c;
    });
}

/**
 * $() 替换命令目录(LC-3 建;LJ-10a 全量对齐 Humble frontend 注册表 VM 终审,2026-10-03):
 * launch/substitutions + launch_ros/substitutions 的 @expose_substitution 全集 23 名。
 * 清除 ROS1 残留伪项:optenv(ROS1)/cwd(ROS1)/find(Humble 只有 find-pkg-share/find-pkg-prefix/
 * find-exec/exec-in-pkg);path-join/string-join/string-strip/for-var 为 rolling-only 未收录。
 */
const SUBST_COMMANDS: ReadonlyArray<{ name: string; detail: string }> = [
    { name: "var", detail: l10n.t("Get launch argument ($(var name))") },
    { name: "env", detail: l10n.t("Get environment variable ($(env VAR [default]))") },
    { name: "eval", detail: l10n.t("Python expression evaluation ($(eval expr))") },
    { name: "find-pkg-share", detail: l10n.t("Get package share directory") },
    { name: "find-pkg-prefix", detail: l10n.t("Get package install root") },
    { name: "find-exec", detail: l10n.t("Find executable path by name") },
    { name: "exec-in-pkg", detail: l10n.t("Get in-package executable path") },
    { name: "param", detail: l10n.t("Get node parameter value ($(param name))") },
    { name: "dirname", detail: l10n.t("Current launch file directory") },
    { name: "filename", detail: l10n.t("Current launch file name") },
    { name: "anon", detail: l10n.t("Generate anonymous unique name ($(anon prefix))") },
    { name: "command", detail: l10n.t("Run a shell command and take its output") },
    { name: "file-content", detail: l10n.t("Read file contents") },
    { name: "if", detail: l10n.t("Conditional value ($(if cond true false))") },
    { name: "equals", detail: l10n.t("Equality comparison ($(equals a b))") },
    { name: "not-equals", detail: l10n.t("Inequality comparison ($(not-equals a b))") },
    { name: "not", detail: l10n.t("Boolean negation ($(not value))") },
    { name: "and", detail: l10n.t("Boolean AND ($(and a b ...)") },
    { name: "or", detail: l10n.t("Boolean OR ($(or a b ...)") },
    { name: "any", detail: l10n.t("True if any ($(any a b ...)") },
    { name: "all", detail: l10n.t("True if all ($(all a b ...)") },
    { name: "log_dir", detail: l10n.t("launch log directory") },
    { name: "launch_log_dir", detail: l10n.t("launch log directory (full name)") }
];

/** $() 命令候选(命令位;插入带尾空格进参数位;前缀过滤) */
export function substCommandCandidates(prefix: string): Candidate[] {
    const p = prefix.toLowerCase();
    return SUBST_COMMANDS.filter((c) => c.name.startsWith(p)).map((c) => {
        const item = value(c.name);
        item.insert = `${c.name} `;
        item.detail = c.detail;
        item.sort = "1_cmd";
        return item;
    });
}

/**
 * 值内最后一个未闭合 `$(` 的尾段(LD-2,值内版 xacro 行级口径):
 * 值形如 `$(find-pkg-share a)/x/$(var ` 时只看最后一个 `$(` 起的尾段——前段已闭合不影响;
 * 尾段含 `)` 即已闭合 → undefined。
 */
function unclosedDollarParenTail(value: string): string | undefined {
    const idx = value.lastIndexOf("$(");
    if (idx < 0) { return undefined; }
    const tail = value.slice(idx);
    if (tail.indexOf(")") >= 0) { return undefined; }
    return tail;
}

/**
 * 未闭合 `$(` 的命令位判定(LC-3/LC-9 门控;LD-2 改尾段口径):
 * 尾段呈 `$(命令前缀` 形态(允许空白,无尾随空格)→ 返回已键入的命令前缀;
 * `$(var ` 已带命令+尾随空格 → undefined(转参数位,由调用方判 arg-ref)。
 */
export function substCommandPrefixAt(value: string): string | undefined {
    const tail = unclosedDollarParenTail(value);
    if (tail === undefined) { return undefined; }
    const m = /^\$\(\s*([A-Za-z-]*)$/.exec(tail);
    return m ? m[1] : undefined;
}

/**
 * `$(var ` 参数位的已敲词(LC-2/LD-2):尾段呈 `$(var 已敲词` / `$(var `(待敲)→ 返回已敲词
 * (待敲为空串);非参数位 → undefined。range 锚定用它(只锚已敲词,`$(var ` 前缀保留)。
 */
export function varArgTypedWordAt(value: string): string | undefined {
    const tail = unclosedDollarParenTail(value);
    if (tail === undefined) { return undefined; }
    const m = /^\$\(\s*var\s+([^\s()]*)$/.exec(tail);
    if (m) { return m[1]; }
    if (/^\$\(\s*var\s*$/.test(tail)) { return ""; }
    return undefined;
}

/** `$(var ` 参数位判定(LC-2;LD-2 起尾段口径) */
export function inVarArgPosition(value: string): boolean {
    return varArgTypedWordAt(value) !== undefined;
}

/** 通用枚举值候选(LC-7) */
export function enumValueCandidates(choices: readonly string[], detail: string): Candidate[] {
    return choices.map((c) => enumItem(c, detail));
}

/** py kwarg 名目录(LC-6;按调用名;首位置参数不计入)。
 *  LJ-4 对齐官方 Humble frontend parse 实证集:Node 全集 = Node.parse(ExecuteProcess.parse)
 *  可读属性 + arguments/ros_arguments;LifecycleNode 同集(继承 Node)。 */
const PY_KWARGS: Readonly<Record<string, readonly { name: string; detail: string }[]>> = {
    Node: [
        { name: "package", detail: l10n.t("Package name") }, { name: "executable", detail: l10n.t("Executable name") },
        { name: "name", detail: l10n.t("Node name") }, { name: "exec_name", detail: l10n.t("Process label") },
        { name: "namespace", detail: l10n.t("Namespace") }, { name: "parameters", detail: l10n.t("Parameter list") },
        { name: "remappings", detail: l10n.t("Topic remappings") }, { name: "arguments", detail: l10n.t("Extra node argv") },
        { name: "ros_arguments", detail: l10n.t("ROS arguments (--ros-args)") }, { name: "output", detail: l10n.t("Output (screen/log/both/none)") },
        { name: "respawn", detail: l10n.t("Restart on exit") }, { name: "respawn_delay", detail: l10n.t("Restart delay (seconds)") },
        { name: "prefix", detail: l10n.t("Launch prefix") }, { name: "emulate_tty", detail: l10n.t("Emulate TTY") },
        { name: "shell", detail: l10n.t("Execute via shell") }, { name: "cwd", detail: l10n.t("Working directory") },
        { name: "additional_env", detail: l10n.t("Additional environment variables") }, { name: "on_exit", detail: l10n.t("On-exit action (shutdown)") }
    ],
    LifecycleNode: [
        { name: "package", detail: l10n.t("Package name") }, { name: "executable", detail: l10n.t("Executable name") },
        { name: "name", detail: l10n.t("Node name") }, { name: "exec_name", detail: l10n.t("Process label") },
        { name: "namespace", detail: l10n.t("Namespace") }, { name: "parameters", detail: l10n.t("Parameter list") },
        { name: "remappings", detail: l10n.t("Topic remappings") }, { name: "arguments", detail: l10n.t("Extra node argv") },
        { name: "ros_arguments", detail: l10n.t("ROS arguments (--ros-args)") }, { name: "output", detail: l10n.t("Output (screen/log/both/none)") },
        { name: "respawn", detail: l10n.t("Restart on exit") }, { name: "respawn_delay", detail: l10n.t("Restart delay (seconds)") },
        { name: "prefix", detail: l10n.t("Launch prefix") }, { name: "emulate_tty", detail: l10n.t("Emulate TTY") },
        { name: "shell", detail: l10n.t("Execute via shell") }, { name: "cwd", detail: l10n.t("Working directory") },
        { name: "additional_env", detail: l10n.t("Additional environment variables") }, { name: "on_exit", detail: l10n.t("On-exit action (shutdown)") }
    ],
    ComposableNode: [
        { name: "package", detail: l10n.t("Package name") }, { name: "plugin", detail: l10n.t("Component class name (ns::Class)") },
        { name: "name", detail: l10n.t("Node name") }, { name: "namespace", detail: l10n.t("Namespace") },
        { name: "parameters", detail: l10n.t("Parameter list") }, { name: "remappings", detail: l10n.t("Topic remappings") },
        { name: "extra_arguments", detail: l10n.t("extra component parameters") }
    ],
    ComposableNodeContainer: [
        { name: "name", detail: l10n.t("container name") }, { name: "namespace", detail: l10n.t("Namespace") },
        { name: "package", detail: l10n.t("Package name") }, { name: "executable", detail: l10n.t("container executable name") },
        { name: "composable_node_descriptions", detail: l10n.t("component description list") },
        { name: "parameters", detail: l10n.t("Parameter list") }, { name: "output", detail: l10n.t("Output") }
    ],
    IncludeLaunchDescription: [
        { name: "launch_description_source", detail: l10n.t("included launch source") },
        { name: "launch_arguments", detail: l10n.t("argument dictionary") }, { name: "condition", detail: l10n.t("enable condition") }
    ],
    DeclareLaunchArgument: [
        { name: "default_value", detail: l10n.t("Default value") }, { name: "description", detail: l10n.t("description") },
        { name: "choices", detail: l10n.t("choice list") }, { name: "condition", detail: l10n.t("enable condition") }
    ],
    ExecuteProcess: [
        { name: "cmd", detail: l10n.t("command and argument list") }, { name: "prefix", detail: l10n.t("Launch prefix") },
        { name: "name", detail: l10n.t("Process name") }, { name: "output", detail: l10n.t("Output (screen/log)") },
        { name: "respawn", detail: l10n.t("Restart on exit") }, { name: "shell", detail: l10n.t("Execute via shell") },
        { name: "additional_env", detail: l10n.t("Additional environment variables") }, { name: "cwd", detail: l10n.t("Working directory") }
    ],
    GroupAction: [
        { name: "actions", detail: l10n.t("sub-action list") }, { name: "pushed_namespace", detail: l10n.t("pushed namespace") },
        { name: "condition", detail: l10n.t("enable condition") }, { name: "scoped", detail: l10n.t("parameter/config scope isolation") },
        { name: "forwarding", detail: l10n.t("Config forwarding") }, { name: "launch_configurations", detail: l10n.t("group-pinned parameters") }
    ],
    SetParameter: [
        { name: "name", detail: l10n.t("argument name") }, { name: "value", detail: l10n.t("argument value") },
        { name: "condition", detail: l10n.t("enable condition") }
    ],
    PushRosNamespace: [
        { name: "namespace", detail: l10n.t("Namespace") }
    ],
    // LJ-6 残差(官方 __init__/parse 签名实证)
    LogInfo: [
        { name: "msg", detail: l10n.t("log content") }
    ],
    Shutdown: [
        { name: "reason", detail: l10n.t("shutdown reason") }
    ],
    TimerAction: [
        { name: "period", detail: l10n.t("period in seconds") }, { name: "actions", detail: l10n.t("sub-action list") },
        { name: "cancel_on_shutdown", detail: l10n.t("Cancel on exit") }
    ],
    RosTimer: [
        { name: "period", detail: l10n.t("period in seconds (ROS clock)") }, { name: "actions", detail: l10n.t("sub-action list") },
        { name: "cancel_on_shutdown", detail: l10n.t("Cancel on exit") }
    ],
    SetEnvironmentVariable: [
        { name: "name", detail: l10n.t("environment variable name") }, { name: "value", detail: l10n.t("value") }
    ],
    AppendEnvironmentVariable: [
        { name: "name", detail: l10n.t("environment variable name") }, { name: "value", detail: l10n.t("Appended value") },
        { name: "prepend", detail: l10n.t("prepend instead of append") }, { name: "separator", detail: l10n.t("separator") }
    ],
    UnsetEnvironmentVariable: [
        { name: "name", detail: l10n.t("environment variable name") }
    ],
    SetLaunchConfiguration: [
        { name: "name", detail: l10n.t("launch config name") }, { name: "value", detail: l10n.t("value") }
    ],
    SetParametersFromFile: [
        { name: "filename", detail: l10n.t("params file path") }
    ],
    LoadComposableNodes: [
        { name: "target_container_name", detail: l10n.t("target container node name") },
        { name: "composable_nodes", detail: l10n.t("component description list") }
    ],
    // LJ-10b:事件驱动 / 协程 / 配置栈(官方 ctor 签名终审)
    RegisterEventHandler: [
        { name: "event_handler", detail: l10n.t("event handler") }, { name: "condition", detail: l10n.t("enable condition") }
    ],
    UnregisterEventHandler: [
        { name: "event_handler", detail: l10n.t("event handler to unregister") }
    ],
    OnProcessStart: [
        { name: "target_action", detail: l10n.t("target process action") }, { name: "on_start", detail: l10n.t("Actions to run on launch start") }
    ],
    OnProcessExit: [
        { name: "target_action", detail: l10n.t("target process action") }, { name: "on_exit", detail: l10n.t("Actions to run on exit") }
    ],
    OnProcessIO: [
        { name: "target_action", detail: l10n.t("target process action") },
        { name: "on_stdout", detail: l10n.t("stdout handling action") }, { name: "on_stderr", detail: l10n.t("stderr handling action") }
    ],
    OnShutdown: [
        { name: "on_shutdown", detail: l10n.t("Actions to run on shutdown") }
    ],
    OnExecutionComplete: [
        { name: "on_completion", detail: l10n.t("Actions to run on completion") }
    ],
    OnIncludeLaunchDescription: [
        { name: "condition", detail: l10n.t("enable condition") }
    ],
    EmitEvent: [
        { name: "event", detail: l10n.t("event to emit") }
    ],
    OpaqueCoroutine: [
        { name: "coroutine", detail: l10n.t("coroutine function") }, { name: "args", detail: l10n.t("coroutine positional arguments") },
        { name: "kwargs", detail: l10n.t("coroutine keyword arguments") }, { name: "ignore_context", detail: l10n.t("do not inject context") }
    ],
    ExecuteLocal: [
        { name: "cmd", detail: l10n.t("command and argument list") }, { name: "output", detail: l10n.t("Output (screen/log/both/none)") },
        { name: "respawn", detail: l10n.t("Restart on exit") }, { name: "shell", detail: l10n.t("Execute via shell") },
        { name: "cwd", detail: l10n.t("Working directory") }, { name: "prefix", detail: l10n.t("Launch prefix") }
    ],
    PushEnvironment: [],
    PopEnvironment: [],
    PushLaunchConfigurations: [],
    PopLaunchConfigurations: [],
    UnsetLaunchConfiguration: [
        { name: "name", detail: l10n.t("launch config name to unset") }
    ]
};

/** 光标处于领域调用的 kwarg 名位(LC-6):返回调用名/已键入前缀/前缀起点/已键入 kwarg 集合 */
export interface PyKwargNameContext {
    call: string;
    prefix: string;
    prefixStart: number;
    exclude: Set<string>;
}

export function pyKwargNameContextAt(text: string, offset: number): PyKwargNameContext | undefined {
    const ctx = enclosingPyCall(text, offset);
    if (!ctx || ctx.call === "get_package_share_directory" || ctx.call === "LaunchConfiguration") {
        return undefined;
    }
    const seg = text.slice(ctx.open + 1, offset);
    if (PY_ATTR_TAIL_RE.test(seg)) {
        return undefined; // 值位:kwarg 值补全的地盘
    }
    const exclude = new Set<string>();
    const done = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    let dm: RegExpExecArray | null;
    while ((dm = done.exec(seg)) !== null) {
        exclude.add(dm[1]);
    }
    // 名位:段尾 = 词(前随空白/逗号/开括号);或紧跟开括号/逗号/换行缩进(空前缀)
    const word = seg.match(/(?:^|[\s,(])([A-Za-z_][A-Za-z0-9_]*)$/);
    if (word) {
        return { call: ctx.call, prefix: word[1], prefixStart: offset - word[1].length, exclude };
    }
    if (seg.length === 0 || /(?:^|[,(])\s*$/.test(seg)) {
        return { call: ctx.call, prefix: "", prefixStart: offset, exclude };
    }
    return undefined;
}

/** 调用的 kwarg 名候选(LC-6;前缀过滤 + 已键入排除) */
export function pyKwargCandidates(call: string, prefix: string, exclude: ReadonlySet<string>): Candidate[] {
    const list = PY_KWARGS[call] ?? [];
    const p = prefix.toLowerCase();
    return list
        .filter((k) => k.name.startsWith(p) && !exclude.has(k.name))
        .map((k) => property(k.name, k.detail));
}

// ---------- XML(.launch / .launch.xml) ----------

/**
 * 标签子元素白名单(父 → 可插入的子标签)。
 * LJ-1/LJ-6 全量对齐官方 Humble frontend parse 源码(2026-10-01 VM 实证):
 * node 子实体 = param/remap/env(node.py parse);param 可嵌套 param;arg 子 choice;group 子 keep;
 * executable 亦 env(ExecuteProcess.parse);timer/ros_timer 子 = 任意动作;
 * node_container(Node 子类)子 = composable_node/param/remap/env;
 * load_composable_node 子 = composable_node;composable_node 子 = param/remap/extra_arg;reset 子 keep。
 */
const LAUNCH_ACTIONS_XML = ["arg", "node", "include", "group", "executable", "let", "set_env", "env",
    "push-ros-namespace", "timer", "ros_timer", "set_parameter", "set_remap", "set_use_sim_time",
    "set_parameters_from_file", "log", "append_env", "unset_env", "reset_env", "reset", "shutdown",
    "node_container", "load_composable_node"];

const XML_CHILDREN: Readonly<Record<string, readonly string[]>> = {
    launch: LAUNCH_ACTIONS_XML,
    node: ["param", "remap", "env"],
    include: ["arg"],
    group: LAUNCH_ACTIONS_XML.concat(["keep"]),
    arg: ["choice"],
    param: ["param"],
    executable: ["env"],
    timer: LAUNCH_ACTIONS_XML,
    ros_timer: LAUNCH_ACTIONS_XML,
    node_container: ["composable_node", "param", "remap", "env"],
    load_composable_node: ["composable_node"],
    composable_node: ["param", "remap", "extra_arg"],
    reset: ["keep"],
};

/**
 * 标签属性集(补全属性名用;LJ-1/LJ-6 对齐官方):
 *  - node(node.py parse + ExecuteProcess.parse):pkg/exec/name/exec_name/namespace/args/ros_args/
 *    cwd/on_exit/launch-prefix/output/respawn/respawn_delay/shell/emulate_tty;
 *  - node_container = Node 子类(同 node)+ composable_node 子实体;
 *  - executable(ExecuteProcess.parse):cmd + 同上全部;
 *  - arg(declare_launch_argument.py):name/default/description + choice 子标签(无 value 属性);
 *  - param(node.py parse_nested_parameters):name/value/type/from/allow_substs;
 *  - group(group_action.py):scoped/forwarding;timer/ros_timer(timer_action.py):period/cancel_on_shutdown;
 *  - set_parameter/set_remap/set_use_sim_time(load_ros)+ keep/choice/env 子实体;
 *  - LJ-6 残差全集:log(message)/append_env(name/value/prepend/separator)/unset_env(name)/
 *    reset_env(无)/shutdown(reason)/reset(无,子 keep)/set_parameters_from_file(filename)/
 *    load_composable_node(target)/composable_node(pkg/exec/plugin/name/namespace/if/unless)/extra_arg。
 */
const XML_ATTRS: Readonly<Record<string, readonly string[]>> = {
    node: ["pkg", "exec", "name", "exec_name", "namespace", "args", "ros_args", "output", "respawn",
        "respawn_delay", "cwd", "launch-prefix", "shell", "emulate_tty", "on_exit", "if", "unless"],
    include: ["file", "if", "unless"],
    arg: ["name", "default", "description", "if", "unless"],
    param: ["name", "value", "type", "from", "allow_substs", "if", "unless"],
    remap: ["from", "to"],
    group: ["scoped", "forwarding", "if", "unless"],
    env: ["name", "value"],
    set_env: ["name", "value"],
    let: ["name", "value"],
    executable: ["cmd", "name", "cwd", "launch-prefix", "output", "respawn", "respawn_delay", "shell",
        "emulate_tty", "on_exit", "if", "unless"],
    "push-ros-namespace": ["namespace"],
    timer: ["period", "cancel_on_shutdown", "if", "unless"],
    set_parameter: ["name", "value", "if", "unless"],
    set_remap: ["from", "to", "if", "unless"],
    set_use_sim_time: ["value", "if", "unless"],
    choice: ["value"],
    keep: ["name", "value"],
    log: ["message"],
    append_env: ["name", "value", "prepend", "separator"],
    unset_env: ["name"],
    reset_env: [],
    reset: [],
    shutdown: ["reason"],
    ros_timer: ["period", "cancel_on_shutdown", "if", "unless"],
    set_parameters_from_file: ["filename"],
    node_container: ["pkg", "exec", "name", "exec_name", "namespace", "args", "ros_args", "output",
        "respawn", "respawn_delay", "cwd", "launch-prefix", "shell", "emulate_tty", "on_exit", "if", "unless"],
    load_composable_node: ["target", "if", "unless"],
    composable_node: ["pkg", "exec", "plugin", "name", "namespace", "if", "unless"],
    extra_arg: ["name", "value"],
    launch: [],
};

/** 元素插入片段(结构补全;子标签在未闭合父内不单独补) */
const XML_SNIPPETS: Readonly<Record<string, { insert: string; detail: string }>> = {
    launch: { insert: "<launch>\n\t$0\n</launch>", detail: l10n.t("launch root") },
    node: { insert: '<node pkg="${1:package_name}" exec="${2:executable_name}" name="${3:node_name}" output="${4|screen,log|}" />$0', detail: l10n.t("Launch a node") },
    include: { insert: '<include file="$(find-pkg-share ${1:package_name})/${2:launch/file.launch.xml}" />$0', detail: l10n.t("Include a launch file") },
    arg: { insert: '<arg name="${1:arg_name}" default="${2:default_value}" />$0', detail: l10n.t("Declare an argument") },
    param: { insert: '<param name="${1:param_name}" value="${2:param_value}" />$0', detail: l10n.t("node parameters") },
    remap: { insert: '<remap from="${1:from_topic}" to="${2:to_topic}" />$0', detail: l10n.t("Topic remappings") },
    group: { insert: "<group>\n\t$0\n</group>", detail: l10n.t("group") },
    "push-ros-namespace": { insert: '<push-ros-namespace namespace="${1:namespace}" />$0', detail: l10n.t("pushed namespace") },
    env: { insert: '<env name="${1:ENV_NAME}" value="${2:value}" />$0', detail: l10n.t("Process environment variables") },
    set_env: { insert: '<set_env name="${1:ENV_NAME}" value="${2:value}" />$0', detail: l10n.t("Set environment variable") },
    let: { insert: '<let name="${1:var_name}" value="${2:var_value}" />$0', detail: l10n.t("Define a variable") },
    executable: { insert: '<executable cmd="${1:command}" output="${2|screen,log|}" />$0', detail: l10n.t("Execute a process") },
    timer: { insert: '<timer period="${1:seconds}">\n\t$0\n</timer>', detail: l10n.t("Timer-triggered child actions") },
    set_parameter: { insert: '<set_parameter name="${1:param_name}" value="${2:param_value}" />$0', detail: l10n.t("Set global parameters") },
    set_remap: { insert: '<set_remap from="${1:from_topic}" to="${2:to_topic}" />$0', detail: l10n.t("Set global remappings") },
    set_use_sim_time: { insert: '<set_use_sim_time value="${1|true,false|}" />$0', detail: l10n.t("set use_sim_time") },
    choice: { insert: '<choice value="${1:value}" />$0', detail: l10n.t("argument choices (arg sub-tag)") },
    keep: { insert: '<keep name="${1:name}" value="${2:value}" />$0', detail: l10n.t("group-pinned parameters (group sub-tag)") },
    log: { insert: '<log message="${1:message}" />$0', detail: l10n.t("Output log") },
    append_env: { insert: '<append_env name="${1:ENV_NAME}" value="${2:value}" />$0', detail: l10n.t("Append environment variable") },
    unset_env: { insert: '<unset_env name="${1:ENV_NAME}" />$0', detail: l10n.t("Unset environment variable") },
    reset_env: { insert: "<reset_env />$0", detail: l10n.t("Unset environment variable") },
    reset: { insert: "<reset>\n\t$0\n</reset>", detail: l10n.t("Reset launch config") },
    shutdown: { insert: '<shutdown reason="${1:reason}" />$0', detail: l10n.t("Shutdown the launch") },
    ros_timer: { insert: '<ros_timer period="${1:seconds}">\n\t$0\n</ros_timer>', detail: l10n.t("Timer-triggered (ROS clock)") },
    set_parameters_from_file: { insert: '<set_parameters_from_file filename="${1:params.yaml}" />$0', detail: l10n.t("Load global parameters from file") },
    node_container: { insert: '<node_container pkg="${1:rclcpp_components}" exec="${2:component_container}" name="${3:container_name}">\n\t$0\n</node_container>', detail: l10n.t("Component container") },
    load_composable_node: { insert: '<load_composable_node target="${1:container_name}">\n\t$0\n</load_composable_node>', detail: l10n.t("Load components into the container") },
    composable_node: { insert: '<composable_node pkg="${1:package_name}" plugin="${2:ns::Class}" name="${3:node_name}" />$0', detail: l10n.t("component description (container sub-tag)") },
    extra_arg: { insert: '<extra_arg name="${1:name}" value="${2:value}" />$0', detail: l10n.t("extra component parameters (composable_node sub-tag)") },
};

/** XML 附加片段(2026-09-07 由原 snippets/launch-xml.json 全量转制的变体/模板/替换项,补主标签目录之外的部分) */
interface XmlExtraDef {
    label: string;
    keywords: string[];
    insert: string;
    detail: string;
    /** 替换类($(…) 片段,可在属性值内使用) */
    subst?: boolean;
}

const XML_EXTRA_SNIPPETS: ReadonlyArray<XmlExtraDef> = [
    { label: l10n.t("XML file template (whole file)"), keywords: ["ros2launch", "template", "xml"], detail: l10n.t("Whole launch file template with XML declaration"), insert: '<?xml version="1.0"?>\n<launch>\n\t$0\n</launch>' },
    { label: l10n.t("node (with namespace)"), keywords: ["ros2nodens", "node", "namespace"], detail: l10n.t("launch node with namespace"), insert: '<node pkg="${1:package_name}" exec="${2:executable_name}" name="${3:node_name}" namespace="${4:namespace}" output="${5|screen,log|}" />$0' },
    { label: l10n.t("node (block)"), keywords: ["ros2nodeblock", "node"], detail: l10n.t("Block-style node (with param/remap sub-tags)"), insert: '<node pkg="${1:package_name}" exec="${2:executable_name}" name="${3:node_name}">\n\t$0\n</node>' },
    { label: l10n.t("arg (no default)"), keywords: ["ros2argnodefault", "arg"], detail: l10n.t("launch argument without default"), insert: '<arg name="${1:arg_name}" />$0' },
    { label: l10n.t("include (with child args)"), keywords: ["ros2includeargs", "include"], detail: l10n.t("launch file inclusion with argument passing"), insert: '<include file="$(find-pkg-share ${1:package_name})/${2:launch/file.launch.xml}">\n\t<arg name="${3:arg_name}" value="${4:arg_value}" />\n</include>\n$0' },
    { label: l10n.t("param (from YAML file)"), keywords: ["ros2paramfile", "param", "from"], detail: l10n.t("Load node parameters from a YAML file"), insert: '<param from="$(find-pkg-share ${1:package_name})/${2:config/params.yaml}" />$0' },
    { label: l10n.t("$(var argument) substitution"), keywords: ["ros2var", "var", "$(var"], detail: l10n.t("launch argument substitution"), insert: '$(var ${1:var_name})', subst: true },
    { label: l10n.t("$(env variable) substitution"), keywords: ["ros2getenv", "env", "$(env"], detail: l10n.t("environment variable substitution"), insert: '$(env ${1:ENV_NAME})', subst: true },
    { label: l10n.t("$(find-pkg-share package) substitution"), keywords: ["ros2findpkg", "find-pkg-share", "$(find-pkg-share"], detail: l10n.t("package share directory substitution"), insert: '$(find-pkg-share ${1:package_name})', subst: true },
];

function xmlExtraMatched(prefix: string): Candidate[] {
    const p = prefix.toLowerCase();
    const out: Candidate[] = [];
    for (const s of XML_EXTRA_SNIPPETS) {
        const hay = latinFilter(s.insert, s.label, s.keywords).toLowerCase();
        if (!hay.includes(p)) {
            continue;
        }
        const c = snippet(s.label, s.insert, s.detail);
        c.filter = snippetFilterText(s.insert, s.label, s.keywords);
        out.push(c);
    }
    return out;
}

/** XML 附加片段候选(在 launch 文件内文本/标签名上下文追加;前缀过滤) */
export function xmlExtraCandidates(prefix: string): Candidate[] {
    return xmlExtraMatched(prefix);
}

/** 替换类片段候选($(…) 可在属性值内用;vscode 侧对模糊前缀过滤) */
export function xmlSubstCandidates(): Candidate[] {
    return XML_EXTRA_SNIPPETS.filter(s => s.subst).map(s => {
        const c = snippet(s.label, s.insert, s.detail);
        c.filter = latinFilter(s.insert, s.label, s.keywords);
        return c;
    });
}

/** output 属性枚举(官方 ExecuteProcess:screen/log/both/none;三格式共用) */
const OUTPUT_CHOICES = ["screen", "log", "both", "none"];

/** output 枚举候选(三格式共用口径,LJ-1 起 py/yaml 与 xml 同给全 4 值) */
export function outputEnumCandidates(): Candidate[] {
    return OUTPUT_CHOICES.map(c => enumItem(c, "output 取值"));
}

/**
 * XML 光标上下文:
 *  - tagName: 正在输入标签名(<后、空白前)
 *  - attrName: 标签内输入属性名(含 = 后尚未有值)
 *  - attrValue: 引号内输入属性值(attr/值前缀/值起点)
 *  - text: 标签间文本区(父标签栈,补子元素用)
 */
export type XmlCursor =
    | { kind: "tagName"; tag: string; tagPrefix: string; parents: string[] }
    | { kind: "attrName"; tag: string; attrPrefix: string }
    | { kind: "attrValue"; tag: string; attr: string; value: string; valueStart: number }
    | { kind: "text"; parents: string[] }
    | undefined;

/** 前缀匹配容器内标签(忽略注释/自闭合)后返回打开标签栈(截止 offset 前) */
function openTagStack(text: string, offset: number): string[] {
    const stack: string[] = [];
    const re = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m.index >= offset) { break; }
        const token = m[0];
        if (token.startsWith("<!--")) { continue; }
        if (token.startsWith("</")) {
            stack.pop();
        } else if (m[1]) {
            // 自闭合(<tag … />)不入栈:找本标签的 '>'
            const gt = text.indexOf(">", m.index);
            if (gt >= offset) { continue; } // 未闭合(编辑中)的标签对后续父链无影响
            if (gt > m.index && text[gt - 1] === "/") { continue; }
            stack.push(m[1]);
        }
    }
    return stack;
}

/** 判定 offset 是否处于打开的标签尖括号内 */
export function xmlCursorAt(text: string, offset: number): XmlCursor {
    if (offset <= 0) { return undefined; }
    const lastLt = text.lastIndexOf("<", offset - 1);
    const lastGt = text.lastIndexOf(">", offset - 1);
    if (lastLt >= 0 && lastLt > lastGt) {
        const inside = text.slice(lastLt + 1, offset);
        const parents = openTagStack(text, lastLt); // 父链不含正在输入的标签
        if (/^\s*\//.test(inside)) { return undefined; } // 闭合标签内不补
        // 标签名 = 从 < 起到第一个空白/斜杠(可能跨过 offset,取 < 后全文)
        const after = text.slice(lastLt + 1);
        const tag = (after.match(/^\s*([A-Za-z][\w-]*)/) || [])[1] ?? "";
        const bare = inside.replace(/^\s*/, "");
        // 标签名输入中:仅名字(或刚输入 '<' 尚无字符)
        if (!/[\s=]/.test(inside)) {
            return { kind: "tagName", tag, tagPrefix: bare, parents };
        }
        // 属性值内:... attr="prefix
        const vm = inside.match(/(?:^|\s)([A-Za-z][\w-]*)\s*=\s*(['"])([^'"]*)$/);
        if (vm) {
            // 2026-09-13:RegExpMatchArray.index 类型为 number|undefined(此处 match 恒带 index,?? 0 仅类型兜底)
            const valueStart = lastLt + 1 + (vm.index ?? 0) + vm[0].length - vm[3].length;
            return { kind: "attrValue", tag, attr: vm[1], value: vm[3], valueStart };
        }
        // 属性名输入中(标签名后、= 前)
        if (tag && !inside.endsWith("=")) {
            const am = inside.match(/(?:^|\s)([A-Za-z][\w-]*)$/);
            if (am && !/\s=/.test(inside.slice(0, am.index))) {
                return { kind: "attrName", tag, attrPrefix: am[1] };
            }
        }
        return undefined; // 标签内空白/等号边界:不打扰
    }
    // 标签间:父链 = 打开标签栈
    return { kind: "text", parents: openTagStack(text, offset) };
}

/** 某父标签下可插入的子标签候选(前缀过滤);父未知/空(根)时给 launch */
export function xmlChildCandidates(parent: string | undefined, prefix: string): Candidate[] {
    const allowed = parent ? (XML_CHILDREN[parent] ?? Object.keys(XML_SNIPPETS)) : ["launch"];
    const p = prefix.toLowerCase();
    const out: Candidate[] = [];
    for (const t of allowed) {
        if (!t.toLowerCase().startsWith(p)) { continue; }
        const s = XML_SNIPPETS[t];
        out.push(snippet(s ? t : t, s ? s.insert : `<${t} />$0`, s ? s.detail : t));
    }
    // 根/未知父也顺带给出其余动作标签(前缀命中才出现,不刷屏)
    if (parent === "launch" || !parent) {
        for (const t of Object.keys(XML_SNIPPETS)) {
            if (!allowed.includes(t) && t.toLowerCase().startsWith(p) && !out.some(c => c.label === t)) {
                const s = XML_SNIPPETS[t];
                out.push(snippet(t, s.insert, s.detail));
            }
        }
    }
    return out;
}

/** 属性名候选(前缀过滤) */
export function xmlAttrCandidates(tag: string, prefix: string): Candidate[] {
    const p = prefix.toLowerCase();
    const attrs = XML_ATTRS[tag] ?? [];
    return attrs.filter(a => a.toLowerCase().startsWith(p)).map(a => property(a, `${tag} 属性`));
}

/** 属性值目标解析:pkg(包名)/ output(枚举)/ exec(可执行名,LA-2)/ file 里 $(find-pkg-share 后补包名 */
export function xmlValueSource(
    attr: string,
    value: string
): { source: "pkg"; keep: number } | { source: "output" } | { source: "exec" } | { source: "bool" }
    | { source: "arg-ref"; typed: string } | { source: "subst-cmd"; prefix: string } | undefined {
    if (attr === "pkg") { return { source: "pkg", keep: 0 }; }
    if (attr === "output") { return { source: "output" }; }
    if (attr === "exec") { return { source: "exec" }; }
    if (attr === "respawn") { return { source: "bool" }; }
    if (attr === "file" && /^\$\s*\(\s*find-pkg-share\s*$/.test(value)) {
        return { source: "pkg", keep: value.length }; // 保留 "$(find-pkg-share " 前缀
    }
    // LC-2:$(var 参数位(未闭合,LD-2 尾段口径;typed=已敲词,range 锚定用)
    const typed = varArgTypedWordAt(value);
    if (typed !== undefined) { return { source: "arg-ref", typed }; }
    // LC-3:$() 命令位($( / $(v …,无右括号;LD-2 尾段口径,值中后续 $() 亦识别)
    const cmdPrefix = substCommandPrefixAt(value);
    if (cmdPrefix !== undefined) { return { source: "subst-cmd", prefix: cmdPrefix }; }
    return undefined;
}

/** 开标签内、光标之前的已闭合同标签属性值(XML 可执行补全的 pkg 上下文):
 *  `<node pkg="demo_pkg" exec="…"` → cursor 在 exec 值内时取到 demo_pkg。仅字面量。
 *  LJ-6 序无关:光标后(同一标签内,至本行行尾/首个 `>`)的已闭合属性同样命中——
 *  `exec=` 写在 `pkg=` 之前也能拿到 pkg 上下文。 */
export function xmlTagAttrBefore(text: string, offset: number, attr: string): string | undefined {
    const lastLt = text.lastIndexOf("<", offset - 1);
    const lastGt = text.lastIndexOf(">", offset - 1);
    if (lastLt < 0 || lastLt < lastGt) {
        return undefined; // 不在开标签内
    }
    const re = new RegExp("\\b" + attr + "\\s*=\\s*([\"'])([^\"']*)\\1");
    const m = re.exec(text.slice(lastLt, offset));
    if (m) {
        return m[2];
    }
    // LJ-6:向后找本标签内的已闭合属性(至首个 '>' 或本行行尾;当前未闭合值不匹配已闭合正则)
    let tagEnd = text.indexOf(">", offset);
    const lineEnd = text.indexOf("\n", offset);
    if (tagEnd < 0 || (lineEnd >= 0 && lineEnd < tagEnd)) {
        tagEnd = lineEnd < 0 ? text.length : lineEnd;
    }
    const after = re.exec(text.slice(offset, tagEnd));
    return after ? after[2] : undefined;
}

// ---------- YAML(.launch.yaml) ----------

/** YAML 动作规格:详情/插入片段/键目录 */
interface YamlActionSpec {
    detail: string;
    insert: (indent: string) => string;
    keys: readonly string[];
}

/**
 * YAML launch 动作目录(列表项);node/include/arg 的键用于键补全。
 * LJ-1 全量对齐官方 Humble frontend parse 源码(2026-10-01 VM 实证):
 *  - node 键 = pkg/exec/name/exec_name/namespace/args/ros_args/output/respawn/respawn_delay/
 *    cwd/launch-prefix/shell/emulate_tty/on_exit + remap/param/env 子列表;
 *  - execute_process 键 = cmd/cwd/name/output/respawn/respawn_delay/launch-prefix/shell/
 *    emulate_tty/on_exit + env 子列表;
 *  - arg + choice 子列表;group 键 scoped/forwarding/keep;
 *  - 补齐动作 push_ros_namespace/timer/set_parameter/set_remap/set_use_sim_time。
 */
const YAML_ACTIONS: Readonly<Record<string, YamlActionSpec>> = {
    node: {
        detail: l10n.t("Launch a node"),
        insert: (i) => ["- node:", `${i}pkg: "${"${1:package_name}"}"`, `${i}exec: "${"${2:executable_name}"}"`, `${i}name: "${"${3:node_name}"}"`, `${i}output: "screen"\${0}`].join("\n"),
        keys: ["pkg", "exec", "name", "exec_name", "namespace", "args", "ros_args", "output", "respawn",
            "respawn_delay", "cwd", "launch-prefix", "shell", "emulate_tty", "on_exit", "remap", "param", "env"],
    },
    include: {
        detail: l10n.t("Include a launch file"),
        insert: (i) => [`- include:`, `${i}file: "$(find-pkg-share ${"${1:package_name}"})/${"${2:launch/file.launch.xml}"}"\${0}`].join("\n"),
        keys: ["file", "arg"],
    },
    arg: {
        detail: l10n.t("Declare an argument"),
        insert: (i) => [`- arg:`, `${i}name: "${"${1:arg_name}"}"`, `${i}default: "${"${2:default_value}"}"\${0}`].join("\n"),
        keys: ["name", "default", "description", "choice"],
    },
    group: {
        detail: l10n.t("GroupAction (sub-list action)"),
        insert: () => "- group:\n$0",
        keys: ["scoped", "forwarding", "keep"],
    },
    execute_process: {
        detail: l10n.t("Execute an arbitrary process"),
        insert: (i) => [`- execute_process:`, `${i}cmd: ["${"${1:command}"}", "${"${2:arg}"}"]${0}`].join("\n"),
        keys: ["cmd", "cwd", "name", "output", "respawn", "respawn_delay", "launch-prefix", "shell",
            "emulate_tty", "on_exit", "env"],
    },
    set_env: {
        detail: l10n.t("Set environment variable"),
        insert: (i) => [`- set_env:`, `${i}name: "${"${1:ENV_NAME}"}"`, `${i}value: "${"${2:value}"}"\${0}`].join("\n"),
        keys: ["name", "value"],
    },
    let: {
        detail: l10n.t("Define a variable"),
        insert: (i) => [`- let:`, `${i}name: "${"${1:var_name}"}"`, `${i}value: "${"${2:var_value}"}"\${0}`].join("\n"),
        keys: ["name", "value"],
    },
    push_ros_namespace: {
        detail: l10n.t("pushed namespace"),
        insert: (i) => [`- push_ros_namespace:`, `${i}namespace: "/${"${1:namespace}"}"\${0}`].join("\n"),
        keys: ["namespace"],
    },
    timer: {
        detail: l10n.t("Timer-triggered child actions"),
        insert: (i) => [`- timer:`, `${i}period: "${"${1:seconds}"}"\${0}`].join("\n"),
        keys: ["period", "cancel_on_shutdown"],
    },
    set_parameter: {
        detail: l10n.t("Set global parameters"),
        insert: (i) => [`- set_parameter:`, `${i}name: "${"${1:param_name}"}"`, `${i}value: "${"${2:param_value}"}"\${0}`].join("\n"),
        keys: ["name", "value"],
    },
    set_remap: {
        detail: l10n.t("Set global remappings"),
        insert: (i) => [`- set_remap:`, `${i}from: "${"${1:from_topic}"}"`, `${i}to: "${"${2:to_topic}"}"\${0}`].join("\n"),
        keys: ["from", "to"],
    },
    set_use_sim_time: {
        detail: l10n.t("set use_sim_time"),
        insert: (i) => [`- set_use_sim_time:`, `${i}value: "${"${1|true,false|}"}"\${0}`].join("\n"),
        keys: ["value"],
    },
    // LJ-6 残差全集(2026-10-01 VM 实证)
    append_env: {
        detail: l10n.t("Append environment variable"),
        insert: (i) => [`- append_env:`, `${i}name: "${"${1:ENV_NAME}"}"`, `${i}value: "${"${2:value}"}"\${0}`].join("\n"),
        keys: ["name", "value", "prepend", "separator"],
    },
    unset_env: {
        detail: l10n.t("Unset environment variable"),
        insert: (i) => [`- unset_env:`, `${i}name: "${"${1:ENV_NAME}"}"\${0}`].join("\n"),
        keys: ["name"],
    },
    reset_env: {
        detail: l10n.t("Unset environment variable"),
        insert: () => "- reset_env:\n$0",
        keys: [],
    },
    log: {
        detail: l10n.t("Output log"),
        insert: (i) => [`- log:`, `${i}message: "${"${1:message}"}"\${0}`].join("\n"),
        keys: ["message"],
    },
    shutdown: {
        detail: l10n.t("Shutdown the launch"),
        insert: (i) => [`- shutdown:`, `${i}reason: "${"${1:reason}"}"\${0}`].join("\n"),
        keys: ["reason"],
    },
    reset: {
        detail: l10n.t("Reset launch config"),
        insert: () => "- reset:\n$0",
        keys: ["keep"],
    },
    ros_timer: {
        detail: l10n.t("Timer-triggered (ROS clock)"),
        insert: (i) => [`- ros_timer:`, `${i}period: "${"${1:seconds}"}"\${0}`].join("\n"),
        keys: ["period", "cancel_on_shutdown"],
    },
    set_parameters_from_file: {
        detail: l10n.t("Load global parameters from file"),
        insert: (i) => [`- set_parameters_from_file:`, `${i}filename: "${"${1:params.yaml}"}"\${0}`].join("\n"),
        keys: ["filename"],
    },
    node_container: {
        detail: l10n.t("Component container"),
        insert: (i) => [`- node_container:`, `${i}pkg: "rclcpp_components"`, `${i}exec: "component_container"`, `${i}name: "${"${1:container_name}"}"\${0}`].join("\n"),
        keys: ["pkg", "exec", "name", "exec_name", "namespace", "args", "ros_args", "output", "respawn",
            "respawn_delay", "cwd", "launch-prefix", "shell", "emulate_tty", "on_exit", "composable_node"],
    },
    load_composable_node: {
        detail: l10n.t("Load components into the container"),
        insert: (i) => [`- load_composable_node:`, `${i}target: "${"${1:container_name}"}"\${0}`].join("\n"),
        keys: ["target", "composable_node"],
    },
};

/**
 * YAML 列表值键的子项目录(LJ-2):键 → 子项键集/整项片段。
 *  - remap(from/to)/env(name/value)/keep(name/value)/choice(value):官方 parse 实证;
 *  - param:name/value/type/from/allow_substs(+ 嵌套 param);
 *  - arg(include 下):name/value —— name 值 = 跨文件参数名(LC-5 yaml 版)。
 */
export interface YamlListItemSpec {
    keys: readonly string[];
    /** 整项片段(替换"- 前缀"或新行插入;i = 键行缩进串) */
    insert?: (i: string) => string;
    detail: string;
}

export const YAML_LIST_ITEMS: Readonly<Record<string, YamlListItemSpec>> = {
    remap: {
        keys: ["from", "to"],
        insert: (i) => `from: "${"${1:from_topic}"}"\n${i}to: "${"${2:to_topic}"}"`,
        detail: l10n.t("Remapping item (from -> to)"),
    },
    param: {
        keys: ["name", "value", "type", "from", "allow_substs", "param"],
        insert: (i) => `name: "${"${1:param_name}"}"\n${i}value: "${"${2:param_value}"}"`,
        detail: l10n.t("argument item (name+value, or load params file via from)"),
    },
    env: {
        keys: ["name", "value"],
        insert: (i) => `name: "${"${1:ENV_NAME}"}"\n${i}value: "${"${2:value}"}"`,
        detail: l10n.t("environment variable item"),
    },
    arg: {
        keys: ["name", "value"],
        insert: (i) => `name: "${"${1:arg_name}"}"\n${i}value: "${"${2:arg_value}"}"`,
        detail: l10n.t("argument items of the included launch (name values completed across files)"),
    },
    choice: {
        keys: ["value"],
        insert: () => `value: "${"${1:value}"}"`,
        detail: l10n.t("argument choices"),
    },
    keep: {
        keys: ["name", "value"],
        insert: (i) => `name: "${"${1:name}"}"\n${i}value: "${"${2:value}"}"`,
        detail: l10n.t("group-pinned parameters"),
    },
    // LJ-6:composable_node(node_container/load_composable_node 子列表;pkg/exec 键自动获得包/可执行值补全)
    composable_node: {
        keys: ["pkg", "exec", "plugin", "name", "namespace", "param", "remap", "extra_arg"],
        insert: (i) => `pkg: "${"${1:package_name}"}"\n${i}exec: "${"${2:executable}"}"\n${i}plugin: "${"${3:ns::Class}"}"\n${i}name: "${"${4:node_name}"}"`,
        detail: l10n.t("component description (pkg/exec/plugin/name)"),
    },
    extra_arg: {
        keys: ["name", "value"],
        insert: (i) => `name: "${"${1:name}"}"\n${i}value: "${"${2:value}"}"`,
        detail: l10n.t("extra component parameters"),
    },
};

/** 各动作中值为包名的键(值补全 → 包名) */
const YAML_PKG_KEYS = new Set(["pkg"]);

/**
 * YAML 光标上下文(行级启发,不做完整 yaml 解析):
 *  - action: 位于列表项位置(行以 "-" 开头或项续行空白),补动作名
 *  - key: 动作下的键区(缩进大于动作行),补该动作的键
 *  - value: 键值行,补值(按键类型)
 * LJ-2 子列表两态(remap/param/env/arg/choice/keep 的子项):
 *  - listKey: 子项首键位("- " 后或空行待 "- "),补整项片段/子键
 *  - listValue: 子项键值行("- from: "x""),按键补值(param 的 from = 参数文件路径、
 *    include 下 arg 的 name = 跨文件参数名)
 */
export interface YamlCursorBase {
    /** 缩进列 = 行首非空白偏移(动作项 '-' 所在列;键/值与之一致或更深) */
    indentCol: number;
}
export type YamlCursor =
    | (YamlCursorBase & { kind: "action"; prefix: string; dashTyped: boolean })
    | (YamlCursorBase & { kind: "key"; action?: string; keyPrefix: string })
    | (YamlCursorBase & { kind: "value"; action: string; key: string; valuePrefix: string; valueStart: number })
    | (YamlCursorBase & { kind: "listKey"; action?: string; parentKey: string; prefix: string; dashTyped: boolean })
    | (YamlCursorBase & { kind: "listValue"; action?: string; parentKey: string; key: string; valuePrefix: string; valueStart: number })
    | undefined;

/**
 * 向上找"浅于当前行"的最近结构行:裸列表键(∈ YAML_LIST_ITEMS)→ 子项语境。
 * 动作行(`- node:`)即块边界 → undefined;顶层裸键(launch:)不在目录 → undefined。
 * 找到列表键后回溯其所属动作(include 下 arg 的跨文件补全要带 action)。
 */
export function resolveYamlListParent(
    text: string,
    fromLineStart: number,
    indentCol: number
): { key: string; action?: string } | undefined {
    let idx = fromLineStart - 1;
    while (idx >= 0) {
        const ls = idx > 0 ? text.lastIndexOf("\n", idx - 1) + 1 : 0;
        const l = text.slice(ls, idx + 1).replace(/\r$/, "");
        const indent = (l.match(/^[ \t]*/) || [""])[0].length;
        if (indent < indentCol) {
            if (/^\s*-\s*[A-Za-z_][\w-]*\s*:/.test(l)) {
                return undefined; // 动作块边界:列表键只在本块内有效
            }
            const km = /^\s*([A-Za-z_][\w-]*)\s*:\s*$/.exec(l);
            if (km && YAML_LIST_ITEMS[km[1]]) {
                return { key: km[1], action: enclosingYamlAction(text, ls, indent) };
            }
            if (indent === 0) {
                return undefined;
            }
        }
        idx = ls - 1;
    }
    return undefined;
}

export function yamlCursorAt(text: string, offset: number): YamlCursor {
    const lineStart = offset > 0 ? text.lastIndexOf("\n", offset - 1) + 1 : 0;
    const line = text.slice(lineStart, offset);
    const indent = (line.match(/^[ \t]*/) || [""])[0];
    const indentCol = indent.length;
    const content = line.slice(indent.length);

    // 值前缀提取(LJ-2 起子项值位与 ② 键值行共用):引号内(未闭合)/空待填/裸标量;注释与列表 → undefined
    const valuePrefixOf = (rest: string): string | undefined => {
        if (rest.startsWith("'") || rest.startsWith('"')) {
            return rest.slice(1);
        }
        if (rest === "" || /^\s*$/.test(rest)) {
            return "";
        }
        if (!rest.startsWith("#") && !rest.startsWith("-")) {
            return rest;
        }
        return undefined;
    };

    // ⓪ "-" 开头行:先判子列表语境,否则按动作项
    if (content.startsWith("-")) {
        const listParent = resolveYamlListParent(text, lineStart, indentCol);
        const rest = content.replace(/^-\s*/, "");
        if (listParent) {
            const km = rest.match(/^([A-Za-z_][\w-]*)?$/);
            if (km) {
                return { kind: "listKey", action: listParent.action, parentKey: listParent.key, prefix: km[1] ?? "", indentCol, dashTyped: true };
            }
            const kv = rest.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
            if (kv) {
                const vp = valuePrefixOf(kv[2]);
                if (vp !== undefined) {
                    return { kind: "listValue", action: listParent.action, parentKey: listParent.key, key: kv[1], valuePrefix: vp, valueStart: offset - vp.length, indentCol };
                }
            }
            return undefined;
        }
        const dash = rest.match(/^([A-Za-z_][\w-]*)?$/);
        if (dash) {
            return { kind: "action", prefix: dash[1] ?? "", indentCol, dashTyped: true };
        }
        // `- node:` 已带冒号(动作块头):不打扰
        return undefined;
    }

    // ② 键值行:key: 值(值可为引号内/裸标量/空)
    const kv = content.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
        const key = kv[1];
        const rest = kv[2];
        const action = enclosingYamlAction(text, lineStart, indentCol);
        const valuePrefix = valuePrefixOf(rest);
        if (valuePrefix !== undefined && action) {
            return {
                kind: "value", action, key, indentCol,
                valuePrefix, valueStart: offset - valuePrefix.length,
            };
        }
        return { kind: "key", action, keyPrefix: key, indentCol };
    }
    // ③ 键名输入中(未含冒号)
    if (/^[A-Za-z_][\w-]*$/.test(content)) {
        const action = enclosingYamlAction(text, lineStart, indentCol);
        return { kind: "key", action, keyPrefix: content, indentCol };
    }
    // ④ 空行:先判子列表新项(待 "- ");再上一非空行缩进浅于本行且以 ':' 结尾 → 期待列表项(动作);否则按键区
    if (content === "") {
        const listParent = resolveYamlListParent(text, lineStart, indentCol);
        if (listParent) {
            return { kind: "listKey", action: listParent.action, parentKey: listParent.key, prefix: "", indentCol, dashTyped: false };
        }
        const action = enclosingYamlAction(text, lineStart, indentCol);
        if (action) {
            return { kind: "key", action, keyPrefix: "", indentCol };
        }
        const prev = previousNonBlankLine(text, lineStart);
        if (prev !== undefined && /:\s*$/.test(prev) && indentCol > 0) {
            return { kind: "action", prefix: "", indentCol, dashTyped: false };
        }
        if (indentCol === 0) {
            return { kind: "key", action: undefined, keyPrefix: "", indentCol }; // 顶层(launch:)
        }
        return undefined;
    }
    return undefined;
}

/** 向前取最近非空行文本(不含行尾换行);无则 undefined */
function previousNonBlankLine(text: string, beforeLineStart: number): string | undefined {
    let idx = beforeLineStart - 1;
    while (idx >= 0) {
        const ls = idx > 0 ? text.lastIndexOf("\n", idx - 1) + 1 : 0;
        const l = text.slice(ls, idx + 1).replace(/\r$/, "");
        if (l.trim().length > 0) {
            return l;
        }
        idx = ls - 1;
    }
    return undefined;
}

/** 向上找缩进浅于当前行的动作行(- action:) */
function enclosingYamlAction(text: string, fromLineStart: number, indentCol: number): string | undefined {
    let idx = fromLineStart - 1; // 上一行行尾
    while (idx >= 0) {
        const ls = idx > 0 ? text.lastIndexOf("\n", idx - 1) + 1 : 0;
        const l = text.slice(ls, idx + 1).replace(/\r$/, "");
        const indent = (l.match(/^[ \t]*/) || [""])[0].length;
        if (indent < indentCol) {
            const m = l.match(/^\s*-\s*([A-Za-z_][\w-]*)\s*:\s*$/);
            if (m) { return m[1]; }
            if (indent === 0) { return undefined; } // 已到顶层,不是动作
        }
        idx = ls - 1;
    }
    return undefined;
}

/** 根 launch: 行是否已存在(决定是否补根键) */
export function hasYamlRootLaunch(text: string): boolean {
    const first = text.split(/\r?\n/).find(l => l.trim().length > 0);
    return first !== undefined && /^launch\s*:\s*/.test(first);
}

/** YAML 动作名候选(列表项位置;innerIndent = 动作键行的缩进字符串)。
 *  LJ-7 词锚:dashTyped 时 insert 首行剥掉 "- " 前缀——已敲的 "- " 保留原文(range 只锚已敲词),
 *  覆盖 "- " 会让 VS Code 以 range 文本作过滤输入而滤空全部候选。 */
export function yamlActionCandidates(prefix: string, innerIndent: string, dashTyped?: boolean): Candidate[] {
    const p = prefix.toLowerCase();
    const out: Candidate[] = [];
    for (const [name, spec] of Object.entries(YAML_ACTIONS)) {
        if (!name.startsWith(p)) { continue; }
        let insert = spec.insert(innerIndent);
        if (dashTyped) {
            insert = insert.replace(/^- /, "");
        }
        const item = snippet(name, insert, spec.detail);
        item.filter = snippetFilterText(insert, name, [name]);
        out.push(item);
    }
    return out;
}

/** YAML 根键候选(顶层无 launch: 时;前缀 'launch' 或空) */
export function yamlRootCandidate(prefix: string, rootOk: boolean): Candidate[] {
    if (!rootOk || !"launch".startsWith(prefix.toLowerCase())) { return []; }
    return [snippet("launch", "launch:\n$0", "launch 根")];
}

/** YAML 动作键候选 */
export function yamlKeyCandidates(action: string | undefined, prefix: string): Candidate[] {
    const p = prefix.toLowerCase();
    const keys = action ? (YAML_ACTIONS[action]?.keys ?? []) : [];
    return keys.filter(k => k.startsWith(p)).map(k => property(k, `${action} 键`));
}

/**
 * YAML 子列表候选(LJ-2):已敲键前缀 → 子键;空前缀 → 整项片段(带 "- " 与否按 dashTyped)。
 * innerIndent = 子项续行缩进串(与首键对齐,= indentCol+2)。
 */
export function yamlListItemCandidates(
    parentKey: string,
    prefix: string,
    innerIndent: string,
    dashTyped: boolean
): Candidate[] {
    const spec = YAML_LIST_ITEMS[parentKey];
    if (!spec) {
        return [];
    }
    const p = prefix.toLowerCase();
    if (p !== "") {
        return spec.keys.filter(k => k.startsWith(p)).map(k => property(k, `${parentKey} 子项键`));
    }
    if (!spec.insert) {
        return spec.keys.map(k => property(k, `${parentKey} 子项键`));
    }
    const body = spec.insert(innerIndent);
    const item = snippet(`${parentKey} 项`, (dashTyped ? "" : "- ") + body, spec.detail);
    item.filter = snippetFilterText(body, `${parentKey} 项`, [...spec.keys]);
    return [item];
}

/** 全部子项键名(LJ-2):yamlIncludeFileValue 判"- 键:"行是兄弟子项(继续上扫)还是动作边界(停) */
const YAML_LIST_ITEM_KEY_NAMES = new Set(Object.values(YAML_LIST_ITEMS).flatMap(s => s.keys));

/**
 * include 块的 file 值(LJ-2;从 arg 子项行向上,止于 `- 动作:` 边界;LG-1 原样语义):
 * `- include:` / `file: "…"` / `arg:` / `- name: …` 的块内向上扫,先遇 file 值即返回;
 * 兄弟子项行(`- name:`,键 ∈ 子项键名集)不停。
 */
export function yamlIncludeFileValue(text: string, fromLineStart: number): string | undefined {
    let idx = fromLineStart - 1;
    while (idx >= 0) {
        const ls = idx > 0 ? text.lastIndexOf("\n", idx - 1) + 1 : 0;
        const l = text.slice(ls, idx + 1).replace(/\r$/, "");
        const bm = /^\s*-\s*([A-Za-z_][\w-]*)\s*:/.exec(l);
        if (bm && !YAML_LIST_ITEM_KEY_NAMES.has(bm[1])) {
            return undefined; // 动作行 = 块边界(向上先遇到 include 行 = 本块无 file)
        }
        const fm = /^\s*file\s*:/.exec(l);
        if (fm) {
            const span = parseYamlScalarValue(l, fm[0].length);
            return span ? span.value : undefined;
        }
        idx = ls - 1;
    }
    return undefined;
}

/** YAML 值来源解析:pkg(包名)/ exec(可执行名,LA-2)/ file 的 $(find-pkg-share(需保前缀)/
 *  file 路径单层补全(LJ-2,"path";XML LC-4 同款,${ 与未闭合 $( 排除)/
 *  filename 参数文件路径补全(LJ-6,set_parameters_from_file) */
export function yamlValueSource(
    key: string,
    valuePrefix: string
): { source: "pkg"; keep: number } | { source: "exec" } | { source: "bool" }
    | { source: "output" } | { source: "arg-ref"; typed: string } | { source: "subst-cmd"; prefix: string }
    | { source: "path"; prefix: string } | { source: "params-path"; prefix: string } | undefined {
    if (YAML_PKG_KEYS.has(key)) { return { source: "pkg", keep: 0 }; }
    if (key === "exec") { return { source: "exec" }; }
    if (key === "output") { return { source: "output" }; }
    if (key === "respawn") { return { source: "bool" }; }
    if (key === "file") {
        if (/^\$\s*\(\s*find-pkg-share\s*$/.test(valuePrefix)) {
            return { source: "pkg", keep: valuePrefix.length }; // 保留 "$(find-pkg-share " 前缀
        }
        const pathOk = valuePrefix.indexOf("${") < 0
            && valuePrefix.lastIndexOf("$(") <= valuePrefix.lastIndexOf(")");
        if (pathOk) {
            return { source: "path", prefix: valuePrefix };
        }
        return undefined;
    }
    if (key === "filename") {
        const pathOk = valuePrefix.indexOf("${") < 0
            && valuePrefix.lastIndexOf("$(") <= valuePrefix.lastIndexOf(")");
        if (pathOk) {
            return { source: "params-path", prefix: valuePrefix };
        }
        return undefined;
    }
    // LC-2/LC-3:yaml 值同样支持 $() 替换(var 参数位 / 命令位;LD-2 尾段口径)
    const typed = varArgTypedWordAt(valuePrefix);
    if (typed !== undefined) { return { source: "arg-ref", typed }; }
    const cmdPrefix = substCommandPrefixAt(valuePrefix);
    if (cmdPrefix !== undefined) { return { source: "subst-cmd", prefix: cmdPrefix }; }
    return undefined;
}

/** 同动作块内的键值(YAML 可执行补全/跳转的 pkg 上下文):
 *  `- node:` 块内 `pkg: "demo_pkg"` → 取到 demo_pkg。仅字面量。
 *  LF-1:parseYamlScalarValue 扫描器(引号单/双+转义+裸全对)。
 *  LG-1 正确语义:值**原样返回**(裸值由扫描器剔首尾空格;引号值含前导/后导空格——
 *  `pkg: " p10…"` 的上下文即 ` p10…`,解析失败无响应 = 正确对齐)。
 *  LJ-6 序无关:向上未命中时**向下**在同块内找(exec 写在 pkg 之前也能命中;块界=缩进浅于键行)。 */
export function yamlSiblingKeyValue(text: string, lineStart: number, key: string): string | undefined {
    const lineEnd = text.indexOf("\n", lineStart);
    const curLine = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).replace(/\r$/, "");
    const keyIndent = (curLine.match(/^[ \t]*/) || [""])[0].length;
    let idx = lineStart - 1;
    while (idx >= 0) {
        const ls = idx > 0 ? text.lastIndexOf("\n", idx - 1) + 1 : 0;
        const l = text.slice(ls, idx + 1).replace(/\r$/, "");
        const km = new RegExp("^\\s*" + key + "\\s*:").exec(l);
        if (km) {
            const span = parseYamlScalarValue(l, km[0].length);
            if (span) {
                return span.value.length > 0 ? span.value : undefined;
            }
            return undefined;
        }
        // 动作行(- node:)= 本块顶部:上方无兄弟键,转向下找(LJ-6 序无关)
        if (/^\s*-\s*[A-Za-z_][\w-]*\s*:/.test(l)) {
            break;
        }
        idx = ls - 1;
    }
    // LJ-6:向下同块找(同缩进兄弟键;缩进变浅 = 出块)
    return yamlSiblingKeyValueDown(text, lineEnd < 0 ? text.length : lineEnd + 1, key, keyIndent);
}

/** 向下找同块内键值(LJ-6 序无关;仅与当前键行同缩进的兄弟键;越过块界即停) */
function yamlSiblingKeyValueDown(text: string, fromOffset: number, key: string, keyIndent: number): string | undefined {
    let idx = fromOffset;
    while (idx < text.length) {
        const le = text.indexOf("\n", idx);
        const l = text.slice(idx, le < 0 ? text.length : le).replace(/\r$/, "");
        if (l.trim().length > 0) {
            const indent = (l.match(/^[ \t]*/) || [""])[0].length;
            if (indent < keyIndent) {
                return undefined; // 越过块界(兄弟动作行/外层键)
            }
            if (indent === keyIndent) {
                const km = new RegExp("^\\s*" + key + "\\s*:").exec(l);
                if (km) {
                    const span = parseYamlScalarValue(l, km[0].length);
                    if (span) {
                        return span.value.length > 0 ? span.value : undefined;
                    }
                    return undefined;
                }
            }
        }
        if (le < 0) {
            return undefined;
        }
        idx = le + 1;
    }
    return undefined;
}

// ---------- LF-0 值扫描器(2026-10-01):引号(单/双+转义)与裸标量双路完备 ----------

/** 单行 YAML 标量的解析结果(区间均在 line 内,排他端点) */
export interface YamlScalarSpan {
    kind: "double" | "single" | "bare";
    /** 转义还原后的值(双引号内 \\" \\\\ \\n \\t 还原;单引号 '' → ';裸=首尾 trim、中间空格保留) */
    value: string;
    /** 值内容首字符 offset(不含引号) */
    contentStart: number;
    /** 值内容末字符后一 offset(排他,不含引号) */
    contentEnd: number;
    /** 整个标量起点(含开引号;裸=contentStart) */
    nodeStart: number;
    /** 整个标量终点(排他,含闭引号;裸=contentEnd) */
    nodeEnd: number;
}

/**
 * 从 line 的 from 处解析一个 YAML 标量值(LF-0,字符级扫描,取代正则的引号/转义盲区):
 *  - 双引号:`\\` 转义扫描,还原 \\" \\\\ \\n \\t(其余转义保真字符),止于未转义 `"`;
 *  - 单引号:`''` doubling 还原为止于孤立 `'`(内嵌双引号无需转义,自然支持);
 *  - 裸:` #`(前有空格)/行尾截断注释,首尾 trim,**中间空格保留**;
 *  - 未闭合/空值/纯注释 → undefined。单行范围(launch 值域均为单行;跨行标量病态,不支持)。
 */
export function parseYamlScalarValue(line: string, from: number): YamlScalarSpan | undefined {
    let i = from;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) {
        i++;
    }
    if (i >= line.length) {
        return undefined;
    }
    const ch = line[i];
    if (ch === '"') {
        let value = "";
        let j = i + 1;
        let closed = false;
        while (j < line.length) {
            const c = line[j];
            if (c === "\\") {
                const n = line[j + 1];
                if (n === undefined) {
                    break;
                }
                if (n === '"') { value += '"'; } else if (n === "\\") { value += "\\"; } else if (n === "n") { value += "\n"; } else if (n === "t") { value += "\t"; } else { value += n; }
                j += 2;
                continue;
            }
            if (c === '"') {
                closed = true;
                j++;
                break;
            }
            value += c;
            j++;
        }
        if (!closed) {
            return undefined;
        }
        return { kind: "double", value, contentStart: i + 1, contentEnd: j - 1, nodeStart: i, nodeEnd: j };
    }
    if (ch === "'") {
        let value = "";
        let j = i + 1;
        let closed = false;
        while (j < line.length) {
            const c = line[j];
            if (c === "'") {
                if (line[j + 1] === "'") {
                    value += "'";
                    j += 2;
                    continue;
                }
                closed = true;
                j++;
                break;
            }
            value += c;
            j++;
        }
        if (!closed) {
            return undefined;
        }
        return { kind: "single", value, contentStart: i + 1, contentEnd: j - 1, nodeStart: i, nodeEnd: j };
    }
    // 裸标量:` #`(前有空格)起为注释;首尾 trim,中间空格保留
    if (ch === "#") {
        return undefined; // 纯注释
    }
    let end = line.length;
    for (let j = i + 1; j < line.length; j++) {
        if (line[j] === "#" && (line[j - 1] === " " || line[j - 1] === "\t")) {
            end = j;
            break;
        }
    }
    const raw = line.slice(i, end);
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    const lead = raw.length - raw.trimStart().length;
    return {
        kind: "bare",
        value: trimmed,
        contentStart: i + lead,
        contentEnd: i + lead + trimmed.length,
        nodeStart: i + lead,
        nodeEnd: i + lead + trimmed.length
    };
}

// ---------- 包名候选 ----------

/** 包名值候选(工作区+系统,前缀过滤由 provider 的 wordRange 承担,此处全量给) */
export function pkgValueCandidates(names: readonly string[]): Candidate[] {
    return names.map(value);
}
