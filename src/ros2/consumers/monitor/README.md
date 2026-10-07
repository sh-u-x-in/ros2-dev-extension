# monitor/ — ROS 2 状态页(核心消费者)

> 状态页 webview 宿主 + 数据层。**唯一数据源 = 常驻助手**(扩展自带的 rclpy 常驻进程
> `assets/ros/param_helper.py`,DDS 直连;ros2 daemon 于 2026-09-26 彻底退役)。
> 事件驱动:Socket 连接 / 助手事件 / 启停动作 → 200ms 去抖刷新。域级总览见 `../README.md`。

## 文件

| 文件 | 职责 |
|:--|:--|
| `page/ros2-monitor.ts` | webview 宿主:面板生命周期(创建/复用/销毁)+ postMessage 消息中枢(helperAction 线字段 10 命令分发)+ 动作回执 postCommandResult;十二轮拆分后不再含 HTML/刷新/启停流 |
| `page/monitor-html.ts` | 状态页 HTML 模板(head 引 style.css 与 dist/ros2_webview_main.js,内联 <style> 拼两段 CSS 常量;#nodes-topics 容器) |
| `page/monitor-css-base.ts` | 页面样式前半:菜单栏/可折叠区块骨架/生命周期节点卡片与状态徽章/ⓘ 悬浮标注/参数树/转换回执终端式日志区/滚动条恒显(旧版行内状态图 sg-* 族已删,十九轮批2) |
| `page/monitor-css-forms.ts` | 页面样式后半:话题/服务条目行/节点行与暂态反馈红字/图标尺寸/服务动作复合行与调用表单/即时悬浮/键钮/离线提示 |
| `page/monitor-refresh.ts` | 数据刷新域:面板单例状态、事件驱动刷新(去抖合并/防重叠/错峰批量 runInBatches)、全量取数一次 postMessage;助手不在线发 ready:false |
| `page/monitor-helper-flows.ts` | 常驻助手启停流程:startHelper/stopHelper 完整链(helperAction 阶段播报 → 启停命令 → 15s 确认窗 → 结果发布 → 触发刷新) |
| `monitor-api.ts` | MonitorApi 组装对象(13 成员:A 列表 7 = nodes/topics/services/actions/lifecycle_nodes/param_list/param_values;B 单点 4;C 操作 2 = helper_running/lifecycle_transition);graph 1s 共享缓存;**重设计阶段 2**:A4 生命周期发现=classify 从图推导、A7 动作分类=classify 从原始服务清单聚合、C3 转换走 CLI(`ros2 lifecycle set <node> <label>`,拒绝=非零退出码) |
| `helper/param-helper-client.ts` | 常驻助手客户端(2026-10-06 重设计:**共享服务端形态**,connect-first——先连全局唯一服务端,连不上才 spawn,flock 竞速败者自退)、单 socket 帧协议(hello 版本握手/resp 按 id 匹配/event 推送/shb 1s 遥测/chb 2s 存在性)、看门狗 5s 无帧按服务端 pid SIGKILL 自愈、**停止=仅断开本窗连接**(共享服务端他窗在用绝不杀;零客户端 10s 宽限服务端自退)、30s 请求超时、测试缝 `setSocketFactoryForTest` |
| `helper/param-helper-protocol.ts` | 助手帧协议数据形状(2026-10-06 重设计:帧类型 hello/req/chb/hello_ack/resp/event/shb/bye + 图/表单/生命周期业务形状;协议版本与 socket 路径常量两侧同值,协议规格见 helper/README.md) |
| `helper/classify.ts` | 图分类纯函数(2026-10-06 重设计阶段 2 自助手 Python 迁入):separateActions 动作三件套聚合 + detectLifecycleNodes 生命周期发现;判据与旧 ops_graph/ops_lifecycle 逐字对齐,补单测 classify.test.ts |
| `helper/param-tree-build.ts` | 扁平参数映射 → 参数树(十九轮批4a 拆出,纯函数) |
| `helper/helper-state.ts` | 助手在线状态唯一事实源(写 = param-helper-client socket 生命周期;读 = 状态栏订阅;前身 daemon-state.ts 已删) |
| `status-bar.ts` | 状态栏指示:在线 `✓ ROS{ROS_VERSION}.{ROS_DISTRO}`、其余只显示发行版;纯显示 + 状态页入口,无定时器 |
| `webview/` | 前端 17 模块,四子层 shared/panels/forms/graph(见 webview/README.md) |
| (资产) `assets/ros/param_helper.py` + `param_helper_lib/` | 常驻助手 rclpy 进程(本目录驱动;不迁入 src——vscodeignore 排除 src/**,迁入则不进 vsix) |
| (资产) `assets/ros/core-monitor/style.css` | 状态页外链样式表(HTML head 引用) |

## 关键约定

- 实例一律经 `composeApi.monitorApi`(组合根装配,`setParamHelperCommandRunner` 注入执行口);
- **参数值架构不变量(2026-09-26 定稿)**:值禁止任何自动/高成本请求模式,唯一合法路径 = 助手批量获取;
- 启停走 webview 内部消息(startHelper/stopHelper),不经 VS Code 命令系统;
- 助手资产:`assets/ros/param_helper.py`(服务级基准:list 0.7ms / 批量 get 1.6ms,CLI 每次调用固定 ~1s 开销故退役)。

## 修改记录

> 轮次图例:批次1-3 与 四~六轮 = 2026-09 下旬表单/迭代系列;七~十轮 = 2026-10-03 悬浮框系列;
> 十一轮起 = 2026-10-03 起的表单/状态页/生命周期系列(补 N 为同轮追加)。

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):monitor 目录此前无 README,演进史见 `../README.md` 修改记录(2026-09-26 常驻助手落地/daemon 退役/事件驱动;09-28~29 服务/动作表单与键盘迭代) |
| 2026-10-03 | 十二轮拆分(单文件 <500 行):ros2-monitor.ts 1203 行 → 本体 236 + monitor-html/css-base/css-forms/refresh/helper-flows 五模块;行为零变化,HTML 逐行 verbatim(CSS 内两行 JS 风格 // 注释转 CSS 注释);launchMonitor 唯一导出与 registry/core.ts 引用不变 |
| 2026-10-03 | 十三~十六轮:表单行序重排与基本行计数/参数树叶子去 (1)(详见 webview/README);monitor-css-forms 同步(section-header-end/node-action-status 等样式) |
| 2026-10-03 | 十七轮:五区块可折叠(monitor-html 删 lifecycle-sub 静态块)+ 生命周期并入节点区(节点行尾 ▸/▾);monitor-css-base 增 section-header/toggle 骨架 |
| 2026-10-03 | 十八轮:生命周期交互收口(转换后刷新/in-flight 守卫/详情缓存/终端式回执日志区/每节点完整图/易失日志)+ 转换协议键 transitionId(修 rid 覆盖)+ 心跳 socket 每实例路径(修多窗口 24 次互删)+ 助手节点名带启动时间戳;涉及 param-helper-client/monitor-refresh/ros2-monitor,详见 webview/README 与各批提交 |
| 2026-10-03 | 二十轮目录分层:monitor 根 12 文件收两域——page/(宿主 6:ros2-monitor/refresh/html/css-base/css-forms/helper-flows)+ helper/(客户端 4:param-helper-client/protocol/tree-build/helper-state),根位留 monitor-api/status-bar 两 compose 成员;外部引用面 5 处(registry/compose/test)同步;assets/ros **不迁入**(vscodeignore 排 src/** 会丢 vsix,样式表本就在 assets/ros) |
| 2026-10-03 | 十九轮全面修正(审计驱动,用户发起):批1 复制命令引号转义真 bug(shellSingleQuoteForCopy 漂移);批2 死代码清理(helper-state 死导出/CSS sg-* 族/py 死常量);批3 分层微调(dom-utils↛hover-tip、sendLog 迁 context);批4 拆分(param-helper-client 537→448+protocol/tree-build;param_helper.py 902→param_helper_lib 包+薄入口,VM e2e 全链验证);批5 daemon 命名债清算(helperAction/helper-toggle-btn/isHelperRunning)+过期注释 27+ 项;批6 README 三份同步+轮次图例 |
| 2026-10-06 | **重设计阶段 1(原子换血)**:助手从"每窗口私有进程(stdio+pid 后缀 socket 双通道)"改为"**全局唯一服务端+多窗口客户端**,一切帧复用单条固定路径 socket(/tmp/rde_param_helper.sock)";flock 冷启动仲裁/hello 版本握手(F5 残留自愈)/停止=仅断开本窗/非对称心跳(服务端 1s 遥测含 RSS,客户端 2s 存在性)/半死 10s 踢除/零客户端 10s 宽限自退;性能四条(P1 参数事件序列化迁出发送线程/P2 首触 wait 3s/P7 磁盘日志常驻句柄轮转/P10 泄漏清扫)+worker 4→6+内层任务看门狗(40s 警告/120s 自杀);output.py/heartbeat.py 删;VM 探针 10/10 PASS |
| 2026-10-06 | **重设计阶段 2(职责迁移)**:数据整形归 TS——动作分类(lifecycle 三件套)与生命周期发现(get_state 标记)迁 helper/classify.ts 纯函数(补 classify.test.ts),助手交原始服务清单(ops_graph 剥离逻辑删);生命周期转换迁 CLI(Ros2ServiceApi.lifecycle_set 自数字 id 改标签,VM 验证拒绝=退出码 1);ops_lifecycle 瘦到 get+info 且 info 三问并行(P3);Python 9 op→7 op |
