# registry/ — 命令注册层

扩展命令的**注册**统一入口(`commands/index.ts` 的 `registerAllCommands` 按领域分发到本目录各函数);注册的函数实现分散在命令层/消费者/调试器。命令 ID 一律取 `host/commands.ts` 常量(单一事实源)。

## 文件清单

| 文件 | 注册内容 | 说明 |
|---|---|---|
| `core.ts` | `registerCoreCommands`:ShowDaemonStatus / Rosdep / Doctor | daemon 状态页 + rosdep/doctor 入口;Run/Launch 已迁往 build-tool/package-service/run 域(2026-09-25),Test 已删除(2026-09-24);StartDaemon/StopDaemon 已移除(2026-08-26) |
| `terminal.ts` | `registerTerminalCommands`:CreateTerminal | 终端命令(GetDebugSettings 已于 2026-09-22 随整套调试链路删除) |
| ~~`ros-cli.ts`~~ | — | **已删除(2026-09-25)**:rosrun/roslaunch 旧编排由 build-tool/package-service/run 域(smart-run/smart-launch + 模板机制)取代 |
| ~~`lifecycle.ts`~~ | — | **已删除**(2026-08-26 起整文件注释墓碑,生命周期命令早已停止暴露;2026-09-29 零引用清理物理删除,git 历史可查) |

## 模式

- 注册命令 handler 内经 `composeApi`(api/ 出口)取实例,或直接调 consumers UI 入口(如 `launchMonitor`、`createRosTerminal`);
- `ensureErrorMessageOnException`(extension.ts)包裹 handler,统一错误弹窗;
- 命令面板可见性由 `package.json contributes.commands` 控制;未在面板暴露的内部命令仅注册可 executeCommand 调用。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 文档同步:terminal.ts 行删 GetDebugSettings(2026-09-22 随调试链路删除,当时漏改);lifecycle.ts 行改「已删除」(墓碑于 2026-09-29 零引用清理物理删除) |
| 2026-08-28 12:52 | 创建 registry/ README(命令注册层/文件清单) |
| 2026-08-28 12:56 | 时间标注统一精确到时分;尾部新增修改记录便于溯源。正文引用的历史日期(2026-08-24 ~ 2026-08-26)为设计/代码注释标注日期,非文件操作时间 |
| 2026-09-01 19:44 | ros-cli.ts 适配 null 契约:pkg_list / pkg_executables 结果 ?? [] 再入 QuickPick(失败 → 空列表);清理死代码 basenames 局部函数 |
| 2026-09-25 | **Run/Launch 注册与旧编排移除**:`core.ts` 摘除 RunCommand/LaunchCommand 注册(迁往 run 域 `registerRosRunCommands`,extension.ts 装配);`ros-cli.ts` 整文件删除(rosrun/roslaunch/公共编排)——run/launch 重做落地 build-tool/package-service/run(模板 + 按目标分槽记忆 + 侧边栏 ▶) |

