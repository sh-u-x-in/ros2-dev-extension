# ROS 2 Robot Development Extension (RDE for ROS 2)

English | [简体中文](../zh-cn/index.md)

A Visual Studio Code extension supporting [Robot Operating System 2 (ROS 2)](https://www.ros.org) development on Windows, Linux and macOS. Robot Operating System is a trademark of Open Robotics.

![Package contents sidebar and ROS 2 status page](../assets/package-sidebar.png)

## Features

* Automatic ROS environment setup (supports pixi and custom setup scripts).
* [ROS 2 status page](usage.md): one-click resident helper to inspect nodes / topics / services / parameters / lifecycle; subscribe to topics, call services, send action goals.
* [Package contents sidebar](usage.md): browse each package's executables, launch files, Python exports, resources and headers based on the actual install directory, with inline run / build buttons.
* Automatic `colcon` build & test task creation; the build command is fully customizable via a settings template, with pre-build install-method and layout conflict checks.
* `ros2 run` / `ros2 launch` with argument presets and per-target memory.
* Syntax highlighting and [language services](intellisense.md) (completion / hover / definition / diagnostics) for `.msg`, `.urdf`/`.xacro` and launch files.
* Python and C++ code snippets to speed up development.
* Automatic ROS C++ include paths and Python import paths (cpptools / clangd engines).
* Format C++ using the ROS `clang-format` style.
* [Discover and run ROS 2 tests](test-explorer.md) (C++ gtest and Python pytest) through the integrated Test Explorer.
* Package creation wizard: scaffold C++ / Python / mixed packages with a dependency picker and naming validation.
* UI available in English and Simplified Chinese (follows the VS Code display language).

> **Development status:** this extension is under rapid active development and has been primarily tested on Linux (ROS 2 Humble). Windows has not been systematically tested and may behave unexpectedly (the status page in particular) — feedback via the issue tracker is welcome.

## Acknowledgements

This project is derived from [ranchhandrobotics/rde-ros-2](https://github.com/ranchhandrobotics/rde-ros-2) and [ms-iot/vscode-ros](https://github.com/ms-iot/vscode-ros) (both MIT licensed), with thanks; see [ThirdPartyNotices](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/ThirdPartyNotices.md) in the repository root.
