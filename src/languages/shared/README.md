# src/languages/shared/ — 语言域共享层

> 跨模块复用的只读工具与包路径解析;不含 UI 提供器。

## 1. 文件清单

| 文件 | 行数 | 职责 | 消费方 |
|:--|:--|:--|:--|
| xml-utils.ts | 108 | @lezer/xml 只读封装:parseXml / elementTagInfo / forEachElement / attrAtCursor(纯函数,无状态不缓存文档) | languages 内部(xacro include-graph/providers/context-locator/diagnostic)+ 跨域:build-tool/package-core/scan/package-xml.ts:12、package-service/config/write/anchors/xml.ts:13 |
| package-map.ts | 387 | PackageMap 两级包路径解析:工作区包(经 getPackageCore workspace 域)+ 系统包(pkg_prefix 位置懒取 + 缓存/单飞/onDirLoaded 事件);resolveFileRef/resolveFindExpr/resolvePackageDir/resolvePackageUri;**2026-09-13+ 增量**:PackageAtomEvent/onPackageAtom 单包原子事件、getWorkspaceEntries()/workspaceReady 同步读口、构造器 pkgPrefix 注入(可测) | xacro/launch(extension 共享实例);rosmsg 经共享实例(见 §3) |
| ros-workspace-gate.ts | 23 | ROS 工作区门槛(2026-09-07):isRosWorkspace()——信号 = package-core workspace 域(null 未就绪乐观放行 / 空数组 = 非 ROS 工作区不放行),rclpy/rclcpp 片段补全防污染;不做 env 门槛 | cpp/python 片段补全 |
| workspace-domain.ts | 27 | 工作区根域判定(2026-09-25 XG13/LA-1):fileInWorkspaceDomain(uri)——"解析域"理念单一事实源:文件跳出工作区根,解析类语言域外早退;rosmsg 例外(登记域需越域登记) | xacro(needFallback 域门)、launch(域外早退) |

## 2. 关键设计

- xml-utils 定位:通用 XML 只读工具,不属于任何语言模块(2026-08-29 自 xacro/ 上移);
- PackageMap 数据源双轨:工作区名单/目录 = package-core 门面(不重复扫描);系统包名单/目录 = ros2 命令域,系统目录懒取 + 事件通知(pending 边重解析挂 onDirLoaded);
- 环境门:系统包列表延后到环境就绪(onDidChangeEnv → refreshSystemList),规避 UnknownROS 误报(8-21 问题);
- ✅ 2026-09-04:工作区包表刷新断链已修(extension 直挂 core.onDidChange workspace 域 → refreshWorkspace;setPackageMapRefresher 死机制移除)。

## 3. 归属与待决(跨模块)

- G1:xml-utils 物理挂在 languages/,被 build-tool 反向 import——纯文本只读工具,语义不构成数据归属问题,但物理错位;建议迁中立层或 lint 豁免(未执行);
- G3/统一入口:✅ 2026-09-03 23:16 落地——PackageMap 新增公开 resolvePackageDir(触发懒取并等待,单飞 + 缓存),rosmsg providers 与 launch XML 链接经共享实例接入(组合根注入),语言域不再各自调 pkg_list/pkg_prefix(兑现 08-23《优化-系统包访问统一入口》);
- 专项记录文档 package-map.md 已删除(历史结论并入本 README 与代码注释,git 历史可查)。

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-29 | 补登 2026-09-05 ~ 09-28 批次(8 个提交未入档):①新增 ros-workspace-gate.ts(2026-09-07 头注定稿)与 workspace-domain.ts(2026-09-25 XG13/LA-1);②package-map.ts 增 PackageAtomEvent/onPackageAtom、getWorkspaceEntries()/workspaceReady、构造器 pkgPrefix 注入;③package-map.md 专项文档删除(本 README §3 已注);文件表行数同步(267→387) |
| 2026-09-03 23:11 | 建档(信息独立):shared 层结构 README——xml-utils/package-map 职责与消费方、两级数据源与环境门、已知断链、G1/G3 归属待决;关联 shared/package-map.md |
| 2026-09-03 23:16 | package-map 完善:新增公开 resolvePackageDir(可等待懒取);语言域(rosmsg/launch)经共享实例接入,G3 统一入口落地(见 package-map.md) |
| 2026-09-04 01:05 | G2 修复:PackageMap 工作区包表刷新直挂 core.onDidChange(workspace 域),setPackageMapRefresher 移除;已知断链条目删除,见 package-map.md §2.1 |
| 2026-09-04 17:14 | PackageMap 系统名单收编(core.system 域):acceptSystem 喂入 + onSystemListChanged 事件,删除自持 pkg_list/loadSystemPackageList/ensureSystemPackagesMap;目录懒取直连 pkg_prefix;systemAvailable = core 域就绪;详情见 package-map.md |