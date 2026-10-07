# ros2/ — ROS 2 核心域

扩展的 ROS 2 功能核心域(独立于 `build-tool/`、`test-provider/`、`languages/` 等旁系域)。
2026-08-24 起由 `src/ros/` 迁入并持续重构:接口集中 `api/`、实例经组合根 `compose.ts` 注入、命令 ID 单一事实源 `host/commands.ts`。

## 分层结构(依赖方向自上而下,禁止反向)

| 层/文件 | 职责 | 依赖 |
|---|---|---|
| `registry/` | 命令注册层(registerAllCommands 分发) | api(类型)+ composeApi + consumers UI 入口 + host(命令 ID) |
| `consumers/` | UI 消费者(状态页 webview / 终端 / 状态栏) | api + composeApi + host + environment(仅经门面) |
| `commands/` | 命令域接口实现(查询/状态 + 任务终端) | api(类型)+ host + 注入(commandRunner) |
| `environment/` | 环境域(source / 激活 / 监听 / 判定) | host 薄壳 + api(类型)+ 注入(RosApiDeps) |
| `host/` | VS Code 中转壳(薄适配,零业务逻辑,可整层 mock) | vscode |
| `api/` | 接口定义唯一集中地 + composeApi 运行时出口 | 仅类型依赖(import type) |
| `compose.ts` | 组合根:各域实例唯一出口,装配注入 | 各实现模块(单向) |

## 核心模式(两条铁律)

### ① 接口集中 api/,实例经 composeApi
`api/index.ts` 是接口类型唯一集中地;**外部消费者一律 `import { composeApi } from "…/api"` 取实例**,不直接 import 实现文件。
`composeApi` 定义在 `compose.ts`(组合根),聚合:
`environment`(EnvironmentFacade)/ `ros2ServiceApi`(Ros2ServiceApi)/ `rosTaskRunner`(RosTaskRunner)/ `commandRunner`(CommandRunner)/ `monitorApi`(MonitorApi)/ `terminalRun`(TerminalRun,2026-09-26 增,普通集成终端执行)。

### ② 组合根成员声明式依赖(注入,不反向 import composeApi)
`compose.ts` 依赖的成员(如 `consumers/monitor/param-helper-client`、`commands/ros2_service_api`)若再 import `composeApi` 会构成循环,因此成员采用**注入模式**:
- 只 `import type` api/ 接口类型(如 `CommandRunner`),模块内持有 `let` 变量 + `setXxx()` 注入点;
- `compose.ts` 装配时调用 `setRos2ServiceApi(...)` / `setCommandRunner(...)` 注入实现;
- 未注入时兜底抛错/空值,提示装配遗漏。

## 其他约定

- **命令 ID 单一事实源**:`host/commands.ts` 定义 `ROS2.*` 常量,consumers/registry 一律从这里取,不硬编码(2026-08-26 收口)。
- **废弃文件整体注释保留**(如 `commands/params.ts`):不再参与编译,头部 `⚠️ DEPRECATED` 标记 + 功能去向说明,不删除。**2026-09-29 口径更新**:零引用(无活 import 且 0 编译行)的工程尸体改物理删除、git 历史可查——本域按此清理 `utils.ts`、`registry/lifecycle.ts`、`commands/lifecycle.ts`、`consumers/command-palette/`、`launch-tree/`、`api/activation-deps.ts`(`api/ros-terminal.ts` 已于 2026-09-22 整体删除,同口径)。
- **api/ 零 vscode 运行时依赖**(2026-08-26):接口文件全部 `import type`,编译后不 require vscode,可纯 Node 单测。
- **环境域只经门面**:`environment/index.ts` 是对外唯一出口(ESLint no-restricted-imports 兜底),禁止直接 import 其子模块。

## 文件地图

| 文件/目录 | 一句话 |
|---|---|
| `compose.ts` | 组合根:6 个实例聚合 + 注入装配 |
| `api/` | 接口定义 + composeApi 出口(见 api/README.md) |
| `host/` | vscode 中转壳(见 host/README.md) |
| `environment/` | 环境域(见 environment/README.md) |
| `commands/` | 命令域接口实现(见 commands/README.md) |
| `registry/` | 命令注册层(见 registry/README.md) |
| `consumers/` | UI 消费者(见 consumers/README.md) |

> 历史:`launch-tree/`(资源管理器侧栏启动树)2026-08-28 起整目录废弃,2026-09-29 零引用清理物理删除;`utils.ts`、`registry/lifecycle.ts`、`commands/lifecycle.ts`、`consumers/command-palette/`、`api/activation-deps.ts` 同批清理(提交 8afde4a 及 ros2 批次)。

## 近期(2026-08-26)关键改动

- 生命周期/daemon 命令停止暴露(`ROS2.lifecycle.*`、`ROS2.startDaemon/stopDaemon` 从命令面板移除,注册与枚举一并删除);
- `monitor-api.ts` 拆分出 `monitor-cli.ts`(环境域依赖集中),commandRunner 全库改组合根注入;
- consumers 统一经 `composeApi` 取实例,消除对环境域/build-tool 的直接依赖;
- `consumers/terminal` 移入 `consumers/terminal/` 子目录。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-04 21:15 | i18n 期2批3(03号档案=环境与终端):全域英文源化——environment 七文件(采集/刷新/装配/校验/注册/command-runner/compile-commands/setup-script)、registry 二、commands 三(ros_task_runner 五弹窗+终端名 编译/运行/启动、ros2_service_api 11 条、terminal-run)、consumers/terminal 二(terminal-profile 标题/banner/(未检测到)哨兵常量化/pwsh·bash·zsh 注入脚本注释按 D3 走语言中立英文,ros-terminal);setup-script 第三方输出翻译模板表整体翻 l10n(键=上游英文原文,册收中文);vscode 未导入文件补 `import { l10n }`;终端名 t() 后 runShellTask 名称随语言;bundle +134 条(总 163);1307 全绿 |
| 2026-09-30 20:31 | **五轮三(用户复检三项)**——①元素头顺序改 [i] 在前方块在后(用户裁定:方块在下标右边);②基本数组(含固定)行尾簇增局部展开/收起双图标(此前以「子项为基本类型无嵌套」为由不加——用户裁定:能折叠的都要有;基本数组收起 = 隐藏元素行,与消息数组口径一致);③局部双图标纵向对齐:行尾簇 margin-left:auto 右推后图标贴右缘,各行同位(此前跟随计数/A 宽度浮动导致偏移)。详见 consumers/README.md 修改记录 20:31 |
| 2026-09-30 20:31 | **五轮二 CSS 补交(逐项自查发现)**——83c854b 提交时脚本中途断言失败,后续补跑只补了 TS 部分;ros2-monitor.ts 的 CSS(display:flex 组头 + .form-header-end 行尾簇)从未落盘,而该提交信息声称包含组头 flex/行尾簇——自查发现后补交;详见 consumers/README.md 修改记录 20:31 |
| 2026-09-30 20:31 | **第五轮二:每元素独立收起 + 组头行尾区重排 + 展开符号固定化(用户裁定)**——①每元素独立收起:消息数组元素头 [i] 增折叠方块(复用 groupToggle,方块在前/[i]/D 在后),收起 = 只渲染元素头(内部字段/子组全部不渲染,数据零丢失),展开 = 恢复;②收集器扩展:去掉内容门槛(恒收集)+ 元素路径 ownPath[i] 纳入收集——表单级一键收起/展开与局部收起作用到元素层;③组头行尾区重排:组头改 flex 行,行尾簇(.form-header-end,margin-left:auto)右推——message_array 行尾 = N 个元素 + A + 局部展开/收起双图标,message 组行尾 = 局部展开/收起双图标,基本数组行尾 = 计数 + A(无局部按钮——子项为基本类型无嵌套);④展开符号固定化:折叠方块不再按 0/非 0 元素出现消失(空数组也有方块+「0 个元素」/「固定 X 个元素」计数),消除首次 A 添加时的行尾跳动。详见 consumers/README.md 修改记录 20:31 |
| 2026-09-30 20:31 | **第五轮:A 新建的数组元素内部组默认全收起(用户裁定)**——A 键与 Shift+Enter 新建的元素,其内部可折叠组(value/resolution 等)在渲染前即写入 state.collapsed(collectCollapsiblePaths 按新元素 fpath 收集):渲染即收起,不闪展开态;attachFormInputKeys 加可选 state 参(Shift+Enter 建元素同样收起),buildPrimitiveRow 签名/调用链同步传 state;每元素独立收起(用户考虑中)仅出思路未实施。详见 consumers/README.md 修改记录 20:31 |
| 2026-09-30 20:31 | **状态页打开不自动启动助手(用户裁定)**——launchMonitor 移除 startParamHelper 自动调用(「页开即启」废);助手改手动:状态页「启动助手」按钮(startHelper 消息 → startHelperFlow,等待上线确认/失败提示链完整保留);页关即停(onDidDispose stopParamHelper)与事件驱动刷新链不变——助手未启动时状态页各区块显示离线/未运行提示,启动后照常全量刷新。详见 consumers/README.md 修改记录 20:31 |
| 2026-09-30 20:26 | **第五轮:服务调用表单默认全收起(用户裁定)**——字段结构到达(formResult)时按当前树 collectCollapsiblePaths 重算可折叠集合并全部置入 state.collapsed(每次到达都重算:formStates 清理后再出现的服务同样全收起);用户点方块/一键展开逐层或全部展开;服务 ⓘ 文案同步(默认全收起)。另:第四轮转义实测工件(tmp-escape-test)清理。详见 consumers/README.md 修改记录 20:26 |
| 2026-09-30 19:35 | **输入框宽度三向钳制(用户复检:180px 单声明后 textarea 仍宽)**——CSS 两边虽同为 180px,实测渲染仍不等,说明 UA 对 input/textarea 的内在尺寸行为有差异;改三向钳制:box-sizing: border-box + width/min-width/max-width 全部 180px —— 浏览器零自由度,像素级恒等(字体度量/cols/flex 收缩全部失效);checkbox 例外维持原生(auto+min-width:0,不参与钳制)。详见 consumers/README.md 修改记录 19:35 |
| 2026-09-30 20:04 | **终端图标 hover 统一(用户复检:美术统一)**——.form-call-btn:hover 特殊态整条删除:终端图标 hover = 与复制钮完全一致(蓝色不变、无下划线无变色);此前提案的「加下划线」作废——经核实复制钮 CSS 声明的下划线因内容纯 SVG 画不出来,视觉上本就没有;详见 consumers/README.md 修改记录 20:04 |
| 2026-09-30 19:40 | **第四轮批次二补:输入框宽度像素钉死+动作行图标换位**——①输入框宽度像素钉死(用户复检:字符串框仍≈其他框 1.5 倍):width:auto 对 textarea 按【自身字体度量】算 cols(默认 20 列),与单行 input 的 size 算法天然不同,内在尺寸对齐不可靠;改固定像素 .form-input 与 textarea.form-input 均 180px(全部文本/数值/字符串框统一),checkbox 例外(input[type=checkbox].form-input width:auto+min-width:0 保持原生勾选框大小);②动作行图标换位(用户裁定):复制在前、终端在后(原终端在前);终端 hover 白色强调(color #ffffff,替代此前蓝→黑)。详见 consumers/README.md 修改记录 19:40 |
| 2026-09-30 19:22 | **第四轮批次二补:输入框宽度像素钉死(用户复检:字符串框仍≈其他框 1.5 倍)**——`width: auto` 对 textarea 按【自身字体度量】算 cols(默认 20 列),与单行 input 的 size 算法天然不同,浏览器内在尺寸对齐不可靠;改固定像素:.form-input 与 textarea.form-input 均 width:180px(全部文本/数值/字符串框统一),checkbox 例外(input[type=checkbox].form-input width:auto+min-width:0,保持原生勾选框大小,不随 .form-input 的 180px/min-width 拉伸);详见 consumers/README.md 修改记录 19:22 |
| 2026-09-30 02:07 | **命令面板隐藏修复(用户 F5 实测仍可见→根因=配置写错位置)**——第三轮把隐藏配置写成顶级贡献点 contributes.commandPalette,VS Code 只认 contributes.menus.commandPalette 菜单,顶级键被静默忽略,六条 when:false 从未生效(犯错链:凭记忆写贡献点未对照官方 schema;JSON 合法零反馈;验证=自我存在性检查非 VS Code 认可检查;误诊旧 vsix;68194de 首犯→c3e7114 revert 恢复错误版本→3b91481 原样重犯);修复:六条 {command,when:false} 移入 menus.commandPalette(顶级键删除);防回归锁 test/suite/command-visibility.test.ts 三用例(六命令 when=false 于 menus/顶级键不得回归/可见=贡献−隐藏对账);官方出处 code.visualstudio.com/api/extension-guides/command。详见 commands/README.md 修改记录 02:07 |
| 2026-09-30 19:10 | **第四轮批次三:转义深修——history expansion(用户复检 6,VM 真 pty 实证)**——残余失败根因 = **bash 交互式 history expansion**:复用终端 sendText 把命令打到【交互提示符】,`!!`/`!@#` 被 !event 展开吞掉(真 pty 对照:`echo A-!!x` 被展开成历史上一条命令;这正是用户截图「!@#: event not found」);修复:①wrapper(source bashrc 后)加 `set +H` 关历史展开(会话级,↑ 重跑安全——服务调用终端不需要 !event 特性);②sendCommand 复用路径先发 `set +H` 再发命令;**VM 全 ASCII 实测 27/27 全 PASS**:用户给定的全可打印 ASCII 串(!! " ' \ `` \$ 空格 换行 反斜杠等全量)+ 8 组值 × 3 路径(rcfile+setH / 复用 sendText+setH / 控制组),接收端逐字节比对一致;官方解析层(单 argv→yaml.safe_load)此前已核对三版本一致。详见 commands/README.md 修改记录 19:10 |
| 2026-09-30 18:56 | **第四轮批次二:一键运行修复(用户复检 9)**——根因一:.launch.py 同时命中两条 ctrl+f10 的 when(launch 正则与 .py 正则都匹配),键位数组 run 定义在后 → run 胜出 → 对 launch 文件走 ownersOfSource=0 → 误报「先构建」;修 = run 的 when 追加 `&& resourceFilename !~ /\.launch\.(py|xml|yaml)$/`(when 文法 !~ 操作符);根因二(纵深):launch 行可能源解析缺失(无源行,install-rule 未命中)→ launchFileOfSource 永不命中;修 = launchActiveEditor 加 basename 兜底(按文件名匹配安装侧目标,唯一直用/多个 QuickPick/零个维持提示);详见 run/README.md 修改记录 18:56 |
| 2026-09-30 15:26 | **第四轮批次一:表单 UI 五修(用户复检 2/3/4/7/8)**——①折叠触发区缩小+蓝色方块:新增 .form-group-toggle(15px 方块,focusBorder 蓝边,三角居中,hover 微亮底),点击监听从整条组头移到方块(groupToggle 助手,三处组头同改),header 其余区域纯展示防误触;②数组计数恒显示统一:基本数组「N 个元素」/空「0 个元素」、固定「固定 X 个元素」(**固定从 appendTypeDim 删除**,消「固定 16 16 项」重复)、消息数组恒显示含空「0 个元素」;③一键展开/收起图标化:文本钮改 ICON_EXPAND/ICON_COLLAPSE 内联 SVG(13px,与参数树同款),文案转 attachHoverTip;④textarea 空态宽度统一:去 240px 固定改 width:auto(cols 默认宽,与单行输入框同宽形式);⑤折叠/增删后 textarea 高度按内容重算:局部 rebuild 在子树入 DOM 前调 autoGrow 被 isConnected 守卫跳过致塌陷,rAF 挂载后补调;详见 consumers/README.md 修改记录 15:26 |
| 2026-09-30 01:51 | **第三轮之四:命令层遗留治理(上轮被回滚三项带上)**——①contributes.commandPalette 首次引入:六个上下文专属命令隐藏出面板(sidebar.runExecutable/launchFile/buildPackage 需树项实参、colcon.toggleIgnore/buildPackageRelease/buildPackageDebug 需右键实参——面板直呼必报警告/错误;菜单/树内触发照常);②僵尸命令 ROS2.updatePythonPath 删除(贡献 + extension.ts 枚举成员;实现零引用已注释,面板直呼报未找到命令);③ROS2.showDaemonStatus 标题改「打开 ROS 2 状态页(服务/话题/参数监控)」(实现即 launchMonitor,daemon 已退役旧题误导)。详见 commands/README.md 修改记录 01:51 |
| 2026-09-30 01:42 | **第三轮之三:tests.runAll 重定义(用户裁定填工作空间级空位)**——调研确认:测试视图最高档只到包节点,runAll 旧实现「全部叶子各跑一遍」(逐用例并行开进程)严格弱于视图(够不着包级 colcon test、不跑 launch 测试、进程数随时例数爆炸);重定义为「运行整个工作空间的测试 (colcon test)」:include=全部包节点 → 沿 runTests 既有串行包级执行器逐包 colcon test + 官方产物解析回填(runAllLeaves → runAllWorkspace,零新执行器),无包时提示;命令标题同步;docs/test-explorer.md 补条目。详见 commands README 或 test-provider README 修改记录 01:42 |
| 2026-09-30 01:33 | **第三轮之二:doctor/rosdep 命令串设置化(并入「运行与启动」组)**——新键 ROS2.run.doctorCommand(默认 ros2 doctor --report)与 ROS2.run.rosdepCommand(默认 rosdep install --from-paths src --ignore-src -r -y),整条命令可改(按空格与引号切分);流线:registry/core.ts 读设置 → splitShellArgs(share/expand 纯函数)切词成 argv → RosTaskRunner 接口(ros2/api)增可选 argv 字段下发 → ros_task_runner 有 argv 用 argv(argv[0]=命令名)、无则回退内置 toXxxCommand() —— ros2/ 零设置读取、不引 share 实现层,依赖方向不破;环境门槛不变(rosdep 需环境,doctor 豁免)。详见 registry README 或 commands README 修改记录 01:33 |
| 2026-09-30 01:24 | **第三轮之一:一键运行当前文件(复用 ROS2.run/launch,用户裁定不建新命令)**——数据源扩口:RunDataSource 增 ownersOfSource(透传 ExecutableResolver.ownersOfSource,源→所属可执行;{pkg,name}→RunTarget 映射)与 launchFileOfSource(launchFiles 快照按 sourcePath 归一匹配,normalizeSourceKey 分隔符统一+win32 小写);命令侧:register-commands 两 handler 接键位实参 {source:"activeEditor"}(keybinding args 透传),smart-run 增 runActiveEditor(0 属主提示先构建不自动构建/多属主 QuickPick/单属主直走 runExecutableFromTree)、smart-launch 增 launchActiveEditor(快照 sourcePath 匹配→launchFileFromTree,未命中同提示);键位单键双态 ctrl+f10(when 互斥:launch 文件→ROS2.launch,.py/.cpp/.cc/.cxx→ROS2.run,均带 args activeEditor)。详见 run/README.md 修改记录 01:24 |
| 2026-09-29 23:59 | **第二轮四项(用户复检)**——②构建预设 describe 精简:「详细输出 1/2:打开 debug 日志(--log-level debug;必须落在 build 之前)」→「详细输出 1/2:打开 debug 日志」、「…2/2(与 console_cohesion+ 合成…)」→「…2/2:记录每个被调用的命令」(使用方法不进选项,约束知识归设计文档;package.json 默认同步锁同步);③任务定义改已注册类型 ROS2:runShellTask 定义 `{type:"shell",command}` 被 VS Code 按 tasks.json shell 任务校验定义本身(顶层无 command 即报「既不指定命令…将忽略该任务」),改 `{type:"ROS2",command,args}`(package.json taskDefinitions 注册,required=command)消除误报,执行体/终端名不变;④侧边栏悬浮去冗余:「布局: xxx(工作空间级,显示在视图标题旁)」括注删除(布局字段自明),文件行「可执行: 是」删除(文件已在可执行分区,字段冗余);⑤创建包三处输入框补 title(包名/C++ 示范节点/Python 示范节点——此前无标题栏,输入框悬空无上下文)。详见各模块 README 修改记录 23:59 |
| 2026-09-29 23:58 | **表单批次 D:调用命令转义修复(用户 11 项之 9,VM 实测接收端对比)**——根因实证:writeCommandWrapper 旧实现 `__rde_cmd=shQuote(cmd)` + `eval "$__rde_cmd"` 双层解析,交互 rcfile 环境下 ''' 转义序列被当字面量(argv 探针:3 参变 4 参、引号入参),含单引号/空格的值六组全 FAIL(参数串值/请求发不出);修复:命令原样写 rcfile 直接一行执行(单次解析,与手敲同构)+ `history -s shQuote(cmd)` 历史存原文;**VM 实测**:自建回显服务逐字节核对接收内容,六组恶意值(it's / say "hi" / $HOME / a b / 真换行 / 反斜杠)旧实现全 FAIL、新实现全 PASS;官方解析多版本核对(humble call.py:80 / jazzy:90 / rolling:102)均单 argv → yaml.safe_load 无版本差异,复制链路(剪贴板 POSIX ''' → 用户粘贴)经同等解析实证无误。详见 commands/README.md 修改记录 23:58 |
| 2026-09-29 23:46 | **表单批次 E(用户 11 项之 10/11)**——①参数 ⓘ 删开发者口吻句「;内容不变时页面保持静止」(角色错位,前句已含等价信息);②服务 ⓘ 重写:按钮指代改图标语义(终端图标=调用/复制图标=复制/一键展开收起),键盘规则同步现状(Enter 字符串换行/数值跳下个、Shift+Enter 新建、空退格向上回退),校验描述补红框+!徽标悬浮详情;③动作 ⓘ 键盘句同步同款。详见 consumers/README.md 修改记录 23:46 |
| 2026-09-29 23:34 | **表单批次 C(用户 11 项之 6:折叠)**——表单组可折叠:message 组全可折;message_array/基本数组有元素或固定长度才可折(空数组无意义不折);组头 ▸/▾ 前缀 + collapsible 光标,点击切换(状态存 ServiceFormState.collapsed(fpath 集合),重渲染保持);折叠态显示元素/项计数(form-group-count 灰小字);折叠 = 不渲染子层(数据仍在状态树,零丢失);动作行新增「一键展开/一键收起」(form-key-neutral 灰色,collectCollapsiblePaths 收集全部可折叠路径,buildInvocableRow 作用域无 rerender 走 rerenderServices 全列表重渲染);.form-group 边框间隙 4px→8px(用户要求拉高);renderFormFields/buildFormEntry/buildArrayEntry 串 state 参数。详见 consumers/README.md 修改记录 23:34 |
| 2026-09-29 23:20 | **表单批次 B(用户 11 项中的 4/5/7/8)**——④校验错误徽标弃原生 title(系统级延迟+cursor:help 问号光标),改 attachHoverTip 即时悬浮层(与 ⓘ 同视觉零延迟),cursor 改 default;⑤动作按钮提示统一:调用/复制(服务+动作共用行)与话题订阅/复制四处全部从原生 title 换 attachHoverTip 高亮即时提示;⑦textarea 坍缩双修——根因 1:autoGrow 在未入 DOM 时调 scrollHeight≈0 写死 height:0px(加 isConnected 守卫),根因 2:重渲染后不补调(rerenderServices 末尾统一补调全部 textarea.form-input)+CSS min-height 22px 下限;附带问题 2 修:formStates 只写不清致服务消失再现带回旧值误导,renderServicesList 增清理(消失目标删状态,在线目标保留);⑧textarea 字体统一(font-family inherit + 12px——表单控件默认不吃继承落入等宽);新增通用 attachHoverTip 助手与 .hover-tip-host/.hover-tip CSS。详见 consumers/README.md 修改记录 23:20 |
| 2026-09-29 01:31 | **设置批次 A(用户 11 项中的 1/2/3)**——①安装形态三值化:ROS2.build.symlinkInstall(布尔)废,新键 ROS2.build.installMethod(enum auto/symlink/copy,默认 auto=平台默认 Windows copy/其余 symlink;显式值优先于平台,Windows 可强制符号=用户自担开发者模式前提),与 installLayout 口径完全对齐;resolveInstallType() 改三值解析,api/settings.ts 快照同步,install-method-check 提示语与两处测试播种同步;②search.excludeFolders 默认值去除误导性 5 项(build/install/log/node_modules/.git——皆为内置 11 目录子集,写入无效),默认 [],描述列明全部 11 个内置目录名(build/install/log/logs/devel/node_modules/.git/.hg/.svn/dist/out);③ide.intellisenseEngine 补 enumDescriptions 五条(auto/cpptools/clangd/both/none 各自悬浮说明),本体描述缩短。**全套测试首次 0 失败**(1179 例,既有 pixi 竞态随用户保存编辑器而愈合) |
| 2026-09-29 02:55 | **文档同步(总览对齐现行)**:①§铁律① composeApi 聚合 5→**6 实例**(+terminalRun,2026-09-26);②铁律② 例举 monitor-cli→param-helper-client(monitor-cli 已删);③分层表/文件地图:launch-tree 行移除(2026-08-28 废弃、2026-09-29 物理删除)、debugger/ 引用移除(09-23 随调试链路整体移除)、environment 依赖去 ActivationDeps(文件已删)、`utils.ts` 行移除(0 活行墓碑已删);④「废弃文件整体注释保留」口径更新:零引用工程尸体改物理删除,本域 5 处(utils/registry lifecycle/commands lifecycle/command-palette)已清理;launch-tree/utils 同批正文注记 |
| 2026-09-29 01:22 | **复杂数组分隔线改贯穿虚线(用户复检:『---』字符不明显)**——废除字符凑法(textContent --- + letter-spacing),改空 div 画线:border-top 1px **dashed** #555(贯穿全宽,灰度与 .form-group 边框一致,虚线形式用户终裁),margin 6px 0 2px;详见 consumers/README.md 修改记录 01:22 |
| 2026-09-29 01:04 | **表单两项:字符串 Enter 换行 + 校验错误重设计(用户裁定)**——①字符串字段(含字符串数组项)由单行 input 改多行 textarea(rows=1 + JS autoGrow 随内容长高):Enter = 输入真实换行(不再跳下一元素,单行 input 物理装不下换行符之根因),Shift+Enter 建元素/退格空删/方向键流转照旧,跳字段用 Tab/方向键;数值/布尔字段行为不变(Enter 仍下一字段);②校验错误重设计:废除「未通过校验(N):路径:详情;…」红字长行,改为错误字段红描边(form-input-invalid,charts-red)+ 旁插红色圆形感叹号徽标(form-error-badge,悬浮 title=详情「『dd』不是有效的 double」),通过时清标记;validateFormNodes 错误结构化({path,message},path 与 data-fpath 同构定位);attachFormInputKeys 加 multiline 参数(Enter 原生放行,Shift+Enter 仍拦截建元素)。详见 consumers/README.md 修改记录 01:04 |
| 2026-09-29 00:47 | **键盘流转全局化(用户复检:上一提交只在数组内生效)**——用户定位:全表单条目按类列表排布,跳转应有序/固定/可测,不限于数组;①方向键去掉数组约束(fpath 前缀校验/非数组成员不响应全部废除):任一输入头部按 ← → 上一个输入尾、尾部按 → → 下一个输入头,checkbox 左右同样流转,DOM 序 = 全表单唯一顺序;②固定数组项空删除的全局上一格(原 Math.max 钳位自指卡死在数组边缘);③非数组普通字段空退格/删除同改向上走一格(此前静默无动作);可删项的删除语义(删后停同下标/删元素向上)不变。详见 consumers/README.md 修改记录 00:47 |
| 2026-09-29 00:31 | **表单四调整(用户复检+扩展)**——①[N]→D 间距统一:简单数组行 flex gap 8px 与键钮 margin-left 8px 叠成 16px,.form-row .form-key-btn margin 置 0 → 与复杂数组同为 8px;②固定长度数组项(不可删)空退格/删除此前无动作,改为导航到上一个输入(向上);③方向键跨元素流转:数组成员光标在头部按 ← → 上一个元素最后输入尾、尾部按 → → 下一个元素第一输入头(fpath 前缀校验不出数组外溢,文本内部原生移动,checkbox 不参与);方向按编辑器通用惯例(左=上/右=下),用户原话配对相反已标注可对调。详见 consumers/README.md 修改记录 00:31 |
| 2026-09-29 00:12 | **表单三调整(用户复检)**——①动作行:终端/复制图标间距 10→4px 并整行右移 6px(不再贴左缘);②简单数组行内顺序改 [N] → D → 输入框(D 与标号相邻,与复杂数组 [i] D 同排布;此前 D 被输入框隔开);③复杂数组元素间插入「---」分隔行(.form-element-sep,灰色小号 letter-spacing,视觉强切元素边界,多层嵌套不混淆;简单数组单行成对不加)。详见 consumers/README.md 修改记录 00:12 |
| 2026-09-28 23:59 | **bool 删除分境定稿(用户明确回退链)**——未勾选 bool 的 Backspace/Delete 分两境:①bool 数组项 = 向下删(四修保留:删除后焦点停同下标,下一项顶上来);②普通 bool 字段(如 ParameterValue.bool_value)= 向上回退链——落到上一个输入的尾(integer_value(头)→布尔→type(尾),与文本空退格同一条链;四修误把它做成跳下一个输入)。至此 bool 键盘全貌:勾选→取消成假;取消后→按场景向下删项或向上回退;空格原生取反;Enter/Shift+Enter 同文本流。详见 consumers/README.md 修改记录 23:59 |
| 2026-09-28 23:52 | **bool 删除方向矫正(用户复检:向下走,不向上回退)**——三修把未勾选 bool 的删除落回文本「空退格」流(splice 后聚焦**前一个**),用户复检指出方向反了;四修改为:未勾选 Backspace/Delete = **向下走**——数组项删除后焦点停**同下标**(下一项顶上来,连续按一路向下删);非数组 bool(如 ParameterValue.bool_value)跳下一个输入;勾选→取消成假一段不变;统一删除流入口守卫恢复原文(bool 各分支已全部 return,不再落入文本退格段)。详见 consumers/README.md 修改记录 23:52 |
| 2026-09-28 23:42 | **表单三修**——①bool 删除同质化补完:未勾选时 Backspace/Delete 不再「跳下一个输入」(用户复检:导致连续删除断链),改为落回与文本「空退格」完全相同的删除流——删数组项并聚焦前一个/元素内回退/删整个元素(统一删除流入口守卫对 checkbox 旁路光标检查,未勾选视同空且在开头);②服务表单终端图标 14→15px,与话题行复制/终端图标同尺寸(间隔本就同为 flex gap 10px),美术统一;详见 consumers/README.md 修改记录 23:42 |
| 2026-09-28 23:18 | **表单二修(用户复检四点)**——①调用终端图标改蓝色(textLink-foreground,与复制钮同色,hover 仍提亮);②D 位置核实未动:D 挂元素(消息数组元素头 [i] 行/基本数组元素行),上数组头的只有 A;③bool 回退框选:checkbox 恢复(鼠标点击=取反原生不变),键盘同质化——聚焦后 Backspace/Delete 勾选→取消成假、已取消再按→跳下一输入,空格不拦截走原生切换,Enter/Shift+Enter 同文本流(attachFormInputKeys isBool 分支改 checkbox 语义,.form-input-bool 窄框类废除);④修 A/D 无色:变量名误写带点 charts.green/red(无效引用回落继承)→ 横线 --vscode-charts-green/red + 兜底色 #3fb950/#f85149;详见 consumers/README.md 修改记录 23:18 |
| 2026-09-28 22:58 | **服务/动作表单六修(用户逐条裁定)**——①调用终端钮去蓝色基底:幽灵图标钮(transparent + descriptionForeground/hover foreground),与复制钮同风格随主题;②删两处说明字:动作行「→ ros2 service call(普通集成终端,命令可改重跑)」(send_goal 同款对称删)与空态长句「该请求的全部字段都是数组且默认为空——…」,用法下沉到 A/D 键钮悬浮,.form-notice CSS 随删;③键钮化:[+ 添加]/[+ 添加元素]→「A」(翠绿 charts.green)、[×]→「D」(红 charts.red),新 .form-key-btn/.form-key-add/.form-key-del,悬浮分别注明 Shift+Enter 新建/删除此元素;④基本数组 A 自底部移到数组头行(与消息数组同位);⑤bool 键盘语义:checkbox→单字符输入(maxLength=1 窄框),非空=真(即敲即存)/空格取反(空↔1)/Backspace+Delete 非空清空成假、已空跳下一输入,Enter/Shift+Enter 并入既有键盘流(attachFormInputKeys 加 isBool 分支),组装/校验/焦点恢复链不变;详见 consumers/README.md 修改记录 22:58 |
| 2026-09-28 22:41 | **状态页图标镂空化 + 换行/复制图标双修**——①用户裁定「所有图标必须镂空且随主题变色」:icons.ts 三图标重画为纯描边(currentColor,fill=none,删黑填充/白描边/阴影 filter/灰色块):方框±号(展开/收起)、终端窗+提示符(执行);复制图标原本已镂空;宿主 CSS 硬编码色全部换 --vscode-* 主题变量(param-tree-btn #9da5b4→descriptionForeground、hover→foreground、param-open-file #3794ff→textLink-foreground、form-call-btn #0e639c→button-background/hover);media/ros2-packages.svg 实心剪影→描边镂空立方体(mask 着色随主题);②修「一键展开/收起子孙两按钮凭空换行」:根因 = 按钮 svg display:block 而容器 .param-tree-actions 是内联 span,块级子元素致内联流碎片化(匿名块盒)各占一行——容器加 display:flex+align-items:center;③修「复制后复制图标化为虚有」:copyCommandToClipboard 的 textContent 读写是文字按钮时代遗物(读回空串、赋值抹掉唯一子节点 SVG,1.5s 恢复空;事件驱动刷新数据不变永不重绘)——改存/恢复 innerHTML。详见 consumers/README.md 修改记录 22:41 |
| 2026-09-28 22:16 | **发布 0.0.1:终端名中文式压缩 + 构建按钮三角图标**——①ros_task_runner 三处任务终端名:Colcon 构建(N 个包)→编译(×N)、run:pkg.exe→运行 pkg.exe、launch:pkg/file→启动 file(只取文件名尾段,包名/嵌套路径不上终端名——命令内容就在终端里);②tasks.ts runShellTask 任务 source 由 shell 改为 ROS2(凡显示任务来源之处变短可识别;改名安全性已核实:按任务名识别我方构建的机制 2026-09-15 已移除,无按名/source 匹配消费方);③package.json 版本 1.4.14→0.0.1(用户裁定版本重起),侧边栏包行构建按钮 icon $(tools)→$(play)(此前为与文件行 ▶ 区分而用 tools,用户裁定改回三角);④打包 vsix/rde-ros-2-0.0.1.vsix(vsce 走 vscode:prepublish 重建 production bundle)。详见 commands/README.md 修改记录 22:16 |
| 2026-09-28 21:09 | **测试基线清理:27 条存量失败 → 1 条**(编辑器竞态的 pixi 期望待用户保存)——①真 bug:setup-script.ts 回退串 `"c:\pixi_ws"` 转义吞反斜杠(实际 c:pixi_ws)修正;②ProductMap 懒获取恢复注入缝(构造器 pkgPrefix 可注入,测试免真 ros2);③过期用例改口径(isValidPackageXml 按 2026-08-22 收紧:未声明 build_type 不合法)+ launch 测试盘符大小写不敏感比较(Uri.fsPath 小写语义);④stub 依赖用例加宿主跳过守卫(share-spec 全文件/弹窗 describe/intellisense render describe——_vscode-stub 在宿主故意不劫持,播种与弹窗队列无效);⑤rosapi+rosmsg provider 组跳过(TODO:诊断证实测试宿主内 dist bundle 从未被 require——模块顶层直写探针未触发,isActive/exports 语义异常,@vscode/test-electron 装配待专项排查);⑥**发现并重建过期 dist 产物**(npm test 只跑 tsc 不重建 webpack bundle,22 条愈合主力);全套 1177 用例 1 失败 66 跳过 |
| 2026-09-28 16:15 | **设置体系批次 4:生效时机一致化**——①package-core 加 `PackageCore.reconfigure(config)`(断环注入不变,组合根读设置下发值对象):排除集/符号链接/超时走 `PackageCache.updateConfig` 既有键比对+去抖标脏(键未变不重扫),colcon list 执行器闭包换新排除集,DataLayer isDirRelevant 排除集 let 化热更新,`packages.refreshMs` 经 DriverTimer 新增 `setIntervalMs` 运行中重设周期(<=0 停用);②extension.ts 四键(search.followSymlinks/search.walkTimeouts/search.excludeFolders/packages.refreshMs)5s 去抖 → reconfigure,去硬编码 60s;③env.systemWatchFiles 列表变化即时重建 shell watcher(registerSystemEnvWatch 改返回 rebuild/dispose 句柄,register.ts ④ 监听内接线);④listeners.ts 整体退役删除(死键注释尸体同批清理);⑤新用例 5 条(timer 重设周期×2/updateConfig 键比对+去抖标脏×2/reconfigure 行为级×1);设置描述与 docs 同步为「改后自动生效」;失败集与基线一致(27=27,总数 1163→1168) |
| 2026-09-28 16:02 | **设置体系批次 3:全键重命名 22 键**——按 7 分组归位:env.distro/env.setupScript/env.pixiRoot/env.systemWatchFiles;build.symlinkInstall/build.installLayout/build.shareSpec/build.preflightWarnings/build.allowEmptyWorkspace(去冗余 colcon 段);run.shareSpec/launch.shareSpec;msg.systemRefreshMinutes/msg.workspaceRescanMs/msg.formatGradientStep/msg.formatLineThreshold(单位进键名);错位归位 search.followSymlinks/search.walkTimeouts/search.excludeFolders/packages.refreshMs(死键暂留描述如实,下批接回);ide.intellisenseEngine;ui.autoShowOutput/ui.showWelcomeOnStartup。约 45 个 ts(json)+45 处读点/监听/错误文案/测试/samples 工作区设置同步;md 活段落同步、修改记录历史行不回改;清注释尸体(package-store 后台刷新块、build-env-utils ros.distro 尾段);用户无存量(开发中)不做旧键回退;失败集与基线一致(27=27) |
| 2026-09-28 15:55 | **设置体系批次 2:三命令模板词数组化 + 预存默认**——CommandSpec.template 改 `string \| readonly string[]` 联合(设置侧=词数组每项一词,引擎 templateText() join 归一、兼容裸字符串,join 后逐字节等价、自由度不变);colcon.build/ros2.run/ros2.launch 三 shareSpec 的 package.json default 预存整份出厂 spec(设置面板出厂值直接可见可改),template 属性声明为 string 数组;defaults/ 三文件出厂模板改词数组;同步锁用例(读 package.json 断言与 defaults 不漂移)+ join==历史文本逐字节锁定;mergeSpec/normalizeSpec 接受数组滤非法项;share-expand 78 例全过。详见 share/README.md 修改记录 15:47 |
| 2026-09-28 15:21 | **设置体系批次 1:展示层减杂**——contributes.configuration 单块拆 7 分组块(环境/构建/运行与启动/消息接口/包发现与搜索/智能感知/界面)+ 每键 order;删死键 sourceOverlayCache(全仓库零引用)与 lastShownWelcomeVersion(迁 context.globalState,旧设置值一次性回退迁移);22 键描述按「一句话功能+取值要点+生效时机」重写,撤三 shareSpec 长墙;docs/configuration.md 整表换现役键、docs/pixi.md 删幽灵 usePixiOnAllPlatforms、docs/README-LAUNCH-TREE.md 命令名改 ROS2.launch;api/settings.ts 快照清幽灵字段(pixiExecutable/env.*)并修正 WalkTimeoutOverride 形状。键名未动,零行为变更 |
| 2026-09-26 19:14 | **consumers/monitor:事件驱动 + 心跳物理隔离**——助手新增 Unix Socket 事件与心跳通道(server_heartbeat/param_change/graph_change 主动推送),ros2-monitor 移除全部轮询链改为事件触发刷新;高并发异步重写(节点哈希路由/单输出线程/SIGTERM 处理)。详见 consumers/README.md 修改记录 19:14 |

| 2026-09-26 18:31 | **consumers/monitor:常驻助手成为状态页唯一数据源,ros2 daemon 退役**——图/参数/生命周期全部经助手 DDS 服务直连;monitor-cli 退役删除;按钮与探测语义改"助手在线"。详见 consumers/README.md 修改记录 18:31 |

| 2026-09-26 17:52 | consumers/monitor:daemon 离线期间 3s 轮询链停摆(探测循环值守,上线自动恢复)。详见 consumers/README.md 修改记录 17:52 |

| 2026-09-26 18:02 | consumers/monitor:启停确认窗口 5s→15s 修 VM 慢启动误报。详见 consumers/README.md 修改记录 18:02 |

| 2026-09-26 17:12 | **consumers/monitor 状态页:参数树四点 UI + 大值"打开到文件"**——(N) 计数独立化/叶子 (1)/单链面包屑压缩(> 亮色加粗)/分支 [+] 节点 [-] 一键展开收起;助手新增 save op:截断参数全值落盘临时 JSON 由编辑器打开,超大内容零 UI 渲染。详见 consumers/README.md 修改记录 17:12 |

| 2026-09-26 16:38 | **consumers/monitor:常驻参数助手架构落地**——废除每 3s CLI dump 轮询(CLI 固定 ~1s 进程开销+PyYAML 大数组文本化),改 rclpy 常驻助手 stdio JSON 协议(list 0.7ms+批量 GetParameters 1.6ms,大数组助手端截断);页开即启/页关即杀/崩溃退避重启;架构不变量写入规范(值禁止自动/高成本请求)。详见 consumers/README.md 修改记录 16:38 |

| 2026-09-26 15:43 | consumers/monitor 状态页:数组括号加粗 + 数组色换紫罗兰 #a78bfa。详见 consumers/README.md 修改记录 15:43 |
| 2026-09-26 15:39 | **consumers/monitor 状态页:顺序稳定双保险 + 参数树全条目化**——数据指纹(键递归排序规范化序列化)不变即跳过重渲染;话题/服务/生命周期列表全部排序;参数树默认整树收起、叶子条目化(参数名可折叠,值作子行);`#lifecycle-sub` 默认完全不渲染+首帧中性加载占位。详见 consumers/README.md 修改记录 15:39 |
| 2026-09-26 14:37 | **consumers/monitor 状态页:按实测格式修正参数解析 + 递归文件树**——三层验证(官方文档/humble dump.py 源码/VM 实机复跑)确认 `ros2 param dump` 输出为 `{节点:{ros__parameters:{点分名按.展开的嵌套层级}}}` 且无类型标注;parseParamDump 重写为结构保真(ParamTree),前端递归文件树(分支可折叠/每层字典序排序/叶子五色),修复 [object Object]、顺序随机、首帧"加载生命周期"占位、ⓘ 提示不换行四项。详见 consumers/README.md 修改记录 14:37 |
| 2026-09-26 02:15 | **consumers/monitor 状态页:两态模型 + 参数文件树 + 类型五色**——生命周期子区并入系统信息(在线全加载/离线一条提示);ⓘ 上标小字号并去除帮助"?"光标;参数改文件树,值由轮询 `ros2 param dump`(monitorApi 新增 A6 param_values,js-yaml 解析)自带,按五类着色常显,展开/收回取值链路整体退役。详见 consumers/README.md 修改记录 02:15 |
| 2026-09-26 01:38 | **consumers/monitor 状态页:修生命周期转换 //node + 参数区树形化 + 离线显性化**——webview 全名拼接在根命名空间产出 `//node` 致转换必败,改结尾斜杠感知拼接;参数区弃表格改树形(节点层可折叠/参数层缩进,平铺表格丢失从属结构);daemon 离线时各区显示明确提示而非静默隐藏;ⓘ 提示窄面板截断修复。详见 consumers/README.md 修改记录 01:38 |
| 2026-09-26 01:12 | **consumers/monitor 状态页:修参数表崩坏**——内联 `.param-row{display:flex}` 把 tr 拽出表格列网格(值列恒起于行宽 50%、与表头错位),删 flex 规则回归正常表格布局,顺带清理旧折叠层遗骸 `.param-node`;详见 consumers/README.md 修改记录 01:12 |
| 2026-09-26 01:08 | **consumers/monitor 状态页:参数收回 + ⓘ 悬浮说明**:参数值展开后可"收回"(删缓存回展开按钮,在飞晚到响应否决,此前展开后永久驻留);使用说明从顶部折叠块改为 ⓘ 悬浮标注分布在对应区块旁(菜单栏/生命周期/系统信息/参数)。详见 consumers/README.md 修改记录 01:08 |
| 2026-09-24 23:08 | **consumers/monitor:daemon 探测职责重定位**:后台常驻 1s 探测取消(多数用户不使用 daemon),探测循环自状态栏移交状态页——仅页面展开期间探测(页开即启/页关即停,代号守卫防残留);状态栏去 ✗(离线只显示发行版文字,在线 ✓),退化为纯显示+状态页入口,订阅 daemon-state 翻转;启动链路环境诊断改挂激活。tsc 零错误 + webpack 通过;详见 consumers/README.md 修改记录 23:08 |
| 2026-09-09 21:05 | **environment:构建任务与 install/** 事件交织(第一部分)**:register.ts 记录"我方构建进行中"(`onDidStartTask` 登记、`onDidEndTaskProcess` 注销),进行期间 install/** 事件全部抑制,构建结束单次 `refreshOverlayAfterBuild()`(1 次/构建);非我方构建(终端/外部)走原 1s 防抖退化路径;host/tasks.ts 补 `onDidStartTask`/`onDidEndTaskProcess` 薄壳;判定按任务文本含 `colcon build`(不跨域 import);10 分钟超时兜底。下游(rosmsg/exe-map requery、env 指纹)本次未动;详见 environment/README.md 修改记录 21:05 |
| 2026-08-28 12:52 | 创建总 README(分层结构/两条核心铁律/约定/文件地图) |
| 2026-08-28 12:56 | 时间标注统一精确到时分;尾部新增修改记录便于溯源。正文引用的历史日期(2026-08-24 ~ 2026-08-26)为设计/代码注释标注日期,非文件操作时间 |
| 2026-09-01 19:44 | **Ros2ServiceApi 查询类 null 契约定稿**:9 个查询方法失败 → resolve null(绝不抛、绝不 undefined),[]/"" = 成功但空——"合法空"与"失败"不再相撞(此前失败折叠为空值);lifecycle_set 保持上抛;接口/实现/全部消费方/测试同步改造,顺带修复 loadSystemPackageList 死守卫与 rosmsg startsWith("") 空串过滤失效;139 用例全过 |
| 2026-09-08 23:48 | **consumers/monitor 日志增强(两轮,首次联测配套)**:① 关键路径 info/debug(轮询周期 #N 各阶段耗时、daemon 启停、状态栏探测翻转、webview 握手与日志转发 `webviewReady`/`webviewLog`),原静默 catch(轮询整体异常/启停失败)补 error;② 低级别 trace/debug 铺到 monitor-api 全 12 查询/操作 + XmlRpc 逐调用 + 图缓存命中/0 边 warn + 前端 `window.onerror`/`unhandledrejection` 全局钩子。查看:输出「ROS 2」通道切 Debug/Trace,或 `RDE_ROS2_LOG_MIRROR` 文件镜像(全级别,不受通道过滤)。细节见 consumers/README.md"monitor/ 日志与可观测性" |
| 2026-09-09 00:04 | **webview 产物格式修复(monitor 状态页总根因)**:根 webpack 配置 ros2_webview entry 移除 `experiments.outputModule`/`libraryTarget:"module"`/`chunkFormat:"module"`——产物由 ESM(顶层 `export`)改经典脚本;HTML 用经典 `<script src>` 加载,此前 SyntaxError 致前端整段不执行(状态页"点击无反应/正在加载永驻/无前端日志");重编译验证 `node --check` 0、无顶层 export。细节见 consumers/README.md"webview 产物格式约束" |

<!-- 文件末尾修改时间:2026-09-26 19:14(事件驱动 + 心跳物理隔离,详见上表 19:14 行) -->

