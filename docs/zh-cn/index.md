# ROS 2 机器人开发扩展 (RDE for ROS 2)

[English](../en/index.md) | 简体中文

一个支持 [机器人操作系统 2(ROS 2)](https://www.ros.org) 开发的 Visual Studio Code 扩展,覆盖 Windows、Linux 与 macOS。Robot Operating System 是 Open Robotics 的商标。

![包内容侧边栏与 ROS 2 状态页](../assets/package-sidebar.png)

## 功能

* 自动检测并配置 ROS 环境(支持 pixi 与自定义 setup 脚本)。
* [ROS 2 状态页](usage.md):常驻助手一键启停,查看节点 / 话题 / 服务 / 参数 / 生命周期;订阅话题、调用服务、发送动作目标。
* [包内容侧边栏](usage.md):以 install 目录实际内容为准浏览每个包的可执行文件、launch 文件、Python 导出、资源与头文件,行内一键运行 / 构建。
* 自动创建 `colcon` 构建与测试任务;构建命令模板可完全自定义,构建前预检安装形态与布局冲突。
* `ros2 run` / `ros2 launch` 参数预设与按目标记忆。
* `.msg`、`.urdf`/`.xacro`、launch 文件等 ROS 文件的语法高亮与[语言服务](intellisense.md)(补全 / 悬停 / 跳转 / 诊断)。
* Python、C++ 代码[片段](snippets.md)加速开发。
* 自动维护 ROS C++ include 路径与 Python 导入路径(cpptools / clangd 双引擎)。
* 使用 ROS 的 `clang-format` 风格格式化 C++。
* 通过集成[测试资源管理器](test-explorer.md)发现并运行 ROS 2 测试(C++ gtest 与 Python pytest)。
* 包创建向导:生成 C++ / Python / 混合包,内置依赖选择与命名校验。
* 界面支持英文与简体中文(跟随 VS Code 显示语言)。

> **开发状态说明**:本扩展处于快速迭代中,开发测试以 Linux(ROS 2 Humble)为主;Windows 未经系统化测试,可能存在意外情况(状态页尤甚)——欢迎到 issue 跟踪器反馈。

## 致谢

本项目衍生自 [ranchhandrobotics/rde-ros-2](https://github.com/ranchhandrobotics/rde-ros-2) 与 [ms-iot/vscode-ros](https://github.com/ms-iot/vscode-ros)(均 MIT 许可),在此致谢;详见仓库根 [ThirdPartyNotices](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/ThirdPartyNotices.md)。
