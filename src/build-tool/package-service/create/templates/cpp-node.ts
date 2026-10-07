// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file cpp-node.ts
 * C++ 节点源文件模板(create/templates,2026-09-04 结构重构建立)。
 * 自 create-cpp-package.cppNodeTemplate 原样迁出,内容不变;
 * 生成器仅按 CppNodeSpec 调本函数产出 src/<file>.cpp。
 *
 * 扩展位(后续"Generated-package content upgrade"调整入口):
 *   - 节点模板正文唯一位于本文件;
 *   - 如需按用途(发布/订阅/服务/动作)扩展节点形态,在本文件加导出函数并留模板常量表。
 */

import { getLogger } from "../../../../logger";

/** 扩展日志薄封装(带 tmpl-cpp-node 模块前缀) */
const log = getLogger("tmpl-cpp-node");

/**
 * C++ 最小示范节点源(继承 rclcpp::Node,构造时注册节点并打印Node name一次)。
 * @param pkg 包名(仅出现在文件注释)
 * @param node 运行时Node name / CMake target 名(合法标识符, 由映射顺延得到)
 */
export function cppNodeSource(pkg: string, node: string): string {
    log.trace(`展开 C++ 节点源:${pkg}/${node}`);
    return `// ${pkg} 最小示范节点: 继承 rclcpp::Node 注册节点 + 打印Node name (一次)
#include <memory>

#include "rclcpp/rclcpp.hpp"

// 继承 rclcpp::Node, 构造函数里用 Node("Node name") 初始化父类
class DemoNode : public rclcpp::Node
{
public:
  DemoNode() : Node("${node}")
  {
    // 打印Node name (只打印一次)
    RCLCPP_INFO(this->get_logger(), "%s", this->get_name());
  }
};

int main(int argc, char ** argv)
{
  // 1) 初始化 ROS 2
  rclcpp::init(argc, argv);
  // 2) 创建节点实例 (构造时即注册节点并打印)
  auto node = std::make_shared<DemoNode>();
  // 3) 释放资源
  rclcpp::shutdown();
  return 0;
}
`;
}
