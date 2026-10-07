# src/languages/xacro 模块审计报告(2026-09-03 21:45 建档)

- 对象:src/languages/xacro/(7 文件 2780 行),.xacro/.urdf 语言服务:include/宏/变量/link-joint 跳转 + 链接 + 悬浮 + 结构/表达式补全 + D1-D7 诊断 + watcher 动态维护
- 背景:工作空间大面积重构(ros2/api、package-core 门面 + 事件、walk 统一、PackageMap 数据源收编)后现状复核;设计基准 = 设计/xacro/00~12(2026-08-18 前后建档)
- 精度:文件级 + 关键函数级,证据给 文件:行号
- 判定标准:数据经共享 PackageMap(package-core 门面),搜索经 build-tool/walk barrel,禁止 import extension/旧包壳,资源随 providers dispose

---

## 一、模块总览(现状复核)

| 文件 | 行数 | 职责 | 类属 | 结论 |
|:--|:--|:--|:--|:--|
| include-graph.ts | 1078 | 图核心:三阶段 build / 增量 upsert-remove / use-def 传播 / 可见性 / 环检测 | 纯逻辑 + vscode(fs 同步读) | ⚠️ 文本驻留无 evict、无 dispose、fallback 全仓重扫副作用(见 §3) |
| providers.ts | 424 | 装配(Definition/Link/Hover)+ 注册 | UI 提供器 | ⚠️ 关键字集/括号判断重复 |
| completion-provider.ts | 538 | 结构补全(50 片段)+ ${} 动态补全 | UI 提供器 | ⚠️ isInDollarBraces 第三份 |
| diagnostic-provider.ts | 323 | D1-D7 诊断 + PackageMap.systemAvailable 门控 | UI 提供器(规则纯函数可测) | ⚠️ XACRO_KEYWORDS 双份 |
| xacro-watcher.ts | 197 | 监听 + rename/轮巡/事件驱动 | 生命周期 | ⚠️ 包正则第三处实现 |
| context-locator.ts | 100 | lezer 光标上下文(tagName/attr/attrValue/comment) | 纯解析 | ✅ 但与 attr 取值双实现(见 F5) |
| urdf-docs.ts | 120 | URDF/关节类型文档纯数据表 | 纯数据 | ✅(测试在 urdf-docs.test.ts) |

装配链(providers.ts:373-423)与 09 文档一致:共享 PackageMap → IncludeGraph(构造注入 packages,include-graph.ts:155)→ XacroWatcher.start() → pkg.initialize().then(() => graph.build([]))(providers.ts:382-384)异步预热;selector 为纯 pattern **/*.xacro、**/*.urdf(providers.ts:387-390,不干扰其它 xml;.xacro/.urdf 扩展已注册到 xml 语言,package.json contributes.languages)。

## 二、依赖审计(出边 / 入边)

| 方向 | 源 | 目标 | 判定 |
|:--|:--|:--|:--|
| 出边 | xacro/*(5 处) | ../shared/xml-utils(纯 lezer 只读工具) | ✅(xml-utils.ts:2 自注 2026-08-29 自 xacro/ 上移,一处实现多处复用) |
| 出边 | include-graph / providers / watcher / diagnostic / completion | ../shared/package-map + ../../build-tool/walk barrel(include-graph.ts:27) | ✅ 合法(搜索统一 walk、包数据经门面) |
| 出边 | — | ../../logger | ✅ |
| 入边 | extension.ts:34(组合根)registerXacroProviders + 共享 xacroPackages(:276-277);launch 复用(:289) | providers | ✅ |
| 入边 | test/suite:include-graph / xacro-completion / xacro-diagnostics / xacro-diagnostics-samples / xacro-samples-integration / urdf-docs / package-map | 模块内 | ✅ |

越界核查:rootPath / findFiles(仅注释提及已替代)/ import extension / getExtension / require( / child_process 全 0 命中 ✅。

### 共享 xml-utils 被 build-tool 反向引用(治理关注点)
xml-utils 物理在 languages/shared,被 build-tool/package-core/scan/package-xml.ts:12 与 package-service/config/write/anchors/xml.ts:13 引用;package-core/README.md:14,29 与 scan/README.md:21 明文定位为"公共工具(上移共享)"。语义不构成归属问题(纯文本只读工具、零 vscode 之外状态,非包数据);但物理仍挂在 languages/ 下,建议迁出至中立层或 lint 豁免(见 §6 ④)。遗留:build-tool/packages/package-xml.ts:23 注释掉的旧路径 import。

## 三、逐文件发现清单

| # | 级别 | 类别 | 位置 | 描述 |
|:--|:--|:--|:--|:--|
| X-F1 | P1 | 断链(功能) | extension.ts:284-286;listeners.ts:19-22/:87;package-map.md:19-22 | 工作区包表刷新链断裂:setPackageMapRefresher 设了回调,唯一调用点 listeners.ts:87 的 packageMapRefresher?.() 已随退役整体注释;extension.ts:194-197 的 packageCore.onDidChange 编排只做 gate.sync + setContext,未补 refresh。后果:激活后新增 package.xml/新工作区包不进 xacro 包表,$(find 新包) 恒 pending(D2 长驻)至重载;package-map.md 已自记(2026-08-31),修复未执行 |
| X-F2 | P2 | 重复 | providers.ts:122-127 / :355-360;completion-provider.ts:533-537 | isInDollarBraces 三份逐字复制(Definition 私有 / Hover 私有 / 模块函数),应收 shared 或模块级唯一函数 |
| X-F3 | P2 | 重复/漂移风险 | providers.ts:28-31;diagnostic-provider.ts:28-31 | XACRO_KEYWORDS(include/macro/property/arg/insert_block/element_inject/if/unless = xacro 官方内建 8 标签)在两文件逐字重复,一旦扩展易漂移(如漏加新标签 → 宏误判:providers.ts:100-107 链接找宏、diagnostic-provider.ts:199-205 D4 误报"需先 include")。注:官方 xacro 无 while/for 循环标签,集合本身与官方一致,主要问题是双份 |
| X-F4 | P2 | 性能(多 parse 无缓存) | xml-utils.ts:40-42;providers.ts:364-367;providers.ts:277/:288;context-locator.ts:34 | parseXml 纯函数不缓存(设计自注);attrAtDocument 每次全文重解析;单次 hover 最多 3 次 parse;completion 每次按键 1 次 parse。建议按 uri+version 缓存单次 parse 结果 |
| X-F5 | P2 | 冗余双实现 | context-locator.ts:62-79;providers.ts:277 | attrAtDocument 手写 Attribute 范围判定与 context-locator 的 role 判定重叠(后者 CursorContext 无 value 字段 → hover 取值二次 parse);应单 parse 同时返回 role+value |
| X-F6 | P2 | 性能/隐式副作用 | include-graph.ts:408-453(:421-425 walk、:435 scanIncludes、:439-441 驻留 text)、:390-393/:1065-1077;diagnostic-provider.ts:204/:224;include-graph.ts:906 | fallback 由只读查询路径(D4/D5 诊断、resolveDollarBraces)意外触发:needFallback(无父/版本变)→ fire-and-forget 全工作区重扫(fallback 2s 防抖 :32/:412 部分抑制)。大仓首查 O(全仓)IO+parse 尖峰;fallback 决策应收敛显式调用点,查询路径禁止隐式写副作用 |
| X-F7 | P2 | 内存/未 dispose | include-graph.ts:76,:808-810;:125;package-map.ts:48 | FileNode.text 全量驻留全文、无 evict;IncludeGraph 无 dispose;propertyCycleEmitter 与 PackageMap.dirLoadedEmitter 未随 providers.ts:416-423 返回数组 dispose(仅 watcher 被 dispose) |
| X-F8 | P3 | 死字段 | include-graph.ts:88;providers.ts:347-348 | Visibility.blocker 声明 + 读取,全仓无赋值点 → hover ⚠️ blocker 分支恒不可达(死代码) |
| X-F9 | P3 | 陈旧注释/降级常量 | diagnostic-provider.ts:25/:190 | "(同 04 降级)"注释引用 completion-provider 已删除的 LARGE_DOC_LINE_LIMIT;LARGE_DOC_LINE_LIMIT(10000)仅 diagnostic 侧在用 |
| X-F10 | P2 | 正则三处 | package-map.ts:103;diagnostic-provider.ts:44-54(extractPkg);xacro-watcher.ts:171-188(collectPendingPackages) | 包引用表达式解析三处独立实现(find/package:// 正则),watcher 未复用 diagnostic 的 extractPkg |
| X-F11 | P3 | 竞态注记 | include-graph.ts:174,:183-231 | build 后半程同步无 await,与 watcher 交错窗口仅在 walkWithTimeout 等待期;upsert 有内容比对(:629-632)兜底,风险受控,属注记 |
| X-F12 | P2 | 遍历成本注记 | include-graph.ts:170-176/:421-425 vs message-index.ts:266-267 | 与 rosmsg 各自全根扫描(文件类型互斥 .xacro|.urdf vs .msg,无内容重复),但无共享目录列举缓存,语言类型增多成本线性叠加 |

## 四、与设计文档差异核对(关键 5 处)

| 文档声明 | 代码现状 | 判定 |
|:--|:--|:--|
| 09-Activation.md:13 激活时"启动一次 ros2 pkg list" | 延后到环境就绪,onDidChangeEnv → refreshSystemList(extension.ts:280-282;package-map.ts:58-65,196-217) | ✅ 有意改进(8-21 规避 UnknownROS 误报),文档未更新(漂移) |
| 09-Activation.md:11/:49 PackageMap 单一共享实例 | 达成:extension.ts:276-289 一实例传 xacro 与 launch(launch/providers.ts:20-23) | ✅ 一致 |
| 09-Activation.md:29 "08 诊断暂不注册(落盘先行)" | 已注册 D1-D7:providers.ts:413 → diagnostic-provider.ts:131-323 | ✅ 时序约定已过期落地(文档漂移) |
| 06 §0.3 方向② / 09 §1④ 包列表更新 → 刷新共享 PackageMap | 回调注册无人调用(listeners.ts:87 注释);package-map.md:19-22 记录未修 | ❌ 断裂 → X-F1 |
| 12 UseDefMap / 11 lezer 迁移 | 已落地(include-graph use-def 传播、xml-utils lezer 封装) | ✅ 一致 |

## 五、测试覆盖

覆盖面广:include-graph.test.ts(展开序/环/可见性/${} 求值/propagate/rename);xacro-completion.test.ts;xacro-diagnostics.test.ts(纯逻辑 classifyEdge/findIncludeCycleThrough);xacro-diagnostics-samples.test.ts(X1-X5 零误报护栏 + getCursorContext 实样);xacro-samples-integration.test.ts;urdf-docs.test.ts;package-map.test.ts。
缺口:registerXacroProviders/extension 装配链、watcher(轮巡/rename 事件)、Definition/Hover/DocumentLink 三 UI 提供器、X-F1 断链行为均无直接测试(依赖 vscode 事件)。

## 六、问题汇总与重构方向

| 级别 | # | 一句话要点 |
|:--|:--|:--|
| P0 | — | 无崩溃级问题 |
| P1 | X-F1(✅ 已修 2026-09-04) | xacroPackages.refreshWorkspace 无调用点 → 工作区包增删后解析悬空;修复:extension 直挂 core.onDidChange(workspace 域),setPackageMapRefresher 死机制移除 |
| P2 | X-F2/F3/F4/F5/F6/F7/F10 | 重复(isInDollarBraces×3、XACRO_KEYWORDS×2、包正则×3)+ 多 parse 无缓存 + fallback 隐式全仓重扫 + 文本驻留无 evict/dispose |
| P3 | X-F8/F9/F11/F12 | blocker 死字段、陈旧注释、竞态受控注记、跨模块遍历成本注记 |

重构方向(建议,未改代码):
1. X-F1 修复:按 package-map.md:22 方案在 extension.ts onDidChange 编排补 void xacroPackages.refreshWorkspace(),同时退役 setPackageMapRefresher 死机制(或改由 listeners 直挂);
2. 收敛重复:isInDollarBraces / XACRO_KEYWORDS / 包引用解析(xacro-watcher 复用 extractPkg)收模块级唯一实现或 shared;
3. 性能:parse 按 uri+version 缓存一次;fallback/D4/D5 查询路径禁止隐式触发全仓重扫,fallback 决策收敛显式调用点;FileNode.text 增 evict/上限;补齐 IncludeGraph/propertyCycleEmitter 的 dispose 并挂入 providers 返回数组;
4. 治理:xml-utils 物理迁出 languages/(中立公共层)或纳入豁免并清理 build-tool/packages/package-xml.ts:23 遗留注释;
5. 清理:删 blocker 死字段/陈旧注释;补装配链与断链行为测试。

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-03 21:45 | 建档:重构后 src/languages/xacro 现状复核审计(7 文件 2780 行)——装配链/依赖合法性、逐文件发现(X-F1~F12,含 F1 断链复现证据与关键断言核验)、09/06 设计差异核对(5 处)、测试覆盖、重构方向;详见 本目录上级的 00-总览-language域审计.md(../00-总览-language域审计.md) |
| 2026-09-03 21:51 | 位置归位(项目结尾归档):报告自 设计/重构/languages域审计-2026-09-03/ 移入源码目录 src/languages/xacro/ 与审计对象同放,原文件夹已删除 |
| 2026-09-04 01:05 | X-F1 修复闭环:extension 直挂 packageCore.onDidChange(workspace 域变化 → void xacroPackages.refreshWorkspace());setPackageMapRefresher 死机制移除(listeners.ts);见 package-map.md §2.1;tsc 0 错误 |
| 2026-09-06 23:01 | 用户反馈批次落地(见 README 修改记录):D5 范围修正(标识符本体)+ 宏形参 D5 豁免(纯函数入诊断模块,新增单测)+ DocumentLink 同文件宏下划线统一(位置改元素实位)+ Hover 文档注释(extractLeadingComment 入 providers 导出,新增 xacro-providers.test.ts);宏形参跳转/补全仍为已知缺口(未做:形参不进符号表) |
| 2026-09-06 23:15 | 用户反馈批次②落地(遮蔽/匹配语义,见 README 修改记录 23:15):${} 形参遮蔽优先(dollarVarAt 替代 isInDollarBraces)、属性值内嵌 ${} 按变量解析且含 ${} 值禁原文符号正匹配、DocumentLink 表达式型 ${} 逐标识符下划线;enclosingMacroSpan 导出+单测;宏形参仍不建符号表(跳转目标=宏定义,补全不含形参)——登记为已知缺口 |
| 2026-09-06 23:25 | 用户反馈批次③落地(定义跳转锚点,nameAttrColumn/symbolAnchorColumn,见 README 23:25);宏形参仍不建符号表(跳转目标=宏定义),登记为已知缺口 |
| 2026-09-06 23:31 | 可观测性增强:Definition/Hover/DocumentLink 查询级日志(入口/分支/未命中原因/产出统计),logMissReason/logVarMiss 经 findSymbolAny 区分"不可见 vs 同名异型 vs 全图无";见 README 23:31 |
| 2026-09-07 22:30 | 目录化重组(效仿 rosmsg):根 index.ts 唯一出口;ui/(提供器拆分 + provider-utils + 装配)/ core/(include-graph、xacro-watcher)/ parse/(context-locator)/ data/(urdf-docs),各子目录 README;本文档 X-F 系列与 §一 行号均为旧平铺布局引用,语义仍有效;见 README 22:30 |