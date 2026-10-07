# shared/ — 第 0 层:基础设施(无业务语义)

> **层级定位**:build-only 真值域的**最底层**。只提供"路径 / 模型 / 文件访问"三种原语,
> **不含任何 build|ROS 业务判断**。
>
> **依赖方向(硬约束)**:`shared/` 不得 import `scan/` 或 `center/`(单向向下)。
> 任何"这是不是一个包 / 这是不是一个目标"的逻辑都属于 `scan/`。

## 文件

| 文件 | 职责 | 关键约定 |
|:--|:--|:--|
| `paths.ts` | 极简 posix 路径工具(`pjoin`/`pdirname`/`prelative`/`pnormalize`…) | 全域统一 `'/'` 语义:分析对象是 Linux 工作区,且内存 fs 以字符串为键,混入 Windows 分隔符会出现"同一文件两个键" |
| `models.ts` | 两源真值域模型:`BuildPackage` / `BuildTraits` / `BuildTarget` / `PythonMeta` / `InstallRule` / `JumpEntry` / `BuildMapSnapshot` / `Tier` + `createJumpEntry`,以及 **安装内容解算模型 `AreaName` / `AreaFile` / `PackageAreas`**(lib/import/share/include 四区) | 只保留"解算 build/ 与 install/ 内容"所需字段;env_hooks / cache / commands / tests / ament_index 等区块不建模型。2026-09-21 删 `compilePathsExistLocally`(域外存在性不判),`srcRoot` 改必填约定值;`AreaFile` 的 `generated`/`library` 是**标记**、`agreement` 是**观察 vs 记录的对账三档**;**2026-09-26 增 `sourceRef`**(内容来源可逆引用:安装规则/安装记录/根映射/构建记录四类,供侧边栏悬浮"来源"栏;`ManifestInfo.origin` 支撑) |
| `fs/primitives.ts` | 注入式 fs:`stat` / **`lstat`** / **`readlink`** / `readdir` / `readText`,加 `nodeFsLike` + `MemoryFs` + `walkFiles`/`isDir`/`isFile` + **`guardDomain`**(域包含性守卫,不变式三夹具) | **裁切版**:原版的 lstat / readlink / ELF 头 / shebang 嗅探已删除 —— 那是 install 侧双版本适配所需,build-only 不需要。**2026-09-21 甲-1 把 `lstat`/`readlink` 请了回来**(软链就是安装机制本身,"软链失效"只靠 `stat` 全看不见);`FsStat` 带 `mode`(权限:实体看自身、软链看目标)与 `mtimeMs`;`MemoryFs` 支持 `addLink`/`chmod` 并**逐段解析软链**;`guardDomain` 只按**访问字符串**判定,故经 build/ 软链到达 src 的内容仍可读 |

## 为什么保留注入式 fs、删掉软链原语

1. **保留注入式 fs**:单测可在任意平台复现(不需要真实 ROS 工作区),真实实现只有 `nodeFsLike` 一处;
2. **删掉软链原语**:build-only 不判形态、不沿 readlink 跳源(源由 `.o.d` / `SOURCES.txt` /
   安装规则直接给出)→ 留着它们只会让模型继续背着"双版本适配"的包袱。
   代价:`walkFiles` 无法识别软链目录,故加**深度上限**兜底。

## 修改记录

| 时间 | 说明 |
|:--|:--|
| 2026-09-29 | 文档补登:models.ts 行补 `sourceRef` 字段(2026-09-26 062eb7e,AreaFile/SidebarRow 来源可逆引用 + ManifestInfo.origin,+15 行,当时未入档);同批顺手修正 `fs/primitives.ts` 文件头注释("裁切版已删 lstat/readlink"过期表述 → 与本表 2026-09-21 甲-1 行一致) |
| 2026-09-13 22:22 | 建档(分层重构配套):`paths.ts` / `models.ts` / `fs/primitives.ts` 由根目录迁入 `shared/` |
| 2026-09-13 23:05 | **build-only 裁切**:`models.ts` 重写为跳转模型(删 install 侧包/可执行/环境模型);`fs/primitives.ts` 由"lstat/stat/readlink/readdir/readText/headBytes + sniff + walkFiles"裁到"stat/readdir/readText + walkFiles",`FsLike` 由 6 方法降到 3 方法,`MemoryFs` 不再需要软链支持;本 README 同步 |
| 2026-09-21 20:16 | **域包含性配套**:`models.ts` 删 `compilePathsExistLocally`(`BuildTarget`/`JumpEntry`)、`BuildMapSnapshot.srcRoot` 由可选改**必填约定值**;`fs/primitives.ts` 新增 **`guardDomain(inner, roots)`** —— 只放行"访问路径以给定根开头"的调用(判定用访问字符串,不看软链解析结果),既是"本域从不越域"的可执行断言,也是不变式三的夹具 |
| 2026-09-21 21:09 | **甲-1**:`FsLike` 增 **`lstat`/`readlink`**(必选,实现面只有 `nodeFsLike`/`MemoryFs`/`guardDomain` 三处),`FsStat` 增 `kind:"link"` 与 **`mode`**;`MemoryFs` 增 `addLink`/`chmod`,并把 `stat`/`readdir` 改成**逐段软链解析**(否则经目录软链访问的路径在内存 fs 里查不到 —— 保真度问题);`AreaFile` 增 `link`/`linkTarget`/`linkDomain`/`viaLinkPath`/`viaLinkDomain`/`dangling`/`executable` |
| 2026-09-21 20:44 | **三区解算配套**:`models.ts` 增 `AreaName` / `AreaFile` / `PackageAreas` 与 `BuildMapSnapshot.areas`;`fs/primitives.ts` 的 `FsStat` 增 **`mtimeMs`**(`nodeFsLike` 直取 `st.mtimeMs`;`MemoryFs` 的 `addDir`/`addFile`/`addBinary` 支持显式时间戳,供陈旧残留夹具) |
