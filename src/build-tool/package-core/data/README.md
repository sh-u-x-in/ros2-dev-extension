# data/ — 统一状态层(单一数据源 + 状态机 + 5 域快照)

package.xml 数据的事实层:物理快照(扫描缓存)+ 逻辑状态(5 域) + 分域事件。
2026-08-29 起 cache/ 吸收进本目录(§4.3 方案 B),物理与逻辑同处一层。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `package-cache.ts` | 单一数据源:unignore/ignore/entries 物理快照(+2026-09-06:ignoreMarkers/whitelist/blacklist)+ contentFingerprint 判重 + 单飞重建/双缓冲/失效 + **重建分档(doRebuild full\|lazy)** + **applyMarkerSync(标记事件不重建)** + getSharedPackageCache 单例 | scan/package-scan + ignore-classify + 注入(colcon list 执行器) |
| `index.ts` | DataLayer 状态机:订阅 event/ 原始事件(**双通道路由 + isDirRelevant 预过滤,2026-09-06**)→ 拉取 cache → 组装 5 域 → 域级比对 → 分域事件 + 3 接入口(ingest/toggle/getBuildPackages)+ refreshSystem(独立系统刷新);toEntry = **契约适配器**(path→dir)+ buildType 纯透传(已由 cache 层合并),refreshSystemList 系统包 buildType 恒 `""` | event/contracts + cache + scan(校验/忽略分类)+ 注入(systemPackages) |
| `state.ts` | 5 域快照形状(workspace/unignored/ignored/system/all)+ PackageChangeEvent(**2026-09-08:仅变化域携带 新值 + 对称旧值 old*,差量消费方自算;all/oldAll @deprecated 弃用**)+ domainSig 域签名 | shared/types |
| `derive.ts` | 派生:deriveWorkspace(unignored+ignored)/ deriveAll(workspace+system)/ fallbackUnignoredFromWalk(**visible(池):isVisibleEntry,2026-09-06**) | shared/types + ignore-classify |
| `config-gen.ts` | **⚠️ 已废弃注释**:配置生成已迁 package-service(数据消费者) | — |
| `validate.ts` | **⚠️ 已废弃注释**:死代码(权威校验由 scan/package-xml 承担) | — |

## 关键设计

- **判重唯一在 cache**:整快照"内容没变"由 contentFingerprint + onContentChange 判定(2026-08-29 逻辑吸收;
  2026-09-06 指纹纳入 ignoredBy/白名单/黑名单,ignoreMarkers 本身不入指纹——变而分类不变不 fire);
  DataLayer 不再二次整快照判重,只做域级细分(domainSig 逐域比对,域级无变化不发事件);
- **5 域**:workspace = unignored + ignored(派生);system = ros2 pkg list(注入提供者,dir 懒取);all = workspace + system(派生);
- **事件 = 事实(新值 + 对称旧值),差值消费方自算(2026-09-08)**:PackageChangeEvent 仅"变化域"携带新值 + 对称旧值(old*)成对(消费方自行做集合差;身份键:workspace/unignored/ignored 按 dir、system 按 name);**all 域弃用**(混合域无单一身份键、历次事件噪音源,@deprecated 标注,保留发射兼容旧订阅方);
- **接入口直改路径**:ingest(analyze + 祖先阻挡判定 + dedupeAdd + invalidate);toggleIgnore(2026-09-06 起**收敛到 cache.applyMarkerSync**,删除本地单包迁移——祖先标记影响整棵子树,非单目录可裁决);
- **重建分档(2026-09-06 §12.5 + V3 §12.12)**:ensureFresh 已脏 → **lazy**(只 walk + 并集加/交集证据快删/白黑名单实时转移,不跑 colcon);无快照/`rebuild()`(60s/手动)→ **full**(colcon 权威 + walk pair 认证白/黑名单);timedOut 只刷画像保名单并保持脏;
- **COLCON_IGNORE 事件不重建(2026-09-06 §12.4/12.5)**:标记事件 → `cache.applyMarkerSync(dirs)`(fs 事实幂等对账 M → 池 × M 重分类 → ignore⇄unignore 迁移),走 onContentChange → 重组装域;池事件(带 dirs)先过 `isDirRelevant` 预过滤(排除/点目录直接丢弃)再懒重建;
- **系统/定时解耦(2026-09-04)**:60s timer-tick 只强制重建工作区,不再调用系统包提供者(pkg list);
  system 域由独立入口 `refreshSystem()` 刷新(只刷 system/all 域,不碰工作区缓存),装配方在底层
  ros2/ env 变化(onEnvChanged)时触发——package-core 自身仍不订阅环境事件(取数经执行口注入铁律)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 补登 2026-09-13(5c5b4c5,手稿 §10 对齐):commit 增 `opts.forceDomains`(当前仅 "system")——env 驱动刷新时 system 域**强制携带**(index.ts:357-397:值未变也发事件,标签 "system(强制回推)",差量消费方自算为 0;system=null 仍不发);refreshSystem 路径传 forceDomains=["system"](index.ts:150),保证环境切换后即使系统包列表无变化订阅方也得到一次刷新机会 |
| 2026-09-08 22:45 | **事件 10 域化 + all 弃用**:state.ts——PackageChangeEvent 增对称旧值 oldWorkspace/oldUnignored/oldIgnored/oldSystem/oldAll(仅变化域携带,新值 + 旧值成对);PackageDataState.all / ev.all / ev.oldAll @deprecated(混合域无单一身份键、事件噪音源,新代码勿用,保留发射兼容);index.ts——commit 逐域附旧值(覆盖前取 this.state),域变化日志改用变化域名清单(changed,不再被 old* 键污染);derive.ts——deriveAll @deprecated 标注;api.ts 门面 onDidChange 注释同步(差量消费方自算);设计约定:差量身份键 = 工作区三域按 dir / system 按 name / all 不做逐条 diff(需全量变化对 workspace + system 源域差量并集);旧消费方零改动(新字段可选) |
| 2026-09-06 23:16 | **四项修复 + V3 落地(设计 §12 + §12.12,详见详解 §12)**:package-cache.ts——PackageSnapshot 增 ignoreMarkers(标记集 M)/whitelist(onlylist)/blacklist(walk-only);doRebuild 分档(full = colcon 权威 + walk pair 认证;lazy = **只 walk** + 并集加/交集证据快删(prevVisible∧¬nowVisible)/白名单 walk-见降级/黑名单 walk-不见除名;timedOut 门控只刷画像保名单并保持脏;colcon 失败不认证保留名单);新增 applyMarkerSync(dirs)(fs 事实幂等对账 M → classifyEntries 重分类 → ignore⇄unignore 迁移,解除忽略优先进交集,尊重黑名单,不 walk 不 colcon);指纹纳入 ignoredBy/白黑名单(M 本身不入);getWorkspaceRoot() 只读暴露;syncUnignore/updateConfig/单飞双缓冲语义不变。index.ts——handleDriverEvent 双通道路由(池事件→refresh(懒);标记事件→applyMarkerSync;timer→rebuild(full))+ DataLayerOptions.isDirRelevant 预过滤注入(排除/点目录事件丢弃;dirs 缺失保守触发);ingest 增祖先阻挡判定(classifyIgnoreReason,快照 M + 合法包链);toggleIgnore 收敛到 applyMarkerSync(删本地单包迁移);derive.fallback 改 isVisibleEntry(ancestor/overlap 不再漏入)。测试:data 层行为见 package-core-v3/events/classify 三新套件 |
| 2026-09-06 20:18 | **新生成包进入检测修复**:package-cache.ts doRebuild 重建前先刷新 colcon 权威(syncUnignore)——原实现 colconReady 后所有 rebuild(60s 定时/watcher/ingest 后)只跑 walk、unignore 保留"上次 colcon list"旧名单,新创建包(上次 colcon 跑于创建前)永不进入 unignore,commitFromSnapshot 用旧名单覆盖 ingest 增量(现象=create 后 colcon=10/fallback=11 且 60s 修不好);修复后每次重建权威名单跟随文件系统;新增 colcon 与 walk 合法名单差异 info 日志(带包名,补诊断缺失);新增真实缓存回归测试(+4,见 package-core/README.md 修改记录 20:18) |
| 2026-09-04 15:45 | **系统/定时解耦(用户意见)**:60s timer-tick(rebuild)不再顺带 refreshSystemList——定时器只管工作区强制重建,不再调用 pkg list;新增 refreshSystem() 独立入口(只刷 system/all 域,不碰工作区缓存),装配方(extension)在 ros2/ env 变化(onEnvChanged,env 可用时)触发;forceRefresh 语义收敛为工作区懒重建(注释同步);api/compose 门面链同步补 refreshSystem;测试 +2(timer-tick 不刷系统 / refreshSystem 只刷 system 域) |
| 2026-08-30 18:42 | 创建 data/ README(文件清单/关键设计) |
| 2026-09-01 20:44 | 五域 null 契约定稿:PackageDataState 五个域(workspace/unignored/ignored/system/all)一律 `PackageEntry[] | null`(null=未刷新/未知, []=已刷新但空);派生域任一上游 null → null 传播;emptyState 全 null、domainSig 区分 null("!null")与 [];ingest/toggle/getBuildPackages 适配 ?? [];新增 package-core-state.test.ts(4 用例) |
| 2026-09-01 20:55 | 数据流简化:①defaultSystemPackages 去掉 ?? [](pkg_list 失败 null 透传 → system 域 null=未知, 不再折叠成"成功但空");②ingestPackageCreated/toggleIgnore 未刷新(null)时早退不做增量(不伪造部分已知, 缓存失效交 watcher 重建);③getBuildPackages 用 ?.length 微调 |
| 2026-09-02 11:03 | buildType 流入 PackageEntry(方案 A 铺垫):WorkspacePackage 加 buildType,cache 层从 walk 画像(entries)合并(attachBuildType 按 path 补,syncUnignore/doRebuild 两处),data 层 toEntry 直接继承(不跨层取数);refreshSystemList 系统包 buildType 恒 ""(ros2 pkg list 无类型);contentFingerprint 纳入 buildType(类型就绪/变化触发内容变化) |
| 2026-09-02 11:10 | 架构修正(用户意见):buildType 合并上移 cache 层(物理数据源自带类型)、data 继承——废弃"data 跨层从 scan 画像补"方案(toEntry 简化为单参数继承;此前跨层补在 colcon list 快路径下 buildType 不可得,属脆弱耦合) |
| 2026-09-02 17:48 | **出口简化与 buildType 事件化(设计/重构/package-core出口简化与buildType事件化-2026-09-02)**:PackageSnapshot 加 colconReady(区分「colcon 跑了但空」);DataLayer 订阅 cache.onContentChange 并以最新快照重组装域;unignored 域 = 参与构建最佳名单(colconReady ? colcon 名单 : fallbackUnignoredFromWalk(walk 合法非忽略),兜底上移);类型就绪才发布(undefined 不落域,commit 保留旧值);domainSig 纳入 buildType;commit 删静默语义(内容真变含类型才发);getBuildPackages 以 colconReady 判定缓存命中;ingest/toggle 增量条目改 analyzePackageDir 携带 buildType(域无 undefined 不变量) |
| 2026-09-03 22:58 | 死代码复核同步(项目结尾):config-gen.ts / validate.ts 墓碑维持注释保留(头部补 2026-09-03 复核标注);package-cache.ts 头部"6+ 外部消费方共用 / 供未来消费者订阅(如 PackageMap/rosmsg…)"×3 处与 getSharedPackageCache"供未来消费者复用"过期注释更正为内部专用(compose 装配 + data 订阅 onContentChange,外部消费方已迁门面域);state.ts computeFingerprint 废弃注释补复核注(无活跃引用);文件清单与当前代码核对一致;详见 package-core/README.md 墓碑登记 |

<!-- 文件末尾修改时间:2026-09-29(补登 09-13 forceDomains 强制回推,详见上表 2026-09-29 行) -->