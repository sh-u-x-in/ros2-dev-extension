# Configuration

### Workspace and Global Settings
All settings registered by the extension live under the `ROS2` section: 22 keys in 7 functional groups (shown in the Settings UI as "ROS 2: <group>"). The authoritative source = package.json `contributes.configuration`; this table is a quick reference.

**Environment**

| Setting | Description |
|---|---|
| ROS2.env.distro | The ROS distribution to load (e.g. humble); empty = environment default |
| ROS2.env.setupScript | Path to the ROS environment setup script; derived from env.pixiRoot when empty; supports `${workspaceFolder}` |
| ROS2.env.pixiRoot | Pixi environment root; on Windows an empty value falls back to `c:\pixi_ws` |
| ROS2.env.systemWatchFiles | Shell config files the environment collection depends on (not watched on Windows) |

**Build**

| Setting | Description |
|---|---|
| ROS2.build.installMethod | Install method, three values: auto (platform default: copy on Windows / symlink elsewhere) / symlink / copy (explicit value takes precedence over the platform default) |
| ROS2.build.installLayout | Install layout: auto (platform default: merged on Windows / isolated elsewhere) / merged (--merge-install) / isolated (colcon default) |
| ROS2.build.shareSpec | Build command template mechanism (template + custom + argv_list) |
| ROS2.build.preflightWarnings | Pre-build warning mode: on / off / ignore-silent-noop |
| ROS2.build.allowEmptyWorkspace | Whether an empty build is allowed in a workspace without packages |

**Run & Launch**

| Setting | Description |
|---|---|
| ROS2.run.shareSpec | ros2 run command template mechanism (factory = `ros2 run ${pkg} ${executable} ${0}`) |
| ROS2.launch.shareSpec | ros2 launch command template mechanism (factory = `ros2 launch ${pkg} ${launch_file} ${0}`) |

**Message Interfaces**

| Setting | Description |
|---|---|
| ROS2.msg.systemRefreshMinutes | Refresh interval (minutes) for the rosmsg system message index |
| ROS2.msg.workspaceRescanMs | Forced rescan period (ms) for the rosmsg workspace index (0 = disabled) |
| ROS2.msg.formatGradientStep | Gradient step (characters) for rosmsg format column alignment |
| ROS2.msg.formatLineThreshold | Single/double-line switch threshold (characters) for @optional annotations |

**Package Discovery & Search**

| Setting | Description |
|---|---|
| ROS2.search.excludeFolders | Extra directories excluded when scanning (11 built-in artifact/dependency names are always excluded and cannot be un-excluded) |
| ROS2.search.followSymlinks | Whether directory searches follow symbolic links (off by default) |
| ROS2.search.walkTimeouts | Per-search-type timeout/depth overrides |
| ROS2.packages.refreshMs | Forced background rescan period (ms) for the package list (0 = disabled; applies automatically) |

**IntelliSense**

| Setting | Description |
|---|---|
| ROS2.ide.intellisenseEngine | Engine for automatic include-entry maintenance: auto / cpptools / clangd / both / none |

**UI**

| Setting | Description |
|---|---|
| ROS2.ui.autoShowOutput | Automatically open the ROS 2 output channel when a warning or error occurs |
| ROS2.ui.showWelcomeOnStartup | Show the welcome page after install or update |

`settings.json` example:

```json
{
    "ROS2.env.distro": "humble",
    "ROS2.env.setupScript": "/opt/ros/humble/install/setup.bash",
    "ROS2.build.installMethod": "auto"
}
```

