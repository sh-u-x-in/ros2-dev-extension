# src/languages/xacro/data/ — 静态文档数据

> xacro 的纯数据层(2026-09-07 目录化):零 vscode 运行逻辑、可单测的静态表。

## 文件

| 文件 | 职责 |
|:--|:--|
| urdf-docs.ts | URDF 元素/几何/材质/传感器文档表 + 关节类型表(jointTypes);findElementDoc/findJointType/elementDocMarkdown/jointTypeMarkdown 供 hover 与补全 |

## 依赖与接线

- 出边:仅 vscode 类型(MarkdownString 组装);无业务依赖;
- 入边:ui/hover-provider、ui/completion-provider;
- 测试:test/suite/urdf-docs.test.ts。

## 修改记录

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-07 22:30 | 目录化建档:urdf-docs.ts 自 src/languages/xacro/ 迁入(import 上移一级) |
