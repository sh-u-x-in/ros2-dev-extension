# Robot Developer Extensions for ROS 2 (RDE for ROS 2)

A Visual Studio Code extension supporting [Robot Operating System 2 (ROS 2)](https://www.ros.org) development on Windows, Linux and macOS.

> This project is derived from [ranchhandrobotics/rde-ros-2](https://github.com/ranchhandrobotics/rde-ros-2) and
> [ms-iot/vscode-ros](https://github.com/ms-iot/vscode-ros) (both MIT licensed), with thanks; see the license details at the bottom and [ThirdPartyNotices](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/ThirdPartyNotices.md).

> 🇨🇳 中文说明:[README.zh-CN.md](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/README.zh-CN.md)

## Features

* **Automatic ROS environment setup** — Detects the distribution and loads the environment when a ROS 2 workspace opens; supports `pixi` environments and custom setup scripts, and re-collects automatically when shell configuration files change.
* **ROS 2 status page** — Start the extension's resident helper (an rclpy process talking to DDS directly) with one click to inspect nodes / topics / services / parameters / lifecycle; subscribe to topics, call services, send action goals (structured forms), and open oversized parameters as full content.
* **Package contents sidebar** — Shows each package's executables, launch files, Python exports, resources and headers based on the actual install directory; inline run / build buttons and click-to-source navigation.
* **Build integration** — `Ctrl+Shift+B` smart build (multi-select packages + argument presets); the build command is fully customizable via a settings template; pre-build checks catch install-method (symlink/copy) and layout (merged/isolated) conflicts with fix suggestions.
* **Run & launch** — `ros2 run` / `ros2 launch` with argument presets and per-target memory; targets never cross-contaminate.
* **Testing** — Integrated with the VS Code Test Explorer: discovers C++ gtest and Python pytest tests automatically, with run/debug and result parsing.
* **Language services** — Completion, hover, definition, formatting and diagnostics for `.msg`/`.srv`/`.action`; include-graph-driven navigation, hover, completion and D1-D14 diagnostics for `.xacro`/`.urdf`; launch files (py/XML/YAML) completion and include navigation.
* **IntelliSense configuration** — Automatically maintains include paths for cpptools and clangd (selectable engine) and merges `compile_commands.json`.
* **Package creation wizard** — Generates C++ / Python / mixed packages: built-in dependency picker, naming and reserved-name validation, launch/resource templates.
* **ROS 2 terminal** — Creates terminals with the ROS environment pre-loaded (bash/zsh/fish/pwsh/cmd all supported); right-click a folder to build or scaffold quickly.
* **rosdep / Doctor** — Shortcuts for `rosdep` dependency installation and `ros2 doctor` diagnostics.
* **Bilingual UI** — English and Simplified Chinese interfaces, following the VS Code display language.

## Getting started

1. Install the extension (the C/C++ and Python extension dependencies are installed automatically).
2. Open a ROS 2 workspace containing a `package.xml`; the extension activates and loads the environment automatically.
3. Click the ROS distribution tag on the bottom status bar to open the status page; use the "ROS 2 Packages" icon in the activity bar for the package contents view.

## Development status

This extension is under **rapid active development** — features and behavior may change between versions. Development and testing were done primarily on Linux (ROS 2 Humble); Windows has not been systematically tested, so unexpected behavior is possible there (the status page in particular). If you run into problems, please report them at [Issues](https://github.com/sh-u-x-in/ros2-dev-extension/issues) — feedback directly drives what gets fixed next.

## Configuration

Key settings (see [docs/configuration.md](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/docs/configuration.md)):

* `ROS2.env.*` — distribution / setup script / pixi environment;
* `ROS2.build.shareSpec` / `ROS2.run.shareSpec` / `ROS2.launch.shareSpec` — the template & preset mechanism for the three commands;
* `ROS2.build.symlinkInstall` / `ROS2.build.installLayout` — install method and layout;
* `ROS2.search.*` — workspace scan exclusions, symlink following and timeouts.

## Documentation

Full documentation (usage / tutorials / testing / configuration / IntelliSense / troubleshooting) lives in the repository [docs/ directory](https://github.com/sh-u-x-in/ros2-dev-extension/tree/main/docs).

## Support

Please report problems at [Issues](https://github.com/sh-u-x-in/ros2-dev-extension/issues) with the ROS distribution,
operating system, reproduction steps and relevant logs from the "ROS 2" output channel.

## Contributing

Issues and PRs are welcome; see [CONTRIBUTING.md](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/CONTRIBUTING.md).

## License & acknowledgements

This project is released under the [MIT License](https://github.com/sh-u-x-in/ros2-dev-extension/blob/main/LICENSE).
Derived from Ranch Hand Robotics' [rde-ros-2](https://github.com/ranchhandrobotics/rde-ros-2)
and Microsoft's [vscode-ros](https://github.com/ms-iot/vscode-ros); upstream copyright notices are retained per their terms.
