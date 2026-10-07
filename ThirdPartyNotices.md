# Third-Party Notices / 第三方声明

本仓库为二次开发项目,基于下列上游项目修改而成。所有上游项目均以 **MIT 许可证**发布
(完整许可文本见本仓库根目录 [LICENSE](LICENSE)):

| 项目 | 版权声明 | 来源 |
|---|---|---|
| Robot Developer Extensions for ROS 2 | Copyright (c) Ranchhand Robotics. All rights reserved. | https://github.com/ranchhandrobotics/rde-ros-2 |
| ROS extension for Visual Studio Code | Copyright (c) Microsoft Corporation. All rights reserved. | https://github.com/ms-iot/vscode-ros |

依据 MIT 许可证条款,上述版权声明与许可声明已随本仓库副本保留(根 LICENSE 与源码文件头)。
源码中保留的 `Copyright (c) Microsoft Corporation` / `Copyright (c) Ranchhand Robotics`
文件头为上游许可要求的原始声明。

## 运行时依赖

以下 npm 运行时依赖以 MIT(或等价宽松)许可证发布,各自许可证详见其包内 LICENSE:

- `@ranchhandrobotics/rde-common`(MIT,https://github.com/Ranch-Hand-Robotics/rde-common)
- `@lezer/xml`、`js-yaml`、`tmp`、`sudo-prompt`、`xmlrpc`、`dagre`、`shell-quote`、`tslib` 及各 Node polyfill 包(browserify 系)
- Python 助手脚本 `assets/ros/param_helper.py` 仅依赖 ROS 2(rclpy),为本仓库自有代码

## 原生二进制

`native/*.node` 为本仓库源码工程 `walk-native/`(Rust / napi-rs)的编译产物,非第三方二进制。
