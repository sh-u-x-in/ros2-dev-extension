# src/languages/xacro/ — .xacro/.urdf 语言服务

> .xacro/.urdf 编辑能力:include/宏/变量/link-joint 的跳转 + 可点击链接 + 悬浮、结构补全 + 表达式补全、D1-D14 诊断、watcher 动态维护(include 图为核心)。
> 设计基准:设计/xacro/00~12(2026-08-18 前后建档;个别时序声明已过期,见 03 审计 §四);**语法升级:13 号语法规范(humble+ 基线 2.0.7,官方源码逐条核实)+ 14 号解析器设计与实施计划(XG0~XG11,2026-09-24/25 实施)**。

## 1. 目录结构(2026-09-07 目录化:core/parse/ui/data + 根出口 index.ts;2026-09-24 XG1~XG4 parse/ 扩为语法层)

> 外部只经根 index.ts import;内部按层:core(图/维护)· parse(XML 光标解析 + xacro 语法层)· data(文档数据)· ui(提供器+装配+共享工具)。
> 每子目录各有 README。历史平铺见 git(2026-09-07 前;03 审计行号为旧布局)。

| 目录/文件 | 职责 |
|:--|:--|
| index.ts | 域唯一出口:registerXacroProviders + Xacro* 提供器类 + extractLeadingComment |
| core/ | include-graph.ts(图核心:三阶段 build/增量/可见性/use-def/环检测/兜底单飞分片;XG5 起解析走 parse/xacro-document 单遍模型 + uri+version 缓存;XG10 边模型 ns/optional/isGlob + glob 本地枚举 + ${} 代换扩展)、xacro-watcher.ts(监听/rename/轮巡/事件驱动) |
| parse/ | xacro-lexer.ts(XG1 $ 层词法:官方 LEXER 四态+issue)· macro-params.ts(XG2 params 全语法)· expression-tokens.ts(XG3 ${} 分词+refIdents)· xacro-tags.ts(XG4 固定标签/属性签名/SUBST_COMMANDS/EVAL_GLOBALS/XACRO_KEYWORDS 单源)· xacro-document.ts(XG4 单遍解析+XacroDocumentStore 缓存)· context-locator.ts(光标上下文;XG6 拆树参数核心) |
| data/ | urdf-docs.ts(URDF/关节类型文档纯数据表) |
| ui/ | providers.ts(装配 + 再导出)· definition-provider(精确跳转,锚点去光标化;XG8 点链/insert_block/call/ns.macro)· hover-provider(含 extractLeadingComment)· document-link-provider(仅 include,文件级链接)· provider-utils(共享日志/解析/锚点;XG6 docModelOf 缓存入口;XG8 nsIncludeTarget/resolveDollarDottedRef/resolveInsertBlockRef)· completion-provider(XG7 官方求值上下文/调用点宏参数/$() 命令全集/ns 点号)· diagnostic-provider(D1-D7 + XG9 D8-D14 语法级,分片可中断、只算激活) |
| 03-xacro模块审计.md / README.md | 审计 + X-F1~F12(2026-09-03 建档,行号为旧布局)/ 本文件 |

## 2. 关键设计

- 装配链(09 定稿):共享 PackageMap → IncludeGraph(注入 packages)→ XacroWatcher.start() → pkg.initialize().then(build);selector 用 pattern **/*.xacro、**/*.urdf(不干扰其它 xml;扩展名已挂 xml 语言);
- 事件驱动两大方向:环境变化 → refreshSystemList(extension 接线 ✅);工作区包表更新 → refreshWorkspace(✅ 2026-09-04 X-F1 已修:直挂 core.onDidChange,§3 旧断链分析仅作历史);
- 查询未中就绪走兜底(fallback fire-and-forget / 传播),启动不阻塞;
- **XG 语法层(2026-09-24)**:每文档版本一次解析(parseXacroDocument:lezer 树 + $ 词法 + 符号含宏参数),五类 provider 经 graph.getDocument/docModelOf 共享(X-F4 关闭);语法基线 = xacro 2.0.7(humble 起步,现网均 2.1.1,语法层逐字节稳定,13 号 §0);只做语法层——识别/定位/作用域符号表,不做宏展开、不求值(用户裁定)。

## 3. 已知问题(审计 X-*)

| 级别 | 要点 |
|:--|:--|
| ✅ 已修(2026-09-04) | X-F1:刷新链断——原 setPackageMapRefresher 无调用点;现 extension 直挂 core.onDidChange(workspace 域)→ refreshWorkspace,死机制移除,新包 $(find) 即时生效 |
| ✅ 已修(2026-09-25 XG 批次) | X-F3:XACRO_KEYWORDS 双份+幽灵词条 element_inject → parse/xacro-tags 单源(官方 10 标签);X-F4:每查询重解析 → docStore uri+version 缓存;表达式正则三处重复 → xacro-lexer 单源 |
| P2 | X-F6:fallback 隐式全仓重扫(XG13 已加域门控:域外文件不再触发;域内隐式重扫仍在);X-F7:文本驻留无 evict(XG5 裁定维持:include 边/符号/hover 注释提取均需文本,驱逐收益低于复杂度)、IncludeGraph 无 dispose |
| P3 | X-F8 blocker 死字段;X-F9 陈旧注释;X-F11/F12 注记 |

## 4. 测试

include-graph.test / xacro-completion.test(含 XG7)/ xacro-diagnostics.test / xacro-diagnostics-samples.test(X1-X5 零误报护栏 + X7 词法级 0-error)/ xacro-samples-integration.test(含 XG11 夹具)/ urdf-docs.test / package-map.test / **XG 新增**:xacro-lexer / xacro-macro-params / xacro-expression-tokens / xacro-document / xacro-navigation-xg8 / xacro-diagnostics-xg9 / xacro-include-edge-xg10。缺口:装配链、watcher 事件。

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-03 23:11 | 建档(信息独立):xacro 模块结构 README——文件职责、装配链与事件驱动、已知问题(X-F1 断链等)、测试;关联 03-xacro模块审计.md |
| 2026-09-04 01:05 | X-F1 修复(刷新断链):extension 直挂 packageCore.onDidChange(workspace 域变化 → xacroPackages.refreshWorkspace),setPackageMapRefresher 死机制移除;见 package-map.md §2.1 |
| 2026-09-06 23:01 | 用户反馈批次(跳转体验):① D5「变量未找到」Hint 三点标在 `${` 下 → 改标变量标识符本身(name 首字母至末字母);② 宏体内引用自身 params 形参(${name} 等)不再误报 D5——新增 parseMacroParams/collectMacroParamSpans/isMacroParamRef 纯函数(诊断模块导出,可测);③ DocumentLink 宏下划线统一:同文件"定义在前"的宏调用也产出可点击链接(原固定 (0,0) 位置致同文件宏永不落链接);④ Hover 悬浮框带出定义上方紧邻 `<!-- -->` 文档注释(extractLeadingComment);新增 xacro-providers.test.ts;见 03 审计修改记录 |
| 2026-09-06 23:15 | 用户反馈批次②(遮蔽与匹配语义):⑤ `${}` 变量解析改**形参遮蔽优先**(宏体内 `${name}` 若为该宏形参 → 跳转/悬浮/链接指向宏定义,不再落到 `<link name="${name}">` 模板或外部 property/arg;dollarVarAt 替代旧 isInDollarBraces 粗判,光标越过 `}` 不再误判在表达式内);⑥ link/joint/filename 属性值内嵌 `${}` 按变量语义解析,含 `${}` 的值不再做原文符号正匹配(DocumentLink 第 4 段整值跳过);⑦ DocumentLink 变量扫描支持表达式型 `${-chassis_hei/2.0}`,块内每个标识符按形参/property/arg 出下划线,位置精确到标识符;新增 enclosingMacroSpan 导出与单测 |
| 2026-09-06 23:25 | 用户反馈批次③(定义跳转锚点):宏/变量(property/arg)/link·joint 的定义跳转与形参跳转,锚点由"标签行首 `<`"改为 **name 属性值首字符**(如 `<xacro:macro name="bracket_mount">` 的 `bracket_mount`);新增 nameAttrColumn/symbolAnchorColumn(定义在另一文件时取图内驻留文本);name 折行等无法定位时回退原锚点,不影响既有可见性语义 |
| 2026-09-06 23:31 | 可观测性增强(调试日志):三个 UI 提供器补查询级日志——Definition/Hover 入口打印 file:行:列 + 行文本,分支决策 trace(include 候选列区间、${} 块内标识符、属性名/值、词与 chBefore),未命中 debug 打印原因线索(logMissReason/logVarMiss:存在但不可见 / 同名异型 / 全图无,经 findSymbolAny);DocumentLink 入口/出口统计(include/宏/变量/link-joint 产出数与各自未解析数),宏与 link 未解析逐条 trace、变量未解析首 10 条 trace;文件不在图内、光标不在词上等静默路径也显式留痕 |
| 2026-09-07 22:30 | 目录化重组(效仿 rosmsg):根新增 index.ts(域唯一出口,extension 改经它 import);ui/(五类提供器 + provider-utils + providers 装配)、core/(include-graph、xacro-watcher)、parse/(context-locator)、data/(urdf-docs)各子目录补 README;Definition/DocumentLink/Hover 拆成独立文件并补可观测日志;测试 import 路径同步;行为不变(tsc 0 错误于 worktree 验证) |
| 2026-09-07 23:45 | 下划线断电(用户终裁):DocumentLink 不再注册/导出(跨文件点击仅带 URI、落点受目标文件历史视口影响;F12 已精确,锚点去光标化 d8b7314);document-link-provider.ts 留档待"开关恢复";见 ui/README 23:45 |
| 2026-09-08 00:11 | DocumentLink 分层恢复(include-only):有下划线=文件级/包含跳转(仅 `<xacro:include filename>` 加下划线点开目标文件),无下划线=精确跳转(宏/变量/link-joint 走 F12/Ctrl+点击);document-link-provider 重写为只读 include 边;providers/index 恢复注册与导出;见 ui/README 00:11 |
| 2026-09-09 00:02 | 补全机制系列修复收尾(2026-09-08 全天,逐条见 ui/README 19:15/19:20/19:25/19:30/19:53/20:15/22:24/22:45/23:28/23:46、00:00;core 见 core/README 00:02):filterText 保留符号(超集)、trigger 体系重构与门控(`<` `{` `(` `/`)、`${}` 宏形参补全 + property 优先同名去重 + 变量项"定义+注释"文档(形参不附)、`$(…)` ⑤ 替换补全、`$(arg)` 引用识别(跨行 offset 扫描)、include filename ⑥ 单层路径(读 followSymlinks 设置/支持绝对路径)、include 跳转护栏(仅普通文件)+ 路径分隔符归一;tsc 0 错误 |
| 2026-09-25 01:30 | XG 语法层升级(XG0~XG11,设计/xacro/13+14):语法基线 humble+ 2.0.7;parse/ 增 $ 词法器/宏参数全语法/表达式分词/文档模型+uri+version 缓存(X-F3/F4 关闭);宏形参经 SymbolRef.params 入符号表(关闭审计登记缺口);补全增强(${} 求值上下文/调用点宏参数/$() 命令全集/ns 点号,顺修存量④mock 失败);导航增强(${} 点链/insert_block→宏参数或块属性/xacro:call/ns.macro);诊断 D8-D14(未闭合 Error/未知命令/调用点参数级/条件静态布尔/重定义/未知宏)+ X7 词法 0-error 护栏;include 边 ns/optional/isGlob + glob 本地枚举 + ${} 代换扩展;样例 grammar/ 夹具五文件;1067 测试 0 新增失败 |
| 2026-09-25 15:50 | XG12 ns 点号链 N 级寻址(用户 ns_lab 真实文件驱动):新建 ui/ns-resolve.ts(resolveNsQualified 逐级 ns= 下钻+无 ns 嵌套传染/nsDeclHopAt/collectNsTable/dottedMacroNameAt,独立模块避免 provider-utils↔diagnostic 循环依赖);definition/hover 点名分段导航(head/中段→ns= 声明、尾段→N 级寻址定义,修 head 段被普通宏分支提前 return 的死代码+误触发全仓兜底);D4/D14 点号名 ns 感知(消"未知宏 kit.plate"假阳性);补全 <xacro:kit./${kit. 升级 N 级(宏/属性/子 ns 续链);VM 真实文件复验 ns_lab+iii 三级链宏 6/6 属性 7/7 全命中;1086 测试 0 新增失败 |
| 2026-09-25 17:05 | XG13 兜底搜索域门控:文件不在 VS Code 工作区根内(系统包等跳转目标)→ needFallback 恒 false + fallback 入口拦截,消"跳到域外文件后未命中白烧全仓反向检索";fileInFallbackDomain 导出可测(win32 大小写不敏感/多根任一覆盖/无根恒域外);1093 测试 0 新增失败 |
| 2026-09-30 16:32 | **RE-2 悬浮注释 verbatim(用户裁定:显示注释包括换行和空格,外壳不管;设计 rosmsg/03-诊断接电.md §1④)**:extractLeadingComment 内文重写为原样保留(仅去 \r 与外壳放置换行,不 trim/不去缩进/不折叠空行),渲染 blockquote→围栏代码块(hover definitionMarkdown + 补全 symbolDocMarkdown 同构);清洗逻辑收进 provider-utils.verbatimCommentInner 双实现同源(补全侧 80 行窗口化扫描保留);xacro-providers.test 旧"合并去缩进"口径改 verbatim + 2 新用例;全量 1195 测试 0 失败 |
