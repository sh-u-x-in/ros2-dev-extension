# src/languages/cpp/ — ROS 2 C++ 节点代码片段(动态注入)

> 2026-09-07 建档:替代退役的静态 `snippets/cpp.json`(原按 cpp 语言全量注入,污染非 ROS 项目)。
> 与 python 模块同批:**全量转制 + ROS 工作区门槛**;静态 `snippets/cpp.json` 已退役删除(package.json contributes.snippets 现为空)。

## 1. 文件清单(2 TS + 1 MD)

| 文件 | 职责 |
|:--|:--|
| cpp-ros-snippets-core.ts | 纯核心(零 vscode):22 条 rclcpp 片段目录(类模板/组件节点/发布·订阅/定时器/服务/参数/日志/QoS/动作/注册宏,body 自原 cpp.json 保真)+ rosCppSnippetCandidates 前缀过滤 |
| cpp-ros-snippets.ts | vscode 适配:RosCppCompletionProvider(selector .cpp/.cxx/.cc/.hpp/.hh/.h)+ registerRosCppCompletion |
| README.md | 本文件 |

## 2. 规则

- **ROS 工作区门槛(shared/ros-workspace-gate)**:`package-core` workspace 域非空才提供;非 ROS 项目(.cpp 普通代码)不弹 rclcpp 片段;
- 词前缀命中目录;字符串与行注释内不触发;
- **补全条目约定(2026-09-08)**:filterText = **结构头部主词 + keywords + label 英文词,纯 ASCII**(headTokens 取 body 开头去 #include/using 引导后前 3 标识符);snippet 项 documentation = 完整 body 代码块预览(detail 页展示结构);中文只留 label。

## 3. 门槛(与 launch 的关系)

只闸 py/cpp 代码片段;launch 三格式不加工作区闸(launch 文件天然只存在于 launch 文件,不污染普通文件)。
env 不做门槛(工作区源码编辑不依赖 env,见 languages/README 依赖约定)。

## 修改记录

> ⚠️ 约定:时间精确到分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-08 00:00 | 建档:cpp.json 22 条 rclcpp 片段全量转制为动态注入 + ROS 工作区门槛(shared/ros-workspace-gate,非 ROS 项目不弹),静态注册与文件退役(package.json contributes.snippets 现为空);extension.ts 接线;test/suite/cpp-ros-snippets.test.ts 4 用例纯核心全绿 |
| 2026-09-08 00:52 | UX 收敛(launch/py/cpp 三 core 统一):filterText 纯 ASCII 且**结构头部主词优先**(headTokens,去 #include/using 引导),detail 页 documentation = 完整 body 预览;单测补 filter ASCII + 头词断言 |
