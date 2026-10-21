# package-service/run —— ros2 run / ros2 launch 灵活启动域(2026-09-25 新建)

`colcon build` 模板机制(`../share/`)的第二个使用者:**命令怎么拼整份交给设置,代码只做"选目标 + 弹参数 + 展开 + 执行"**。

## 定位

| | 内容 |
|---|---|
| 2026-10-18 | **入口环境早退+统一围栏(P1+P5)**:smart-run/smart-launch 各三入口(面板/Ctrl+F10/侧边栏▶)增 refuseIfNoEnvAtEntry——门关一句拒绝,不进选择/记忆写盘链(修双弹窗:终点被拒 return 不抛后 notifyStaleIfNeeded 仍无条件执行的陈旧警告);run/register-commands 两命令换 registerGatedCommand;launchActiveEditor 补 data 判空(旧 null 时 TypeError 靠注册层兜底);测试=run-launch-entry-gate 套件 6 例(拒绝/陈旧透传/零取数/记忆零写盘/门开放行) |
| 服务对象 | `ros2 run`(可执行)/ `ros2 launch`(启动文件) |
| 执行链 | `share-spec.ts` 按设置模板展开整条 argv → `composeApi.rosTaskRunner.run/launch` → `runShellTask`(VS Code 任务终端,含 overlay 的 `getEnv()`) |
| VS Code 命令 | `ROS2.run` / `ROS2.launch`(id 沿用上游遗留常量,单一事实源在 `ros2/host/commands.ts`) |
| 设置 | `ROS2.run.template` + `ROS2.run.presets` / `ROS2.launch.template` + `ROS2.launch.presets`(2026-10-17 两拆分;文法见 `share/presets-table.ts`) |

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
| 2026-10-18 | **键族迁 tool 层(用户裁定:呈现 = ROS2 › Tool › Run/Launch)**:share-spec 四常量改 `tool.run.template`/`tool.run.presets`/`tool.launch.template`/`tool.launch.presets`;run-data-source `RUN_STALE_WARNING_SETTING` 改 `tool.run.staleWarning`(读:181/写回:234 均经常量,零散改);smart-run/smart-launch 空 argv 错误文案键名同步;出厂 spec/展开引擎零改动 |
| 2026-10-17 | **模板设置两拆分**:share-spec.ts 改读 `ROS2.run.template`+`ROS2.run.presets` / `ROS2.launch.template`+`ROS2.launch.presets`(常量 `ROS_RUN_SETTING`/`ROS_LAUNCH_SETTING` → 四个新常量,私有 readSpec 共用);设置表行同步;详见 share/README.md 修改记录 2026-10-17 行 |
| 2026-10-17 | **真多实例·终版(同日上一行唯一名方案作废,源码级实证)**:用户实测 #2 从未作为独立进程启动——workbench 源码逐行取证(1.133 dev 宿主 bundle):①任务闸门按 `task.getKey()` 分组活实例(`_getInstances`),**名字与 definition 自定义字段都不参与身份** → 唯一名方案被同组吞掉,#2 落入限额分支;②限额判定 `instances.length < (task.runOptions.instanceLimit ?? 1)` —— **instanceLimit 缺省 1**,第二份必命中 → 返回旧实例(kind:2/same:true,新执行被丢弃,只弹不跑)+ 按 `task.runOptions.instancePolicy`(内部字段,缺省 **"prompt"**)弹"选择要终止的实例" → 被改写为"终止旧的、重跑一份"。正解 = 任务携带**原生 runOptions**:`{ instancePolicy: "silent", instanceLimit: 8 }`(常量 RUN_INSTANCE_LIMIT)—— silent 分诊 `case "silent": break` 不弹窗不终止、限额内真执行新实例(新终端,mapKey `_id|instance`,终端层原生同任务多实例);扩展侧 runOptions 序列化原样透传已核(公开 d.ts 仅 reevaluateOnRerun,后两字段为内部读取故类型 cast);策略值需小写精确匹配源码 case。**#N 前缀原生不可行,放弃(用户裁定)**——同名才同组,唯一名即死路。回滚:nextRunInstanceName/definition.instance/测试 7 例全删;ros_task_runner 改传 taskRunOptions、host/tasks.ts 增 taskRunOptions 透传(类型 cast)。ros-task-runner.test 回退 10→3 例,junit 真实 testcase 1361→1354、0 失败 |
| 2026-10-17 | **run/launch 真多实例(用户裁定方法二/序号前置,"launch 多运行也做")**:根因 = 任务名恒为 `Run <pkg>.<executable>`(与参数无关)→ VS Code 对同名任务 = 终端重用 + **终止旧进程**,同一可执行第二次运行顶替第一次,起不了两个;代码层零查重(全链路已核)。解除 = 任务身份唯一化:①新增纯函数 `nextRunInstanceName(base, liveTaskNames)`——活任务名过滤 `vscode.tasks.taskExecutions`(base 精确名或 `#N base`),序号取**活集合最大 N+1 而非 count+1**(活 [#2,#3] → 新 #4;count+1 会撞回 #2/#3 重新触发顶替);首实例不带号,第二份起 `#N ` **前置**(`#2 Run py01_topic.demo07…`,用户裁定格式);②`executeRunArgv` 接线(run/launch 共用底座,launch 一并生效);③`host/tasks.ts` `RunShellTaskOptions.instance` → 任务 definition 携带(**定义级唯一双保险**——即使宿主身份只看定义不看名也各开终端;colcon_build/doctor/rosdep 不传零影响)。既有消费方核查:`onDidStartTask` 零消费方(09-30 构建事件化后退役,注释残留)、task.name 唯一另一消费方 = colcon-task-provider(build 侧名字空间不交叉)→ 编号名零破坏;build 不参与(并发构建有害,超出点名范围)。ros-task-runner.test +7 例(首实例无号/#2/#3/max+1 性质钉/首实例死后不撞/它目标不串/launch 同构),junit 真实 testcase 1354→1361、0 失败 |
| 2026-10-16 | **陈旧警告误报根治(用户实测"每次都弹且安装时间戳逐秒不变",实机破案)**:真因 = ament_python 无安装清单(install_manifest/symlink_install_manifest/install.log 三记录全无)→ 跳转表 installPath 空 → 富集兜底 `installPaths[0]` 字母序恒为 devDir(`build/<pkg>` **目录**;它是 devModuleFile 的路径前缀且 "build"<"install"),statSync 比对的是**目录 mtime** —— 目录时间只随直接子项增删变化 = 冻结在建包时刻(实机 `build/py01_topic` = 2026-10-12 17:47:36.228 与警告逐秒吻合),内部文件天天重建也不动 → 每个 ament_python 可执行每次运行必弹、时间戳永不变化;ament_cmake 有清单(scriptPath 实证)不受影响,故仅 python 犯病。修复 = 消费端双门(truth 层 devDir/installPaths 原样保留 —— byInstallPath 路径反查索引仍需要):①新增纯函数 `staleInstallTargetOf`:`pythonInstall.verified !== true`(develop/符号安装,egg-link 直通 src 改了即生效,比对无意义,与 srcLinkNote 三档文案同语义)→ undefined 不给比对目标,cpp/copy 安装 python 维持原口径;②`notifyStaleIfNeeded` **isFile 门**:statSync 非文件的落点一律不警(防再犯不变量)。行为变化:符号安装 python 不再弹陈旧警告(语义上永不陈旧);跳过时 log.debug 留痕(diag-first);波及面仅陈旧路径(lookup 另两消费方只用 srcPaths/buildPath,已核;侧边栏 ▶ 不传 stale 参数);l10n 册 +1 键(跳过日志);run-readiness.test +7 例(落点选择 5 含 devDir 拒绝性质钉/isFile 门目录绊线/正路径恰弹一次+冷却,正路径对共享 stub 补 showWarningMessage 捕获并 after 还原),junit 真实 testcase 元素 1330→1337、0 失败 |
| 2026-10-14 | **陈旧警告面改版:状态栏 → 非模态警告气泡 + 「不再显示」按钮(用户裁定,推翻 10-13 选型)**:用户实机观察到非模态气泡不点按钮也会宿主自动收起(实测约 12 秒、不积累),原"带按钮 toast 会钉住"顾虑不成立;`notifyStaleIfNeeded` 展示面 `setStatusBarMessage(msg,4000)` → `showWarningMessage(msg, STALE_MUTE_LABEL)`(void 发射不阻塞,判定链/冷却/触发链零改动);按钮 = 写 `ROS2.run.staleWarning=false` 永久静默(有工作区写工作区层否则用户层,照 preflight setPreflightMode 先例;`STALE_MUTE_LABEL` 常量同源 t() 照 PREFLIGHT_MUTE_LABEL 先例);`STALE_STATUSBAR_TIMEOUT_MS` 常量废除(测试断言同步删)+ `STALE_MUTE_LABEL` 非空断言;nls×2/docs×2"状态栏 4 秒"措辞同步;l10n 册 +3 键(Don't show again/写失败/写回日志;workspace/user 键既有复用) |
| 2026-10-13 18:49 | **陈旧附加警告(用户裁定「附加不阻碍/状态栏 4 秒/30 秒冷却」)**:源比安装产物新时,Ctrl+F10 运行/启动**照常执行** + 状态栏 4 秒提醒(本次运行可能不含最新修改)——警告是最后闸门的纯附言,潜台词"可以运行";①RunTarget 富集 installPath/srcPath(ownersOfSource 内 lookup 走 O(1) 缓存索引);②判定/冷却收纯函数 isStale(双存在且源严格更新;symlink 穿透等时零误报;源缺失不警)/shouldNotifyStale(30s 窗口);③非阻塞面 = setStatusBarMessage 4s(带按钮 toast 会钉住、无按钮时长不可控,均不满足固定消退);④设置键 ROS2.run.staleWarning(默认开,刻意测试旧安装可关;package.json/nls×2/docs×2 同步);⑤splitOwnerReadiness 泛型化透传属主额外字段;30s 同目标冷却(会话级);run-readiness.test +4 例(isStale/冷却/键名锁/静默路径),1345 用例 0 失败 |
| 2026-10-13 09:40 | **一键运行安装侧就绪预检(方案甲,用户裁定)**:根因 = 跳转表全部来自 build 侧(有编译无安装也放行,侧边栏 = install 侧观察却不显示,两套证据矛盾,用户实测确认);ownersOfSource 接口改分层结果 `{runnable, compiledNotInstalled}`,就绪口径 = 侧边栏同一行(lib 区 installed 可执行行命中,三种未就绪子 case 全落坑:无安装规则/missing/非可执行);中心未就绪(null)保守全部放行(判不了不拦);smart-run 双警告:①0 属主=未编译(既有)②属主全未就绪=已编译未安装(新警告,进 l10n 册 +1 键);就绪拆分为纯函数 splitOwnerReadiness 可无头测试(新增 run-readiness.test.ts 6 例);resolver/侧边栏零改动 |
| 2026-09-30 18:56 | 一键运行修复:run 键位 when 排除 .launch.*(消双命中);launchActiveEditor 加 basename 兜底匹配(无源行可用) |
| 2026-09-30 01:24 | 一键运行:RunDataSource 增 ownersOfSource/launchFileOfSource(源→安装侧目标);run/launch handler 接键位实参;smart-run/launch 增 ActiveEditor 入口(0 属主提示先构建) |

- 2026-09-29 补登 2026-09-28(批次3):设置键归位 `ROS2.ros2.run|launch.shareSpec` → `ROS2.run|launch.shareSpec`(share-spec.ts 常量与正文同步,记录行漏登,此处补)。
- 2026-09-25 新建:`ros2 run`/`ros2 launch` 重做落地(旧 `registry/ros-cli.ts` 编排与
  `ros_task_runner.ts` 的 deprecated run/launch 同批移除;执行层收成 argv-only + 环境门槛)。
