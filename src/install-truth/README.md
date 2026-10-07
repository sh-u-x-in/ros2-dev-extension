# install-truth/ — 两源真值域(build 记录 · install 观察)

> **立论已于 2026-09-21 修订**:旧版「唯一输入 `build/`」的裁切**已破产**(见 §1)。
> 破产的不是 `build/` 这个源,而是「**唯一**」这个限定 —— `install/` 里有一整层
> `build/` **结构性无法产生**的内容,不是"会陈旧"可以修补的问题。
>
> **定位**:回答"这个工作区**装出来了什么、能跑什么、源在哪**"。
> **两源**:`build/`(全部是**记录**:构建产物 / 安装规则 / egg-info / 清单)
> 与 `install/`(全部是**观察**:现状 / 形态 / 实际内容)。
>
> **最高原则:只反映真实,不反映意图。**
> `src/` **不作为来源** —— 它是意图域(`package.xml` / `setup.py` / 声明 / 待测源码),本域不主动去"查"它(见 §2.2)。
> 但**经软链被纳入 `build/` 或 `install/` 的内容,就是这两者的一部分,必须照读** ——
> 归属由「**访问路径**」决定,不由「软链解析后的真实位置」决定。
> 判据一律是"**记录说了什么** + **现在实际是什么**",绝不是"**声明应该是什么**"。
>
> **真实优先于好看**:该"扩大"就如实返回扩大(如 develop 模式下 `import` 区含未声明文件),
> 不用声明去过滤、不用意图去纠正、不写"理论上应该有/没有"。
> **truth 层只给全集 + 标记;过滤与展示是消费方的事。**
>
> **与 main 插件 core 的关系是并列**:core 跟 src 域(package.xml/构建配置),
> 本域跨 build 域(编译产物)与 install 域(装配结果),两者天然不同步
> → 独立数据源、独立失效源、独立就绪契约。

## 1. 立论修订:为什么「唯一输入 build/」破产

### 1.1 旧立论与其战绩(不作废)

2026-09-13 依 `discover/buildonly-四象限报告.md`(1222 个叶子字段中 **1080 固有 / 142 记录型差异**)裁定
**唯一输入 `build/`**。当时的唯一需求是「**可执行文件跳转**」,而 targets(`link.txt`+objects+sources)/
egg-info / 安装规则**全在"固有"侧** → 裁切成立,并有**四象限不变式**与**名单对拍**两份验证兜底。

**这次裁切没有判错。** 它的有效期取决于需求边界;是需求从"有哪些可执行"扩到「**包里有什么** +
**运行期路径映射** + **测试发现**」以后,把边界撑破了。

### 1.2 撑破边界的三种结构(2026-09-21 于 VM `roa2_ws` 实测)

| # | 结构 | 为什么 `build/` 拿不到 | 实测证据 |
|:--|:--|:--|:--|
| ① | **装配层(workspace-level)** | `build/<pkg>` 是 per-package 产物,而装配结构是**工作区级**的,任何单个包目录都装不下 | `install/setup.{bash,sh,zsh,ps1}`、`install/local_setup.*`、`install/_local_setup_util_{sh,ps1}.py`、`install/.colcon_install_layout`、`share/colcon-core/packages/<pkg>`、`share/ament_index/resource_index/*/<pkg>` |
| ② | **安装形态** | 形态是 install 侧事实,`build/` 只能靠时间戳间接猜 | `lib/python3.10/site-packages/<pkg>.egg-link` 是 **develop 模式的唯一权威标志**;本工作区**无** egg-link → 实体拷贝(且 `data/hello.txt` inode 与 src 不同、`links=1`) |
| ③ | **运行期实际内容** | 清单/声明回答不了"此刻能 import 什么" | `ament_python × develop` 下 `build/<pkg>/<pkg> -> src/<pkg>/<pkg>` 是**目录软链**,`site-packages` 根直通整个源码目录 → `exclude_package_data` **失效**,被排除的 `data/secret.txt` 会"扩大"出现 |

**③ 的语义是"真实",不是"缺陷"**:扩大发生了,它就是**事实**。本域必须**如实返回扩大后的集合**,
既不能隐藏,也不能标成"理论上应该有/没有" —— 后者是拿意图去覆盖真实,正是本域要避免的。
(对应到真实工作区:实体安装下 `install/iii/.../iii/data/` **确实没有** `secret.txt`;
develop 安装下 **确实会有**。两种都照实报,只有"实测是哪一种"这一个问题需要回答,即 §4.3 的形态判据。)

**根因一句话**:

> `build/` 记录的是「**每个包各自产出了什么**」;`install/` 记录的是「**这些产物如何被装配成一个可 source 的工作区**」。
> 前者是 per-package,后者是 workspace-level —— 后者**没有任何一个 `build/<pkg>` 装得下**。

这是**结构性问题**,不是时效问题,不可修补。

**附带收获**:读 `install/` 后 `.colcon_install_layout`(isolated/merged)变为可观测,
补上了旧版"四象限"里 **merged 象限从未实测**的空缺(本工作区 = `isolated`)。

**命名注**:目录名 `install-truth` 反而因此名实相符 —— "build-only"是它的一段偏差期。

## 2. 两源分工(取代「唯一输入 build/」)

| 源 | 类别 | 角色 | 提供 | 明确不提供 |
|:--|:--|:--|:--|:--|
| `build/` | **记录** | 候选 + 结构 + 源 | 包与 traits、目标与构成源、头与链接库、`entry_points`、安装规则(源→目标)、CTest 注册、编译期源路径(`.o.d`)、`install.log` 与两份清单(**上一次安装的记录**) | 装配结构、安装形态、运行期实际内容 |
| `install/` | **观察** | 事实裁决 | 形态(`egg-link` / 软链目标)、落点存在性、实际内容集合、装配结构、布局(iso/merged) | **不生成候选** —— 它不知道"源在哪" |
| `src/` | **意图** | **不作为来源(见 §2.2)** | — | 不主动去读:声明 / `package_data` / 测试定义属意图域。**例外**:经 `build/`/`install/` 软链纳入的部分是那两者的一部分,**照读** |

两源**都是真实**:`build/` 是**"过去发生过什么"的记录**,`install/` 是**"现在实际是什么"的观察**。
`Agreement` 表达的是这两者之间的关系,**不是"声明 vs 事实"**。

### 2.1 调用纪律(硬约束)

1. **`install/` 只在「状态类结论」上被查询**;候选一律由 `build/` 生成。
   这是与旧版(install 为中心的 19 用例版)**最本质的区别** —— 旧版把 install 当**主源**,
   于是形态检测 / egg-info 双落点 / 候选 X_OK 扫描 / readlink 跳源链全部建在 install 上,四象限不同解。
   本版 install 只是**裁决器**:不生成候选,只回答"这一条结论此刻成不成立、实际指向哪里"。
2. **五件不拉回来的事**:① install 当候选生成器;② X_OK 扫描当名单来源;
   ③ egg-info 双落点试错(build 侧单落点已实测);④ 沿 readlink 链跳源(readlink 只用于"判生成物"与"显示真实位置");
   ⑤ install 目录遍历当主数据源(会让"未安装/系统包/生成物"的判定失去依据)。
3. **truth 层只给全集 + 标记,过滤下沉到消费方**。不因"看起来乱"而抹掉任何真实项:
   `installed=false` 的条目**保留**(它们本身就是"编译了但没装"这一事实);
   生成物**保留但打 `generated` 标记**(不删);扩大出来的文件**原样返回**。
   因此 `collectJumps` 的 `includeUninstalled` 选项应当**取消** —— 那属于展示层策略。
4. **结论必须带对账状态**:

```ts
type Agreement =
    | "confirmed"   // build 记录 + install 观察一致
    | "derived"     // 只有 build 记录,未核对(且不得靠 src 验证来升级)
    | "conflict"    // 记录与观察不一致 → 必须暴露,不得静默取一
    | "unavailable";// 源缺失
```

`conflict` 是当前模型**完全缺失**的状态,而"残留 `install.log` + 实际直通安装"正是它的典型实例。
特别注意:`derived` **不得**通过"去 `src/` 确认一下"来升级 —— 那是把意图域拉进来;要升级只能靠 install 侧观察。

### 2.2 域包含性:`src/` 何时可读、何时不可读(硬约束,且可测试)

先纠正一句过强的话:**`src/` 不是"完全不可读"**。

判据不是"路径字符串里有没有 `src`",而是「**这次访问是从哪儿出发的**」:

> **归属由「访问路径」决定,不由「软链解析后的真实位置」决定。**
>
> - 访问路径在 `build/` 或 `install/` **之下** → **允许**,即使软链把它带到 `src/`、甚至 `/opt/ros`;
> - 访问路径**直接**是 `<ws>/src/**`(或其它域外绝对路径)→ **禁止**。

**为什么必须允许第一种**:软链一旦存在,`src/<pkg>/<pkg>` 就**已经成为 `build/<pkg>/<pkg>` 的一部分**
(实测:`build/iii/iii -> src/iii/iii`)。此时读 `build/iii/iii/jjj.py` 是在读 **build 的内容**,不是"查意图"。
不读它,build 的真相就是**残缺的**。

**而且这正是"扩大"的机制本身**:§1.2 ③ 里 develop 模式之所以会把 `data/secret.txt` 带进来,
**就是因为** `build/<pkg>/<pkg>` 这条软链把整个源码目录纳入了 `sys.path` 根。
所以 —— **要如实反映扩大,就必须读这条软链**;禁止它,本域就报告不了自己应当报告的那个事实。

**反过来,禁止的是「越域取证」**:拿着记录里的绝对路径**直接**去 stat `src/`。
两类访问在文件系统上可能命中同一个 inode,但**语义完全不同**:前者是"build 里有什么",后者是"源码目录里有什么"。

`install/` 侧同理,而且有一个更直观的例证:
`install/p10_mix_deps_std/share/p10_mix_deps_std/environment/ament_prefix_path.sh -> /opt/ros/humble/share/ament_cmake_core/…`
—— 访问路径在 `install/` 下,就该读;它是 `install/<pkg>` 的真实组成部分。

**唯一的字面例外**:`<ws>/src` 作为**落点前缀**(调试跳转要拼出 `src/<pkg>/…` 这个字符串)。
**允许拼字符串,不允许访问**,连"它存不存在"也不该问(按约定拼即可)。

**现状(2026-09-21 核查并**已清理**;当时越域违规共 3 处)**:

| # | 位置 | 原行为 | 处置(✅ 已落地) |
|:--|:--|:--|:--|
| 1 | `scan/build-root.ts` | `isDir(<ws>/src)` 推导 `srcRoot` | ✅ 去掉探测;`srcRoot` 改为**必定存在**的约定值 `pjoin(workspaceRoot, "src")` |
| 2 | `scan/jumps.ts` `consoleJump` | 对 `src/<pkg>/…` 候选逐个 `isFile` 确认 | ✅ 去掉确认;一律给推导首选并标 `derived`(`tier` 由 `L` 降为 `C`) |
| 3 | `scan/targets.ts` | 对 `compilePaths`(记录里的 src 绝对路径)逐个 `exists`,算 `compilePathsExistLocally` | ✅ **字段已删除**;`compilePaths` 只作记录原样给出 |

**第 3 条的裁定依据(用户 2026-09-21)**:

> 我们提供的是**真实情景**;所指向的文件**不存在、位置移动、重命名**,这些**不归我们管**。
> 我们需要的是在 `build/`、`install/` 当中**解算出内容,呈现出来**。

即:本域的职责边界就是**这两棵树**;凡"指向域外的引用",其**存在性一律不判**。
`compilePathsExistLocally` 声称的是域外(src / 异机构建)事实 → **删除**。
"本机可访问性"作为**调试侧要的判据**,由消费方在自己机器上自查(它本来就在本机跑,那属于它自己的域)。

**另有 2 处曾被本文件上一版误判为违规,现已澄清为合法**(记录在此,避免以后又被"顺手改掉"):

| 位置 | 行为 | 判定 |
|:--|:--|:--|
| `scan/jumps.ts` `devModuleCandidates` | 在 `build/<pkg>/` 下找模块文件,经软链可达 src | ✅ **合法** —— 访问路径在 build 下;它观察的正是"直通模式下 build 里有什么" |
| `shared/fs/primitives.ts` `walkFiles` | 用 `stat`(跟随软链)遍历 `build/<pkg>`,会穿进 `build/<pkg>/<pkg>` | ✅ **合法** —— 遍历 build 的内容本就该跟随它自己的软链;仍需 `maxDepth` 防环(已有,默认 24)与规模控制 |

守卫夹具已随本次改动落地:`shared/fs/primitives.ts` 的 **`guardDomain(inner, roots)`**
(只放行**访问路径**以给定根开头的调用),由 `api.ts` 导出,并在 §9 的单测里作为不变式三使用。

### 2.3 四区的**覆盖边界**(口径,不是漏)

四区只覆盖下列落点形状:`lib/<pkg>/**` + `lib/` 根扁平文件 + `bin/`(软链感知)、
`lib/python3.x/{site,dist}-packages/<pkg>/**`、`share/<pkg>/**`、`include/<pkg>/**`。
以下**不进**四区(它们既不属于"能跑什么"也不属于"用户资源"):

- `lib/cmake/**`(CMake 包导出)、`share/ament_index/**`、`share/colcon-core/**`
- 工作区级的装配层(`install/setup.*`、`local_setup.*`、`_local_setup_util_*.py`)—— 见 §1.2 ①

需要时应新增**第五区**(如 `other`),而不是把它们塞进现有四区。

## 3. 三条不变式

| # | 名称 | 内容 | 作用域 |
|:--|:--|:--|:--|
| 一 | **install 无关性(四象限不变式)** | 同一 build 夹具配四种 install 布局(含完全无 install)→ 跳转表**逐字节相同** | **仅固有结论**:目标 / 构成源 / egg-info / 安装规则 / CTest 注册。**限定作用域,不撤销** |
| 二 | **两源一致性(陈旧残留不变式)** | 人为放入陈旧残留(旧 `install.log`、旧 `symlink_install_manifest.txt`、残留的 `build/<pkg>/<pkg>` 软链、`egg-info/not-zip-safe`)→ 结论**不得**把它们当成当前事实;记录与观察不一致必须产出 `conflict`,不得静默取值 | **状态结论** |
| 三 | **域包含性(意图隔离不变式)** | 注入一个只放行「**访问路径**以 `buildRoot` 或 `installRoot` 开头」的 `FsLike`,其余一律失败 → 本域全部功能(候选 / 清单 / 裁决 / 索引)**必须照常工作**,且 `build/<pkg>/<pkg> -> src/<pkg>/<pkg>` 这类**软链仍可正常穿越** | **全域** |

不变式二的意义:旧版所有契约(单飞、双缓冲、内容指纹、逐包容错)**都不覆盖**这一类威胁,
而用户的工作区**天然长这样**。

不变式三的意义:它是"**只反映真实、不反映意图**"这条最高原则的**可执行形式**。
关键在「按**访问路径**(字符串)判定,而不是按解析后的真实位置判定」——
`FsLike` 的入参本身就是访问路径字符串,守卫做在**字符串层**即可,精确、零成本、无平台差异:

```ts
// 域包含性守卫:只看访问字符串,不看 readlink 结果
const inDomain = (p: string) =>
    p === buildRoot || p.startsWith(buildRoot + "/") ||
    p === installRoot || p.startsWith(installRoot + "/");
```

夹具一注入:§2.2 的 **3 处越域访问立刻报错**,而那 **2 处软链穿越照常通过** —— 一次同时验证两侧。
这正是它比"一律禁止 `src/`"更有价值的地方:后者会同时砍掉合法用法,把"如实反映扩大"的能力一起关掉。

> 2026-09-14 的旧注仍然有效:`installPaths`/`buildPath`/`pythonInstall` 是**路径信息**(不是"源在哪"),
> 会随安装布局/形态变化;不变式一断言的是 targets/sources/egg-info/安装规则那部分。

> ⚠️ 不变式三还牵出一个连带结论:**`tier` / `verified` 里凡是靠"去 src 确认"得来的一律要下调**。
> 例如 `consoleJump` 现在的 `confirmed → tier=L` 是"摸 src 换来的高置信度",按新原则必须回到 `derived`。
> 宁可置信度低,不可越域取证。

## 4. 威胁类别:陈旧残留

`build/` 与 `install/` 都是**惰性清除**的 —— 上一次不同形态构建的产物会留在原地。
**"文件存在"不等于"当前有效"。**(实测:`build/iii/iii` 软链停在 9月16,`install.log` 是 9月21,
两者并存于同一目录。)

| 文件 | 谁写 | 模式相关 | 残留风险 |
|:--|:--|:--|:--|
| `egg-info/{PKG-INFO,SOURCES.txt,entry_points.txt,top_level.txt,dependency_links.txt}` | **每次构建** | 无关 | 低 ✅ 可作基线 |
| `egg-info/not-zip-safe` | **惰性写** | 无关 | **有**(实测停在 2026-09-16) |
| `install.log` | **仅实体安装** | **强相关** | **高**(develop 模式下必陈旧) |
| `build/<pkg>/<pkg>` 目录软链 | **仅 develop** | 强相关 | 高(实体模式下必残留) |
| `build/<pkg>/build/lib/` | **仅实体** | 强相关 | 高 |
| `prefix_override/sitecustomize.py` | 每次构建 | 无关 | 低 |
| `colcon_build.rc` | 每次构建 | 无关 | 低 ✅ 可作时刻基线 |
| install 侧 `.py` / 资源拷贝 | mtime-aware copy | — | **旧但正确**(未重装 ≠ 装错) |

### 4.1 新鲜度基线(build-only 可行)

```
基线 = mtime(build/<pkg>/colcon_build.rc)
     ∩ mtime(build/<pkg>/<pkg>.egg-info/SOURCES.txt)   ← 每次构建必写,且带内容语义
逐文件判定: mtime(f) >= 基线 ⇒ 本次构建产物;否则 ⇒ 残留,不采信 + 记 warning
```

**判据必须逐文件,不能整目录** —— 实测反例:`egg_info` 每次构建重写 5 个文件,
但 `not-zip-safe` 停在 9月16,**同一个目录里混着新鲜与陈旧**。

**明确不能用的两个 mtime**:

- **目录 mtime** —— 反例:`build/iii/prefix_override/` 目录是 9月16,里面的 `sitecustomize.py` 每次构建都重写。
  (这个坑本项目自己踩过一次:曾据此误判它为"symlink 构造残留"。)
- **install 侧 mtime** —— distutils 拷贝**保留源文件时间**,`install/iii/.../data/hello.txt` 的 mtime 等于 `src` 的 mtime,
  反映的是**源的时刻**,不是安装时刻。想判"这次装过没有",只能看那批**无条件重写**的文件
  (`share/<pkg>/hook/*`、`package.*`、`lib/<pkg>/<name>` 入口壳、install 侧 egg-info)。

### 4.2 mtime 与 hash 正交,不得混用

| 问题 | 手段 |
|:--|:--|
| 这次构建**跑过它**吗 | `mtime`(实测:5 个 egg-info 文件 mtime 变、内容 hash 全不变) |
| 内容**变了吗** | 内容 hash(现有 `fingerprintOfSnapshot` 的做法正确) |

### 4.3 一个 build-only 可行的形态判据(待 develop 模式实测复核)

| 观察 | 结论 |
|:--|:--|
| `install.log` **新鲜**(≥ 基线) | 本次构建走过 `install --record` ⇒ **实体** |
| `install.log` **陈旧或不存在**,而 `egg-info` 新鲜 | 本次构建没走实体 install ⇒ **develop / link-through** |

依据:`setup.py egg_info` 在两种模式的命令里**都出现**(9月16 与 9月21 实测),
而 `--record` **只在实体模式**出现。

## 5. 分层结构(依赖单向向下,禁止反向 import)

> 下表是**当前代码**的实际形态(仍为 build-only 实现);两源改造项见 §11。

```
install-truth/
├── api.ts                     门面:唯一对外出口(类型 + 工厂 + 便捷函数)
├── README.md                  本文件(域级总览)
├── center/                    第 2 层 · 有状态:数据中心
│   ├── README.md
│   ├── build-map-center.ts    单飞合并 / 双缓冲原子替换 / 内容指纹(全局 + 逐包)/ null 就绪契约 / 逐包容错
│   │                          / 构建信号 rc-mtime 增量门 / onPackagesChanged 包级差分(2026-09-30 构建事件化)
│   ├── query.ts               消费方数据结构(扁平索引 + 裁决 + ExecutableResolver + 侧边栏行模型 rowsOf/sidebarView)
│   └── shared-center.ts       按工作区根共享的中心单例(2026-09-24;2026-09-30 去 watcher 化 —— 失效源改为环境域构建信号)
├── scan/                      第 1 层 · 纯解析(无状态:fs + 路径 → 结论对象)
│   ├── README.md
│   ├── build-root.ts          build 根定位(+ src 根推导,只作落点前缀)
│   ├── packages.ts            build 域包发现 + traits(构建类型不写死)
│   ├── targets.ts             link.txt + *.o.d → 目标/输出名/构成源/头/链接库
│   ├── python-meta.ts         <pkg>.egg-info → entry_points / SOURCES(单落点)
│   ├── install-rules.ts       cmake_install / symlink_install → 脚本入口的源→目标
│   ├── manifests.ts           install_manifest ∪ symlink_install_manifest ∪ install.log → 安装落点(含陈旧守卫)
│   ├── installed.ts           **install 侧观察 → 三区(lib/import/share)+ include**;与记录对账
│   └── jumps.ts               三类来源合成"命令名 → 源码"
└── shared/                    第 0 层 · 基础设施(无业务语义)
    ├── README.md
    ├── paths.ts               极简 posix 路径工具
    ├── models.ts              BuildPackage / BuildTarget / JumpEntry / BuildMapSnapshot
    └── fs/primitives.ts       注入式 fs:FsLike(stat/readdir/readText)+ nodeFsLike + MemoryFs + walkFiles
```

| 层 | 目录 | 状态 | 一句话职责 |
|:--|:--|:--|:--|
| 第 0 层 | `shared/` | 无状态 | 路径 / 模型 / 注入式文件访问(不得 import 上层) |
| 第 1 层 | `scan/` | 无状态 | 给定 fs + 路径 → 结论对象;可反复调用、结果一致、不发事件 |
| 第 2 层 | `center/` | **有状态** | 快照 + 就绪/变化/失效三种生命周期能力 |
| 门面 | `api.ts` | — | 唯一对外出口(消费方只 import 这里) |

## 6. 三类跳转来源(取自 build/,四象限固有)

| # | 来源 | 产出 | 跳转类型 | 坐标系 |
|:--|:--|:--|:--|:--|
| ① | `CMakeFiles/<target>.dir/link.txt` + `*.o.d` | 输出名(`-o`)、构成源(.cpp 绝对路径)、生成源计数、头计数、链接库 | `cpp` | 固有 + **编译期源路径**(供调试侧推 `sourceFileMap`) |
| ② | `<pkg>.egg-info/entry_points.txt` + `SOURCES.txt` | 命令名 = 模块:属性 → 源(按 SOURCES 推导) | `console_script` | 固有(egg-info 在 build 侧单落点) |
| ③ | `cmake_install.cmake` / `ament_cmake_symlink_install.cmake` 的 `FILES`/`PROGRAMS` 规则(落点 `lib/<pkg>`、`bin/`) | 脚本源(规则内绝对路径) | `script` | 固有(规则本身)+ 落点由 install 裁决 |

同名冲突优先级 `cpp > console_script > script`,并记 warning;未解析不隐藏(带中性原因 + 条件分级 `C`)。
库目标(.so)不入可执行跳转表。

**注意 `SOURCES.txt` 的口径**:它是 setuptools 对源树的**投影记录**(sdist 口径),
既不是"装出去的东西"也不是"import 面" —— 实测它含 6 个 `test/*.py`(未装进 site-packages)、
含 `launch/__pycache__/*.pyc`、含 `config/`/`urdf/`。

因此它的**合法用途只有两个**:① §4 的新鲜度基线(取 mtime);② 推导模块名对应的源落点(**标 `derived`**)。
**不得**用它回答"`import` 区里有什么",更不得用它过滤实际内容 —— 那正是"用记录冒充事实"。
`import` 区的唯一口径是 install 侧的实际内容(§1.2 ③)。

## 7. 对外契约(门面)

```ts
const center = createBuildMapCenter({ workspaceRoot });   // 默认注入真实 fs
center.getState();                    // null = 未就绪;快照 = 已就绪(空包表也可区分)
center.onDidChange(ev => ...);        // 首次就绪 + 内容指纹变化才发
await center.refresh("manual");       // 单飞 + 合并:进行中再来 → 标脏,链尾补刷一次
center.invalidate("build 变化");      // 只标脏(失效源:构建信号主动 refresh / 手动刷新;watcher 已退役)
center.refreshAfterBuildSignal();     // 构建信号入口(2026-09-30):幂等;就绪后走 rc-mtime 增量门
center.onPackagesChanged(names => …); // 包级差分(增/改/删非空才发;取代旧 onBuildTouch)
center.jumpsOf(pkg); center.find(pkg, name); center.packageNames(); center.package(name);
center.getLastError();                // 构建失败保留上次好快照 + 记原因
```

**按路径反查(P0-1/2/3,2026-09-14 起;调试侧运行期入口)**:

```ts
const resolver = new ExecutableResolver(center);
await resolver.resolveByPath("/ws/install/demo/lib/demo/talker");
//   → { status:"ok", pkg:"demo", name:"talker", entry }        ← 路径 → 包名/可执行名
//   → status:"path-unknown"  该路径不属于本工作区已安装目标(系统包/临时脚本/包装器;正常结论)
//   → null                   数据中心未就绪(与 path-unknown 严格区分)
normalizeInstallKey(p);          // 归一化键(反斜杠/折叠/尾斜杠/Windows 盘符小写)
lookupByPath(index, p);          // 纯函数版(索引已有,不需要 center)
// 条目上新增的路径信息:
//   installPaths / installPath(入口)/ buildPath(link.txt 的 -o,供 symlink 解析后路径命中)
//   pythonInstall { scriptPath, sitePackagesDir, moduleFile, devDir, devModuleFile, verified }
//   compilePaths                     ← P0-3:编译期路径记录(DWARF 里的字符串;**不判域外存在性**)
```

**接线层职责(2026-09-30 定稿,构建事件化)**:失效源 = 环境域构建信号
(`environmentFacade.onBuildSignal` → extension.ts → `refreshAfterBuildSignal()`,rc-mtime 增量门)
+ 手动刷新(权威全量)+ 换根(重建);`install/**` watcher 不再做(设计废止,见 §11 第 5 项);
详情见 `手工重设计/13-build事件驱动中心刷新-设计方案.md`。

**三区查询(最小门面,2026-09-21)** —— 与上面同风格:未就绪 → `null`,**空区 → `[]`**(≠ null):

```ts
resolver.areasSnapshot();                       // 同步只读;侧边栏用它 + onDidChange
                                                // (别每展开一个节点都 await ensureFresh —— 会反复全量重扫)
await resolver.areasOf(pkg);                    // 单包四区(包不存在 → null)
await resolver.filesOf(pkg, "import");          // 某一区(该区为空 → [])
await resolver.installedPackages();             // 已装出来的包名
await resolver.findInstalledFile(installPath);  // 落点 → 条目(键经 normalizeInstallKey,吸收写法变体)
```
过滤(隐藏生成物 / 隐藏库 / 只取 `.py`)一律**下沉到消费方** —— truth 层只给全集 + 标记(§2.1 第 3 条)。

### 7.1 侧边栏视图(2026-09-21;按 `手工重设计/侧边栏提案.md` 的三区骨架对账)

一行即可渲染 —— `rowsOf` 是纯函数,门面是它的现成包装:

```ts
const rows = rowsOf(pkgAreas, jumps);   // 纯函数(不需要 center)
resolver.sidebarSnapshot();             // 同步:全部包 → [{ pkg, prefix, layout, rows }]
await resolver.sidebarView();           // 异步(先 ensureFresh)
await resolver.packageView(pkg);        // 单包
```

`SidebarRow` 给到"渲染一行所需的**全部事实与标记**":
`name` / `status`(四档 `installed`·`missing`·`generated`·`source-unresolved`)/
`source`(lib 区自动带 `:main`,如 `…/helper.py:main`)/ `sourceEvidence` /
`library` / `generated` / `link`+`linkDomain`+`viaLinkDomain`+`dangling` / `executable` / `installPath`。
**数组顺序 = 稳定区序 `lib → import → share → include`,同区内按名字** —— 可直接照渲染。

**完整性对账(真机 `roa2_ws` 上把提案那两棵树画出来)**:

| 提案要显示 | 本域给什么 | 真机结果 |
|:--|:--|:--|
| `iii.lib` 三入口带 `:main` | `area==="lib"` + `entryAttr` | `helper/other/sss → src/iii/iii/{sub/helper,other,sss}.py:main` ✅ |
| `iii.import` 包内文件树 | `area==="import"`(`__pycache__` 靠 `generated` 标记) | 10 行(asset / data / py.typed / sub/…),**无 `secret.txt`**(实体安装,正合"理论上没有") ✅ |
| `iii.share` 用户资源 | `area==="share"` | 13 行(含提案手绘时**漏掉**的 `launch/sss.launch.py`) ✅ |
| `p10` 三区 + include | 四区 | lib 2 / import 2 / share 33 / include 3,源箭头全部正确 ✅ |

> 结论:**提案里画得出来的,本域现在都给得全**;唯一多出来的一列是"形态"(`linkDomain` / `viaLinkDomain`),
> 那是 hover 判断"改源码要不要重装"的依据。

## 8. 未移植(留在 Python 原型当路线图)

`discover/buildonly/scan.py` 还抽取了:env_hooks(.dsv 预演)、cache(CMakeCache 关键项)、commands
(实际构建命令/参数)、tests(pytest/CTest 摘要)、ament_index(标记/运行依赖/rosidl 清单)、manifests
(安装清单 + 布局线索)。其中 **env_hooks / ament_index / 安装清单**三项现在**因 §1.2 ① 而重新变得相关**
(它们正是"装配层"的原料),按需按同款分层补 `scan/` 模块即可。

## 9. 测试

```bash
npx tsc -p .                      # 类型检查 + 编译(仓库根;rootDir="." → out/)
node test/run-buildmap-tests.js   # 无头单测(65 用例,MemoryFs 注入)
```

**不变式一**由既有的"四象限不变式"用例覆盖(同一 build 夹具配四种 install 布局 → 跳转表逐字节相同)。
**不变式三(域包含性)已落地**:文末 `describe("域包含性…")` 4 条用例 ——
注入 `guardDomain(..., [BUILD])` 后快照构建照常成功、`console_script` 不再越域确认、
守卫确实拦得住、并验证"同一内容经 `build/` 到达放行、直接 `src/` 路径拒绝"。

**三区解算已落地(13 条用例)**:`describe("安装内容解算:三区…")` 覆盖 ——
四区按落点形状归档(且 `__pycache__` 照实列出)、`confirmed` / `observed`(扩大)/ `manifest-only` 三档对账、
`generated`/`library` 只是标记不过滤、`dist-packages` 也归 import 区、
源落点由记录拼出(不访问 `src/`)、陈旧 `install.log` 被守卫丢弃并记 warning、指纹随安装内容变化、
`lib/` 根下的库、merged 扁平落点归属、以及 **甲-1 的形态四条**(软链穿越 / 悬空链可见 / 权限看目标 / `linkDomain` 三档)。

**真实工作区探针(VM;共享盘直通,零同步)**:

```bash
cd /mnt/hgfs/ros2share/rde-ros-2       # = Windows 侧同一检出(vmhgfs-fuse)
node test/run-buildmap-areas-live.js /home/ros2/roa2_ws
```
最近一次结果:`13 包 / 540 文件`;四区 `lib=35 import=69 share=368 include=68`;
对账 `confirmed=398 observed=142 manifest-only=0`;源落点 `install-rule=383 / python-rootmap=70 / jump-record=20 / 无源=67`;
**形态 `link=228 dangling=0 executable=25`,`linkDomain build=196 / outside=16 / src=16`,`viaLinkDomain` 空**(本工作区是实体安装,无目录直通);
`RESULT=OK`(归档自洽 0 越界)。

**待补:不变式二(陈旧残留)** —— 夹具现成(当前 `build/iii` 的形态就是:9月16 的软链残留 +
9月20 的 install 文件 + 本次重建的 egg-info),见 §11 第 9 项。

**待补:不变式三(域包含性)** —— 夹具极简:一层 `FsLike` 包装,只放行访问路径以 build/install 根开头的调用。
它一上就会**立刻抓到 §2.2 的 3 处越域访问**,同时**保证那 2 处软链穿越仍然工作** ——
所以应当**先于**两源改造落地(见 §11 第 10 项)。

**真实工作区实测(VM;build/ 在 VM 本地盘)**:

```bash
node test/run-buildmap-live.js     /home/ros2/roa2_ws   # 跳转表冒烟
node test/run-buildmap-p0-live.js  /home/ros2/roa2_ws   # P0 专项:按路径反查自洽性 + 落点存在性
```
P0 探针最近一次结果(roa2_ws / Humble / **isolated**、且实际为**实体安装**):13 包 15 条目、
`byInstallPath` 56 键、`installPaths` 15/15、`pythonInstall` 7 条(清单核对 2 / 推导未核对 5)、
`compilePaths` 8 条(本机齐 8)、**主落点存在 15/0 缺失、自洽性 0 失败、系统路径 → `path-unknown`**、`RESULT=OK`。

> ⚠️ 该结果里"symlink+isolated"是**旧描述**;2026-09-21 实测证明本工作区是**混合状态**
> (9月16 一次 `--symlink-install` 构建 → CMake 包保留逐文件软链;9月20/9月21 切换为实体
> → `ament_python` 三包变为实体拷贝),故改为"isolated + 实体(ament_python) / 逐文件软链(ament_cmake)"。

## 10. 消费方(侧边栏已接**简易版**;其余未接线)

**侧边栏接线位置**:`src/sidebar/`(本域**零 vscode**,适配层放在域外)——
`install-truth-tree.ts`(纯树模型:包 → 区 → **目录树** → 行;可无头单测)、`install-truth-sidebar.ts`(薄适配层:
建中心 → `TreeDataProvider` → 一个刷新命令 + 点击跳转)。视图 ID `ros2.installTruth`,容器 ID `ros2-packages`
(活动栏图标 `media/ros2-packages.svg` —— **必须是 SVG**,PNG 不渲染、容器直接不出现)。
**区内按 `/` 折成目录树**(2026-09-21 修:此前是平铺,33 行糊成一片;现在与提案手绘同形,
排序 = **纯字母序、目录与文件混排**,想改成"目录优先"只改 `foldRowsToTree` 里那一个比较函数)。
**工作区是惰性绑定的**:`launch.json` 的 `Extension` 配置只传 `--extensionDevelopmentPath`、不带文件夹,
故宿主起来时 `workspaceFolders` 为空 —— 提供器**仍无条件注册**,首次展开时才解析工作区并绑定中心
(`onDidChangeWorkspaceFolders` 时重绑),所以**起来之后再打开 ROS 工作区也能接上**,不需要重载窗口。
无工作区时根节点显示"未打开工作区";`locateBuildRoot` 失败时显示"解算失败 + 原因"(不崩)。
**点击跳转(2026-09-21)**:文件行挂 `TreeItem.command` → `ROS2.sidebar.openSource`(只作行命令,不进命令面板 —— 它需要参数)。
⚠️ **展示串带 `:main`,不能直接当路径**:故 `SidebarRow` / `TreeNode` 同时给两个字段 ——
`source`(展示用,如 `…/helper.py:main`)与 **`sourcePath`(纯路径,机器用/点击跳转)**。
源文件不存在时(可能被移动/改名)给一句看得懂的话 + 「复制路径 / 打开所在目录」,而不是甩通用错误;
**检查存在性是编辑器侧的事**(本域不判域外存在性,§2.2),这只是"打不开时怎么解释"。

**预览标签(2026-09-21 修;用户实测反馈)**:单击走 **`{ preview: true, preserveFocus: true }`** ——
预览标签会被下一个**复用**(点 N 个只留 1 个),且**焦点留在树上**,可以连着往下点(这才是"快速浏览")。
⚠️ 上一版写的是 `preview: false`(= 钉住新标签),点 5 个攒 5 个 —— **那是 bug**。
预览与焦点是**两个独立选项**:`preview` 管标签复用、`preserveFocus` 管焦点,二者无依赖关系。
已知边界:用户关掉 `workbench.editor.enablePreview` 后 VS Code **会忽略** `preview: true`
([vscode#149088](https://github.com/microsoft/vscode/issues/149088),设计如此),那时标签仍会累积。
**不提供"固定打开"**:钉住是 VS Code 的既有机制 —— **双击标签**即固定,或**改动文件内容**时自动把预览转固定;
2026-09-21 用户裁定撤掉该右键项("这些都是自动执行的,你添加一个选项反而更多")。

> 开发流程:`Extension` 配置的 `preLaunchTask` = `dev-build`(`tsc -p ./` → `out/`,`webpack --mode development` → `dist/`),
> 故 **F5 会自动带上新代码**;`package.json` 的 `main` 指向 `dist/extension`,手动跑只需 `npm run dev-build`。

**视图门槛(2026-09-21;用户问"非 ROS 工作区会不会注册")**:`views[].when = "ros2.hasPackageXml"`
⇒ **非 ROS 工作区不显示**这个视图(该 key 由 package-core 驱动,见 `extension.ts::syncHasPackageXmlContext`)。
不加门槛时:贡献是静态的 ⇒ 图标照样出现,点开只会得到「解算失败:未找到 build/(build-only 需要构建产物)」= 纯噪音。

> ⚠️ 为什么不担心"鸡生蛋"(视图被 `when` 藏住 → 不触发 `onView` → 扩展不激活 → key 永不设置 → 视图永不出现):
> 本仓库的 `activationEvents` 里有 **`workspaceContains:**/package.xml`** —— ROS 工作区会**主动**激活扩展并设置该 key,
> 视图随即出现。空 ROS 工作区(或 `build.allowEmptyWorkspace`)下 key 为 false ⇒ 侧边栏也不显示,符合预期。
> ⚠️ 待你眼验的一点:VS Code 的既有行为是"容器内所有视图都隐藏时,活动栏容器一并隐藏";
> 这条我没有跑宿主验证过 —— 若你看到图标仍在(只是点开空),回来告诉我,我再换方案。

| 消费方 | 用途 | 依赖的结论类别 |
|:--|:--|:--|
| `languages/launch` | `executable=` 校验/hover/补全(填 05 文档"依赖已构建产物名单 v1 不做"缺口) | 固有(名单)+ 状态(是否装出) |
| 调试跳转(`手工重设计/10` 的 P0) | 断点文件跳转:**运行期路径 → `src/`**;Python 侧主战场是 `install/` → `src/`(测试期 `PYTHONPATH` 指向 install 副本,已实测);C++ 侧用 `compilePaths`(DWARF 里的编译期路径) | 状态(形态 + 实际内容)+ 固有(编译期路径) |
| **测试发现(C++ 限定)** | **C++ gtest 可 build-only 全量发现**:`build/<pkg>/CTestTestfile.cmake` 的 `add_test`(命令/参数/工作目录/label)+ `test_results/**/*.gtest.xml` 上次结果 + `.o.d` 直接给出测试源。**Python 侧彻底不在本域** —— 测试定义只存在于 `src/<pkg>/test/*.py`(源码/意图),而 `build/{ggg,hi,iii}` 连 `CTestTestfile.cmake` 都没有,**两源皆无** | 固有(build-only 完备) |
| **侧边栏**(`手工重设计/侧边栏提案.md`) | **已接简易版**(`src/sidebar/`):活动栏「ROS 2 包」→ 包 → 区(`可执行`/`Python 导出`/`资源`/`头文件`)→ 行;行内右侧给工作区相对的源路径(lib 区带 `:main`),hover 摊开状态与形态。展开时**惰性刷新**,只提供一个刷新命令 | 两源:`install` 定内容与形态、`build` 定源(**不用 `src` 定声明**) |
| 一键运行 | ✅ **已接**(2026-09-25:侧边栏 lib/launch 区行内 ▶ → run 域 `smart-run`/`smart-launch` 弹参数窗 + 记忆 + 任务终端) | 状态 |
| 一键测试 | ✅ **已接电**(2026-09-24 dfcd829:测试 provider 经 shared-center 共享中心定位可执行;测试发现与执行细节见 src/test-provider/) | 状态 |

## 11. 改造清单(第 10 项**已落地**,其余未做)

| # | 动作 | 依据 | 影响面 |
|:--|:--|:--|:--|
| 1 | ~~`MANIFEST_FILES` 加 `install.log` + 时间戳守卫~~ ✅ **已落地**:加进并集,并配 `freshnessBaselineMs`(取 `colcon_build.rc` ∩ `<pkg>.egg-info/SOURCES.txt` 的**较早者**);早于基线的记录进 `skipped` 并记 warning | §4 残留图谱 | `ggg`/`hi`/`iii` 三个 `ament_python` 包有清单可核对了 |
| 2 | ~~`findSitePackagesDir` 兼容 `/dist-packages/`~~ ✅ **已落地**(两种 marker 同时认) | `ament_cmake_python` 落点是 `local/lib/python3.10/dist-packages`(实测 p10/p12/p13) | 这三包的 Python 落点不再全漏 |
| 3 | **install 侧观察层** ✅ **已落地**:`scan/installed.ts` 完成"遍历 install 解算四区 + 与记录对账";**形态也齐了**(`lstat`/`readlink`/`mode` → `link`/`linkDomain`/`viaLinkDomain`/`dangling`/`executable`)。**仍缺** `egg-link` 与 `PythonInstall.mode`(develop 模式判定,见第 8 项) | §2 调用纪律 | 三区内容与形态均已可用 |
| 4 | 结论加 **`Agreement` 状态**,`conflict` 显式暴露 | §2 | 残留清单与实际不一致时不再静默取值 |
| 5 | ~~`trigger.ts` 扩展 `install/**` 失效源 + 防抖~~ **废止(2026-09-30 构建事件化)**:失效源改为构建信号主动刷新(单包构建 rc 门重扫 1 包 ≈亚秒,实测见 13 号设计 §3.2),install 抖动问题随 watcher 一并消失 | §2 | 已由 13 号设计取代 |
| 6 | `jumps.ts` **不再丢 `installed=false`**;取消 `includeUninstalled` 选项;生成物改为只打 `generated` 标记(不删);新增 `testIndex`(CTest 注册 + `test_results/*.gtest.xml`) | §2.1 第 3 条(truth 只给全集 + 标记,过滤下沉消费方);测试二进制正是被第 ④ 步"按清单排除未安装"丢掉的那批(`test_adder` 4.35 MB / `test_entries` 5.71 MB) | truth 语义 + consumer:测试发现 |
| 7 | 新增 `pathMapIndex`(**根对根**映射)+ `resolveRuntimePath()` | 根对根比逐文件省一个数量级,且天然覆盖新增文件 | 调试跳转;`{site-packages 根 → src/<pkg> 根}` 一对前缀在实体与软链两种形态下都成立 |
| 8 | `PythonInstall.mode`:`copy` / `link-through` | §1.2 ③ | `import` 区口径选择的前提(直通模式下清单会撒谎) |
| 9 | **陈旧残留夹具 + 不变式二测试** | §3 / §4 | 夹具现成;这是唯一能防住 §4 全部残留项的手段 |
| 10 | ~~**域包含性守卫**~~ ✅ **2026-09-21 已落地**:3 处越域访问已清(`srcRoot` 改必填约定值、`consoleJump` 去确认并降为 `derived`、`compilePathsExistLocally` 整体删除);新增 `guardDomain` 夹具 + 4 条不变式三用例;`tsc` 0 错、**47 用例全绿** | §2.2 / 不变式三 | 已解决 |

## 12. 修改记录

> 约定:时间精确到分钟。

| 时间 | 说明 |
|:--|:--|
| 2026-10-04 21:40 | **i18n 期2批4(05号档案)**:本域全部用户可见串英文源化——center/query 6 串(包不在工作区/源未解析/路径反查等)、scan/jumps ~28 串链注+层注(含 Python 落点三段碎片)、scan/installed 6 串 sourceRef+警告、shared/models TIER 四标签、center/build-map-center throw/增量重扫+BUILD_SIGNAL_REASON 值改语言中立英文 "build signal"(内部比较键,不进册,日志泄漏面随之英文)、shared/fs/primitives 越域 throw、center/shared-center 生命周期 2 串;纯数据域补 `import { l10n }`(models.ts 无 import 行手工锚定);build-map.test 31 处值绑定断言同步翻转(indexOf 子串/标签数组/描述 N items/tooltip 关键词),断言消息中文保留;中文译文收 bundle(+95=270 键);全套 1307 用例 0 失败 |
| 2026-10-04 16:48 | **目录行去图标(用户裁定"资源管理器口径")**:文件行改主题类型图标后,codicon folder 夹在中间反而扎眼 —— dir 行 `IconPlan` 增 `{tag:"none"}`,适配层不设 iconPath/resourceUri(渲染器对 iconPath/resourceUri/themeIcon 三连空不画图标,只剩折叠箭头+文字);**区头行(area)是分区标题非文件夹,保留 folder**(用户同轮裁定"区头保留,只目录去");测试补目录/区头口径断言钉死,验证:tsc 0 错、dev-build 重建、全套 1307 用例 0 失败 |
| 2026-10-04 14:51 | **侧边栏图标双改(活动栏 R monogram + 树文件行接文件图标主题)**:①活动栏图标立方体→**R 字母 monogram**(用户三候选 V1/V2/V3 浏览器截图预览裁定取 V2;纯 path 描边笔画 2.25@24 零字体依赖,stroke=currentColor 随主题;淘汰用户的 R2 重叠草案 —— 蒙版下单色塌缩/24px 发丝笔/text 字体依赖三硬伤截图实证)(1f4ca2d);②树文件行图标改接**文件图标主题**(官方机制:`TreeItem.resourceUri` + `ThemeIcon.File`,vscode.d.ts 与工作台 treeView.ts:1687 源码核实 —— file/folder ThemeIcon 仅在设有 resourceUri 时让位主题,其余恒按 codicon):决策上移纯函数 `iconPlanOf`(tree 模块,`IconPlan = file\|codicon`),用户裁定**「有源路径才换」**—— 有 sourcePath 的文件行全区域统一走主题类型图标(与资源管理器同源、随用户主题自动跟随),无源路径的纯二进制退回角色 codicon(lib→terminal / launch→rocket / import→symbol-module / share→file-media / 其余→file-code),missing 行 warning 警示优先,dir/area/package 虚拟折树节点无路径字段维持 folder/package/info;适配层 getTreeItem 只做机械翻译,iconOf 退役(零引用)。知情项:resourceUri 行吃 explorer.decorations(git 颜色/徽标,与资源管理器一致非 bug);图标主题选 None 时文件行无行内图标(平台语义)。验证:tsc 0 错、dev-build 重建、buildmap 套件 + 全套 **1307 用例 0 失败**(基线 1305 + 新增 2) |
| 2026-09-30 | **构建事件化(手工重设计/13 实施)**:①失效源换血 —— `center/trigger.ts` 整文件退役(`BuildMapTrigger`/`BUILD_WATCH_PATTERNS`/`isRelevantBuildPath`/`packageOfBuildPath` 零引用清理),shared-center 的 9 组 build 产物 watcher(27 订阅)+ `onBuildTouch` 全撤;②新失效源 = 环境域专供事件 `onBuildSignal`(源处零防抖)→ `refreshAfterBuildSignal()`(rc-mtime 增量门:单包构建恰 1 包重写 → 重扫 ≈69ms/包;零变化快速路;实测与门槛裁定见 13 号设计 §3)+ 激活后台首扫(查询端 ensureFresh 兜底);③`onPackagesChanged` 包级差分(逐包指纹,增/改/删非空才发)取代 onBuildTouch 喂测试域(CTest 新节点/runnable 恢复/剪枝/gtest 定位四链保留);④手动刷新改主动(权威全量);⑤`fingerprintOfSnapshot` 行生成抽取为 pkgRow/jumpRows/areaRow(全局值逐字节不变);⑥`minRefreshIntervalMs` 选项注释按实现更正(默认 0)。基准探针 `test/bench-buildmap-scale.js`(4557692):线性度全刻度 + rc 语义实证。验证:tsc 0 错、buildmap 套件 88 用例、全套 2378 用例 0 失败、dev-build 重建、VM 探针复跑一致 |
| 2026-09-29 | 文档补登 + 分层树/消费方表对齐:①§5 树补 query.ts / trigger.ts / **shared-center.ts**(2026-09-24 dfcd829 新建,自上一轮文档后未入树);②§10 消费方「一键运行/一键测试(待接管)」更新为已接状态(运行=2026-09-25 侧边栏 ▶ 委托 run 域;测试=2026-09-24 测试真值链路接电,同批测试排除项退役);③补登 2026-09-24 测试批两条(dfcd829 B15 接电 + 6531506 测试真值链路);④侧边栏七批批次小项补登:第二批 ③行首图标(lib→terminal、launch→rocket)④▶ 载荷改 runPayloadOf(element),第五批 ③树 tooltip「实体安装」→「拷贝安装」(062eb7e)——批次日期按实际提交日 2026-09-26(表内 09-25 系写作日,历史行不回改) |
| 2026-09-13 20:13 | **建档 + 首版落地**(install 为中心:判包/形态检测/双版本跳源链/候选 X_OK 扫描/数据中心):19 用例全绿 |
| 2026-09-13 22:22 | 分层重构(`shared/` + `scan/` + `center/` + `api.ts` 门面),`git mv` 保留历史;三份层 README 建档 |
| 2026-09-13 23:05 | **build-only 裁切(用户裁定:需求 = 可执行文件跳转;四象限报告证明只读 build 即可)**:`git mv` 重命名 5 个 scan/center 文件 + 2 个测试文件(历史保留);`shared/models.ts` 重写为跳转模型;`shared/fs/primitives.ts` 裁到 stat/readdir/readText(walkFiles/isDir/isFile);`scan/build-root.ts`(原 workspace)、`scan/packages.ts`(build 域判包 + traits)、`scan/targets.ts`(原 cpp)、`scan/python-meta.ts`(原 python,egg-info 单落点)、新增 `scan/install-rules.ts`(脚本入口)、`scan/jumps.ts`(原 executables,三类来源合成)、`center/build-map-center.ts`(原 exec-map-center);删除 install 侧形态检测/egg-info 双落点/X_OK 候选/readlink 链;测试重写 17 用例(新增 **install 无关性四象限不变式**);`tsc` 0 错误、17 用例全绿 |
| 2026-09-13 23:33 | **通用性评估 + 反例修复(用户:极端一点查其他版本 + 查局部反例)**:① 生成器/构建选项实测探针(非破坏性,/tmp 小工程)——**Ninja 生成器下 `link.txt`=0、`*.o.d`=0**(只剩 `build.ninja` + `compile_commands.json`)→ 现实现 C++ 跳转全失效,**列为最大缺口**(详见 `设计/新功能/07-buildonly通用性评估与反例清单.md`);**UNITY_BUILD 不构成反例**(`.o.d` 首依赖虽指向 `Unity/unity_0_cxx.cxx`,但同一条记录仍列出全部用户源)。② 本版本(Humble/roa2_ws)反例对拍(新增 `test/run-install-parity.sh`,地面真相 = ros2pkg 口径 walk `lib/<pkg>` + X_OK + 软链 shebang 兜底)抓到三类:**漏报** `fff/rrr.py`/`p10_mix_deps_std/py_listener.py`(PROGRAMS 规则未识别;实体态落点还带 `${CMAKE_INSTALL_PREFIX}`)、**误报** `test_adder`/`test_entries`(编译但未安装)、`link.txt` 无 `-o` 目标。③ 修复:新增 `scan/manifests.ts`;`install-rules.ts` 补 `PROGRAMS` 两种写法 + 根相对源绝对化 + `${CMAKE_INSTALL_PREFIX}` 剥离;`jumps.ts` 按清单核对并默认排除未安装(`includeUninstalled` 可保留),`JumpEntry` 增 `installed`/`installPath`;矩阵脚本每象限追加 parity 段。④ 验证:`tsc` 0 错误、无头 **21 用例**全绿、**四象限 × 名单对拍全部 NO_DIFF** |
| 2026-09-13 23:52 | **消费方数据结构 + 事件触发模块(用户:launch 是主消费方,准备数据结构与事件触发)**:新增 `center/query.ts`(**扁平索引 + 统一裁决**):`buildExecIndex`(pkg/name → 条目、包→名字、全部名字、源→归属 反向表)、`lookupExecutable`(四态裁决 `ok`/`pkg-not-built`/`exe-not-found`(带同包建议)/`source-unresolved`)、`ExecIndexCache`(按快照引用失效)、`ExecutableResolver`(launch 侧门面:`lookup`/`namesOf`/`allNames`/`sourcesOf`/`ownersOfSource`,`onDidChange`;未就绪一律 `null` 而非空);新增 `center/trigger.ts`(事件触发):**构建期抑制**(`onBuildStarted`→抑制文件事件,`onBuildFinished`→立即刷新)、**相关路径过滤**(link.txt/egg-info/清单/cmake_install/CMakeCache/`.o.d`…)、**防抖合并**、定时器可注入、`BUILD_WATCH_PATTERNS` 供 VS Code 适配层直接用;`api.ts` 导出两者;测试追加 **7 用例**(消费方 3 + 事件 4) → 共 **29 用例**;`tsc` 0 错误、全绿 |
| 2026-09-13 23:59 | **改按用户裁定:脏标记 + 调用即刷新(去掉轮询/静默/防抖扫描)+ colcon 日志实测**:`center` 增 `ensureFresh()`(见脏即立即重扫;`minRefreshIntervalMs` 默认 **0 不节流**;未就绪时首次查询即自动初始构建),`ExecutableResolver` 查询方法改**异步**(`lookup/namesOf/allNames/sourcesOf/ownersOfSource` 内部先 `ensureFresh`,消费方无需自己挂 watcher/定时器);`trigger.ts` 重写:文件事件**只置脏**(零扫描零定时器),只有**结束信号**走 150ms 合并后主动刷新一次;新增 `07`/`08` 文档记录 colcon 结束痕迹与日志屏蔽实测(`--log-base /dev/null` 官方可关、`--event-handlers log-` 可去 events.log、全局选项必须写在 verb 之前)→ **日志只作可选增强**;测试 30 用例全绿 |
| 2026-09-14 (P0 全做) | **调试侧消费落地(用户裁定:按本域惯例、仍只解析 `build/`)**:① **P0-1** `ExecIndex.byInstallPath` + `shared/paths.normalizeInstallKey` + `center/query.lookupByPath`(新状态 **`path-unknown`**)+ `ExecutableResolver.resolveByPath`;② **P0-2** `JumpEntry.installPaths`/`pythonInstall`(壳 / site-packages / 清单模块 / **devDir** / **devModuleFile** / `verified`);③ **P0-3** `BuildTarget.compilePaths` + `compilePathsExistLocally` + `JumpEntry.compilePaths`、`parseLinkOutputPath`/`outputPath`(供 symlink 别名);④ `pythonInstall` 的**核对与推导分离**(ament_python **无安装清单**实测 → 按 isolated/merged 两布局 × 三落点给候选,`verified=false` 且入 chain);⑤ `fingerprintOfSnapshot` 补入上述字段(修"只变安装/路径信息不发事件"的漏发)。**验证**:`tsc` 0 错误、无头 **43 用例**全绿;VM 真实工作区(`roa2_ws`)P0 探针 `RESULT=OK`(主落点 15/0、自洽 0 失败、系统路径 `path-unknown`);新增 `test/run-buildmap-p0-live.js` |
| 2026-09-21 19:55 | **立论修订:`唯一输入 build/` 破产 → 三源分工(仅文档,代码未动)** —— 由 `手工重设计/侧边栏提案.md` 新骨架(三区 `lib`/`import`/`share`)与 VM(`roa2_ws`)多轮实测驱动。① **三类结构不在 `build/`**:装配层(workspace-level:`install/setup.*`、`local_setup.*`、`_local_setup_util_{sh,ps1}.py`、`.colcon_install_layout`、colcon-core 与 ament_index 索引)、安装形态(`site-packages/<pkg>.egg-link` = develop 唯一权威标志;本工作区无 → 实体)、运行期实际内容(`ament_python × develop` 下 `build/<pkg>/<pkg> -> src/<pkg>/<pkg>` 是目录软链 → `exclude_package_data` 失效,`import` 区"扩大")。② **两类时效陷阱**:`build/` 惰性清除(9月16 的软链残留与 9月21 的实体 `install.log` 并存;`log/build_*/iii/command.log` 实证 9月16=`develop --editable … symlink_data`、9月20=`develop --uninstall`+`install --record`、9月21=纯实体)、`egg_info` **每次构建重写 5 个文件但 `not-zip-safe` 惰性写**(实测停在 9月16)→ 新鲜度判据必须**逐文件**;并修正一处自身误判(目录 mtime ≠ 文件新鲜度:`prefix_override/` 目录 9月16、其 `sitecustomize.py` 每次重写)。③ **文档变更**:标题与定位重写;新增 §1 立论修订(含根因"per-package 产物 vs workspace-level 装配")、§2 三源分工 + 调用纪律 + `Agreement` 状态(含缺失的 `conflict`)、§3 两条不变式(旧四象限**限定作用域保留** + 新增陈旧残留不变式)、§4 陈旧残留威胁类别(残留图谱 + 新鲜度基线 + mtime/hash 正交)、§11 改造清单 9 项;§6 补 `SOURCES.txt` 口径说明(sdist 全集,**不可**当 `import` 区清单);§9 更正"symlink+isolated"为实测的混合状态;§10 消费方补"依赖的结论类别"并写入测试发现(C++ 限定)与侧边栏 |
| 2026-09-21 20:00 | **原则收紧:`src/` 绝对不可碰(立论由"三源"改回"两源",truth 语义澄清)** —— 用户裁定:本域只反映**真实**,不反映**意图**;`src/`(package.xml / setup.py / 待测源码)整体**出局**,连 stat / readdir / 软链跟随都不允许;判据只能是"记录说了什么 + 现在实际是什么",绝不是"声明应该是什么"。① **两源定稿**:`build/` = **记录**,`install/` = **观察**,两者都是真实;`Agreement` 明确为"**记录的过去 vs 观察的现在**",不是"声明 vs 事实"。② 新增 §2.2「`src/` 不可达」并**核查出本域当前 5 处 src 接触点**(`build-root.ts` 的 `isDir(<ws>/src)`;`jumps.ts::consoleJump` 对 `src/<pkg>/…` 候选逐个 `isFile` 确认;`targets.ts` 对 `compilePaths` 逐个 `exists` 算 `compilePathsExistLocally`;`jumps.ts::devModuleCandidates` 经 `build/<pkg>/<pkg>` 目录软链间接触达;`shared/fs/primitives.ts::walkFiles` 用 `stat` 跟随软链穿进 src),逐条给出处置。③ 新增**不变式三「`src/` 不可达」**(注入"访问 `<ws>/src/**` 即失败"的 `FsLike`,全域功能须照常工作)—— 它是最高原则的**可执行形式**,夹具极简、且能一次抓出全部接触点,建议**最先落地**;连带结论:**凡靠"去 src 确认"换来的 `tier`/`verified` 一律下调**(如 `consoleJump` 的 `confirmed → tier=L` 回到 `derived`;宁可置信度低,不可越域取证)。④ **truth 语义澄清:"扩大"是真实,不是缺陷** —— 该扩大就如实返回,不用声明过滤、不写"理论上应该有/没有";**truth 层只给全集 + 标记,过滤下沉消费方** → `includeUninstalled` 应取消、生成物只打 `generated` 标记不删、`installed=false` 条目保留;`SOURCES.txt` 的合法用途收缩为"新鲜度基线(mtime)+ 模块名源落点推导(标 `derived`)",**不得**用于回答或过滤 `import` 内容。⑤ 消费方表修正:测试发现 **Python 侧彻底不在本域**(两源皆无,不只是"不承诺");侧边栏改为"两源,不用 `src` 定声明",并按真实渲染 `secret.txt`。⑥ §11 改造清单增至 10 项(新增第 10 项"零 `src/` 访问",列为最先做)。**本次仍为文档修订,代码未动** |
| 2026-09-21 20:09 | **修正上一版的过强约束:`src/` 并非完全不可读(域包含性定稿)** —— 用户裁定:`iii -> src/` 这类软链**必须读**,因为软链一旦存在,`src` 就已经**成为 `build/`/`install/` 的一部分**。① **判据改写**:归属由「**访问路径**」决定,不由「软链解析后的真实位置」决定 —— 访问路径在 `build/`/`install/` 之下即允许(哪怕被带到 `src/` 甚至 `/opt/ros`),**直接**访问 `<ws>/src/**` 则禁止。② **违规数由 5 处修正为 3 处**:保留**越域**三项(`build-root.ts::isDir(<ws>/src)`、`jumps.ts::consoleJump` 对 `src/<pkg>/…` 逐个 `isFile`、`targets.ts` 对 `compilePaths` 逐个 `exists`);**撤回**上一版对 `jumps.ts::devModuleCandidates` 与 `shared/fs/primitives.ts::walkFiles` 的指控 —— 二者访问路径均在 `build/` 下,跟随软链是**合法且必需**的(它们观察的正是"直通模式下 build 里有什么"),仅需保留 `maxDepth` 防环。③ **关键论证**:**"扩大"的机制本身就是这条软链**把源码目录纳入 `sys.path` 根 —— 因此要如实反映扩大,**就必须**读这条软链;禁止它会同时砍掉合法用法,把本域"如实报告事实"的能力一起关掉。④ **不变式三改写为「域包含性」**:注入只放行"访问路径以 build/install 根开头"的 `FsLike`,全域功能须照常工作且软链穿越仍可用;守卫做在**字符串层**(`FsLike` 入参即访问路径),精确且零成本,一次抓出 3 处越域、同时验证 2 处穿越。⑤ 补 `install/` 侧同类例证:`install/p10_mix_deps_std/share/…/ament_prefix_path.sh -> /opt/ros/humble/…`,访问路径在 install 下即应读。**本次仍为文档修订,代码未动** |
| 2026-09-21 20:16 | **域包含性落地(§11 第 10 项完成;本域首次代码改动)** —— 用户裁定边界:"我们提供的是**真实情景**,所指向的文件**不存在、位置移动、重命名**,这些**不归我们管**;我们需要的是在 `build/`、`install/` 当中**解算出内容,呈现出来**"。据此把 §2.2 的 3 处越域访问全部清掉:① `scan/build-root.ts` 去掉 `isDir(<ws>/src)` 探测,`BuildContext.srcRoot` 改为**必填**的约定值 `pjoin(workspaceRoot, "src")`(`BuildMapSnapshot.srcRoot` 同步改必填,`fingerprintOfSnapshot` 的 `?? ""` 一并去掉);② `scan/jumps.ts::consoleJump` 去掉对 `src/<pkg>/…` 候选的逐个 `isFile` 确认 —— 一律给推导首选并如实标 `derived`(`tier` 由 `L` 降为 `C`,文案改为"存在性不归本域管");连带把 `candidates.length===0` 的文案从"src 根缺失"改为"模块名为空"(srcRoot 现恒存在);③ `scan/targets.ts` 删除 `compilePathsExistLocally` 的逐个 `exists` 循环并**整体删除该字段**(`shared/models.ts` 的 `BuildTarget` / `JumpEntry` 各一处),`compilePaths` 只作记录原样给出,chain 改为"本机可访问性由消费方自查";`center/build-map-center.ts` 指纹同步移除该字段。**新增守卫夹具**:`shared/fs/primitives.ts` 的 `guardDomain(inner, roots)` —— 只放行**访问路径**以给定根开头的调用(不看软链解析结果),经 `api.ts` 导出。**测试**:`test/suite/build-map.test.ts` 新增 `describe("域包含性…")` **4 用例**(守卫下快照照常成功 / console 不再越域确认 / 守卫确实拦得住 / 同一内容经 build 放行而直接 src 拒绝),并把 2 条 P0-3 用例改写为"域外存在性不再判定、异机构建与同机构建结论一致";`test/run-buildmap-p0-live.js` 同步去掉该字段的统计与打印。**验证**:`npx tsc -p .` **0 错误**、`node test/run-buildmap-tests.js` **47 用例全绿**(原 43 + 新增 4)。**待办**:VM 上的 `run-buildmap-p0-live.js` 尚未复跑(需把 `out/` 同步到 VM);`手工重设计/10`、`手工重设计/11`、`问题/新问题/排期-*` 仍按旧字段描述,需另行修订 |
| 2026-09-21 20:44 | **三区解算落地(补齐"替代能力")** —— 用户指出上一步"只是强行删除了对 `src` 的访问,但并没有替代",要求**完善 lib / import / share 三区**。本次完成 §11 第 1/2 项与第 3 项的一半:① **`scan/installed.ts`(新)**:`installRootOf` / `readInstallLayout`(读 `install/.colcon_install_layout`)/ `collectAreas` —— **以 install 侧观察为主**,按落点形状归档四区(`lib` = `<prefix>/lib/<pkg>/` + `bin/`;`import` = site-packages **或 dist-packages**;`share`;`include`),再与 build 侧的**清单 / 安装规则对账**:`agreement` 三档(**`confirmed`** / **`observed`** ← 直通模式"扩大"出来的正是这一档,如实保留 / **`manifest-only`** ← 只记录、观察不到),`generated`(约定黑名单 ∪ 源落在 build 内)与 `library` 只作**标记不过滤**,`sourcePath` 按"跳转记录 → 安装规则 → ament_python 根映射"推出(**纯字符串拼装、不访问 `src/`**);② **`manifests.ts`**:`MANIFEST_FILES` 加入 **`install.log`**(`ament_python` 的唯一清单替代品),新增 **`freshnessBaselineMs`**(取 `colcon_build.rc` 与 `<pkg>.egg-info/SOURCES.txt` 的**较早者**)与**陈旧守卫**,早于基线的记录进 `ManifestInfo.skipped` 并记 warning;`findSitePackagesDir` 同时认 `site-packages` 与 **`dist-packages`**;③ **`fs/primitives.ts`**:`FsStat` 增 **`mtimeMs`**(守卫的唯一依据;`MemoryFs` 的 `addDir`/`addFile`/`addBinary` 支持显式时间戳);④ 快照增 **`areas`** 字段,`fingerprintOfSnapshot` 纳入"区/相对路径/对账状态/标记/源落点"→ **扩大出一个文件也会发事件**。**测试**:新增 `describe("安装内容解算:三区…")` **8 用例**(四区归档 / 三档对账 / manifest-only / 标记不过滤 / dist-packages / 源落点不越域 / 陈旧守卫 / 指纹随内容变化);`npx tsc -p .` **0 错误**、**55 用例全绿**(原 47 + 8)。**仍未做**:`FsLike` 无 `readlink` → 尚不能如实区分"拷贝 vs 软链",也拿不到软链目标(故 `rosidl` 生成物暂靠"源落在 build 内"标记,而非软链判定) |
| 2026-09-21 21:09 | **甲-1 形态落地 + 真机三处修正 + 三区真机探针(代码改动)** —— 用户指出上一步"只删除了越域访问、没有替代",要求**完善三区**;本轮把 §11 第 1/2/3 与**甲-1**做实。① **`FsLike` 加 `lstat`/`readlink`**(`FsStat` 增 `kind:"link"` 与 `mode`;`nodeFsLike` 直取 `st.lstat`/`st.readlink`;`MemoryFs` 增 `addLink`/`chmod`,并实现**逐段软链解析** —— 否则 `install/…/site-packages/py/sss.py`(py 是目录软链)在内存 fs 里查不到,那是**保真度**问题;`guardDomain` 转发两个新方法)。② **`installed.ts` 换成软链感知遍历 `walkArea`**(lstat 枚举 → **悬空链可见**;目录软链继续深入 = "扩大"的通道;`maxDepth` 防环),产出 `link` / `linkTarget` / `linkDomain`(src/build/outside)/ `viaLinkPath`+`viaLinkDomain`(上游目录软链 —— **软链目录里的子文件自身不是软链**,"扩大成因"是上游的事实)/ `dangling` / `executable`(实体看自身、**软链看目标**)。③ **真机跑出三处修正**:a) `sourceFromRules` 的 DIRECTORY 拼接产生双斜杠(`src/fff/fff//__init__.py`)→ 改用 `pjoin`;b) `lib/` **根**下的库被漏(p12/p13 `lib=0` → `8`)→ 新增 `collectFlatDir`,并给 merged 布局加"只认被记录提到的"归属门;c) **`generated` 判据修正** —— 原用 `linkDomain==="build"` 会把 C++ 可执行(软链指向 build、源在 `src`)误标成生成物进而被消费方隐藏;**真实判据是「约定黑名单 ∪ 源落在 build 内」**,而 develop 模式扩大出来的**用户数据不得**标成生成物(否则正好把"扩大"藏掉)。④ **新增真机探针 `test/run-buildmap-areas-live.js`**(四区计数 / 三档对账 / 标记 / 形态 / `linkDomain` 分布 / 悬空清单 / 归档自洽)。**VM 结果(`roa2_ws`;共享盘直通,零同步)**:13 包 540 文件,`lib=35 import=69 share=368 include=68`,`confirmed=398 observed=142 manifest-only=0`,源落点 `install-rule=383 / python-rootmap=70 / jump-record=20 / 无源=67`,**形态 `link=228 dangling=0 executable=25`,`linkDomain build=196 / src=16 / outside=16`,`viaLinkDomain` 空**(本工作区 = 实体安装,无目录直通),`RESULT=OK`。**另一条真机验证**:`install.log` 进清单并集后 `run-buildmap-p0-live.js` 的 `pythonInstall` 由"清单核对 2 / 推导未核对 5"变为**"清单核对 7 / 推导未核对 0"**,`byInstallPath` 56→39 键(**收敛**:有清单核对后不再登记布局猜测的别名),`RESULT=OK` 保持。⑤ 文档:新增 §2.3 **四区覆盖边界**(`lib/cmake/**`、`share/ament_index/**`、工作区装配层不进四区,需要时应开第五区);§9 补探针与 61 用例。**测试**:`tsc` 0 错、**61 用例全绿**(55 + 甲-1 四条 + `lib/` 根/merged 两条)。**仍未做**:甲-3 跳转图查询口、甲-2 门面、甲-4 测试注册表、乙-1 不变式二、乙-3 外部文档、甲-5 |
| 2026-09-21 21:15 | **最小门面(用户:"随便做一下就好")** —— 给 `ExecutableResolver` 补 5 个方法,风格与既有查询一致:**未就绪 → `null`(sync 视图)/ 构建失败 → `null`(async)**、**空区 → `[]`(≠ null)**、包不存在 → `null`:① `areasSnapshot()`(同步只读,给侧边栏 + `onDidChange` —— 避免"每展开一个节点都 `await ensureFresh()`"造成反复全量重扫);② `areasOf(pkg)`;③ `filesOf(pkg, area)`;④ `installedPackages()`;⑤ `findInstalledFile(installPath)`(落点 → 条目,键经 `normalizeInstallKey` 吸收写法变体;配**按快照引用失效**的 `areaIndex` 懒建索引,同 `ExecIndexCache` 的做法)。**明确不做**:过滤(隐藏生成物 / 库 / 只取 `.py`)一律下沉消费方。**测试**:新增 1 条门面用例(覆盖 `sync null` / `构建失败 null` / `空区 []` / 包不存在 null / 归一化键命中);`tsc` 0 错、**62 用例全绿**。**注**:原本按"未就绪 → null"写断言,实测发现这四个异步方法**惰性自动构建**(与 `lookup`/`namesOf` 同契约),只有**构建失败**才 null —— 断言已按真实契约改正 |
| 2026-09-21 21:18 | **侧边栏视图(用户澄清:"我这里实际上想说的是侧边栏,只要侧边栏的数据能够完整,那么基本上大部分数据都已经完整了")** —— 上一步做的是**调试侧**查询口,本步按 `手工重设计/侧边栏提案.md` 的**三区骨架**逐项对账,把缺口补齐。① **补唯一的真缺口:lib 区的 `:main`** —— `JumpEntry` 增**结构化**字段 **`entryTarget`**(`module:attr`,如 `iii.sub.helper:main`);此前它只躺在 `chain` 的中文文案里,而提案要求源箭头显示成 `…/helper.py:main`。② **新增一站式行视图**:`center/query.ts` 增 **`SidebarRow`** / **`SidebarPackageView`** / **纯函数 `rowsOf(pkgAreas, jumps?)`**,以及门面三方法 **`sidebarSnapshot()`(同步)/ `sidebarView()`(异步)/ `packageView(pkg)`**。`SidebarRow` 给到"渲染一行所需的全部事实与标记":`name` / `status` 四档(`installed`·`missing`·`generated`·`source-unresolved`,判定优先级即此序)/ `source`(lib 区自带 `:main`)/ `sourceEvidence` / `library` / `generated` / `link`+`linkDomain`+`viaLinkDomain`+`dangling` / `executable` / `installPath`;**数组顺序 = 稳定区序 `lib → import → share → include`**,可直接照渲染。③ **真机把提案那两棵树画出来对账**(`roa2_ws`):`iii.lib` 三入口 → `src/iii/iii/{sub/helper,other,sss}.py:main` ✅;`iii.import` 10 行(`asset`/`data`/`py.typed`/`sub/**`),**无 `secret.txt`**(实体安装,正合"理论上没有")✅;`iii.share` 13 行(**含提案手绘时漏掉的 `launch/sss.launch.py`**)✅;`p10` lib 2 / import 2 / share 33 / include 3,源箭头全部正确 ✅。④ **真机再抓出第 4 个用户可见 bug**:`p10` 的 share 源路径多一层 `launch/` —— 根因是 CMake 为 `launch`/`config`/`urdf` 各写一条 DIRECTORY 规则而**共用同一个 dest**,原实现"先匹配先赢 + 兜底"让第一条的兜底抢走了后面正确的源(实测首次渲染出 `src/p10/launch/config/extra/deep.yaml` 与 `src/p10/launch/urdf/…`);改为**两遍解析**(先全局找 `rest` 首段精确匹配,再退兜底),真机复核 33 条 share 全对。**测试**:新增 4 条(侧边栏行四档 + `:main` / 整棵树契约 / DIRECTORY 多源 / 共用 dest 的优先级);`tsc` 0 错、**65 用例全绿**。⑤ 文档:§7.1 新增侧边栏视图契约 + 完整性对账表 |
| 2026-09-21 21:22 | **简易侧边栏接线(用户:"你知道简易侧边栏吗?就是真正的显示出来…确实就是简易,只需要简易就行")** —— 把三区数据真正画进 VS Code 活动栏。① **新增 `src/sidebar/`**(适配层放**域外**,本域保持零 vscode):`install-truth-tree.ts` = **纯树模型**(包 → 区 → 行,零 vscode,可无头单测;`SIMPLE_DISPLAY` 单点控制"隐藏生成物 / lib 不列库"两条裁剪 = 对齐提案 §2.7 口径);`install-truth-sidebar.ts` = 薄适配层(建中心 → `TreeDataProvider` → 刷新命令;行内右侧给**工作区相对**的源路径,lib 区带 `:main`;hover 摊开 `status` / 落点 / 源 / 形态(软链指向 src|build|outside、悬空、直通)+ 源证据)。展开根时才 `ensureFresh`(**惰性,不挂 watcher、不轮询**)。② **package.json 贡献**:活动栏容器 `ros2-packages` + 视图 `ros2.installTruth` + 命令 `ROS2.sidebar.refresh` + `view/title` 刷新按钮;`extension.ts` 在测试提供器之后注册。③ **图标**:—— 用户指出"侧边栏要指定一个图标不然出不来的"。核实 `viewsContainers.activitybar[].icon` **必须是 SVG**(PNG 不渲染、容器直接不出现),而 `media/` 里只有 `icon.png`;新增 **`media/ros2-packages.svg`**(24×24 单色包箱图形),容器与视图图标均指向它。④ **打包**:核实 `package.json` 的 `main` = `./dist/extension`(webpack 产物),`tsc` 的 `out/` 不够 → 跑 `npx webpack --mode development` 重打包(0 warning 通过),并在 `dist/extension.js` 里核对到视图 ID / 刷新命令 / 树标签 / 区标签。**测试**:树模型 2 用例(层级与两条裁剪 + `:main` 相对路径 / 空态与占位);`tsc` 0 错、**67 用例全绿**。**使用前提(易踩)**:提供器读 `workspaceFolders[0]`,所以开发宿主里要**打开 ROS 工作区**(如 `/home/ros2/roa2_ws`),否则树显示"未发现构建产物"(不会崩)|
| 2026-09-21 21:23 | **侧边栏改为工作区惰性绑定(用户:"不用重新打包,我会直接跑扩展宿主")** —— 核 `.vscode/launch.json`:`Extension` 配置的 `preLaunchTask` 是 **`dev-build`**(`tsc -p ./` → `out/`,`webpack --mode development` → `dist/`),故 **F5 自动带上新代码**,手动 webpack 确实多余。但同一份配置**只传 `--extensionDevelopmentPath`、不带文件夹参数** ⇒ 宿主起来时 `workspaceFolders` 为空,而原实现在"无工作区"时**直接不注册提供器** ⇒ 视图会显示"没有数据提供器"。改为:① **视图无条件注册**(贡献已在 package.json);② 中心/解析器**首次展开时才按当前工作区创建**,`boundRoot` 变了就整体重建;③ 订阅 `onDidChangeWorkspaceFolders` 重绑并重绘 ⇒ **起宿主之后再打开 ROS 工作区即可直接接上,不需要重载窗口**;④ 无工作区 → 根节点"未打开工作区";`locateBuildRoot` 失败 → "解算失败 + 原因"(读 `getLastError()`,不崩)。`tsc` 0 错、**67 用例全绿** |
| 2026-09-21 21:56 | **侧边栏点击跳转(用户:"点击跳转没做?做一下吧,我方便直观地测试")** —— ① **数据侧补字段**:`SidebarRow` / `TreeNode` 各增 **`sourcePath`(纯路径)**;`source` 仍是**展示串**(lib 区带 `:main`)。这个区分是必需的:`…/helper.py:main` 直接当路径会去找名叫 `helper.py:main` 的文件。② **适配层**:文件行挂 `TreeItem.command` → 新命令 **`ROS2.sidebar.openSource`**(只作行命令,不进 `package.json` 的 commands —— 它需要参数);存在 → `openTextDocument` + `showTextDocument(preview:false)`;不存在 → 一句看得懂的话 + 「复制路径 / 打开所在目录」,而不是甩通用错误(检查存在性是**编辑器侧**的事,本域不判域外存在性 §2.2)。③ **真机就绪度核对**(`roa2_ws`;用**真实树** `buildTree` 过滤后统计):**侧边栏可见 91 行,91 行全部可点,指向不存在的源 0 行**;全工作区 540 行中有 344 行有可打开的源(其余是生成物 / `.pyc` 等被隐藏或无源项)。**测试**:树用例补两条断言(纯路径不带 `:main`;无源行 `sourcePath` 为 `undefined` ⇒ 点它什么也不做)—— 顺带抓出**夹具**漏给 `sourcePath` 的问题;`tsc` 0 错、**67 用例全绿** |
| 2026-09-21 22:02 | **侧边栏加视图门槛(用户问:"对于非 ROS 工作空间的,这个侧边栏还会注册吗?")** —— 核查结论:**会注册,而且是噪音** —— `viewsContainers`/`views` 是**静态贡献**(只要扩展激活过,图标就出现),而 `registerInstallTruthSidebar` 又是无条件注册,于是非 ROS 工作区里点开只会得到「解算失败:未找到 build/(build-only 需要构建产物)」。修:`views[].when = "ros2.hasPackageXml"`(该 key 由 package-core 驱动:`extension.ts` 的 `syncHasPackageXmlContext`,`hasPackages = workspace.length > 0`)⇒ **非 ROS 工作区不显示该视图**。**并排查了"鸡生蛋"陷阱**:视图被 `when` 藏住时不触发 `onView` ⇒ 若该 key 只能由扩展激活后设置,视图将永远不出现;本仓库**恰好躲过**,因为 `activationEvents` 含 `workspaceContains:**/package.xml`(ROS 工作区主动激活 ⇒ 设 key ⇒ 视图出现)。空 ROS 工作区 / `allowEmptyWorkspace` 下 key=false ⇒ 侧边栏也隐藏(符合预期)。**未验证项**:容器在"所有视图都隐藏"时是否一并隐藏(VS Code 既有行为,未跑宿主眼验),已记进 §10 待确认 |
| 2026-09-21 22:04 | **区内改为目录树(用户贴图:"你这让我很难办啊,你这样子平铺,方便是方便了,我看起来可不方便")** —— 上一版把区内的行**平铺**成 `relPath` 列表,`p10` 的 share 区 33 行糊成一片(截图里 `config/extra/deep.yaml`、`launch/nested/…`、`urdf/stress/arm/…` 全是长标签)。修:① 新增纯函数 **`foldRowsToTree(rows, ws)`** —— 按 `/` 把行折成**目录层级**,目录节点 `kind:"dir"`、标签带尾斜杠 `config/`;文件节点退化成**叶名**(`deep.yaml`),**完整源路径仍留在行内右侧灰字**;② 排序取**纯字母序、目录与文件混排**,与 `手工重设计/侧边栏提案.md` 的手绘形状一致(`… demo9.xacro → ns_lab/ → p10.urdf → stress/`),想改"目录优先"只动那一个比较函数;③ 适配层把 `dir` 也画成 `folder` 图标、不给 `command`(目录不可跳转),文件仍可点击跳转。**真机复核**(`p10_mix_deps_std`):树形与提案逐行同形(`资源 → config/ → extra/ → deep.yaml` / `launch/ → nested/` / `urdf/ → {demo10.xacro…, ns_lab/(8 个), p10.urdf, stress/ → {arm/(2), chassis.xacro, …, sensors/(2)}}`),最深 8 层正常。**测试**:新增 1 条(折树形状 + 混排顺序 + 文件是叶子),并把原 share 断言改为经目录取叶;`tsc` 0 错、**68 用例全绿** |
| 2026-09-21 22:11 | **点击跳转改用预览标签(用户实测:"我点击那些条目之后直接跳转过去这是正常的,但是似乎你把焦点也转移过去了…vscode 是有预渲染器的…点 5 个之后会复用窗口,最后只剩下一个")** —— 复现根因:原实现是 `showTextDocument(doc, { preview: false })`,**`false` = 钉住新标签** ⇒ 点 N 个攒 N 个。查证(vscode#149088):`preview: true` 才是预览模式;且 `preview` 与 `preserveFocus` 是**两个独立选项** —— 把预览等同于"焦点别移过去"是常见误解,实际前者管标签复用、后者管焦点。修:`openPath(filePath, preview)` 统一封装,单击走 **`{ preview: true, preserveFocus: true }`**(复用单标签 + 焦点留在树上 ⇒ 可连续点/连按方向键浏览);右键补 **`ROS2.sidebar.openSourcePinned`**(`preview:false` + 聚焦)以补回预览模式**丢掉的"双击钉住"手势**(树行没有双击事件),菜单 `when` 限定 `viewItem == ros2.installTruth.file.openable`(只有"有源可跳"的文件行才出现,故 `contextValue` 对可跳转文件行单独取值);命令标题登记进 `contributes.commands`(菜单项需要),分组 `1_open` 走右键菜单而非行内图标。**记录已知边界**:用户关掉 `workbench.editor.enablePreview` 时 VS Code 忽略 `preview: true`(设计如此),标签仍会累积。`tsc` 0 错、**68 用例全绿**;`package.json` 校验:3 个命令 ID、`view/item/context` 的 `when`、`views[].when=ros2.hasPackageXml` 均正确 |
| 2026-09-21 22:14 | **撤掉"固定打开"右键项(用户裁定:"不需要补充一个固定打开,因为对于用户来说只要双击标签就会固定,只是多一个步骤,又或者是修改文件内容将预渲染直接转化为固定标签,这些都是自动执行的,你添加一个选项反而更多")** —— 撤回上一轮新增的 `ROS2.sidebar.openSourcePinned`:① `package.json` 删该命令声明与整块 `menus."view/item/context"`;② 适配层删 `SIDEBAR_PIN_COMMAND` / `pinSource` / 为它而设的 `contextValue` 细分(`ros2.installTruth.file.openable`),`contextValue` 回到 `ros2.installTruth.${kind}`;③ `openPath(filePath, preview)` 收敛为 `openPath(filePath)`,固定走 `{ preview: true, preserveFocus: true }`(去掉那个只有一个取值的旋钮);④ §10 记下"钉住靠既有机制"的结论,避免以后又有人"顺手补一个"。**校验**:`tsc` 0 错、**68 用例全绿**;`contributes.commands` 只剩 `ROS2.sidebar.refresh`(点击命令仍需参数、本就不在清单里)`,`view/item/context` 已移除,`grep openSourcePinned\|SIDEBAR_PIN_COMMAND\|file.openable` 无残留 |
| 2026-09-25 | **launch 区提升 + 侧边栏 ▶ 运行(消费方 = build-tool/package-service/run)**:侧边栏树模型(`src/sidebar/install-truth-tree.ts`,消费方策略不动 truth 层)把 share 区命中 `*.launch.{py,xml,yaml}` 的行提升为独立 **launch 展示区**(排"可执行"之后,行 area 改写为 `launch`、去 `launch/` 前缀展示、truth 仍按四区给数据);`fileContextValue` 细化 contextValue(`file.executable` / `file.launch`,missing/悬空/无执行位不给),适配层注册行内 ▶ 命令(`ROS2.sidebar.runExecutable` / `launchFile`,委托 run 域弹参数窗 + 记忆 + 任务终端)。`file`/`fileNodeOf` 增 `pkg`/`installPath` 字段供运行取目标 |
| 2026-09-25(第二批) | **黑名单硬排除 + include 生成头显示(用户裁定)+ build 终点调查记档** —— ① **扫描层黑名单**:`AREA_SKIP_DIRS` 加入 `__pycache__`、遍历跳过 `*.egg-info` 目录段(推翻 2026-09-21 "照实列出 + 打标记"口径;用户:"务必使用黑名单文件夹排除"—— 实测 pyc/egg-info 在侧边栏全是噪音);② **include 区生成头显示**(消费方侧,`install-truth-tree.ts`):`hideGenerated` 对 include 区豁免 —— 此前接口包(如 p13_msgs)的 rosidl 生成头因"源在 build → generated=true"被整区吃空,包节点还挂着全量计数"122 项"造成错账;现在生成头显示、**点击统一跳安装侧文件**(`openTargetOf`:generated include → `installPath`,不跳 src/build;包节点描述改用**过滤后可见行数**);提案 §2.1 的"接口包 include 区 ※ 待定"就此落定;③ **调查记档("只读 build 是否含 install 终点"—— 结论:含,三载体)**:`build/<pkg>/CMakeCache.txt` 的 `CMAKE_INSTALL_PREFIX:PATH=`(绝对前缀,TS 未读,Python 原型 `discover/buildonly/scan.py:236-263` 有)、`install_manifest.txt`/`symlink_install_manifest.txt`(逐行绝对路径,`manifests.ts` 已读但未接头文件)、`cmake_install.cmake` DESTINATION(已解析但归一为相对前缀)。本期**未接线**:头文件列表沿用 install 观察(include 子树干净、点击目标必然存在、零新增扫描),build 侧噪音更多(box_functions.c/CMakeFiles/未安装文件);将来做"未安装预览/无 install 模式"时按上述三载体启用 |
| 2026-09-25(第三批,展示层) | **布局上移 + rosidl 中间产物过滤 + 纯 Python 面 + 子孙计数(用户裁定,truth 层不动)** —— ① 包节点不再逐包标 `isolated/merged`(工作空间级属性,`layoutOfViews` 汇总后写 `view.description` 显示在视图标题旁;混合 → "混合布局");② **rosidl 中间产物隐藏**(`isRosidlIntermediate`,只对 generated 行生效):include 区剔 `detail` 路径段与 `*__visibility_control.h/hpp`,import 区剔 `*_s.c` / `*_s.ep.*.c` / `.so` —— 用户裁定"只显示最后的导出接口"+ import **纯 Python 面**;手写 detail/ 头文件与非生成 .so 不受影响;③ 文件行路径灰字取消(改悬浮属性,tooltip 已含全文);④ 目录节点新增**递归子孙文件数**灰字(区/包计数同口径,随过滤自动更新);⑤ 展示层防御 `__pycache__`/`.egg-info` 段(manifest-only 反向行可能带回) |
| 2026-09-25(第四批,展示层) | **包属性呈现 + 排序/折叠重构(用户裁定)** —— ① `SidebarPackageView` 增可选字段 `installForm` / `buildType`:`installFormOf(rows)` **以 install 侧观察为准**(observed 行有 `link=true` 或 `viaLinkDomain` 非空 → symlink;全真实文件 → copy;无观察 → unknown 不猜);`buildType` 取 `snapshot.packages[pkg].type`(inferType)。**配置域/观察域分工记档**:build 域 install-method-check 的 CMakeCache(`AMENT_CMAKE_SYMLINK_INSTALL`)解析是**配置意图**而非 install 现状(其头注实测反例明令禁止当现状用),故不接代码;② 包节点 description = `符号安装 · ament_cmake · N 项`(unknown 属性省略),tooltip 说明依据;③ 目录 label 去尾部 `/`;④ **单分支文件夹合并**(VS Code compact folders 同语义:恰 1 个子目录且无文件 → label 连成 `a/b/c`);⑤ 排序**固定目录在前、文件在后**(推翻混排口径,修 `__init__.py` 插到目录前的乱序);⑥ 目录/区计数统一 " N 项" 追加式;⑦ `openTargetOf` 生成物跳安装侧扩展到 import 区(生成 .py 不再落 build);⑧ `attachView` 显式回写 `view.title`(修视图标题旁布局 description 不渲染) |
| 2026-09-25(第五批) | **陈旧清单守卫扩展 + 来源引用(用户裁定"build 可以是数据来源但不能是唯一,必须加 install 查询筛选")** —— ① **三份安装记录统一过新鲜度守卫**(`FRESHNESS_GRACE_MS = 5s` 宽限差):原口径只守 `install.log`,豁免理由"两份 manifest 每次安装重写"只对**当前形态**成立 —— 切换符号/实体后,弃用形态的 manifest 残留不清(实测 p10_mix_deps_std:`symlink_install_manifest.txt:46` 比基线早 10 分钟,把已删的 config/p10.yaml 混进并集 → 误报 missing);宽限差防误杀 —— 正常同形态构建里清单 mtime 比基线(`colcon_build.rc`)早亚秒级(实测 0.1s),严格 `<` 会把当前记录也丢掉;② **AreaFile/SidebarRow 增 `sourceRef`**(悬浮栏"内容来源"可逆搜索):安装规则 → `安装规则 <文件名>`,manifest-only → `安装记录 <清单文件名>`,根映射 → `<pkg>.egg-info 根映射`,跳转 → `构建记录(link.txt/.o.d)`;`ManifestInfo.origin`(路径 → 清单文件名)与 `sourceFromRulesRef`(带 `from`)支撑 |
| 2026-09-25(第六批,用户裁定) | **布局写进视图标题本体 + 构建挪到行尾** —— ① 树根信息行撤除:单视图容器的紧凑标题(「ROS 2 包: 包内容」)渲染的是 **title**(description 紧凑头部不显示),故 `setViewTitle` 把布局/包数动态写进标题本体 → 「包内容 isolated · 13 包」;② `ROS2.sidebar.buildPackage` 从右键菜单改为**行尾 inline 按钮**(`$(tools)`,与文件行的 ▶ 区分) |
