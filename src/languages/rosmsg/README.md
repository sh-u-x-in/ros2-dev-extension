# src/languages/rosmsg/ — ROS 消息接口语言服务模块

> 本目录为 languages 域最老、先实行的模块:能力与设计决策沉淀最早,部分信息曾被代码头部注释"吸收"——本 README 将这些信息独立出来并补全(2026-09-03 独立/完善)。
> 定位:对 .msg/.srv/.action(rosmsg 语言,别名 "ROS Interface")提供结构解析、消息索引、跳转/悬停/链接、类型补全、格式化、诊断;语义 token 已禁用(见 §6)。

## 1. 模块接线(组合根视角)

| 项 | 现状 |
|:--|:--|
| 注册 | extension.ts registerRosMessageProviders(context)(仅激活一次,不随环境重注册) |
| 实例 | MessageIndex(data/message-index.ts 门面,组装 WorkspaceIndex + SystemIndex)在注册处创建,5 类提供器共享 |
| 事件 | 系统索引重建 = 事件链(core.refreshSystem → ev.system → PackageMap.onSystemListChanged,2026-09-04 C 收尾);配置变化 → 刷新间隔动态生效 |
| 文档 | 结构:本 README;审计/修复:同目录 02-rosmsg模块审计.md |

## 2. 目录结构与文件清单(2026-09-04 按模块重组,git mv 保历史;13 TS + 2 MD)

> 外部只经域出口 index.ts import;内部分层:shared(纯共享)/ parse(纯解析)/ ui(提供器)/ data(索引服务)。

| 目录 | 文件(行数) | 职责 |
|:--|:--|:--|
| 根 | index.ts(7) | 域唯一出口:registerRosMessageProviders + MessageIndex + 类型 |
| shared/ | interface-data.ts(43) | BUILTIN_TYPES(17)/COMMON_PACKAGES(9)/isBuiltinType(byte/char 已标注废弃,2026-09-04 R14) |
| parse/ | rosmsg-document.ts(333)· formatter.ts(262)· semantic-token-builder.ts(51) | 纯结构解析(含 invalidLines/getCompletionContext)/ 格式化纯函数 / token 数据纯函数(R13 后无运行消费者,单测保留) |
| ui/ | providers.ts(622)· completion-provider.ts(222)· diagnostic-provider.ts(212) | 4 类提供器 + 注册(注入共享 PackageMap)/ 两段式补全 / 诊断(analyzeDocument 纯逻辑可测) |
| data/ | tables.ts(三表核心)· message-index.ts(门面)· workspace-index.ts(工作区子索引)· system-index.ts(系统子索引)· types.ts(常量/类型/载荷) | tables = **写线三表 + 读线两表 + 四个事件 + op 流**(纯 TS,可无头测);工作区子索引 = 包表消费(R1/R2/R3)+ .msg 事件接线 + 兜底重扫 + 节流 + 缓存;系统索引 = interface_list/二分/缓存 |
| 根 | 02-rosmsg模块审计.md · README.md | 审计+修复记录(2026-09-03)/ 本文件 |

## 3. 数据流与分层数据源(自代码头部注释提炼)

### 3.1 三层消息来源

| 层 | 内容 | 来源 | 备注 |
|:--|:--|:--|:--|
| 内置 | 17 内置类型 + 9 常用包 | shared/interface-data.ts 静态 | 离线可用 |
| 工作区 | 工作区 .msg(合法/非法哨兵行) | 自定义 walk(不跟随符号链接 + 双超时 + 任意层级产物排除)+ .msg watcher 增量(+ rename 补盲);**三张表 + op 流**(2026-09-13) | 包表来源 = PackageMap 注入(R1 快照/R2 就绪/R3 原子事件);归属判定枚举祖先链 |
| 系统 | 系统消息(ros2 interface list) | Ros2ServiceApi.interface_list(2026-09-03 R4,删裸 cp.exec;环境门控 getEnvIssue) | 仅 .msg;有序数组二分;磁盘缓存版本 v5(2026-09-25 RM-1:增带路径登记 pkgMsgFiles/pkgMsgDirs,触碰时整包 .msg 路径入档) |

### 3.2 查询链(定义/悬停/链接;2026-09-13 三张表重构:删除 walk 兜底——索引即权威)

1. 带包名 → 正表精确命中(内层二分,零扫描);
2. 裸名 → 反表点查当前文件定本包 → 正表按名查;miss 补登(当成一次消息增加落库)后重查(v3 §5.3);
3. 仍未中 → 经 PackageMap.resolvePackageDir 解析包目录,按 `pkg/msg/Name.msg` 标准布局点查(系统包懒取目录;不再 walk)。

### 3.3 刷新/失效时机

| 时机 | 动作 |
|:--|:--|
| 文档关闭/变化 | parseMessageFile 缓存条目删除(uri 键) |
| 环境变化(onDidChangeEnv) | 系统索引全量重建(R5;环境未就绪自动跳过) |
| 配置变化 | ROS2.msg.systemRefreshMinutes 动态生效(setRefreshIntervalMs,R5) |
| .msg 增删改 | watcher → **消息增加/删除事件**(写线 → op → 读线)+ 写盘防抖 500ms |
| .msg 移动/改名 | `onDidRenameFiles` → 旧路径删 + 新路径增(2026-09-09;整目录移动若只报文件夹对,兜底 = 兜底重扫/包事件自愈) |
| package.xml 增删改/改名 | package-core workspace 域变化 → PackageMap 差量【拆碎投递】(onPackageAtom)→ **新增包认领 / 删除包包级继承**(不再全量重扫) |
| 兜底重扫(节流) | ROS2.msg.workspaceRescanMs(默认 60s)——**启动不开;首次打开 .msg 才开;关窗冻结(计时不归零)**;超时不收敛 |
| 系统索引惰性 | 查询时 ensureSystemFresh(超 refreshMs 才重建) |

## 4. 关键设计决策记录(独立自代码注释,按日期)

| 日期 | 决策 | 出处/现状 |
|:--|:--|:--|
| 2026-08-16 | semantic token 覆盖 TextMate 致配色时序错乱 → 禁用(provider 空注册) | 2026-09-03 R13 已删空注册文件,TextMate(grammar 移 snippets/)统一负责 |
| v3→v4 | 系统索引键格式:仅 .msg → 三段 pkg/msg/Name → v4 剥中段存二段 pkg/Name | message-index.ts CACHE_VERSION=4;R1 修复贯通诊断误报/命中失效/补全清空三症状 |
| 2026-08-30 | 兜底自遍历移除:无 package-core → warn 跳过,不自走 walk + 真包判定 | message-index/refreshPackageNames |
| 2026-09-01 | Ros2ServiceApi null 契约(失败 null,[]/""=成功但空) | interface_list 返回 null 处理 |
| 2026-09-02 | 包数据收编:读 package-core workspace 域(合法真包,含被忽略包) | refreshPackageNames 注释(批3① + 去 src) |
| 2026-09-03 | R1/R2(部分)/R3/R4/R5/R8/R11/R12/R13 修复落地 | 02 审计 §七;本 README §3 |

## 5. 配置项

| 键 | 默认 | 说明 |
|:--|:--|:--|
| ROS2.msg.systemRefreshMinutes | 10(分钟) | 系统索引惰性重建间隔(运行中修改生效,R5) |
| ROS2.msg.formatGradientStep | 11 | 格式化梯度分档步长(对齐) |
| ROS2.msg.formatLineThreshold | 60 | @optional 单/双行切换阈值 |
| ROS2.msg.workspaceRescanMs | 60000 | 工作区强制重扫周期(2026-09-04 R10:自有键,不再越域读 colcon);0=禁用 |

## 6. 现状要点与遗留

- ✅ 已修复(2026-09-03):R1 系统索引键 / R4 命令域收编 / R5 环境与配置事件 / R2 重扫单飞 / R3+R8 包过滤 / R11+R12 诊断口径 / R13 语义高亮死链;
- ⚠️ 未修(第一批范围外):R6 死守卫、R10 越域配置键、R14 byte/char 口径;
- ✅ 2026-09-09 00:16:`.msg` rename 补盲——订阅 `workspace.onDidRenameFiles`(Explorer 拖拽/F2 目录移动对 glob watcher 常漏报),rename → 旧路径 remove + 新路径 upsert 增量;整目录仅报文件夹对/多根边缘仍由周期重扫与 core 域事件全量重扫自愈(R7 文件级部分闭环);
- ✅ 2026-09-03 23:16:PackageMap.resolvePackageDir(可等待懒取)落地,rosmsg providers 经共享实例接入(组合根注入),兑现 2026-08-23《优化-系统包访问统一入口》;launch XML 链接同批切共享实例(05 task3);
- ✅ 2026-09-03 2026-09-03 23:52:事件源收编落地(R2 闭环)——删自持 package.xml watcher / refreshPackageNames / handlePackageXmlEvent / packageNameByDir,名单实时读门面 + 订阅 core.onDidChange(workspace 域)重扫;仅留 .msg watcher;
- ✅ 2026-09-04(G2 已于 01:05 修复,extension 直挂 core.onDidChange):watcher 事件加产物目录过滤(①)/ 增量并入单飞链(②,单写者)/ 多根扫描(④)/ 重扫周期自有键 ROS2.msg.workspaceRescanMs(⑤ R10)/ 死守卫清理(③ R6)/ byte-char 已废弃口径统一(⑥ R14);
- ✅ 2026-09-13 15:49:**三张表 + 四个事件 + op 流重构**(rosmsg-v3.md 全量落地)——写线(正/反/包表)与读线(两表副本,只经 op 同步)分离;包表来源改 PackageMap 原子事件(R3)推送,包变化不再全量重扫(新增包反表前缀扫认领/删除包包级继承/改名 = remove+add);裸名解析删 walk(反表点查 + 补登);系统包悬停不再白跑 walk;兜底重扫落节流三规则;缓存 v4 正表快照;新增 rosmsg-tables 测试套件;
- 剩余:watcher 事件未覆盖用户自定义排除(search.excludeFolders,仅默认产物集);PackageMap 系统可执行属 launch 专区待决(见 launch/README)。

## 7. 测试覆盖

10 套件:rosmsg-tables(新增:三表/四事件/op 流/读写一致性)/ rosmsg-document / rosmsg-formatter / rosmsg-diagnostics / rosmsg-samples-parser / rosmsg-samples-providers(R10 适配 PackageMap 注入)/ message-index-cache(v4 正表快照,重写)/ semantic-token-builder / ros-msg-providers(旧大套件)/ package-map(补原子事件用例)。缺口:parseMessageFile 缓存/磁盘读写/ensureSystemFresh 无直接单测(类同旧)。

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-03 23:10 | 建档(独立/完善):将散于代码头部注释与历次修复中的 rosmsg 模块信息独立为本 README——文件清单(当前行数/职责)、三层数据源与查询链、刷新时机、设计决策记录(v3→v4/R1-R13)、配置项、现状与遗留、测试覆盖;关联 02-rosmsg模块审计.md |
| 2026-09-03 23:16 | resolvePackageDir 接入:providers 经组合根共享实例(sharedPackageMap),删除本地 pkg_list/pkg_prefix(原 resolvePkgFilter 整体移除);系统包目录 = 触发懒取并等待(单飞 + 缓存);§3.2/§6 同步 |
| 2026-09-03 23:52 | 瘦身(R2 闭环):删自持 package.xml watcher + refreshPackageNames/handlePackageXmlEvent/packageNameByDir;名单实时读门面(workspaceNameByDir)+ 订阅 core.onDidChange(workspace 域)重扫;仅留 .msg watcher;增量/查询同口径,R7 rename 残留顺带缓解 |
| 2026-09-04 01:23 | 小问题批次修复(①②③④⑤⑥):watcher 事件产物目录过滤(isProductPath,DEFAULT_EXCLUDED_DIR_NAMES)/ 增量并入单飞链(enqueue 单写者,消竞态)/ 多根全文件夹扫描/ 重扫周期自有键(去 colcon 越域)/ 死守卫清理 / byte-char 废弃口径(hover 提示);tsc 0 错误 |
| 2026-09-04 01:36 | 结构重组(git mv,拆长文件):按模块分组 shared/parse/ui/data + 域出口 index.ts;data/message-index.ts 828 行拆四——types.ts(115)/workspace-index.ts(387)/system-index.ts(195)/message-index.ts(门面 133);extension/测试 import 全改经新路径或 index;tsc exit=0 |
| 2026-09-04 16:56 | 事件链收尾(C):删 rosmsg 对 ros2 环境域直连(ui/providers 原 composeApi.environment.onEnvChanged、data/system-index 原 getEnvIssue 门控)——系统刷新触发改经 PackageMap.onSystemListChanged(无共享实例时退 core.onDidChange ev.system),门控改注入 envAvailable(= packages.systemAvailable,core.system 域就绪);extension 侧路删、core ev.system → acceptSystem 喂入共享 PackageMap;tsc 0 错误 |
| 2026-09-09 00:16 | **`.msg` rename 补盲(用户探查:整目录移动漏订阅是否广泛)**:`setupWorkspaceWatcher` 增订阅 `vscode.workspace.onDidRenameFiles`——两端口任一是 `.msg` → 旧路径 `removeWorkspaceEntry` + 新路径 `upsertWorkspaceEntry`(与全量同链串行,单写者无竞态);新增 `isMsgUri`/`renameSub` 字段与 dispose;文件头/§3.1/§3.3/§6 同步;整目录移动只报文件夹对(逐文件对缺失)时兜底 = core ev.workspace → refreshWorkspace 全量重扫,正确性不依赖本增量 |
| 2026-09-13 15:49 | **三张表 + 四个事件 + op 流重构落地(`手工重设计/rosmsg-v3.md`;比对报告 = `手工重设计/rosmsg-v3-代码比对-2026-09-13.md`)**:新增 `data/tables.ts`(写线 IndexWriter 正/反/包表 + 读线 IndexReader 两表副本 + 消息增删/包增删四事件 + op 类型;纯 TS 可无头测);`workspace-index.ts` 全重写(包表来源 = 注入 PackageSource:PackageMap R1 快照/R2 就绪/R3 原子事件;先订阅再快照后重放;op 分发:小批量读线 apply、大批量整表批替换;兜底重扫超时不做收敛;节流三规则落地;缓存 v4 = 正表快照);`message-index.ts` 门面换读线查询 + 新方法 findMessage/findBareNameDefinition;`providers.ts` findMessageDefinitions 删除 walk 兜底(带包名 → 正表二分 + 标准布局点查;裸名 → 反表点查 + 补登;系统包不再白跑 walk)+ 节流接线(onDidOpen/onDidClose);`shared/package-map.ts` 新增 PackageAtomEvent 原子事件流(diff 键 = (名,路径) 有序对;先 remove 后 add)+ getWorkspaceEntries/workspaceReady + initialize 幂等;新增测试 rosmsg-tables(四事件/op 流/读写一致性)、重写 message-index-cache(v4)、package-map 补原子事件用例、R10 用例适配注入;tsc 0 错误 |
| 2026-09-13 16:22 | **工作区外文件不补登(v3 附录 E 定案①)**:`enrollFile` 加 `isInWorkspace` 闸(路径前缀比较,不依赖 uri scheme/Remote 兼容,Windows 大小写容错);`findBareNameDefinition` 对工作区外文件直接短路(补全/裸名/跳转仅查询能力,不入非法桶、不污染磁盘缓存);新增 R10b 回归用例(工作区外 .msg 探测 → 断言不解析/不登记);v3 同步 §5.1 宿主两路注(.msg 反表点查 vs .srv/.action 枚举祖先,附录 E 定案②)/§5.3 补登两个排除注/附录 E 两条 ✅ 标注;全量 660 项:自引入失败 0,剩 13 项既有基线不变 |
| 2026-09-25 18:10 | RM-1 系统带路径懒登记(用户指令:完成工作区外面的补充登记):SystemIndex 增 pkgMsgFiles/pkgMsgDirs(触碰某系统包时一次 readdir share/<pkg>/msg,整包 .msg 路径登记,按包单飞+随系统缓存落盘,CACHE_VERSION 4→5)+ registerPackagePaths/systemEntryWithPath/applySystemSnapshot(注入名单快照)+ 名单变化修剪;PackageSource 增可选 resolvePackageDir(PackageMap 结构化满足);MessageIndex.findMessageWithSystemPath(工作区优先→登记→带路径条目);ui findMessageDefinitions ① 步接线(系统登记命中即跳,点查兜底保留)。设计对照 rosmsg-v3 §5.4:名单仍由 interface list 供给,路径从"请求时拼"升级为"触碰时登记"。5 条新测试 |
| 2026-09-29 | 文档勘误:§3.1 系统行缓存版本 v4→v5 对齐 RM-1(正文漏改);修改记录 RM-1 行并回主表(此前误挂独立小表,表头重复) |

| 2026-09-30 16:32 | **RE-1 诊断接电(设计 03-诊断接电.md;用户:同包裸字段有支持却报未知/启动刷屏)**:①未知消息类型三级判定(索引点查 → findMessageWithSystemPath 系统懒登记 → 标准布局 FS 点查,与 hover/跳转同源口径;裸名仅同包)——消除"打开瞬间索引未就绪即判未知"时序误报;②重算接电:index.initialize() 就绪后 + 系统刷新链(防抖 1s)调用 reanalyzeAll,过期警告自动清除;③跳过日志聚合(设计约定保留,用户裁定):同 scheme 首条 debug 后续降 trace,Chat 快照刷屏消失;④registerRosMessageDiagnostics 增 packages 参数、返回 {disposables, reanalyzeAll};analyzeDocument 改 async(头测同步 async 化 + 3 新用例);全量 1195 测试 0 失败 |
<!-- 文件末尾修改时间:2026-09-30(RE-1 诊断接电,详见上表 2026-09-30 行) -->
