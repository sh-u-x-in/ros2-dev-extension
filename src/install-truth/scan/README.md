# scan/ — 第 1 层:纯解析(无状态)

> **层级定位**:build-only 真值域的**解析层**。输入 = `FsLike` + build 路径,**输出 = 模型对象**;
> 不持有状态、不缓存、不发事件、不挂 watcher(那些属于 `center/`)。
>
> **依赖方向**:只 import `shared/`;同层内 `jumps.ts` 可调用其余模块;反向禁止。

## 文件

| 文件 | 职责 | 关键点 |
|:--|:--|:--|
| `build-root.ts` | build 根定位(工作区根 或 build 根)→ `{workspaceRoot, buildRoot, srcRoot}` | src 根只作**跳转落点前缀**,**按约定拼、不探测不读**(域包含性,2026-09-21) |
| `packages.ts` | build 域包发现 + `traits`(cmake/ament_cmake/python/rosidl/colcon) | 收录判据三选一(egg-info / CMakeCache / colcon 落痕);**构建类型不写死**,推断结果只作展示 |
| `targets.ts` | `link.txt` + `*.o.d` → 目标:输出名(`-o`)、输出完整路径、objects、构成源、**编译期源路径集合**、生成源计数、头计数、链接库 | 排除 `*_uninstall.dir` 与空目标;源是否"生成"由是否落在 build 内判定;`compilePaths` 供调试侧推 `sourceFileMap`(P0-3),**只给记录、不判域外存在性**(2026-09-21) |
| `python-meta.ts` | `<pkg>.egg-info` → `entry_points`(命令→模块:属性)与 `SOURCES.txt`;模块 → 源候选推导、**develop 模式模块候选** | **单落点**(四象限实测 build 侧均有 egg-info)→ 不需要双版本分支;dev 候选根 = `build/<pkg>`(P0-2) |
| `install-rules.ts` | `cmake_install.cmake` / `ament_cmake_symlink_install.cmake` 的 `FILES`/`DIRECTORY`/**`PROGRAMS`** 规则 | **三种写法都认**:实体 `file(INSTALL … TYPE PROGRAM …)`、实体 `install(PROGRAMS …)`、软链 `ament_cmake_symlink_install_programs(…)`;落点剥离 `${CMAKE_INSTALL_PREFIX}`;ament 形态的根相对源按首参根绝对化 |
| `manifests.ts` | `install_manifest.txt` ∪ `symlink_install_manifest.txt` ∪ **`install.log`** → 安装落点集合;并给出 **site-packages/dist-packages 落点** 与 **无清单时的布局候选** | **"编译出的目标 ≠ 装出去的可执行"** 的判据;三份记录互补(`install.log` 是 `ament_python` 的唯一替代品,**模式相关 → 过 `freshnessBaselineMs` 陈旧守卫**);**FRESHNESS_GRACE_MS = 5000ms 宽限差**(2026-09-26:清单 mtime 比基线早 5s 内仍视为新鲜——正常构建清单早于 colcon_build.rc 亚秒级,严格 `<` 会误杀当前记录;形态切换残留是分钟级,5s 稳定区分);`derivedInstallCandidates` 覆盖 **ament_python 无清单**的情形(P0-1/P0-2) |
| `installed.ts` | **install 侧观察 → 三区 `lib`/`import`/`share`(+`include`)**;与清单/安装规则**对账**,并给源落点与**形态** | 内容以**观察**为准(故直通模式"扩大"如实呈现);遍历是**软链感知**的(`lstat` 枚举 → 悬空链可见;目录软链深入 = 扩大通道);**AREA_SKIP_DIRS 硬排除**(2026-09-26 黑名单批次,推翻 09-21"照实列出+打标记"口径:`.git`/`node_modules`/`.cache`/`.pytest_cache`/`__pycache__`/`*.egg-info` 纯噪音,连标记带行一起不进真值);`agreement` 三档 `confirmed`/`observed`(扩大)/`manifest-only`;`generated`(约定黑名单 ∪ 源落在 build 内)/`library` 只是**标记**不过滤;`linkDomain`/`viaLinkDomain`/`dangling`/`executable` 是**形态**;源落点**只拼字符串、不访问 `src/`**;布局读 `install/.colcon_install_layout`;**覆盖边界见主 README §2.3** |
| `jumps.ts` | 三类来源合成"命令名 → 源码",并挂 **installPaths / buildPath / pythonInstall / compilePaths** | 同名优先级 `cpp > console_script > script`;库不入表;未解析不隐藏(条件分级);落点**核对与推导分离**(`pythonInstall.verified`);**console 源不越域确认**(一律 `derived`,2026-09-21) |

## 规格来源(唯一真相,勿凭记忆改)

- `discover/buildonly/scan.py`(Python 原型:唯一输入 build/ 的抽取器)—— 本层逐函数对齐
- `discover/buildonly-四象限报告.md`(证据:1080/1222 叶子固有;targets / egg-info / 安装规则全在固有侧)
- `知识/install-build静态解析-{实体安装,符号链接}` —— 仅用于理解 install 侧术语;build-only 不再依赖其双版本分支

## 修改记录

| 时间 | 说明 |
|:--|:--|
| 2026-09-29 | 文档补登(2026-09-21 后欠账,文件表已同步):①manifests.ts **FRESHNESS_GRACE_MS = 5000**(2026-09-26,p10_mix_deps_std 实测:残留清单早基线 10 分钟混入并集误报 manifest-only;同批 ManifestInfo 增 origin/sourceRef 来源字段);②installed.ts **AREA_SKIP_DIRS 黑名单硬排除**(2026-09-25 fd76085,推翻"照实列出+打标记"口径) |
| 2026-09-13 22:22 | 建档(分层重构配套):原 `workspace` / `index` / `cpp` / `python` / `scan` 迁入 `scan/`(`index`→`packages`、`scan`→`executables`) |
| 2026-09-13 23:05 | **build-only 裁切**:`workspace.ts`→`build-root.ts`(只认 build 根)、`packages.ts` 改为 build 域判包 + traits、`cpp.ts`→`targets.ts`(纯 link.txt/.o.d)、`python.ts`→`python-meta.ts`(egg-info 单落点)、`executables.ts`→`jumps.ts`(三类来源合成);新增 `install-rules.ts`;删除 install 侧候选扫描 / readlink / 形态检测 |
| 2026-09-13 23:33 | **反例修复**:新增 `manifests.ts`;`install-rules.ts` 补 `PROGRAMS`(两种写法)与 dest 规范化;`jumps.ts` 加清单核对 + `installed`/`installPath`。**已知缺口: Ninja 生成器下无 `link.txt`/`.o.d`**(实测),需 `build.ninja`+`compile_commands.json` 兜底 —— 见 `设计/新功能/07-*` |
| 2026-09-14 (P0) | **调试侧消费落地(用户裁定 P0 全做,仍严格 build-only)**:① `targets.ts` 新增 `parseLinkOutputPath` + `BuildTarget.outputPath`(link.txt 的 `-o` 原值,相对值按 build 内存在性解析)与 **`compilePaths`/`compilePathsExistLocally`**(P0-3:`.o.d` 里全部源扩展名依赖的原样字符串 + 本机可访问性);② `python-meta.ts` 新增 **`devModuleCandidates`**(P0-2:develop 模式 sys.path 根 = `build/<pkg>`,依据 VM 实测 `install/…/<pkg>.egg-link → build/<pkg>` 且 `build/<pkg>/<pkg>` 是指向 src 的软链);③ `manifests.ts` 新增 **`derivedInstallCandidates`**(P0-1 兜底:**ament_python 无安装清单**时按 isolated/merged 两种布局 × 三种落点给候选)、`findSitePackagesDir`、`findModuleInstalledPath`、`findInstalledPathsBySuffix`;④ `jumps.ts` 挂载 `installPaths`/`buildPath`/`pythonInstall`(含 `devDir`/`devModuleFile`/`verified`),**核对与推导分离并如实入 chain**(VM 实测:ament_python 无清单 → `verified=false`) |
| 2026-09-21 20:16 | **域包含性(用户裁定:域外存在性一律不判)**:`build-root.ts` 的 `srcRoot` 由"探测存在则给"改为**必填约定值** `pjoin(workspaceRoot, "src")`(去掉 `isDir(<ws>/src)`);`targets.ts` 删除 `compilePathsExistLocally`(不再逐个 `exists` 记录里的 src 路径);`jumps.ts::consoleJump` 去掉对 `src/<pkg>/…` 候选的 `isFile` 确认,一律 `derived`(`tier` L→C)。**保留**经 `build/` 软链到达 src 的合法穿越(`devModuleCandidates` / `walkFiles`)。README 同步 |
| 2026-09-21 20:44 | **三区解算 + 清单替代品(用户:补上替代能力,完善 lib/import/share)**:新增 **`installed.ts`**(install 侧观察 → 四区,与清单/规则对账;`agreement` 三档、`generated`/`library` 标记、源落点纯拼装不越域);`manifests.ts` 把 **`install.log`** 并进 `MANIFEST_FILES` + 新增 `freshnessBaselineMs` 与**陈旧守卫**(`ManifestInfo.skipped`),`findSitePackagesDir` 兼容 **`dist-packages`**;README 同步 |
| 2026-09-21 21:09 | **甲-1 形态 + 真机三处修正**:`installed.ts` 遍历改**软链感知**(`lstat`/`readlink`;悬空链可见;目录软链深入),产出 `link`/`linkDomain`/`viaLink*`/`dangling`/`executable`;新增 `collectFlatDir` 补 `lib/` **根**下的库(p12/p13),merged 布局加"只认被记录提到的"归属门;修 DIRECTORY 规则拼接的双斜杠(`pjoin`);**修 `generated` 判据**(不得用"目标在 build",真实判据 = 约定黑名单 ∪ 源落在 build 内,否则 C++ 可执行会被误标成生成物、而扩大出来的用户数据会被藏掉) |
| 2026-09-21 21:18 | **侧边栏视图配套 + 第 4 个真机 bug**:`jumps.ts` 给 `console_script` 挂**结构化** `entryTarget`(`module:attr`,供 lib 区显示 `:main`);`installed.ts` 的 DIRECTORY 规则解析改**两遍**(先全局找 `rest` 首段精确匹配,再退兜底)—— 修"多条规则共用同一 dest 时,前一条的兜底抢走后一条正确源"的真机 bug(p10 的 `config`/`urdf` 曾被挂到 `launch/` 上) |
