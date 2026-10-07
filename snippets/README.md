# snippets/ — 语言配置与 TextMate 语法(注意:不是代码片段!)

> **目录名是历史遗留**:package.json 的 `contributes.snippets` 为空——真正的 ROS 代码片段已转 TS 动态提供
> (`src/languages/cpp/cpp-ros-snippets-core.ts` 22 条 rclcpp、`src/languages/python/py-ros-snippets-core.ts` 19 条 rclpy,
> 2026-09-08 替代退役的静态 snippets/python.json / cpp.json)。**勿在此新增 snippet**。

## 清单

| 文件 | 实际角色 |
|:--|:--|
| `ROS2.json` | ROS Interface(rosmsg)语言的**语言配置**(contributes.languages[].configuration):括号/注释配对等 |
| `rosmsg.json` | rosmsg 的 **TextMate 语法**(contributes.grammars,scopeName `source.rosmsg`) |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):按 package.json 贡献点核对两文件真实角色,防"代码片段目录"误读 |
