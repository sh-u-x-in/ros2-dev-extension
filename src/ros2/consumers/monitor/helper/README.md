# helper/ — 常驻助手客户端(共享服务端形态)

> 扩展侧与常驻助手服务端(`assets/ros/param_helper.py`,rclpy 常驻进程)对话的客户端。
> 2026-10-06 重设计:**全局唯一助手服务端 + 多窗口客户端**——一切帧复用一条固定路径
> Unix socket,一行 JSON 一帧,信封 `{client,id,time}`(上行)/`{service,time,cl-num}`(下行)。
> 2026-10-18 P4:**上行首帧=hello 环境指纹握手**(proto+四环境键,不匹配 deny 踢除+客户端熔断)。
> 历史:2026-09-26 初版为"每窗口私有进程,stdio 业务 + pid 后缀 socket 心跳"双通道;
> 双通道与逐实例隔离随共享服务端形态整体退役(多窗口互删问题的解法从"各自隔离"升级为"服务端仲裁")。

## 传输与端点

- **socket**:`/tmp/rde_param_helper.sock`(固定知名路径;`param-helper-protocol.ts` 的 `HELPER_SOCKET_PATH` 与 `kernel.py` 的 `SOCKET_PATH` 两侧同值,**契约测试锁逐字节对账**);
- **锁**:`/tmp/rde_param_helper.lock`(flock 冷启动仲裁:spawn 竞速败者立即退 0,进程死亡内核自动放锁,永无陈锁;锁文件四字段 pid/启动时刻/启动 ticks/**扩展版本**,ticks=杀前验尸防 pid 复用,版本=杀旧拉新治理——格式与比较规则见冻结规范 **[VERSION-CONTROL.md](VERSION-CONTROL.md)**);
- **协议版本**:`rde-helper/1`(`HELPER_PROTO_VERSION` ↔ `kernel.PROTO_VERSION`,契约锁同上);不符 → 服务端 deny+踢除,客户端 tripFailure 熔断;
- **环境指纹键**:`HELPER_FINGERPRINT_KEYS`(ROS_VERSION/ROS_DISTRO/ROS_DOMAIN_ID/RMW_IMPLEMENTATION)↔ `kernel.py:33`,wire 键=全小写(派生),未设归一 "0"——**2026-10-18 键名漂移恒 deny 事故后全链路契约锁死**(test/suite/helper-hello-contract.test.ts)。

## 帧(一行 JSON,信封+载荷键分流)

| 帧 | 方向 | 路由 | 说明 |
|:--|:--|:--|:--|
| `hello{proto,env}` | C→S | — | 连接**首帧**(信封 client/id/time);proto 或指纹不符 → `deny` 并踢除;3s 未发 hello 亦踢(无 deny,静默) |
| `deny{reason}` | S→C | 单发 | 握手拒绝(proto 违规/指纹失配,失配含逐键明细 client='x' server='y');客户端收到即 tripFailure 熔断 |
| `request{op,...}` | C→S | 进池 | 业务请求信封 `{client,id,time,request}`;`ping` 不进池就地应答 |
| `response{client,id,time,success,data\|error}` | S→C | 按 id 匹配 | 孤儿响应(断线迟到/无 pending)丢弃并留痕;信封 service/time 顺带更新服务端 pid/启动时刻 |
| `heartbeat{busy,q[],inf,brk,eq,rss}` | S→C | 广播 1s | 服务端遥测(20ms 采样窗口均值);**只发已验证连接** |
| `push{kind:graph\|param\|param_structure\|lifecycle,...}` | S→C | 广播/定向 | 图全量与增量、参数名册/变化、生命周期;同样只发已验证连接 |

- 单帧上限 20MB(防爆炸断路器);每连接独立发送队列(64 帧)+写线程;
- **在线语义 = resync 回应到达**(非 ping、非 hello;hello 只过协议关,resync 拉全量快照才算就绪)。

## 生命周期(双向看门狗 + 自愈 + P4 熔断)

- **hello 握手(P4)**:首帧强制 hello;指纹=服务端 run() 启动时自 os.environ 算一次,客户端值=envFacade 快照(spawn 注入同源);不匹配 deny(含键明细)+踢+客户端熔断;
- **客户端看服务端**:在线后 5s 无任何帧 → 读锁文件 pid+启动 ticks 核对(防 pid 复用)→ SIGKILL → 重连/重拉;
- **服务端看客户端**:连接断开即感知;半死 10s 踢除;**已验证连接归零 + 宽限 10s → 服务端自退**;
- **停止 = 仅断开本窗连接**:共享服务端可能有别的窗口在用,客户端绝不 SIGKILL 服务端;
- **P4 失败熔断**:spawn 前环境门(门关绝不 spawn);预检退出码 100+位掩码 → 立即熔断;瞬态失败 3 次 → 熔断;deny → 立即熔断——熔断=自动停(desiredRunning 复位、零重连重拉),原因经 failureCallback 直达页面,用户再点 Start 复位;
- **启动确认窗三态**(2026-10-18):startHelperFlow 等 15s,熔断(tripped,快速终结不发误导超时文案)/被更新的启动或停止接管(superseded,静默)/超时(timeout,通用文案)/达成(ok);
- spawn 后 15s 未在线 → 判僵杀掉走退避(1s→30s 封顶);flock 竞速败者退出码 0,客户端识别后直连胜者,不烧退避。

## 职责划分(重设计裁定:"常驻才留 Python,数据整形归扩展")

- **助手(Python)留守**:图差分与增量事件、params/save、lifecycle_get/info(轮询型)、表单内省(rosidl 只能 Python)、僵尸服务过滤(依赖内部观察状态)、熔断(**节点级**:任一服务超时=整个节点开断 30s/3s 探测,单 attempt)/缓存/心跳/看门狗;
- **扩展(TS)接管**:动作分类与生命周期发现(`classify.ts` 纯函数,从原始服务清单推导)、生命周期转换(CLI `ros2 lifecycle set <node> <label>`,拒绝=非零退出码,2026-10-06 VM 实机验证)、参数取值编排(阶段 3)、增量贴补与重同步(阶段 3)。

## 模块

| 文件 | 职责 |
|:--|:--|
| `param-helper-client.ts` | 连接维护(connect-first/spawn 兜底/竞速容忍)、hello 握手、帧路由、请求 id 匹配(30s 默认/ping 3s/resync 15s)、看门狗、启停与熔断(代数/失败信号 `helperFailureSignal`)、测试缝(setSocketFactoryForTest/_resetForTest) |
| `param-helper-protocol.ts` | 帧类型与业务数据形状(纯类型)+ socket/锁路径/协议版本/**指纹键表**(跨语言契约,契约测试锁) |
| `classify.ts` | 图分类纯函数:separateActions(动作三件套聚合)/detectLifecycleNodes(生命周期发现) |
| `param-tree-build.ts` | 扁平参数映射 → 参数树(纯函数) |
| `helper-state.ts` | 在线状态唯一事实源(写=resync 回应生命周期;读=状态栏) |

## 修改记录

| 时间 | 说明 |
|---|---|
| 2026-10-18 23:59 | **键名漂移恒 deny 事故修复+契约测试网(三波代理红队/验证)**:①hello.env 键改服务端全小写全名(键表派生自 HELPER_FINGERPRINT_KEYS,禁手写),sendHello 补 HelperHelloFrame 类型收口;②熔断快速失败——startParamHelper 返回代数+helperFailureSignal 探针,确认窗三态(ok/timeout/tripped/superseded),deny 不再傻等 15s 报误导超时,重入 start/stop 由代数仲裁旧窗静默;③客户端小加固=socket 会话身份守卫(onConnect/onData/onClose+resync 续体罩 graph push)/trip 清 frameBuf/serverPid/proc exit 属主守卫/_resetForTest;④服务端 deny reason 带失配键明细;⑤新套件 helper-hello-contract 36 例=跨语言契约锁(源码提取对账)+事故墓碑+真值表+全帧+deny 行为+三态;⑥本 README 协议段重写(P4 后整体过时) |
| 2026-10-18 (P4) | hello 指纹握手上线(proto+四环境键,deny+踢除+熔断)、spawn 环境闸、预检位掩码 100+mask、熔断自动停(瞬态 3 次/预检立即)、确认窗 15s——本批 born-bug(客户端短键名)由上行业务回归发现,契约网即为其根治 |
| 2026-10-06 | 重设计阶段 1+2:单 socket 帧协议定稿(本档即协议规格);共享服务端形态;职责迁移(分类/发现/转换离场 Python);测试缝 stdio→socket 假服务 |
