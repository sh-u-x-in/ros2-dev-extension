# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.1] - 2026-09-29

First public release (version numbering restarts at 0.0.1).

### Added

- **ROS 2 status page**: a resident helper (rclpy, direct DDS connection) as the single source of truth — nodes / topics / services / parameters / lifecycle at a glance; topic subscription, service calls, action goal sending (structured forms), a five-color parameter tree with truncation and full-content opening;
- **Package contents sidebar**: an install-truth-driven package contents tree (executables / launch / Python exports / resources / headers) with inline run & build, rosidl intermediate-artifact filtering and hard blacklist exclusion;
- **Build template mechanism**: argument templates + presets + per-target memory for `colcon build` / `ros2 run` / `ros2 launch` (stored in settings; factory defaults fully replaceable);
- **Pre-build checks**: pre-flight detection of install-method (symlink/copy) and layout (merged/isolated) conflicts, including automatic `--cmake-clean-cache` and a "don't warn again" tier;
- **Testing**: C++ gtest + Python pytest discovery, execution and result parsing (Test Explorer);
- **Language services**: rosmsg (.msg/.srv/.action completion/hover/definition/formatting/diagnostics), xacro (include graph + D1-D14 diagnostics + dotted ns-chain addressing), launch (py/XML/YAML completion and navigation), dynamic rclpy/rclcpp snippet injection;
- **IntelliSense maintenance**: automatic include-path maintenance for cpptools / clangd + compile_commands merging;
- **Package creation wizard**: C++ / Python / mixed package generation with dependency picking and name validation;
- **Environment management**: distribution detection, pixi support, shell config watching, build-dedicated environment (self-overlay removed);
- **Bilingual UI**: English source strings with a Simplified Chinese l10n bundle (1,400+ keys) following the VS Code display language — commands, settings, notifications, status page and editor hovers/completions are all localized.

### Changed

- All settings keys reorganized into 7 groups (`ROS2.env.*` / `build.*` / `run.*` / `launch.*` / `msg.*` / `search.*` / `ide.*` / `ui.*`);
- Removed telemetry code.

### Removed

- ROS 1 (roscore/roslaunch) commands and the daemon XML-RPC direct link (the status page now uses the resident helper).
