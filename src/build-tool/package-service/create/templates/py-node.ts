// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file py-node.ts
 * Python 节点源文件模板【全库唯一来源】(create/templates,2026-09-04 结构重构建立)。
 *
 * 此前 Python 节点模板存在三处拷贝/近似拷贝:
 *   - create-cpp-package.pythonNodeTemplate (cpp-dual 脚本 + mixed 模块用);
 *   - create-python-package.nodeTemplate   (ament_python 模块用)。
 * 三者正文逐字节相同,差异只在文件落点(scripts/ vs <pkg>/)与是否经 console_scripts 注册,
 * 由各生成器的文件组装决定——本文件收敛为唯一实现。
 *
 * 扩展位(后续"Generated-package content upgrade"调整入口):
 *   - 节点模板正文唯一位于本文件;
 *   - 如需按用途(发布/订阅/服务)扩展节点形态,在本文件加导出函数。
 */

import { getLogger } from "../../../../logger";

/** 扩展日志薄封装(带 tmpl-py-node 模块前缀) */
const log = getLogger("tmpl-py-node");

/**
 * Python 最小示范节点源(继承 rclpy Node,构造时注册节点并打印Node name一次)。
 * @param pkg 包名(仅出现在模块 docstring)
 * @param node 运行时Node name(合法标识符或脚本场景的映射名)
 */
export function pyNodeSource(pkg: string, node: string): string {
    log.trace(`展开 Python 节点源:${pkg}/${node}`);
    return `#!/usr/bin/env python3
"""${pkg} minimal demo node: subclasses an rclpy Node, registers it and prints the node name (once)."""

import rclpy
from rclpy.node import Node


# 继承 rclpy.node.Node, 构造函数里 super().__init__('Node name')
class DemoNode(Node):

    def __init__(self):
        super().__init__('${node}')
        # 打印Node name (只打印一次)
        self.get_logger().info(self.get_name())


def main(args=None):
    # rclpy.init() 返回 None, 不能当 with 上下文管理器用;
    # 标准流程 = 初始化 → 建节点 → 用毕显式释放 → 关闭 rclpy
    rclpy.init(args=args)
    node = DemoNode()   # 构造时即注册节点并打印
    node.destroy_node()  # 释放节点 (示范代码不 spin, 用完即退)
    rclpy.shutdown()


if __name__ == '__main__':
    main()
`;
}
