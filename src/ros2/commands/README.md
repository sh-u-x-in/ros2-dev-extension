# commands/ — 命令域接口实现

命令域**接口实现**(非注册;注册在 `registry/`)。实现经 `compose.ts` 装配为 `composeApi` 的成员。

## 文件清单

| 文件 | 实现 | 说明 |
|---|---|---|
| `ros2_service_api.ts` | `Ros2ServiceApi` | 查询/状态类:包/接口/参数/生命周期/colcon list。全部经注入的 `CommandRunner` 执行 ros2 CLI(2026-08-26 起组合根注入 `setCommandRunner`,不再静态 import environment);查询类容错降级,操作类(`lifecycle_set`)失败上抛 |
| `ros_task_runner.ts` | `RosTaskRunner` | A9 任务终端执行:纯函数(参数→命令行,零 vscode 依赖可单测)+ 薄壳经 `host/tasks.runShellTask` 构造 VS Code Task 执行;colcon_build / run / launch / doctor / rosdep。**2026-08-31 起 colcon_build 为扩展构建唯一执行入口**(链路收敛 A,消费方 = package-service/build 的智能构建与右键单包);**colcon_build 带 #12 环境门槛**(isAvailable 不满足 → UI 提示不启动终端),doctor 豁免;run/launch **2026-09-25 起与 colcon_build 同款 argv-only 模式**(调用方 run 域按模板展开,本层补 #12 门槛) |
| `terminal-run.ts` | `TerminalRun` | **普通集成终端执行接口**(2026-09-26/27:run/launch 改走普通集成终端而非任务终端的实现体;compose 第 6 成员 `terminalRun`;支持 `shellPath`/`shellArgs` 定制,供 bash `--rcfile` 启动前注入 history -s) |
| ~~`lifecycle.ts`~~ | — | **已删除**(2026-08-26 起整文件注释墓碑,功能去向 monitorApi;2026-09-29 零引用清理物理删除,git 历史可查) |
| `params.ts` | — | **⚠️ 废弃注释**(2026-08-26):旧参数实现整体注释,功能去向 monitorApi |

## 与 Ros2ServiceApi 分工

- **查询/状态** → `Ros2ServiceApi`(`ros2_service_api.ts`);
- **执行类** → `RosTaskRunner`(`ros_task_runner.ts`)一处,不重复。

## 依赖模式(2026-08-26)

两个实现对象都是 compose 成员,不能 import `composeApi`(循环),统一**声明式依赖**:
`import type { CommandRunner } from api` + 模块内 `let commandRunner` + `setCommandRunner()` 注入点;
`compose.ts` 装配时注入真实 `commandRunner`。未注入时兜底抛错提示装配遗漏。

## colcon build 链路收敛(2026-08-31,方案 A)

2026-08-31 起 `colcon_build` 成为**扩展构建的唯一执行入口**;2026-09-22 起它**不再拼装任何命令**:

- **命令构造已移出本域(2026-09-22)**:原纯函数 `toColconBuildCommand` **已删除**。扩展自己的 colcon 命令由
  build 域的模板引擎(`build/share-spec.ts` 读设置 `ROS2.build.shareSpec`)展开成**整条 argv** 后传进来;
  `ColconBuildOptions.argv` **必填**,本文件只 `command = argv[0]` / `args = argv.slice(1)`(命令名本身也可被用户改),
  空 argv ⇒ 报错不启动终端。`test/suite/ros-task-runner.test.ts` 随之删掉对应用例;
- **消费方**:package-service/build 的智能构建(smart-build.ts)、右键单包构建(register-commands.ts)统一经
  `composeApi.rosTaskRunner.colcon_build`;任务为 shell 类型(经 runShellTask),`ColconProvider` 收窄为 tasks.json
  自定义 colcon 任务的 resolver(逻辑内联至 colcon-task-provider.ts,原 ros-shell.ts 已删除);
- **install_type 两域分工(仅服务于测试链路)**:build/ `resolveInstallType()` 只做政策(平台 + `symlinkInstall`/`installLayout`
  → 两轴组合 {method,layout}),本文件 `toInstallTypeFlags` 只做翻译(组合 → `--symlink-install`/`--merge-install` 数组)。
  ⚠️ 扩展构建**不再走这条**:两轴由模板里的 `${install_method}` / `${install_layout}` 承载(值仍来自同一设置)。
- **#12 环境门槛(2026-08-31)**:`colcon_build` / `rosdep` 执行前检查 `environmentState.getEnvIssue()`(2026-08-31 由 isAvailable 重设计,返回不可用原因 string|null,可直接拼进提示)——唯一判定(涵盖未 source/source 失败/环境非 ROS2 四情形,见 environment/README.md「source 机制与 getEnvIssue 判定」);不满足 → showErrorMessage 明确提示(附原因),不启动注定失败的终端;doctor 豁免;
- **run / launch 重做完成(2026-09-25)**:收成 `Ros2RunOptions` / `Ros2LaunchOptions` 的 argv-only 模式(对齐 colcon_build —— 调用方 `build-tool/package-service/run/share-spec.ts` 按设置 `ROS2.run|launch.shareSpec`(2026-09-28 批次3 自 `ROS2.ros2.run|launch.shareSpec` 归位)展开整条 argv,本层只执行),补齐 #12 环境门槛;`toRos2RunCommand`/`toRos2LaunchCommand` 已删除,旧编排 `registry/ros-cli.ts` 同批删除;消费方 = run 域的命令面板与侧边栏 ▶;**2026-09-26/27 执行层再细分**:任务终端(runShellTask)之外新增 `terminal-run.ts` 普通集成终端路径;
- 参考:设计/重构/package-service/build域结构整理调研-2026-08-31-0028.md §5(收敛记录)、§8(安装方式分工);src/ros2/environment/README.md(构建后刷新链,与构建执行解耦)。

### 两种任务机制(勿混淆,2026-08-31)

colcon 相关代码存在**两条互不替代的机制**:

| | 机制① 主动执行(接口) | 机制② 响应解析(provider 回调) |
|:--|:--|:--|
| 方向 | 扩展【主动】发起(我们调用接口) | VS Code【回调】我们(别人发起执行时) |
| 入口 | `composeApi.rosTaskRunner.colcon_build`(本域实现) | `package-service/build/colcon-task-provider.ts` ColconProvider.resolveTask |
| 任务类型 | `shell`(内置,无需 provider) | `colcon`(自定义,必须 provider 解析) |
| 服务对象 | 扩展自身构建(智能/右键单包/空构建) | tasks.json 自定义 colcon 任务 |
| 说明 | 接口替代了原 makeBuildTask/makeColconPackageTask | 返回 vscode.Task 是契约;类型检查是标准防御(与已删的 isROSBuildTask 无关:那是任务结束后的归属判定,这是执行前的类型过滤)。**自由度(2026-08-31 升级)**:ROS 环境恒注入(getEnv),options.cwd / options.env(叠加覆盖)/ options.shell 全放开 |

## 修改记录
| 2026-09-30 02:07 | 隐藏配置位置修复:contributes.commandPalette(顶级,被静默忽略)→ menus.commandPalette;新增 command-visibility 防回归锁三用例 |
| 2026-09-30 19:10 | 转义深修:wrapper 与 sendCommand 均加 set +H(关交互 history expansion,根因=!!/!@# 被 !event 吞);VM 全 ASCII 27/27 全 PASS(真 pty 对照实证根因) |
| 2026-09-30 01:51 | 命令层遗留治理:commandPalette 隐藏六上下文命令;删僵尸 updatePythonPath;showDaemonStatus 标题改状态页 |
| 2026-09-30 01:42 | tests.runAll 重定义:工作空间级运行(全部包节点逐包 colcon test),标题同步;旧叶子扇出废 |
| 2026-09-30 01:33 | doctor/rosdep 命令串设置化:RosTaskRunner 接口增可选 argv(设置切词下发),缺省回退内置 toXxxCommand |
| 2026-09-29 23:59 | runShellTask 任务定义改注册类型 ROS2(shell 内建类型遭定义校验误报「将忽略该任务」) |
| 2026-09-29 23:58 | 调用命令转义修复:wrapper 废 __rde_cmd+eval 双层解析,命令原样一行直接执行(history -s shQuote 存原文);VM 六组恶意值实测旧全 FAIL/新全 PASS;官方多版本解析核对一致 |
| 2026-09-29 | 文档同步:文件清单补 `terminal-run.ts`(2026-09-26/27 落地,普通集成终端执行接口);`lifecycle.ts` 行改「已删除」(2026-08-26 墓碑于 2026-09-29 零引用清理物理删除);run/launch 设置键名随批次3 归位注记 |
| 2026-09-28 22:16 | 任务终端名中文式压缩:编译(×N)/运行 pkg.exe/启动 file;source 改 ROS2(经 host/tasks.ts 薄壳) |

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-22(模板接线 + 去兼容包袱) | **colcon_build 只执行**、`toColconBuildCommand` **删除**:`ColconBuildOptions` 收成 `{ base_path, argv, packages? }`(`argv` **必填**,含命令名;`packages` 仅供任务名/日志)——扩展构建一律由 build 域模板引擎(`build/share-spec.ts`)展开后传入,本文件**不拼装、不兜底**;同时删掉 `ColconBuildType` 与 `build_type`/`parallel`/`verbose`/`clean` 这些只服务旧构造的字段。`toInstallTypeFlags` 保留(`test-provider/ros-test-runner.ts` 在用)。**开发期不留兼容层**:不提供"未给 argv 时回落内置构造"的旧路径 |
| 2026-09-22 | **colcon_build 改用构建专用 env**:`env` 由 `getEnv()`(快照,含本工作区自己的 `install/` overlay)改为环境域新增的 `getBuildEnv()`(= 快照**剔除本工作区自身条目**)——消除 `colcon-override-check` 的"自我覆盖"警告,并避免旧 install 参与 include/依赖解析;`ros2 run / launch / doctor / rosdep` 保持 `getEnv()`(需要 overlay)。**构建命令构造、环境门槛(getEnvIssue)与其余逻辑均未变**;实现与边界见 `../environment/README.md`「构建专用环境」节 |
| 2026-08-28 12:52 | 创建 commands/ README(接口实现/注入模式/废弃文件) |
| 2026-08-28 12:56 | 时间标注统一精确到时分;尾部新增修改记录便于溯源。正文引用的历史日期(2026-08-24 ~ 2026-08-26)为设计/代码注释标注日期,非文件操作时间 |
| 2026-08-31 11:34 | 链路收敛 A 状态同步:colcon_build 由零调用方变为扩展构建唯一执行入口(build-command/colcon-command 统一经 composeApi.rosTaskRunner.colcon_build);toColconBuildCommand 成为唯一命令构造;install_type 两域分工(build/ 枚举决策 + 本文件 toInstallTypeFlag 翻译);新增「colcon build 链路收敛」节 |
| 2026-08-31 11:53 | 补「两种任务机制」对比节(主动执行接口 vs 响应解析 provider,方向/入口/任务类型/服务对象/说明五维);colcon.ts 注释同步加强(文件头两机制说明 + provideTasks TODO 过期核实 + resolveTask 类型过滤与 isROSBuildTask 的区别) |
| 2026-08-31 12:17 | resolveTask 自由度升级记录:ROS 环境恒注入 + options.cwd/env/shell 全放开(colcon.ts RosTaskDefinition.options 新增),UI 映射文档 §3 同步 |
| 2026-08-31 21:02 | colcon_build 加 #12 环境门槛(isAvailable 唯一判定,不满足 → UI 提示不启动终端);doctor 豁免;run/launch 标注废弃待重新设计(保留实现不改动);文件清单/链路收敛节同步 |
| 2026-08-31 22:30 | isAvailable → getEnvIssue 全量改名同步;rosdep 补门槛(独立文案,依赖 ROS_DISTRO) |
| 2026-08-31 23:10 | 交叉引用同步 package-service/build 改名批次:build-command→smart-build、colcon-command→register-commands、colcon.ts→colcon-task-provider.ts(ros-shell.ts 已删除) |
| 2026-09-01 19:44 | ros2_service_api.ts 查询类 9 方法失败返回 null(取代折叠为 []/""),lifecycle_get 未知状态/失败 → null;lifecycle_set 保持失败 reject 上抛;文件头错误策略注释定稿 |
| 2026-09-02 15:54 | colcon_list 路径绝对化(同源修复,无活跃调用方):输出 path 统一 `path.resolve(base_path ?? process.cwd(), …)`——对齐 PackageEntry.dir 契约=工作区包绝对路径(与 package-core/scan/colcon-list.ts 同源缺陷一并修复) |
| 2026-09-16 02:23 | 安装两轴拆轴(政策定稿):`ColconInstallType` 三值枚举 → `{method: symlink|copy, layout: merged|isolated}`;`toInstallTypeFlag` → `toInstallTypeFlags`(数组;实体/分包=不加参数,删除不存在的 `--isolated-install`;Linux 上 symlinkInstall=false 由"实体+合并"改为"实体+分包");新增设置 `ROS2.colcon.build.installLayout`(auto/merged/isolated);设置描述/单测同步 |
| 2026-09-25 | **run/launch 重做(argv-only + 门槛)**:`run`/`launch` 签名改为 `Ros2RunOptions`/`Ros2LaunchOptions`(`argv` 必填整条含命令名;`pkg`/`executable`/`launch_file`/`cwd` 仅任务名/日志/执行目录),删除 `toRos2RunCommand`/`toRos2LaunchCommand`;执行底座补 #12 环境门槛 + 空 argv 拒绝 + 结构化任务名(`ROS 2 运行 pkg.exe` / `ROS 2 启动 pkg/file`),env 保持 `getEnv()`(运行需要 overlay);旧编排 ros-cli.ts 与孤儿接口 run-orchestration.ts 同批删除。命令内容来源 = `build-tool/package-service/run/`(模板机制) |

