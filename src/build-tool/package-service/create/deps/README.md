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
| `dep-pick.ts` | 多选 UI 壳 `pickDeps(kind)`:取候选 → QuickPick 多选(含「自定义输入...」)→ 合并 → 显式校验(失败弹错重开保留勾选);**数据源契约**:候选 = `unignored ∪ system`(工作区侧含未构建 / 环境侧 system 非空直接用, null → 现跑 `pkg_list`), **两侧皆空**才降级纯输入框;Esc = 终止 | vscode、`./dep-lang`、`./dep-merge`、`./dep-parse`、`./dep-catalog`、extension(packageCore)、ros2/api |

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
| 2026-10-07 | **dep-pick 标题统一 + CUSTOM_LABEL 双角色解耦 + 清残**:多选/自定义/降级 3 弹窗标题接流名;「自定义输入」判定改项上 isCustom 标记(原按 label 反查——label 已本地化随语言变;重开恢复拆为 picked 名单 + wantsCustom 布尔);「[本工作区包]」「[纯 Python 包]」标记、占位符、首项描述、cpp-only 拦截报错进 l10n;dep-parse 升级/跨体系两消息表 + 格式报错 + depAnnotation 两标注 l10n 化(表值模块装载期翻译,同 pick-preset CUSTOM_ITEM_LABEL 先例) |
| 2026-09-04 17:11 | 建档:create/ 分类后补子目录 README——deps/(catalog 分类表 + parse/merge 纯函数 + pick UI 壳; 数据源契约与标签语义锚点) |
| 2026-09-14 (实施) | 候选来源修订:**候选 = 工作区(含未构建) ∪ 环境**, 新增 `dep-lang.unionCandidateNames`, `dep-pick` 降级判据改"两侧皆空"; 表内补 `dep-lang.ts` 行(2026-09-06 建档时漏登记) |
