# 复测报告:intellisense-gen 生成代码 × 6 包复杂工作区(2026-09-05)

> 对象:`src/build-tool/package-service/config/gen`(intellisense 配置生成器源码)
> 测试场:`/home/ros2/roa2_ws`(6 包混合 ROS2 Humble 工作区)
> 方法:按 gen 代码算法**等价复算**(Python)+ 真实头文件/模块命中测试,不跑 TS、不改代码
> 前身文档:roa2_ws `docs/路径映射与导入结论.md`(§8 复杂环境复测);本报告直接验证**扩展实现层**

> ⚠️ **2026-09-07 修订(本文被取代部分,以本条为准)**:本文记录的是 **2026-09-05** 行为——clangd 行集为「顶层 include + 一级子层 include/<pkg> **父子全列**」(当时为同时兼容"普通 export include 根(A 风格)"与"rosidl 双层 export include/<pkg>(B 风格)"两套)。
> **2026-09-07 头文件布局统一【约定 B】(Humble+ 官方/rosidl 双层)后,该"父子并列全列"已收敛为"每包一行消费根"**:工作空间 src 包 → 父根 `<pkg>/include`(不再展开 include/<pkg> 子行);install/发行版前缀 → 只列各包子根 `include/<pkg>`(不再列 include 父根)。实现见 `intellisense-utils.ts` `clangdGroupDirs` 与 `intellisense-render.ts` syncClangd 归正。
> 下文 5.1 表命中行(系统双层 rclcpp、rosidl 接口包 p12/p13)**在新行集下仍全部命中**(它们命中的正是子根 include/<pkg>);「5.1 结论」与「第 7 节结论 2」中"一级子层展开同时兼容两套/核心路径推导无需修改"的表述**已失效**;附录 A 复算脚本为 2026-09-05 版本(ws 侧也做一级子层),已被新语义取代,仅作历史参照。

---

## 1. 被测代码分层

| 文件 | 职责 | 被验证的关键函数 |
|:--|:--|:--|
| `intellisense-api.ts` | 接口层(纯类型) | — |
| `intellisense-config.ts` | 编排层:引擎开关/防抖/包 diff/有感删除 | collectAllIncludes 分派、additions/removals |
| `intellisense-render.ts` | 渲染层:写 c_cpp_properties.json / .clangd / extraPaths | syncCppProperties / syncClangd / syncPythonPaths |
| `intellisense-utils.ts` | **工具层(路径推导核心)** | collectPrefixes / collectSystemIncludes / collectPythonDirs / **clangdGroupDirs(每包一行消费根,2026-09-07 起;旧称 clangdFlagEntries"顶层+一级子层")** / absIncludeForPkg |
| `intellisense-blacklist.ts` | 黑名单 | — |

核心假设(本次复测对象):
1. 前缀来源 = `CMAKE_PREFIX_PATH + AMENT_PREFIX_PATH + COLCON_PREFIX_PATH`;
2. include 顶层 = `<前缀>/include`,clangd 侧再展开**一级子目录**覆盖 ROS"双层 include"(2026-09-05 行为;2026-09-07 起收敛为每包一行消费根——ws 父根 / env 子根,见文首修订注记);
3. Python 侧 = env.PYTHONPATH **原样条目** + ament_python 包 `pkg.dir`;
4. cpptools includePath 用 `**` 递归通配。

---

## 2. 测试场结构(6 包混合,与代码假设的"覆盖面"对照)

```text
/home/ros2/roa2_ws/src/
├── iii               ament_python  纯 Python  (setup.py / site-packages 体系)
├── lll               ament_cmake   纯 C++     (include/ 实体)
├── p10_mix_deps_std  ament_cmake   C++ + Python 混合(add_library 双 .so + ament_python_install_package)
├── p11_use_adder     ament_cmake   C++ 消费方 (依赖 p10/p12/p13, 多可执行)
├── p12_msgs          ament_cmake   rosidl 接口包(msg/srv → 8 个 .so)
└── p13_msgs          ament_cmake   rosidl 接口包(Box 内嵌 p12/Num + std_msgs/Header, DEPENDENCIES)
```

**安装形态(同一 overlay 混装)**:`iii`=symlink(egg-link);`lll`=symlink(share 软链);`p10/p11/p12/p13`=entity(实体)。

**覆盖意图**:此测试场刻意包含代码假设之外的两类"新增形态"——① 混合包(p10,ament_cmake 但含可 import Python 模块);② rosidl 接口包(p12/p13,include 导出根为 `<prefix>/include/<pkg>` 的"再一层"结构,且自产 Python 消息代码)。

---

## 3. 原始完整环境变量(source 后,2026-09-05)

> 获取:干净终端 `source /opt/ros/humble/setup.bash && source install/setup.bash` 后 `env`。以下为路径类变量**原样全文**(分析用);全部变量名清单 66 个(LS_COLORS 等噪音省略)。

```text
AMENT_PREFIX_PATH=/home/ros2/roa2_ws/install/p13_msgs:/home/ros2/roa2_ws/install/p12_msgs:/home/ros2/roa2_ws/install/p11_use_adder:/home/ros2/roa2_ws/install/p10_mix_deps_std:/home/ros2/roa2_ws/install/lll:/home/ros2/roa2_ws/install/iii:/opt/ros/humble

CMAKE_PREFIX_PATH=/home/ros2/roa2_ws/install/p13_msgs:/home/ros2/roa2_ws/install/p12_msgs:/home/ros2/roa2_ws/install/p11_use_adder:/home/ros2/roa2_ws/install/p10_mix_deps_std:/home/ros2/roa2_ws/install/lll

COLCON_PREFIX_PATH=/home/ros2/roa2_ws/install

PYTHONPATH=/home/ros2/roa2_ws/install/p13_msgs/local/lib/python3.10/dist-packages:/home/ros2/roa2_ws/install/p12_msgs/local/lib/python3.10/dist-packages:/home/ros2/roa2_ws/install/p10_mix_deps_std/local/lib/python3.10/dist-packages:/home/ros2/roa2_ws/build/iii:/home/ros2/roa2_ws/install/iii/lib/python3.10/site-packages:/opt/ros/humble/lib/python3.10/site-packages:/opt/ros/humble/local/lib/python3.10/dist-packages

PATH=/home/ros2/.vscode-server/...(省略 vscode 无关项)...:/opt/ros/humble/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin

LD_LIBRARY_PATH=/home/ros2/roa2_ws/install/p13_msgs/lib:/home/ros2/roa2_ws/install/p12_msgs/lib:/home/ros2/roa2_ws/install/p10_mix_deps_std/lib:/opt/ros/humble/opt/rviz_ogre_vendor/lib:/opt/ros/humble/lib/x86_64-linux-gnu:/opt/ros/humble/lib

ROS_DISTRO=humble
ROS_VERSION=2
ROS_PYTHON_VERSION=3
```

**观测要点(供代码对照)**:
- 接口包 p12/p13 也进 PYTHONPATH(`local/.../dist-packages`)——rosidl 同时生成 Python 消息代码;
- iii(symlink)以 `build/iii` 进 PYTHONPATH(egg-link 语义);
- CMAKE_PREFIX_PATH 只含"有 cmake 导出"的包(无纯 Python 的 iii);`/opt/ros/humble` 由 AMENT 提供。

---

## 4. 验证方法(等价复算,可复现)

按 `intellisense-utils.ts` 算法用 Python 逐行等价实现(collect_prefixes/collectSystemIncludes/absIncludeForPkg/一级子层展开/PYTHONPATH 原样),对本环境生成:
- clangd 侧 `-I` 全集(顶层 + 一级子层);
- python extraPaths 全集(env.PYTHONPATH + ament_python 的 `pkg.dir`);

再对本工作区代码**实际会写出的头文件与 import 目标**做文件系统命中测试。复算脚本全文见**附录 A**。

---

## 5. 验证结果

### 5.1 clangd `-I` 命中(9/9 全中)

| 头文件(真实代码写法) | 命中 -I 根 | 覆盖布局 |
|:--|:--|:--|
| `rclcpp/rclcpp.hpp` | `/opt/ros/humble/include/rclcpp` | 系统双层(一级子层展开) |
| `std_msgs/msg/header.hpp` | `/opt/ros/humble/include/std_msgs` | 系统接口包(一级子层) |
| `sensor_msgs/msg/point_cloud2.hpp` | `/opt/ros/humble/include/sensor_msgs` | 系统接口包(一级子层) |
| `p10_mix_deps_std/adder.hpp` | `install/p10_mix_deps_std/include`(顶层) | 普通 ament_cmake(export include 根) |
| `p10_mix_deps_std/p10_greeting.hpp` | 同上 | header-only |
| `lll/ooo.hpp` | `install/lll/include`(顶层) | 普通 ament_cmake |
| `p12_msgs/msg/num.hpp` | `install/p12_msgs/include/p12_msgs`(**一级子层**) | **rosidl 双层** |
| `p12_msgs/srv/add_two_ints.hpp` | 同上 | rosidl |
| `p13_msgs/msg/box.hpp` | `install/p13_msgs/include/p13_msgs`(一级子层) | **rosidl 嵌套(DEPENDENCIES)** |

> 结论:虽然"rosidl 接口包导出根 = `include/<pkg>`(比普通包多一层)"是本次前身研究中新确认的事实,**gen 代码无需知道也能覆盖**——`clangdFlagEntries` 的"顶层 + 一级子层展开"同时兼容两种 export 根风格。核心路径推导**无需修改**。
>
> ⚠️ *(2026-09-07 注记:该"父子全列以同时兼容 A/B 两套"的策略已收敛为每包一行消费根,结论已失效——见文首修订注记;上表命中行对应的子根在新行集下依旧覆盖,5.1 命中结论不变。)*

### 5.2 cpptools includePath(`**` 递归通配)

`toCppIncludeEntry` 生成 `${workspaceFolder}/.../**`(工作区内)或 `<abs>/**`(系统),`**` 递归足以覆盖 rosidl 的 `include/<pkg>/<pkg>/msg/detail/` 更深层——**无额外风险**。

### 5.3 python extraPaths 命中(3/3 全中)

| import(真实) | 命中 extraPath | 说明 |
|:--|:--|:--|
| `import iii` | `/home/ros2/roa2_ws/build/iii` | iii 为 ament_python(symlink 也覆盖) |
| `import p10_mix_deps_std` | `install/p10_mix_deps_std/local/lib/python3.10/dist-packages` | 混合包 Python(经 env.PYTHONPATH) |
| `import p12_msgs` | `install/p12_msgs/local/lib/python3.10/dist-packages` | **接口包自带 Python**(经 env.PYTHONPATH) |

### 5.4 与"前身"结论一致性

| 前身结论(docs §8) | gen 代码是否自动承载 |
|:--|:--|
| include 导出根两种风格(普通 `include` vs rosidl `include/<pkg>`) | ✅ clangd 一级子层展开覆盖;cpptools `**` 覆盖 ⚠️ *(2026-09-07:clangd 侧已收敛为"每包一行消费根",env 前缀显式收子根 include/<pkg>,见文首注记;cpptools `**` 父级递归不变)* |
| 接口包/混合包注入 PYTHONPATH(dist-packages) | ✅ collectPythonDirs 原样吃 PYTHONPATH |
| symlink vs entity 混装 | ✅ 依各包 hook 注入的 env,逐条进 extraPaths |

---

## 6. 优化建议(按优先级)

### P1(建议评估:混合包源码 Python 未被直接分析)

**现象**:`isPythonPackage` 只收 ament_python;`p10`(ament_cmake 却含 `p10_mix_deps_std/__init__.py`)被归为 C++ → 其**源码**可 import 模块不进 extraPaths,只能靠 env 里**已安装**的 dist-packages 副本(改源码需重建才进分析,与 symlink 开发体验不一致)。

**可选改进(需权衡)**:给"非 ament_python 但含 Python 模块"的包(C++/混合包)追加探测:`pkg.dir` 下是否存在 `__init__.py` 或存在 `setup.py`(本测试场 p10 布局为 `<pkg.dir>/<同名目录>/__init__.py`)→ 命中则把模块父目录加进 extraPaths。
- 优点:混合包/未来"CMake 装 Python"包源码直接可分析;
- 代价:探测成本、可能与 env 已装副本重复(无害,extraPaths 可含多处)。

### P2a(cpptools / clangd 标准不一致,低风险打磨)

`syncCppProperties` 硬编码 `cppStandard: gnu++17`,而 `.clangd` 写 `-std=c++20`。rclcpp 仅需 C++17(`std::variant`),17 够用;但用户代码若用 C++20 特性,cpptools 侧误报。建议:读设置提供 cppStandard(代码中已有 TODO 位置)。

### P2b(无害但可留意)

`collectSystemIncludes` 无条件收录 `<前缀>/include`(含不存在者)。设计注释已声明"无副作用、省 watcher",cpptools browse 会有少量空目录噪音——**维持现状即可**,仅记录。

### P3(测试与文档)

1. `clangdFlagEntries` / `collectSystemIncludes` 等是**纯函数**,建议把 6 包环境固化为无头单元测试夹具,至少覆盖:rosidl 双层(p12/p13)、普通 export include 根(p10)、SYSTEM 关键字。防回归。
2. 建议在环境调研文档补一条:**rosidl 接口包也会注入 PYTHONPATH(`local/lib/python3.10/dist-packages`)**——gen 代码已天然覆盖,但"为什么 PYTHONPATH 那么多条"的说明可补。

---

## 7. 结论

1. **gen 生成代码的路径推导在 6 包复杂环境(普通包 + 混合包 + 两个 rosidl 接口包 + symlink/entity 混装)下 100% 命中**,无需改动核心逻辑。
2. 前身"两种 include 导出根 / 接口包带 Python"的新事实,均被既有算法(一级子层展开 + PYTHONPATH 原样)自动承载。
   ⚠️ *(2026-09-07 注记:前一句的"一级子层展开自动承载两种导出根"随统一约定 B 已收敛为"每包一行消费根"(ws 父根 / env 子根),推导仍需知道"该列哪层"——详见文首修订注记。)*
3. 唯一值得产品化评估的点 = P1(混合包源码 Python 分析);P2/P3 为打磨项。

---

## 附录 A:复算脚本(等价实现 + 命中测试)

> ⚠️ *(2026-09-07 注记:本脚本按 2026-09-05 算法编写——ws 与 env 两侧都做"顶层+一级子层"展开;该行为已被新语义取代(ws 只收父根、env 只收子根),脚本仅作历史命中复算参照,勿照抄为当前实现。)*

```python
import os

ENV = dict(os.environ)
WS = "/home/ros2/roa2_ws"


def collect_prefixes(env):
    out = set()
    for key in ("CMAKE_PREFIX_PATH", "AMENT_PREFIX_PATH", "COLCON_PREFIX_PATH"):
        for part in (env.get(key) or "").split(os.pathsep):
            if part:
                out.add(part)
    return out


def one_level_subs(inc):
    try:
        return [
            os.path.join(inc, e.name)
            for e in os.scandir(inc)
            if e.is_dir() and not e.name.startswith(".")
        ]
    except OSError:
        return []


system_includes = [os.path.join(p, "include") for p in collect_prefixes(ENV)]
src_pkgs = [
    d.name
    for d in os.scandir(os.path.join(WS, "src"))
    if os.path.isfile(os.path.join(WS, "src", d.name, "package.xml"))
]
ws_includes = [os.path.join(WS, "src", p, "include") for p in src_pkgs]

clangd_I = ["-std=c++20"]
for inc in dict.fromkeys(system_includes + ws_includes):
    clangd_I.append("-I" + inc)
    for s in one_level_subs(inc):
        clangd_I.append("-I" + s)

roots = [x[2:] for x in clangd_I if x.startswith("-I")]
tests = [
    "rclcpp/rclcpp.hpp",
    "std_msgs/msg/header.hpp",
    "sensor_msgs/msg/point_cloud2.hpp",
    "p10_mix_deps_std/adder.hpp",
    "p10_mix_deps_std/p10_greeting.hpp",
    "lll/ooo.hpp",
    "p12_msgs/msg/num.hpp",
    "p12_msgs/srv/add_two_ints.hpp",
    "p13_msgs/msg/box.hpp",
]
for h in tests:
    m = [r for r in roots if os.path.isfile(os.path.join(r, h))]
    print(("OK " if m else "MISS") + h, "->", m[0] if m else "-")

extra = (ENV.get("PYTHONPATH") or "").split(os.pathsep) + [
    os.path.join(WS, "src", p) for p in src_pkgs
]
for mod in ["iii", "p10_mix_deps_std", "p12_msgs"]:
    r = [e for e in extra if os.path.isfile(os.path.join(e, mod, "__init__.py"))]
    print(("OK " if r else "MISS") + "import " + mod, "->", r[0] if r else "-")
```
