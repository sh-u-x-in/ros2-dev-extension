# src/languages/rosmsg 模块审计报告(2026-09-03 21:47 建档)

- 对象:src/languages/rosmsg/(9 文件 2582 行),.msg/.srv/.action 消息接口语言服务:结构解析、消息索引(工作区 + 系统)、跳转/悬停/链接/补全/格式化/诊断/语义 token
- 背景:工作空间大面积重构(ros2/api 统一出口含 interface_list、package-core 门面 + 事件、walk 统一、null 契约改造)后现状复核;对照 src/languages/shared/package-map.md(2026-08-31 建档,记录断链与收编中间态)
- 精度:文件级 + 关键函数级,证据给 文件:行号;核心 bug 链(R1)已逐行核验

---

## 一、模块总览(现状复核)

| 文件 | 行数 | 职责 / 主要导出 | 类属 | 结论 |
|:--|:--|:--|:--|:--|
| providers.ts | 616 | 组合面:parseMessageFile + 模块级解析缓存(FIFO 100)、findMessageDefinitions(索引优先 + walk 兜底)、Definition/Hover/DocumentLink/Formatter、registerRosMessageProviders(550) | UI 提供器 + 编排 | ⚠️ 面过大:解析/缓存/查找/4 类 provider/注册单文件承载,未子目录化 |
| message-index.ts | 759 | MessageIndex:工作区 .msg 索引(包名映射经 getPackageCore 门面)+ 自持双 watcher + 磁盘缓存;系统索引(ros2 interface list → 排序数组 + 前缀二分) | 数据服务 | ❌ 数据源杂交(门面 + 自持 watcher + 裸 cp.exec + 自造缓存),R1 键格式 bug |
| rosmsg-document.ts | 334 | 纯结构解析 parseRosMessageDocument(分段/字段/常量/分隔线校验)+ getCompletionContext | 纯解析 | ✅(仅依赖 vscode TextDocument 类型) |
| completion-provider.ts | 223 | 两段式补全(无 /:6 层;有 /:包内消息)+ 惰性 ensureSystemFresh | UI 提供器 | ✅ 结构清晰(受 R1 连累) |
| diagnostic-provider.ts | 203 | analyzeDocument(导出供单测)+ registerRosMessageDiagnostics(500ms 防抖) | UI 提供器(规则纯函数可测) | ⚠️ 自推包名与 index 口径不一致(R11) |
| formatter.ts | 263 | formatRosMessageContent 纯函数(梯度分档 + @optional 单/双行) | 纯函数 | ✅ 单测完备 |
| semantic-tokens.ts | 50 | provider 类存在;registerRosMessageSemanticTokens 为空操作(:47-49) | 死链 | ⚠️ 禁用态仍在装配链(R13) |
| semantic-token-builder.ts | 52 | buildSemanticTokenData 纯函数 | 纯函数 | ✅(无运行消费者,单测保留) |
| interface-data.ts | 44 | BUILTIN_TYPES(17)/COMMON_PACKAGES(9)/isBuiltinType | 静态数据 | ⚠️ byte/char 已废弃仍作内置文档(R14) |

注册口:组合根 extension.ts:33,272 registerRosMessageProviders(context)(仅注册一次,不随环境变化重注册)。

## 二、依赖审计(出边 / 入边)

| 方向 | 源 | 目标 | 判定 |
|:--|:--|:--|:--|
| 出边 | providers.ts:8 | ../../build-tool/walk(barrel) | ✅ |
| 出边 | providers.ts:9-10 | ../../ros2/api(composeApi + Ros2ServiceApi 类型) | ✅ api barrel |
| 出边 | message-index.ts:16 | ../../build-tool/package-core/api(getPackageCore 门面) | ✅ |
| 出边 | message-index.ts:18 | ../../build-tool/walk | ✅ |
| 出边 | message-index.ts:14 | child_process(裸 cp.exec ros2 interface list) | ❌ 模式违背(R4) |
| 入边 | extension.ts:33,272(组合根) | providers | ✅ |
| 入边 | test/suite 8+1 套件(见 §五) | 域内纯函数/MessageIndex | ✅ |

红线核查:无 import ../extension、无 ros2 内部实现文件、无 package-core 内部文件(仅门面)✅;唯一模式违例 = message-index.ts:522 裸 cp.exec 绕开命令域(R4)。

## 三、逐文件发现清单(核验通过)

### message-index.ts

| # | 级别 | 类别 | 位置 | 描述 |
|:--|:--|:--|:--|:--|
| R1 | P1 | 潜在 bug(键格式断裂) | :499-505;:725-731;SystemCacheFile 注释 :51-54 | refreshSystemFull 把三段键 pkg/msg/Name 原样存入 systemSorted(仅过滤 msg 中段,未剥除);systemEntryFromKey 只按首个 / 切分 → entry.name = msg/String(注释自称存 pkg/Name 二段,代码与注释矛盾)。症状三连:① diagnostic-provider.ts:110 e.name===name 判已知 → 系统类型恒误报"未知消息类型";② providers.ts:132-133 索引命中比较 entry.name===messageName → 系统类型永不命中(坠回全量 walk);③ completion-provider.ts:192 entry.name.startsWith(namePrefix) + :188 label=pkg/msg/String → 输入 std_msgs/S 后列表清空、空前缀时插入含 msg/ 的错误类型文本。R14 测试仅空前缀未暴露。修复:systemSorted 改存二段 pkg/Name(剥 msg/ 段),一处贯通三症状 |
| R2 | P1 | 重复/模式违背 | :359-377(packageXmlWatcher),:239-251,:254-291 | 真包判定已收编门面(:209-227 读 getPackageCore workspace 域),但仍自持 packageXmlWatcher 与 package-core event/fs-watcher 重复监听 **/package.xml;handlePackageXmlEvent 每次触发全量 .msg walk;delete 分支(:243-245)只删本地映射一目录、不读 core 新态;全程不订阅 core.onDidChange;4 处事件入口(:187/:193/:247/:459)无单飞,可能并发重扫。对照 shared/package-map.md §3:统一事件化已被判"暂缓",现状即中间态,但 delete 漂移属真实缺口 |
| R3 | P1 | 低效 | providers.ts:158-185(被 provider 侧引用) | 兜底 walk 循环内逐文件 await ros2ServiceApi.pkg_list({}) → 一次跳转最多 N 次 pkg list 子进程;:192-208 系统回退又重复一次。应提循环外单次查询 |
| R4 | P1 | 模式违背 | message-index.ts:519-550(:522 cp.exec) | 系统枚举裸 cp.exec("ros2 interface list", timeout 20s)+ 手写 GBK 解码,绕开命令域;Ros2ServiceApi.interface_list 已存在(ros2-service-api.ts:36,实现 ros2/commands/ros2_service_api.ts:109,统一 env 注入/超时/null 契约)——应收编,删除本文件整段自造子进程 + 解码 |
| R5 | P1 | 时效缺口 | providers.ts:550-610;extension.ts:272 vs :280-286 | registerRosMessageProviders 只注册一次,MessageIndex 不订阅 onDidChangeEnv(对照 xacro PackageMap 在 extension.ts:280-286 有环境 + refresher 事件)→ 切发行版/重 source 后系统补全/定义陈旧至多 refreshMs(默认 10 分钟);刷新间隔配置激活时读一次(:553-557),运行中修改无效 |
| R6 | P2 | 死逻辑 | :672-680 | getWorkspacePackagesWithMsg 在 v3"仅 .msg"后 .some(e => e.path?.endsWith(.msg)) 恒真,冗余判定残留 |
| R7 | P2 | 潜在 bug | providers.ts:175/:259;message-index.ts:348-357 | 多根工作区只扫 folder[0];.msg 增量删除以旧路径算键,rename/移目录后残留键删不到(removeWorkspaceEntry 无反向路径索引) |

### providers.ts

| # | 级别 | 类别 | 位置 | 描述 |
|:--|:--|:--|:--|:--|
| R8 | P2 | 语义错位 | :158-185(:174 pkg_prefix) | 兜底包判定 pkg_prefix(默认 --share)→ pkgPath = share 目录,工作区源码 .msg 恒不 startWith(share) → 冷启动索引未就绪期(缓存空)跳转/悬停对工作区消息失效,仅"安装树=工作区"布局成立;失败无 UI 提示 |
| R9 | P2 | 双解析入口 | :55-100;:468(DocumentLink 裸 parse);semantic-tokens.ts:34 | parseMessageFile 自带缓存(uri+version 键,close/change 监听 :591-600 删除 ✅),但 parseMessageFile 内部又包一层 parseRosMessageDocument(:74),且 DocumentLink 裸 parse、语义 token 裸 parse → 一次交互多次全量结构解析。应收敛为"结构解析 + 版本缓存"唯一出口 |

### diagnostic-provider.ts / 其它

| # | 级别 | 类别 | 位置 | 描述 |
|:--|:--|:--|:--|:--|
| R10 | P2 | 越界配置 | message-index.ts:465-474 | 工作区强制重扫周期读 packages.refreshMs(build 域键,默认 60s 全量重扫 :449-462),语言域定时驱动依赖 build 域配置,与组合根/intellisense-config 各自读同类键的现状并存(治理分散) |
| R11 | P2 | 口径分裂 | diagnostic-provider.ts:67-72 vs message-index.ts:666-669 | 诊断自推当前包名(两级目录取名,期望 <pkg>/msg|srv|action/<file>,不符时按父目录近似)与 index.packageNameByDir(真名 = package.xml <name>)两套口径;散乱/非标准布局误报;index 已有 getPackageForFile 而不用 |
| R12 | P2 | 低效 | diagnostic-provider.ts:105-128 | 未知类型逐字段查 index(每字段多次 Map 查询),全文档 500ms 防抖无增量 |
| R13 | P2 | 死链/资源错位 | semantic-tokens.ts:47-49;package.json:54-145/:682/:689 | registerRosMessageSemanticTokens 为空 dispose(2026-08-16 因 semantic 覆盖 TextMate 配色时序 bug 禁用):类/legend/builder 全保留但零注册,误导性空注册仍在装配链;package.json configurationDefaults 仍配 [rosmsg] textMateRules + semanticHighlighting.enabled:false;tmLanguage(源自 jtbandes/ros-tmlanguage)与语言配置(ROS2.json)错放 snippets/ 目录,grammars 路径指向 ./snippets/rosmsg.json——功能可用但放置/命名治理错位,ARCHITECTURE/04 文档路径已过期 |
| R14 | P3 | 数据陈旧 | interface-data.ts:9-10 | BUILTIN_TYPES 含已废弃 byte/char 并作 hover 文档,与诊断(:75-86)与 tmLanguage invalid.deprecated 口径冲突;COMMON_PACKAGES(9 包)与系统/工作区包集合天然重叠,仅离线兜底价值 |

✅ 亮点:formatter.ts 纯函数单测完备;rosmsg-document 集中产出 invalidLines 统一供诊断;completion getCompletionContext(:45)只在类型位补全;配置读取已上移 providers.ts:525-530(但仍散落 3 文件 4 键)。

## 四、跨模块重复与错位(对照 package-map.md)

1. 真包判定已收编 ✅:message-index:209 与 package-map.ts:127-145 均读 getPackageCore workspace 域,md §2.2 的"消费方重写真包判定"已消除;
2. 事件未收编(中间态):message-index 仍自持 packageXmlWatcher,未并入 core.onDidChange(md §3 已判"统一走 package-core 事件"暂缓,现状即该中间态,delete 漂移需补);
3. md §2.1 package-map 断链 → ✅ 已修(2026-09-04):extension 直挂 core.onDidChange(workspace 域)刷新共享 PackageMap,setPackageMapRefresher 死机制移除——两域事件策略已统一(本模块同批改为订阅 core 事件重扫,R2 闭环);
4. 数据源收编方向(建议):.msg 内容索引属本域领域数据可自持,但触发源应收编——删自持 packageXmlWatcher(:369-372)与 60s 重扫定时(:449-462),改由 core.onDidChange + onDidChangeEnv 注入回调(仿 extension.ts:280-286)驱动;系统枚举改 ros2ServiceApi.interface_list(统一 env/超时/解码/null 契约),删除 :519-550 自造 cp.exec。

## 五、测试覆盖

强:rosmsg-document.test(308 行,分隔线全分支)、rosmsg-formatter.test(125,@optional 单双行)、rosmsg-diagnostics.test(156,14 例)、rosmsg-samples-parser.test(274,R1-R8 真文件)、rosmsg-samples-providers.test(244,R10-R17:MessageIndex 扫描/跳转/悬停/补全,自建 PackageCore 注入)、semantic-token-builder.test(113)、message-index-cache.test(104,payload 往返/版本)。
弱/缺:parseMessageFile 模块级缓存(FIFO/版本/失效)无直接单测;loadDiskCache/writeDiskCache/ensureSystemFresh/refreshWorkspace walk 无单测;R1 键格式无断言(未被发现);兜底 walk/pkg 过滤无单测;ros-msg-providers.test(754 行)旧大套件与 7 新套件职责交叠。

## 六、问题汇总与重构方向

| 级别 | # | 一句话要点 |
|:--|:--|:--|
| P1 | R1 | systemSorted 三段键 → 系统类型诊断误报 + 索引命中失效 + 补全清空/插入错文本(已逐行核验) |
| P1 | R2 | 自持 package.xml watcher 与 package-core 双监听,不订阅 onDidChange,delete 漂移 |
| P1 | R3 | 兜底 walk 逐文件 pkg_list(每次跳转最多 N 次子进程) |
| P1 | R4 | 裸 cp.exec 造 ros2 interface list,绕开 interface_list 与 env 门控 |
| P1 | R5 | 无环境事件订阅,系统索引跨环境陈旧(对照 xacro 有接线) |
| P2 | R6-R13 | 死逻辑/多根与 rename 残留/share 语义错位/双解析入口/越域配置键/包名口径分裂/诊断逐字段查询/semantic 死链 + 语法文件错放 |
| P3 | R14 | byte/char 数据口径陈旧 |

重构方向(建议,未改代码,对齐 build/ 域模式):
1. 子目录化:rosmsg/ 拆 structure(解析 + 版本缓存唯一出口)/ index(索引服务)/ providers(按 provider 拆文件)/ tokens;
2. message-index 收编为"订阅事件、不建 watcher"的索引服务:数据源 = getPackageCore 门面 + ros2ServiceApi.interface_list + environment.whenReady() 门控(对齐 package-map.ts:203),删除自持 packageXmlWatcher、60s 重扫定时与 cp.exec 段;
3. R1 一处修正:systemSorted 键改存二段 pkg/Name(剥 msg/ 段),贯通诊断/命中/补全三症状;
4. registerRosMessageSemanticTokens 空注册与 configurationDefaults textMateRules 整体删除或真实恢复,消灭误导性装配;语法文件迁出 snippets/(恢复语法/语言配置目录或按语义命名);
5. 清理:R6 死逻辑、R14 口径、providers 旧大测试套件职责;补 R1/缓存/兜底路径单测。

## 七、修复实施记录(2026-09-03 第一批:修复大部分问题)

> 状态:已实施并 tsc 通过(src/languages 0 错误;整仓其余错误为他人并行 WIP 的 config/write/anchors/cmake.ts,未触碰)。

| 编号 | 级别 | 修复 | 落点 |
|:--|:--|:--|:--|
| R1 | P1 | systemSorted 键剥除中段 msg/ → 二段 pkg/Name(systemEntryFromKey 首斜杠切分即得 pkg+Name);磁盘缓存 CACHE_VERSION 3→4(旧三段缓存自动失效重建) | message-index.ts refreshSystemFull / CACHE_VERSION |
| R2 | P1(已闭环 2026-09-03 23:52) | refreshWorkspace 单飞串行(workspaceRefreshChain 排队)+ 事件源收编:删自持 package.xml watcher / refreshPackageNames / handlePackageXmlEvent / packageNameByDir——名单实时读门面(workspaceNameByDir)+ 订阅 core.onDidChange(workspace 域变化 → 重扫),仅留 .msg watcher;增量/查询同口径(entryFromUri 传快照) | message-index.ts 全域 |
| R3 | P1 | 兜底包判定循环外单次查询(原逐文件 await pkg_list → 至多 N 次子进程);22:21 复核收敛——工作区目录不再自行读 package-core 状态,复用 MessageIndex.getWorkspacePackageDir(与分类同源) | providers.ts findMessageDefinitions + resolvePkgFilter + message-index.ts 新增访问器 |
| R5 | P1 | 环境变化(onDidChangeEnv)→ 立即重建系统消息索引(不再陈旧至多一个刷新周期);运行中修改 ROS2.msg.systemRefreshMinutes → setRefreshIntervalMs 动态生效(不再激活时读一次) | providers.ts 注册段 + message-index.ts setRefreshIntervalMs / refreshSystemFull 环境门 |
| R8 | P2 | 包过滤工作区包优先:经 MessageIndex.getWorkspacePackageDir(既有 dir↔真名映射,免重复读门面/免 --share 只认安装树的语义错位);系统包才走 pkg_list/pkg_prefix(命令域合规出口) | providers.ts resolvePkgFilter + message-index.ts getWorkspacePackageDir |
| R11 | P2 | 诊断当前包名优先取 index.getPackageForFile(真名 = package.xml <name>),消除自推口径(两级目录取名)与索引口径分裂;loose 文件退回父目录近似 | diagnostic-provider.ts analyzeDocument |
| R12 | P2 | 未知类型判定按包名一次性缓存(namesOf:同包多字段只查一次索引),不再逐字段重复 Map/二分 | diagnostic-provider.ts analyzeDocument |
| R13 | P2(部分) | semantic-tokens.ts 删除(空注册/死链);semantic-token-builder.ts 纯函数与单测保留;package.json configurationDefaults/grammars 路径治理与语法文件迁出 snippets/ 未动(功能可用,属资源治理,另行处置) | 文件删除 + providers.ts 注册链/日志 |
| R6/R7/R10/R14 | P2/P3(已修 2026-09-04) | R6 死守卫清理(getWorkspacePackagesWithMsg);R7 多根(全文件夹扫描)+ rename 残留(新快照,瘦身期已缓解);R10 自有键 ROS2.msg.workspaceRescanMs(去 colcon 越域,package.json 同步);R14 byte/char hover 标注已废弃(与诊断/语法口径统一) | message-index.ts / interface-data.ts / package.json |

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-03 21:47 | 建档:重构后 src/languages/rosmsg 现状复核审计(9 文件 2582 行)——依赖合法性、逐文件发现 R1-R14(核心 bug 链 R1 已逐行核验:systemSorted 三段键 vs systemEntryFromKey 首斜杠切分)、跨模块事件策略分裂对照 package-map.md、测试覆盖、重构方向;详见 本目录上级的 00-总览-language域审计.md(../00-总览-language域审计.md) |
| 2026-09-03 21:51 | 位置归位(项目结尾归档):报告自 设计/重构/languages域审计-2026-09-03/ 移入源码目录 src/languages/rosmsg/ 与审计对象同放,原文件夹已删除 |
| 2026-09-03 22:18 | 修复实施(第一批,大部分问题):R1 系统索引键剥 msg/ 存二段 pkg/Name + 缓存 v4;R4 系统枚举改 Ros2ServiceApi.interface_list(删 cp.exec 与 GBK 手写解码);R5 注册段加 onDidChangeEnv 重建 + 刷新间隔配置动态生效;R2 部分(refreshWorkspace 单飞串行);R3+R8 providers 包过滤元数据化(resolvePkgFilter:工作区目录优先 + 系统单次查询);R11+R12 diagnostic 用 index.getPackageForFile + 包内名称缓存;R13 semantic-tokens.ts 空注册删除(builder+测试保留);tsc src/languages 0 错误(整仓仅剩他人 WIP cmake.ts 破损);详见本报告 §七 |
| 2026-09-03 22:21 | 复核修正(R8 收敛):resolvePkgFilter 工作区目录分支不再自行 getPackageCore().getState() 翻工作区域(舍近求远),改为复用 MessageIndex 既有 dir↔真名映射——message-index.ts 新增 getWorkspacePackageDir(反向查 packageNameByDir,与分类同源、随包事件/重扫维护);providers.ts 删除 getPackageCore import;系统包目录仍走 ros2ServiceApi 单次查询(命令域合规出口;PackageMap 系统位置为事件式懒取,不适合单次同步过滤);tsc src/languages 0 错误 |
| 2026-09-03 23:16 | R3/R8 终版(统一入口落地):删除 providers resolvePkgFilter(自持 pkg_list/pkg_prefix),系统包目录改经共享 PackageMap.resolvePackageDir(组合根注入 sharedPackageMap);package-map.ts 新增可等待 resolvePackageDir(触发懒取并等待,单飞 + 缓存);语言域不再各自调命令 API;tsc src/languages 0 错误 |
| 2026-09-03 23:52 | R2 闭环 + 瘦身(第二批):删自持 package.xml watcher / refreshPackageNames / handlePackageXmlEvent / packageNameByDir(名单权威在 package-core workspace 域);新增 workspaceNameByDir(实时读门面)+ 订阅 core.onDidChange(ev.workspace 变化 → 重扫)取代原 package.xml watcher 的即时性;entryFromUri/findPackageDirForFile/getPackageForFile/getWorkspacePackageDir 全部改传/读实时快照;仅留 .msg watcher;R7 rename 残留顺带缓解;tsc src/languages 0 错误 |
| 2026-09-04 01:05 | 跨模块刷新统一(G2 侧):shared PackageMap 工作区包表刷新由 extension 直挂 core.onDidChange(workspace 域),setPackageMapRefresher 死机制移除——与 message-index 的 core 订阅重扫(R2)同一事件源,两域刷新策略对齐;tsc 0 错误 |
| 2026-09-04 01:23 | 小问题批次闭环(①-⑥):①watcher 事件产物目录过滤(isProductPath,增量面与 walk 排除口径对齐,DEFAULT_EXCLUDED_DIR_NAMES);②增量 upsert/remove 并入单飞链(enqueue 单写者队列,消除增量 vs 全量竞态);④doRefreshWorkspace 遍历全部工作区文件夹(原只 folder[0]);⑤readRescanIntervalMs 改读自有键 ROS2.msgWorkspaceRescanInterval(package.json 新增配置);③getWorkspacePackagesWithMsg 死守卫清理;⑥interface-data byte/char 描述标注已废弃(建议 uint8/int8);tsc 0 错误 |
| 2026-09-04 01:36 | 结构重组(用户指令):rosmsg 按模块分组(shared/parse/ui/data)+ 域出口 index.ts;data/message-index.ts(828 行)拆为 types.ts(常量/类型/payload 纯函数)+ workspace-index.ts + system-index.ts + 门面 message-index.ts(133);ui/providers 注册入口改经 index;extension/7 测试 import 路径同步(git mv);tsc exit=0——拆分前行号引用失效,以文件为准 |
| 2026-09-04 17:14 | 事件链收尾(ros2→core→PackageMap→rosmsg,C 与 D):PackageMap 系统名单改吃 core.system 域(acceptSystem,删自持 pkg_list 全套),新增 onSystemListChanged;extension 删侧路、core ev.system → acceptSystem(含种子);rosmsg ui/providers 删 composeApi.environment.onEnvChanged 直连、data/system-index 删 getEnvIssue 门控(改注入 envAvailable=packages.systemAvailable);§六/§七 状态同步(R2 事件收编终态);tsc 0 错误 |