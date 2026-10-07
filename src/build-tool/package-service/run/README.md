# package-service/run —— ros2 run / ros2 launch 灵活启动域(2026-09-25 新建)

`colcon build` 模板机制(`../share/`)的第二个使用者:**命令怎么拼整份交给设置,代码只做"选目标 + 弹参数 + 展开 + 执行"**。

## 定位

| | 内容 |
|---|---|
| 服务对象 | `ros2 run`(可执行)/ `ros2 launch`(启动文件) |
| 执行链 | `share-spec.ts` 按设置模板展开整条 argv → `composeApi.rosTaskRunner.run/launch` → `runShellTask`(VS Code 任务终端,含 overlay 的 `getEnv()`) |
| VS Code 命令 | `ROS2.run` / `ROS2.launch`(id 沿用上游遗留常量,单一事实源在 `ros2/host/commands.ts`) |
| 设置 | `ROS2.run.shareSpec` / `ROS2.launch.shareSpec`(对象,与 `build.shareSpec` 同 schema) |

## 文件表

| 文件 | 职责 |
|---|---|
| `index.ts` | 唯一对外出口(注册 / 数据源工厂 / 树入口 / 命令 id) |
| `command-ids.ts` | 命令 ID 转口(`ROS2.run`/`ROS2.launch` 不改 id,注册者换成 run 域) |
| `launch-detect.ts` | launch 文件识别 + 展示名(纯函数;侧边栏与数据源共用同一判定) |
| `run-data-source.ts` | `RunDataSource` 窄接口(仿 BuildDataSource 注入)+ `createInstallTruthRunDataSource()`(install-truth 共享数据中心) |
| `share-spec.ts` | 接线适配层:读设置 → 合并出厂默认 → 装填动态参数 → `expandCommand` 展开整条 argv |
| `smart-run.ts` | `ros2 run` 编排:面板(选包→选可执行)+ 树入口(目标已知);共用"参数弹窗→记忆→执行" |
| `smart-launch.ts` | `ros2 launch` 编排:面板(单级选文件)+ 树入口;同上 |
| `register-commands.ts` | 命令注册(`registerRosRunCommands(context, data)`) |

## 与 build 域的关键差异

1. **记忆按目标分槽**(用户裁定 2026-09-25):构建参数对包均匀,一个槽够用;运行参数因目标而异。
   `ros2.run::<pkg>/<exe>`、`ros2.launch::<源文件绝对路径>`(无源退化为安装路径)——
   不同包的同名 launch 不串记忆,记忆跟着文件走。
2. **每次都弹参数窗**:出厂模板只含 `${0}` ⇒ 弹窗形态 input-only(预填上次参数,Esc = 取消);
   用户往设置加预设后自动升级为"多选列表 + 自定义输入"(`presetPickPlan` 判定)。
3. **数据来源 = install 侧真相**(install-truth 共享数据中心,无需 ROS 环境):
   可执行 ← jumps;launch 文件 ← share 区行按 `launch-detect` 过滤。
   ⇒ 侧边栏看得见的 = 面板能选的 = 能运行的,三者同源。

## 依赖走向

```
run/ → share/(引擎 pick-preset / selection-memory / expand,零命令知识)
run/ → share/defaults/ros2-run|ros2-launch(出厂 spec + dynamics + 记忆键,纯函数)
run/ → install-truth(共享数据中心;文件系统扫描)
run/ → ros2/api(composeApi.rosTaskRunner:只收现成 argv)
```

边界:本域不认识 vscode Task(执行归 ros2/commands),不认识 install 目录细节(归 install-truth);
`ros2/` 不反向依赖本域(注册在 extension.ts 组装,命令 id 经 host/commands 单源)。

## 修改记录
| 2026-09-30 18:56 | 一键运行修复:run 键位 when 排除 .launch.*(消双命中);launchActiveEditor 加 basename 兜底匹配(无源行可用) |
| 2026-09-30 01:24 | 一键运行:RunDataSource 增 ownersOfSource/launchFileOfSource(源→安装侧目标);run/launch handler 接键位实参;smart-run/launch 增 ActiveEditor 入口(0 属主提示先构建) |

- 2026-09-29 补登 2026-09-28(批次3):设置键归位 `ROS2.ros2.run|launch.shareSpec` → `ROS2.run|launch.shareSpec`(share-spec.ts 常量与正文同步,记录行漏登,此处补)。
- 2026-09-25 新建:`ros2 run`/`ros2 launch` 重做落地(旧 `registry/ros-cli.ts` 编排与
  `ros_task_runner.ts` 的 deprecated run/launch 同批移除;执行层收成 argv-only + 环境门槛)。
