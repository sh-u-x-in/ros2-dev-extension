# ROS 2 机器人开发扩展(RDE for ROS 2)

> 🇬🇧 English: [README.md](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/README.md)

一个 Visual Studio Code 扩展,为 Windows、Linux 和 macOS 上的 [机器人操作系统 2(ROS 2)](https://www.ros.org) 开发提供支持。

![包内容侧边栏与 ROS 2 状态页](docs/assets/package-sidebar.png)

> 本项目衍生自 [ranchhandrobotics/rde-ros-2](https://github.com/ranchhandrobotics/rde-ros-2) 与
> [ms-iot/vscode-ros](https://github.com/ms-iot/vscode-ros)(均为 MIT 许可),在此致谢;许可详情见文末与 [ThirdPartyNotices](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/ThirdPartyNotices.md)。

## 功能特性

* **自动配置 ROS 环境** —— 打开 ROS 2 工作区自动检测发行版并加载环境;支持 `pixi` 环境与自定义 setup 脚本,shell 配置文件变化自动重新采集。
* **ROS 2 状态页** —— 一键启动扩展自带的常驻助手(rclpy 进程,DDS 直连),查看节点 / 话题 / 服务 / 参数 / 生命周期;支持订阅话题、调用服务、发送动作目标(结构化表单),大参数可一键打开完整内容。
* **包内容侧边栏** —— 以 install 目录实际内容为准展示每个包的可执行文件、launch 文件、Python 导出、资源与头文件;行内一键运行 / 构建,点击跳转源码。
* **构建集成** —— `Ctrl+Shift+B` 智能构建(多选包 + 参数多选);构建命令由设置中的模板决定,可完全自定义;构建前主动预检安装形态(符号/拷贝)与布局(合并/分包)冲突并给出修复建议。
* **运行与启动** —— `ros2 run` / `ros2 launch` 支持参数预设与按目标记忆,同一命令不同目标互不串档。
* **测试** —— 集成 VS Code 测试资源管理器:自动发现 C++ gtest 与 Python pytest 测试,支持运行/调试与结果解析。
* **语言服务** —— `.msg`/`.srv`/`.action` 的补全、悬停、跳转、格式化与诊断;`.xacro`/`.urdf` 的 include 图驱动的跳转、悬浮、补全与 D1-D14 诊断;launch 文件(py/XML/YAML)补全与 include 跳转。
* **智能感知配置** —— 自动维护 cpptools 与 clangd 的 include 路径(可选引擎),合并 `compile_commands.json`。
* **包创建向导** —— 生成 C++ / Python / 混合包:内置常用依赖选择、命名与保留名校验、launch/资源模板。
* **创建 ROS 2 终端** —— 预加载 ROS 环境的终端(bash/zsh/fish/pwsh/cmd 均支持),右键目录可快速构建或生成包。
* **rosdep / Doctor** —— 快捷执行 `rosdep` 安装依赖与 `ros2 doctor` 诊断。
* **界面双语** —— 英文与简体中文界面,跟随 VS Code 显示语言。

## 入门

1. 安装本扩展(会自动安装 C/C++ 与 Python 扩展依赖)。
2. 打开一个包含 `package.xml` 的 ROS 2 工作区,扩展自动激活并加载环境。
3. 点击左下角状态栏的 ROS 发行版标签打开状态页;活动栏「ROS 2 包」图标打开包内容视图。

## 开发状态说明

本扩展正处于**快速迭代**阶段,功能与行为可能随版本调整。开发与测试主要在 Linux(ROS 2 Humble)环境完成,Windows 未经系统化测试,可能存在意外情况(状态页尤甚)。遇到问题欢迎到 [Issues](https://github.com/sh-u-x-in/ros2-dev-extension/issues) 反馈——你的反馈直接决定下一步修什么。

## 配置

主要设置(见 [docs/configuration.md](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/docs/zh-cn/configuration.md)):

* `ROS2.env.*` —— 发行版 / setup 脚本 / pixi 环境;
* `ROS2.build.shareSpec` / `ROS2.run.shareSpec` / `ROS2.launch.shareSpec` —— 三条命令的模板与预设机制;
* `ROS2.build.installMethod` / `ROS2.build.installLayout` —— 安装形态(auto / symlink / copy)与布局;
* `ROS2.search.*` —— 工作区扫描的排除目录、符号链接跟随与超时。

## 文档

完整文档(使用 / 教程 / 测试 / 配置 / 智能感知 / 故障排查)见仓库 [docs/ 目录](https://github.com/sh-u-x-in/ros2-dev-extension/tree/main/docs)。

## 支持

遇到问题请到 [Issues](https://github.com/sh-u-x-in/ros2-dev-extension/issues) 反馈,附上 ROS 发行版、
操作系统、复现步骤,以及输出面板「ROS 2」通道的相关日志。

## 贡献

欢迎 Issue 与 PR,见 [CONTRIBUTING.md](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/CONTRIBUTING.md)。

## 许可与致谢

本项目以 [MIT 许可证](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/LICENSE)发布。
衍生自 Ranch Hand Robotics 的 [rde-ros-2](https://github.com/ranchhandrobotics/rde-ros-2)
与 Microsoft 的 [vscode-ros](https://github.com/ms-iot/vscode-ros),依其条款保留上游版权声明。
