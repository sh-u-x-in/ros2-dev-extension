# helper/ — 常驻助手客户端(共享服务端形态)

> 扩展侧与常驻助手服务端(`assets/ros/param_helper.py`,rclpy 常驻进程)对话的客户端。
> 2026-10-06 重设计:**全局唯一助手服务端 + 多窗口客户端**——所有帧(请求/响应/心跳/事件/遥测)
> 复用一条固定路径 Unix socket,一行 JSON 一帧、首字段 `t` 分流。
> 历史:2026-09-26 初版为"每窗口私有进程,stdio 业务 + pid 后缀 socket 心跳"双通道;
> 双通道与逐实例隔离随共享服务端形态整体退役(多窗口互删问题的解法从"各自隔离"升级为"服务端仲裁")。

## 传输与端点

- **socket**:`/tmp/rde_param_helper.sock`(固定知名路径;`param-helper-protocol.ts` 的 `HELPER_SOCKET_PATH` 与 `kernel.py` 的 `SOCKET_PATH` 两侧同值);
- **锁**:`/tmp/rde_param_helper.lock`(flock 冷启动仲裁:spawn 竞速败者立即退 0,进程死亡内核自动放锁,永无陈锁;锁文件记 pid/启动时刻,存活阶梯第三级验尸用);
- **协议版本**:`PROTOCOL_VERSION = 1` 两侧同值;hello 不匹配 → 服务端回 `bye` 并断开,客户端读锁文件 pid → SIGKILL 旧服务 → 重拉(F5 残留自愈)。

## 帧(一行 JSON,`t` 分流)

| 帧 | 方向 | 路由 | 说明 |
|:--|:--|:--|:--|
| `hello{c,v}` | C→S | — | 连接首帧;c=客户端标签(exthost pid),v=协议版本;hello 前的任何帧=协议违规断开 |
| `hello_ack{p,up,v,gen,cl}` | S→C | 单发回执 | p=服务端 pid(看门狗处决用);gen=世代(进程启动 ms,识别重启);在线语义=收到 hello_ack |
| `req{id,op,...}` | C→S | 进池 | 业务请求;`ping` 不进池就地应答积压再重也秒回 |
| `resp{id,ok,data\|error}` | S→C | **只回发起连接** | id 匹配;孤儿响应(断线迟到/世代更替)丢弃并留痕 |
| `event{event_type,data}` | S→C | 广播 | graph_change/param_change/events_lost(阶段 3 增 lifecycle_state 与带类型增量) |
| `shb{p,up,gen,cl,ver,busy,q[],inf,brk,eq,rss}` | S→C | 广播 1s | 服务端遥测:连接数/图版本为即时值;busy/q[]/inf/brk/eq/rss 六项为 **20ms 采样窗口均值**(加权监测,用户裁定——瞬时快照把尖峰定格成整秒状态) |
| `chb{}` | C→S | 就地登记 | 客户端存在性(2s 一发;10s 收不到=半死踢除) |
| `bye{reason,v}` | S→C | — | 版本不符逐客帧 |

- 单帧上限 20MB(防爆炸断路器;超限 resp 转错误/事件丢弃);
- 每连接独立发送队列(64 帧)+写线程(序列化不占 worker;慢客户端只丢自己不拖累广播)。

## 生命周期(双向看门狗 + 自愈)

- **客户端看服务端**:握手后 5s 无任何帧 → 按 hello_ack 的 pid(或锁文件)SIGKILL → 重连/重拉;
- **服务端看客户端**:连接断开即感知;半死(chb 超时 10s)踢除;**连接归零 + 宽限 10s → 服务端自退**(最后一个客户端关门时服务端跟着走,谁开页谁拉起);
- **停止按钮 = 仅断开本窗连接**:共享服务端可能有别的窗口在用,客户端绝不 SIGKILL 服务端;
- spawn 后 15s 未握手 → 判僵杀掉走退避(1s→30s 封顶);flock 竞速败者退出码 0,客户端识别后直连胜者,不烧退避。

## 职责划分(重设计裁定:"常驻才留 Python,数据整形归扩展")

- **助手(Python)留守**:图差分与增量事件、params/save、lifecycle_get/info(轮询型)、表单内省(rosidl 只能 Python)、僵尸服务过滤(依赖内部观察状态)、熔断(**节点级**:任一服务超时=整个节点开断 30s/3s 探测,单 attempt)/缓存/心跳/看门狗;
- **扩展(TS)接管**:动作分类与生命周期发现(`classify.ts` 纯函数,从原始服务清单推导)、生命周期转换(CLI `ros2 lifecycle set <node> <label>`,拒绝=非零退出码,2026-10-06 VM 实机验证)、参数取值编排(阶段 3)、增量贴补与重同步(阶段 3)。

## 模块

| 文件 | 职责 |
|:--|:--|
| `param-helper-client.ts` | 连接维护(connect-first/spawn 兜底/竞速容忍)、帧路由、请求 id 匹配(30s 超时)、看门狗、启停、测试缝 `setSocketFactoryForTest` |
| `param-helper-protocol.ts` | 帧类型与业务数据形状(纯类型)+ 协议版本/socket 路径常量 |
| `classify.ts` | 图分类纯函数:separateActions(动作三件套聚合)/detectLifecycleNodes(生命周期发现) |
| `param-tree-build.ts` | 扁平参数映射 → 参数树(纯函数) |
| `helper-state.ts` | 在线状态唯一事实源(写=握手生命周期;读=状态栏) |

## 修改记录

| 时间 | 说明 |
|---|---|
| 2026-10-06 | 重设计阶段 1+2:单 socket 帧协议定稿(本档即协议规格);共享服务端形态;职责迁移(分类/发现/转换离场 Python);测试缝 stdio→socket 假服务 |
