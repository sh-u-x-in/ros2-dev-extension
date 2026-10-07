# ui/ — rosmsg 编辑器提供器

> 注册入口 + 各类 vscode.languages 提供器实现。域级总览与查询链见 `../README.md` §3.2(索引即权威,无 walk 兜底)。

## 文件(3 TS)

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `providers.ts` | 623 | 注册入口 `registerRosMessageProviders(context, xacroPackages)` + 4 类提供器(Hover/Definition/链接/格式化)+ 节流接线(onDidOpen/onDidClose)+ `findMessageDefinitions` 查询链(带包名正表二分 / 裸名反表点查+补登 / 系统登记命中即跳) |
| `completion-provider.ts` | 222 | 两段式类型补全("/" 触发:先包名后消息名;内置类型 + 工作区 + 系统) |
| `diagnostic-provider.ts` | 212 | 诊断:重复字段 / 未知类型 / 废弃类型(byte/char)/ 自包含递归(「消息不能直接或间接包含自身」) |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):三文件职责自根 README 与头注独立成档;R10 后共享 PackageMap 实例注入 |
