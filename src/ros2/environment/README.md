# environment/ — 环境域

ROS 环境加载/激活/监听/判定的唯一所属域。**对外唯一门面 `index.ts`**(ESLint no-restricted-imports 兜底),外部组件禁止直接 import 子模块;内部模块之间自由互调。

## 对外门面 `index.ts` 导出

- `environmentFacade`(EnvironmentFacade 实现:getEnv / isAvailable / whenReady / resolvedEnv / onEnvChanged / activateEnvironment / refreshEnvironment / syncPackagesState / registerEnvironmentListeners 等);
- 生命周期:activateEnvironment / refreshEnvironment / syncPackagesState / syncBuildTaskProvider / disposeEnvSubscriptions / addEnvSubscription;
- 原语:`commandRunner` / `exec` / `spawn`(统一超时 + UTF-8/GBK 解码 + 日志);
- 只读状态:`getEnv` / `resolvedEnv` / `onEnvChanged` / `environmentState`;
- 注入:`setRosApiDeps`(环境域用上层 UI 能力)。(2026-08-31:`setActivationDeps` 已随 onDidEndTask 链移除——环境域不再需要 build-tool 能力,见「构建后刷新与 compile_commands 合并」节)

## 内部模块

| 文件 | 职责 |
|---|---|
| `state.ts` | env 内存态唯一持有者:getEnv / isAvailable / whenReady / onEnvChanged(写路径 setEnv / notifyEnvChanged 不对外) |
| `source.ts` | 环境采集与写入(2026-09-15 重设计):单次链式采集 → 快照变化写 state;外部变化触发事件;防重入,失败保留旧快照 |
| `env-collect.ts` | 环境快照采集(2026-09-15 新增):bash 交互链(--login -i)一次 source 系统 + 工作空间;Windows 走两次 sourceSetupFile 保底;验货(关键变量 + 条目数) |
| `env-compare.ts` | 环境比较纯函数(2026-09-15 新增):路径剔除 + 折叠序列/顺序指纹;snapshotChanged(写入判定)/ externalChanged(事件判定);shell 状态键不参与。`isWorkspaceEntry` 已平台无关化(反斜杠→正斜杠 + 去尾斜杠 + Windows 大小写不敏感),`valueShape` 按 `path.delimiter` 拆分(2026-09-22) |
| `activate.ts` | 完整激活/轻量刷新编排 + 组件重装配门控;构建后刷新 refreshAfterBuild(采集流水线 + compile_commands 合并) |
| `status.ts` | 可用性判定 context key 更新(单一判定来源 state.isAvailable;2026-08-31 起仅管环境/配置 key——ros2.hasPackageXml 移出,包判定归 package-core,由组合根 onDidChange 反应式更新) |
| `build-signal.ts` | **构建信号专供事件**(2026-09-30):`onBuildSignal`(对外只读)/ `fireBuildSignal()`(域内)—— register.ts 构建信号回调里**源处零防抖**先行 fire,消费方自行幂等;现由 install-truth 数据中心订阅做主动增量刷新(手工重设计/13),对外唯一构建事件出口 |
| `register.ts` | 环境监听统一注册(2026-09-15 精简:shell 配置 / 构建信号 install/setup.bash / 工作区文件夹 / 配置变化 / 60 秒轮询);**2026-09-28 批次4**:`registerSystemEnvWatch` 改返回 rebuild/dispose 句柄——`env.systemWatchFiles` 列表变化即时重建监听(组合根 5s 去抖接线) |
| `setup-script.ts` | setup 脚本路径读取/执行/发行版探测(仅依赖 host/ 与 rde-common) |
| `command-runner.ts` | CommandRunner 实现(exec/spawn 原语;env 实时取自 state) |
| `compile-commands.ts` | 编译产物合并:`build/<pkg>/compile_commands.json` → `build/compile_commands.json`(clangd 索引;2026-08-31 自废弃 build-env-utils 恢复,构建信号驱动) |
| `build-env.ts` | **构建专用环境**(2026-09-22 新增):`stripWorkspaceEntries()` 纯函数 + `getBuildEnv()` —— 从快照中**剔除本工作区自身条目**(install 各布局 / build 的 develop 注入 / 标量前缀变量),只留真正 underlay;供 `colcon build` 用,运行/调试仍用 `getEnv()` |
(2026-08-31:`deps.ts` 整文件注释墓碑——ActivationDeps 注入机制随 onDidEndTask 链整体移除,见下节;**2026-09-29 零引用清理物理删除**,git 历史可查)

## 依赖方向

environment → host/(vscode 薄壳)+ api/(仅类型)+ rde-common;不静态依赖 build-tool、不接收其注入(2026-08-31 起,原 ActivationDeps 注入已移除)。不反向依赖 consumers(门面注释明确)。

## 构建后刷新与 compile_commands 合并(2026-09-15 更新)

构建完成后做两件事,统一由 **构建信号监听**(register.ts `registerBuildSignalWatch`:`install/setup.bash` 单文件,1s 防抖)驱动 `refreshAfterBuild()`:

1. 环境采集流水线(`sourceRosAndWorkspace`,2026-09-15 重设计:系统 + 工作空间单次链式采集 → 比较 → 写入/事件);
2. 合并 `build/<pkg>/compile_commands.json` → `build/compile_commands.json`(`compile-commands.ts`,clangd 索引)。

> 【2026-09-30 构建】同一信号回调里还**先行 `fireBuildSignal()`(零防抖)** —— 环境域专供事件
> (`build-signal.ts`),现由 install-truth 数据中心订阅做 rc-mtime 增量主动刷新(手工重设计/13);
> 环境域自身的 1s 防抖刷新行为不变。

### 触发矩阵(以下为 2026-08-31 历史记录)

> 【2026-09-15 更新】构建信号已收窄为 `install/setup.bash` 单文件(每次构建 1 次事件),“我方构建任务抑制”机制整体删除;下表保留为旧 install/** 时代的记录。

| 场景 | overlay 刷新 | merge compile_commands |
|:--|:--|:--|
| 扩展构建成功/失败(经任务系统) | ✅ **任务进程结束 → 1 次**(进行期间 install/** 抑制) | ✅ 同左 |
| 手动构建成功(终端/外部) | ✅ install/** 防抖(非我方 → N 包 N 次) | ✅ 同左 |
| 手动构建失败(部分包成功) | ✅ 成功包写 install → watcher 触发 | ✅ 同左 |
| 手动构建失败(无包成功) | 不触发 = 正确(无新产物) | 不触发 = 正确(无可合并数据) |

### 与"我方构建任务"交织(2026-09-09,用户方案)

| 情形 | install/** 事件 | 刷新次数 |
|:--|:--|:--|
| 我方构建(任务系统:RosTaskRunner 快捷构建 / tasks.json 的 colcon 任务) | 进行中**全部抑制**(trace 留痕) | 任务进程结束 → **1 次** |
| 用户自行构建(终端 / 外部 / CI) | 1s 防抖聚合 | N 包 N 次(退化路径:正确但较贵) |
| 我方任务卡死 / 事件丢失 | 10 分钟超时后解除抑制 | 兜底,避免 install/** 被永久静默 |

判定 = 任务名 / 定义里的命令与参数文本含 `colcon build`(环境域不 import build 域,只按任务文本判定;`colcon test` 等不匹配);
`onDidEndTaskProcess` 携带退出码,全部我方构建结束后立即调 `refreshOverlayAfterBuild()`。


### install ↔ build 一一对应论证(2026-08-31 确认)

colcon 逐包 `configure → build → install`,install 仅在 build 成功后执行:

- install/<pkg> 写入 ⟹ 该包 build 成功 ⟹ `build/<pkg>/compile_commands.json` 已完整(编译产物最后写入早于该包 install 写入——install 写入是该包产物的"后置屏障");
- 失败包不 install → 不产生 install 写入;若其 configure 已生成 compile_commands.json(编译期失败场景),因无 install 写入不触发合并——目标未编译成功,索引价值低,接受为已知边界;
- 1s 防抖在每次 install 写入时重置 → 最后一次 install 后 1s 才执行 → 所有成功包产物已就绪。

### 结论:onDidEndTask / isROSBuildTask 链已移除(2026-08-31)

原 activate.ts 经 `onDidEndTask` + 注入的 `isROSBuildTask` 在"任务结束"时触发刷新,只覆盖扩展任务路径、漏手动构建(用户终端自行 build 不是 vscode.Task,该事件永不触发);
overlay 与 merge 的输入信号(install/、build/ 产物)由文件监听全覆盖后此链冗余,连同注入机制一并删除:

- `activate.ts` onDidEndTask 订阅、`deps.ts`、`api/activation-deps.ts`、`build-tool.ts isROSBuildTask`、`extension.ts setActivationDeps`、`host/tasks.ts onDidEndTask` 薄壳全部移除;
- `refreshOverlayAfterBuild()` 保留为唯一实现,merge 恢复在此(`compile-commands.ts`)。

### 源码级验证(2026-08-31,克隆 colcon-core master 核实)

针对"单包 install 非原子 → 窗口内触发 → 是否产生破碎环境"的质疑,源码证实三层保证(只可能"缺席/旧状态",不可能"半写破碎"):

1. **overlay source 进不了单包窗口**:`verb/build.py` 的 main() 顺序为 `rc = execute_jobs(...)` → `self._create_prefix_scripts(install_base, ...)` → `return rc`。setup.sh/.bat + local_setup + _local_setup_util **只在全部包的 configure+build+install job 完成后一次性生成**。单包 install 窗口内该文件 mtime 未变(增量:预检跳过)或不存在(全新:返回无 overlay)→ 编译中触发 = source 是 no-op,源码保证,非推测。
2. **source 时包集合 = 运行时 iterdir 扫描**(`shell/installed_packages.py` 的 Merged/IsolatedInstalledPackageFinder):按 `share/colcon-core/packages/`(merged)或逐包子目录(isolated)的 marker 文件定包;marker(`package.dsv`)由 `environment/__init__.py create_environment_scripts` 在**该包 install 的载荷写入之后**才生成(`task/python/build.py` 顺序:setup.py install → create_environment_scripts)→ 中途扫描最多"该包缺席",不可能"该包半写"。
3. **失败构建也覆盖**:`_create_prefix_scripts` 在 execute_jobs 之后**无条件执行**(失败也重写 setup 文件)→ mtime 变化 → watcher 照常触发 → 运行时扫描只含成功安装的包、merge 只合成功包的 compile_commands。此前"失败构建可能无触发"的担忧在源码层面不成立。

```
单包 install 时序:payload 大量文件写入 → package.dsv marker 最后写
整构建时序:  所有包 job(configure+build+install) → setup.sh/.bat 一次性生成(含失败构建)
source 时刻:  setup 文件出现/重写后 ≥1s(防抖)→ iterdir 扫描 → 完整/缺席,永无半写
```

### 符号链接:不会误触发(2026-08-31 核实,VS Code 官方 wiki + API)

疑问:install/ 内含符号链接(如 Linux `--symlink-install` 链接树、Python editable 安装)时,
修改链接目标(源码)是否会导致 `install/**` watcher 误触发?

- **默认不跟随符号链接**(VS Code wiki File-Watcher-Issues 明确:symbolic links are not followed automatically;仅 `files.watcherInclude` 显式添加才跟踪);`createFileSystemWatcher` API(v1.101)无 followSymlinks 选项,行为由 VS Code 内置策略决定;
- 能触发的只有**链接条目本身**的创建/删除/替换(即 colcon 重新生成链接 = 真实安装动作),这是合法触发;
- 即便假设误触发,破坏力上限是空操作:overlay source 被 setup 文件 mtime 门槛挡住(源码编辑不改它)、merge 读的 `build/<pkg>/compile_commands.json` 也不随源码编辑变化(输出相同,仅浪费 IO);
- 平台:Windows(ReadDirectoryChangesW)不递归跟随重解析点,且本项目 Windows 默认 `--merge-install`(可经 `ROS2.build.installLayout` 显式改分包;install/ 基本无符号链接),此担忧基本不存在;Linux/mac 链接树同理不跟随;Remote(SSH/WSL/Docker)watcher 跑在远端 FS;
- **反向风险更值得注意**:wiki 同页——mapped network drives / 第三方 FS 驱动不保证产生文件事件(工作区在网络挂载如 ros2share 时可能**漏事件**,而非误触发);watcher 不跟随符号链接,不会像 walk 层那样遍历爆炸(walk-utils.ts 符号链接默认不跟随),但也跟踪不到链接目标的任何变化。

## source 机制与 isAvailable 判定(2026-08-31 定稿)

> 【2026-09-15 更新】"source 链"已重设计为"单次链式采集"(env-collect + env-compare + source 流水线,见文件表与修改记录);以下链路为 2026-08-31 的历史快照(行号已过时),保留作溯源。

### 链路出处(谁调谁)

```
① 触发入口  src/ros2/environment/activate.ts:78  refreshEnvironment → sourceRosAndWorkspace()
② 编排      src/ros2/environment/source.ts:312    sourceRosAndWorkspace()
              ├─ :324 refreshSystemEnv()(系统层;source.ts:127 定义)→ :165/:226 sourceSetupFile
              ├─ :326 sourceWorkspaceOverlay()(overlay;source.ts:256 定义)→ :296 sourceSetupFile
              └─ :328 state.setEnv(fullEnv)  ← "成功 source" = 走到这行
③ 封装      src/ros2/environment/setup-script.ts:122  sourceSetupFile(日志中文翻译 + env.pixiRoot)
④ 真身      node_modules/@ranchhandrobotics/rde-common/src/utils/process.ts:37
              Windows(≈:45-102):临时 .bat(vcvarsall + pixi shell-hook + call setup + set)→ cmd /c
              Unix(≈:103-119):bash --login -c "source '<file>'; env"(fish/csh 分支)
              解析(≈:155-175):stdout 的 KEY=VALUE 行 → env 对象 → resolve;exec error → reject
⑤ 写入/判定  src/ros2/environment/state.ts:86 setEnv / :41 isAvailable
```

**机制**:"source" = child_process.exec 一条 shell 命令(子进程 shell 里执行脚本 + 输出 env);
扩展捕获并解析结果环境存快照(state.setEnv)——扩展内存 env 是捕获时刻的快照,非实时。
**"成功 source"** = exec 无 error + 解析成功 → setEnv 执行;失败 = catch 吞掉、不写 → getEnv() 保持 undefined。

### getEnvIssue() 非 null 的四种情形(唯一判定,2026-08-31 #12 采用)

`getEnvIssue()`(state.ts:41;2026-08-31 由 isAvailable 重设计,返回 string | null)= 非 null 涵盖:
1. 未找到相关 source 文件(脚本路径配置错误 / 不存在);
2. 无法成功执行 source 命令(子进程失败 / shell 报错);
3. 成功执行但返回空(捕获到空环境);
4. 成功捕获环境但校验不过(ROS_DISTRO 非已知 ROS2 发行版名 / ROS_VERSION 为空)。
注:情形 1-3 使 env 为 undefined(getEnv() 返回 undefined);情形 4 是 env 有值但内容不合格——
**getEnvIssue() 单判定即全覆盖,无需再单独判 getEnv()**;返回值可直接拼进 UI 提示,布尔判定用 `=== null`。

### 构建环境门槛(#12,2026-08-31)

- `colcon_build` / `rosdep`(ros2/commands/ros_task_runner.ts)执行前检查 `environmentState.getEnvIssue()`;
  非 null → showErrorMessage 明确提示(**附具体原因**),不启动注定失败的终端;rosdep 文案独立(依赖 ROS_DISTRO);
- **doctor 豁免**(诊断工具,无环境时恰恰需要它);
- ros2 run / ros2 launch 已废弃待重新设计,不加门槛(见 commands/README.md)。

## 构建专用环境(2026-09-22 新增)

**问题**:快照按设计 source 了 `<ws>/install/setup.bash`(intellisense/调试/运行需要 overlay),但**构建不需要自己的 overlay**——
把本工作区 install 带进构建 env 会触发 `colcon-override-check` 的"自我覆盖"警告,并让旧 install 参与 include/依赖解析
(更实际的风险:实体↔符号切换的静默无效由此放大,见知识文档 §2.2)。

**做法**:`build-env.ts`

- `stripWorkspaceEntries(env, workspaceRoot)`(纯函数,可无头单测):只处理**已知路径型变量白名单**
  (`AMENT_PREFIX_PATH` / `COLCON_PREFIX_PATH` / `CMAKE_PREFIX_PATH` / `PATH` / `LD_LIBRARY_PATH` / `PYTHONPATH` /
  `PKG_CONFIG_PATH` / `CMAKE_MODULE_PATH` / `GAZEBO_*` / `IGN_*`)+ 标量 `AMENT_CURRENT_PREFIX`;
  逐条目剔除"本工作区根之下"的条目(**复用 `env-compare.isWorkspaceEntry` 同一口径**),过滤后为空则**整键删除**;
- `getBuildEnv()` = `stripWorkspaceEntries(getEnv(), 工作区根)`;分隔符用 `path.delimiter`;
- 消费方:`ros2/commands/ros_task_runner.ts` 的 `colcon_build` 改用 `getBuildEnv()`;其余 `ros2 run / launch / doctor / rosdep` 仍用 `getEnv()`(需要 overlay)。

**边界(不可越线)**:只剔"本工作区";**其它工作区与系统一律保留**(剔多了才是饮鸩止渴);不修改快照本身;
工作区内部依赖由 colcon 按拓扑自行注入各包前缀,不依赖 source 本工作区(标准 `colcon build` 流程即如此)。

**已修(2026-09-22,原为已知边界)**:`env-compare.isWorkspaceEntry` 曾为 POSIX 口径(`<root>/` 前缀),Windows 环境条目用
反斜杠 ⇒ 该共享函数会把工作区条目误判为外部条目。现已从**共享函数本身**修掉(`normalizePathForCompare`:反斜杠→正斜杠、
去尾斜杠、win32 下大小写不敏感;前缀匹配支持根自身与 `root/` 两种形态),`valueShape` 亦改为按 `path.delimiter` 拆分
(此前写死 `:`)。因此 `build-env.ts` **不再自行归一化**,与 `env-compare` 共用同一口径;POSIX 行为不变,Windows 上
`externalChanged` 不再误报"外部变化"(既有缺陷一并修复)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 文档同步(补 09-22 后 3 个提交欠账):①`register.ts` 行补批次4 `registerSystemEnvWatch` rebuild/dispose 句柄 + systemWatchFiles 即时重建(83f7f82);②`deps.ts` 表注从「已删除」改「墓碑后于 2026-09-29 物理删除」(文件此前仍在,属文案超前);③补登 e4fc59b:setup-script.ts pixi 回退串 `"c:\pixi_ws"` 转义吞反斜杠修复(实际 c:pixi_ws,2026-09-28 21:09 测试批) |
| 2026-09-22(同日补) | **`env-compare.isWorkspaceEntry` 平台无关化(共享函数修正,非绕过)**:接入 `build-env` 时发现该判定的既有缺陷——POSIX 口径(`<root>/` 前缀)+ 分隔符写死 `:` ⇒ Windows 反斜杠条目恒不匹配,`externalChanged` 会把本工作区条目误判为"外部条目"(与 `build-env` 无关的既有行为)。修法:新增 `normalizePathForCompare`(反斜杠→正斜杠、去尾斜杠、win32 大小写不敏感),`isWorkspaceEntry` 改用它并支持"根自身 / `root/` 之下"两种形态,`valueShape` 按 `path.delimiter` 拆分;`build-env.ts` 中临时的本地归一化随之删除(两处共用同一口径)。测试:`env-compare.test.ts` 夹具改平台无关(`path.delimiter`),新增分隔符/尾斜杠/大小写/`valueShape` 用例;`npx tsc -p ./` 零错误,五套无头用例 75 例全过 |
| 2026-09-22 | **构建专用环境**:新增 `build-env.ts`(`stripWorkspaceEntries` 纯函数 + `getBuildEnv`),`colcon_build` 改用它——消除 `colcon-override-check` 的自我覆盖警告,并避免旧 install 参与 include/依赖解析(与 build 域的形态/布局前瞻检查互补);新增 `test/suite/build-env.test.ts`(9 例:isolated/merged、PATH/PYTHONPATH 的 build 注入、保留其它工作区与系统、空值删键、非路径变量不动、不改原快照、分隔符跨平台) |
| 2026-09-30 | **构建信号事件化分叉(手工重设计/13)**:新增 `build-signal.ts`(`onBuildSignal` 专供事件 + `fireBuildSignal`),register.ts 构建信号回调(change/create/delete)先零防抖 fire、再走原 1s 防抖环境刷新(环境行为零变化);`EnvironmentFacade` 增 `onBuildSignal` 出口 —— install-truth 数据中心据此主动增量刷新,其 9 组 build/** watcher 同日退役。消费方幂等由对方保证(单飞+合并) |
| 2026-09-16 02:41 | **构建信号 watcher 改文件型(方案 2)+ 安装方式拆轴背景同步**:①`register.ts` `registerBuildSignalWatch` 由 `RelativePattern(wsRoot, "install/setup.bash")`(模式含斜杠 ⇒ 递归 watcher ⇒ 自动吃 `files.watcherExclude`,被自家排除表静默)改为**以文件自身为 base**(`<ws>/install/setup.bash` + `*`):文件型非递归监视跳过 excludes/includes 检查、不受排除表影响;install/ 不存在时挂起 + `fs.watchFile` 轮询(~5s)、出现即合成 create(首次构建同样可靠)。②本 README「watcher 不跟随符号链接」节勘误:"Windows 恒 `--merge-install`" → "默认 `--merge-install`(可经 `ROS2.colcon.build.installLayout` 显式改分包)"。③背景:安装方式拆两轴(形态 symlink/copy × 布局 merged/isolated),`resolveInstallType()` 改读双设置(详见 commands/README 02:23 行、gen/README 02:41 行) |
| 2026-09-15 | **环境体系重设计落地**(压缩方案,设计稿:手工重设计/ros2-环境体系设计.md):① 新增 `env-collect.ts`(bash `--login -i` 交互链一次 source 系统 + 工作空间;Windows 两次 sourceSetupFile 保底;验货=关键变量+条目数)与 `env-compare.ts`(路径剔除 + 折叠序列/顺序指纹;`snapshotChanged` 写判 / `externalChanged` 事件判;shell 状态键不参与);② `source.ts` 重写为单流水线(采集→比较→写入/事件;失败保留旧快照;防重入)——旧机制整体移除(系统层缓存三件套、overlayMtimeMs mtime 预检、sourceWorkspaceOnly、refreshSystemEnv);③ `register.ts` 精简:install/** 整树 → `install/setup.bash` 单文件构建信号,**“我方构建任务抑制”机制整体删除**;新增 60 秒轮询 `registerEnvPollTimer`;④ `activate.refreshOverlayAfterBuild` → `refreshAfterBuild`(语义=采集流水线 + compile_commands 合并;facade/环境域导出同步更名);⑤ 新增 `test/suite/env-compare.test.ts`(23 用例全过;tsc 零错误)。事件语义:环境变化事件 = 外部变化专属;工作空间变化不触发(由 package-core 侧负责) |
| 2026-09-09 21:05 | **构建任务与 install/** 事件交织(用户方案,第一部分)**:register.ts 新增"我方构建进行中"标记——`onDidStartTask` 登记(判定 = 任务名/命令/参数含 `colcon build`),期间 `install/**` 事件全部抑制(trace 留痕);`onDidEndTaskProcess`(带退出码)注销,归零时立即 `refreshOverlayAfterBuild()` → **1 次/构建**;非我方构建(终端/外部)仍走 1s 防抖退化路径(N 包 N 次);10 分钟超时兜底防永久抑制;host/tasks.ts 补两个薄壳;触发矩阵同步为交织语义;下游(rosmsg/exe-map requery、env 指纹)本次未动 |
| 2026-08-28 12:52 | 创建 environment/ README(门面导出/内部模块/依赖方向) |
| 2026-08-28 12:56 | 时间标注统一精确到时分;尾部新增修改记录便于溯源。正文引用的历史日期(2026-08-24 ~ 2026-08-26)为设计/代码注释标注日期,非文件操作时间 |
| 2026-08-30 21:16 | 删除 `vscode-utils.getRosSetupScript` 薄转发(旧兼容层):唯一调用方 `test/suite/pixi.test.ts` 改直连本域 `setup-script.ts`;生产代码本就经 `source.ts` 直连,转发无存在必要 |
| 2026-08-30 21:19 | `getRosSetupScript()` 增加 pixiRoot 平台回退(Windows 空配置回退 `c:\\pixi_ws` 并拼 `ros2-windows` 子目录;其他平台空串不做推导),与 `sourceSetupFile()` 同口径、对齐 package.json 声明文案(问题 1 遗留缺口);`pixi.test.ts` 相应断言改为按平台分支 |
| 2026-08-30 21:23 | `getDistros()` 补缺失 return:`/opt/ros` 存在但非目录时返回 `[]` 而非隐式 undefined(严格模式 noImplicitReturns 报 TS2366) |
| 2026-08-30 23:16 | 门面外部直连清零:8 处消费者改走 `composeApi.environment`(api/ 统一出口,只见 EnvironmentFacade 接口);本域仅 extension.ts 组合根保留直连(装配函数特权) |
| 2026-08-31 10:15 | 构建后刷新链定稿:install↔build 一一对应论证(四场景矩阵,新增「构建后刷新与 compile_commands 合并」节);mergeCompileCommands 自废弃 build-env-utils 恢复为 `compile-commands.ts` 并绑回 `refreshOverlayAfterBuild`;移除 onDidEndTask + isROSBuildTask + ActivationDeps 注入链(deps.ts / api/activation-deps.ts / build-tool.ts isROSBuildTask / extension.ts setActivationDeps / host/tasks.ts onDidEndTask);内部模块表/门面导出/依赖方向同步更新 |
| 2026-08-31 10:30 | 触发链章节补「源码级验证」小节(克隆 colcon-core master 核实):单包 install 非原子但三层保证不产生破碎环境——① setup 文件仅整构建末尾一次性生成(verb/build.py execute_jobs 后无条件调用)→ 单包窗口内 mtime 预检拦截;② 包集合 source 时 iterdir 扫描、package.dsv 在载荷后最后写 → 只缺席不半写;③ 失败构建同样重写 setup 文件 → 部分成功覆盖成立 |
| 2026-08-31 10:33 | 触发链章节补「符号链接:不会误触发」小节(VS Code 官方 wiki + @types/vscode API 核实):watcher 默认不跟随符号链接,链接目标(源码)变化不产生 install/** 事件;能触发的只有链接条目本身的创建/删除/替换(合法触发);即便误触发也是空操作(mtime 门槛 + merge 数据源不变);网络盘反向风险(漏事件)一并记录 |
| 2026-08-31 17:55 | status.ts 越界修复:ros2.hasPackageXml context key 移出环境域(包判定归 package-core 权威域),改由组合根 packageCore.onDidChange 反应式更新(extension.ts 编排,首载/刷新完成自动 setContext);status.ts 只保留环境/配置 key |
| 2026-08-31 18:33 | rootPath 废弃 API 迁移:setup-script.ts / source.ts `vscode.workspace.rootPath` → `workspaceFolders?.[0]?.uri.fsPath`(source.ts 顺带修掉 `${undefined}` 模板串为 `?? ""` 的潜在怪路径) |
| 2026-08-31 18:36 | source.ts 严格空值修复(VS Code 报 TS18048/TS2454,既有问题非本次引入):① rosSetupScript 展开 ${workspaceFolder} 处 workspaceFolders 判空(folders && length===1);② setupScript 赋初值兜底(catch 分支可能早于赋值) |
| 2026-08-31 18:39 | setupScript 初值优化(调试技巧):空串 → `(自动发现路径未构造:发行版 ${distro})`——正常被 path.format 覆盖;构造前抛错时 catch 日志直接带出发行版,无需反查定位 |
| 2026-08-31 21:02 | 新增「source 机制与 isAvailable 判定」节:链路出处(activate.ts:78 → source.ts:312/328 → setup-script.ts:122 → rde-common process.ts:37 → state.ts:86/41)+ isAvailable false 四情形(唯一判定)+ #12 构建门槛说明 |
| 2026-08-31 22:30 | isAvailable 彻底重设计为 getEnvIssue():string|null(state.ts 实现 + 两个 api 接口 + environmentState/facade + 全部调用方更新):返回不可用具体原因,可拼进 UI 提示;rosdep 补 #12 门槛(独立文案);文档「getEnvIssue 非 null 四情形」同步 |

<!-- 文件末尾修改时间:2026-09-15(环境体系重设计落地:单次链式采集 + 路径剔除比较 + 构建信号/60 秒轮询;详见上表 2026-09-15 行) -->
<!-- 文件末尾修改时间:2026-09-16 02:41(构建信号 watcher 改文件型(方案 2)+ 安装方式拆轴勘误,详见上表 02:41 行) -->

