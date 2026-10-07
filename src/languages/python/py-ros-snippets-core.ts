import { l10n } from 'vscode'; // 2026-10-04 i18n 期2

/**
 * ROS 2 Python 节点代码片段核心(纯 TS,零 vscode 依赖,可无头单测)
 *
 * 2026-09-07:由原 snippets/python.json 全量转制(19 条,rclpy 节点骨架:类模板/发布·订阅/
 * 定时器/服务/参数/日志/动作/QoS),静态语言级注册退役(python 语言全量注入会污染 .launch.py
 * 与无关 .py 文件),改经代码提供器(见 py-ros-snippets.ts)动态注入:
 *  - 仅在**普通 .py(非 *.launch.py)**提供——launch.py 的补全归 languages/launch;
 *  - label 中文(原 description),原 prefix(ros2pub/ros2node…)并入 keywords 参与 filterText,
 *    保留旧肌肉记忆,不出现半英半中条目。
 */

export interface RosPySnippet {
    /** 中文显示名(= 原 description) */
    label: string;
    /** 匹配记忆词(原 snippet prefix + 英文语义词),参与 filterText */
    keywords: string[];
    /** 保真多行 body(原 snippets/python.json 转制,含 ${…} tabstop/选项) */
    body: string[];
}

const ROS_PY_SNIPPETS: ReadonlyArray<RosPySnippet> = [
    { label: l10n.t("Node class template"), keywords: ["ros2node", "node", "class", "rclpy"], body: [
        "import rclpy",
        "from rclpy.node import Node",
        "",
        "",
        "class ${1:MyNode}(Node):",
        "\tdef __init__(self):",
        "\t\tsuper().__init__('${2:my_node}')",
        "\t\t${0}",
        "",
        "",
        "def main(args=None):",
        "\trclpy.init(args=args)",
        "\tnode = ${1:MyNode}()",
        "\trclpy.spin(node)",
        "\tnode.destroy_node()",
        "\trclpy.shutdown()",
        "",
        "",
        "if __name__ == '__main__':",
        "\tmain()"
    ] },
    { label: l10n.t("Publisher"), keywords: ["ros2pub", "publisher", "create_publisher"], body: [
        "self.publisher_ = self.create_publisher(",
        "\t${1:String},",
        "\t'${2:topic_name}',",
        "\t${3:10}",
        ")",
        "${0}"
    ] },
    { label: l10n.t("Publisher with timer callback"), keywords: ["ros2pubtimer", "publisher", "timer"], body: [
        "self.publisher_ = self.create_publisher(",
        "\t${1:String},",
        "\t'${2:topic_name}',",
        "\t${3:10}",
        ")",
        "self.timer = self.create_timer(${4:1.0}, self.timer_callback)",
        "",
        "def timer_callback(self):",
        "\tmsg = ${1:String}()",
        "\tmsg.data = '${5:Hello}'",
        "\tself.publisher_.publish(msg)",
        "\tself.get_logger().info('Publishing: \"${5:Hello}\"')",
        "${0}"
    ] },
    { label: l10n.t("Subscriber"), keywords: ["ros2sub", "subscriber", "create_subscription"], body: [
        "self.subscription = self.create_subscription(",
        "\t${1:String},",
        "\t'${2:topic_name}',",
        "\tself.${3:listener_callback},",
        "\t${4:10}",
        ")",
        "",
        "def ${3:listener_callback}(self, msg):",
        "\tself.get_logger().info('Received: \"%s\"' % msg.data)",
        "${0}"
    ] },
    { label: l10n.t("Timer"), keywords: ["ros2timer", "timer"], body: [
        "self.timer = self.create_timer(${1:1.0}, self.${2:timer_callback})",
        "",
        "def ${2:timer_callback}(self):",
        "\t${0:pass}"
    ] },
    { label: l10n.t("Service server"), keywords: ["ros2srv", "service", "server"], body: [
        "self.srv = self.create_service(",
        "\t${1:AddTwoInts},",
        "\t'${2:add_two_ints}',",
        "\tself.${3:handle_service}",
        ")",
        "",
        "def ${3:handle_service}(self, request, response):",
        "\t${0:pass}",
        "\treturn response"
    ] },
    { label: l10n.t("Service client"), keywords: ["ros2client", "service", "client"], body: [
        "self.client = self.create_client(",
        "\t${1:AddTwoInts},",
        "\t'${2:add_two_ints}'",
        ")",
        "while not self.client.wait_for_service(timeout_sec=1.0):",
        "\tself.get_logger().info('service not available, waiting...')",
        "${0}"
    ] },
    { label: l10n.t("Async service call"), keywords: ["ros2call", "service", "call"], body: [
        "request = ${1:AddTwoInts}.Request()",
        "${2:request.a = 1}",
        "${3:request.b = 2}",
        "future = self.client.call_async(request)",
        "rclpy.spin_until_future_complete(self, future)",
        "response = future.result()",
        "${0}"
    ] },
    { label: l10n.t("Declare parameter"), keywords: ["ros2param", "parameter", "declare"], body: [
        "self.declare_parameter('${1:param_name}', ${2:default_value})",
        "${0}"
    ] },
    { label: l10n.t("Get parameter"), keywords: ["ros2getparam", "parameter", "get"], body: [
        "self.get_parameter('${1:param_name}').${2:value}",
        "${0}"
    ] },
    { label: l10n.t("Declare and get parameter"), keywords: ["ros2declgetparam", "parameter"], body: [
        "self.declare_parameter('${1:param_name}', ${2:default_value})",
        "${3:value} = self.get_parameter('${1:param_name}').${4:value}",
        "${0}"
    ] },
    { label: l10n.t("Debug log"), keywords: ["ros2debug", "log", "debug"], body: [
        "self.get_logger().debug('${1:message}')",
        "${0}"
    ] },
    { label: l10n.t("Info log"), keywords: ["ros2info", "log", "info"], body: [
        "self.get_logger().info('${1:message}')",
        "${0}"
    ] },
    { label: l10n.t("Warn log"), keywords: ["ros2warn", "log", "warning"], body: [
        "self.get_logger().warning('${1:message}')",
        "${0}"
    ] },
    { label: l10n.t("Error log"), keywords: ["ros2error", "log", "error"], body: [
        "self.get_logger().error('${1:message}')",
        "${0}"
    ] },
    { label: l10n.t("Fatal log"), keywords: ["ros2fatal", "log", "fatal"], body: [
        "self.get_logger().fatal('${1:message}')",
        "${0}"
    ] },
    { label: l10n.t("Action server"), keywords: ["ros2actionserver", "action", "server"], body: [
        "from rclpy.action import ActionServer",
        "",
        "self._action_server = ActionServer(",
        "\tself,",
        "\t${1:Fibonacci},",
        "\t'${2:fibonacci}',",
        "\tself.${3:execute_callback}",
        ")",
        "",
        "def ${3:execute_callback}(self, goal_handle):",
        "\tself.get_logger().info('Executing goal...')",
        "\t${4:# Process the goal}",
        "\tgoal_handle.succeed()",
        "\tresult = ${1:Fibonacci}.Result()",
        "\treturn result",
        "${0}"
    ] },
    { label: l10n.t("Action client"), keywords: ["ros2actionclient", "action", "client"], body: [
        "from rclpy.action import ActionClient",
        "",
        "self._action_client = ActionClient(",
        "\tself,",
        "\t${1:Fibonacci},",
        "\t'${2:fibonacci}'",
        ")",
        "${0}"
    ] },
    { label: l10n.t("QoS profile"), keywords: ["ros2qos", "qos"], body: [
        "from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy",
        "",
        "qos_profile = QoSProfile(",
        "\treliability=ReliabilityPolicy.${1|RELIABLE,BEST_EFFORT|},",
        "\thistory=HistoryPolicy.${2|KEEP_LAST,KEEP_ALL|},",
        "\tdepth=${3:10}",
        ")",
        "${0}"
    ] },
];

export interface RosPyCandidate {
    label: string;
    insert: string;
    filter: string;
}

/** 全量目录(供测试/统计) */
export function rosPySnippets(): ReadonlyArray<RosPySnippet> {
    return ROS_PY_SNIPPETS;
}

/** 结构头部 tokens:去 import/from 头、${…} 占位、引号值、标点后取前几个标识符 */
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

/** 纯 ASCII 过滤词(2026-09-08):结构头部主词 + keywords + label 英文词;中文只在显示 label */
function latinFilter(insert: string, label: string, keywords: string[]): string {
    const fromLabel = label.match(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g) ?? [];
    return Array.from(new Set([...headTokens(insert), ...keywords, ...fromLabel])).join(" ");
}

/** 前缀过滤候选(过滤集 = 纯 ASCII 词;空前缀 = 全量,供 '.' 触发) */
export function rosPySnippetCandidates(prefix: string): RosPyCandidate[] {
    const p = prefix.toLowerCase();
    const out: RosPyCandidate[] = [];
    for (const s of ROS_PY_SNIPPETS) {
        const insert = s.body.join("\n");
        const hay = latinFilter(insert, s.label, s.keywords).toLowerCase();
        if (!hay.includes(p)) {
            continue;
        }
        out.push({
            label: s.label,
            insert,
            filter: latinFilter(insert, s.label, s.keywords),
        });
    }
    return out;
}

/** 是否为 launch.py(跳过:launch 补全归 languages/launch,不注入 rclpy 节点片段) */
export function isLaunchPyPath(fsPath: string): boolean {
    return fsPath.toLowerCase().endsWith(".launch.py");
}
