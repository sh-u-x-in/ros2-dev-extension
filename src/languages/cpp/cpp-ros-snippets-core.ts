import { l10n } from 'vscode'; // 2026-10-04 i18n 期2

/**
 * ROS 2 C++ 节点代码片段核心(纯 TS,零 vscode 依赖,可无头单测)
 *
 * 2026-09-07:由原 snippets/cpp.json 全量转制(22 条,rclcpp 节点骨架:类模板/组件节点/发布·
 * 订阅/定时器/服务/参数/日志/QoS/动作/注册宏),静态语言级注册退役(cpp 语言全量注入会污染
 * 非 ROS 项目),改经代码提供器(cpp-ros-snippets.ts)动态注入,并施加 ROS 工作区门槛
 * (shared/ros-workspace-gate):非 ROS 工作区不弹。
 */

export interface RosCppSnippet {
    /** 中文显示名(= 原 description) */
    label: string;
    /** 匹配记忆词(原 snippet prefix + 英文语义词),参与 filterText */
    keywords: string[];
    /** 保真多行 body(原 snippets/cpp.json 转制,含 ${…} tabstop/选项) */
    body: string[];
}

const ROS_CPP_SNIPPETS: ReadonlyArray<RosCppSnippet> = [
    { label: l10n.t("Node class template"), keywords: ["ros2node", "node", "class", "rclcpp"], body: [
        "#include \"rclcpp/rclcpp.hpp\"",
        "",
        "class ${1:MyNode} : public rclcpp::Node",
        "{",
        "public:",
        "\t${1:MyNode}() : Node(\"${2:my_node}\")",
        "\t{",
        "\t\t${0}",
        "\t}",
        "",
        "private:",
        "\t",
        "};",
        "",
        "int main(int argc, char * argv[])",
        "{",
        "\trclcpp::init(argc, argv);",
        "\trclcpp::spin(std::make_shared<${1:MyNode}>());",
        "\trclcpp::shutdown();",
        "\treturn 0;",
        "}"
    ] },
    { label: l10n.t("Component node template"), keywords: ["ros2component", "component", "node"], body: [
        "#include \"rclcpp/rclcpp.hpp\"",
        "#include \"rclcpp_components/register_node_macro.hpp\"",
        "",
        "namespace ${1:my_namespace}",
        "{",
        "",
        "class ${2:MyNode} : public rclcpp::Node",
        "{",
        "public:",
        "\texplicit ${2:MyNode}(const rclcpp::NodeOptions & options)",
        "\t: Node(\"${3:my_node}\", options)",
        "\t{",
        "\t\t${0}",
        "\t}",
        "",
        "private:",
        "\t",
        "};",
        "",
        "}  // namespace ${1:my_namespace}",
        "",
        "RCLCPP_COMPONENTS_REGISTER_NODE(${1:my_namespace}::${2:MyNode})"
    ] },
    { label: l10n.t("Publisher"), keywords: ["ros2pub", "publisher", "create_publisher"], body: [
        "publisher_ = this->create_publisher<${1:std_msgs::msg::String}>(",
        "\t\"${2:topic_name}\", ${3:10});",
        "${0}"
    ] },
    { label: l10n.t("Publisher with timer callback"), keywords: ["ros2pubtimer", "publisher", "timer"], body: [
        "publisher_ = this->create_publisher<${1:std_msgs::msg::String}>(",
        "\t\"${2:topic_name}\", ${3:10});",
        "timer_ = this->create_wall_timer(",
        "\tstd::chrono::milliseconds(${4:500}),",
        "\tstd::bind(&${5:MyNode}::${6:timer_callback}, this));",
        "",
        "void ${6:timer_callback}()",
        "{",
        "\tauto message = ${1:std_msgs::msg::String}();",
        "\tmessage.data = \"${7:Hello}\";",
        "\tRCLCPP_INFO(this->get_logger(), \"Publishing: '%s'\", message.data.c_str());",
        "\tpublisher_->publish(message);",
        "}",
        "${0}"
    ] },
    { label: l10n.t("Subscriber"), keywords: ["ros2sub", "subscriber", "create_subscription"], body: [
        "subscription_ = this->create_subscription<${1:std_msgs::msg::String}>(",
        "\t\"${2:topic_name}\", ${3:10},",
        "\tstd::bind(&${4:MyNode}::${5:topic_callback}, this, std::placeholders::_1));",
        "",
        "void ${5:topic_callback}(const ${1:std_msgs::msg::String}::SharedPtr msg)",
        "{",
        "\tRCLCPP_INFO(this->get_logger(), \"I heard: '%s'\", msg->data.c_str());",
        "}",
        "${0}"
    ] },
    { label: l10n.t("Subscriber (lambda)"), keywords: ["ros2sublambda", "subscriber", "lambda"], body: [
        "subscription_ = this->create_subscription<${1:std_msgs::msg::String}>(",
        "\t\"${2:topic_name}\", ${3:10},",
        "\t[this](const ${1:std_msgs::msg::String}::SharedPtr msg) {",
        "\t\tRCLCPP_INFO(this->get_logger(), \"I heard: '%s'\", msg->data.c_str());",
        "\t\t${0}",
        "\t});",
        ""
    ] },
    { label: l10n.t("Timer"), keywords: ["ros2timer", "timer"], body: [
        "timer_ = this->create_wall_timer(",
        "\tstd::chrono::milliseconds(${1:500}),",
        "\tstd::bind(&${2:MyNode}::${3:timer_callback}, this));",
        "",
        "void ${3:timer_callback}()",
        "{",
        "\t${0}",
        "}"
    ] },
    { label: l10n.t("Service server"), keywords: ["ros2srv", "service", "server"], body: [
        "service_ = this->create_service<${1:std_srvs::srv::AddTwoInts}>(",
        "\t\"${2:add_two_ints}\",",
        "\tstd::bind(&${3:MyNode}::${4:handle_service},",
        "\t\tthis, std::placeholders::_1, std::placeholders::_2));",
        "",
        "void ${4:handle_service}(",
        "\tconst std::shared_ptr<${1:std_srvs::srv::AddTwoInts}::Request> request,",
        "\tstd::shared_ptr<${1:std_srvs::srv::AddTwoInts}::Response> response)",
        "{",
        "\t${0}",
        "}"
    ] },
    { label: l10n.t("Service client"), keywords: ["ros2client", "service", "client"], body: [
        "client_ = this->create_client<${1:std_srvs::srv::AddTwoInts}>(\"${2:add_two_ints}\");",
        "",
        "while (!client_->wait_for_service(std::chrono::seconds(1))) {",
        "\tif (!rclcpp::ok()) {",
        "\t\tRCLCPP_ERROR(this->get_logger(), \"Interrupted while waiting for service.\");",
        "\t\treturn;",
        "\t}",
        "\tRCLCPP_INFO(this->get_logger(), \"Service not available, waiting...\");",
        "}",
        "${0}"
    ] },
    { label: l10n.t("Async service call"), keywords: ["ros2call", "service", "call"], body: [
        "auto request = std::make_shared<${1:std_srvs::srv::AddTwoInts}::Request>();",
        "${2:request->a = 1;}",
        "${3:request->b = 2;}",
        "auto result = client_->async_send_request(request);",
        "if (rclcpp::spin_until_future_complete(this->get_node_base_interface(), result) ==",
        "\trclcpp::FutureReturnCode::SUCCESS)",
        "{",
        "\tRCLCPP_INFO(this->get_logger(), \"Result: %ld\", result.get()->sum);",
        "} else {",
        "\tRCLCPP_ERROR(this->get_logger(), \"Failed to call service\");",
        "}",
        "${0}"
    ] },
    { label: l10n.t("Declare parameter"), keywords: ["ros2param", "parameter", "declare"], body: [
        "this->declare_parameter(\"${1:param_name}\", ${2:default_value});",
        "${0}"
    ] },
    { label: l10n.t("Get parameter"), keywords: ["ros2getparam", "parameter", "get"], body: [
        "this->get_parameter(\"${1:param_name}\", ${2:variable});",
        "${0}"
    ] },
    { label: l10n.t("Declare and get parameter"), keywords: ["ros2declgetparam", "parameter"], body: [
        "this->declare_parameter(\"${1:param_name}\", ${2:default_value});",
        "this->get_parameter(\"${1:param_name}\", ${3:variable});",
        "${0}"
    ] },
    { label: l10n.t("Debug log"), keywords: ["ros2debug", "log", "debug"], body: [
        "RCLCPP_DEBUG(this->get_logger(), \"${1:message}\");",
        "${0}"
    ] },
    { label: l10n.t("Info log"), keywords: ["ros2info", "log", "info"], body: [
        "RCLCPP_INFO(this->get_logger(), \"${1:message}\");",
        "${0}"
    ] },
    { label: l10n.t("Warn log"), keywords: ["ros2warn", "log", "warning"], body: [
        "RCLCPP_WARN(this->get_logger(), \"${1:message}\");",
        "${0}"
    ] },
    { label: l10n.t("Error log"), keywords: ["ros2error", "log", "error"], body: [
        "RCLCPP_ERROR(this->get_logger(), \"${1:message}\");",
        "${0}"
    ] },
    { label: l10n.t("Fatal log"), keywords: ["ros2fatal", "log", "fatal"], body: [
        "RCLCPP_FATAL(this->get_logger(), \"${1:message}\");",
        "${0}"
    ] },
    { label: l10n.t("QoS profile"), keywords: ["ros2qos", "qos"], body: [
        "auto qos = rclcpp::QoS(rclcpp::KeepLast(${1:10}));",
        "qos.${2|reliable,best_effort|}();",
        "${0}"
    ] },
    { label: l10n.t("Action server"), keywords: ["ros2actionserver", "action", "server"], body: [
        "#include \"rclcpp_action/rclcpp_action.hpp\"",
        "",
        "using ${1:Fibonacci} = ${2:example_interfaces::action::Fibonacci};",
        "using GoalHandle${1:Fibonacci} = rclcpp_action::ServerGoalHandle<${1:Fibonacci}>;",
        "",
        "action_server_ = rclcpp_action::create_server<${1:Fibonacci}>(",
        "\tthis,",
        "\t\"${3:fibonacci}\",",
        "\tstd::bind(&${4:MyNode}::handle_goal, this, std::placeholders::_1, std::placeholders::_2),",
        "\tstd::bind(&${4:MyNode}::handle_cancel, this, std::placeholders::_1),",
        "\tstd::bind(&${4:MyNode}::handle_accepted, this, std::placeholders::_1));",
        "${0}"
    ] },
    { label: l10n.t("Action client"), keywords: ["ros2actionclient", "action", "client"], body: [
        "#include \"rclcpp_action/rclcpp_action.hpp\"",
        "",
        "action_client_ = rclcpp_action::create_client<${1:example_interfaces::action::Fibonacci}>(",
        "\tthis,",
        "\t\"${2:fibonacci}\");",
        "${0}"
    ] },
    { label: l10n.t("Component registration macro"), keywords: ["ros2register", "component", "register"], body: [
        "#include \"rclcpp_components/register_node_macro.hpp\"",
        "",
        "RCLCPP_COMPONENTS_REGISTER_NODE(${1:namespace}::${2:ClassName})",
        "${0}"
    ] },
];

export interface RosCppCandidate {
    label: string;
    insert: string;
    filter: string;
}

/** 全量目录(供测试/统计) */
export function rosCppSnippets(): ReadonlyArray<RosCppSnippet> {
    return ROS_CPP_SNIPPETS;
}

/** 结构头部 tokens:去 import/#include 头、${…} 占位、引号值、标点后取前几个标识符 */
function headTokens(insert: string, max = 3): string[] {
    const lines = insert.split("\n").filter(l => l.trim().length > 0);
    let start = 0;
    while (start < lines.length && /^\s*(?:#\s*include|using\b)/.test(lines[start])) {
        start++;
    }
    const head = lines.slice(start).join("\n").slice(0, 100);
    const cleaned = head
        .replace(/\$\{[^}]*\}/g, " ")
        .replace(/"[^"]*"/g, " ")
        .replace(/'[^']*'/g, " ")
        .replace(/[{}()[\]=\-;]/g, " ");
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

/** 前缀过滤候选(过滤集 = 纯 ASCII 词;空前缀 = 全量) */
export function rosCppSnippetCandidates(prefix: string): RosCppCandidate[] {
    const p = prefix.toLowerCase();
    const out: RosCppCandidate[] = [];
    for (const s of ROS_CPP_SNIPPETS) {
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
