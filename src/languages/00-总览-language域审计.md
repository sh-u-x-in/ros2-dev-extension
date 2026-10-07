# src/languages 域总览审计报告(2026-09-03 21:47 建档)

- 对象:src/languages/(23 文件约 6300 行:launch 4 / rosmsg 9 / xacro 7 / shared 3),语言服务域:.msg/.srv/.action、.xacro/.urdf、.launch.py/.launch/.launch.xml 的 IntelliSense 能力
- 背景:工作空间大面积域重构(ros2/api 统一出口、package-core 门面 + 事件化、walk 统一、命令收编、launch 树废弃)后,对本域做全面复核审计
- 分模块报告:./launch/01-launch模块审计.md / ./rosmsg/02-rosmsg模块审计.md / ./xacro/03-xacro模块审计.md(本文件为总览与跨模块结论,与源码同放)
- 方法:逐文件通读 + 出边/入边 grep 全量 + 红线模式扫描 + 子代理交叉复核 + 关键发现逐行核验;证据给 文件:行号

---

## 一、重构后接线现状(组合根视角)

extension.ts(组合根)直连三模块注册 + 共享数据实例:
| 步骤 | 代码 | 说明 |
|:--|:--|:--|
| ① | extension.ts:33-36 | import registerRosMessageProviders / registerXacroProviders / PackageMap / registerLaunchProviders |
| ② | :272 | context.subscriptions.push(...registerRosMessageProviders(context))(仅一次) |
| ③ | :276-277 | 共享 PackageMap 单例 xacroPackages → registerXacroProviders(xacroPackages) |
| ④ | :280-282 | onDidChangeEnv → xacroPackages.refreshSystemList()(方向①) |
| ⑤ | :284-286 | setPackageMapRefresher → xacroPackages.refreshWorkspace()(方向②) |
| ⑥ | :289 | registerLaunchProviders(xacroPackages) 复用同一实例 |

依赖方向(合法集):languages → ros2/api barrel(composeApi + 类型)| build-tool/package-core/api(getPackageCore 门面)| build-tool/walk barrel | logger | vscode;入边仅 extension(组合根)+ test/suite。

## 二、模块总览与结论

| 模块 | 文件数 | 行数 | 职责 | 结论 | 详细 |
|:--|:--|:--|:--|:--|:--|
| launch | 4 | 523 | .launch.py include 跳转 + XML include 链接 | ⚠️ 4 P1:误报面/IncludeLaunchFile 缺口/XML 链接陈旧 CLI 兜底未切 PackageMap;05 交接任务 3/4 未落地 | 01-launch模块审计.md |
| rosmsg | 9 | 2582 | 消息接口语言服务(索引 + 解析 + 5 类提供器) | ❌ 1 个高置信 P1 bug(R1 系统索引键格式)+ 4 项 P1(事件未收编/逐文件 pkg_list/裸 cp.exec/无环境订阅) | 02-rosmsg模块审计.md |
| xacro | 7 | 2780 | .xacro/.urdf 语言服务(IncludeGraph + 提供器 + watcher) | ⚠️ 1 个 P1 断链(X-F1 包表刷新无人调用)+ 多 P2 重复/性能 | 03-xacro模块审计.md |
| shared | 3 | 421 | xml-utils(lezer 只读工具)/ package-map(两级包映射 + 自注文档) | ⚠️ xml-utils 物理归属错位(G1);package-map 刷新链断(G2) | §三 |

全域 P0(崩溃级)无;P1 共 10 项(launch 4 / rosmsg 5 / xacro 1)。

## 三、跨模块治理发现(总览级)

### G1.xml-utils 物理归属错位(下层依赖上层)
languages/shared/xml-utils.ts(纯 lezer XML 只读工具,零 vscode 状态)被 build-tool 反向引用:package-core/scan/package-xml.ts:12、package-service/config/write/anchors/xml.ts:13;package-core/README 已明文定位"公共工具(上移共享)"。语义不构成数据归属问题,但物理仍挂在 languages/ 下——依赖方向显示为 build-tool → languages(UI 域),易误导新人。建议:迁出至中立层(如 src/shared/ 或 build-tool 公共工具区)或加 lint 豁免并文档化;遗留 build-tool/packages/package-xml.ts:23 注释旧路径 import。

### G2.PackageMap 工作区包表刷新链断裂(✅ 2026-09-04 已修:extension 直挂 core.onDidChange workspace 域)
package-map.md §2.1 已自记:extension.ts:284-286 setPackageMapRefresher 挂回调,唯一调用点 listeners.ts:87 随退役整体注释 → 无实际调用;extension.ts:194-197 的 packageCore.onDidChange 编排未补 refreshWorkspace。后果:xacro/launch 共享的 PackageMap 工作区包表在"激活后新增 package.xml/新包"时不刷新,$(find 新包) 恒 pending 至重载。xacro 侧为真实断链(X-F1);rosmsg message-index 因自持 watcher 不受影响 → 两域事件策略分裂。修复方向(未执行):onDidChange 编排补 void xacroPackages.refreshWorkspace(),退役 setPackageMapRefresher 死机制。

### G3.包发现双轨(✅ 已收敛 2026-09-03:自持 package.xml watcher 删除,订阅 core workspace 域事件重扫)
真包判定已双收编 getPackageCore 门面(message-index.ts:209 / package-map.ts:127);但 message-index 仍自持 package.xml watcher + 60s 强制重扫(默认读 packages.refreshMs,越域配置键 R10),package-core 驱动层同样在监听/定时(60s)——两套定时扫描并存;message-index delete 分支不读 core 新态(漂移)。建议:索引服务的 .msg 内容可自持,触发源收编 core.onDidChange + onDidChangeEnv(见 02 报告 §四 4)。

### G4.rosmsg 系统消息索引键格式 bug(全域最高优先级 P1)
R1(02 报告):systemSorted 存三段键 pkg/msg/Name,systemEntryFromKey 只切首斜杠 → entry.name=msg/String。后果:系统类型被诊断误报"未知消息类型"、定义/悬停索引命中失效(坠回全量 walk + CLI 兜底)、输入 std_msgs/S 后补全清空(空前缀时插入含 msg/ 的错误类型)。修复一处(键改存二段 pkg/Name)贯通三症状;当前 R14 测试只测空前缀未暴露。

### G5.launch-link-provider 未走共享包解析(职责越界残留)
XML include 链接仍逐 include 直连 ros2ServiceApi.pkg_list/pkg_prefix(每次 spawn ros2 CLI,无记忆),工作区源码包/无环境场景断裂;05 交接文档 task3 与 优化-系统包访问统一入口 文档均明列待切 PackageMap,未迁移(01 报告 L-B1~B4)。

### G6.语义高亮死链 + 语法资源放置错位
registerRosMessageSemanticTokens 为空操作(2026-08-16 禁用,配色时序 bug 未修);tmLanguage(源自 jtbandes/ros-tmlanguage)与语言配置错放 snippets/(ROS2.json = language-configuration、rosmsg.json = tmLanguage),grammars.path 指向 ./snippets/rosmsg.json;configurationDefaults 内嵌 [rosmsg] textMateRules + semanticHighlighting.enabled:false。功能可用但命名/目录治理错位,ARCHITECTURE/04-语法高亮与补全注册.md 记录的旧路径(src/languages/rosmsg/ROS Interface.*)已过期(文档漂移)。

### G7.死面残留(launch 域)
launch-py-parser 的 scanLaunchNodes/LaunchNode/extractAttr/offsetToLine 仅测试引用(launch 树已废);launch.test.ts(139 行 dumper spawn 测试)与 assets/scripts/ros2_launch_dumper.py 属 05 task1 应删未删;ros2/launch-tree 4 文件仍注释保留(处置未收尾)。

### G8.无模块级唯一出口
src/languages 无 index/barrel,extension 直连三个 providers 文件 + shared/package-map(与 build/ 域"子域 index 唯一出口"模式不一致);可接受(组合根直连注册面收敛、文档化)或建 languages/index 收口——待决策。

## 四、红线与清洁度核对(全域)

| 检查项 | 结果 |
|:--|:--|
| vscode.workspace.rootPath(废弃 API) | 0 命中 ✅(2026-08-31 批次已全量迁移) |
| vscode.workspace.findFiles | 0 命中(仅注释提及已替代)✅ |
| import ../extension 反向依赖 | 0 命中 ✅ |
| vscode.extensions.getExtension | 0 命中 ✅ |
| TODO/FIXME/HACK | 0 命中 ✅ |
| child_process 裸命令 | 1 处:message-index.ts:522(cp.exec ros2 interface list,R4)❌ |
| walk 统一入口 | 全量走 build-tool/walk barrel ✅ |
| 包数据门面 | package-map / message-index 均经 getPackageCore ✅ |
| ros2 访问 | 均经 ros2/api barrel ✅(launch-link-provider 用途不当属职责问题,非 import 形式问题) |
| 模块级缓存/资源 dispose | ⚠️ providers 返回数组基本齐全;IncludeGraph/propertyCycleEmitter/PackageMap.dirLoadedEmitter 无 dispose(X-F7);semantic 空注册(R13) |

## 五、测试覆盖汇总

| 模块 | 套件 | 缺口 |
|:--|:--|:--|
| rosmsg | rosmsg-document / formatter / diagnostics / samples-parser / samples-providers / message-index-cache / semantic-token-builder / ros-msg-providers(旧大套件) | R1 键格式无断言;解析缓存/磁盘读写/ensureSystemFresh 无直接单测;两套件职责交叠 |
| xacro | include-graph / xacro-completion / xacro-diagnostics / xacro-diagnostics-samples / xacro-samples-integration / urdf-docs / package-map | registerXacroProviders 装配链、watcher(轮巡/rename)、三 UI 提供器、X-F1 断链无直接测试 |
| launch | launch-py-parser / launch-link-provider / launch.test(dumper 遗留) | LaunchPy DocumentLink/Hover 无单测;误报护栏/系统包分支/工作区包分支无用例 |

## 六、设计文档漂移清单(复核依据更新)

| 文档 | 声明 | 现状 |
|:--|:--|:--|
| ARCHITECTURE/04 | 语法文件在 src/languages/rosmsg/ROS Interface.* | 已移至 snippets/(ROS2.json、rosmsg.json),路径过期 |
| xacro 09-Activation | 激活时启动 ros2 pkg list;08 诊断暂不注册 | 系统列表延后到环境就绪(onDidChangeEnv);D1-D7 已注册 |
| xacro 06 §0.3 方向② / 09 §1④ | 包列表更新 → 刷新共享 PackageMap | 回调无人调用(断链,package-map.md 记录未修) |
| 新功能 05 | 任务 1-4(删树/IncludeLaunchFile/切 PackageMap/yaml) | 半做:删树仅 UI 侧;2/3/4 未做 |

## 七、问题总账与重构路线(按域批处理建议)

| 批次 | 内容 | 关联 |
|:--|:--|:--|
| P1-A(rosmsg 收编) | R1 键格式一处修正;message-index 触发源收编 core.onDidChange + onDidChangeEnv,删自持 packageXmlWatcher/60s 定时/cp.exec,改 ros2ServiceApi.interface_list + whenReady 门控;兜底 pkg_list 提循环外 | 02 报告 R1-R5 |
| P1-B(断链修复) | onDidChange 编排补 xacroPackages.refreshWorkspace + 退役 setPackageMapRefresher;补断链测试 | 03 报告 X-F1 / G2 |
| P1-C(launch 收缩收尾) | XML link 切共享 PackageMap(删 CLI 直连);扫描收窄(注释/字符串剥离 + launch 上下文约束);05 task1 残留清理(scanLaunchNodes/launch.test/dumper/launch-tree 注释文件);IncludeLaunchFile 支持 | 01 报告 |
| P2 | xacro 重复收敛(isInDollarBraces×3/XACRO_KEYWORDS×2/包正则×3)+ parse 缓存 + fallback 副作用收敛;rosmsg 子目录化 + 语义高亮死链处置 + 语法文件归位;xml-utils 迁出 languages 或豁免;多根/rename 残留;越域配置键统一 | 各模块报告 |
| P3 | 死字段 blocker、陈旧注释、byte/char 口径、旧大测试套件整理 | 各模块报告 |

## 八、结论

languages 域在大规模重构后"结构红线"保持干净(无 extension 反向依赖/无 findFiles/无 rootPath/无 TODO),数据源已切 getPackageCore 门面、搜索已统一 walk barrel、ros2 访问已收敛 api barrel——域重构的主体方向在本域已正确落地;剩余问题集中在 3 类:① 重构中间态未收尾(rosmsg 事件双轨 + R1 键格式回归、xacro 断链、launch 05 任务未落地);② 重复与资源治理(xml-utils 归属、语法文件放置、多处常量/正则/工具函数复制);③ 死面与文档漂移(scanLaunchNodes、semantic 空注册、4 处设计文档过期)。建议按 §七 批次处理,P1-A/B/C 为高置信修复,每批以本审计编号闭环。

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-03 21:47 | 建档(补记录):languages 域审计 4 件套——00 总览(本文件)+ 01 launch / 02 rosmsg / 03 xacro 分模块审计;全域 23 文件约 6300 行复核:接线现状(extension 组合根直连 + 共享 PackageMap)、G1-G8 跨模块发现(含高置信 P1:rosmsg R1 系统索引键格式 bug、xacro X-F1 包表断链)、红线清洁度核对(0 rootPath/findFiles/extension 反向/TODO)、测试覆盖、设计文档漂移 4 处、P1-A/B/C 分批重构路线;详见 ./launch/01-launch模块审计.md、./rosmsg/02-rosmsg模块审计.md、./xacro/03-xacro模块审计.md |
| 2026-09-03 21:51 | 位置归位(项目结尾归档):总览与三份分模块审计移入源码目录 src/languages/(总览在根,分模块在 launch/rosmsg/xacro/),原 设计/重构/languages域审计-2026-09-03/ 已删除 |
| 2026-09-03 23:16 | G3/G5 闭环:PackageMap.resolvePackageDir(可等待懒取)落地;rosmsg providers 与 launch XML 链接改经组合根共享实例,PackageMap 成为语言域系统包目录唯一入口(pkg_prefix 活跃调用 5 → 3,ros-cli/debugger 按定稿保留直连);G5 状态改已修 |
| 2026-09-03 23:52 | G3 闭环(R2 完成):message-index 删自持 package.xml watcher/refreshPackageNames/handlePackageXmlEvent/packageNameByDir,名单实时读门面 + 订阅 core.onDidChange(workspace 域)重扫,仅留 .msg watcher;增量/查询同口径,R7 rename 残留顺带缓解 |
| 2026-09-04 01:05 | G2/X-F1 修复:PackageMap 工作区包表刷新直挂 extension 的 packageCore.onDidChange(workspace 域变化 → refreshWorkspace),setPackageMapRefresher 死机制移除(listeners.ts);xacro 新包 $(find) 即时生效;tsc 0 错误 |
| 2026-09-04 17:14 | G3/D 终态 + 事件链闭环:PackageMap 系统名单吃 core.system 域(acceptSystem/onSystemListChanged,去 self pkg_list);rosmsg 不再直连 ros2 环境域(core.refreshSystem → ev.system → PackageMap → rosmsg);rosmsg 结构按模块重组(shared/parse/ui/data + index);详见各模块 README/审计 |