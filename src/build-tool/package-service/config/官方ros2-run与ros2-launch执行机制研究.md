# 官方 ros2 run 与 ros2 launch 执行机制研究

> 状态：研究结论（2026-09-02）
> 目的：弄清**官方 ROS 2 CLI**（非本扩展封装）的 `ros2 run` / `ros2 launch` 从命令行参数到进程执行的真实机制
> 方法：克隆官方源码研究——ros2cli（ros2run 包）、launch_ros（ros2launch 包）、launch（LaunchService）；对照外部调研（gen/外部调研-ROS2路径映射与intellisense-参考 的 roa2_ws 目录树与 console_scripts 机制链）
> 源码位置：D:\Commonly_used_system_files\Desktop\ros2-src-study\{ros2cli, launch_ros, launch}（git clone --depth 1，main 分支）

---

## 0. 结论先行

- **ros2 run = ament_index 定位 + 子进程执行**：包前缀（AMENT_PREFIX_PATH 索引）→ `<prefix>/lib/<pkg>/` 下可执行文件（X_OK 筛选）→ `subprocess.Popen` 继承当前进程环境执行，信号转发给子进程；
- **ros2 launch = ament_index 定位 + launch 框架事件循环**：包 share 目录找 launch 文件 → `.launch.py` 用 importlib 加载并调 `generate_launch_description()` → `LaunchService`（asyncio 事件循环）访问所有实体、等全部完成自动退出；
- **两者都吃环境变量**（AMENT_PREFIX_PATH 索引），不读源码——与扩展 executable-map（读 setup.py/CMakeLists 的源码侧静态映射）互补；
- 对应外部调研：`install/<pkg>/lib/<pkg>/<cmd>`（console_scripts 命令入口）正是 ros2 run 的查找目标；`install/<pkg>/share/<pkg>/launch` 正是 ros2 launch 的查找目标。

---

## 1. 官方 ros2 run 执行机制

### 1.1 命令入口（ros2cli/ros2run/ros2run/command/run.py，CommandExtension）

argparse 参数：
| 参数 | 说明 |
|---|---|
| `--prefix` | 前缀命令（如 `--prefix 'gdb -ex run --args'`），shlex.split 后插到可执行前 |
| `package_name` | 可选；缺省 → `get_package_names()`（ament_index 全部包名）交互选择 |
| `executable_name` | 可选；缺省 → `get_executable_paths(pkg)` 交互选择 |
| `argv` | `nargs=REMAINDER`，透传给可执行文件 |

### 1.2 定位可执行（ros2run/api/__init__.py + ros2pkg/api/__init__.py）

```
get_executable_path(package_name, executable_name)
  └─ get_executable_paths(package_name)          # ros2pkg.api
       ├─ get_package_prefix(package_name)        # ament_index_python:查 AMENT_PREFIX_PATH 前缀下
       │                                          #   share/ament_index/resource_index/packages 索引文件
       ├─ base_path = <prefix>/lib/<package_name> # ★ 可执行目录约定
       └─ os.walk(base_path): 跳过 "." 开头目录; 保留 os.access(path, os.X_OK) 的文件
  └─ basename 精确匹配 executable_name; Windows 上按 PATHEXT 兼容无扩展名输入
  └─ 多个匹配 → 抛 MultipleExecutables(列出全部路径)
```

### 1.3 执行（run_executable）

```python
cmd = [path] + argv
if os.name == 'nt' and path.endswith('.py'):   # Windows 上 .py 用解释器执行
    cmd.insert(0, sys.executable)
if prefix is not None: cmd = prefix + cmd
process = subprocess.Popen(cmd)               # ★ 继承当前进程完整环境(无显式 env 参数)
signal.signal(SIGINT/SIGTERM, 转发给子进程)     # 信号代理
while process.returncode is None: process.communicate()  # 等待子进程结束
# 非零退出: POSIX 负值(-N=信号 N) → 打印信号名; 否则 'Process exited with failure N'
```

**要点**：Popen 无 env 参数 → 继承**调用进程环境**（扩展经 ShellExecution 注入 getEnv() 后，子进程即继承完整 ROS 环境）；ros2 run 是阻塞式（等子进程结束才返回）。

---

## 2. 官方 ros2 launch 执行机制

### 2.1 命令入口（launch_ros/ros2launch/ros2launch/command/launch.py，CommandExtension）

| 参数/选项 | 说明 |
|---|---|
| 模式 | single file（第一个参数是文件路径）/ pkg file（包名 + launch 文件名） |
| `-n/--noninteractive` | 无终端关联模式 |
| `-d/--debug` | asyncio/日志 debug |
| `-p/--print` | 只打印 LaunchDescription 描述（LaunchIntrospector），不启动 |
| `-s/--show-args` | 打印 launch 文件可接收参数（`<name>:=<value>`） |
| `--launch-prefix` | 给所有可执行加前缀（如 `xterm -e gdb -ex run --args`）；`--launch-prefix-filter` 正则过滤 |
| `launch_arguments` | `nargs='*'`，`<name>:=<value>`（重复后者胜） |

### 2.2 定位 launch 文件（pkg file 模式，ros2launch/api/api.py）

```
get_share_file_path_from_package(package_name, file_name)
  └─ get_package_share_directory(package_name)  # ament_index_python:AMENT_PREFIX_PATH 前缀下
  │                                            #   share/<package_name> 目录(★ launch 文件安装约定)
  └─ os.walk(share 目录) 找同名文件; 0 个 → FileNotFoundError; 多个 → MultipleLaunchFilesError
```

### 2.3 装配（launch_a_launch_file）

```python
launch_service = launch.LaunchService(argv=launch_arguments, noninteractive=..., debug=..., log_file_name=...)
launch_description = launch.LaunchDescription([
    launch.actions.IncludeLaunchDescription(
        AnyLaunchDescriptionSource(launch_file_path),     # 按扩展名分发加载
        launch_arguments=parse_launch_arguments(...),     # '<name>:=<value>' → tuples
    )])
launch_service.include_launch_description(launch_description)
ret = launch_service.run()
```

> 用 IncludeLaunchDescription 包装的原因：为 launch 文件设置"当前位置"，其内部相对路径（相对本文件）才能正确解析。

### 2.4 文件加载（launch/launch/launch_description_sources/）

| 文件类型 | 加载方式 |
|---|---|
| `.launch.py` | `load_python_launch_file_as_module`：**importlib SourceFileLoader 加载模块** → 调用模块内 `generate_launch_description()` 返回 LaunchDescription；无该函数 → InvalidPythonLaunchFileError |
| `.launch.xml` / `.launch.yaml` | launch.frontend.Parser 声明式解析 |
| 未知扩展名 | any_launch_file_utilities 按顺序尝试 |

### 2.5 执行核心（launch/launch/launch_service.py，LaunchService.run）

```
LaunchService.run()
  ├─ include_launch_description → emit IncludeLaunchDescription 事件(入 asyncio 事件队列)
  ├─ 内置 handler: OnIncludeLaunchDescription → visit_all_entities_and_collect_futures(
  │      访问 launch 树全部实体(action), 收集 asyncio future 到 _entity_future_pairs)
  ├─ 主循环 run_async:
  │     · 处理事件队列(_process_one_event → handler.handle)
  │     · 空闲判定 _is_idle(): 实体 future 全 done + 事件队列空 + 无活动 task
  │     · shutdown_when_idle=True(默认): 空闲即优雅 Shutdown → 退出
  │     · 异常 → return_code=1 并继续跑完 shutdown
  ├─ SIGINT: 优雅 shutdown(日志 'user interrupted with ctrl-c'); 二次忽略
  └─ SIGTERM/SIGQUIT: 直接 cancel 主 task(警告可能残留孤儿进程)
```

**要点**：launch 是事件驱动 + asyncio 的进程监督系统——ExecuteProcess 等 action 以 asyncio future 形式运行，全部完成即空闲退出；ros2 launch 阻塞直到 launch 系统结束（Ctrl-C 优雅停）。

---

## 3. 源码位置对照（克隆仓库）

| 内容 | 文件 |
|---|---|
| ros2 run 命令 | ros2cli/ros2run/ros2run/command/run.py |
| ros2 run 定位+执行 | ros2cli/ros2run/ros2run/api/__init__.py（get_executable_path / run_executable） |
| 可执行枚举 | ros2cli/ros2pkg/ros2pkg/api/__init__.py（get_executable_paths） |
| ros2 launch 命令 | launch_ros/ros2launch/ros2launch/command/launch.py |
| ros2 launch 装配 | launch_ros/ros2launch/ros2launch/api/api.py（launch_a_launch_file / get_share_file_path_from_package） |
| launch 文件加载 | launch/launch/launch_description_sources/python_launch_file_utilities.py 等 |
| LaunchService 事件循环 | launch/launch/launch_service.py |

---

## 4. 与扩展 / 外部调研的对照（对一键配置 01 / 一键启动 03 的意义）

| 官方机制 | 对应外部调研（roa2_ws） | 对扩展的意义 |
|---|---|---|
| ros2 run 查 `<prefix>/lib/<pkg>/` X_OK 文件 | `install/iii/lib/iii/sss`（console_scripts 命令入口，无后缀） | ① 一键配置 01 给 python 补 console_scripts / install(PROGRAMS) → 装到 lib/<pkg> 才被 ros2 run 找到；② executable-map 的 consoleScript/cmakeTarget 是**源码侧静态映射**，ros2 run 是**安装产物侧运行时事实**——两者互补；③ 一键启动 03 的 C++ 路必须**先构建**（目标装进 install/<pkg>/lib/<pkg>/），ros2 run 才能定位 |
| ros2 launch 查 share 目录 launch 文件 | `install/iii/share/iii/launch`（data_files 安装项） | 一键配置 01 给 ament_cmake 补 `install(DIRECTORY launch ...)` / python 补 data_files → 不安装则 ros2 launch 找不到；03 的 launch 路依赖安装产物 |
| ament_index（AMENT_PREFIX_PATH 索引） | 环境变量快照（AMENT_PREFIX_PATH 含 install/lll、install/iii、/opt/ros/humble） | 扩展 getEnv() 注入的环境正是官方 CLI 的查找依据——env 不一致则 run/launch 失败，印证"环境以 source 结果为准" |
| ros2 run Popen 继承调用进程环境 | 运行时靠 source 环境变量（外部调研第 1 节） | 扩展任务终端 ShellExecution env 注入 getEnv() = 官方子进程继承的同一份环境 |
| ros2 run 对 Windows .py 插 sys.executable | 命令入口无 .py 后缀（shebang） | Windows 上 console_scripts 入口实际形态（.exe/.cmd）与 Linux 不同，一键启动 03 需平台分支 |
| launch 事件循环 idle 自动退出 | — | ros2 launch 是"监督进程"：节点退出/空闲即整个 launch 结束；03 的 launch 路直接复用官方命令即可，无需在扩展侧模拟 |

---

## 5. 未构建（无 install 产物）时的行为与提前校验（launch 一键启动铺垫）

> 目的：`ros2 launch` 的失败点可拆成三层，扩展在真正执行前逐层预检，确保"命令一定能找到文件/跑起来"。

### 5.1 两种模式的源码事实

| 模式 | 判定 | 是否依赖构建 | 未构建行为 |
|---|---|---|---|
| `ros2 launch <pkg> <name>`（pkg 模式） | 第一个参数不是存在的文件 → `get_share_file_path_from_package` → ament_index 查包 share 目录 | **依赖**（ament_index 包索引仅 install 时生成） | `PackageNotFoundError`（包不在索引）或 `FileNotFoundError`（share 目录无文件）→ RuntimeError |
| `ros2 launch <绝对路径>`（single file 模式） | `os.path.isfile(args.package_name)` → **只判 `os.path.exists`** | **不依赖** | 文件存在即可进入加载；失败仅剩解析错误或运行时依赖 |

### 5.2 三种文件类型在两模式下的可达性

| 文件类型 | pkg 模式（未构建） | 绝对路径模式（未构建） |
|---|---|---|
| `.launch.py` | ❌ 找不到（索引/文件缺失） | ✅ 文件存在即可 importlib 加载 + 调 generate_launch_description() |
| `.launch.xml` / `.xml` | ❌ 同上 | ✅ frontend Parser（launch_xml 注册扩展名） |
| `.launch.yaml` / `.yaml` / `.yml` | ❌ 同上 | ✅ frontend Parser（launch_yaml 注册扩展名） |

> ⚠️ 绝对路径模式的隐性前提：launch **内容**引用包的语句（`PackageShare` / `Node(package=...)` / `IncludeLaunchDescription(PackageShare(...))`）在求值/运行时仍要 ament_index 能找到包——未构建的工作区包会在**运行阶段**报错，但**文件加载与解析阶段不依赖它们**。

### 5.3 三层提前校验（03 一键启动落地）

```
校验1 文件可达性
  绝对路径 → fs.existsSync(文件存在即可, 对齐 os.path.exists)
  pkg 模式 → AMENT_PREFIX_PATH 前缀下 share/<pkg>/ 存在且含同名文件
            (扩展侧静态模拟 get_share_file_path_from_package 的 os.walk)
  └ 失败: 提示'包未构建/未安装'或'包内无此 launch 文件'

校验2 可解析性(不启动, 只加载)
  官方自带只解析不运行通道: ros2 launch -s <file> / -p <file>
  (-s=show-args, -p=print: 都只调 get_launch_description_from_any_launch_file,
   不启动 LaunchService) → 扩展用 commandRunner.exec 预跑一次
  └ 失败: 解析错误(SyntaxError/InvalidLaunchFileError), 提前报给用户

校验3 运行时依赖(内容引用)
  静态扫描 launch 内容引用的包名(PackageShare/FindExecutable/Node(package=...))
  → executable-map / PackageMap 校验包是否可用
  └ 工作区包未构建 → 提示'先构建'(ros2 run/launch 运行时才会暴露, 预检可拦截)
```

### 5.4 ros2 run 的对应预检（同为安装产物依赖）

- ros2 run 未构建必然失败：ament_index + `<prefix>/lib/<pkg>/` X_OK（get_executable_paths）；
- 扩展侧预检 = 静态模拟：`<prefix>/lib/<pkg>/<exe>` 存在且可执行；或 `ros2 pkg executables <pkg>`（commandRunner）确认；
- 对一键启动 03：C++ 文件路必须先构建（目标装进 install/<pkg>/lib/<pkg>/），ros2 run 才能定位——预检失败直接提示先构建。

---
## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-02 00:09 | 建档：克隆官方源码（ros2cli/launch_ros/launch）研究 ros2 run（ament_index→lib/<pkg>/ X_OK→Popen 信号转发）与 ros2 launch（share 定位→importlib 加载 generate_launch_description→LaunchService asyncio 事件循环 idle 退出），对照外部调研与扩展 executable-map/一键配置/一键启动 |
| 2026-09-02 00:16 | 追加第 5 节：未构建行为与提前校验——pkg 模式依赖 ament_index（未构建必然失败）、绝对路径模式仅判文件存在（未构建可运行，内容不引用未安装包时）；三层预检（文件可达性/可解析性 -s -p/运行时依赖）+ ros2 run 对应预检，为 launch 一键启动做铺垫 |