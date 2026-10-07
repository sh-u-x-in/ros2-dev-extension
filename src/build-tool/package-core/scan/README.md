# scan/ — 校验 + 扫描(package.xml 权威判定)

package.xml 数据的"眼睛与裁判":搜索原语、合法性校验、colcon list 执行器、忽略判定、排除常量与路径工具。
2026-08-29 语义收编归位(自 packages/ 移入),colconListExecutor 亦归位于此。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `package-xml.ts` | 校验核心:lezer 严格 well-formed(R1-R4)+ 根 `<package>` + name 非空 + build_type 同类型校验(matchesBuildTypeFile,ament_python→setup.py/pyproject,ament_cmake/cmake→CMakeLists) | languages/shared/xml-utils(公共解析)+ @lezer/common |
| `package-scan.ts` | 扫描原语:scanWorkspacePackages(walkWithTimeout 双超时 + maxDepth + 排除 + 真包判定);2026-09-06 起结果增 `ignoreMarkers`(标记集 M,第二趟 COLCON_IGNORE 遍历)+ 点目录过滤(isDirScanExcluded,§12.10-B) | walk/(公共搜索)+ package-xml |
| `ignore-classify.ts` | **分类纯函数(2026-09-06)**:classifyIgnoreReason / classifyEntries(池 × M → 每条目 `ignoredBy`:same-dir/ancestor/overlap)+ isVisibleEntry(visible(池) 谓词);COLCON_IGNORE 事件路径(applyMarkerSync)与 walk 重建共用,单一事实源 | 无(仅 type import package-scan) |
| `colcon-list.ts` | colcon list 执行器(2026-08-29 自组装根归位):执行口注入的工厂,解析 stdout + 排除 + 权威校验;输出路径统一绝对化(2026-09-02,与 walk 画像 dir 同形态) | package-xml + 注入(CommandExecutor) |
| `colcon-scan.ts` | COLCON_IGNORE 同目录判定(hasColconIgnoreSameDir,纯 fs,ingest 同目录 fs 实时探测用;祖先遮蔽由 ignore-classify 承担,2026-09-06 原"只同目录定稿"作废);死代码注释保留(scanPackages 等) | path/fs |
| `package-core/…/数据源与事件链路现状详解-2026-09-06.md` | 细粒度现状详解 + §12 四项修复/V3 定稿设计(见 §12.6 本目录改动方案) | — |

注:排除常量与路径工具(resolveExcludeFolders/isPathExcluded/DEFAULT_EXCLUDED_DIR_NAMES)在 walk 层,
本目录经 walk barrel 导入并在 package-scan re-export(DEFAULT_EXCLUDED_DIR_NAMES)保持兼容。

## 关键设计

- **单一真包判定核心**:analyzePackageDir(isValidPackageXml / package-scan / colcon-list 共用),消除重复判定;
- **build_type 同类型校验**(用户定规则):ament_python → setup.py/pyproject.toml;ament_cmake/cmake → CMakeLists.txt;未声明/未知 → 不合法;
- **依赖公共工具**:walk/(搜索平替,7 方消费,不收编)与 languages/shared/xml-utils(通用解析,上移共享)——本目录零第三方业务依赖。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-06 23:16 | **四项修复 scan 层落地(设计 §12.2/§12.6/§12.10,详见详解 §12)**:①新增 `ignore-classify.ts`:classifyIgnoreReason(自根向下首个阻挡:标记→ancestor、自身标记→same-dir、合法包祖先→overlap)/classifyEntries(填 ignoredBy + hasColconIgnore)/isVisibleEntry——池 × M 分类唯一实现,COLCON_IGNORE 事件(applyMarkerSync)与重建共用;②`package-scan.ts`:PackageScanEntry 增 `ignoredBy`、结果增 `ignoreMarkers`(第二趟 COLCON_IGNORE 遍历收集,含非包目录)、buildEntry 不再逐目录 access(单一事实源 = M)、新增 `isDirScanExcluded`(点目录任意层级对齐 colcon 剪枝 §12.10-B + 内置产物名 + buildExcludeFolders,scan 过滤与事件预过滤共用);③colcon-scan 头注释"只同目录定稿"作废标注(同目录 fs 探测保留给 ingest);文件清单更正(excluded-paths/package-fs 历史行删,排除工具在 walk 层注明) |
| 2026-08-30 18:42 | 创建 scan/ README(文件清单/关键设计) |
| 2026-09-02 15:54 | **colcon-list 数据源修复(路径绝对化)**:colcon list 输出路径统一 `path.resolve(workspaceRoot, rawPath)`(兼容相对/绝对两种形态;旧实现 `isAbsolute` 兜底于 2026-08-29 收编时丢失)——修复 unignore 相对路径与 walk 画像 `entries[].dir`(绝对)的 `===` 全等断裂(executable-map.isBuildable / package-cache.attachBuildType 匹配失败,colcon 权威注入后映射反而全空);排除/校验改走绝对路径,不再依赖进程 cwd |
| 2026-09-02 17:48 | **colcon-list 出口携带 buildType(设计 §4.2 补强)**:收录校验由 isValidPackageXml 改 analyzePackageDir(复用同一次解析),输出 {name,path,buildType} 与 WorkspacePackage 同构——colcon 注入即带类型,undefined 窗口基本归零;syncUnignore 的 attachBuildType 降级为防御性兜底 |
| 2026-09-03 22:58 | 死代码复核同步(项目结尾):colcon-scan.ts 主体墓碑维持注释保留(2026-08-29,内含 2026-08-21"待删除(用户自行处理)"历史标记——定稿不删),仅 hasColconIgnoreSameDir 参与编译(data 层 ingest/toggle 用);文件清单与当前代码核对一致;详见 package-core/README.md 墓碑登记 |
