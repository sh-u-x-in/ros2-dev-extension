# src/languages/xacro/ui/ — 编辑器交互提供器层

> xacro 的 UI 面(2026-09-07 目录化;原 providers.ts 拆分 + completion/diagnostic 迁入)。

## 定位

所有 `vscode.languages.register*` 提供器实现 + 装配(ui/providers.ts)+ 共享查询工具(provider-utils.ts)。
数据来自 core/include-graph(图查询)与 core/xacro-watcher(维护),文档数据取 ../data/urdf-docs,
光标解析上下文取 ../parse/context-locator。对外唯一出口 = 模块根 index.ts(本层 providers 再导出)。

## 文件

| 文件 | 职责 |
|:--|:--|
| providers.ts | 装配 registerXacroProviders(共享 PackageMap → IncludeGraph → watcher → 注册)+ 对外再导出;交互:精确跳转 + include 文件级链接 + 悬浮 |
| definition-provider.ts | XacroDefinitionProvider(F12/Ctrl+点击):include → ${} 变量(形参遮蔽)→ 属性字面 link/joint → 宏调用;命中返回名称 Range(cpp 式全选,锚点去光标化) |
| hover-provider.ts | XacroHoverProvider:include 目标 / ${} 变量与形参 / 元素·关节类型文档 / link-joint / 宏调用;extractLeadingComment(定义上方注释入悬浮框)随本文件 |
| document-link-provider.ts | XacroDocumentLinkProvider(include-only):仅 `<xacro:include filename>` 值加下划线 → 文件级跳转(点开被包含文件);宏/变量不下划线 |
| provider-utils.ts | 提供器共享:log、queryAt/logMissReason/logVarMiss(异步原因线索)、dollarVarAt、resolveDollarRef(形参遮蔽优先)、nameAttrColumn/symbolAnchorColumn/symbolNameRange/macroParamRange、attrAtDocument/attrWithOffsetsAt |
| completion-provider.ts | UrdfXacroCompletionProvider:结构补全(50 片段)+ ${} 动态补全(依赖 graph/上下文);**XG7**:求值上下文判定 / 调用点宏参数 / $( ) 替换命令全集候选;**XG12**:ns 点号链候选(ns-resolve);路径补全统一 walk 口径(读 ROS2.search.followSymlinks) |
| diagnostic-provider.ts | registerXacroDiagnostics(**D1-D14**(XG9 语法级 D8-D14:D10/D11 调用点参数级、D14 未知宏 ns 感知),含宏形参 D5 豁免,分片可中断、只算激活)+ 纯规则导出(isPackageRef/classifyEdge/环检测/parseMacroParams/collectMacroParamSpans/enclosingMacroSpan) |
| ns-resolve.ts | **ns 点号链 N 级静态寻址(XG12,2026-09-25 新建,303 行)**:官方语义镜像(逐级经 ns= include 下钻子命名空间表、无 ns 嵌套向下传染、链上任一跳悬空即失败);消费方 definition/hover(点名分段导航)/diagnostic(D4/D14 ns 感知)/completion(ns 链候选);独立成模块避免 diagnostic ↔ provider-utils 循环依赖 |

## 依赖与接线

- 查询链统一:Definition/Hover → provider-utils.resolveDollarRef(或图 findSymbol)→ core/include-graph;
- DocumentLink(include-only)不解析文本:直接读 graph include 边(line/startColumn/endColumn/target);
- 未命中原因经 findSymbolAny 分级(不可见/同名异型/全图无)后台记 debug 日志,便于排查;
- 出边:ui/* → core/include-graph、ui/diagnostic-provider(跨度工具)、../parse/context-locator、../data/urdf-docs、../../shared/{xml-utils,package-map}、logger。

## 修改记录

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-29 | 文档补登(2026-09-09 ~ 09-28 十批次,细则见根 README XG 各行):①新增 **ns-resolve.ts**(XG12,文件表已入);②诊断 D1-D7 → **D1-D14**(D10/D11 调用点参数级、D14 ns 感知);③补全 XG7 求值上下文/宏参数/$( ) 全集、XG12 ns 链、路径补全读 search.followSymlinks;④definition/hover XG8 点链导航、XG13/LA-1 域外早退(fileInWorkspaceDomain) |
| 2026-09-07 22:30 | 目录化建档:providers.ts 拆为 definition/document-link/hover/provider-utils 四件 + providers 装配;completion-provider/diagnostic-provider 平迁入 ui/ |
| 2026-09-07 23:06 | 跳转锚点去光标化(用户反馈:光标叠加影响跳转结果):link/joint 字面与宏调用跳转的可见性判定锚点改为"属性值起点 / 宏名词首"(新增 attrWithOffsetsAt),不再使用事件光标在值内/行内的子位置;${} 路径本已锚引用本体;tsc 0 错误(worktree) |
| 2026-09-07 23:10 | 性能(用户确认方案):① 原因线索日志异步化——logMissReason/logVarMiss 仍保留日志,但全图 findSymbolAny 探测改 250ms 后台 + 每(文件+名+类)去重,不再阻塞交互查询;② 诊断只算激活文件——open/激活切换统一 300ms 防抖调度,到期若已非激活则跳过(暂停),切回自动重排(恢复),不再按打开顺序批量预计算非激活文档;fallback 全局单飞见 core/README 23:10 |
| 2026-09-07 23:16 | 重分析"合作式中断"(用户确认:分片 + 轮询检查):诊断 refresh 改异步分片(runChunked,每 200 条让出事件循环一次并检查激活文档,切走即中断、不发布,切回激活重算;并发守卫 refreshBusy 防同文档重入);D4/D5 重查(findSymbol/findSymbolAny)移入分片内执行 |
| 2026-09-07 23:45 | 下划线断电(用户终裁:去下划线保精准跳转):DocumentLink 不再注册/导出(跨文件点击仅带 URI、落点受目标文件历史视口影响,F12 已精确);document-link-provider.ts 断电留档(文件头注"待开关恢复"),index/ui-providers 同步收口;tsc 0 错误 |
| 2026-09-08 00:11 | DocumentLink 分层恢复(include-only,用户新认知:有下划线=文件级/包含跳转,无下划线=精确跳转):document-link-provider 重写为仅 `<xacro:include filename>` 加下划线(直接读 include 边,点开目标文件);宏/变量/link-joint 保持无下划线,走精确 F12/Ctrl+点击(锚点去光标化);providers 恢复注册,index 恢复导出;tsc 0 错误 |
| 2026-09-08 00:30 | 补全条目消歧(对齐 launch):同类 prefix 片段在列表直接可见简短中文关键词(SNIPPET_HINTS,如 box(长方体) vs box(几何·长方体)、origin(rpy) vs origin(xyz·rpy)),中文不前置、filterText 保留原 prefix 保模糊匹配;detail 仍为完整描述;单测不受影响;tsc 0 错误 |
| 2026-09-08 00:52 | filterText 结构头部主词化(对齐 launch 规则):snippetFilterTokens 从片段正文头部抽 token(去 ${…} 占位/引号值,取标签名+属性名前若干),并入原 prefix、去重限量(≤8)、纯 ASCII——如 `<box size=…>` → "box size"、完整 `<joint name type …>` 可被 "joint name" 命中;中文仅留在 label 不进 filterText;tsc 0 错误 |
| 2026-09-08 19:15 | filterText 保留符号修正(用户:旧"只留前半段主词"决策致带符号输入片段无法命中,如 `<env n` 永远匹配不上 "env name"):snippetFilterTokens 拆为 snippetHeadLiteral(保留 `<box size=` 这类带 `<`/`=` 的结构头字面量,纯 ASCII、≤48 字符)+ snippetWordTokens(原 ≤8 词流);filterText = 头字面量 + 单词流(超集)——纯字母输入命中不回退,带符号输入片段亦可子序列命中;仅 xacro 模块改动(launch/cpp/py 未动,待验证后再统一);tsc 0 错误 |
| 2026-09-08 19:20 | 自动触发 + 去头插入(用户实测:手动触发全出现、自动不出表 = 匹配无问题、只是 `<b` 未被纳入自动触发):① providers.ts 补全注册 triggerCharacters 加 `"<"`(原仅 `"$"`)——敲 `<` 即唤起本提供器(tagStart 片段自动入表);② completion-provider 新增 isTypingTagName:光标前正在敲未闭合标签名(如 `<box`)时,元素片段 insertText/documentation 去掉首行 `<`(filterText 仍按带 `<` 的完整片段),根治"手输 `<` + 片段自带 `<` → `<<box…`";tsc 0 错误 |
| 2026-09-08 19:25 | ${} 补全补全宏形参 + "$" 触发生效(用户三连:①无片段以 $ 开头,"$" trigger 只为 ${} 服务;②"$" 敲下不跳表 = ④ 在 "$" 后(未敲 "{")返回空 → 注册无意义;③手动表里无宏变量 = 光标所在宏的形参不进候选,长期缺口):④ 重写为 dollarVarCtx 两态——inBraces(已在 ${} 内)照旧插名字、atDollar(刚敲 "$")插 "{name}"(总成 ${name}),"$" 处即有候选自动跳表;候选 = 最内层宏形参(collectMacroParamSpans/enclosingMacroSpan,遮蔽优先,跳过 1 万行大文档同降级)+ include 图可见 property/arg(同名形参遮蔽);tsc 0 错误 |
| 2026-09-08 19:30 | 触发字符 "$" → "{"(用户评审:弹表时刻应=变量名槽位形成,"$" 弹早了、需 atDollar 补丁、且误弹 "$(find pkg)"):providers.ts triggerCharacters 改 "<"、"{"(删 "$");completion-provider 删除 DollarCtx/atDollar 态与 "{name}" 补丁插入,④ 只留 inBraces 一态、insertText=纯名字;候选/形参逻辑不变;将来做 $(…) 替换补全再单独注册 "("(后话);tsc 0 错误 |
| 2026-09-08 19:53 | $(…) 替换补全(方向2 落地;用户三向权衡:只做 "(",不做 "}" 自动闭合、不做 ±*/ 运算符 trigger——后者如 xyz="-${chassis_axle_x}" 在 ${} 外也大量出现、必误伤):providers.ts trigger 加 "(";completion-provider 增 ⑤——isInDollarParen 判定,函数名位(find/find-pkg-share/arg,insertText 带尾空格)→ 参数位(find* → PackageMap.getPackageNames 工作区+系统包名;arg → graph 可见 arg 名);并加 trigger 门控:非 "<" 的窄 trigger("{"、"(")只服务各自上下文(非命中 return undefined),静态片段分支再排除 ${...}/$(...) 内与 "{"、"(" 独占,杜绝 "(a"/文本 "(" 误弹;构造器增可选 pkg(PackageMap);tsc 0 错误 |
| 2026-09-08 20:15 | xacro:include filename 单层路径补全 ⑥(用户定稿:只补一层——多层/大目录弹大量列表不美观;像头文件那样每次只提示当前层;多层靠"选目录带尾 / 继续"逐层完成):ctx.role=attrValue+attrName=filename+元素 xacro:include 时,attrValuePrefixAt 取同行光标前值前缀(跨行/越出引号静默跳过);includeFileCandidates 解析有效目录根(相对=当前文件目录与 resolveInclude 同口径 / $(find pkg) 与 package:// 经 PackageMap.get/resolvePackageDir 取包根)→ 前缀拆"目录段+当前词"→ 只 readdir 一层(目录在前、文件只收 .xacro/.urdf、跳点文件);值内含 "${…}" 或未闭合 "$("(⑤ 地盘)不介入;**符号链接跟随 = 读 ROS2.colcon.build.followSymlinks(readFollowSymlinksSetting,默认不跟随与 ts-walk 同口径)**,非"写死";无需新 trigger(段边界后敲字母经 quick suggestions 自动再问);tsc 0 错误 |
| 2026-09-08 22:24 | "$(arg name)" 引用识别 + 悬停展示语义收窄(用户定稿:普通变量悬停应显示"定义 + 定义上方注释",形参不显示——形参是 params="a b c" 多参数堆叠、无逐参注释):① provider-utils 新增 dollarParenArgAt($(arg name) 行内扫描,与 dollarVarAt 对称,命中返回名字+列范围);② definition-provider 增 2.5 分支:$(arg x) 的 x → findSymbol(kind=arg) 强制 arg(同名 property 桥接不遮蔽,<xacro:property value="$(arg x)"> 里点 x 跳命令行 arg 定义,复用 symbolNameRange/名称锚定);③ hover-provider 增 2.5 分支同款悬停(definitionMarkdown:定义行 + 上方紧邻注释 extractLeadingComment);④ hover-provider 形参分支改为最小身份文案(宏参数 x(宏 y 的形参)+ 定义于 文件:行),不再经 definitionMarkdown(不再带宏整体注释与定义行);tsc 0 错误 |
| 2026-09-08 22:45 | dollarParenArgAt 改全文 offset 扫描(用户质询:${parent 跨行能识别、$(arg 跨行为何不行——原因=实现偷懒用了行级 lineText,非机制限制):改为与 dollarVarAt 同法——全文找光标前最近的未闭合 "$(",`$(` 到名字间校验 `[空白含换行]* + arg + 空白含换行`,名字 = 光标处词字符;返回起止 offset,definition/hover 经 positionAt 转换(悬停高亮跨行 wordRange 用 offset Range);落在 arg 关键字/空白/已闭合对之外 → undefined;tsc 0 错误 |
| 2026-09-08 23:28 | 变量表去重 + 文档 + 层进连贯(用户三连实测:①`$(find iii)/` 手敲 "/" 不弹;②选目录后不连贯、无法续弹;③`${p` 仍两个同名变量、且列表旁详细描述无定义):④ 重写——property/arg 按名去重且 **property 优先、arg 补位**(${} 解析顺序 property→arg,同名并存只认 property,arg 归 $(arg)(⑤) 消费,消"两个同名变量");property/arg 项附 documentation=定义行 + 定义上方紧邻注释(symbolDocMarkdown,与 hover 同构;adjacentCommentAbove 窗口化 ≤80 行,防补全逐键全文 regex;形参项不附——多参数堆叠无逐参注释);providers.ts trigger 增 "/"(窄用途:仅 xacro:include filename 值内层进,ctx 门控于其余位置一律不提供,避免文本/URL/`</` 误弹);目录项 command=editor.action.triggerSuggest,选中目录自动续弹下一层;tsc 0 错误 |
| 2026-09-08 23:46 | include filename ⑥ 支持**绝对路径**(用户实测:绝对路径不弹——根因=旧 seg 切分把 "/usr/…" 开头空段丢掉后 `join(base,…)` 拼到当前文件目录,静默走错目录):目录推导改三分支——rest 以 "/" 或盘符开头 → 绝对(目录部分 path.resolve,空目录部分如 "/"=根);否则 join(base, 目录段);"~" 刻意不展开(xacro/roslaunch 均不解释 ~,与 resolveInclude 一致,视为字面目录);POSIX 语义冒烟(绝对多段/仅首段/仅根/相对/./../)通过;tsc 0 错误 |
| 2026-09-09 00:00 | include 跳转护栏 + 路径分隔符归一(用户实测两连:①写到一半的目录也能跳、VS Code 报"是目录";②D1"目标文件不存在 …sensors\imu_array.xacro"与悬停的 "/" 路径前后冲突):①provider-utils 新增 isFileTarget(stat 须为普通文件)——definition 的 include 分支与 filename 分支、document-link-provider 三处护栏:目录/半路径/未落盘一律不跳/不给下划线(半路径目录编辑态不再误跳);②include-graph resolveInclude 分隔符归一 `\`→`/`(属性值标准是 "/";posix 上反斜杠会解析成字面名 → 目标恒不存在,造成 D1 噪音与前后冲突),D1 告警文本与悬停 target 从此同源一致;tsc 0 错误 |
| 2026-09-09 00:23 | trigger 补 `"\"`(用户:/ 能弹、\ 不弹,二者应为兄弟):providers.ts triggerCharacters "/" 与 "\" 并列注册,completion-provider 门控改 `trig==="/" || trig==="\\"`(仍仅 xacro:include filename 值内,其余位置不提供);配合 core 活文本入图(core/README 00:23),警告/跳转即时跟随未保存编辑;tsc 0 错误 |
