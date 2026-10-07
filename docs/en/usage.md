# Usage

## Package Contents Sidebar

Open the **ROS 2 Packages** icon in the Activity Bar to browse every package in your workspace based on the *actual install directory* — executables, launch files, Python exports, resources and headers — with inline run / build buttons and click-to-source navigation. The status page (opened from the status bar) shows live nodes / topics / services / parameters and a lifecycle state graph with transition controls:

![Package contents sidebar, status page with lifecycle graph, run parameter box and source navigation](../assets/package-sidebar.png)

## Commands

Access the following commands from the [Command Palette](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette) (`Ctrl+Shift+P`):

| Name | Description |
|---|:---|
| ROS2: Create Terminal | Create a terminal with the ROS environment pre-loaded. |
| ROS2: Open ROS 2 Status Page | Open the status page (nodes / topics / services / parameters / lifecycle). |
| ROS2: Run ROS Executable (ros2 run) | Pick a package and executable, with argument presets and per-target memory. |
| ROS2: Run ROS Launch File (ros2 launch) | Pick a launch file, with argument presets and per-target memory. |
| ROS2: Build ROS 2 Packages | Smart `colcon build`: multi-select packages, then pick extra argument presets. |
| ROS2: Regenerate IntelliSense Configuration (incremental) | Re-sync cpptools / clangd include paths and `compile_commands.json`. |
| ROS2: Install This Workspace's ROS Dependencies via rosdep | Shortcut for `rosdep install --from-paths src --ignore-src -r -y`. |
| ROS2: Run ros2 doctor to Diagnose ROS 2 Issues | Run `ros2 doctor` in a ROS terminal. |
| ROS2: Refresh Test Discovery / Run All Tests | Drive the [Test Explorer](test-explorer.md). |
| ROS2: Show Getting Started | Open the walkthrough. |

Right-clicking a folder in the Explorer offers **Toggle Colcon Ignore**, **Colcon Build (Release/Debug)** and the three **Create Package** wizards (C++ / Python / mixed, with a dependency picker and name validation).

## Building Packages

`Ctrl+Shift+B` (or **ROS2: Build ROS 2 Packages**) starts the smart build flow: multi-select the packages to build, then optionally pick argument presets (e.g. verbose output) or type custom arguments — your selection is remembered for next time. The build command itself is fully customizable via the `ROS2.build.shareSpec` template in settings, and pre-build checks warn about install-method (symlink/copy) and layout (merged/isolated) conflicts before they fail your build:

![Smart build: workspace build, package multi-select and argument presets](../assets/build-preset.gif)

`COLCON_IGNORE` can be toggled from the folder context menu to exclude a folder (and its subtree) from discovery and builds.

## IntelliSense

The extension keeps C++ and Python IntelliSense paths in sync automatically. See the [IntelliSense documentation](intellisense.md) — including message-file completion/navigation, xacro and launch-file jump-to-definition.
