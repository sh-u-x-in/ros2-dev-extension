# package-service — 包服务层

> 定位:围绕"包"的用户服务(数据消费者/写侧/执行侧),与 package-core(权威包数据中心)解耦;
> 数据源经注入 / import type,零运行时耦合 package-core(除类型形状)。
> 结构定稿:2026-08-30(config/create/build 三域;languages 不入本层,留 src/languages/)。

## 目录

| 目录 | 语义 | 内容 |
|:--|:--|:--|
| `config/` | **配置域**:构建配置(解析/读取/生成/修改)+ 可执行派生 | parse/ derive/ gen/ write/ |
| `create/` | **包创建域**(迁自 build-tool/create) | 模板展开 + 交互层 + 校验 |
| `build/` | **构建域**(迁自 build-tool/tasks,2026-08-30 改名 build) | 命令注册 + 智能构建流程 + 任务提供器 + 构建记忆(详见 build/README.md) |
| `run/` | **运行与启动域**(2026-09-25 建域):ros2 run / ros2 launch 智能执行 + 命令模板机制(share-spec)+ 参数预设与记忆 | 详见 run/README.md |
| `share/` | **共享层**(2026-09-22 升格,原 state/ 上提并入):参数模板机制(share-spec)+ 选择/构建记忆 + 工作区状态文件唯一读写(单写者队列 + 原子覆盖 + 字段所有者表) | state-file.ts / selection-memory.ts / build-memory.ts / share-spec.ts / defaults/(详见 share/README.md) |

## config/ 内部

> **2026-09-04 断电**:config 除 gen 外退役——exe-map/(可执行映射)与 write/(01 一键配置/02 重命名)无消费者且写回受插入形式限制不可行,接线/实例化/命令注册已移除,代码留档并 tsconfig exclude(不参与编译);对应测试套件一并排除。下表行保留为历史清单。

| 子块 | 语义 | 文件 |
|:--|:--|:--|
| `parse/`(原,已归并) | 构建配置解析(setup.py / CMakeLists.txt)——2026-09-03 并入 exe-map/parse | setup-parser.ts / cmake-parser.ts |
| `derive/`(原,已归并) | 配置 → 可执行派生(读侧)——2026-09-03 并入 exe-map/ | executable-map.ts / event-collector.ts / types.ts |
| `exe-map/` | (断电留档)可执行映射读侧 + 解析器(2026-09-03 收敛;2026-09-04 断电) | executable-map.ts / event-collector.ts / types.ts / parse/ |
| `gen/` | 编辑器配置生成(读快照+环境 → 智能提示配置;**活跃**) | intellisense-config.ts(编排)/ intellisense-api / intellisense-utils / intellisense-render / README.md(语义总说明;2026-09-08 intellisense-blacklist 已移除) |
| `write/` | (断电留档)构建文件改写器(01 一键配置 / 02 重命名;2026-09-04 断电) | configure-actions.ts / configure-file.ts / rename-actions.ts / package-rename.ts / anchors/ |

## 边界

- 依赖方向:外部 → package-service → package-core;执行/环境经 ros2/ api 注入;
- build-env-utils.ts:已废弃注释(历史参考,不参与编译)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-04 21:55 | i18n 期2批5(07号档案):构建/运行/launch 全域英文源化——register-commands 弹窗+日志、single-package、smart-build 两级 QuickPick+13 日志(空构建双角色按钮常量 t() 化)、share-spec build/run/launch 六日志、colcon-task-provider、preflight-warnings(PREFLIGHT_MUTE_LABEL 双角色 t() 化+4 日志)、install-layout-check(W1 四段拼接各自成键+LAYOUT_FLAG_HINT+4 日志)、install-method-check(W2/W3 长警告+探针日志)、smart-run/smart-launch 全弹窗+新同名 launch 歧义弹窗、pick-preset(CUSTOM_ITEM_LABEL+槽位 detail+8 日志,首条日志措辞去 ${0} 字面量防 l10n {N} 占位符误捕获)、selection-memory/state-file/build-memory;纯数据域补 import { l10n };share-expand/preflight/install-layout 测试 6 处值断言翻转;bundle +115=388 键;1307 全绿 |
| 2026-10-04 20:40 | i18n 期2 批2(D3 裁定英文化+期1 接缝收口):①生成戳记翻转为语言中立英文——STAMP_TAIL_MARK→`# [rde-ros-2 generated]`、XML 变体→`<!-- rde-ros-2 generated … -->`(写入用户文件的内容不 l10n,未发布翻转无历史包袱;旧中文戳记仅人读不参与判定,configure-actions.test 14 处断言同步翻转,anchors.test 中文夹具保留恰充旧戳兼容用例);②share/defaults 接缝:三出厂规格的 custom 描述与两条 argv describe 翻英文(语言中立数据非 UI 铬),package.json 五处 default 同步翻转(manifest 中文就此归零,share-expand 同步锁两处比对自然绿);全套 1307 用例 0 失败 |
| 2026-10-04 19:34 | i18n 期0(骨架,英文源+中文册已批):双角色串同源收口——①smart-build 空构建弹窗按钮「在设置中允许空构建」、configure-file 一键配置确认按钮「确认写入」、package-rename 弹窗「以文件夹名称为准,改写声明/忽略本次」四处字面量改同源常量(按钮=显示文案+返回值匹配键双角色,l10n 化后比较键不得是第二份字面量);②configure-actions 戳记键 `# [rde-ros-2 扩展生成]` 抽 STAMP_TAIL_MARK 常量,生成本体(stampComment)与幂等叠加判定(stampSnippet)同源,期 2 英文化只改一处;PREFLIGHT_MUTE_LABEL/BUILD_SIGNAL_REASON/ADD_MARKERS 三处本就常量同源免改;行为零变化,全套 1307 用例 0 失败 |
| 2026-09-29 | 文档同步:目录表修正——`state/` 行废除(2026-09-22 已上移 `share/`,原表漏改且仍指向不存在的 state/README.md),补 `run/`(2026-09-25 建域)与 `share/`(2026-09-22 升格共享层)两行导航;文末时间戳同步 |
| 2026-09-22 | **共享层收拢**:`state-write/state-file.ts` 与 `build/build-memory.ts` 一起上移进 **`share/`**(该目录升格为 package-service 的共享层:参数模板机制 + 记忆 + 工作区状态文件),`state-write/` 子域取消、README 并入 `share/README.md`;新增通用选择记忆 `share/selection-memory.ts`(按命令 id 分槽);新增「多写者纪律」 |
| 2026-09-07 22:54 | 溯源补登(本会话微调批次留痕):③ env 行集再收紧——前缀 include 无任何子目录(缺失/空/纯 Python·无头包)不产出行,撤销此前"退化保留父根"退路(防 `iii/include`、`fff/include` 等噪音行;22:44 定稿,intellisense-utils `clangdGroupDirs` + 单测 +1 → 24 例);④ 注释纠错——intellisense-config.ts 头注删除过期"include 目录监听(2026-09-02 修复漏洞)"表述(该 watcher 09-02 10:46 短暂加入、10:49 即删,现事件源仅包+环境两路),config/gen/README 与外部调研注记同步;⑤ 修改记录时间戳规范化(全部补齐精确到分) |
| 2026-09-07 22:50 | ① create 模板头文件布局 → **约定 B**(Humble+ 官方/rosidl 双层同款):cmake.ts「对外提供头文件/库」与安装段 DIRECTORY 示例改为装 `include/<pkg>/<pkg>`、`ament_export_include_directories(include/<pkg>)`、`$<INSTALL_INTERFACE:include/<pkg>`(**三处同源**),源码布局 `include/<pkg>/` 不变;新增回归断言锁定三处 B 值、禁 A 残留(create-cpp-package 53 例全绿)。② config/gen `.clangd` 行集层级收敛(**不再父子并列全列**):工作空间组只列 `-I<ws>/src/<pkg>/include` 父根(不再展开 `include/<pkg>` 子行);环境前缀组只列各包子根 `-isystem<prefix>/include/<pkg>`(不再列 `include` 父根;无任何子目录的前缀——缺失/空/纯 Python·无头包——不产出行)——旧「顶层+一级子层」形态(2026-09-06,为兼容 A/B 两套导出根而全列)在同步时被归正清除(旧 env 父行 / 旧 ws 子行 / 错位 -I);cpptools 侧保持父级 `/**` 递归不变。涉及 cmake.ts / test/suite/create-cpp-package.test.ts / intellisense-utils.ts / intellisense-render.ts / intellisense-config.test.ts(create-cpp-package 53 例 + intellisense-config 24 例全绿);gen 调研文档同步注记 |
| 2026-09-06 23:32 | config/gen 补可观测日志(此前调试只能靠落盘文件):渲染层(intellisense-render)每个真实写盘/变更决策留 info——c_cpp 生成 / 重排(管辖 N + 额外 M + 清 /usr/include K 计数、字段补齐升级明细)/ 结构异常重建 warn、.clangd 生成(分组计数)/ 更新(DB 收编、管辖归正移除行数、组内补缺失计数、flow 保守插入)、settings extraPaths 补充条数、remove* 有感删除计数与"无命中残留容忍"debug;编排层(intellisense-config)补触发可观测——重算入口(包数/消失候选/引擎侧)、易增 include 分组计数、难删复核跳过/黑名单命中/待弹窗明细、同意删除侧计数、拒绝记黑名单、订阅调度原因(包域变化/环境变化,800ms 防抖 trace)。纯附加,零行为变化;tsc + intellisense-config 23 用例全绿。涉及 intellisense-render.ts / intellisense-config.ts |
| 2026-09-06 18:35 | config/gen 语义收敛(管辖内破坏性归正,不做新旧形态兼容):① **不再收录 /usr/include 等编译器默认搜索路径**(隐式自带,收录=与系统路径重复;旧文件残留条目同步清除);② .clangd 工作空间组 `-I<dir>`、环境前缀组 **`-isystem<dir>`**(单 token,clang/g++ 连写均已实测接受),-I 无条件先于 -isystem 命中(与顺序无关,实测)——src 新头永远优先于 install/发行版旧头;③ .clangd 增量对**管辖条目**(当前 ws/env 目录集)破坏性归正:旧 `-I<env>`/错位/-isystem<ws> 移入规范组、重复行折叠、残留 /usr/include 清除;管辖外条目原地保留;不整块重排;④ c_cpp_properties includePath **整块重排**(短文件、策略靠顺序):[管辖规范序 ws src→环境前缀]+[管辖外额外条目原序去重],字段补齐/升级:缺 compileCommands 补 `${workspaceFolder}/build/compile_commands.json`、cppStandard 旧默认 gnu++17→**gnu++20**(跨平台恒写,对齐 .clangd);⑤ 单测 **23 项全绿**(新增归正/去重/重排/字段升级/多事件循环防重复用例)。涉及 intellisense-utils.ts / intellisense-render.ts / intellisense-config.ts / intellisense-config.test.ts |
| 2026-09-06 15:20 | config/gen(.clangd)修正与分组布局:① `CompilationDatabase: build` 收编为 **CompileFlags 子键**(顶层键在 clangd schema 无效——历史误写顶层;已存在文件同步迁移,块内已有保留用户值,无 CompileFlags 块则文尾补块);② Add 条目分组输出:通用标志(-Wall 保留 / -std=c++20)/ 工作空间包 include / 系统 include(环境前缀+系统头,按**来源**归组——前缀物理在工作区内也归系统),组间注释分隔、工作空间在前系统在后(此前系统在前);③ 带分组注释文件增量**按组定位插入**(新包进工作空间组、新前缀进系统组、标志置列表头),无注释旧文件/flow 保守不重排(维持原插入点),用户内容不动;④ removeClangdIncludes 删空组时清理本模块组注释标记(防孤儿);⑤ syncClangd 签名改 `{ ws, sys }`、collectAllIncludes 分组输出、parseClangdAddEntries 容忍 Add 内注释行;⑥ 单测 19 项全绿(新增分组展开/生成顺序/分组增量/旧文件迁移/注释兼容用例)。涉及 intellisense-utils.ts / intellisense-render.ts / intellisense-config.ts / intellisense-config.test.ts;设计稿与 gen 调研文档修改记录同步 |
| 2026-09-04 17:04 | create/ 域等价变换结构重构(详见 create/README §7.6): 校验/命名下沉 names.ts、kind 默认行入 kinds.ts、模板收敛 templates/、生成器瘦身为组装+公共 API 门面; 生成产物逐字节不变, 44 例对照 + 130 用例全绿 |
| 2026-08-31 18:33 | 建档(补记录):build/ 域结构治理完成——链路收敛 A(统一 RosTaskRunner.colcon_build)、依赖注入(BuildDataSource)、命令 ID 下沉(build/commands.ts)、index 唯一出口、rootPath 迁移(build-command.ts → workspaceFolders[0]);详见 设计/重构/package-service/build域结构整理调研-2026-08-31-0028.md |
| 2026-08-31 18:49 | build-command.ts 空构建分支彻底合并(空构建 = 包列表为空的特例,统一两级选择流程)+ makeConfigItems 抽出(纯函数) |
| 2026-08-31 23:55 | **新建 state/ 子域(通用状态文件层)**:build/state-file.ts 的通用读写 git mv 上提为 state/state-file.ts,补单写者队列(per-root Promise 链)+ 原子覆盖(tmp + rename),取消整文件覆盖式导出、唯一写入口改 updateStateFile;build 侧只留字段访问器 build-memory.ts;动机=未来 config/gen 的 include 黑名单要共用同一文件,避免 config → build 横向依赖与多写者互相覆盖;新增 test/suite/state-file.test.ts(9 用例,含并发不丢字段,可无头跑) |
| 2026-08-31 23:35 | build/ 合并①:register-task-provider.ts(原 build-tool.ts)并入 colcon-task-provider.ts——3 行注册壳与 provider 是 1:1 独占关系,"实现 + 注册动作"归一个文件;index.ts 导出符号不变,外部零改动;build/ 文件数 9 → 8(command-ids.ts 经讨论保持独立) |
| 2026-08-31 23:10 | build/ **名符其实改名批次**(git mv 保留历史):commands→command-ids、colcon-command→register-commands、build-command→smart-build、build-state→state-file、build-tool→register-task-provider、colcon→colcon-task-provider;ros-shell.ts 删除、install-type.ts 死代码清理、logger 前缀=文件基名;新建 build/README.md;本表 build/ 行语义同步(旧写"智能构建 + 任务提供器 + shell",shell 早已退役) |
| 2026-09-02 15:54 | executable-map(现 exe-map/) 收录修复配套:isBuildable 的 unignore 匹配改 `path.normalize` 后比较(防御分隔符/尾斜杠形态差异);上游 package-core/scan/colcon-list 输出路径绝对化(2026-09-02)后,unignore 与 walk 绝对 dir 全等匹配恢复——此前 colcon 权威注入后本映射反而全空(一键启动数据源断裂);详见 package-core/scan/README.md |
| 2026-09-03 14:07 | 路径同步:本行及 15:54 行 derive/executable-map 措辞改 exe-map/(derive/ + parse/ 2026-09-03 收敛为 config/exe-map/) |
| 2026-09-04 | **config 除 gen 外断电**:exe-map/ + write/ 无消费者且一键配置写回受插入形式限制几乎不可行——消费者已消失,生产者不必存在;extension.ts 实例化/订阅/命令注册全部移除,package.json ROS2.configureFile 命令与右键菜单贡献删除,tsconfig exclude 两目录及其 7 测试套件(不参与编译,代码/研究文档留档);见 config/README 下 exe-map/、write/ 目录头注记 |

<!-- 文件末尾修改时间:2026-09-29(目录表修正:state/ 行废除改指 share/,补 run/ 与 share/ 两行;详见修改记录 2026-09-29 行) -->
