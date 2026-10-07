# Commands & features

Once ROS 2 is installed and a workspace is open, these powerful features are available:

## Command Palette

Press `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) to open the Command Palette and type "ROS2" to see all available commands:

* **ROS2: Create Terminal** - creates a terminal with the ROS environment loaded
* **ROS2: Regenerate IntelliSense Configuration (incremental)** - automatically maintains include paths and other IntelliSense configuration for ROS C++/Python development
* **ROS2: Show ROS 2 Status Page** - opens the ROS 2 status page (nodes/topics/services/parameters/lifecycle)
* **ROS2: Install this workspace's ROS dependencies via rosdep** - runs `rosdep` to install dependencies

## Test Explorer

The extension integrates with the VS Code Test Explorer:

* automatic discovery of ROS 2 tests
* run individual tests or whole suites
* inline test results

## IntelliSense

Get smart completions and documentation:

* **Message files** - hover a message type to see its field definitions
* **Go to definition** - jump to message/service/action definitions
* **Completion** - smart suggestions for ROS message fields

## Build integration

The extension creates build tasks automatically:

* press `Ctrl+Shift+B` to build your workspace
* builds packages with `colcon`
* integrates a compiler-error parser

## Learn more

* Type "ROS2" in the Command Palette to discover all commands (build, create C++/Python/mixed packages, run executables, launch files, Doctor diagnostics, etc.)
* Extension documentation lives in the repository `docs/` directory (usage / tutorials / test explorer / configuration / IntelliSense / troubleshooting)

---

# 命令与功能（中文）

安装 ROS 2 并打开工作区后,你就可以使用这些强大的功能:

## 命令面板

按 `Ctrl+Shift+P`(macOS 上为 `Cmd+Shift+P`)打开命令面板,输入 "ROS2" 即可查看所有可用命令:

* **ROS2: 创建终端** - 创建一个已加载 ROS 环境的终端
* **ROS2: 重新生成智能感知配置(补写)** - 为 ROS C++/Python 开发自动维护 include 路径等 IntelliSense 配置
* **ROS2: 打开 ROS 2 状态页(服务/话题/参数监控)** - 打开 ROS 2 状态页(节点/话题/服务/参数/生命周期)
* **ROS2: 使用 rosdep 安装此工作区的 ROS 依赖** - 运行 `rosdep` 安装依赖

## 测试资源管理器

扩展集成了 VS Code 的测试资源管理器:

* 自动发现 ROS 2 测试
* 运行单个测试或整个测试套件
* 内联查看测试结果

## IntelliSense

获得智能代码补全和文档:

* **消息文件** - 悬停消息类型即可查看字段定义
* **跳转到定义** - 跳转到消息/服务/动作定义
* **自动补全** - 获取 ROS 消息字段的智能建议

## 构建集成

扩展自动创建构建任务:

* 按 `Ctrl+Shift+B` 构建你的工作区
* 使用 `colcon` 构建包
* 集成编译器错误的解析器

## 了解更多

* 在命令面板输入 "ROS2" 可发现全部命令(构建、生成 C++/Python/混合包、运行可执行文件、启动 launch 文件、Doctor 诊断等)
* 扩展文档见仓库 `docs/` 目录(使用/教程/测试资源管理器/配置/智能感知/故障排查)
