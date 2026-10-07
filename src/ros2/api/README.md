# api/ — 接口定义唯一集中地

2026-08-25 起接口集中于此;消费者只从这里 import 接口类型,实现由组合根注入(`compose.ts`),不 import 实现。

## 规范(两条)

1. **只放接口类型 + 运行时出口**,不放实现;
2. **零 vscode 运行时依赖**(2026-08-26):所有 `import * as vscode` 均为 `import type`,类型擦除后不 require vscode,可纯 Node 单测。

## 接口清单

| 文件 | 接口/类型 | 说明 |
|---|---|---|
| `environment-facade.ts` | `EnvironmentFacade` | 环境域对外唯一接口(门面 `environment/index.ts` 实现) |
| `environment-state.ts` | `EnvironmentState` | 环境能力:读 env / 可用性 / 就绪门控 / 变化订阅 |
| `command-runner.ts` | `CommandRunner` / `ExecResult` / `CommandExecError` | 非交互命令执行原语(统一超时/编码/日志) |
| `ros2-service-api.ts` | `Ros2ServiceApi` / `PackageEntry` / `LifecycleState` | 命令域查询/状态(包/接口/参数/生命周期/colcon) |
| `ros-task-runner.ts` | `RosTaskRunner` / `ColconBuildOptions` / `Ros2RunOptions` / `Ros2LaunchOptions`(2026-09-25:run/launch 同为 argv-only)/ `ColconInstallType`(两轴 {method,layout}) / `ColconInstallMethod` / `ColconInstallLayout` 等 | A9 任务终端执行(colcon/run/launch/doctor/rosdep)。~~`run-orchestration.ts`~~ 占位接口已删除(2026-09-25,重做落地 run 域,无需占位) |
| `terminal-run.ts` | `TerminalRun` | 普通集成终端执行接口(2026-09-26:run/launch 执行层收 argv-only 后新增;compose 第 6 成员 `terminalRun`,实现 = commands/terminal-run.ts) |
| `monitor-api.ts` | `MonitorApi` + QueryResult/NodeInfo/TopicInfo/ServiceInfo/**ActionInfo**/ParamValue/**ParamTree**/**ParamTypedValue**/LifecycleGraph 等 | 状态页消费者对象契约(**13 个查询/操作**;2026-09-26 起 daemon XML-RPC/CLI 链路退役,数据源唯一 = 常驻助手) |
| `settings.ts` | `SettingsProvider` / `ExtensionSettings` / `WalkTimeoutOverride` | 设置读取(类型化 + 默认值 + 订阅;构建快照为**两轴** `symlinkInstall`/`installLayout`,键 2026-09-28 批次3 归位为 `ROS2.build.*`) |
| `ros-api-deps.ts` | `RosApiDeps` + `setRosApiDeps/getRosApiDeps` | 环境域用上层 UI 能力的注入边界 |
| ~~`ros-terminal.ts`~~ | — | **已删除**(2026-09-22:A7 交互终端废弃后长期只剩注释,按"开发期不留历史包袱"整体删除;活着的终端能力在 `consumers/terminal/ros-terminal.ts`) |
| ~~`activation-deps.ts`~~ | — | **已删除**(2026-09-29:接口成员 isROSBuildTask 随 onDidEndTask 链移除后长期整文件注释、零引用,物理删除;git 历史可查) |

## 运行时出口

`index.ts` 末尾 `export { composeApi } from "../compose"`:
- **组合根之外的消费者**(registry/commands 层/状态页/状态栏/side 边栏)从这里取实例;
- **组合根成员**(param-helper-client、ros2_service_api 等)不能 import 它(循环),改走 `setXxx()` 注入(见 `compose.ts`);`TerminalRun` 类型经 compose `import type` 直连本目录文件(不经 barrel)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 文档同步(补 09-25 后 8 个提交欠账):①删 `run-orchestration.ts` 清单行(与上表 09-25 删除注记自相矛盾的漏改);②补 `terminal-run.ts`(2026-09-26 第 6 组合成员);③monitor-api 12→13 成员 + ActionInfo/ParamTree/ParamTypedValue 类型 + 数据源唯一=常驻助手(09-26 daemon 退役);④settings 键名随批次3 归位注记(ROS2.build.*);⑤`activation-deps.ts` 墓碑物理删除(零引用清理,8afde4a 同口径);⑥运行时出口注记 monitor-cli→param-helper-client |
| 2026-08-28 12:52 | 创建 api/ README(接口清单/规范/composeApi 出口) |
| 2026-08-28 12:56 | 时间标注统一精确到时分;尾部新增修改记录便于溯源。正文引用的历史日期(2026-08-24 ~ 2026-08-26)为设计/代码注释标注日期,非文件操作时间 |
| 2026-08-30 23:16 | 环境门面外部直连迁移至统一出口:8 处消费者(debugger×4 / build-tool / mcp / test-provider / 命令域)改走 `composeApi.environment`(类型经 api/ 接口),environment/index.ts 外部直连清零,仅 extension.ts 组合根保留直连(装配 setActivationDeps/setRosApiDeps/refreshContextKeys 特权) |
| 2026-09-01 19:44 | Ros2ServiceApi 接口 9 个查询方法签名加 `| null`(失败 → null 契约,注释落错误策略);lifecycle_get 哨兵 {id:-1} 退役(未知状态/失败 → null);MonitorApi.param_get 同步 `Promise<string | null>` |
| 2026-09-16 02:41 | `ros-task-runner` 安装类型拆两轴:`ColconInstallType` 由三值枚举改为 `{method: symlink&#124;copy, layout: merged&#124;isolated}`,新增导出 `ColconInstallMethod`/`ColconInstallLayout`(index.ts 同步;拆轴总览见 commands/README 02:23 行) |
| 2026-10-06 | `Ros2ServiceApi.lifecycle_set` 签名 `{node, transition_id: number}` → `{node, transition: string}`(重设计阶段 2:转换走 CLI 标签通道,数字 id 版零真实调用方;拒绝=非零退出码,2026-10-06 VM 实机验证);MonitorApi 数据源注记:常驻助手 2026-10-06 起为共享服务端形态(单 socket 帧协议,见 consumers/monitor/helper/README.md) |
| 2026-09-22 | `settings.ts` 快照跟着拆轴:`colcon.build.installMode: "merge"&#124;"symlink"&#124;"isolated"`(把两轴压成三选一)与不存在的 `parallel`/`verbose` 删除,改为对齐 package.json 真实键的两轴 `symlinkInstall`(轴1)/`installLayout: "auto"&#124;ColconInstallLayout`(轴2,枚举类型自 ros-task-runner 复用);SettingsProvider 仍未实现,本次为契约修正(零运行时影响) |

