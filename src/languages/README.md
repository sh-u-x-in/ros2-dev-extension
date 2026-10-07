# src/languages/ — 语言服务域总览

> 为 .msg/.srv/.action、.xacro/.urdf、.launch.py/.launch/.launch.xml 等 ROS 文件提供 IntelliSense 能力(解析/索引/跳转/悬停/链接/补全/格式化/诊断)。
> 2026-09-03(项目结尾):各模块结构信息独立为目录内 README,与代码同放;审计与修复状态见各目录 0x-*模块审计.md 与 00-总览-language域审计.md。

## 1. 目录与文档地图

| 目录 | 内容 | 结构文档 | 审计/修复 |
|:--|:--|:--|:--|
| rosmsg/ | 消息接口语言服务(.msg/.srv/.action) | rosmsg/README.md(2026-09-03 独立/完善,最详) | 02-rosmsg模块审计.md |
| launch/ | launch 文件语言服务(三格式补全 + launch.py/XML/YAML include 链接;launch.py 于 2026-09-08 解冻恢复并升级为"简单变量表+静默") | launch/README.md | 01-launch模块审计.md |
| xacro/ | .xacro/.urdf 语言服务(IncludeGraph + 提供器 + watcher) | xacro/README.md | 03-xacro模块审计.md |
| python/ | ROS 2 Python 节点片段(rclpy,动态注入:排除 *.launch.py + ROS 工作区门槛,2026-09-07/08) | python/README.md | — |
| cpp/ | ROS 2 C++ 节点片段(rclcpp,动态注入 + ROS 工作区门槛,2026-09-08) | cpp/README.md | — |
| shared/ | 跨模块共享:xml-utils(lezer XML 只读工具)/ package-map(两级包路径解析)/ ros-workspace-gate(工作区闸)/ workspace-domain(工作区根域判定,2026-09-25) | shared/README.md(package-map.md 专项记录已删,结论并入 README 与代码注释) | — |
| 根 | 域总览(本文件)+ 全域审计总览 | README.md | 00-总览-language域审计.md |

## 2. 接线现状(组合根 extension.ts)

| 顺序 | 动作 | 说明 |
|:--|:--|:--|
| ① | registerRosMessageProviders(context, xacroPackages) | rosmsg 语言提供器(共享包实例注入,2026-09-03 起) |
| ② | const xacroPackages = new PackageMap() | 共享包路径解析实例(语言域共用) |
| ③ | registerXacroProviders(xacroPackages) | xacro 提供器 + 预热 build |
| ④ | packageCore.onDidChange(ev.system) → xacroPackages.acceptSystem(ev.system) | 系统包表经 core 回推喂入(2026-09-04 收尾:env → core.refreshSystem → ev.system → acceptSystem;含种子:激活时 system 域已就绪则立即喂入) |
| ⑤ | packageCore.onDidChange(ev.workspace) → refreshWorkspace() | 工作区包表刷新(✅ 2026-09-04 已修:setPackageMapRefresher 死机制移除,直挂 core.onDidChange) |
| ⑥ | registerLaunchProviders(xacroPackages) | launch 复用同一实例 |
| ⑦ | registerRosPythonCompletion() | rclpy 节点片段动态注入(2026-09-07;排除 *.launch.py;ROS 工作区门槛) |
| ⑧ | registerRosCppCompletion() | rclcpp 节点片段动态注入(2026-09-08;ROS 工作区门槛) |

## 3. 依赖与数据约定(合规集)

- 数据源:包数据经 build-tool/package-core/api(getPackageCore 门面:workspace/unignored/ignored/system/all 5 域);
- 搜索:build-tool/walk barrel(walkOptions/walkWithTimeout,统一排除/超时/符号跟随);
- ros2 访问:ros2/api barrel(composeApi + Ros2ServiceApi 类型);系统消息枚举经 interface_list(2026-09-03 R4 收编);
- 禁止:import extension、vscode.workspace.findFiles、rootPath、getExtension(全域 0 命中,清洁度核对应见 00 总览 §四);
- 例外(需知):build-tool/package-core/scan/package-xml.ts 与 package-service/config/write/anchors/xml.ts 反向 import shared/xml-utils(公共只读工具,归属错位,G1);
- 系统包目录:package-core system 域只有名单(dir 空),目录查询归 ros2ServiceApi.pkg_prefix;语言域统一入口(PackageMap.resolveSystemPackageDir)待决未落(08-23 文档欠账,G3)。

## 4. 跨模块问题索引(详见 00-总览 G1-G8)

| # | 一句话 | 落点 |
|:--|:--|:--|
| G1 | xml-utils 物理归属 languages/ 被 build-tool 反向依赖 | shared/README |
| G2 | PackageMap 工作区包表刷新链断 → ✅ 已修(2026-09-04:extension 直挂 core.onDidChange) | xacro X-F1 |
| G3 | 包发现双轨 → ✅ 已收敛(2026-09-03 R2 闭环:自持 package.xml watcher 删除,订阅 core workspace 域事件重扫) | rosmsg 02 R2 |
| G4 | rosmsg 系统索引键格式 bug(已修 R1) | rosmsg 02 R1 |
| G5 | launch XML 链接未切共享 PackageMap(陈旧 CLI 兜底)→ ✅ 已修(2026-09-03,05 task3) | launch 01 L-B2/B3 |
| G6 | 语义高亮死链(已清)+ 语法文件错放 snippets/(未动) | rosmsg 02 R13 |
| G7 | launch 死面残留(scanLaunchNodes/launch.test/dumper) | launch 01 L-F4 / 05 task1 |
| G8 | 无模块级唯一出口(extension 直连各 providers,可接受) | 待决策 |

## 5. 修订/建档约定

- 每个 README 末为修改记录表(时间精确到分钟);
- 代码改动遵循四则:数据经门面、命令经 api、搜索经 walk、注释标注日期;
- 审计编号(R1-R14 / L-* / X-*)在对应审计文档与 README 间互相引用,修复后同步状态。

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-29 | 文档同步(补 09-08 后 42 个提交的活段落欠账):①§2 接线表修正——④改 core ev.system → acceptSystem 回推链(旧 onDidChangeEnv 直调已废)、⑤断链警示删除(2026-09-04 已修,直挂 core.onDidChange)、①补 xacroPackages 参数;②§1 表 shared 行补 workspace-domain、删 package-map.md 引用(专项文档已删);③XG1~XG13/LA/RM 等批次细节由 xacro/launch/rosmsg 各目录 README 承载,本总览只管域级接线 |
| 2026-09-03 23:10 | 建档(项目结尾,信息独立):languages 域总览 README——目录/文档地图、组合根接线现状(含 setPackageMapRefresher 断链警示)、依赖与数据约定、跨模块问题索引(G1-G8)、修订约定;各模块结构 README 同步建档(rosmsg 最详,launch/xacro/shared 见各目录) |
| 2026-09-03 23:16 | PackageMap 统一入口落地:接线①更新为 registerRosMessageProviders(context, xacroPackages)(共享实例注入);G3/G5 状态刷新(系统包目录统一入口 / XML 链接切 PackageMap);详见 package-map.md 与 launch/rosmsg README |
| 2026-09-04 01:05 | G2 闭环(X-F1):PackageMap 工作区包表刷新直挂 extension 的 packageCore.onDidChange(workspace 域),setPackageMapRefresher 死机制移除;see package-map.md §2.1 |
| 2026-09-04 17:14 | rosmsg 结构重组 + 事件链收尾:rosmsg 按模块分组(shared/parse/ui/data)+ 域出口 index.ts,message-index 828→133 门面(2026-09-04 01:36);系统消息刷新经 ros2→core→PackageMap.onSystemListChanged→rosmsg(core.refreshSystem 独立入口,ev.system→acceptSystem),rosmsg 不再直连 ros2 环境域;详见 rosmsg/README、package-map.md |
| 2026-09-08 00:00 | 代码片段静态转动态收官(py/cpp):原 snippets/{python,cpp}.json(语言级全量注入)全部退役删除、内容全量转制入本域新模块 languages/python(py-ros-snippets*,19 条 rclpy,排 *.launch.py)与 languages/cpp(cpp-ros-snippets*,22 条 rclcpp);新增 shared/ros-workspace-gate(工作区闸:package-core workspace 域非空才提供,env 不当闸),接线⑦⑧;launch 三格式不加闸;详见 python/README、cpp/README、shared/ros-workspace-gate.ts |