# ROS2 路径映射 / import / intellisense 外部调研参考

> 来源：D:\Commonly_used_system_files\Desktop\roa2_ws\docs（2026-08-25 调研，ROS 2 Humble，含 iii 纯 Python 包 + lll C++ 包）
> 关联：本模块 gen/intellisense-config.ts（c_cpp_properties / python extraPaths / .clangd 生成）、exe-map/parse/setup-parser.ts（consoleScripts）、exe-map/executable-map.ts（ExecutableEntry.kind = consoleScript）
> 性质：外部实测结论整理（含改进点对照），非本扩展自身代码

---

## 1. 总结（TL;DR）

1. **Python import Python 永远不需要头文件**——只要包在 `PYTHONPATH`（运行时）或 `extraPaths`（Pylance）里。
2. **头文件只在 C++ 依赖 C++ 时才有意义**：包须 `install(DIRECTORY include/ ...)` + `ament_export_include_directories(include)`，之后 `-I` 才能从 `AMENT_PREFIX_PATH` 前缀拼出真实目录。
3. **分析器（Pylance/clangd）不继承终端环境**：VS Code 子进程环境启动时固化，必须把路径写进 `.vscode/settings.json`，否则必然红波浪线。
4. **运行时靠 source 出的环境变量；分析器靠 settings.json 固化路径**——两条通道互不替代。
5. **设计取两种构建模式（`--symlink-install` 与默认）的共性，不关注符号链接与否**：两模式运行时 import 都靠 `PYTHONPATH` 注入目录（symlink 额外含 `build/<pkg>`、默认含 `install/.../site-packages`）；C++ 头文件都靠 `AMENT_PREFIX_PATH` 拼 `/include`；分析器都不继承终端环境。配置生成**以环境变量为准、不感知链接方式**，减少设计难度。
6. **ROS2 include 是"双层"结构**（`include/<pkg>/<pkg>/xxx.hpp`）：`c_cpp_properties.json` 的 `/**` 天然覆盖；`.clangd` 不支持递归通配，必须**逐层显式**列出**消费根一层**(2026-09-07 语义:工作空间 src 包 = `<pkg>/include` 父根;install/发行版前缀 = 各包子根 `include/<pkg>`,不再父子并列全列)且**必须** `-std=c++20`（rclcpp 用 C++17 特性）。

---

## 2. 环境变量语义与映射方法论

| 变量 | 条目语义 | 映射动作 | 映射到 |
|---|---|---|---|
| `PYTHONPATH` | 直接搜索目录 | 原样 | `python.analysis.extraPaths` |
| `AMENT_PREFIX_PATH` | 前缀 | 拼 `/include` | clangd 的 `-I` |
| `AMENT_PREFIX_PATH` | 前缀 | 拼 `/lib/python3.10/site-packages` | 即 PYTHONPATH 的来源 |
| `CMAKE_PREFIX_PATH` | 前缀 | 拼 `/include`、`/lib`、`/share` | CMake 查找包 |

- `PYTHONPATH` 给的是"现成的搜索目录"（加包名即到包）；`AMENT_PREFIX_PATH` / `CMAKE_PREFIX_PATH` 给的是"前缀"，必须自己拼子目录。
- 从 AMENT_PREFIX_PATH 推导 include：每个前缀拼 `/include` 并检测存在（纯 Python 包如 iii 无头文件目录，拼出不存在 → 跳过）。

## 3. 构建模式共性（设计取共性，不关注符号链接）

> 原则：不区分 `--symlink-install` 与默认模式，只取**两种模式都成立**的共性，作为配置生成的依据；symlink 差异细节仅备查（见第 7 节快照），不进入设计。

| 共性点 | 说明 | 对配置生成的意义 |
|---|---|---|
| import 靠 PYTHONPATH | 两模式运行时 import 都依赖 PYTHONPATH 注入的搜索目录（symlink 额外注入 `build/<pkg>`；默认注入 `install/.../site-packages`；两模式都有 `install/.../site-packages`） | extraPaths **以 env.PYTHONPATH 为准**（TS 读 env，不猜目录、不感知链接方式） |
| C++ 头文件靠前缀拼 /include | 两模式一致：`AMENT_PREFIX_PATH` / `CMAKE_PREFIX_PATH` 前缀拼 `/include` 即真实目录 | 系统 include 以此生成，无需感知符号链接 |
| 分析器不继承终端环境 | 两模式一致：VS Code 子进程环境启动时固化 | 必须固化 settings.json / .clangd |
| console_scripts 入口形态 | 两模式一致：`install/<pkg>/lib/<pkg>/<cmd>` 无后缀命令 | 一键启动（03）直接 `ros2 run <pkg> <cmd>` |

> 一句话：**设计只依赖环境变量内容（PYTHONPATH / AMENT_PREFIX_PATH / CMAKE_PREFIX_PATH），不依赖包是怎么安装的（符号链接与否）**——本地环境给什么变量就收什么目录。

## 4. console_scripts 机制链（iii 的 sss 命令，对应 executable-map 的 consoleScript 入口）

```
setup.py entry_points 'sss = iii.sss:main'
  → build/iii/iii.egg-info/entry_points.txt
  → install/iii/lib/iii/sss（无 .py 后缀，shebang #!/usr/bin/python3，EASY-INSTALL-ENTRY-SCRIPT）
  → 运行时 load_entry_point 动态加载 build/iii/iii/sss.py 的 main()
```

- `install/<pkg>/lib/<pkg>/<cmd>` 是**命令入口（无后缀）**，运行方式：`ros2 run <pkg> <cmd>`；它依赖 `build/<pkg>/<pkg>.egg-info` 可达。
- 已知坑（Humble）：rclpy **不支持 `with rclpy.init()` 上下文管理器**（Jazzy+ 才支持），须用传统 try/finally + `rclpy.shutdown()`。

## 5. clangd / c_cpp_properties 双层 include 关键结论

| 工具 | 写法 | 递归通配 | 覆盖双层 |
|---|---|---|---|
| `c_cpp_properties.json` | `"/opt/ros/humble/include/**"` | ✅ `/**` | ✅ 自动 |
| `.clangd` | `-I<src include 父根>` / `-isystem<include/<pkg> 子根>` | ❌ 不支持 | ✅ 每包一行消费根显式列出(2026-09-07) |

- `/**` 不会导致头文件错位：include 搜索 = "目录列表 + 相对路径拼接"，只有完全匹配才命中，多余目录只跳过。
- `.clangd` 必须满足三件事：`-std=c++20`（rclcpp 用 C++17 特性） + 逐层显式 + **每包一行消费根**（2026-09-07 起：工作空间 src 包列 include 父根、install/发行版前缀只列各包子根 `include/<pkg>`——B 双层下父行无解析力、src 包子行冗余，不再"父子并列"；TS 内化 readdir 生成，不跑 sh 脚本）。
- 报错对照：`pp_file_not_found: rclcpp/rclcpp.hpp` → `-I` 层不对；`no template named 'variant'` → 缺 `-std=c++20`；改 `.clangd` 后需重启 clangd 生效。

## 6. 与 config 模块的关联与改进点（重点）

对照 `gen/intellisense-config.ts` 现有实现：

| # | 现有实现 | 外部调研结论 | 差距 / 改进方向 |
|---|---|---|---|
| 1 | c_cpp_properties 用 `${workspaceFolder}/.../**` includePath | `/**` 支持双层 ✅ | 基本一致，无需改 |
| 2 | `.clangd` 生成 `-I<包 include>`（顶层，不展开子包层） | `.clangd` 不支持递归通配，须**逐层展开** `include/<pkg>/` 层 + `-std=c++20` | ✅ 已落地(2026-09-07)：工作空间只列 src include 父根、install/发行版前缀只列各包子根 `include/<pkg>`（不再父子并列）；`-std=c++20` 恒写(2026-09-02 起) |
| 3 | `syncPythonPaths` 只收集含 setup.py 的目录（src/ 或包根） | 共性结论：extraPaths 应以 env.PYTHONPATH 为准，其注入目录（含 build/<pkg>、site-packages、第三方路径）都应收 | 🔴 现有实现漏 PYTHONPATH 注入的非工作区/构建目录 |
| 4 | `getSystemIncludeDirs()` 注入 ros2/ 环境 AMENT/CMAKE_PREFIX_PATH 下 include | 系统 `/opt/ros/humble/include` 下约 106 个子包目录，手动展开不现实；需逐层展开（TS 遍历子目录）或依赖 c_cpp_properties 的 `/**` | ✅ 已定(2026-09-07)：`.clangd` 环境组 readdir 前缀 include 得各包子根 `include/<pkg>` 并渲染 `-isystem`（不再收 include 父根）；c_cpp_properties 走 `/**` 递归豁免，维持父级收录 |
| 5 | `exe-map/parse/setup-parser.ts`(原 parse/setup-parser.ts,2026-09-03 收敛)解析 console_scripts 得 `ConsoleScript{name,module,func}` | 实测入口形态：`install/<pkg>/lib/<pkg>/<cmd>` 无后缀命令，`ros2 run <pkg> <cmd>` 运行 | 与 executable-map 的 `ExecutableEntry.kind = "consoleScript"` 语义一致 ✅；一键启动（03）可据此直接 `ros2 run` |

**本地内化（不用 sh 运行，用 TS 内置覆盖）**：外部 `env_to_settings.sh` / `gen_clangd_include.sh` 仅作**逻辑来源参考**，实现一律用 **TS 内置能力**（`fs.promises` / `path`）直接内化，**不调用、不依赖 sh 脚本运行**：
- env_to_settings.sh 的逻辑 → 内化为 TS 函数：读 env.PYTHONPATH / AMENT_PREFIX_PATH → 拼 /include / 原样收 extraPaths → `fs.promises.access` 检测存在；
- gen_clangd_include.sh 的逻辑 → 内化为 TS 目录遍历：readdir 前缀 include 子目录展开 `include/<pkg>/` 消费根（2026-09-07 起仅**环境前缀**展开子根、**工作空间 src include 直接收父根**，不再两处都父子并列）。

## 7. 原始快照（保留备查）

> ⚠️ 以下为外部实测原始数据，含 symlink 特异细节（build/ 注入、符号链接等），**仅供备查，不进入设计**；设计依据见第 3 节共性结论。

### 环境变量（symlink / 非 symlink 两版一致，即共性的实测证据）
```
AMENT_PREFIX_PATH: /home/ros2/roa2_ws/install/lll /home/ros2/roa2_ws/install/iii /opt/ros/humble
PYTHONPATH(symlink): /home/ros2/roa2_ws/build/iii ← 额外注入; 另含 install/iii/.../site-packages 与 /opt/ros/humble/...
PYTHONPATH(非symlink): 无 build/iii; 含 install/iii/.../site-packages 与 /opt/ros/humble/...
CMAKE_PREFIX_PATH: /home/ros2/roa2_ws/install/lll
```

### 工作区结构（symlink，摘要）
```
roa2_ws/
├── build/  iii(egg-link 符号链接到 src) + lll(ament_cmake 构建产物) + COLCON_IGNORE
├── install/ iii/lib+share, lll/include+lib+share, setup.*/local_setup.*
├── log/    latest -> latest_build -> build_2026-08-25_17-55-12
├── ros2share -> /home/ros2/ros2share
└── src/    iii(Python: iii/ + package.xml + setup.py + setup.cfg + resource + test)
             lll(C++: CMakeLists.txt + include + src + package.xml)
```

### 常用命令速查
```bash
source /opt/ros/humble/setup.bash && source <ws>/install/setup.bash   # 执行前必须主动 source
colcon build --symlink-install [--packages-select <pkg>]
ros2 run <pkg> <cmd>
echo "$PYTHONPATH" | tr ':' '\n'      # 查看环境变量
echo "$AMENT_PREFIX_PATH" | tr ':' '\n' | while read p; do inc="$p/include"; [ -d "$inc" ] && echo "存在: $inc" || echo "不存在: $inc"; done
```

---

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-01 21:01 | 建档：读取 D:\Commonly_used_system_files\Desktop\roa2_ws\docs（7 个文件：路径映射与导入结论.md + 4 份快照 + 2 个工具脚本），总结并落位本参考文档，对照 gen/intellisense-config.ts 列出改进点 |
| 2026-09-01 21:09 | 移动至 gen/ 并改名（原 REFERENCE.md，中文文件名） |
| 2026-09-01 23:56 | 按用户意见内化：① 删除 symlink/非 symlink 差异关注，第 1/3/6 节改为"取两种构建模式共性"（设计以环境变量为准、不感知链接方式）；② 工具脚本改为"TS 内置内化"（fs/path 实现，不跑 sh），第 5/6/7 节同步去 sh 依赖 |
| 2026-09-02 00:21 | 第 6 节改进点已实施（2026-09-02）：① extraPaths 以 env.PYTHONPATH 为准（getPythonSearchDirs 注入）；② .clangd 子包层展开 + -std=c++20；③ onEnvChanged 环境变化增量更新；④ COLCON_PREFIX_PATH 并入前缀源。TS 本地内化落地（无 sh 脚本） |
| 2026-09-02 00:23 | 自包含化：getSystemIncludeDirs/getPythonSearchDirs 注入回调删除，改注入 getEnv 原语，提取逻辑（前缀→include 检测、PYTHONPATH 拆分）内化于 intellisense-config.ts（对齐"TS 内置内化、不增加组合根复杂度"原则） |
| 2026-09-02 00:27 | 注入形态重构：getEnv/onEnvChanged 两原语 → 单个 environment 门面对象注入（IntellisenseEnvSource 窄接口，vscode.Disposable 结构化兼容），前缀/PYTHONPATH 裁切完全内化于 intellisense-config.ts，组合根零裁切（参考 ros2/api 纯接口 + environment 自包含模式） |
| 2026-09-02 10:07 | 追踪机制落地：包/环境变化事件驱动 + 800ms 防抖合并 + 增量补新（易增难删：新包自动加、删除不自动删、保守匹配），包变化不再只走 0→1 单次生成 |
| 2026-09-02 10:12 | 实现升级：有感删除（正常删/出现情况回退）+ 黑名单（state 文件持久化防覆盖）+ 引擎开关（intellisenseEngine 控制 cpptools/clangd 侧）；文件分裂为 api/utils/render/blacklist/config 五层（对齐 ros2/api + environment 自包含结构） |
| 2026-09-03 14:07 | 路径同步:关联行与表 5 的 parse/setup-parser.ts 改 exe-map/parse/setup-parser.ts(原 parse/,2026-09-03 收敛) |
| 2026-09-07 22:44 | `.clangd` 行集层级收敛为【约定 B】「每包一行消费根」：工作空间组只列 `-I<ws>/src/<pkg>/include` 父根（不再展开 include/<pkg> 子行）；环境前缀组只列各包子根 `-isystem<prefix>/include/<pkg>`（不再列 include 父根；**无任何子目录的前缀——缺失/空/纯 Python·无头包——不产出行**）。理由：Humble+ 官方/rosidl 双层布局统一后，父行对 B 安装头无解析力、子行对 src 冗余——旧「顶层+一级子层」全列是 2026-09-06 为兼容 A/B 两套导出根所做的过渡。同步：syncClangd 归正清除旧 env 父行 / 旧 ws 子行 / 错位 -I；本表第 5/6 节与 TL;DR 措辞更新；cpptools 侧维持 `/**` 父级递归不变。涉及 intellisense-utils.ts / intellisense-render.ts（单测 24 项全绿） |
| 2026-09-07 22:54 | 溯源补登：上文 22:44 行用例数 23→24（新增"无子目录前缀不产出行"用例）；"include watcher 触发补行"过期表述已从代码注释/README 清除（该 watcher 2026-09-02 10:46 加、10:49 删，事件源仅包+环境两路） |