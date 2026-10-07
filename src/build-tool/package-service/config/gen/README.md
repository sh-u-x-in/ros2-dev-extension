# config/gen — 编辑器配置生成器(intellisense 配置)

> package-service config 域中**唯一活跃**子目录(config 其余 2026-09-04 断电留档,见 `../README.md`)。
> 职责:吃「包数据快照 + 环境变量 + 安装布局标记」→ 增量维护三份编辑器配置 —— `.vscode/c_cpp_properties.json`(cpptools)、
> `.clangd`(clangd)、settings.json 的 `python.autoComplete/analysis.extraPaths`(Pylance),外加"有感删除"(弹窗确认后移除)。
> 定位:**分析器用的 include/搜索路径生成与追踪**(CMakeLists 的"头文件生产侧"由 `create/templates/cmake.ts` 负责,
> 两边在 2026-09-07 统一到【约定 B】头文件布局)。
> 本目录历经多轮修订(2026-09-02 五层分裂+事件追踪 → 09-05 6 包复测 → 09-06 CompilationDatabase 子键/分组
> /-isystem/管辖归正 → 09-07 头文件布局统一约定 B,clangd 行集收敛为"每包一行消费根" → 09-08 事件 10 域差量消费
> (有感删除候选 = 事件差量 oldWorkspace−workspace,不再本地维护上一版;按类型分侧 + 弹窗前存在性预检;python 侧删除接线;
> maintain-all:忽略包同样维护,分类翻转零动作;黑名单机制已移除——事件差量一次性判定下无重复骚扰可防)
> → **09-15/16 安装布局感知(读 `install/.colcon_install_layout` 的内容 → isolated / merged 分别出条目;env 不再贡献
> 本工作区路径;工作区 install/build 落点全部由本地静态模板生成;管辖内旧布局残留直接删除;settings.json 附带
> workspace 排除键)**);本文为当前语义总说明,演进详情与实测依据见"关联文档"与 `手工重设计/` 下的手稿。

## 产出文件

| 产出 | 引擎 | 生成/维护语义 |
|:--|:--|:--|
| `.vscode/c_cpp_properties.json` | cpptools | includePath = `src/<pkg>/include/**`(非 python 包,列全)+ **安装侧(按布局)**:isolated = `install/<pkg>/include/<pkg>/**` 每包一条(**多一层包名,杜绝 `<pkg>/<pkg>/…` 双层包名导入**)、merged = `install/include/**` 一条 + `/opt/ros/humble/include/**`。**`/**` 允许递归 → 死条目无害,故列全**;整块重排 + 字段补齐(compileCommands / cppStandard=gnu++20) |
| `.clangd` | clangd | CompileFlags.CompilationDatabase(build)子键 + Add **四组**(注释行分隔):编译标志 / 工作空间包 include(`-I`) / **工作空间安装产物 include(按布局,注释文字随布局)** / 发行版 include(`-isystem`)。Add **没有通配递归** → 工作区安装侧**按包静态逐条写完整消费根**(不检测目录是否已存在);发行版侧包名事先未知,只能按前缀枚举子根 |
| settings.json | Pylance | `python.autoComplete/analysis.extraPaths`(**两键同内容**)= 工作区 ament_python 包根 + **安装侧落点(按布局静态全量 + 按包类型分派)** + `build/<pkg>`(符号安装兜底)+ env(已剔除本工作区,只剩其他工作空间/系统);组序 **src → install/site-packages → build → install/local/dist-packages → /opt/ros**;另补 `files.watcherExclude` / `search.exclude` / `python.analysis.exclude` 三个排除键 |

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `distro-templates.ts` | **发行版模板注册表 + 版本发现**(2026-09-28 VD-1,纯函数零 vscode):`DISTRO_PATH_TEMPLATES`(9 个 KNOWN 发行版全覆盖)/ `resolveDistroTemplate`(未知名回落 DEFAULT)/ `observePythonAbi`(PYTHONPATH 系统段观测 pythonAbi,/opt/ros 优先)/ `resolveDistroConfig`(查行 + 观测覆盖;cmakePythonPurelib 的 ABI 段连带替换、purelib 形态沿用表行;未知发行版观测不组合) | intellisense-utils(类型与 DEFAULT) |
| `intellisense-api.ts` | **接口层**(纯类型,零实现):`IntellisenseConfigOptions`(workspaceRoot / getState / environment 门面)/ `IntellisenseConfig`(sync / subscribe / dispose) | package-core/api(仅 type) |
| `intellisense-config.ts` | **编排层**:引擎开关(`ROS2.ide.intellisenseEngine` = auto/cpptools/clangd/both/none)、800ms 防抖、两路事件订阅(包变化 + 环境变化;**无** include 目录监听——无条件收录,见语义 #2)、**maintain-all 差量消费(2026-09-08:事件 10 域,只订阅 workspace 域;有感候选 = oldWorkspace−workspace 事件差量,本地不维护上一版)**、**易增时每轮 `readInstallLayout()` 读布局并传给 cpp / clangd / python 三侧(2026-09-16)**、易增(无感)/难删(有感:**复核 → 按类型定侧(python 只走 extraPaths)→ 弹窗前存在性预检 → 60s 弹窗确认**(2026-09-08 由 10s 调长);确认计数/措辞以**包**为单位;黑名单机制已移除 2026-09-08) | utils / render、vscode |
| `intellisense-utils.ts` | **工具层**(纯函数,可无头):collectPrefixes / collectSystemIncludes / collectPythonDirs(**自带本工作区剔除,2026-09-15**)、`clangdGroupDirs`(**三组行集:ws / install / sys**)、parseClangdAddEntries、absIncludeForPkg、recheckPackageAbsent、**orderPythonExtraPaths(python extraPaths 规范组序,2026-09-16 按手稿重排为 src→site-packages→build→dist→/opt/ros)**、isUnderWorkspace / isBuildArtifactEntry、**布局感知静态模板(`InstallLayout` / `parseInstallLayout` / `readInstallLayout`(读标记内容)/ `filterExistingDirs` / `amentPythonInstallDir` / `cmakePythonInstallDir` / `cppInstallIncludeDir`(子层·cpptools)/ `cppInstallIncludePrefix`(父层·clangd)/ `pythonDevelopDir` / `collectStaticPythonDirs` / `collectStaticCppIncludes(±Prefixes)`,2026-09-16)** | node:fs |
| `intellisense-render.ts` | **渲染层**(写文件):`syncCppProperties` / `syncClangd(workspaceRoot, {ws, install?, sys}, layout)` / `syncPythonPaths(..., layout)`(**并集补缺失 + 整块规范重排,2026-09-09**;**管辖内旧布局/旧形状残留直接删除,2026-09-15**;**安装组独立分组 + 注释随布局、settings 排除键补写、孤儿分组注释清理,2026-09-16**) / 有感删除**预检**(2026-09-08:cppIncludeEntryExists / clangdIncludeExists / pythonPathExists,与 remove* 同口径) / `removeCppIncludes` / `removeClangdIncludes` / `removePythonPaths`;`.clangd` 块内破坏性归正(旧形态/重复/残留 /usr/include 清除)+ 组内补缺失;flow 保守 | utils、vscode |
| `install-layout-watch.ts` | **安装布局信号监听**(2026-09-16 自 extension.ts 收编;组合根只组装):`registerInstallLayoutWatch({ workspaceRoot, onLayoutSignal, logger })` → ①`RelativePattern(root, "*")` 盯 **install 目录条目**(按名过滤;补充信号)②标记文件**以文件自身为 base**(`<ws>/install/.colcon_install_layout` + `*`,文件型非递归监视:不受 `files.watcherExclude` 影响;不存在时挂起轮询~5s 出现即合成 create;方案 2)③兜底轮询 `pollIntervalMs`(默认 60s,0 = 关闭;当前调用点暂设 0);1s 防抖 + 目录出现后 6s 有界补查;依赖可注入(`createWatcher` / `readMarkerContent`),可无头测试 | vscode、node:fs / node:path |

## 语义要点(2026-09-16 现状)

### 1. 数据流与触发

触发 = **两路事件**:包快照(工作区包清单)变化 + 环境变化(source 完成、overlay 变化);**无** include 目录监听(2026-09-07 更正:2026-09-02 10:46 曾短暂加过、10:49 即删——无条件收录,见 #2)→ **800ms 防抖合并** →
**另两路"重算"入口(2026-09-15 起,不走事件差量,直接整块重算 + 补写;2026-09-16 修正监听面)**:
①**布局信号监听(2026-09-16 "方案 2" 收口;两个 watcher + 一个兜底)**——
  - ① `RelativePattern(root, "*")`:**补充信号**——盯工作区根条目、回调按名过滤 `install`(create/delete)→ 1s 防抖 →
    `sync()`;目录 create 时**再排一次 6s 补查**(标记可能稍晚落盘)。其"非递归 + includes 反转"通道在排除表存在时
    不可靠(反转 include 对含双星号的排除键实测匹配不到真实路径)→ **不作为正确性依赖**。
  - ② **标记文件 watcher(方案 2,主通道)**:`RelativePattern(<ws>/install/.colcon_install_layout, "*")`
    —— **以文件自身为 base** 的**文件型非递归监视**:事件显式跳过 excludes/includes 检查
    ("file is explicitly watched"),**不受 `files.watcherExclude` 影响**;文件不存在(未构建)时 VS Code 把请求
    **挂起**并用 `fs.watchFile` 轮询(~5s),路径出现即**合成 create 事件**并转入正式监视(baseWatcher 源码行为);
    注册即常驻(无"补挂"逻辑)。只订阅 create;change/delete 交给轮询兜底(用户裁定)。
  - **兜底轮询(`pollIntervalMs` 默认 60s,0 = 关闭;当前调用点暂设 0 = 验证期禁用)**:读一次标记(≤9 字节)内容,变了才重算。
  - **勘误(2026-09-16,按 VS Code 1.124.2 源码逐条核实)**:01:23/01:30 两行的根因表述**不成立**——
    "注册时父目录不存在 ⇒ watcher 死 / 锚在目标自身"是误诊(监听目标恒为 base,pattern 只是扩展侧过滤器);
    真正闸门是"**模式含斜杠 ⇒ 递归 watcher ⇒ 自动吃 files.watcherExclude**"(排除项由本扩展自己写入 install 子树)。
②用户命令 `ROS2.regenerateIntellisenseConfig`(补写缺失,非强行覆盖)。所有入口都走同一条"读内容 → 按 isolated/merged
出条目"的路径。
**构建完成信号不归本域**:`install/setup.bash`(colcon 每次调用必重写)由 `ros2/environment` 域监听并触发
`refreshAfterBuild()`;"构建后环境确实变了"经 `environment.onEnvChanged` 进来,本域照常重算——本域不自己盯 setup.bash
(生成配置不消费构建事件,2026-09-16 用户裁定)。
- **maintain-all(2026-09-08)**:配置输入 = workspace 域(unignored + ignored,**忽略包同样维护**——多收无害);
  ignore 分类翻转不产生成员变化 → 本层零动作,只订阅 workspace 域事件;
- **易增(无感)**:`collectAllIncludes(entries, layout)` 分 **ws / install / installPrefixes / sys** → 按引擎侧调
  `syncCppProperties(inc.all)`、`syncClangd({ ws, install: installPrefixes, sys }, layout)` + python extraPaths(幂等补缺失);
- **难删(有感,2026-09-08)**:消失候选 = **事件差量**(`oldWorkspace − workspace`,条目带类型;本地不再
  维护上一版快照)→ 复核(package.xml 仍在 / 已回当前集合则不删)→ **按类型定侧**(python 只走 extraPaths,
  C++ 才走 cpp/clangd,不跨侧)→ **配置存在性预检**(用户已删条目则不弹)→ 弹窗(60s 超时默认保留,
  2026-09-08 由 10s 调长)→
  同意才删;**拒绝/超时 = 条目默认保留**(黑名单机制已移除 2026-09-08:事件差量模型下每条消失至多被判定
  一次,无重复骚扰可防;路径重现后再消失会重新询问)。

### 2. include 来源分组(与【约定 B】头文件布局的关系)

- **ws** = 工作区 C++ 包(非 ament_python)的 `src/<pkg>/include`(源码根;python 包无头文件不进);
- **install** = 工作区**安装产物**(本地模板按 `.colcon_install_layout` 生成;非 ament_python 包):
  isolated = `install/<pkg>/include`(每包一条)、merged = `install/include`(一条共用);
- **sys** = 环境前缀(CMAKE/AMENT/COLCON 拼 `/include`)**中不属于本工作区的前缀**(其他工作空间 + 发行版;2026-09-15
  起 `<ws>/install` 前缀被 `collectSystemIncludes` 剔除——本工作区的安装头改由 **install 组**按布局给出,不再随 env 抖动)。
- 背景:**约定 A**(旧手写)= 装 `include/<pkg>`、导出根 `include`;**约定 B**(Humble+ 官方/rosidl)= 装
  `include/<pkg>/<pkg>`、导出根 `include/<pkg>`。2026-09-07 起本扩展生产模板与推导统一按 B。
- `all = ws + install + sys` 供 cpp 侧(cpp 用 install 的**子层**消费根);编译器默认路径(/usr/include 等)一律不收(隐式自带)。

### 3. `.clangd` 行集模型 = **每包一行消费根**(不再"父子并列全列")

- ws 组:`-I<ws>/src/<pkg>/include`(父根,源码头 `include/<pkg>/…` 经它解析;**不**展开 include/<pkg> 子行);
- **install 组(2026-09-16 独立成组,静态)**:`-isystem<ws>/install/<pkg>/include/<pkg>`(isolated)或
  `-isystem<ws>/install/include/<pkg>`(merged)= **各包子根**(B 双层物理 `include/<pkg>/<pkg>/…` 的消费根),
  注释行随布局改写(`# ---- 工作空间安装产物 include:isolated install/<pkg>/include(在后,-isystem) ----`);
  **按包清单静态逐条写全,不检测目录是否存在**(见下"为什么静态");
- sys 组:`-isystem<prefix>/include/<pkg>`(其他工作空间/发行版各包子根;**这些前缀里的包名事先未知,只能枚举**),
  **末尾再补一条前缀 include 根本身**(`-isystem<prefix>/include`;2026-09-16 用户裁定"就补这一条根")——
  实测 `/opt/ros/humble/include` 下有 7 个**非双层包名**的包(`foonathan_memory`、`intra_process_demo`、
  `libyaml_vendor`、`moodycamel`、`tf2_sensor_msgs`、`urdfdom`、`urdfdom_headers`),它们的头直接在
  `<prefix>/include/<pkg>/x.hpp`,消费写法 `#include <<pkg>/x.hpp>` **只有父根能解析**;双层包(rosidl)仍走子根行。
  (工作区侧**不补**父根:工作区单层包由 ws 源码组 `-I<ws>/src/<pkg>/include` 兜住。)
- **为什么工作区侧静态、发行版侧枚举**:配置修正只有**包事件 / 环境事件**两个触发源,**新增头文件没有事件**——
  若按"目录现在存在吗"筛行,用户事后补上 `include/<pkg>` 时这行永远补不进配置(2026-09-16 用户裁定);
  静态写死后目录将来出现即生效,当前不存在的行对 clangd 无害(找不到即跳过)。发行版前缀里的包集合只有重装
  ROS 才会变,不属这一类,故保留 `readdir` 枚举(这是"发现未知名字",不是"筛已知条目")。
- 命中优先级:`-I` 组无条件先于 `-isystem` 命中(src 新头永远优先于 install/发行版旧头),同组内先列先赢;
  `-isystem<dir>` 必须单 token 连写(.clangd Add 元素 uniqueItems,拆行会被拒/去重);
- 归正(已存在 block):错位/重复/旧"父子并列"行(旧 env 父行、旧 ws 子行、`-I<env>` 等)移除,缺失规范行按组补入;
  管辖外条目(用户自加)原地保留;flow 风格(用户手写列表)保守只补不删;
- 通用标志:-Wall / `-std=c++20`(rclcpp 用 C++17 特性)。

### 4. c_cpp_properties.json(cpptools)

includePath = ws 组 `src/<pkg>/include/**` → install 组(按布局;isolated 每包 `install/<pkg>/include/<pkg>/**`
—— **多一层包名**以杜绝 `<pkg>/<pkg>/…` 双层包名导入;merged 一条 `install/include/**`)→ sys 组 `/opt/ros/humble/include/**`;
**cpptools 的 `/**` 允许递归,所以一次列全(死条目无害)**。短文件整块重排 = [管辖规范序] + [管辖外额外条目(原序去重)];
残留 /usr/include 清除;字段升级:缺 compileCommands 补 `${workspaceFolder}/build/compile_commands.json`、
cppStandard 旧默认 gnu++17 → gnu++20(与 .clangd 对齐)。2026-09-15:env 组**不含本工作区前缀**;管辖内旧布局/旧形状残留
(本工作区 install/build 派生且不在新集合)直接清除。

### 5. python extraPaths(Pylance)

成员 = 工作区 ament_python 包根(src)+ **安装侧落点(按布局塌缩,按包类型静态全量)** + `build/<pkg>`(符号安装 develop
兜底)+ env(其他工作空间/系统;本工作区条目已在 `collectPythonDirs` 内剔除):
- ament_python 包 → isolated `install/<pkg>/lib/<abi>/site-packages` / merged `install/lib/<abi>/site-packages`
  (**实体安装=真实文件;符号安装=只有 `<pkg>.egg-link` 指针,目录仍真实 → 一律收录**,用户裁定"必须得加");
- 其他包(rosidl 接口包 / ament_cmake_python 混合包 / 纯 C++)→ isolated `install/<pkg>/local/lib/<abi>/dist-packages` /
  merged `install/local/lib/<abi>/dist-packages`(**符号安装下目录真实、内部条目是指向 build/src 的符号链 → 可分析**);
  纯 C++ 包写成惰性条目(不存在即被分析器跳过)—— **静态全量、不按存在性筛**(同上"为什么静态");
- `build/<pkg>` = 符号安装的 develop 注入目录(egg-link 指向的正是它),两种安装形态都写(实体下只是惰性条目);
- 发行版常量按**发行版分派**(2026-09-28 VD,`distro-templates.ts`):`env.ROS_DISTRO` 查模板表(humble~lyrical + EOL 备查行,
  **rolling 维持排除**,2026-09-28 用户裁定)+ `env.PYTHONPATH` **观测 pythonAbi 优先**(解 iron jammy/noble 双装歧义),
  观测失败→表值,未知发行版/无 env→整体回落 humble 默认(与 2026-09-15 裁定一致);差异事实源见
  `手工重设计/gen-静态路径核实-2026-09-15.md` 与 `手工重设计/12-发行版发现与gen模板分派-设计方案.md`。

读现有配置 → **管辖条目并集补缺失 + 整块规范重排**(2026-09-09,对齐 cpp includePath"先列先赢 + 每轮重排");
组序(2026-09-16 按手稿)= **① src 源码 → ② 其它未分类 → ③ install/…/site-packages → ④ build(develop 注入) →
⑤ install/…/local/dist-packages → ⑥ /opt/ros 官方置尾**;同组保持原相对顺序(稳定,不 churn)。
**管辖外条目(用户自加,可位于任意位置)不参与排序/比较**:以原相对顺序保留在队尾,用户增删/调序队尾不触发
重写;**但本工作区 install/build 派生条目若不在新集合中 = 旧布局/旧形状残留 → 直接删除**(2026-09-15 起不再
留队尾;cpp includePath / .clangd Add / python extraPaths 三处同规则)。另:settings.json 会补写三个排除键
(`files.watcherExclude` / `search.exclude` 对象补 `true`,`python.analysis.exclude` 数组追加),只补缺失、不动用户已有值。
语义:同名冲突时"你的包"胜、实体安装陈旧时分析器看新版——与 C++ `-I` 同思路(Python 无 -isystem 告警抑制,排序纯加分无副作用)。

## 演进简表

| 时间(精确到分) | 关键变化 | 详档 |
|---|---|---|
| 2026-09-02 10:12 | 原 build-env-utils 重设计:api/utils/render/blacklist/config 五层;环境变化事件追踪、有感删除、黑名单、引擎开关(事件源仅包+环境两路;10:46 加的 include watcher 10:49 即删——无条件收录、不做存在性检测) | package-service/README.md 修改记录 |
| 2026-09-05 10:16 | 6 包复杂环境复测(普通/混合/rosidl 接口包 + symlink/entity 混装):命中 100%;当时 clangd 靠"顶层+一级子层全列"同时兼容 A/B | 复测报告 md |
| 2026-09-06 18:35 | CompilationDatabase 收编 CompileFlags 子键;Add 分组(标志/ws/env,注释分隔);env 归 `-isystem`;管辖内破坏性归正;收 /usr/include;cppStandard gnu++20 | package-service/README.md 修改记录 |
| 2026-09-07 22:44 | 头文件布局统一【约定 B】:clangd 行集收敛为每包一行消费根(ws 父根 / env 子根),不再父子并列;无子目录前缀不产出行;旧形态同步归正 | 本文 + package-service/README.md |
| 2026-09-15 23:24 | **工作区条目不参与 env 推导 + 静态安装路径模板 + 布局变化重算**:env 侧剔除本工作区前缀/条目(只留其他工作空间 + 系统);工作区 install/build 落点改由本地静态模板生成;管辖内旧布局残留由"留队尾"改为**直接删除**;新增 `install/.colcon_install_layout` 创建监听(1s 防抖 → 三配置重算补写)与用户命令 `ROS2.regenerateIntellisenseConfig` | 本文 §4/§5 + 手工重设计/gen-静态路径核实-2026-09-15.md |
| 2026-09-16 00:21 | **安装布局感知落地(读内容 → 按 isolated/merged 分别出条目)**:`readInstallLayout` 每轮读 `.colcon_install_layout` **内容**;cpp 安装侧按布局给**子层**消费根(isolated 每包 `install/<pkg>/include/<pkg>/**` 杜绝双层包名导入 / merged 一条 `install/include/**`)、clangd 安装侧给**父层**前缀由 `clangdGroupDirs` 展开真实子根并独立成组(注释随布局)、python 落点按布局塌缩 + 存在性过滤 + `build/<pkg>` 兜底;`orderPythonExtraPaths` 组序按手稿改为 src→site-packages→build→dist→/opt/ros;settings.json 补写三个排除键 | 本文 + 手工重设计/{.clangd,.clangd copy,c_cpp_properties*(2),setting*(2)} 手稿 |

## 关联文档

| 文档 | 内容 |
|---|---|
| `外部调研-ROS2路径映射与intellisense-参考.md` | 外部实测结论(路径映射/双层 include/分析器不继承终端);2026-09-07 已注记 B 收敛 |
| `复测报告-intellisense-gen-6包复杂环境-2026-09-05.md` | 6 包复测等价复算与命中表;文首有 2026-09-07 修订注记(被取代部分) |
| `环境变量获取与数据来源路线-调查.md` | 环境变量来源路线与历次修订记录 |
| `../../README.md` | package-service 总览与修改记录 |
| `手工重设计/{.clangd,.clangd copy,c_cpp_properties.json,c_cpp_properties copy.json,setting.json,setting copy.json}` | **配置产出目标手稿**(isolated / merged 各一套;带内联注记说明为何这样写);2026-09-16 起产物与其逐行对齐 |
| `手工重设计/gen-静态路径核实-2026-09-15.md` | 跨发行版路径核实(Humble/Iron/Jazzy/Kilted 的 python 落点差异、符号/实体形态实测) |
| `test/suite/intellisense-config.test.ts` | 无头 mocha 单测(29 例:utils 纯函数 + 渲染生成/增量/归正/删除/多事件循环/有感删除预检/extraPaths 规范组序/孤儿注释清理/**发行版模板透传与切回清替(2026-09-28)**) |
| `test/suite/distro-templates.test.ts` | 无头 mocha 单测(7 例:模板表覆盖与回落/PYTHONPATH 观测提取/组合覆盖与不组合语义;2026-09-28) |
| `test/suite/intellisense-ws-filter.test.ts` | 无头 mocha 单测(14 例:本工作区剔除判定 + env 集合过滤 + 布局标记解析/读取 + 布局感知静态路径 + 组序;2026-09-15/16) |
| `test/suite/install-layout-watch.test.ts` | 无头 mocha 单测(5 例:锚点=工作区根、install/ 存在性决定是否挂标记监听、目录出现后补挂 + 防抖 + 补查、事件合并、dispose 清理;2026-09-16) |

## 测试与边界

- 无头运行:`npm run test-compile && npx mocha out/test/suite/distro-templates.test.js out/test/suite/intellisense-config.test.js out/test/suite/intellisense-ws-filter.test.js`(render/state 层需 `_vscode-stub`);四象限真跑见 `.tmp_gen4/`(VM 侧:fresh.sh 干净生成 + finalcheck.sh 与手稿逐行比对);
- 依赖方向:外部 → package-service → package-core;环境经 ros2/ 门面注入(api.ts 窄接口);
- 修改提醒:改行集语义/归正/删除 = 影响用户已有 `.clangd` / c_cpp_properties,必须同步单测与本文语义要点。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-28 17:27 | **发行版模板分派(VD 批次,设计方案 `手工重设计/12`)**:①新增 `distro-templates.ts`——`DISTRO_PATH_TEMPLATES` 模板表(humble=VM 实测专有 `local/lib/python3.10/dist-packages`;iron/jazzy/kilted/lyrical=`lib/<abi>/site-packages`(手稿 C2,源码级);dashing/eloquent=python3.6、foxy/galactic=python3.8(EOL 备查,2026-09-28 网络核实,两老发行版均按 bionic/focal 系统 python 构建);**rolling 维持排除**——不进环境域白名单、不进表,2026-09-28 用户裁定);`observePythonAbi` 从 env.PYTHONPATH 观测 python3.\d+ 完整目录段(/opt/ros 系统段优先,任意段兜底;解 iron jammy/noble 双装歧义);`resolveDistroConfig` = 查行 + 观测覆盖(**观测优先,表兜底**,2026-09-28 用户裁定;观测覆盖时 cmakePythonPurelib 的 ABI 段连带替换、purelib 形态沿用表行;未知发行版/无 env 整体回落 DEFAULT,观测不组合)。②接线:`intellisense-config.applyAdditions` 每轮解析并打日志(distro/ABI/来源),`syncPythonPaths` 加可选 `tpl` 参透传 `collectStaticPythonDirs`(缺省 = DEFAULT,向后兼容);发行版切换后旧形状条目由既有"旧形状残留直接删除"机制自动清替,零新增事件/配置键(package.json 零改动)。③测试:新增 `test/suite/distro-templates.test.ts`(7 例)+ config 套件 +1(28→29,模板透传与切回清替),既有 `DEFAULT_PATH_TEMPLATE === HUMBLE` 断言保留。④头文件布局/系统 include 组/`-std` 经核实**无发行版差异,不进模板**(约定 B 自 Humble 起一致:rosidl `DESTINATION include/${PROJECT_NAME}/${PROJECT_NAME}` + Jazzy 佐证;sys 组走 env 前缀天然自适应) |
| 2026-09-16 02:41 | **监听改造收口(方案 2)+ 勘误 + 文档同步**:①标记 watcher 改为**以文件自身为 base** 的文件型非递归监视——事件显式跳过 excludes/includes 检查、不受 `files.watcherExclude` 影响;文件不存在时挂起 + `fs.watchFile` 轮询(~5s),出现即合成 create 并转入正式监视;注册即常驻(删除 `dirExists` 与补挂逻辑)。②目录条目 watcher 降级为补充信号。③轮询保留默认 60s,当前调用点暂设 `pollIntervalMs: 0`(验证期禁用兜底,先只验 watcher 通路)。④勘误 01:23/01:30 行:"父目录不存在/锚在目标自身"不成立;真闸门 = 模式含斜杠 ⇒ 递归 watcher ⇒ 自动吃 `files.watcherExclude`。⑤文件清单行与语义要点 §1 同步;单测 9 例全绿 |
| 2026-09-16 01:30 | **锚点改"工作区根条目松匹配 `*`"(用户实测给出规律:启动时 install/ 不存在→出现能触发;已存在时删掉再建不触发)**:①`install-layout-watch.ts` 的目录 watcher 由 `RelativePattern(root, "install")` 改为 `RelativePattern(root, "*")` + 回调里按条目名过滤 `install`。根因:watcher 的锚定方式取决于**注册时目标是否存在**——目标不存在时它锚在父目录(所以"从无到有"能报),目标已存在时它锚在目标自身(目录一被删 watcher 即死、不会重挂,所以"删了再建"不报)。改成松匹配后锚永远在工作区根(自身永不被删),两种情况都收得到。②用户该次日志已确认新版加载成功(`[extension] 已注册配置重算信号监听:/home/ros2/roa2_ws/install(目录条目)+ install/.colcon_install_layout(标记,按需)`)。③单测 8 → 9 例(新增"根目录里非 install 条目的增删被忽略";锚点断言改为 `/ws|*`),三套合计 **51 例全绿**,`tsc` 干净 |
| 2026-09-16 01:23 | **加"兜底轮询"并承认 watcher 通道不可靠(用户第二次实测:install/ 确实是重建的,01:16:45 那次 marker mtime = 构建开始那一刻,依然没重算)**:①新增 `pollIntervalMs`(默认 60000,0 = 关闭)+ `readMarkerContent()` 注入:每分钟读一次标记(≤9 字节)内容,内容变/出现/消失才发信号(注册时先取基线,不误报)。②机制:VS Code 对"工作区内、非递归"的 watcher 会把 `files.watcherExclude` 的键**反转成 `opts.includes`**(`mainThreadFileSystem.$watch`),而本工作区 watcherExclude 含"排除 install 目录"那条 ⇒ 目录条目 `/…/install` 不匹配(尾部还要求再有一段)、`.colcon_install_layout` 是点开头(兜底通配默认不匹配点开头段)——所以"锚点搬到工作区根"也没救回这条通道;environment 域盯的 `install/setup.bash`(非点文件、在 install/ 之下)才有事件。③结论:正确性不再押在 watcher 上 —— 切布局必然改变 AMENT_PREFIX_PATH 形状 → 环境事件会触发重算;同布局重建本来不需要写(静态模板 + 幂等);watcher 退化为"尽力而为",轮询是确定性兜底。④踩坑记录:块注释里写 `**`+`/install/`+`**` 这种 glob 字面量会因其中的"星号斜杠"提前终止注释(`tsc` TS2304),文件头已改写法规避。⑤单测:watcher 套件 5 → 8 例(轮询变化/出现/消失/关闭/dispose 停止),三套合计 **51 例全绿**;`tsc` 干净。⑥**注意**:改了 `out/` 必须在 VS Code 里 Developer: Reload Window,运行中的扩展宿主不会自动加载新编译产物 |
| 2026-09-16 01:12 | **监听实现从 extension.ts 收编为独立文件(用户要求:"别给我在 ext 拉屎,把 1 长串的监听给我收进去,自己新建一个文件装起来,交给 ext 组装")**:新增 `gen/install-layout-watch.ts`(`registerInstallLayoutWatch({ workspaceRoot, onLayoutSignal, logger })` → 双 watcher + 1s 防抖 + 目录出现后 6s 有界补查 + `dispose` 全清),`extension.ts` 只剩 12 行组装(还顺手删掉了为它加的 `import * as fs / path`)。注入缝改为 `createWatcher(base, pattern)`(原先是"传 pattern 对象",导致无头测试必须依赖 `RelativePattern` 构造器——stub 里没有;改成两字符串后测试可直接断言 `"/ws|install"`)。新增无头单测 `test/suite/install-layout-watch.test.ts` 5 例(锚点、存在性决定挂法、防抖/补挂/补查、事件合并、dispose 清理)。合计 **47 例全绿**(28 + 14 + 5),`tsc` 干净 |
| 2026-09-16 01:08 | **监听锚点搬到工作区根(用户指出:那次是 install/ 从无到有,标记 100% 是 create,却依然没事件)**:①`extension.ts` 改为**双 watcher**:`RelativePattern(root, "install")`(盯 install **目录条目**,父目录=工作区根必存在 → create/delete 必达)+ `install/.colcon_install_layout`(install/ 已存在时才挂:激活时 `fs.existsSync` 判断,或由目录事件补挂;create/change/delete)。目录 create 时额外排一次 **6s 补查**(标记可能稍晚落盘,有界)。②根因:注册时父目录 `install/` 不存在 → VS Code watcher 不会在父目录后来出现时补挂(用户那次构建里,本域的标记 watcher 与 environment 域盯 `install/setup.bash` 的 watcher **同时**没响,互相印证;两条实现模型——"监听父目录按名过滤" / "监听 base 目录 + 扩展侧按 glob 过滤"——都给出同一结论)。③注册期 debug 日志改为同时报两个锚点。④`tsc` 干净,42 例全绿 |
| 2026-09-16 01:04 | **监听面收窄回本域(用户裁定:"install/setup.bash 的监听跟你有什么关系?")**:删除 00:59 里加的那条 `install/setup.bash` watcher——它是 `ros2/environment` 域的业务(那边 register.ts 的构建信号 → `refreshAfterBuild()`),"构建后环境变了"经 `environment.onEnvChanged` 进本域即可;本域只管安装布局(信号实现见上表 01:08)。另加注册期 debug 日志,便于从日志确认监听是否挂上 |
| 2026-09-16 00:59 | **修复"构建完成后不自动重算" + 孤儿分组注释清理(用户实测 rh 日志定位)**:①**watcher 缺陷**:旧版只监听 `install/.colcon_install_layout` 的 `onDidCreate`,而该文件**不是每次构建都写**——实测重复构建 mtime 一动不动(00:25:16→00:25:16),只有删掉它或删 `install/` 才再现;且激活期间它可能已被建好(错过 create)⇒ 构建完什么信号都没有,只能手动跑命令(用户 rh 日志:`配置重算入口` 前无任何事件/调度行 = 命令直调)。修:`extension.ts` 改为该文件 **create/change/delete 三件套**(01:04 又按用户裁定撤掉了当时一并加的 setup.bash 那一路,见上表)。②**孤儿分组注释清理**:布局切换后"另一布局"的安装组注释行会残留(其条目已被归正删掉,注释没有),`syncClangd` 现在在删除步骤后无条件调用 `dropOrphanedAddMarkers`(识别 isolated/merged 两种安装组注释文本)。实测:向已生成的 `.clangd` 注入一条 merged 残留注释 → 跑真实管线 → 日志 `清理孤儿分组注释 1 行` 且只剩本布局注释。③单测 +1(孤儿注释清理)→ **42 例全绿** |
| 2026-09-16 00:37 | **sys 组末尾补一条前缀 include 根(用户手稿注记"补一个根目录")**:`clangdGroupDirs` 在枚举完 sys 前缀的各包子根后,再补一条 `<prefix>/include` 本身。原因:实测 `/opt/ros/humble/include` 下有 7 个**非双层包名**的包(foonathan_memory、intra_process_demo、libyaml_vendor、moodycamel、tf2_sensor_msgs、urdfdom、urdfdom_headers),头在 `<prefix>/include/<pkg>/x.hpp`,消费写法 `#include <<pkg>/x.hpp>` 只有父根能解析(2026-09-07"父行无解析力"的结论只对双层 rosidl 包成立)。**工作区侧不补**(单层工作区包由 ws 源码组兜住,用户明确"补工作空间的干嘛?就一个目录")。四象限重跑:`.clangd` Add **129 条**(标志 2/源码 10/安装 10/发行版 107 = 106 子根 + 1 根),末尾一行即 `-isystem/opt/ros/humble/include`;单测相应更新(父根末尾一条、错位 -I 父根归正为 -isystem 父根),41 例全绿 |
| 2026-09-16 00:32 | **安装侧改为纯静态(拆掉存在性检测,用户裁定)**:①`clangdGroupDirs` 的 install 组不再 `readdir` 子根,改为**原样收录**由 `collectStaticClangdInstallIncludes` 静态算出的消费根(isolated `install/<pkg>/include/<pkg>` / merged `install/include/<pkg>`,每包一条 —— Add 无通配递归必须写全);②`syncPythonPaths` 去掉 `filterExistingDirs`,`collectStaticPythonDirs` 全量写入(纯 C++ 包也带一条惰性 dist-packages);③删除 `filterExistingDirs` / `cppInstallIncludePrefix` / `collectStaticCppIncludePrefixes`,`childDirsOf` 仅保留给 sys 组(发行版/其他工作空间前缀里包名事先未知,只能枚举——属"发现"而非"筛条目")。**理由**:配置修正只有包事件/环境事件两个触发源,**新增头文件没有事件**,按存在性筛行会导致用户事后补目录时配置里永远没有该行。④单测:去掉存在性过滤用例、新增"静态不看存在性"用例(clangd 三组语义 + python 静态分派),41 例全绿。⑤四象限重跑:`.clangd` Add **128 条**(标志 2/源码 10/**安装 10**/发行版 106,两布局同数)、cpp includePath 21/21/12/12、extraPaths **21/21/10/10**;与手稿的差异 = 手稿只写了当时**已存在**的那几行(install 6 条、dist-packages 4 条),静态后补全为 10 条(多 fff/p11_use_adder/p16_rawuse/sss)与 10 条(多 lll/p11_use_adder/p14_header_only/p15_rawlib/p16_rawuse/sss) |
| 2026-09-16 00:21 | **安装布局感知(读 `.colcon_install_layout` 内容 → isolated/merged 分别生成)+ 手稿对齐**:①`intellisense-utils` 新增 `InstallLayout` / `parseInstallLayout` / `readInstallLayout`(读**内容**,缺失/非法 → `isolated`=colcon 默认)/ `filterExistingDirs`;`DistroPathTemplate` 保留为跨版本接口(Humble 默认)。②安装侧模板改为**布局塌缩**:`amentPythonInstallDir`(isolated `install/<pkg>/lib/<abi>/site-packages` / merged `install/lib/<abi>/site-packages`)、`cmakePythonInstallDir`(isolated `install/<pkg>/<purelib>` / merged `install/<purelib>`)、`cppInstallIncludeDir`(cpptools 用**子层**消费根:isolated `install/<pkg>/include/<pkg>`、merged `install/include`)、`cppInstallIncludePrefix`(clangd 用**父层**前缀)、`pythonDevelopDir`(`build/<pkg>`)、`collectStaticPythonDirs` / `collectStaticCppIncludes` / `collectStaticCppIncludePrefixes`。③`clangdGroupDirs` 改三组 `{ws, install, sys}`,install 独立成组、注释随布局(`工作空间安装产物 include:<layout> …`);**install 与 sys 都只列真实存在的子根**(Add 逐条拼接、无通配递归),cpp 侧因 `/**` 可递归而列全。④python 落点按布局 + 存在性过滤(site-packages 实体=真实文件 / 符号=egg-link 存根,用户裁定"必须得加",一律收录;接口包 dist-packages 符号下是真目录+符号链,可分析)。⑤`orderPythonExtraPaths` 组序按手稿重排:**src → install/site-packages → build → install/local/dist → /opt/ros**(原为 build 在 site 之前)。⑥settings.json 新增三键补写 `files.watcherExclude` / `search.exclude` / `python.analysis.exclude`(只补缺失模式,`ROS2.distro` 仍归 environment 域)。⑦config 每轮 `readInstallLayout` 并传三侧(clangd 传父层前缀)。⑧单测:config 27 例(组序断言更新)+ ws-filter 14 例(布局解析/读取、模板塌缩、去重、存在性过滤、组序),合计 41 例全绿;`npx tsc -p ./` 干净。⑨四象限实测(VM `/tmp/g4/{iso-ent,iso-sym,mrg-ent,mrg-sym}`,13 包):cpp includePath **21/21/12/12 条**、`.clangd` Add **124 条**(标志 2/源码 10/安装 6/发行版 106)、extraPaths **15/15/10/10 条**;与 `手工重设计/` 六份手稿**逐行比对一致**(仅手稿内联注记/4 空格缩进/末尾无换行差异)。**已知待办**:已有旧 `.clangd` 的**增量归正不收敛**(旧版标记注释残留、安装组被追加到文件尾——生成路径正确,待改归正为"识别新旧标记 + 管辖组按规范序重排");extraPaths 同桶内相对顺序按包清单序(手稿为其反向 = 工作区 PYTHONPATH 序) |
| 2026-09-15 23:24 | **环境推导剔除本工作区 + 静态安装路径模板 + 构建结构变化重算(用户裁定)**:①`intellisense-utils` 新增 `isUnderWorkspace` / `isBuildArtifactEntry`;`collectSystemIncludes` / `collectPythonDirs` 增 `workspaceRoot` 参数,本工作区条目一律剔除(实测 roa2_ws:AMENT 11 条只剩 `/opt/ros/humble`;PYTHONPATH 11 条只剩系统 2 条)——env 从此只参与"其他工作空间 + 系统"展开,布局怎么变都不参与。②新增静态模板 `DistroPathTemplate` / `amentPythonTemplateDirs` / `cmakePythonTemplateDirs` / `collectStaticPythonDirs`(默认 `HUMBLE_PATH_TEMPLATE`,含 `pythonAbi`、`cmakePythonPurelib`;跨版本换模板即可,未做版本分派)——工作区包的 install/build 落点由模板列全(分包+合并+develop 同时列,失效条目惰性跳过),故**不需要读 `.colcon_install_layout` 判布局**;接口包(p12/p13/p10)从"靠 env 才有 dist-packages"变为模板直出。③`intellisense-render` 新增"管辖内旧布局/旧形状残留直接删除"(cpp includePath / .clangd Add / python extraPaths 三处,原先是留队尾);④`extension.ts` 新增 `install/.colcon_install_layout` 创建监听(1s 防抖 → `intellisenseConfig.sync()`)与命令 `ROS2.regenerateIntellisenseConfig`(补写,不强行覆盖);⑤新增无头单测 `test/suite/intellisense-ws-filter.test.ts`(10 例:归属判定/env 剔除/模板分派去重/跨版本接口),`npx tsc -p ./` 干净。实测推演(roa2_ws 13 包):模板 18 条 + src 3 条 + 系统 2 条 = 23 条,组序 src→build→site-packages→local/dist→/opt/ros |
| 2026-09-09 20:47 | **settings.json 写入面追踪 + 单飞串行化(用户实测"写入一半/中间态")**:追踪全部 settings.json 写入方——①`syncPythonPaths` 两键两次 `cfg.update`(每次整文件重写 settings.json)②`removePythonPaths` 逐键 update ③`ROS2.distro` 自动发现写入(`ros2/environment/source.ts:188` → `ros2/host/config.ts` update,单次)④onboarding 写 Global(非本工作区文件);**代码内无任何直接 fs 写 settings.json**。"写一半"根因 = 一次同步需保存两次,两键之间即中间态、多路同步并发会交错。修复:render 内新增 per-workspaceRoot 单飞链 `enqueueSettingsWrite`,`syncPythonPaths`/`removePythonPaths` 整体串行(顺序不重叠;两键两次保存属 VS Code API 限制,收敛结果一致) |
| 2026-09-09 01:43 | **python extraPaths 注入 + 整块规范重排(对齐 C++)**:intellisense-utils 新增纯函数 `orderPythonExtraPaths`(组序:①src 工作区 ament_python 包根 → ②其它/未分类 → ③build → ④install/site-packages → ⑤install/local/dist-packages → ⑥/opt/ros 官方置尾;同组稳定保持输入序);intellisense-render `syncPythonPaths` 从"只增不重排"升级为"并集补缺失 + 整块规范重排"(成员保留用户条目,顺序不一致即写盘,幂等无 churn)——产出与你 roa2_ws settings 同形状;单测 +2(utils 组序/渲染重排)25→27 |
| 2026-09-09 01:52 | **管辖收敛(用户意见:条目可在任何位置)**:重排与写盘比较**只作用于管辖条目**(工作区包根 + env.PYTHONPATH 注入);管辖外(用户自加)条目不参与排序,以原相对顺序整体留队尾——用户自加条目位于任意位置都不被挪动,仅队尾增删/调序不触发重写(与 cpp 管辖外"原序保留"同口径);同步 render/README/测试断言(用例并入 01:43 的 syncPythonPaths) |
| 2026-09-08 23:53 | **有感删除体验修正(用户实测)**:①确认计数/措辞改以【包】为单位——同一包多侧条目(cpp+clangd)只算 1 个包;弹窗消息、难删 debug、拒绝/同意 info 日志全部按包计(原先按条目数会把 1 个包显示成"2 条/2 个包");②删除确认超时 10s → 60s(10s 过短,实测弹窗 23:51:36 → 23:51:46 用户未来得及操作即被记超时拒绝);requestDeletionConfirmation 按唯一目录数措辞 |
| 2026-09-08 23:09 | **移除黑名单机制(简化)**:`intellisense-blacklist.ts` 整文件删除;`intellisense-config.ts` 去 import/易增清黑名单块/难删 readBlacklist+黑名单过滤+拒绝记黑名单(拒绝/超时 = 条目默认保留,路径重现后再消失会重新询问);文件头/注释同步;`includeBlacklist` 不再读写(用户旧状态文件残留字段无害,无人再读);state-file 头注所有者表、state-write/README、package-service/README、gen README(产出文件/文件清单/语义要点)黑名单相关行同步删除;state-file 测试改用中性字段名(与黑名单解耦);依赖面清零(grep includeBlacklist 仅剩历史文档) |
| 2026-09-08 22:53 | **事件 10 域差量消费 + 有感删除语义落地(与 package-core 10 域事件配套)**:①intellisense-config.ts——删本地 `lastWorkspaceDirs`,有感候选 = 事件差量(`oldWorkspace − workspace`,按 dir,条目带类型);订阅只关心 workspace 域(maintain-all,unignored/ignored 翻转零动作);难删改「复核 → 按类型定侧(python 只走 extraPaths,C++ 才走 cpp/clangd)→ 配置存在性预检(无条目不弹)→ 黑名单过滤 → 弹窗」;同意分支不再清黑名单(黑名单只与拒绝/超时(记)、条目路径重现(清)相关);②intellisense-render.ts——新增有感删除预检三函数(cppIncludeEntryExists/clangdIncludeExists/pythonPathExists,与 remove* 同口径);③python 侧删除接线(removePythonPaths 首次有候选可达);④单测 +1(预检)24→25;⑤README 语义要点/文件清单/产出文件同步 |
| 2026-09-07 22:54 | 溯源补登:演进简表/修改记录全部行补齐"精确到分"(09-02 10:12、09-05 10:16、09-06 18:35、09-07 22:44/22:50);表头改「时间(精确到分)」 |
| 2026-09-07 22:50 | 注释纠错:确认事件源仅**两路**(包变化 + 环境变化),本文件(语义要点#1 触发句、文件清单行)与 intellisense-config.ts 头注删除过期"include 目录监听(watcher)/include 目录从无到有"表述(该 watcher 2026-09-02 10:46 短暂加入、10:49 即删——无条件收录、不做存在性检测);utils 函数注释同步去掉"由 include watcher 补行"错误说法 |
| 2026-09-07 22:44 | env 行集再收紧:intellisense-utils `clangdGroupDirs` 环境组只列"确有子目录"的 `include/<pkg>`;**前缀 include 无任何子目录(缺失/空/纯 Python·无头包)不产出行**,撤销此前"退化保留父根"退路(防 `iii/include`、`fff/include` 等噪音行);render 归正注释同步;单测 +1 → 24 例全绿 |
| 2026-09-07 22:09 | 建档:本目录历经 09-02/09-05/09-06/09-07 多轮修订,补独立 README 收束当前语义(每包一行消费根 / 归正 / 易增难删 / 引擎开关),关联文档互链 |

<!-- 文件末尾修改时间:2026-09-08 22:53(事件 10 域差量消费 + 有感删除类型分侧/预检/python 侧接线,详见上表 22:53 行) -->
<!-- 文件末尾修改时间:2026-09-08 23:09(移除黑名单机制,详见上表 23:09 行) -->
<!-- 文件末尾修改时间:2026-09-08 23:53(确认按包计数 + 超时 10s→60s,详见上表 23:53 行) -->
<!-- 文件末尾修改时间:2026-09-09 01:43(python extraPaths 规范组序重排,详见上表 01:43 行) -->
<!-- 文件末尾修改时间:2026-09-09 01:52(管辖收敛:仅管辖条目参与重排/比较,详见上表 01:52 行) -->
<!-- 文件末尾修改时间:2026-09-09 20:47(settings.json 写入单飞串行化,详见上表 20:47 行) -->
<!-- 文件末尾修改时间:2026-09-15 23:24(环境推导剔除本工作区 + 静态安装路径模板 + 构建结构变化重算,详见上表 23:24 行) -->
<!-- 文件末尾修改时间:2026-09-16 00:21(安装布局感知:读 .colcon_install_layout 内容 → isolated/merged 分别出条目,详见上表 00:21 行) -->
<!-- 文件末尾修改时间:2026-09-16 00:32(安装侧改纯静态、拆掉存在性检测,详见上表 00:32 行) -->
<!-- 文件末尾修改时间:2026-09-16 00:37(sys 组末尾补一条前缀 include 根,详见上表 00:37 行) -->
<!-- 文件末尾修改时间:2026-09-16 00:59(修复构建后不自动重算 + 孤儿注释清理,详见上表 00:59 行) -->
<!-- 文件末尾修改时间:2026-09-16 01:04(监听面收窄:只监听 .colcon_install_layout,setup.bash 归环境域,详见上表 01:04 行) -->
<!-- 文件末尾修改时间:2026-09-16 01:08(监听锚点搬到工作区根:install 目录条目 + 标记文件双 watcher,详见上表 01:08 行) -->
<!-- 文件末尾修改时间:2026-09-16 01:12(监听实现收编为 gen/install-layout-watch.ts,ext 只组装,详见上表 01:12 行) -->
<!-- 文件末尾修改时间:2026-09-16 01:23(加兜底轮询 pollIntervalMs=60s;watcher 通道受 watcherExclude 反转影响不可靠,详见上表 01:23 行) -->
<!-- 文件末尾修改时间:2026-09-16 01:30(目录 watcher 改工作区根条目松匹配 *:修"注册时 install/ 已存在→删了再建不报",详见上表 01:30 行) -->
<!-- 文件末尾修改时间:2026-09-16 02:41(监听改造收口(方案 2)+ 勘误 + 文档同步,详见上表 02:41 行) -->
