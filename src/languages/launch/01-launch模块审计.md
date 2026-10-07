# src/languages/launch 模块审计报告(2026-09-03 21:44 建档)

- 对象:src/languages/launch/(4 文件 523 行),launch 文件"写文件"语言服务:.launch.py include 跳转(DocumentLink + Hover)+ XML launch include 链接(DocumentLink)
- 背景:工作空间大面积重构(ros2/api 统一出口、package-core 门面 + 事件、walk 统一、launch 树废弃)后现状复核;设计基准 = 设计/新功能/05-launch解析收缩与可执行映射-交接文档.md(2026-08-22)
- 精度:文件级 + 关键函数级,证据给 文件:行号
- 判定标准:仅"include 跳转 + 结构补全"静态能力,不做动态解析/树/执行;数据经共享 PackageMap(工作区经 package-core 门面);语言域不直连 ros2 命令 API 实现

---

## 一、模块总览(现状复核)

| 文件 | 行数 | 职责 | 主要导出 | 类属 | 结论 |
|:--|:--|:--|:--|:--|:--|
| launch-py-parser.ts | 245 | launch.py 轻量文本扫描(include/Node,括号配对 + 字面量解析) | scanLaunchIncludes / scanLaunchNodes / LaunchInclude / LaunchNode | 纯解析(依赖 vscode Uri) | ⚠️ 误报面 + 死导出残留(见 §3) |
| launchpy-provider.ts | 71 | .launch.py 的 DocumentLink + Hover | LaunchPyDocumentLinkProvider / LaunchPyHoverProvider | UI 提供器 | ⚠️ 无缓存全量扫 |
| launch-link-provider.ts | 163 | XML launch include 链接 | LaunchLinkProvider / registerLaunchLinkProvider | UI 提供器 | ❌ 陈旧 CLI 兜底,未切 PackageMap(见 B 专项) |
| providers.ts | 44 | 统一注册(收口) | registerLaunchProviders(packages?) | 注册 | ⚠️ 重复 initialize |

注册口:组合根 extension.ts:289 registerLaunchProviders(xacroPackages)(在 registerXacroProviders(:277)之后,共享同一 PackageMap 实例,符合"09 PackageMap 单一共享"定稿;providers.ts:20-23 注释确认)。

## 二、依赖审计(出边 / 入边)

| 方向 | 源 | 目标 | 判定 |
|:--|:--|:--|:--|
| 出边 | launchpy-provider / launch-py-parser / providers | ../shared/package-map(PackageMap,内部经 getPackageCore 门面取工作区包,package-map.ts:127-149) | ✅ 合法(共享层经门面) |
| 出边 | launch-link-provider.ts:7-8 | ../../ros2/api(composeApi + Ros2ServiceApi 类型) | ⚠️ import 形式合规(api barrel),用途不当——语言域直连命令查询 API(见 §3 B1-B3) |
| 入边 | extension.ts:36,289(组合根) | providers | ✅ |
| 入边 | test/suite/launch-py-parser.test.ts、launch-link-provider.test.ts | 解析器 / 链接提供器 | ✅ |
| 入边 | ros2/launch-tree | launch-py-parser | ✅ 已断(全部注释,launch-tree-provider.ts:24,166-175;文件整体注释不参与编译) |

无 rootPath / findFiles / import extension / getExtension / @deprecated / TODO / child_process 命中(全目录 grep 0)✅。

## 三、逐文件发现清单

### launch-py-parser.ts

| # | 级别 | 类别 | 位置 | 描述 |
|:--|:--|:--|:--|:--|
| L-F1 | P1 | 解析正确性 | :58, :77, :196-233 | 正则对全文直接扫描,无注释/字符串剥离——注释或 docstring 里的 os.path.join( / 引号 launch 字面量一律成链;findMatchingParen/splitTopLevel 只按括号/逗号深度计数,引号内字符也参与配对切分(多行字符串内 ( ) , 会错位)。同仓 setup-parser 已有 stripPythonComments 前置剥离先例(05 §3.1),未复用 |
| L-F2 | P1 | 误报 | :58-74, :160 | 对每个 os.path.join 都建 include 记录,resolveJoinExpr 只以 fs.existsSync(joined)(:160) 判定,不要求末段为 launch 文件、不要求 include 上下文;join 分支无 .launch.(py|xml) 后缀约束(字面量分支 :77 有);launchpy-provider.ts:56-66 对 target 未解析的 join 仍弹 "launch include" hover 标签,误报面最重 |
| L-F3 | P1 | 覆盖缺口(05 task2 未做) | :50-94 | 不支持 IncludeLaunchFile(...) 写法(05 文档 :115/:135 自认);当前仅 os.path.join + 裸字面量两形态,主流 IncludeLaunchDescription(...) 依赖 os.path.join 内层被部分兜住,其余真实写法覆盖不到 |
| L-F4 | P2 | 死面残留 | :96-128, :33-47 | scanLaunchNodes / LaunchNode / extractAttr / offsetToLine 现仅测试引用(launch 树已废弃注释);头注释(:4-6)仍称"与 launch 树复用",陈旧 |
| L-F5 | P2 | 重复/同步 IO | :167-193 | resolveLiteral 与 PackageMap.resolveFileRef(package-map.ts:177-193)重复实现(resolveFileRef 还多支持 package://);主线程同步 fs.existsSync(:160/:179/:192) |

### launchpy-provider.ts

| # | 级别 | 类别 | 位置 | 描述 |
|:--|:--|:--|:--|:--|
| L-F6 | P3 | 粒度/无缓存 | :27, :56 | DocumentLink 与 Hover 各自全文档 scan + 全量解析(含 existsSync、可能触发系统包懒取);Hover 只查单 offset 却解析整文件;无 document.version 级缓存(对照 rosmsg message-index 磁盘缓存 + xacro IncludeGraph+watcher 方案)。文档小、可接受,属 P3 |

### providers.ts

| # | 级别 | 类别 | 位置 | 描述 |
|:--|:--|:--|:--|:--|
| L-F7 | P2 | 重复初始化 | :24 | 共享实例(xacro 已建)上二次 void pkg.initialize();PackageMap.initialize(package-map.ts:58-65)无幂等门,scanPackages 每次无条件重扫。建议加 initializePromise 幂等门,或 launch 仅自建实例时 init |

### launch-link-provider.ts(专项)

| # | 级别 | 类别 | 位置 | 描述 |
|:--|:--|:--|:--|:--|
| L-B1 | — | 用途确认 | :13-14 | 模块级取 composeApi.ros2ServiceApi;唯一用途:resolveFilePath 的"系统包位置兜底"——每个含 $(find-pkg-share) 的 include:先 pkg_list({})(:103) 成员校验 → pkg_prefix(:111) 取目录 → 正则替换(:119-120)+ existsSync(:123)。即每次链接解析 spawn ros2 CLI 子进程,无记忆 |
| L-B2 | P1 | 功能分裂/陈旧 | :103-131 | 兜底口径 = 已安装(overlay)包:未构建的工作区源码包不在 pkg_list → 静默 return null(:128-131),XML include 链接断;共享 PackageMap 工作区表可解析同包。同包 .launch.py 能跳、.launch.xml 不能;无 ROS 环境时 XML 侧整体失效(py 侧纯工作区表仍工作)(口径推断依 05 文档与代码,待实测复核) |
| L-B3 | P1 | 重复/职责不符 | 全文件 | PackageMap.resolveFindExpr(package-map.ts:101-119)/resolveFileRef(:177-193) 已具等价且更优能力;05 文档 :116/:136 与 问题/优化/优化-系统包访问统一入口-2026-08-23.md 均明列"XML include 待切 PackageMap",仍未迁移;语言域直连命令 API 违背分层(ros2 命令域属执行/查询层) |
| L-B4 | P2 | 注册盲区 | providers.ts:40;launch-link-provider.ts:154-157 | registerLaunchLinkProvider() 不传共享 pkg(也说明 B2/B3 未切);selector 用 {language:xml} + pattern **/*.launch、**/*.launch.xml——若文件以非 xml 语言打开(plaintext)链接永不触发;测试宿主缺语言关联时存在"0 链接静默"风险 |

## 四、与"05-launch 解析收缩"设计对齐(任务清单核对)

| 05 任务 | 状态 | 证据 |
|:--|:--|:--|
| 1 删 launch 树(视图/命令/文件/dumper/测试) | 半做:UI 贡献与命令已删(2026-08-31 批次,extension.ts:295 注释);文件注释保留(ros2/launch-tree/*、commands/launch-tree.ts);残留:launch-py-parser 的 scanLaunchNodes/LaunchNode、test/suite/launch.test.ts(139 行 dumper spawn 测试)、assets/scripts/ros2_launch_dumper.py 未删 | 05 :114 |
| 2 补 IncludeLaunchFile 主流写法 | 未做 | L-F3 |
| 3 XML include 统一 PackageMap | 未做(仍是 ros2ServiceApi 直连) | L-B2/B3 |
| 4 yaml launch(挂 yaml id) | 未做(模块内无 yaml 文件/补全) | — |

## 五、测试覆盖

- test/suite/launch-py-parser.test.ts(116 行):scanLaunchNodes 4 例 + scanLaunchIncludes 3 例;用未 initialize 的 PackageMap 且无真实文件系统 target(用例注释自认 target 可能 undefined);无注释/字符串剥离、嵌套 join、引号内括号、IncludeLaunchFile 用例
- test/suite/launch-link-provider.test.ts(245 行):6 条集成用例(executeDocumentLinkProvider),依赖 samples/.../launch_examples 样本;受 L-B4 语言选择器影响存在"0 链接静默"风险;只断言相对路径,不覆盖 $(find-pkg-share) 系统包分支
- test/suite/launch.test.ts(139 行):ros2_launch_dumper spawn 遗留,属 05 task1 待删
- 空白:LaunchPy DocumentLink/Hover 提供器无直接单测;launch ↔ PackageMap 两级(工作区/系统)无集成用例

## 六、问题汇总与重构方向

| 级别 | # | 一句话要点 |
|:--|:--|:--|
| P1 | L-F1/L-F2 | launch.py 扫描无注释/字符串剥离 + join 分支无 launch 上下文约束 → 误报 |
| P1 | L-F3 | IncludeLaunchFile 等主流写法未覆盖(05 task2) |
| P1 | L-B2/L-B3 | XML include 链接用陈旧 CLI 兜底(每次 spawn ros2 pkg list/prefix),workspace 包/无环境场景断裂,与 PackageMap 能力重复 |
| P2 | L-B4 | XML selector 语言绑定盲区(可能 0 链接) |
| P2 | L-F4/L-F5/L-F7 | 死导出(scanLaunchNodes)+ 解析重复(resolveLiteral vs resolveFileRef)+ 共享实例重复 initialize |
| P3 | L-F6 | 提供器无缓存全量扫描 + 同步 existsSync |

重构方向(建议,未改代码):
1. 收窄扫描语义:launch-py-parser 前置注释/字符串上下文过滤(引 setup-parser stripPythonComments 同款);join 分支要求末段含 launch 扩展名且位于 include/IncludeLaunchDescription 上下文;删除无 launch 语义的 join 成链;
2. 05 task3 落地:registerLaunchLinkProvider(packages) 接收共享 PackageMap,删除 pkg_list/pkg_prefix 直连,复用 resolveFileRef(顺带解决 B2 工作区包断链与 B4 的一部分);
3. 05 task1 收尾:删 scanLaunchNodes/LaunchNode/其测试 + launch.test.ts(dumper 遗留)+ assets/scripts/ros2_launch_dumper.py(连同 ros2/launch-tree 注释文件整体处置);

> **修正(2026-09-17)**：上面这条里的 `ros2_launch_dumper.py` **不能删** —— 它是**调试链路**的活消费者
> (`configuration/resolvers/ros2/launch.ts` 与 `debug_launch.ts` 都靠它求值 launch 文件),只是**不再是 launch 侧的资产**:
> 已 `git mv` 到 `src/debugger/launch-runner/py/ros2_launch_dumper.py` 并拆成 `launch_dump/` 包(纯逻辑可在本机单测)。
> `test/suite/launch.test.ts` 同理保留(它现在覆盖 dumper 的 JSON 契约,而不是 launch 树解析);
> 真正该收尾的只剩 `scanLaunchNodes`/`LaunchNode` 与 `ros2/launch-tree/*` 注释文件。
4. 幂等:PackageMap.initialize 加 initializePromise 门(或 launch 仅自建时 init),消除重复扫;
5. 补测试:include 误报护栏(注释/字符串/拼接)、$(find-pkg-share) 系统包分支、工作区包分支。

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-03 21:44 | 建档:重构后 src/languages/launch 现状复核审计(4 文件 523 行)——接线/依赖合法性、逐文件发现(L-F1~F7、L-B1~B4)、05 交接文档任务核对(删树半做/IncludeLaunchFile 未做/XML 切 PackageMap 未做/yaml 未做)、测试覆盖、重构方向;详见 本目录上级的 00-总览-language域审计.md(../00-总览-language域审计.md) |
| 2026-09-03 21:51 | 位置归位(项目结尾归档):报告自 设计/重构/languages域审计-2026-09-03/ 移入源码目录 src/languages/launch/ 与审计对象同放,原文件夹已删除 |
| 2026-09-03 23:16 | 修复(05 task3 / L-B2/B3):launch-link-provider 改接共享 PackageMap——registerLaunchLinkProvider(packages),find-pkg-share 经 resolvePackageDir(懒取等待)、其余经 resolveFileRef,删除逐 include 直连 ros2ServiceApi 与本地重复解析;tsc 通过 |