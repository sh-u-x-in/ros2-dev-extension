# Configuration

### Workspace and Global Settings
All settings registered by the extension live under the `ROS2` section: 46 keys in 8 groups (each group is a titled section in the Settings UI, e.g. "ROS 2 Environment"; within a group the key segments further group the rows, e.g. "ROS2 › Tool › Run: Template"). The authoritative source = package.json `contributes.configuration`; this table is a quick reference.

**Environment**

| Setting | Description |
|---|---|
| ROS2.env.distro | The ROS distribution to load (e.g. humble); empty = environment default |
| ROS2.env.setupScript | Path to the ROS environment setup script; derived from env.pixiRoot when empty; supports `${workspaceFolder}` |
| ROS2.env.pixiRoot | Pixi environment root; on Windows an empty value falls back to `c:\pixi_ws` |
| ROS2.env.systemWatchFiles | Shell config files the environment collection depends on; any change re-collects the environment |
| ROS2.env.allowEmptyWorkspace | Empty-workspace inclination for the unified environment gate (merged from the former build/ide keys, default off): when the workspace has no packages, gated features proceed anyway (build task provider / empty builds, IntelliSense generation — environment side only); the environment threshold is never exempted |

**Build**

| Setting | Description |
|---|---|
| ROS2.build.installMethod | Install method, three values: auto (platform default: copy on Windows / symlink elsewhere) / symlink / copy (explicit value takes precedence over the platform default) |
| ROS2.build.installLayout | Install layout: auto (platform default: merged on Windows / isolated elsewhere) / merged (--merge-install) / isolated (colcon default) |
| ROS2.build.template | Build command template (flat string with `${base_path}` / `${packages_select}` / `${clean}` / `${install_method}` / `${install_layout}` / `${1}..${n}` / `${0}` placeholders) |
| ROS2.build.presets | Preset table for the `${1}..${n}` slots: a key with no separator is the custom-input entry (key = description above the input box, value = grey example inside it); a key `N\|description` (N ≥ 1) presets slot ${N}; same-slot entries are exclusive alternatives |
| ROS2.build.preflightWarnings | Pre-build warning mode: on / off / ignore-silent-noop |

**Run & Launch**

| Setting | Description |
|---|---|
| ROS2.tool.run.template | ros2 run command template (factory = `ros2 run ${pkg} ${executable} ${0}`) |
| ROS2.tool.run.presets | Preset table for ROS2.tool.run.template (same grammar: separator-free key = custom-input entry, `N\|description` = slot preset) |
| ROS2.tool.run.staleWarning | Warn (non-blocking toast with a "Don't show again" button) when the installed copy is older than the source file on Ctrl+F10 run/launch |
| ROS2.tool.launch.template | ros2 launch command template (factory = `ros2 launch ${pkg} ${launch_file} ${0}`) |
| ROS2.tool.launch.presets | Preset table for ROS2.tool.launch.template (same grammar: separator-free key = custom-input entry, `N\|description` = slot preset) |
| ROS2.tool.launch.yamlDefinitionEnabled | Go-to-definition registration for .launch.yaml (F12, experimental; off = no definition provider for YAML; applies after a window reload) |
| ROS2.tool.doctorCommand | Full command string executed by the "Run ros2 doctor" command (factory `ros2 doctor --report`) |
| ROS2.tool.rosdepCommand | Full command string executed by the "Install dependencies via rosdep" command |

**Message Interfaces**

| Setting | Description |
|---|---|
| ROS2.msg.systemRefreshMinutes | Refresh interval (minutes) for the rosmsg system message index |
| ROS2.msg.workspaceRescanMs | Forced rescan period (ms) for the rosmsg workspace index (0 = disabled) |
| ROS2.msg.formatGradientStep | Gradient step (characters) for rosmsg format column alignment |
| ROS2.msg.formatLineThreshold | Single/double-line switch threshold (characters) for @optional annotations |

**Scan & Discovery**

| Setting | Description |
|---|---|
| ROS2.search.excludeFolders | Extra directories excluded when scanning (11 built-in artifact/dependency names are always excluded and cannot be un-excluded) |
| ROS2.search.followSymlinks | Whether directory searches follow symbolic links (off by default) |
| ROS2.search.walkTimeout.\<type\>.\<field\> | Flat per-type walk budgets, 12 keys (type = message / xacro / package / test; field = totalTimeoutMs / branchTimeoutMs / maxDepth). Factory values pre-stored per key (10000/2000/8; test 30000/5000/12); total & branch minimum 1. Changes apply to the next scan. |

**Packages**

| Setting | Description |
|---|---|
| ROS2.packages.refreshMs | Forced background rescan period (ms) for the package list (0 = disabled; applies automatically) |
| ROS2.packages.userIndex | User-supplied package index for the dependency picker: key = package name, value = "[py\|]<description>" (the optional "py" prefix forces the [pure Python package] badge; the description replaces the row's when the name matches; unmatched entries stay hidden) |

**IntelliSense**

| Setting | Description |
|---|---|
| ROS2.ide.intellisenseEngine | Engine for automatic include-entry maintenance: auto / cpptools / clangd / both / none |
| ROS2.ide.entryOverrides.clangd | Replacement table for entries generated into .clangd: key = exact Add token (without "- "), value = replacement used verbatim, empty string = remove. Chained to a fixed point in one sync; cycles drop the entry. |
| ROS2.ide.entryOverrides.cpptools | Replacement table for includePath entries generated into c_cpp_properties.json: key = exact entry string (with ${workspaceFolder} / trailing "**"), value = replacement verbatim, empty string = remove. Same chaining semantics. |
| ROS2.ide.entryOverrides.python | Replacement table for directories generated into both extraPaths lists: key = exact directory string, value = replacement verbatim, empty string = remove. Same chaining semantics. |
| ROS2.ide.clangdTidy | Take over .clangd ordering (default off): re-sort managed entries into canonical group order and re-anchor the localized group comments on every sync; your own rows keep relative order at the end of the Add block. One-way effect. |

**UI**

| Setting | Description |
|---|---|
| ROS2.ui.showWelcomeOnStartup | Show the welcome page after install or update |
| ROS2.ui.showLeftovers | Show leftover entries in the Package Contents view: files still under install/ but no longer declared by the latest build (renamed/removed executables, commented-out setup.py entries). Hidden by default; toggle with the eye button in the view title bar |

`settings.json` example:

```json
{
    "ROS2.env.distro": "humble",
    "ROS2.env.setupScript": "/opt/ros/humble/install/setup.bash",
    "ROS2.build.installMethod": "auto"
}
```

