# api/ — 对外唯一依赖点(类型层 + 运行时出口)

2026-08-30 定稿(≈ros2/api/ 范式):package-core 对外唯一可 import 的区域;
**绝对意义的所有外部依赖一律走本目录**,组合根 compose.ts 只被装配方(extension)直接调用。

## 规范(两条)

1. **零 function/class 定义**:只放接口/类型 + re-export(运行时出口),不放实现;
2. **零实现 re-export 污染**:静态能力等函数经运行时出口从 compose.ts 转发,本目录不定义任何函数。

## 文件清单

| 文件 | 内容 | 说明 |
|---|---|---|
| `api.ts` | `PackageFacadeApi`(门面接口)+ 对外类型(PackageDataState / PackageChangeEvent / PackageEntry;2026-09-02 起物理层类型 PackageScanEntry / PackageSnapshot / WorkspacePackage 不再对外) | 类型层;实现 PackageFacade 在 compose.ts |
| `index.ts` | 聚合:`export * from "./api"` + 运行时出口(re-export compose.ts 的 createPackageCore / 静态能力 / 组装类型) | 外部 import `…/package-core/api` 的落点 |

## 运行时出口

`index.ts` 转发 compose.ts 产物(≈ros2/api re-export composeApi)+ shared 值类型谓词:
- `createPackageCore`(工厂)/ `getPackageCore`(2026-09-02 门面访问器:返回最近装配的 PackageCore,语言服务/derive 等非装配方取门面实例的落点)/ `probeValidWorkspacePackages`(2026-08-31 收编自 vscode-utils.workspaceContainsPackageXml;仅 onboarding 单次探测用,原 hasValidWorkspacePackages)/ `isValidPackageXml` / `getPackageNameFromXml`;
- ⚠️ 2026-09-02(设计 D3):`getSharedPackageCache` / `PackageCache` / `PackageSnapshot` / `PackageScanEntry` 等物理层出口已删除——cache 内部化,对外只剩 PackageFacadeApi(getState / onDidChange / forceRefresh / ingest / toggle / getBuildPackages);
- **shared 值类型谓词**(2026-09-02):`isPythonPackage`(buildType==="ament_python",仅工作区包类型判别)/ `PYTHON_BUILD_TYPE` 常量——**来源权威 = PackageDataState 分域**(system 域=系统包),消费方按域拿,不设 isSystemPackage 谓词(字段值判别属舍本逐末);
- 类型:`PackageCore / PackageCoreOptions / PackageCoreConfig` 等。
(2026-08-31 核对:原列表中的 `resolveExcludeFolders / isPathExcluded / DEFAULT_EXCLUDED_DIR_NAMES` 已随 walk 归位移出,以 index.ts 实际导出为准)
组合根成员(compose.ts 自身)不得经本目录反取(循环),直接 import 内部模块即可。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 文档勘误 + 补登:①2026-09-02 11:15 行所记 "isSystemPackage" 谓词实际未落地(代码零命中;正文"不设 isSystemPackage 谓词"为现行事实)——系统包判别权威仍在 PackageDataState 分域,历史行不回改、特此勘误;②补登 2026-09-13(5c5b4c5)api/api.ts refreshSystem 强制回推语义注释(forceDomains=["system"],详见 data/README.md 同日行) |
| 2026-09-08 22:45 | **事件 10 域化说明同步**:api.ts 头注与 PackageFacadeApi.onDidChange 注释更新——事件 = 变化域的新值 + 对称旧值(old*),差量消费方自算(身份键:工作区三域按 dir、system 按 name);all 域 @deprecated 弃用(混合域无单一身份键);对外类型不变(纯加性可选字段),旧消费方零改动 |
| 2026-08-30 18:42 | 创建 api/ README(规范/文件清单/运行时出口) |
| 2026-08-31 17:56 | 运行时出口列表刷新(与 index.ts 实际导出对齐):新增 hasValidWorkspacePackages(收编自 vscode-utils.workspaceContainsPackageXml,包判定归位),标注已随 walk 归位移除的 resolveExcludeFolders 等 |
| 2026-08-31 18:25 | 运行时出口同步重命名:hasValidWorkspacePackages → probeValidWorkspacePackages(单次探测语义) |
| 2026-09-02 11:15 | 运行时出口新增 shared 值类型谓词:isSystemPackage / isPythonPackage / PYTHON_BUILD_TYPE——PackageEntry 判别规则(系统包=dir 空、python=ament_python)唯一出处,消费方经 api 使用(shared 对外不可见) |
| 2026-09-02 17:48 | **出口收窄(设计 D3)**:删 getSharedPackageCache / PackageCache / PackageSnapshot / WorkspacePackage / PackageScanEntry 物理出口;新增 getPackageCore 门面访问器;文件清单/运行时出口同步(对外只剩 PackageFacadeApi + 值谓词) |
| 2026-09-03 22:58 | 死代码复核同步(项目结尾):api.ts 注释指路更正——PackageFacade 实现已由 facade.ts 合并入 compose.ts(原指路文件不存在,2026-08-30 合并);运行时出口/文件清单与当前代码核对一致;详见 package-core/README.md 墓碑登记 |

<!-- 文件末尾修改时间:2026-09-29(isSystemPackage 勘误 + 09-13 补登,详见上表 2026-09-29 行) -->