# src/languages/xacro/core/ — 展开图与动态维护

> xacro 模块的"数据侧"核心(2026-09-07 目录化,随 ui/parse/data 分层;原 src/languages/xacro/ 平铺)。

## 定位

与 ui/(编辑器交互提供器)解耦的**图/索引与生命周期**层:include 展开图、符号表、可见性/兜底、
增量维护与监听——供 ui 提供器与诊断/补全查询,不含任何 register/vscode.languages 注册逻辑。

## 文件

| 文件 | 职责 |
|:--|:--|
| include-graph.ts | IncludeGraph:三阶段 build(静态骨架→${} 收敛→兜底)/ 增量 upsert-remove / 符号懒收集 / 可见性(expandOrder·findRoots·visibleSymbols·isVisible)/ findSymbol·findSymbolAny / fallback 反向搜索 / pullPackageFile / use-def 传播(D6)/ rename;文件搜索走 build-tool/walk barrel;**XG5**:scanIncludes/collectSymbols 改读 parse/XacroDocument 单遍解析 + getDocument(uri+version 缓存);**XG10**:IncludeEdge 增 ns/optional/isGlob + globLocalIncludes 本地枚举 + ${} 代换(resolveDollarBraces)扩展;**XG13/LA-1**:needFallback 域门控(fileInFallbackDomain,域外文件不再触发全仓反向检索) |
| xacro-watcher.ts | XacroWatcher:FileSystemWatcher 增量(按 uri 防抖)/ rename / onDirLoaded 事件重解析 / 60s 轮巡兜底 |

## 依赖与接线

- 入边:ui/diagnostic-provider、ui/completion-provider、ui/*-provider、core/xacro-watcher(include-graph);
  注册处 ui/providers.ts 创建 `IncludeGraph(pkg)` + `watcher.start()`。
- 出边:include-graph → languages/shared/{xml-utils, package-map}、build-tool/walk(index barrel)、logger。
- 规则:本层零 vscode.languages 注册、零 UI 决策;查询全部同步(内存),IO 外置(见文件头 S1-A 注)。

## 修改记录

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-29 | 文档补登(include-graph.ts 三批增量,文件表已同步;细则见根 README 修改记录 XG 各行):XG5(解析改读 XacroDocument 单遍模型 + uri+version 缓存)、XG10(IncludeEdge ns/optional/isGlob + glob 本地枚举 + ${} 代换扩展)、XG13/LA-1(fallback 域门控 needFallback/fileInFallbackDomain);自 09-09 后本目录 379 行代码变更首次入档 |
| 2026-09-07 22:30 | 目录化建档:include-graph.ts / xacro-watcher.ts 自 src/languages/xacro/ 迁入(相对 import 上移两级),git 历史与语义不变 |
| 2026-09-07 23:10 | 性能:IncludeGraph.fallback 全局单飞 + 排队(fallbackInFlight/fallbackPending)——同一时刻至多一次整仓反向扫描,快速切换/多文件未命中不再多波叠加;排队文件在当次完成后按各自 2s 防抖续扫 |
| 2026-09-07 23:16 | 重分析"合作式中断"(fallback 侧):候选文件 read+scan 循环按 40 条/片让出事件循环(setTimeout 0),长整仓扫描期间交互任务可插队;配合单飞与诊断分片(ui/README 23:16) |
| 2026-09-09 00:02 | resolveInclude 路径分隔符归一(用户:D1"目标文件不存在 …sensors\imu_array.xacro"与悬停的 `/` 路径前后冲突):解析前 `\`→`/`——属性值标准是 "/",posix 上反斜杠会解析成带 `\` 的字面名 → 目标恒"不存在"(D1 噪音、跳转与悬停结论冲突);归一后 D1 与悬停/跳转 target 同源一致;配合 ui 侧 isFileTarget 护栏(definition/document-link,见 ui/README 00:00) |
| 2026-09-09 00:23 | **活文本入图**(用户:警告产生/消除极慢,须保存+手动切文件——根因=FileSystemWatcher 只收磁盘事件、scanIncludes/upsert 全走 fs.readFileSync,未保存编辑从不进图,而 D1/D4/D5 全查图):①include-graph.upsert/scanIncludes 增可选 text 参(传活文本则免磁盘读,幽灵比对/边维护不变);②xacro-watcher 订阅 workspace.onDidChangeTextDocument,把未保存编辑的 live 文本经同一 300ms 防抖队列 upsert(fl 后照常 reparseDollarEdges+propagate);诊断 changeSub(300ms)本就随编辑调度 → 警告无需保存/切文件即跟随;tsc 0 错误 |
