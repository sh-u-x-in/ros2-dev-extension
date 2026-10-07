# ROS2.run 与 ROS2.launch 执行机制研究

> 状态：研究结论（2026-09-01）
> 目的：弄清本扩展「运行 ROS 可执行文件 / 启动 ROS 启动文件」从命令触发到进程执行的全链路，为一键启动（新功能 03）的设计提供依据
> 方法：读源码（registry/ros-cli → commands/ros_task_runner → host/tasks → environment）+ 对照外部调研（gen/外部调研-ROS2路径映射与intellisense-参考，roa2_ws 目录树与 console_scripts 机制链）

---

## 0. 结论先行

- **命令 → 交互编排 → 任务终端**：`ROS2.run` / `ROS2.launch` 命令经 QuickPick 选包/选可执行/输参数后，由 `RosTaskRunner` 构造 `vscode.Task + ShellExecution` 执行，**env 实时注入内存 source 结果（environmentFacade.getEnv()），任务终端无需再 source**。
- **当前实现已标 @deprecated 待重设计**（2026-08-31）：ros2 run / ros2 launch 保留仅因 registry/ros-cli.ts 仍调用；重设计（对应新功能 03 一键启动）将以此为壳。
- **查询类命令走另一通道**：选包/选可执行依赖 `ros2 pkg list / prefix / executables`（commandRunner.exec 非交互执行，30s 超时 + UTF-8/GBK 解码）——**工作区包可被 executable-map 静态数据替代**（见第 6 节）。

---

## 1. 命令入口与注册

| 项 | 位置 | 说明 |
|---|---|---|
| 命令 ID | `src/ros2/host/commands.ts` | `RunCommand = "ROS2.run"`、`LaunchCommand = "ROS2.launch"`（上游遗留，注释标 deprecated） |
| 命令面板标题 | `package.json` contributes.commands | "运行 ROS 可执行文件 (ros2 run)" / "运行 ROS 启动文件 (ros2 launch)" |
| 注册 | `src/ros2/registry/core.ts` `registerCoreCommands()` | `registerCommand(RunCommand, () => ros_cli.rosrun(context))`；统一包 `ensureErrorMessageOnException`（异常弹窗） |

---

## 2. 交互编排层（registry/ros-cli.ts）

自上游 ms-iot/vscode-ros 迁入，公共编排拆分、三命令各留薄入口：

### rosrun（ROS2.run）
```
selectPackage()          // QuickPick: ros2ServiceApi.pkg_list() → ros2 pkg list 每行一个包名
  → pkg_executables()    // QuickPick: ros2ServiceApi.pkg_executables(name) → ros2 pkg executables 每行"pkg exe"取第 2 列
  → inputArguments()     // showInputBox 输入额外参数,空格分词 toArgs()
  → rosTaskRunner.run({ pkg, executable, args })
```

### roslaunch（ROS2.launch）
```
selectPackage()                 // 同上
  → selectLaunchFile(pkg)       // pkg_prefix() → ros2 pkg prefix --share <name> 拿包 share 路径;
                                // findPackageFiles() 用 find -L <path> -type f -name *launch.py 找 launch 文件;QuickPick 选
  → inputArguments()            // 同 rosrun
  → rosTaskRunner.launch({ file: launchFilePath, args })
```

⚠️ 层级标注（2026-08-26 用户定稿）：包查询（pkg_list/pkg_prefix）与文件查找（findPackageFiles）按职责属于 **package-core / package-service 层**，不属于 ros2/ 域；暂放命令层，待 package 层重构时迁移——**这正是 executable-map 数据的用武之地（见第 6 节）**。

---

## 3. 执行层（RosTaskRunner → runShellTask）

### 3.1 纯函数：参数 → 命令行（ros_task_runner.ts，可纯单测）

| 函数 | 输出 | 单测 |
|---|---|---|
| `toRos2RunCommand({pkg, executable, args})` | `["run", pkg, executable, ...args]` | ✅ test/suite/ros-task-runner.test.ts |
| `toRos2LaunchCommand({file, args})` | `["launch", file, ...args]` | ✅ 同上 |

### 3.2 薄执行壳（run / launch）

```ts
await runShellTask(`ros2 run ${pkg} ${exe}`, "ros2", toRos2RunCommand(opts), {
    cwd: opts.cwd,
    env: getEnv(),      // ← 实时注入内存 source 结果,非快照
});
```

### 3.3 runShellTask（host/tasks.ts，VS Code 中转薄壳）

```ts
const task = new vscode.Task({type:"shell", command}, vscode.TaskScope.Workspace, name, "shell");
task.execution = new vscode.ShellExecution(command, args, { env, cwd });
return vscode.tasks.executeTask(task);   // VS Code 集成任务终端运行
```

- **env 来源**：`environmentFacade.getEnv()`（source 管线产物，含 AMENT_PREFIX_PATH / PYTHONPATH / CMAKE_PREFIX_PATH / ROS_DISTRO / ROS_VERSION / COLCON_PREFIX_PATH 等 57~59 个变量）→ 任务终端直接继承完整 ROS 环境，**无需再 source**；
- 对比：colcon_build 有环境门槛（getEnvIssue() 非 null → 弹窗提示不启动）；run/launch 因 deprecated 未加门槛。

---

## 4. 支撑设施（查询/终端/环境三条通道）

| 通道 | 实现 | 用途 |
|---|---|---|
| 非交互查询 | `commandRunner.exec()`（environment/command-runner.ts） | `ros2 pkg list/prefix/executables`、`ros2 interface list` 等；自动注入 env、30s 超时、UTF-8→GBK→宽松三级解码 |
| 任务终端 | `runShellTask()`（host/tasks.ts） | run/launch/colcon 构建执行，env 注入 getEnv() |
| 交互终端 | `terminal-profile.ts`（TerminalProfileProvider "ROS 2 环境"，id `rde-ros-2.ros-environment`） | 新建终端下拉框；跨平台注入（bash `--rcfile wrapper` / pwsh `-NoExit -File` / cmd `/k`）；顺序保证"用户启动文件先加载、再注入扩展 env" |
| 环境 source | environment/（source → state.setEnv） | 前序调查：系统层 /opt/ros/<distro>/setup.* + 工作区 overlay install/setup.*（见 gen/环境变量获取与数据来源路线-调查） |

---

## 5. 对照外部调研（roa2_ws 目录树与 console_scripts 机制链）

### 5.1 overlay 与目录树对应

外部调研目录树（install/ 含 setup.bash / local_setup.* / share / lib）正是扩展 source 的工作区 overlay 内容——`sourceWorkspaceOverlay()` 叠加 `<ws>/install/setup.*` 后，env 里出现 COLCON_PREFIX_PATH 与 install 前缀，任务终端执行 `ros2 run/launch` 即依赖这些前缀定位包与可执行。

### 5.2 ros2 run 的定位原理（对照 console_scripts 机制链）

```
setup.py entry_points 'sss = iii.sss:main'
  → build/iii/iii.egg-info/entry_points.txt
  → install/iii/lib/iii/sss（无 .py 后缀命令入口,shebang + EASY-INSTALL-ENTRY-SCRIPT）
  → ros2 run iii sss = 在 install/iii/lib/iii/ 下找到 sss 并执行(load_entry_point 动态加载 build/iii/iii/sss.py)✅ 实测跑通
```

- 即：**ros2 run 的执行目标 = 安装产物（install/<pkg>/lib/<pkg>/<cmd>），不是源码**；扩展的 executable-map 静态映射（consoleScript/cmakeTarget/exportExecutable）与该机制互补——前者补全/跳转用，后者是运行时事实。

---

## 6. 与 config 模块的关系（一键启动 03 的落点）

| 现有机制 | config 侧替代/增强 | 说明 |
|---|---|---|
| `pkg_executables()`（ros2 pkg executables，环境依赖、每次 exec） | `exe-map/executable-map.ts`（原 derive/executable-map.ts,2026-09-03 收敛）的 `PackageExecutables.executables`（工作区包静态映射） | 工作区包可不用 exec 查询，直接读内存映射；系统包仍留 `ros2 pkg executables` 接口出口（05 交接文档任务 7 原话） |
| `pkg_list()`（ros2 pkg list） | package-core 快照（PackageDataState） | 选包数据源可切到工作区快照 |
| `findPackageFiles()`（find -L 文件系统查找 launch.py） | exe-map/parse/setup-parser data_files + launch 安装项（一键配置 01 后 launch 必然在包内） | launch 文件枚举可静态化 |
| `rosTaskRunner.run/launch` 执行壳 | 一键启动 03 直接复用（构造 Task + ShellExecution + env 注入） | 03 只需在其上按文件类型分发 + 环境门槛 |

---

## 7. 现状标注与未来方向

1. **run/launch 已废弃待重设计**（2026-08-31 标注）：保留实现不改动；重设计 = 一键启动（03），落点在命令层 quick-run，复用 RosTaskRunner 壳 + executable-map 数据 + 环境门槛（getEnvIssue）；
2. **launch 树已删除/注释**（05 交接文档决策）：launch-parser.ts 整体注释（曾用 assets/scripts/ros2_launch_dumper.py python3 模拟运行——Windows 上 python3 假 exe 不可用）；launch 只保留"写文件"静态能力（include 跳转 + 结构补全），launch 一键启动底座重新评估（复用 ROS2.launch vs 重建）；
3. **查询通道可静态化**：ros-cli 的层级标注（查询属 package 层）与 executable-map 定位一致，重设计时把工作区包数据从 exec 切到内存映射，减少环境依赖与延迟。

---

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-02 00:05 | 建档：研究 ROS2.run/ROS2.launch 执行链路（registry/ros-cli 交互编排 → RosTaskRunner 纯函数+runShellTask 任务终端 → env 实时注入 getEnv()），对照 roa2_ws 外部调研（overlay 目录树 + console_scripts 机制链），标注 deprecated 现状与一键启动 03 的落点 |
| 2026-09-03 14:07 | 路径同步(derive/ + parse/ 2026-09-03 收敛为 exe-map/,parse 为子目录):§6 表 findPackageFiles 行引用改 exe-map/parse/setup-parser;正文其余 derive/… 引用同指 exe-map/ 同名文件 |