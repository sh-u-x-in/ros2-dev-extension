# deps/ — 依赖域(候选 / 解析 / 合并 / 分类)

> create 子域的"额外依赖"全套:候选数据、解析校验、消费形态分类、多选交互。
> 纯函数层(dep-catalog/merge)零 vscode、可无头单测;dep-parse 校验消息走 l10n(2026-10-04 批13 起,可经 stub 无头单测);dep-pick 是唯一 UI 壳。
> 设计依据:04-包创建依赖多选-具体设计方案.md、05-包依赖标签研讨与humble清单对照.md、06-member_of_group与包选择关系研讨.md(均在 ../ 根)。
> 创建:2026-09-04 17:11(等价变换分类后补各子目录 README)。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `dep-catalog.ts` | 分类目录常量表 `DEP_CATALOG`(271 条,消费形态 5 类:C1 depend / C2 buildtool / C3 exec / C4 元包 / C5 演示)+ `lookupDep` / `depTagClass`(未收录兜底 depend)/ `depDescription`(QuickPick 作用说明);接口意图:`INTERFACE_GENERATOR_SIDE`(11)/ `INTERFACE_RUNTIME_SIDE`(9)/ `hasInterfaceIntent`(标配对 → member_of_group 注入判定) | 纯数据,零依赖 |
| `dep-parse.ts` | 解析与按 kind 校验:`parseDepList`(空格/逗号分隔)、`validateDepList`(包名格式 → 升级信号 → 跨体系不可能)、`depAnnotation`(元信息标注);`DEP_BUILTIN` / `DepCheckKind` 门面转发 `../kinds` | `../naming/names`(validatePackageName)、`../kinds` |
| `dep-merge.ts` | 多选合并纯函数:`mergeDeps`(勾选 ∪ 自定义,内置过滤 + 去重)、`excludeBuiltin`(候选剔除内置)、`validateFinal`(合并后显式逐项校验) | `./dep-parse` |
| `dep-lang.ts` | 来源/语言判定纯函数:`makeLangContext` / `isWorkspaceDep` / `isPythonDep`(工作区 buildType 权威, 系统包 KNOWN_PYTHON_ONLY 兜底);`unionCandidateNames`(**候选并集** = 工作区已确认包(含未构建) ∪ 环境可见包, 按名去重、工作区在前) | `./dep-catalog` |
| `dep-pick.ts` | 多选 UI 壳 `pickDeps(kind)`:取候选 → QuickPick 多选(内置依赖以「已自动选择,取消无效」预勾选形态**置顶显示**(2026-10-12,原自动隐藏——用户搜索内置包无命中会误判环境故障;取消无效由生成器无条件写入 + mergeDeps 恒过滤保证)→ 含「自定义输入...」)→ 合并 → 显式校验(失败弹错重开保留勾选);**数据源契约**:候选 = `unignored ∪ system`(工作区侧含未构建 / 环境侧 system 非空直接用, null → 现跑 `pkg_list`), **两侧皆空**才降级纯输入框;Esc = 终止 | vscode、`./dep-lang`、`./dep-merge`、`./dep-parse`、`./dep-catalog`、extension(packageCore)、ros2/api |

## 边界与依赖方向

- 候选 = **工作区已确认包(unignored, 含未构建) ∪ 环境可见包(system, 只表示工作空间以外)**；工作区侧名称已过 package-core 合法性检查，故允许未构建；**环境侧不再兜底工作区包**（2026-09-14 修订，原"只含已构建"约束反转，见 04 文档 §1/§3）；
- 标签语义锚点(05 文档 §2):**消费形态决定标签**——C1 三标签(安全超集)、C2 buildtool_depend、C3 exec_depend(不 find_package)、C4/C5 仅标注不写;
- member_of_group 与依赖标签**正交**(06 文档):仅"生成器侧 + 运行支撑侧标配对"同时勾选时注入;
- dep-pick 依赖 package-core/ros2(组合根注入),其余文件可无头 mocha。

## 扩展位(后续调整入口)

- 新发行版包名/分类修正:改 `dep-catalog.ts` 表(或未来模式兜底,当前 B1 方案:未收录默认 depend);
- 新"升级信号/跨体系"规则:改 `dep-parse.ts` 的 UPGRADE/IMPOSSIBLE 表;
- 多选交互/数据源契约演进:改 `dep-pick.ts`。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-13 23:40 | **描述转义 `\|` 补遗(同 feature,用户裁定)**:value 支持转义——分隔符只认**未转义**的 `|`(扫描按转义单元跳过 `\x`),描述段 `\|` 反转为字面竖线;cpp 描述可自然携带 `|`,消除"首段静默丢弃"陷阱;旧 leading-`|` 写法向后兼容;nls×2/docs×2 补转义说明;测试 +3 |
| 2026-10-13 23:19 | **用户补充索引:候选描述覆盖表(用户裁定,新设置键 ROS2.packages.userIndex,type=object)**:动机 = 候选描述全随扩展写死(工作区包无描述/系统包 catalog 写死/未知包),用户无从补充与修正;语义 = **匹配式覆盖,非注入**——键 = 包名(纯名,JSON 键唯一=每包名一规则,匹配零歧义;lang 段按用户裁定移入 value),值 = "[py|]<描述>"(py 前缀强制 [纯 Python 包] 标注;**前缀段恒丢弃**——含拼错的 osdcno\|,描述取首个 \| 之后全文可再含 \|;无 \| = 全值为描述 cpp 默认);命中候选 → description 替换 + detail 强制标注;**未命中条目不显示**(不做候选注入);非法包名解析期不校验、原样显示,提交走既有 validateDepList(「由用户决定」=提交校验);解析/查表收纯函数(parseUserIndexValue/descriptionOverrideOf,dep-lang 层);UI 壳仅接入 description/detail 两处,excludeBuiltin/mergeDeps/校验/拦截零改动;测试 +9(parse 5/override 3/键名锁 1),1359 用例 0 失败 |
| 2026-10-12 22:52 | **徽标文案去歧义(用户指出)**:「取消无效」两读(取消后无效果 vs 无法取消)→ 改为结果陈述「[内置依赖:始终包含,勾不勾选都会生成]」(en: always included, whether checked or not)——不评价勾选行为,只陈述不变事实;册键随英文源串同步换键 |
| 2026-10-12 22:44 | **内置依赖改「显示 + 已自动选择」(用户裁定,废 2026-09-01 自动隐藏)**:动机 = 用户搜索内置包(rclcpp 等)列表无命中,误判扩展/环境故障;QuickPick 列表内置项以预勾选 + detail 徽标置顶显示(可被搜索命中);"取消无效"由既有机制保证(生成器无条件写入 + mergeDeps 恒过滤 extra,用户点掉勾生成物不变;QuickPick 无禁用项故徽标预告而非强制回勾);excludeBuiltin/mergeDeps 纯函数与既有测试零改动(语义仍=可选项区不含内置);徽标进 l10n 册(+1 键) |
| 2026-10-12 22:44 | **内置依赖改「显示 + 已自动选择」(用户裁定,废 2026-09-01 自动隐藏)**:动机 = 用户搜索内置包(rclcpp 等)列表无命中,误判扩展/环境故障;QuickPick 列表内置项以预勾选 + detail 徽标「[内置依赖:已自动选择,取消无效]」置顶显示(可被搜索命中);"取消无效"由既有机制保证(生成器无条件写入 + mergeDeps 恒过滤 extra,用户点掉勾生成物不变;QuickPick 无禁用项故徽标预告而非强制回勾);excludeBuiltin/mergeDeps 纯函数与既有测试零改动(语义仍=可选项区不含内置);徽标进 l10n 册(+1 键) |
| 2026-10-07 | **dep-pick 标题统一 + CUSTOM_LABEL 双角色解耦 + 清残**:多选/自定义/降级 3 弹窗标题接流名;「自定义输入」判定改项上 isCustom 标记(原按 label 反查——label 已本地化随语言变;重开恢复拆为 picked 名单 + wantsCustom 布尔);「[本工作区包]」「[纯 Python 包]」标记、占位符、首项描述、cpp-only 拦截报错进 l10n;dep-parse 升级/跨体系两消息表 + 格式报错 + depAnnotation 两标注 l10n 化(表值模块装载期翻译,同 pick-preset CUSTOM_ITEM_LABEL 先例) |
| 2026-09-04 17:11 | 建档:create/ 分类后补子目录 README——deps/(catalog 分类表 + parse/merge 纯函数 + pick UI 壳; 数据源契约与标签语义锚点) |
| 2026-09-14 (实施) | 候选来源修订:**候选 = 工作区(含未构建) ∪ 环境**, 新增 `dep-lang.unionCandidateNames`, `dep-pick` 降级判据改"两侧皆空"; 表内补 `dep-lang.ts` 行(2026-09-06 建档时漏登记) |
