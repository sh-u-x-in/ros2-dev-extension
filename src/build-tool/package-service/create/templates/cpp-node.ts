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
 *
 * 教学注释 L10N(2026-10-12):注释以稳定 ID 查 l10n/templates 表(en 源 + 各语种),
 * 按 `lang` 出单语生成物;缺省 "en" 时与历史中文版的注释行语种不同(本文件生成注释
 * 2026-10-12 起源语言为英文),代码行逐字节不变。
 */

import { getLogger } from "../../../../logger";
import { resolveCppNodeStrings } from "../../../../../l10n/templates/index";
import type { TemplateCommentLang } from "../../../../../l10n/templates/index";

/** 扩展日志薄封装(带 tmpl-cpp-node 模块前缀) */
const log = getLogger("tmpl-cpp-node");

/**
 * C++ 最小示范节点源(继承 rclcpp::Node,构造时注册节点并打印Node name一次)。
 * @param pkg 包名(仅出现在文件注释)
 * @param node 运行时Node name / CMake target 名(合法标识符, 由映射顺延得到)
 */
export function cppNodeSource(pkg: string, node: string, lang: TemplateCommentLang = "en"): string {
    log.trace(`展开 C++ 节点源:${pkg}/${node}`);
    const T = resolveCppNodeStrings(lang, { pkg });
    return `// ${T.fileHeader}
#include <memory>

#include "rclcpp/rclcpp.hpp"

${T.classInherit}
class DemoNode : public rclcpp::Node
{
public:
  DemoNode() : Node("${node}")
  {
${T.printOnce}
    RCLCPP_INFO(this->get_logger(), "%s", this->get_name());
  }
};

int main(int argc, char ** argv)
{
${T.stepInit}
  rclcpp::init(argc, argv);
${T.stepCreate}
  auto node = std::make_shared<DemoNode>();
${T.stepShutdown}
  rclcpp::shutdown();
  return 0;
}
`;
}
