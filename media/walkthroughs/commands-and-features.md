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
