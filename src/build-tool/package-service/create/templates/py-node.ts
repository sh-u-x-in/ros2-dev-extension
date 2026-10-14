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
 *
 * 教学注释 L10N(2026-10-12):docstring 与注释均以稳定 ID 查 l10n/templates 表
 * (en 源 + 各语种),按 `lang` 出单语生成物,代码行逐字节不变。
 *
 * shebang 语义(2026-10-12,方案 B 用户裁定):`opts.directExec = true` ⇒ 保留
 * `#!/usr/bin/env python3`(文件被**直接执行**的场景:cpp-dual scripts/ 与 mixed 模块,
 * 二者经 install(PROGRAMS) 直装 lib/<pkg>/,Linux 内核靠 shebang 选解释器);
 * `false` ⇒ 不写 shebang(文件经 **console_scripts 入口点**执行的场景:ament_python 模块,
 * setuptools 生成的包装器自带 shebang,模块本身是被 import 的)。缺省 true(保守:
 * 未来新调用方忘传时,直装路径仍可执行)。
 */

import { getLogger } from "../../../../logger";
import { resolvePyNodeStrings } from "../../../../../l10n/templates/index";
import type { TemplateCommentLang } from "../../../../../l10n/templates/index";

/** 扩展日志薄封装(带 tmpl-py-node 模块前缀) */
const log = getLogger("tmpl-py-node");

/**
 * Python 最小示范节点源(继承 rclpy Node,构造时注册节点并打印Node name一次)。
 * @param pkg 包名(仅出现在模块 docstring)
 * @param node 运行时Node name(合法标识符或脚本场景的映射名)
 * @param lang 注释语种(缺省 en = 英语源)
 * @param opts.directExec 文件是否被直接执行(PROGRAMS 直装)= true 写 shebang;
 *        经 console_scripts 入口点执行 = false 不写(缺省 true)
 */
export function pyNodeSource(pkg: string, node: string, lang: TemplateCommentLang = "en", opts: { directExec?: boolean } = {}): string {
    log.trace(`展开 Python 节点源:${pkg}/${node}`);
    const T = resolvePyNodeStrings(lang, { pkg });
    const shebang = (opts.directExec ?? true) ? "#!/usr/bin/env python3\n" : "";
    return `${shebang}"""${T.moduleDocstring}"""

import rclpy
from rclpy.node import Node


${T.classInherit}
class DemoNode(Node):

    def __init__(self):
        super().__init__('${node}')
${T.printOnce}
        self.get_logger().info(self.get_name())


def main(args=None):
${T.initNote}
${T.flowNote}
    rclpy.init(args=args)
    node = DemoNode()   ${T.registerNote}
    node.destroy_node()  ${T.destroyNote}
    rclpy.shutdown()


if __name__ == '__main__':
    main()
`;
}
