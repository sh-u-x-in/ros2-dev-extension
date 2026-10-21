# helper/ — 常驻助手(Python 服务端)测试之家

> 这个文件夹装着**关于常驻助手(Python 复杂节点)的全部测试资产**:场景脚本、
> 退出码探针、预检遮蔽矩阵、测试节点夹具。为什么存在:2026-10-19 僵尸助手事故
> (扩展宿主重载掐断 stderr 读端 → warn 写入 BrokenPipeError 无声杀死
> housekeeping 线程 → 心跳/踢除/自退全灭的半死服务端)证明——协议正确的代码
> 也会被「环境背叛」杀死,所以这里测的不只是协议,还有**生命周期与鲁棒性**。

## 运行(VM 内,需 ROS env)

```bash
cd /home/ros2/rde-ros-2   # hgfs 同份存储,本地构建/改动即时生效
source /opt/ros/humble/setup.bash
python3 test/vm/helper/_vm_server_test.py --all        # 42 场景主套件
python3 test/vm/helper/_vm_server_test.py --only D8    # 单跑场景
python3 test/vm/helper/_preflight_shadow_test.py       # 预检遮蔽矩阵(F1-F6)
python3 test/vm/helper/_exit_probe.py                  # 退出码探针(SIGTERM/SIGKILL)
python3 test/vm/helper/_x2_probe.py 3                  # CLI 链路诊断探针(N 循环,带全量遥测)
```

## 资产清单

| 文件 | 职责 |
|---|---|
| `_vm_server_test.py` | 42 场景主套件:A 连接注册 / B 数据请求(参数·订阅·批量·表单) / C 图·生命周期 / D 鲁棒性(半死踢除·串行契约·熔断链·flock 竞速·宽限自退·stderr 断管钳) / E 心跳 / F 故障注入(卡转有感) / G 行为客户端 / X 复合(堵转数据流·生命周期并发·负载·域隔离·版本治理杀旧拉新/让位/legacy) |
| `_preflight_shadow_test.py` | 预检遮蔽矩阵 F1-F6:PYTHONPATH 遮蔽 rclpy/rcl_interfaces、孤儿目录遮蔽 lib、对象性质遮蔽(main/disk_log 变非可调用)——断言退出码=100+位掩码且 stderr 结构化报错,**绝不静默** |
| `_exit_probe.py` | SIGTERM(优雅退场)/SIGKILL(强杀)两路退出后图消失计时 |
| `_x2_probe.py` | CLI 链路诊断探针:N 循环复刻 X2 核心(冻结烧灼+订阅+CLI 改参),ros2 调用带全量遥测(耗时/rc/stderr)+daemon 视角+helper 日志尾——2026-10-20 daemon 误杀案的 A/B 实证载体 |
| `nodes/rde_talker.py` | /talker 常驻夹具(替代 demo talker;参数可读写) |
| `nodes/rde_listener.py` | /listener(替代 demo listener) |
| `nodes/rde_lc_talker.py` | /lc_talker 生命周期夹具;`RDE_TEST_HANG_SEC=N` 让 on_configure 挂 N 秒(破坏性:转换超时/服务停摆测试) |
| `nodes/rde_multi_param.py` | /multi_param 12 参全类型+点分命名空间 |
| `nodes/rde_multi_service.py` | /multi_service 三服务(AddTwoInts/SetBool/Trigger) |
| `nodes/rde_action_server.py` | /action_server 动作服务器(Fibonacci,与 get_form 同源类型) |
| `nodes/rde_frozen_node.py` | /frozen_node 普通节点卡死夹具(RDE_FREEZE_AFTER 秒后执行器挂住) |

## 设计规则(增改必读)

1. **测试节点与用户工作空间零耦合**:独立脚本、python3 直跑、不 import 任何
   工作区/demo 包;破坏性行为一律走环境变量开关,默认健康。
2. **多客户端**由 VClient 类承载(A2 三客户端/B9 并发乱序/D5 竞速/行为客户端 G 系),
   新场景需要第二个连接时用 `new_client(tag)`,不要自开 socket。
3. **服务端线程不允许无声死亡**:任何巡检/广播循环的异常必须留痕存活
   (server.py 逐拍守护);D8 场景就是这条规则的钳。
4. 场景自清理:起fixture 的场景要么自灭(lifecycle 参数面零残留),要么在
   收尾恢复健康形态(F6);pkill 模式一律 `[r]` 括号防自匹配。

## 事故史(为什么有这些场景)

| 事故 | 钳 |
|---|---|
| 2026-10-18 P4 握手键名漂移,恒 deny | monitor-api 四键断言 + helper-hello-contract 跨语言契约锁(TS 侧) |
| 2026-10-19 D1 裸 socket 缺 hello,0ms 假踢 | D1 内置 hello 握手 |
| 2026-10-19 D3 flake:lc_pid 捕到速死进程 | ensure_lc_node 前置自愈 + 捕获滤僵尸 |
| 2026-10-19 stderr 断管杀线程 → 僵尸助手 | D8 断管自退钳 + 服务端逐拍守护 + 客户端心跳看门狗 |
| 2026-10-20 clean_slate 误杀活 daemon:X2/X3 假红被误判「产品缺陷」 | daemon 复位 pkill 双模式(连字符+下划线)+ 等真死再清 SHM;`ros2_checked` 承重 CLI 全查 rc(C5/B11/G1-step3 负向断言不再空洞成立);X2 detail 报实测值与 CLI 败因;X3 rc=0 才算 done;setup 开工前 daemon 聋检测报警 |

## 修改记录

| 时间 | 说明 |
|---|---|
| 2026-10-19 23:30 | 建档:两脚本自 test/vm/ 迁入(git mv 保历史),测试节点夹具库建立(6 节点,零工作区耦合,python3 直跑);主套件 demo 依赖全部换仓内夹具(节点名对齐,断言零改动);新增 B13(多参数取全)/F6(生命周期卡转有感);新增预检遮蔽矩阵脚本(F1-F6);背景=僵尸助手事故(见 commit 80c7117 与 CHANGELOG) |
| 2026-10-20 | X2/X3 假红破案与根治:clean_slate 的 daemon 复位 pkill 模式下划线/连字符错配(从未命中)+SHM 卫生误删活 daemon 传输段(聋而未死,CLI 秒败 Node not found→参数事件/转换从未发生);修=双模式并杀+轮询等真死再清段;新增 `ros2_checked`(承重 CLI 查 rc,负向断言防假过)+setup daemon 聋检测+X2/X3 detail 诚实化;`_x2_probe.py` 诊断工具入库(A/B 实证载体);背靠背全量×2 为回归锁 |
