# build — 构建域(命令 + 任务 + 状态)

> 定位:围绕 "colcon build" 的**用户入口层**——命令注册(智能构建 / 右键单包 / 忽略切换)、
> 任务提供器(tasks.json 自定义 colcon 任务的 resolver)、构建记忆落盘、安装方式政策。
> **不含命令构造与执行**:统一经 `composeApi.rosTaskRunner.colcon_build`(2026-08-31 链路收敛 A);
> 包数据经 `BuildDataSource` 参数注入(组合根 extension 传 packageCore 实例),零反向依赖。
> 结构定稿:2026-08-30(迁自 build-tool/tasks);命名定稿:2026-08-31(名符其实改名批次)。

## 文件清单

| 文件 | 语义 | 导出 | 旧名(git mv) |
|:--|:--|:--|:--|
| `index.ts` | **唯一对外出口**:外部一律经此 import,不直连子文件 | 3 函数 + 4 命令 ID | — |
| `command-ids.ts` | 命令 ID **常量表**(注册者拥有,extension.Commands 引用同一常量) | 4 个常量 | `commands.ts` |
| `register-commands.ts` | 命令**注册逻辑**:忽略切换 + 右键单包 Release/Debug + 智能构建委托;本地 `findPackageForPath` | `registerColconCommands` | `colcon-command.ts` |
| `smart-build.ts` | 智能构建(Ctrl+Shift+B)**交互流程**:两级选择(多选包 → 参数多选/自定义输入)+ 记忆预选;命令经 `share-spec.expandColconBuild()` 按设置模板展开 | `runColconBuild` | `build-command.ts` |
| `colcon-task-provider.ts` | 任务提供器**实现 + 注册动作**:`ColconProvider`(resolveTask 解析 tasks.json 的 colcon 任务)+ 注册函数(是否注册由 package-core 门控决定) | `ColconProvider` / `COLCON_TASK_TYPE` / `RosTaskDefinition` / `registerBuildTaskProvider` | `colcon.ts` +(并入)`build-tool.ts` |
| `install-type.ts` | 安装方式**政策**(平台 + 配置 → `ColconInstallType` 两轴组合 {method,layout};翻译成 CLI flag 归 ros2/) | `resolveInstallType` | (原名保留) |
| `share-spec.ts` | **模板接线适配层**(2026-09-22 接线):读设置 `ROS2.build.shareSpec` → 与 `share/defaults/` 出厂默认**按"字段是否给出"合并**(显式空数组/空串被尊重,故预设可全删)→ 装填 5 个命名动态参数(两轴经 `resolveInstallType()`,与前瞻检查**同源**)→ 展开成整条 argv 交给 ros2/;未知占位符只记日志不剔除 | `SHARE_SPEC_SETTING` / `readColconBuildSpec` / `expandColconBuild` | (2026-09-22 新增) |
| `install-layout-check.ts` | 构建前**安装布局检查**(读 `<ws>/install/.colcon_install_layout` 与本次请求布局比对;不一致 → 警告文案,经 `preflight-warnings` 弹出,**不阻塞构建**;仅内部使用,不进 index 出口) | `readInstallLayoutMarker` / `buildInstallLayoutWarning` / `checkInstallLayout` / `warnInstallLayoutMismatch` | (2026-09-22 新增) |
| `install-method-check.ts` | 构建前**安装形态检查**(**每个方向只用它的权威信号**:① 本次**符号** → build 落点 lstat 是实体目录 ⇒ `create_symlink` 删不掉目录、退出码 2;② 本次**实体** → **install 侧现状(唯一探针)**:`<prefix>/share/ament_index/resource_index/packages/<pkg>`(**1 次 lstat;软链=符号/常规文件=实体;isolated 与 merged 都适用**);**探针缺失 → `unknown` 放行,不做任何扫描**——依据"不假设用户会人工局部篡改 install/"(否则连软链都能被全删,任何残留痕迹判据都会失效),缺失只发生在两类**设计使然**的情形(纯 CMake 包无 ament 索引;手写 setup.py 未注册 `packages` 的 ament_python 包);`package_run_dependencies` / `parent_prefix_path` 与 `packages` 同源同自由度(8 包 × 2 形态实测同生共死)故**不挂**;③ 两向都用 `CMakeCache.txt` 的 `AMENT_CMAKE_SYMLINK_INSTALL` **只判"要不要 `--cmake-clean-cache`"**——**cache 不代表 install 现状**。输出:自动清缓存判定 + 硬冲突/静默无效文案;**零 vscode、不阻塞**) | `checkInstallMethod` / `decideInstallMethod` / `buildInstallMethodWarning` / `readConfiguredMethod` / `inspectLanding` / `inspectInstallPayload` / `installPrefix` | (2026-09-22 新增) |
| `preflight-warnings.ts` | **前瞻警告唯一出口 + 三选一模式 + 「不再提示」按钮**:模式 `ROS2.build.preflightWarnings` = `on`(默认)/`off`/`ignore-silent-noop`(只忽略"形态静默无效";兼容旧布尔 `false`→off);采用**非模态 toast**(唯一能与 QuickPick 并存且有按钮的通知类型,研究见知识文档 §6.2);`silent-noop` 类通知带「不再提示此类警告」按钮,点击把模式写为 `ignore-silent-noop`(工作区设置) | `PREFLIGHT_WARNINGS_SETTING` / `PREFLIGHT_MUTE_LABEL` / `preflightModeFrom` / `shouldShowPreflight` / `getPreflightMode` / `setPreflightMode` / `showPreflightWarning` / `showInstallMethodWarning` | (2026-09-22 新增) |
| `data-source.ts` | build 域对包数据源的**窄接口**(3 方法,类型自 package-core/api 纯 type import) | `BuildDataSource` | (原名保留) |
| `single-package.ts` | `buildSinglePackageByName(data, name, variant)` | **单包构建公共执行体**(2026-09-25 第五批):按包名执行 —— 可构建校验(IGNORE 不放行)+ 形态/布局检查并发 + 记忆展开(不弹窗)+ Debug 追加覆盖;右键单包与包内容侧边栏"构建此包"共用 |

> **本域已无记忆模块**:`build-memory.ts`(包选择记忆)与状态文件层 `state-file.ts` 于 2026-09-22 一起上移进 `../share/`
> —— 该目录现为 package-service 的共享层(参数模板机制 + 记忆 + 工作区状态文件),详见 `../share/README.md`。

命名约定:`register-*` = 注册逻辑;`*-provider` = provider 实现(含其自身的注册动作);`*-ids` = 常量表;
**logger 前缀 = 文件基名**(如 `[smart-build]`、`[colcon-task-provider]`),日志可直接反推文件。

## 依赖走向(域内)

```
index.ts ──> register-commands.ts ──> command-ids / smart-build / install-type / data-source
         ──> colcon-task-provider.ts(自带 registerBuildTaskProvider)
         ──> install-type.ts
smart-build.ts ──> ../share/build-memory.ts + ../share/selection-memory.ts ──> ../share/state-file.ts(共享层:记忆 + 工作区状态文件)
               ──> install-type.ts / data-source.ts / install-layout-check.ts / install-method-check.ts
register-commands.ts ──> install-layout-check.ts / install-method-check.ts(构建前两项检查)
install-layout-check.ts / install-method-check.ts ──> preflight-warnings.ts(弹窗唯一出口;形态检查只出文案)
```

外部消费:`extension.ts`(命令 ID + 两个 register)、`test-provider/ros-test-runner.ts`(resolveInstallType),
均经 `index.ts`;出边只有 `composeApi`(ros2/api)、`package-core/api` 的 type import,
以及 `../share/`(状态文件通用层,2026-09-22 起与 config/ 共用——原 `package-service/state` 已上移)。

## 两种任务机制(勿混淆)

| | 机制① 主动执行 | 机制② 响应解析 |
|:--|:--|:--|
| 方向 | 扩展【主动】发起 | VS Code【回调】我们 |
| 入口 | `composeApi.rosTaskRunner.colcon_build`(shell 类型) | `colcon-task-provider.ts` `ColconProvider.resolveTask`(colcon 类型) |
| 服务对象 | 智能构建 / 右键单包(本域命令) | tasks.json 里手写的 `{"type":"colcon"}` 任务 |

二者互不替代;详见 `src/ros2/commands/README.md`「两种任务机制」节。

## 边界

- **命令由设置模板决定**(2026-09-22 接线):`share-spec.ts` 读 `ROS2.build.shareSpec` → 与出厂默认合并 → 用 `share/` 引擎展开成**整条 argv**,经 `ColconBuildOptions.argv`(**必填**)交给 ros2/ 执行;ros2/ 侧的内置构造 `toColconBuildCommand` 已删除,不留回退路径;
- **不直接取包数据**:经 `BuildDataSource` 注入,不 import extension 全局(消除循环依赖);
- **不做环境判定**:环境门槛在 `colcon_build` 内(`getEnvIssue`),本域只负责交互与注册;
- `ros-shell.ts` 已于 2026-08-31 删除(链路收敛 A 后零内容墓碑,历史见 git);
- `register-task-provider.ts`(原 `build-tool.ts`)已于 2026-08-31 并入 `colcon-task-provider.ts`(3 行壳 + 1:1 独占关系,不值得独立成文件);
- **不拥有状态文件**:`.vscode/rde-ros-2-state.json` 属 `../share/`(三域共用,2026-09-22 自 state/ 上移),build 只拥有其中 3 个字段(所有者表见 ../share/README.md);
- **安装布局只告警不拦截**:`install-layout-check.ts` 只读标记 + 弹警告——布局不一致时 colcon 自己会以退出码 1 拒绝(VM 实测 colcon-core 0.21.0),扩展不替用户做"清理 install/ 或改设置"的决定,也不阻止构建;
- **形态轴(copy/symlink)已按六格矩阵做构建前检查,且"每个方向只用它的权威信号"**:① 本次**符号** → build 落点 lstat(是实体目录 ⇒ 退出码 2);② 本次**实体** → **install 侧现状(唯一探针)**`<prefix>/share/ament_index/resource_index/packages/<pkg>` 一次 lstat(**实测 isolated/merged × 符号/实体 四组合完全同步**;写入者:ament_cmake = `ament_package()` 钩子 → `ament_index_register_package()`,ament_python = 包自己的 `setup.py` 的 `data_files`);**探针缺失 → `unknown` 放行,不挂任何次选探针、也不做扫描**——依据"不假设用户会人工局部篡改 install/"(否则连软链都能被全删,任何残留痕迹判据都会失效),缺失只发生在**设计使然**的两类(纯 CMake 包无 ament 索引;手写 setup.py 未注册 `packages` 的 ament_python 包);`package_run_dependencies` / `parent_prefix_path` 与 `packages` **同生共死**(8 包 × 2 形态实测),挂第二条永远不可能被命中故去掉;③ `CMakeCache.txt` 的 `AMENT_CMAKE_SYMLINK_INSTALL` **只用于"要不要 `--cmake-clean-cache`"**。⚠️ **cache 不代表 install 现状**:build 先于 install,实测可稳定构造「cache=`OFF`(说实体)+ 落点=实体目录 + install 侧仍 65 条软链」——拿 cache 判"一致/无事"会漏掉正在发生的静默无效(用户 2026-09-22 指出,已修 + 加护栏)。install 侧读取**不采信清单 / `*.egg-link`**(会撒谎)。`cmake_args.last`(**按是否包含 flag 判定**)保留为**诊断知识、不参与判定**。切换形态的**六格矩阵** + 边界场景 + 时序错位 + 探针写入者/成本实测、失败判据与修复路径见 `知识/安装形态切换六格矩阵-实测-2026-09-22.md`。结论:**切换形态须先删 `build/<pkg>` + `install/<pkg>`**——不删则"符号→实体"静默无效(退出 0 但产物不变)、"实体→符号"退出码 2(`create_symlink` 撞实体目录);`--cmake-clean-cache` 只解决配置回落,替代不了清理。`install-method-check.ts` 只做**查表 + 自动清缓存 + 提示**(按包,选完包之后;不阻塞);
- **前瞻警告:三选一模式 + 「不再提示」按钮 + 时机规定**。模式 `ROS2.build.preflightWarnings` = `on`(默认,三类都提示)/`off`(全静默)/`ignore-silent-noop`(只忽略"形态静默无效");**只影响提示**——检查照跑、`--cmake-clean-cache` 照加、构建照常。`silent-noop` 类通知带「不再提示此类警告」按钮(官方 UX 指南:✔️ 每条通知都应提供 "Do not show again";❌ 不要重复发送),点击写工作区设置为 `ignore-silent-noop`。**通知类型研究结论**(以 `@types/vscode@1.101.0` / `engines.vscode ^1.101.0` 为准):① **非模态 toast** = 可与 QuickPick 并存、✅ 支持按钮、API **无 sticky/timeout 参数**(收起时机由 VS Code 控制)→ **本项目采用**;② **模态对话框** = 必须应答、**阻塞界面** ⇒ 会把同时打开的 QuickPick 挡死,不用;③ **进度通知**(`withProgress` + `ProgressLocation.Notification`)= 任务结束即消失,但**只有 cancel、无自定义按钮**,不适用。**弹出时机**:W1 布局(工作区级精度)随**第一个选择项**立即弹;W2/W3 形态(按选中包,精度不同)随**第二个选择项**弹(检查不 await,完成即弹)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 文档勘误 + 补登:①边界节两处(`package-service/state`/state/README.md)改指 `../share/`(2026-09-22 上移后漏改,与同文"已上移"自相矛盾);②补登 2026-09-25(第五批)——`buildSinglePackageByName` 单包公共执行体抽取入 single-package.ts(文件表已有行);③补登 2026-09-28(批次3)——设置键归位 `ROS2.colcon.build.shareSpec`→`ROS2.build.shareSpec`、`ROS2.colcon.build.preflightWarnings`→`ROS2.build.preflightWarnings`(正文已随批改键,记录行漏登) |
| 2026-09-22(单包吃记忆 + 去兼容) | ① **右键单包构建不再弹任何参数选择**:新增 `share-spec.expandColconBuildWithMemory()` —— 直接套用 `share/selection-memory` 里的选择(勾过的预设 + 上次自定义输入),**记忆为空 ⇒ 等价于直接用模板**(设置没写就是出厂默认模板);两个单包入口(Release/Debug)都改走它,Debug 仍追加一组 `--cmake-args -DCMAKE_BUILD_TYPE=Debug` 覆盖;② **删除兼容层**:`ColconBuildOptions` 收成 `{ base_path, argv, packages? }`(`argv` 必填),ros2/ 的 `toColconBuildCommand` 与 `build_type`/`parallel`/`verbose`/`clean`/`install_type` 字段一并删除(开发期不留"旧调用方"路径) |
| 2026-09-22(模板接线) | **构建命令改由设置模板展开(接线落地)**:① 新增 `share-spec.ts`(读设置 + 合并出厂默认 + 装填动态参数 + 展开);② `smart-build.ts` 第二个弹窗由"四条固定构建配置"换成通用的 `share/pick-preset.pickPresets()`(自定义输入仅在模板含 `${0}` 时出现;多选;Esc 一律取消),命令改走 `expandColconBuild()` 并把整条 argv 交给 `colcon_build`;③ `register-commands.ts` 两个右键单包入口同样走模板(Release = 模板原样;**Debug = 模板展开后追加一组 `--cmake-args -DCMAKE_BUILD_TYPE=Debug` 覆盖**——因为模板已写死 `RelWithDebInfo` 且机制不再暴露 `${build_type}`);④ `ros2/api` 的 `ColconBuildOptions` 改收 `argv`(必填)(ros2/ 只收现成 argv,不认识模板);⑤ 构建记忆字段 `buildConfig` 下线(参数选择改归 `share/selection-memory`);⑥ 删除 `makeConfigItems`/`pickBuildConfig`。**内置模板在普通输出下与旧命令逐字节等价**(`share` 单测锁定);无头用例 **165 例全过** |
| 2026-09-22(构建 env 分离) | **构建终端不再带本工作区 overlay**:`ros2/commands/ros_task_runner.ts` 的 `colcon_build` 改用环境域 `getBuildEnv()`(= 快照剔除本工作区自身条目,见 `ros2/environment/README.md`「构建专用环境」)⇒ `colcon-override-check` 的 "already built in one or more underlay workspaces" 警告**消失**,并顺带消掉"旧 install 参与 include 顺序 / 被判 Up-to-date"的隐患。与 build 域两项前瞻检查**互补**:前者治"构建环境里带进了自己的 install",后者治"磁盘上的陈旧布局/形态";`--allow-overriding` 因此不再必要(仅作备选) |
| 2026-09-22(W3 可关 + 按钮 + 时机) | **按用户要求**:① 前瞻警告模式由布尔改为**三选一枚举** `on`/`off`/`ignore-silent-noop`(兼容旧布尔 `false`→off),即"W3 单独可关";② `silent-noop` 类通知增加**「不再提示此类警告」按钮**(点击写工作区设置 = ignore-silent-noop);③ **弹出时机按精度分级**:W1 布局(工作区级)随**第一个选择项**弹(原有),W2/W3 形态(按选中包)改为随**第二个选择项**弹——`smart-build.ts` 改为"启动检查不 await → 第二个弹窗出现时通知并发弹出 → 构建前再取 `cleanCache`";④ **通知类型研究落实**(`@types/vscode@1.101.0` + 官方 UX 指南):采用**非模态 toast**(唯一能与 QuickPick 并存且支持按钮者;模态会阻塞 QuickPick;`withProgress` 进度通知只有 cancel、无自定义按钮),`MessageOptions` 无 sticky/timeout,收起时机由 VS Code 控制。代码:新增 `warningKind`(conflict/silent-noop)、`showInstallMethodWarning()`、`preflightModeFrom()`、`shouldShowPreflight()`、`setPreflightMode()`。单测:**38 例全过** |
| 2026-09-22(文档留痕) | 按用户要求把结论与**提问全过程**写入知识文档:新增 **§6.1「为什么不能把 CMakeCache 当 build 侧唯一信号(信号 1 与 3 能否合并)」**(格 6 反例:实体态 cache=`OFF` + 落点目录 + 本次符号 → 只看 cache 会放行,实际退出码 2;反向落点也替代不了 cache)与 **§8「问答与决策记录」**(本次调查用户提过的 14 个问题逐条:问题/结论/依据/落地),§7 未验证边界同步更新。本文档为 `install-method-check.ts` 判据的唯一依据来源 |
| 2026-09-22(探针单条定稿) | **install 侧只留唯一探针(用户裁定)**:`<prefix>/share/ament_index/resource_index/packages/<pkg>` 一次 lstat;`package_run_dependencies` **也不挂**(与 `parent_prefix_path` 同为同源同自由度,只有 `packages` 普适:ament_python 也有),**兜底有界扫描整体移除**——理由:扫描的前提是"install 侧内容未被人工改动",而该前提一旦不成立,用户连软链都能全删,任何残留痕迹判据都会失效 ⇒ 明确采用假设"install/ 不由人工局部篡改",探针缺失即 `unknown` 放行(缺失只发生在纯 CMake 包 / 手写 setup.py 未注册这两类设计使然的情形)。代价:极罕见的"手写 setup.py 的 ament_python 包 + 符号态 + 切实体"会漏判(已记入文档)。单测重写为单探针版并新增两条锁定用例(探针缺失不扫描、次选资源项不参与判定),**37 例全过** |
| 2026-09-22(探针链定稿) | **探针链只留两条(用户裁定 + 8 包 × 2 形态实测)**:`package_run_dependencies` 与 `parent_prefix_path` **同生共死**(同由 `ament_index_register_package()` 注册:ament_cmake 系两者都在,ament_python(iii/ggg)/ 纯 CMake(p15)两者都无),自由度完全相同、第 3 条永远不会被命中 ⇒ 去掉;保留 `packages`(唯一普适,ament_python 也有)+ `package_run_dependencies`,其后仍是"标记全缺 → 降级有界扫描 → 仍无结论则放行"。单测同步(标记链只两条 + `parent_prefix_path` 不参与判定的锁定用例),**36 例全过** |
| 2026-09-22(探针升级) | **install 侧判定改用 ament_index 标记(用户提议"只看一个标记文件",并要求查清写入者与不写的边界")**:首选 `share/ament_index/resource_index/{packages,package_run_dependencies}/<pkg>` **一次 lstat**(软链=符号 / 实体文件=实体);实测 isolated/merged × 符号/实体 四组合与 install 侧完全同步 ⇒ **merged 布局不再是盲区**;查清写入者(ament_cmake = `ament_package()` 钩子 → `ament_index_register_package()`;ament_python = 包自己的 `setup.py` 的 `data_files`)与**不写的情形**(纯 CMake 包 / 手写 setup.py 漏写 / install 被部分删除),故保留"标记全缺时降级有界扫描"的兜底;成本 0.0025 ms vs 扫描 0.07~0.41 ms。单测新增标记/标记链 2 例,**36 例全过** |
| 2026-09-22(判据分工修正) | **用户指出"CMakeCache 的 0/1 与对应包的安装形式并不对应"**(build 先于 install:cache 可能已写成新形态,而 install 仍是旧的)→ 判据改为**每方向一个权威信号**:本次**符号**看 build 落点(失败在 build 侧)、本次**实体**看 **install 侧现状**(静默无效在 install 侧)、`CMakeCache` **只用于决定是否自动 `--cmake-clean-cache`**;**install 侧扫描由"仅无 cache 时"改为"本次实体时总是做"**(有界 + 已做目标前缀过滤)。复现证据:符号构建→实体+clean-cache→删落点再实体构建 = 「cache=`OFF` + 落点=实体目录 + install 仍 65 软链」,旧判据会判"无事"。单测新增 4 条护栏:22:50 情形、mx10 情形、cache=符号但 install 已实体(不误报)、unknown 放行 |
| 2026-09-22(简化) | **按用户裁定简化形态判据**:去掉 `cmake_args.last` 读取(少一次读 + 少一个概念,它降级为纯诊断知识);**主判据统一为 `CMakeCache.txt` 的 `AMENT_CMAKE_SYMLINK_INSTALL`**(`=1/ON` 符号 / `=OFF` 实体 / **文件不存在 → 任意类型通过**);保留两条**必要**兜底——① 落点 lstat(治 cache 已翻符号而落点仍是实体目录的**重复失败**,否则会再次退出码 2)② **仅在无 CMakeCache 时**扫 install 侧(治"build 被删、install 还在却要切实体"的静默无效;实测反向"实体→符号"能自动修正,故不提示)。**同批修掉兜底②的假阳性**:只认"目标落在工作区 `src/` 或 `build/`"的软链(官方 deb 实体安装实测有 4 条版本链 `libfastcdr.so -> libfastcdr.so.1` 等,只看"是不是软链"会错判),`merged` 布局无法归属单包 → `unknown` 不猜。单测同步重写为简化版判据 + 3 个边界场景 + 版本链/merged 两条假阳性护栏,**31 例全过** |
| 2026-09-22 | **构建前安装形态检查(六格矩阵落地)+ 前瞻警告开关**:新增 `install-method-check.ts`(零 vscode:读 `cmake_args.last` 判"上次请求形态"、读 `CMakeCache.txt` 判"实际配置形态"、lstat 落点判硬冲突、有界扫描 install 侧判静默无效 → 输出 `{cleanCache, warning}`);`smart-build.ts` 在**选完包之后**按包检查并把 `cleanCache` 传给 `ColconBuildOptions.clean`(自动加 `--cmake-clean-cache`),`register-commands.ts` 两个单包入口同办;命中"本次符号 + 落点实体目录(必失败退出码 2)"或"本次实体 + 现状符号(静默无效)"时弹**非阻塞**提示并给出"该删哪个目录"。新增 `preflight-warnings.ts`(`ROS2.colcon.build.preflightWarnings`,默认 true)作为**布局预判与形态预判的唯一弹窗出口**——前瞻警告与构建自身报错重复,允许关闭(关闭不影响自动清缓存与构建)。单测:新增 `test/suite/install-method-check.test.ts`(查表/文案/磁盘判据/端到端,软链断言在无权限平台自动跳过)与 `test/suite/preflight-warnings.test.ts` |
| 2026-09-22 | **构建前安装布局检查(非阻塞警告)**:新增 `install-layout-check.ts`(读 `install/.colcon_install_layout` vs 本次请求布局 → 文本;**标记缺失/非法不告警**);`smart-build.ts` 在**第一个选择弹窗出现时并发**触发(不 await 通知本身:用户可无视风险走完两级选择并构建)、`register-commands.ts` 两个单包构建前各触发一次;设计前提(用户裁定):布局在 Windows 必须锁合并(环境变量长度)、形态在 Windows 必须锁实体(符号需管理员),`auto` 默认即平台锁定;不读既有布局是刻意简化 → 现在只补"不一致就提示",不做迁移/自动清理。单测新增 `test/suite/install-layout-check.test.ts`(无头,7 例);同步修正 `test/suite/build-domain.test.ts` 拆轴前的过期断言(原断言 `resolveInstallType() === "merge"`,拆轴后返回两轴对象)。**同批实测成文**:安装形态切换六格矩阵(VM 上真跑 6 格 + 5 个补救场景)见 `知识/安装形态切换六格矩阵-实测-2026-09-22.md` |
| 2026-08-31 23:55 | **状态层分离**:通用文件读写(readStateFile/writeStateFile)git mv 上提至 `package-service/state/state-file.ts`(新建平级子域,含单写者队列 + 原子覆盖),build 侧只留字段访问器 `build-memory.ts`(名字随职责收窄);smart-build.ts 改依赖 build-memory;为未来的 config/ 黑名单让出并发安全的共用底座 |
| 2026-08-31 23:35 | **合并①**:`register-task-provider.ts` 整体并入 `colcon-task-provider.ts`(registerBuildTaskProvider 与 ColconProvider 同居;index.ts 出口改道,导出符号不变 → 外部与测试零改动);文件数 9 → 8;`command-ids.ts` 经讨论**保持独立**(零依赖叶子:域内后续模块取 ID 不必拖入 vscode/composeApi 重模块,亦保留 package.json↔常量一致性纯单测的可能) |
| 2026-08-31 23:10 | 建档 + **名符其实改名批次**(全部 git mv 保留历史):commands→command-ids、colcon-command→register-commands、build-command→smart-build、build-state→state-file、build-tool→register-task-provider、colcon→colcon-task-provider;删除废弃墓碑 ros-shell.ts;清理 install-type.ts 49 行死代码注释;logger 前缀统一为文件基名;index.ts 导出符号不变(外部零改动),仅 test/suite/build-domain.test.ts 的 2 条深路径导入同步 |
