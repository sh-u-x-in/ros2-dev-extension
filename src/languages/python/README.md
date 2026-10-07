# src/languages/python/ — ROS 2 Python 节点代码片段(动态注入)

> 2026-09-07 建档:替代退役的静态 `snippets/python.json`(原按 python 语言全量注入,污染 `.launch.py` 与无关 `.py`)。
> 与 launch/xacro 同款处置:**先全量转制、后撤静态**;本模块只服务**普通 .py 文件里的 rclpy 节点骨架**,launch.py 的补全归 `../launch`。

## 1. 文件清单(2 TS + 1 MD)

| 文件 | 职责 |
|:--|:--|
| py-ros-snippets-core.ts | 纯核心(零 vscode):19 条 rclpy 片段目录(类模板/发布·订阅/定时器/服务/参数/日志/动作/QoS,body 自原 python.json 保真)+ rosPySnippetCandidates 前缀过滤 + isLaunchPyPath |
| py-ros-snippets.ts | vscode 适配:RosPyCompletionProvider(selector **/*.py,**排除 *.launch.py**、字符串内不触发、'.' 触发成员区)+ registerRosPythonCompletion |
| README.md | 本文件 |

## 2. 规则

- selector `**/*.py`,但 `isLaunchPyPath`(文件名以 `.launch.py` 结尾)一律跳过——launch 文件的补全由 languages/launch 的代码提供器负责;
- 代码位置打字触发(词前缀命中目录)/ `.` 触发列成员类片段后继续过滤;字符串字面量内不触发;
- **补全条目约定(2026-09-08)**:filterText = **结构头部主词 + keywords + label 英文词,纯 ASCII**(headTokens 取 body 开头去 import/from 引导后前 3 标识符,如 发布者 → `self publisher_ create_publisher`);snippet 项 documentation = 完整 body 代码块预览(detail 页展示结构);中文只留 label;
- 静态 `snippets/python.json` 已退役删除(package.json contributes.snippets 为空)。

## 3. 测试

test/suite/py-ros-snippets.test.ts(纯核心:目录 19 条 / 前缀过滤 / launch.py 判定 / filter 纯 ASCII,无头可跑)。

## 修改记录

> ⚠️ 约定:时间精确到分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-07 23:56 | 建档:python.json 19 条 rclpy 片段全量转制为动态注入(防 .launch.py 与无关 .py 污染,用户指定处理 py),静态注册与文件退役(package.json contributes.snippets 仅余 cpp.json);extension.ts 接线;test/suite/py-ros-snippets.test.ts 6 用例纯核心全绿 |
| 2026-09-08 00:00 | 门槛(用户口径:只闸 py/cpp):provider 施加 shared/ros-workspace-gate——非 ROS 工作区不弹 rclpy 片段;launch 三格式不加闸 |
| 2026-09-08 00:52 | UX 收敛(launch/py/cpp 三 core 统一):filterText 纯 ASCII 且**结构头部主词优先**(headTokens),detail 页 documentation = 完整 body 预览;label 维持中文(无同前缀重复);单测补 filter ASCII + 头词断言 |
