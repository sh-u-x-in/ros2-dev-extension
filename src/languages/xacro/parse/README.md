# src/languages/xacro/parse/ — 光标/结构解析

> xacro 的"解析纯层"(2026-09-07 目录化)。XML 底层解析统一在 languages/shared/xml-utils(@lezer/xml 封装),
> 本层只放"以 xacro 语义解释解析结果"的只读工具。
> 2026-09-24 XG1~XG4:新增 xacro 语法层四件套($ 词法/宏参数/表达式分词/文档模型+缓存),
> 设计见 设计/xacro/14,语法事实源见 设计/xacro/13。

## 文件

| 文件 | 职责 |
|:--|:--|
| context-locator.ts | getCursorContext:光标所在上下文(tagName / attrName / attrValue / comment / tag 内),供 hover 元素文档与 completion 决策;纯 lezer 只读;**XG6**:拆出 getCursorContextFromTree(tree,…) 核心——有缓存树时直接复用(XacroDocumentStore 接线) |
| xacro-lexer.ts | XG1 `$` 层词法器:官方 LEXER 四态 token(text/expr/extension/ss-escape)+ issue(未闭合/嵌套 $);纯函数 |
| macro-params.ts | XG2 宏 params 全语法解析(re_macro_arg 等价):标量/默认/^转发/^|回退/*块/**字典 + offset;纯函数 |
| expression-tokens.ts | XG3 `${}` 内 python-ish 分词:token 流 + refIdents 属性引用候选(白名单/点链/调用位排除);纯函数 |
| xacro-tags.ts | XG4 固定标签模型:10 标签分类/属性签名表/SUBST_COMMANDS/EVAL_GLOBALS 补全数据;XG7 起 EVAL_GLOBALS 求值条目扩充、XG10 起 $ 词法段扩展(与 lexer/tag 表联动) |
| xacro-document.ts | XG4 单遍文档模型 + 缓存:一次 lezer 遍历产出标签实例/符号(含宏参数)/$词法段;XacroDocumentStore 按 uri+version 键控 |

## 依赖与接线

- 出边:xacro-lexer/macro-params/expression-tokens/xacro-tags 无内部依赖(xacro-document 聚合四者 + ../../shared/xml-utils);context-locator → ../../shared/xml-utils;
- 入边:core/include-graph(XG5 起)、ui/hover-provider、ui/completion-provider;XG6 起五类 provider 共享 XacroDocumentStore。

## 修改记录

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-29 | 文档补登(XG5~XG13 对本层增量,细则见根 README XG 各行):context-locator 增 getCursorContextFromTree 树核心(XG6);xacro-tags EVAL_GLOBALS 扩充(XG7)与 $ 词法段扩展(XG10);五文件清单本身未变 |
| 2026-09-07 22:30 | 目录化建档:context-locator.ts 自 src/languages/xacro/ 迁入(import 上移一级) |
| 2026-09-24(XG1~XG4) | 新增 xacro-lexer/macro-params/expression-tokens/xacro-tags/xacro-document 五文件(语法层升级,批次 XG0~XG11) |
