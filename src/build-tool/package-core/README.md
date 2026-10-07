# package-core/ — 权威包数据中心

扩展的 package.xml 权威数据核心域(独立于 `package-service/`、`tasks/`、`create/`、`packages/` 等旁系域)。
2026-08-28 起由 packages/ 语义收编而成:校验/扫描/缓存/状态/时机全链归位,接口集中 `api/`、实例经组合根 `compose.ts` 装配、外部依赖一律走 `api/`。

## 分层结构(依赖方向自上而下,禁止反向)

| 层/文件 | 职责 | 依赖 |
|---|---|---|
| `api/` | 对外唯一依赖点:类型层 + 运行时出口(≈ros2/api/) | 仅类型依赖(import type) |
| `compose.ts` | 组合根:createPackageCore 工厂 + 装配 + 门面实现(≈ros2/compose.ts) | 各实现模块(单向)+ vscode + ros2/api(执行口) |
| `gate.ts` | 门控编排(门槛 && 门户 && 倾向 + 任务提供器注册) | vscode(仅 import type) |
| `data/` | 统一状态层:单一数据源(缓存)+ DataLayer 状态机 + 5 域快照 | scan(校验/扫描)+ event(契约)+ 注入(systemPackages) |
| `scan/` | 校验 + 扫描:package.xml 权威判定、搜索原语、执行器、工具 | walk/(公共搜索)+ languages/shared/xml-utils(公共解析)+ logger |
| `event/` | 时机引擎:何时刷新(timer + fs 监听 + 去抖) | vscode(仅 fs-watcher)+ contracts |
| `shared/` | 共享工具:值类型 + 通用事件发射器 | 无 |

## 核心模式(铁律)

### ① 一切走 api/
外部消费者一律 `import ... from "…/package-core/api"`(类型 + 运行时出口:createPackageCore / getSharedPackageCache / probeValidWorkspacePackages / 校验 / 常量);
**绝对意义的所有依赖,无第三方引用 api/ 以外内容**;组合根 `compose.ts` 只被装配方(extension)直接调用。

### ② api/ 纯类型层
`api/api.ts` 只放接口/类型;`api/index.ts` 聚合 + 运行时出口(re-export compose 产物,≈ros2/api re-export composeApi);
目录内零 function/class 定义、零实现 re-export。

### ③ 依赖方向单向无环
api → compose → 实现层;data → scan/event(单向);scan → 公共工具(walk/xml-utils);实现层不反向 import 组合根。

### ④ 取数经执行口注入
colcon list 执行器(scan/colcon-list)与系统包列表(systemPackages)均经注入(组装根接 ros2/ composeApi),
package-core 零命令执行、不 import ros2/ 实现。

### ⑤ 废弃文件整体注释保留
如 `data/config-gen.ts`(迁 package-service)、`data/validate.ts`(死代码)等:
不再参与编译,头部 `⚠️ DEPRECATED` 标记 + 去向说明,不删除(行数不跌,历史可查)。
**2026-09-29 口径更新**:零引用(无活 import 且 0 编译行)的工程尸体改物理删除、git 历史可查——`cache/package-cache.ts` 已按此删除(提交 8afde4a);仍有档案价值的注释保留件(如 scan/colcon-scan.ts 主体)维持不删。

## 文件地图

| 文件/目录 | 一句话 |
|---|---|
| `compose.ts` | 组合根:createPackageCore 工厂 + PackageFacade 门面 + 静态能力导出(含 probeValidWorkspacePackages 单次探测谓词,2026-08-31) |
| `gate.ts` | 门控编排(构建任务提供器注册管理) |
| `api/` | 对外唯一依赖点:类型层 + 运行时出口(见 api/README.md) |
| `data/` | 统一状态层:单一数据源 + 状态机 + 5 域快照(见 data/README.md) |
| `scan/` | 校验 + 扫描:package.xml 权威判定(见 scan/README.md) |
| `event/` | 时机引擎:timer + fs 监听(见 event/README.md) |
| `shared/` | 共享工具:值类型 + 事件发射器(见 shared/README.md) |
| `DESIGN.md` | 本目录设计说明(内部结构问题存档) |

## 近期关键改动(2026-08-28 ~ 2026-08-30)

- 语义收编:cache/scan 簇归位 package-core(2026-08-29);
- 断环:组装根 vscode-utils 依赖参数化(PackageCoreConfig 注入);
- executable 簇剔除(可执行派生属 package-service,非 package.xml 数据);
- system/all 域恢复(5 域回归,06/07 设计);
- config-gen 迁出 package-service;cache/ 吸收进 data/ + 逻辑吸收(删双重指纹判重);
- ui→api、driver→event、gate import type;colconListExecutor 归位 scan/;
- api/ 目录定稿(纯类型层 + 运行时出口),一切走 api/ 落地;
- 结构对称探索存档(组合根零函数尝试已回滚:注入式装配 = 工厂在组合根,合理差异);
- probeValidWorkspacePackages 收编(2026-08-31):vscode-utils.workspaceContainsPackageXml 归位本中心(包判定权威域),onboarding 改经 api 调用;仅单次决策使用(原 hasValidWorkspacePackages,重命名以强调"单次、不考虑更新"语义);UI context key(ros2.hasPackageXml)改组合根反应式(onDidChange → setContext),不再查询式强制扫描。

## 死代码/墓碑登记(2026-09-03 复核,项目结尾定稿)

> 定稿:墓碑一律**不删除**,以整体注释 + 头部 DEPRECATED/日期标注留存(git 历史与本文件可查);活代码内过期"预留/未来"注释已同步更正或标注复核日期。

### A. 整文件墓碑(0 编译行)

| 文件 | 行数 | 废弃日期 | 去向 / 说明 | 复核 |
|:--|:--|:--|:--|:--|
| data/config-gen.ts | 191 | 2026-08-29 | 实现迁 package-service/config/gen(intellisense-config) | 2026-09-03 维持 |
| cache/package-cache.ts | 386 | 2026-08-29 | 新实现 = data/package-cache.ts(cache/ 吸收进 data/) | 2026-09-29 物理删除(零引用清理,提交 8afde4a) |
| data/validate.ts | 52 | 2026-08-29 | 校验职能并入 scan/package-xml + cache 内建 | 2026-09-03 维持 |
| scan/colcon-scan.ts(主体) | 171(编译行≈10) | 2026-08-29 | 仅 hasColconIgnoreSameDir 存活(data 层 ingest/toggle 用);内含 2026-08-21"待删除(用户自行处理)"历史标记 | 2026-09-03 维持,标记定稿不删 |

### B. 活代码内过期"预留/未来"注释(2026-09-03 更正/标注)

| 位置 | 处理 |
|:--|:--|
| data/package-cache.ts 头部"6+ 外部消费方共用/供未来消费者订阅(如 PackageMap/rosmsg…)"×3 处 + getSharedPackageCache"供未来消费者复用" | 更正为"内部专用(compose 装配 + data 订阅 onContentChange),外部消费方已迁门面域";接入状态表标注为历史记录 |
| data/state.ts:87 computeFingerprint 废弃注释 | 补"2026-09-03 复核:维持注释保留,无活跃引用" |
| shared/types.ts ExecutableInfo 注释("供未来可执行派生服务恢复") | 补"2026-09-03 复核:exe-map 已落地(package-service/config/exe-map),本条仅供历史" |
| api/api.ts "实现 = facade.ts / 已移往 facade.ts" | 更正指路:facade.ts 已于 2026-08-30 合并入 compose.ts(原指路文件已不存在) |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-04 22:05 | i18n 期2批6(06号档案):本域纯日志面全量英文源化——package-xml 五 reason 串+两出口、package-scan 超时/完成、package-cache 30 条、data/index 14 条(system(强制回推) 改语言中立 system(force-repush) 内部标签不进册)、fs-watcher 4 条、walk 2 条;全域补 import { l10n }(fs-watcher 已有 vscode 导入走 vscode.l10n.t);bundle +62=447 键;1307 全绿 |
| 2026-09-29 | 文档补登两批 + 墓碑口径更新:①补登 2026-09-13(5c5b4c5)——env 驱动刷新**强制回推 system 事件**(data/index.ts forceDomains 含 "system" 时强推,refreshSystem 语义升级,详见 data/README.md);②补登 2026-09-28(83f7f82,批次4)——`PackageCore.reconfigure(config)` 新门面 API(compose.ts)、`DriverTimer.setIntervalMs` 运行中重设周期(event/timer.ts)、isDirRelevant 排除集热更(compose.ts);③铁律⑤口径更新 + `cache/package-cache.ts` 墓碑物理删除(零引用工程文件清理,提交 8afde4a),文件地图 cache/ 行移除 |
| 2026-09-08 22:45 | **事件 10 域化 + all 弃用**:PackageChangeEvent 增对称旧值 old5(oldWorkspace/oldUnignored/oldIgnored/oldSystem/oldAll)——仅变化域携带(新值 + 旧值成对),差量消费方自算(身份键:工作区三域按 dir、system 按 name);all 域 @deprecated(混合域无单一身份键、历次事件噪音源,新代码勿用,保留发射兼容);commit 域变化日志改用变化域名清单;api/data/derive 注释同步。改动:data/state.ts、data/index.ts(commit)、data/derive.ts、api/api.ts;详见 data/README.md 修改记录 22:45 行 |
| 2026-09-06 23:16 | **四项修复 + V3 落地(设计:数据源与事件链路现状详解 §12 + §12.10 + §12.12)**:①P1/P2 scan:新增 scan/ignore-classify.ts(分类纯函数,ignoredBy = same-dir/ancestor/overlap,自根向下首个阻挡),package-scan 结果增 ignoreMarkers(第二趟 COLCON_IGNORE 遍历)+ PackageScanEntry.ignoredBy + isDirScanExcluded(点目录对齐 §12.10-B);②cache:快照增 ignoreMarkers/whitelist/blacklist,doRebuild 分档(full=colcon 权威+pair 认证 / lazy=只 walk+加+交集证据快删),applyMarkerSync(标记事件不重建),timedOut/colcon 失败门控;③data:事件双通道路由 + isDirRelevant 预过滤,ingest 祖先判定,toggleIgnore 收敛 applyMarkerSync,fallback 改 visible(池);④event:DriverEvent 带 dirs(op 折叠)、新增 event/batcher.ts、fs-watcher 路径聚合;⑤compose 预过滤接线;colcon-scan 定稿注释作废。测试:package-core 六套件 45 用例全绿(新增 classify/v3/events);文档:本 README + data/event/scan README + 详解 §12 已同步 |
| 2026-09-06 20:18 | **新生成包无法进入检测修复(远端问题:create 后 colcon=10/fallback=11,60s 周期修不好)**:data/package-cache.ts doRebuild **重建前先刷新 colcon 权威名单(syncUnignore)**——原实现 60s 定时/watcher/ingest 后的 rebuild 只跑 walk 且 unignore 只保留"上次 colcon list"注入值,从不重跑 colcon:新创建包(colcon 上次跑于创建前)进不了 unignore,commitFromSnapshot 随后用旧名单整体覆盖 ingest 增量(事件链看似断裂);修复后每次重建(含 60s 周期与懒重建)colcon 名单跟随文件系统,新包即时/周期内收敛;doRebuild 增 colcon 与 walk 合法名单差异 info 日志(带包名,补齐此前缺失的诊断);新增 test/suite/package-core-cache.test.ts 真实缓存回归(+4 用例:新包纳入 unignore / 60s 与 ensureFresh 纠偏 / colcon 剪枝 / ignore 派生不受影响) |
| 2026-09-04 15:45 | **系统/定时解耦(用户意见)**:60s timer-tick 不再刷新系统包列表(不再调用 pkg list)——定时器只管工作区强制重建;system 域改由新独立入口 refreshSystem() 刷新(只刷 system/all 域),装配方 extension 在 ros2/ env 变化(onEnvChanged,env 可用)时接线触发;api(纯接口)/compose(门面+组装)/data 全链补 refreshSystem;event/contracts timer-tick 注释同步;详见 data/README.md(+2 无头测试) |
| 2026-08-30 18:42 | 创建总 README(分层结构/五条铁律/文件地图/近期改动);效仿 ros2/README.md 范式 |
| 2026-08-31 17:56 | hasValidWorkspacePackages 收编记录:包判定权威归位(自 vscode-utils),核心模式①运行时出口/文件地图/近期改动同步;UI context key 反应式化说明 |
| 2026-08-31 18:25 | 重命名 hasValidWorkspacePackages → probeValidWorkspacePackages:仅 onboarding 单次决策使用,注释强化"单次、不考虑更新、刻意减少复杂度"语义;引用同步(api/index、README、onboarding、vscode-utils 注释) |
| 2026-08-31 18:33 | rootPath 废弃 API 迁移:compose.ts 缺省工作区根 `vscode.workspace.rootPath` → `workspaceFolders?.[0]?.uri.fsPath`(注释同步);全工作区迁移见结构文档 |
| 2026-09-01 19:44 | compose.ts defaultSystemPackages 适配 null 契约:`pkg_list` 失败 → null,数据层提供者 `?? []` 归一(string[] 不变,空/失败统一降级) |
| 2026-09-01 20:44 | 数据层五域 null 契约(与 Ros2ServiceApi null 契约对齐):null=未刷新/未知, []=已刷新但空, 调用方不再靠时序推断;消费方适配(extension workspace?.length、intellisense-config ?? []、register-commands ignored ?? []) |
| 2026-09-01 20:55 | 数据流简化(null 契约收尾):系统包数据源失败 null 全链路透传(compose 归一补丁拆除);ingest/toggle 未刷新时不伪造增量, 早退交刷新;143 用例全过 |
| 2026-09-02 15:54 | **colcon list 数据源修复(路径绝对化)**:scan/colcon-list.ts 输出路径统一 resolve(workspaceRoot)——修复 colcon 相对路径与 walk 绝对 dir 的全等匹配断裂(此前 colcon 权威注入后 executable-map 收录反而全空、attachBuildType 合并失效);详见 scan/README.md |
| 2026-09-02 17:48 | **出口简化与 buildType 事件化(设计/重构/package-core出口简化与buildType事件化-2026-09-02)**:①domainSig 纳入 buildType(域事件覆盖类型就绪/翻转);②快照加 colconReady,域层 unignored = 参与构建最佳名单(colcon 权威 / walk 兜底上移);③类型就绪才发布(undefined 不落域);④colcon-list 出口携带 buildType(undefined 窗口归零);⑤API 收窄:api 删 cache 物理出口(PackageSnapshot/WorkspacePackage/PackageScanEntry/getSharedPackageCache),新增 getPackageCore 门面访问器——对外只剩 PackageFacadeApi;⑥消费方(debugger launch/package-map/message-index)迁移到门面 workspace 域;executable-map 同步切门面并接线(05 任务 6) |
| 2026-09-03 22:50 | 死代码复核(项目结尾):墓碑定稿不删除(data/config-gen、cache/package-cache、data/validate、colcon-scan 主体头部补"2026-09-03 复核"标注);活代码过期注释更正/标注(data/package-cache"6+ 消费方/供未来"×4 处→内部专用、state.ts computeFingerprint、shared/types ExecutableInfo、api/api.ts facade 指路→compose.ts);README 增"死代码/墓碑登记"章节(见上) |

<!-- 文件末尾修改时间:2026-09-29(文档补登 09-13/09-28 两批 + cache 墓碑物理删除口径更新,详见修改记录 2026-09-29 行) -->
