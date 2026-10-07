# consumers/ — UI 消费者层

面向用户的 UI 集成层:查询/操作能力全部经 `composeApi`(api/ 出口)获取,自身只做"展示 + 交互 + 轮询/渲染"。与 `api/`(契约)、`registry/`(命令注册)、`host/`(vscode 薄壳)并列。

## 结构

```
consumers/
├── monitor/           ROS 2 状态页(核心;十二轮拆分后 12 个模块,单文件 <500 行)
│   ├── ros2-monitor.ts        webview 宿主:面板生命周期 + postMessage 消息中枢(helperAction 线字段)+ 动作回执
│   ├── monitor-refresh.ts     数据刷新域:面板单例 + 事件驱动刷新(去抖/防重叠/错峰批量 runInBatches)
│   ├── monitor-html.ts        状态页 HTML 模板(内联 <style> 拼两段 CSS 常量)
│   ├── monitor-css-base.ts    页面样式前半(菜单/区块骨架/生命周期卡片/ⓘ/参数树/终端日志区)
│   ├── monitor-css-forms.ts   页面样式后半(条目行/服务动作复合行/表单/悬浮/键钮)
│   ├── monitor-helper-flows.ts 常驻助手启停流程(helperAction 播报 + 15s 确认窗)
│   ├── monitor-api.ts         MonitorApi 组装对象(13 个查询/操作;**唯一数据源 = 常驻助手** DDS 直连,graph 1s 共享缓存)
│   ├── param-helper-client.ts 常驻助手客户端(stdio JSON-lines + Unix Socket 心跳/事件;心跳 socket 每实例路径;transitionId 协议键;崩溃退避重启)
│   ├── param-helper-protocol.ts 助手 stdio 协议数据形状(纯类型)
│   ├── param-tree-build.ts    扁平参数映射 → 参数树(纯函数)
│   ├── helper-state.ts        助手在线状态单一事实源(写路径 = param-helper-client socket 生命周期;读路径 = 状态栏订阅)
│   ├── status-bar.ts          状态栏指示(在线 ✓/其余只显示发行版;纯显示不探测,订阅 helper-state;点击开状态页)
│   └── webview/           前端 17 模块四子层:shared/(context+i18n+dom-utils+hover-tip+icons 工具层)、
│       panels/(topics/lifecycle/lifecycle-log/param-tree 区块面板)、forms/(model/fields/render/panel 表单引擎)、
│       graph/(state-graph 三件 SVG 状态图);入口 ros2_webview_main.ts 留根
│   (资产:assets/ros/param_helper.py 薄入口 + param_helper_lib/ 包 + core-monitor/style.css —— rclpy 常驻助手与页面样式,**不迁入 src**:vscodeignore 排 src/** 会丢 vsix)
└── terminal/          终端消费者
    ├── ros-terminal.ts     createRosTerminal(命令 ROS2.createTerminal 行为实现;vscode 仅类型引用)
    └── terminal-profile.ts "ROS 2 环境"终端配置(TerminalProfileProvider;跨平台注入 wrapper + banner)
```

> **历史**:monitor-cli.ts(ros2 CLI 子进程)与 daemon-state.ts 已于 2026-09-26 整体删除——ros2 daemon XML-RPC 链路退役,
> 常驻助手成为状态页唯一数据源(见修改记录 09-26 18:31 行);command-palette/(旧 rosrun/roslaunch 交互面板)
> 整文件注释墓碑于 2026-09-29 物理删除(清理提交 8afde4a)。

## 规范(2026-08-26 收口)

1. **取实例一律经 `composeApi`**(api/ 出口):如 `composeApi.monitorApi`、`composeApi.environment.getEnv()`;不再直接 import 环境域/build-tool 实现。
2. **命令 ID 单一事实源**:从 `host/commands.ts` 取(`ShowDaemonStatusCommand` / `CreateTerminalCommand`),不硬编码。
3. **vscode 运行时 import 合法**:consumers 是 UI 层,直接 import vscode 是既成惯例(webview/状态栏/profile 注册都需要);仅类型用法收敛为 `import type`(如 ros-terminal.ts)。
4. **compose 成员不 import composeApi**:monitor-api/param-helper-client 是 compose 组成成员,反向取 `composeApi` 会循环 → 声明式依赖 + 组合根注入(`setRos2ServiceApi` / `setParamHelperCommandRunner`)。
5. **参数值请求架构不变量(2026-09-26 VM 实测定稿)**:值**禁止任何自动/高成本请求模式**——`ros2 param dump` 全量轮询(每 3s 一个 CLI 进程 ~1s 固定开销 + PyYAML 大数组文本化 1s+)与逐参数 `ros2 param get` 串行链路均已废除;唯一合法路径 = 常驻 rclpy 助手(`param_helper.py`,页开即启/页关即杀)的 `list_parameters(0.7ms) + 一次批量 GetParameters(21 参数 1.6ms)`,元素 >1000 的数组助手端截断(回传 `__rde_truncated` 标记,前端标"…共 N 项");助手不可用 → 该节点参数区显示失败提示,页面不崩。

## 关键文件细节

### monitor/monitor-api.ts(组装对象,13 成员)
- A 列表查询: nodes / topics / services(**助手 graph op,一次全量,1s 共享缓存**)/ lifecycle_nodes / param_list(2026-09-26 起状态页不再使用,保留为公共 API 面)/ param_values(助手一次批量 GetParameters,类型归一五类 integer/double/boolean/string/array,>1000 元素助手端截断回 `__rde_truncated`);
- B 单点查询: param_get / lifecycle_get / lifecycle_node_info / lifecycle_available_states(助手 lifecycle_info 打包当前态+可用态+转换图+可用转换);
- C 操作: helper_running(ping)/ lifecycle_transition(助手 change_state 直连)。
- **daemon XML-RPC/CLI 链路已整体退役(2026-09-26)**:A1-A3 原 XmlRpc 直连 daemon(端口 11511+ROS_DOMAIN_ID)、monitor-cli 子进程实现全删;数据源唯一 = 常驻助手,执行口经组合根注入(`setParamHelperCommandRunner`)。

### monitor/helper-state.ts(2026-09-26 自 daemon-state.ts 改建;2026-10-03 写路径订正)
- 助手在线状态唯一事实源(写变化才广播、无 vscode 依赖可单测);写路径 = **param-helper-client 的 socket 生命周期**(连接建立置真/断开与停止置假,1s 探测循环已于 2026-09-26 随轮询退役);读路径 = 状态栏订阅(`onHelperRunningChanged`)。

### monitor/ros2-monitor.ts + webview/
- **事件驱动刷新(2026-09-26,3s 轮询与 1s 探测循环整体移除)**:刷新仅由 Socket 连接建立 / 助手事件(param_change | graph_change,0.5s 起步自适应图差分)/ 启停动作触发,200ms 去抖合并;助手离线时零刷新(整区一条"助手未运行"提示);`startHelperFlow`/`stopHelperFlow` 管助手生命周期;
- **助手启停按钮走 webview 内部消息**(startHelper/stopHelper),不经 VS Code 命令系统;
- 前端渲染节点行(**生命周期节点行尾 ▸/▾ 内联展开状态图卡片与回执日志,十七轮并入**)/话题/服务/动作行 + **参数文件树** + 服务调用/动作 send_goal 结构化表单(2026-09-28/29 键盘流转与校验大迭代,见修改记录);数据指纹不变则跳过重渲染(页面静止);
- **五区块可折叠(2026-10-03 十七轮)**:节点/话题/服务/动作/参数标题行尾 ▾/▸,收起状态跨刷新记忆;
- **参数文件树(2026-09-26)**:节点层(`▾/▸` 可折叠 + 参数计数,折叠状态跨轮询保持)→ 参数层(缩进 + 树参考线,名称 + 类型化彩色值常显)。值来自助手批量 GetParameters(param_values),按五类着色:整数 `#b5cea8`/浮点 `#dcdcaa`/布尔 `#569cd6`/字符串 `#ce9178`/数组括号加粗 `#a78bfa`(子元素按自身类型递归);**无任何按钮**——按需取值链路整体退役;截断数组行尾"打开完整内容(共 N 项)"(save op 落盘临时 JSON 打开);某节点取值失败 → 该节点显示"参数获取失败",不拖累其他节点;
- ⓘ 悬浮标注(2026-09-26 调整):11px + `vertical-align:super` 悬在所标注标题右上角;`cursor:default`(帮助"?"光标已去除);提示框宽度适配窄面板。

### monitor/status-bar.ts(2026-09-24 重定位;2026-09-26 改订)
- `status-bar.ts`:纯显示 + 状态页入口(点击 = ShowDaemonStatusCommand)——在线 `✓ ROS2.humble`,离线/未知只显示发行版文字(**✗ 已移除**:用户误读为"出错/可关闭");订阅 `onHelperRunningChanged` 翻转显示,自身不持有任何定时器;激活时一次性输出启动链路环境诊断(纯 env 读取);未设 tooltip(悬停无提示,待补);
- 唯一事实源机制见上节 `helper-state.ts`(前身 daemon-state.ts 已删除,订阅事件名随之一改)。

### monitor/ 日志与可观测性(2026-09-08;下文 daemon 时代条目为历史记录,现行 = 事件驱动 + 助手,见修改记录 2026-09-26 两行)
- **通道**:统一收进扩展 `LogOutputChannel`「ROS 2」(vscode-utils.createOutputChannel)。模块前缀:`ros2-monitor` / `monitor-api` / `param-helper-client` / `status-bar` / `command-runner`;webview 侧日志经 `[webview]` 前缀进同一通道。
- **级别约定**(2026-09-09 收敛:记"变化 + 失败 + 密集单行汇总",周期性逐条一律不打):
  - `info` = 关键事件与状态翻转:daemon 启停(开始/确认结果/失败)、daemon 探测状态变化(状态页探测循环,2026-09-24 起写路径)、轮询 ready 首次发布、webview 前端就绪握手、整体异常、启动链路环境诊断;
  - `debug` = 失败明细(各 A/B/C 查询仅失败才记,成功不逐条)+ 在线周期单行汇总(每 3s 1 条,含数量与各阶段耗时)+ 启停确认结果 + param dump 每节点抓取一条;
  - `trace` = 最低频兜底:前端逐动作点(triggerTransition)。状态栏心跳已随探测职责移交取消(2026-09-24);requestParamValue 逐动作点已随取值链路退役取消(2026-09-26:值随轮询 dump 自带,无按需取值);
  - 已移除的周期性噪音:XmlRpc 逐调用、C2 daemon_running 探测逐条、状态栏每秒探测、状态栏心跳、轮询离线稳态、图缓存命中逐条——稳态默认静默。
- **查看方式**:① 输出面板「ROS 2」右上角级别下拉切 **Debug/Trace**;② 环境变量 `RDE_ROS2_LOG_MIRROR`(`console` 或文件路径,逐条追加,**不受通道级别过滤**,全量含 trace 落盘,无头/长时联测首选)。
- **webview 侧转发机制**:webview console 不外显 → `sendLog()` postMessage `{command:'webviewLog', level, message}`;初始化完成 post `webviewReady` 握手(面板创建后无此条 = 前端脚本未加载/初始化失败);`window.onerror` / `unhandledrejection` 全局钩子 + 各渲染块 try/catch 把未捕获异常回传扩展日志。
- **排查线索索引(现行)**:点击"启动助手"无反应 → 看 `收到 startHelper 请求` → param_helper.py 启动链路日志(无此链 = 消息未达扩展或跑的是旧构建);数据不上屏 → 看 `[webview]` 前端就绪握手与助手连接日志(2s ping / 5s 看门狗);历史 daemon 时代线索(`收到 startDaemon 请求`/`ros2 daemon start:…`)仅适用于旧构建。
- **启动链路静态诊断(2026-09-09;2026-09-24 起改挂状态栏激活,不再依赖探测)**:状态栏激活时输出环境摘要——info:`启动链路环境诊断:ROS_VERSION/DISTRO/DOMAIN_ID + PATH 解析 ros2 → <路径>(探测端口=11511+domain)`;warn:PATH 中找不到 ros2(点击启停必然 `exec spawn ros2` 失败,UI 表现为"点了没反应、仍一直不在线")。
- **webview 产物格式约束(2026-09-09)**:状态页前端 bundle 必须为**经典脚本格式**——webpack 该 entry 禁用 `experiments.outputModule` / `libraryTarget:"module"`,HTML 以经典 `<script src>` 加载;产物带顶层 `export` 会抛 SyntaxError 导致**整段前端不执行**(此前"点击无反应 + 占位永驻 + 无前端日志"的总根因)。改后验证:`node --check` 通过、无顶层 export。

### terminal/
- `ros-terminal.ts`:创建注入 env 的 ROS 终端(host/terminal.createTerminal + composeApi.environment.getEnv)。
- `terminal-profile.ts`:在"新建终端"下拉注册 `rde-ros-2.ros-environment`;跨平台按 shell 生成注入 wrapper(bash --rcfile / zsh ZDOTDIR / fish --init-command / pwsh -File / cmd /k / WSL 降级),banner 显示发行版/overlay/环境变量速览;自组装 `vscode.TerminalOptions`(单消费方 UI 集成,不进 api/,设计上有意)。

## 修改记录
| 2026-09-30 20:31 | 五轮三:元素方块移下标右边;基本数组(含固定)行尾簇加局部展开/收起;局部图标右缘对齐消偏移 |
| 2026-09-30 20:31 | CSS 补交:.form-group-header flex + .form-header-end 行尾簇规则(五轮二遗漏部分) |
| 2026-09-30 20:31 | 五轮二:每元素独立收起([i] 方块 [i] D);收集器去门槛+元素路径纳入;组头行尾簇重排(计数/A/局部按钮右移,局部=本组及子孙);展开符号固定化 |
| 2026-09-30 20:31 | A/Shift+Enter 新建元素内部组默认全收起(渲染前写入 collapsed;attachFormInputKeys 增 state 参) |
| 2026-09-30 20:31 | 状态页打开不自动启动助手(改「启动助手」按钮手动启);页关即停与事件刷新链不变 |
| 2026-09-30 20:26 | 服务调用表单默认全收起:字段到达时全量置折叠(重算式);ⓘ 文案同步 |
| 2026-09-30 19:35 | 输入框宽度三向钳制:border-box + min/width/max 全 180px(input 与 textarea 恒等,checkbox 例外) |
| 2026-09-30 20:04 | 终端图标 hover 统一:删除 .form-call-btn:hover 特殊态(hover=蓝色不变,与复制钮完全一致) |
| 2026-09-30 19:40 | 输入框宽度钉死 180px(checkbox 例外);动作行换位:复制在前终端在后,终端 hover 白色强调 |
| 2026-09-30 19:22 | 输入框宽度像素钉死:form-input/textarea 统一 180px(checkbox 例外原生大小);根因=textarea auto 宽按自身字体度量算 cols 天然偏宽 |
| 2026-09-30 15:26 | 表单批次一:折叠改蓝色方块三角(触发区缩小防误触);数组计数恒显示(固定并入计数消重复);一键展开/收起图标化;textarea 空态宽度统一+局部重渲染后高度重算 |
| 2026-09-29 23:46 | 表单批次 E:参数ⓘ删开发者口吻句;服务ⓘ重写(图标语义+现行键盘/校验描述);动作ⓘ键盘句同步 |
| 2026-09-29 23:34 | 表单批次 C:组头折叠(▾/▸ 点击切换,状态持久,折叠态计数);一键展开/收起(动作行);边框间隙 8px |
| 2026-09-29 23:20 | 表单批次 B:校验徽标即时悬浮(title/问号光标废);四处动作按钮统一高亮即时提示;textarea 坍缩双修(离线守卫+渲染后补调+min-height);formStates 随目标消失清理;textarea 字体统一 inherit |
| 2026-09-29 02:40 | **文档同步(正文重写,消除"文案超前"重灾)**:①结构树/规范④/关键文件细节全部从已删除的 daemon/monitor-cli/daemon-state 架构改写为现行 常驻助手唯一数据源 + helper-state + 事件驱动(3s 轮询/1s 探测循环/XmlRpc 链路已删,见 09-26 三行);②webview 树补 icons.ts、服务/动作结构化表单、icons 镂空、数据指纹防抖动;③日志节标注 daemon 时代条目为历史记录,排查线索索引改现行助手链路;④历史:command-palette/ 墓碑于 2026-09-29 物理删除(8afde4a);本表 09-26 前的 daemon 时代记录行按惯例保留 |
| 2026-09-29 01:22 | 复杂数组分隔线改贯穿 1px 虚线(dashed #555 与边框同灰度,废 --- 字符) |
| 2026-09-29 01:04 | 表单两项:字符串字段 textarea 化(Enter=真实换行,autoGrow);校验错误重设计(红描边+红圆叹号徽标悬浮详情,废红字长行,错误结构化 {path,message}) |
| 2026-09-29 00:47 | 键盘流转全局化:方向键全表单列表流转(去数组约束,checkbox 参与);固定项删除全局上一格;普通字段空删除向上走 |
| 2026-09-29 00:31 | 表单四调整:[N]→D 间距统一 8px(行内 margin 叠加去除);固定数组项空删除导航上一输入;方向键跨元素流转(←头进上元素尾/→尾进下元素头,fpath 限同数组) |
| 2026-09-29 00:12 | 表单三调整:动作行缩距右移;简单数组 [N]/D 相邻(D 在输入框前);复杂数组元素间 --- 分隔线 |
| 2026-09-28 23:59 | bool 删除分境定稿:数组项向下删(保留);普通 bool 字段向上回退链(落上一输入尾,integer→bool→type),四修的跳下个废除 |
| 2026-09-28 23:52 | bool 删除方向矫正:未勾选删除 = 向下走(数组项删除后停同下标连续下删/非数组跳下个),三修的向上回退废除 |
| 2026-09-28 23:42 | 表单三修:bool 未勾选删除落回文本同款删除流(删项/删元素/回退,不再跳下个);服务表单终端图标 15px 与话题行统一 |
| 2026-09-28 23:18 | 表单二修:终端图标改蓝(textLink);A/D 颜色修复(charts 变量名点改横线+兜底);bool 回退 checkbox 但键盘同质化(删除=取消/已取消跳下个,空格走原生) |
| 2026-09-28 22:58 | 服务/动作表单六修:终端钮去蓝底幽灵化;删 service call/send_goal 说明行与空态长句(下沉 A/D 悬浮);[+添加]/[+添加元素]→A(charts.green)、[×]→D(charts.red);基本数组 A 移数组头行;bool checkbox→单字符输入(非空=真/空格取反/删除清空或跳下个,并入键盘流) |
| 2026-09-28 22:41 | 状态页:图标镂空化(3 图标重画纯描边 currentColor + 宿主色换 --vscode-* 变量 + 视图图标描边化);修参数树展开/收起按钮换行(容器内联 span 被块级 svg 碎片化→加 flex);修复制后图标消失(textContent 反馈抹 SVG→innerHTML 存/恢复) |

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-26 19:14 | **事件驱动 + 心跳物理隔离(用户方案落地)**:① 助手新增事件与心跳通道(Unix Socket /tmp/rde_param_helper_heartbeat.sock,与业务 stdout 物理隔离):server/每 1s server_heartbeat 广播/5s 失联看门狗自退出(RDE_HEARTBEAT_ENABLED=0 可关;从未连接不触发,兼容旧客户端);② 事件总线:参数变化订阅 /parameter_events(原生)+ 图变化 0.5s 内部差分定时,统一以 {"type":"event",event_type:"param_change|graph_change"} 推送;③ 助手高并发异步重写:输入线程→节点哈希路由 4 worker(同节点串行/异节点并发)→rclpy 异步 future(单 executor spin)→单输出线程优先级队列;ros_call 超时显式 remove_pending_request+重试一次;client 5 分钟闲置销毁(in-flight 防误杀);SIGTERM 显式处理(多线程默认终止不可靠);stdin EOF 排空后优雅退出;④ 扩展端 param-helper-client:Socket 连接(断线 500ms 重连)、2s ping、5s 无数据 SIGKILL 看门狗重启、事件转发 setHelperEventCallback、连接状态 setHelperConnectionCallback(写 helper-state 驱动状态栏);⑤ ros2-monitor 改事件驱动:3s 轮询链与 1s 探测循环整体移除,刷新仅由 Socket 连接建立/助手事件/启停动作触发(200ms 去抖合并);⑥ 术语定稿:常驻助手(扩展进程)/自带 demo(官方 demo_nodes)/python demo(用户 complex_params 测试节点);⑦ VM 冒烟(纯 python 驱动,引号安全):params 25 条原生值、graph 4 节点 2 话题 18 服务——daemon 死亡状态下全部正常;单测 35 passing;tsc/webpack/产物/python 语法全过 |

| 2026-09-26 18:31 | **常驻助手成为状态页唯一数据源,ros2 daemon 退役(用户指令:即使 daemon 完全死亡页面也要工作)**:机制经 MCP 源码核实(humble ros2lifecycle:生命周期节点=图服务含 <节点>/get_state 且类型 lifecycle_msgs/srv/GetState;状态/可用态/转换图=<节点>/get_state、get_available_states、get_transition_graph,TransitionDescription{id,label,start_state,goal_state})。① 助手新增 op:graph(节点/话题/服务一次全量)、lifecycle_nodes、lifecycle_get、lifecycle_info(打包当前态+可用态+转换图+可用转换推导)、lifecycle_transition(直连 change_state)、ping;② monitor-api 重写:A1/A2/A3→助手 graph(1s 共享缓存),A4→lifecycle_nodes,B2/B3/B4→助手 lifecycle_info/lifecycle_get,C2 daemon_running→**helper_running(ping)**,C3→助手 change_state 直连;**XmlRpc daemon 直连层整体删除**;C1 daemon() 移除;③ **monitor-cli.ts 全文件退役删除**(lifecycle CLI 链路/图缓存/daemonStart/Stop),buildParamTree/fromJsonValue/isTypedLeaf 迁入 param-helper-client.ts,compose 去 monitor-cli 装配;④ 助手高并发异步重写(输入线程→节点哈希路由 4 worker→rclpy 异步 future→单输出线程优先级队列):一个死节点不再阻塞其他请求,心跳输入层直答最高优先级,SIGTERM 显式处理(多线程形态默认终止不可靠),client 5 分钟闲置销毁,输入池背压;⑤ 探测循环 ping 助手,状态栏/按钮语义改"助手在线",按钮文案"启动助手/停止助手";⑥ 单测重构(mock 助手客户端注入缝 setHelperClientForTest——tsc 具名导入编译为本地绑定,monkey-patch 属性无效)35 passing;⑦ VM 冒烟:daemon 强杀死亡状态下 graph/params/lifecycle_nodes 全部正常供数(params 21 参数原生 JSON);顺带发现并清理:异步助手对 SIGTERM 不响应致 stop 后残留(已加 SIGTERM 处理+客户端 SIGKILL 兜底);⑧ 待办:C++ 助手(协议与语言解耦) |

| 2026-09-26 17:52 | **离线停摆(用户质疑离线期间轮询空转)**——daemon 离线时无数据可查,3s 轮询链不再排下一轮(runPoll finally 按 getDaemonRunning 判定),整链停摆;1s 探测循环继续值守,onDaemonRunningChanged 翻转上线且页面开着时自动恢复轮询;离线页面零轮询消息,只显示"守护进程未运行"提示;提示:每次构建后需 Reload Window,否则扩展宿主供旧 HTML/旧后端(新 webview JS + 旧宿主错配会白屏) |

| 2026-09-26 18:02 | **修启停确认误报(用户日志)**——waitForDaemonState 确认窗口 5s → 15s:本机 VM 实测任何 Python 进程启动 ~1s,daemon 需拉起/初始化 rclpy/绑定 XML-RPC 端口,DDS 收敛另有首轮 2.2~4.4s 抖动,5s 产生"start 命令成功却报未上线"误报(页面随后自愈但红字已吓人);超时提示补"若稍后上线,状态会自动翻转"说明;停止路径同步放宽 |

| 2026-09-26 17:12 | **参数树四点 UI + 大值"打开到文件"(用户反馈)**:① (N) 计数独立 span(margin-left:12px≥两空格,杜绝误读为名称一部分),叶子条目也显示 (1);② 单链面包屑压缩(参考 VS Code compact folders):唯一子且为分支的层级链合并为一条 qos_overrides >/parameter_events > publisher 面包屑,">"白色加粗(有意不用"."太小不显眼),叶子不吞,压缩条目 (N)=终端分支叶子数;③ 分支行尾 [+] 一键展开全部子孙(collectEntryKeys 批量入 expanded 集合+rerenderParams 显式重绘),节点行行尾 [+]/[-] 一键展开/收起,点击 stopPropagation;④ **大值"打开到文件"**:助手新增 save op——单参数全值(不截断)落盘临时 JSON(tempfile 目录,rde-param-<节点>_<参数>.json)回传路径,ros2-monitor saveParamToFile 分支 openTextDocument 打开;截断叶子值行尾"打开完整内容(共 N 项)"入口;超大内容零 stdio 回传/零 DOM 渲染;⑤ VM 冒烟:2000 元素数组——params op 正确截断(total 2000/前 1000 项),save op 文件 2000 项完整(首 0 尾 1999),临时文件已清理;冒烟节点初版未 spin 致服务永不应答(测试脚本 bug 非产品问题,已修正重测);tsc 零错误+webpack 通过+产物/python 语法校验 0+单测 20 passing |

| 2026-09-26 16:38 | **常驻参数助手架构落地(用户 VM 服务级实测驱动,替代 3s dump 轮询)**:实测数据——CLI 每次调用固定 ~1s 进程/DDS 发现开销(与数据量无关),服务级 list_parameters 0.7ms、批量 GetParameters(21 参数)1.6ms、dump=逐参数串行+PyYAML 大数组文本化(1s+);据此:① 新增 assets/ros/param_helper.py(rclpy 常驻助手,stdio JSON-lines 协议;list+一次批量 get,list_parameters 响应经 VM 冒烟修正为 result.names,wait_for_service 消除启动竞态;>1000 元素数组助手端截断回 __rde_truncated 标记);② 新增 param-helper-client.ts(进程生命周期:页开即启/页关即杀/崩溃指数退避重启;请求 id 匹配+10s 超时;compose 注入 setParamHelperCommandRunner);③ monitor-cli 删 dump 全链路(parseParamDump/fetchParamDump/js-yaml),新增 buildParamTree(扁平点分名按.拆段重建层级)/fromJsonValue(截断标记→array+total);④ A6 param_values 改走助手,失败节点显示失败提示;⑤ 节点列表过滤 rde_param_helper;⑥ ParamTypedValue 增 total 可选字段,webview 截断数组标 …共 N 项;⑦ 规范节新增架构不变量(值禁止自动/高成本请求,唯一合法路径=助手批量获取);⑧ VM 端到端冒烟通过(对 /complex_params_cpp 一次返回全部 21 参数原生 JSON 值);单测 20 passing(删 4 dump 用例,增 buildParamTree/协议 2 用例);tsc 零错误+webpack 通过+产物/python 语法校验 0 |

| 2026-09-26 15:43 | **数组括号加粗 + 换紫罗兰色(用户反馈:紫色太单薄)**——renderTypedValue 数组的 `[`/`, `/`]` 三个标点 span 加 font-weight:bold;数组色 `#c586c0` → `#a78bfa`(用户提供的色相分布方案中的紫罗兰,更亮更饱和);tsc 零错误+webpack 通过 |
| 2026-09-26 15:39 | **顺序稳定双保险 + 参数树全条目化 + 生命周期空窗根除(用户反馈:数据不变仍跳动/初始全展开/use_sim_time 无法折叠)**:**跳动机制分析**——用户猜测"循环取参数时先返回的排前面"对旧设计成立(parameters 键按子进程完成顺序写入,for...in 按插入序渲染);14:37 构建已排序+单 dump 化,但仍有两真源:①整树每 3s 无条件销毁重建;②话题/服务/生命周期卡片仍按 daemon 返回顺序渲染。修复:①**数据指纹**(canonicalStringify 对象键递归排序→序列化只由数据本身决定)与上次一致则**整体跳过重渲染**,DOM 零扰动,机制性杜绝"不变仍抖";②话题/服务/节点表与生命周期卡片全部按名称排序(保险一补全);③**参数树全条目化**——集合语义翻转 `paramTreeCollapsed`→`paramTreeExpanded`(初始空=整树收起,文件树惯例),**叶子改条目**:参数名是 ▸ 可点击条目,展开后值作为**子行**(缩进+五色)展示,统一"名条目→值子列表"语义;④`#lifecycle-sub` 静态 `display:none` 完全不渲染(轮询空窗期不再闪现标题),`#topics` 静态预置中性"正在加载…",首条轮询自动替换;⑤死 CSS `.param-tree-param` 清理,新增 `.param-tree-value-row`;tsc 零错误+webpack 通过+产物校验 0 |
| 2026-09-26 14:37 | **按实测格式修正参数解析 + 递归文件树 + 四项缺陷(用户实测反馈,三层验证后实施)**:**验证记录**:① 网络查证官方参数文档;② humble 分支 `ros2param/verb/dump.py` 源码——顶层 `{节点全名: {'ros__parameters': {}}}`、`insert_dict` 按 `.` 逐段拆键、`/` 非分隔符整段成键、**值无类型标注**;③ VM 实机独立复跑 `ros2 param dump /talker` 与前两者逐字一致(临时 talker 验证后清理)。据此:① **parseParamDump 重写**——取 `ros__parameters` 下映射递归构树(新类型 `ParamTree`,分支=子映射/叶子=五类值,`join(".")` 为拆键严格逆),无包裹旧格式兜底;此前误设 `{type,value}` 标注形态致 `[object Object]`+计数全 1;② **webview 递归文件树**——新增 `renderParamBranch`:分支=可折叠文件夹行(▸/▾ 段名(叶子数),折叠键=节点名\|join路径),叶子=名称+五色值;**节点层+每层键名字典序排序**(修复顺序随 daemon 返回随机漂移);③ **首帧占位删除**——"正在加载生命周期节点..."静态占位移除,打开留白,首条轮询统一翻转(修复"生命周期特权加载"观感);④ **ⓘ 提示换行修复**——`width:max-content+calc(100vw-…)` 上限在 webview 不生效(单行撑出面板),改确定式 `width:420px;max-width:90vw;overflow-wrap:anywhere`,参数区提示文本分行;⑤ 单测重写为实测输出原文用例(嵌套结构/数组递归/通配键/兜底),22 passing;tsc 零错误+webpack 通过+产物校验 0 |
| 2026-08-28 12:53 | 创建 consumers/ README(目录树/规范/关键文件细节) |
| 2026-08-28 12:56 | 时间标注统一精确到时分;尾部新增修改记录便于溯源。正文引用的历史日期(2026-08-24 ~ 2026-08-26)为设计/代码注释标注日期,非文件操作时间 |
| 2026-08-31 18:33 | terminal-profile.ts `vscode.workspace.rootPath` 迁移为 `workspaceFolders?.[0]?.uri.fsPath`(废弃 API 清理,行为等价) |
| 2026-09-01 19:44 | monitor-api 适配 null 契约:param_get / lifecycle_get 失败 → null 直通(不再用 ""/{id:-1}),lifecycle_nodes / param_list 底层 null → {success:false,data:[]};测试同步 |
| 2026-09-08 23:30 | **monitor 消费者日志补强(第一轮)**:ros2-monitor 补面板创建/轮询周期(#N)info+debug 日志与整体异常 error(原静默吞);daemon 启停成功耗时 + 失败 error;status-bar 探测 debug + 状态翻转 info;monitor-cli daemon 启停开始/完成/失败日志;webview 新增 `webviewReady` 握手 + `webviewLog` 日志转发 + 渲染 try/catch(异常回传不再静默) |
| 2026-09-08 23:48 | **monitor 消费者低级别日志铺开(第二轮)**:monitor-api 全 12 查询/操作补 trace 入口/debug 成败耗时;XmlRpc 逐调用 trace;图缓存命中 trace + 解析 0 边 warn(stdout 片段);lifecycle_transition 分步 debug(标准 7/图查找/id 解析/执行结果);webview 升 trace 级 + `window.onerror`/`unhandledrejection` 全局钩子;README 补"日志与可观测性"小节 |
| 2026-09-08 23:57 | **降噪(首测反馈)**:每秒稳态探测(status-bar 探测 / C2 daemon_running 结果 / 离线稳态轮询)由 debug 降 trace——Debug 级别只保留状态翻转与事件,不再每秒刷屏;README 级别约定同步 |
| 2026-09-09 00:01 | **启动链路静态诊断**:状态栏首轮探测后输出环境摘要(info/warn)——ROS_VERSION/DISTRO/DOMAIN_ID、PATH 是否解析到 ros2、预期探测端口;PATH 无 ros2 → warn(点击启停必然 exec spawn 失败,解释"点了没反应、仍不在线") |
| 2026-09-09 00:04 | **修复 webview 不执行总根因**:webpack ros2_webview entry 移除 `experiments.outputModule` + `libraryTarget:"module"`(产物由 ESM 顶层 export 改经典脚本)——HTML 以经典 `<script src>` 加载,此前 SyntaxError 致前端整段不执行(点击无反应 / "正在加载…"永驻 / 无 [webview] 日志 全由它引起);`npm run webpack` 重编译验证:`node --check` 0、无顶层 export、UTF-8 干净 |
| 2026-09-09 00:20 | **消除启停"晚一档"(UX)**:① 后端 start/stop 命令完成后先 `waitForDaemonState` 实测(5s 内确认在线/离线)才发 started/stopped,isRunning 用实测值(此前用轮询缓存的旧值,按钮/页面晚一拍);命令成功但状态未达 → 发 error 如实告知;② 轮询改链式调度(runPoll + scheduleNextPoll),启动/停止确认后 `triggerPollAfterDaemonState` 提前补一轮,页面数据刷新从 ≤3s 压到 ~1s;③ 前端 starting/stopping 小字不再 5s 自动清空(持续到结果消息),共享清理定时器防旧定时器误清;④ 确认期间禁用按钮防连点 |
| 2026-09-09 00:32 | **日志收敛(提升单条信息商)**:移除全部周期性逐条日志——XmlRpc 逐调用、C2 探测逐条、状态栏每秒探测行、轮询离线稳态行、图缓存命中 trace、各 A/B 查询的成功/入口行、前端每轮收包与渲染行;改为:变化才记(info 翻转)、失败才记(debug 明细)、在线周期单行汇总(debug,每 3s 1 条带数量与分阶段耗时)、状态栏心跳兜底(trace,约每 30s 1 条);转换/参数动作一次一条结果 |
| 2026-09-24 23:08 | **daemon 探测职责重定位(用户反馈:后台常驻探测离谱 + ✗ 误读为错误)**:① 探测循环自状态栏移交状态页(ros2-monitor)——多数用户根本不使用 daemon,后台常驻 1s 探测取消,**仅页面展开期间探测**:页开即启(首轮立即)、`onDidDispose` 即停,循环代号(generation)守卫防在飞循环残留;② 状态栏去 ✗——离线/未知只显示发行版文字,在线 ✓,退化为纯显示+状态页入口,订阅 daemon-state 翻转显示,自身无定时器;③ 启动链路环境诊断改挂激活(原挂首轮探测);④ 状态栏心跳日志随之消亡;daemon-state 唯一事实源不变,写路径 = 状态页探测循环;tsc 零错误 + webpack 编译通过 |
| 2026-09-26 01:08 | **参数收回 + ⓘ 悬浮说明(用户反馈)**:① 参数值补**收回逻辑**——webview 值列展开后显示"值 + 收回按钮",点收回删缓存回到"展开"按钮(此前展开后值永久驻留、无收回,旧使用说明"收回即停止"从未实现);`paramValuePending` 在飞标记否决"收回后晚到的取值响应"(响应无请求 id,按 node\|param 键查标记,既不进缓存也不上屏);3s 重渲染经 `renderParamValueCell` 按缓存恢复同一形态;② 使用说明从顶部 `<details>` 折叠块改为 **ⓘ 悬浮标注**分布在对应区块旁:菜单栏(打开方式/daemon 是什么/未上线排查)、生命周期节点 h3(转换操作/完整图开关)、系统信息 h3(节点/话题/服务含义/3s 刷新)、参数 h2(动态创建,展开/收回说明);CSS 悬浮提示(`.info-icon`/`.info-tip`,pre-line 多行),移除 `.usage-hint`;旧文案"约每秒自动刷新"更正为约 3 秒、"展开期间自动刷新"更正为值不自动刷新;验证:tsc 零错误 + webpack 通过 + 产物 `node --check` 0 / 无顶层 export |
| 2026-09-26 01:12 | **修参数表崩坏(用户截图)**:内联样式 `.param-row { display:flex }` 把 `tr` 拽出表格列网格——两个 td 变 flex 项各占 50%(`.param-name,.param-value` 的 `flex:1`),值列恒起于行宽一半而表头按正常表格另排一套,即"展开按钮悬在中部、值列表头靠最右"的错位;删 flex 规则回归正常表格布局(列宽全表统一),顺带清理更早折叠层遗骸 `.param-node`/`.param-node summary`(现渲染器只产表格,不再有这些元素);单元格 padding/word-break 由外部 style.css 全局表格规则覆盖 |
| 2026-09-26 02:15 | **两态模型 + 参数文件树 + 类型五色(用户反馈,经计划批准)**:① **生命周期子区并入系统信息**——打开状态页只剩两态:在线全部加载/离线整区一条统一提示(分区各自的离线提示删除);子区显隐改 `#lifecycle-sub` 定位(parentElement 在并入后指向整个 section,不可再用);② **ⓘ 调整**:11px + `vertical-align:super` 悬在标题右上角,`cursor:default` 去除帮助"?"光标(用户两次指出);③ **参数区改文件树,删「展开」按钮**:值改由轮询自带——monitor-cli 新增 `fetchParamDump`(`ros2 param dump <node>` + **js-yaml v4 首个实际使用点**,兼容 humble `{type,value}` 与旧版扁平两形态,ROS 类型归一五类),monitorApi 新增 **A6 param_values**(13 成员),轮询 ③ 每节点 1 条 dump 替代 A5 param_list(命令数持平),postMessage 直接带类型化值;前端树常显彩色值(整数 `#b5cea8`/浮点 `#dcdcaa`/布尔 `#569cd6`/字符串 `#ce9178`/数组括号 `#c586c0` 子元素递归),布尔 true/false、字符串不加引号,"Integer value is:" 式 CLI 原文不再出现;getParamValues/paramValues 消息链路与 paramValueCache/paramValuePending/展开收回按钮全部删除;dump 失败节点显示"参数获取失败"不拖累其他节点;④ 单测 +3(parseParamDump 两形态/非法输入/fetchParamDump 失败降级),monitor-api 21 passing;⑤ `.param-expand/.param-collapse/.param-spinner` CSS 随按钮退役;验证:tsc 零错误 + webpack 通过 + 产物 `node --check` 0 |
| 2026-09-26 01:38 | **修生命周期转换 //node + 参数区树形化 + 离线显性化(用户反馈)**:① **修转换 Node not found**——webview 全名拼接 `ns + "/" + name` 在根命名空间(namespace="/")产出 `//lc_talker_py`,`ros2 lifecycle set //xx` 必失败;改为结尾斜杠感知拼接(`endsWith("/") ? ns+name : ns+"/"+name`),与参数路径 `${ns}${name}` 惯例统一;② **参数区弃表格改树形**——用户误把节点组行 `/talker` 当参数名,且表格平铺丢失 节点→参数 从属结构:节点层粗体行(▸/▾ 可折叠,带参数计数,折叠状态 Set 跨 3s 重渲染保持),参数层缩进 + 树参考线(border-left),值"展开/收回"沿用;`renderParamValues` 选择器同步 `div.param-tree-param`;话题/服务/节点仍用表格(平铺数据适合);③ **离线显性化**——daemon 未运行时生命周期区/系统信息不再静默隐藏/清空,显示"守护进程未运行——启动后显示…"斜体提示(此前用户困惑"加载时为何只有占位");④ ⓘ 悬浮提示窄面板截断修复:`width:max-content; max-width:calc(100vw - 24px)`;验证:tsc 零错误 + webpack 通过 + 产物 `node --check` 0 |

