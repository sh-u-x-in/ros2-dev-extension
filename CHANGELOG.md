# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.3] - 2026-10-15

### Added

- **Package sidebar: install-truth health** — rows visually distinguish missing artifacts (red), broken symlinks (red) and missing sources (amber ⚠ badge); file rows show source and install modification times (merged into one for symlink rows), tooltips explain when a symlinked edit takes effect (rebuild for interfaces, recompile for headers, immediate for runtime files), and package hovers show the last build time; rows whose files disappeared are synthesized from build records instead of silently vanishing; clicking a row re-verifies it against disk and rescans the tree when stale;
- **Package sidebar: leftover entries** — files still under `install/` that the latest build no longer declares (renamed executables, commented-out `setup.py` entry points) are detected, hidden by default and toggled with a title-bar eye button (`ROS2.ui.showLeftovers`); the leftover count stays visible in the view title;
- **One-key run readiness (`Ctrl+F10`)** — warns when a target is compiled but not installed, and shows a non-modal "source newer than install" warning with a don't-show-again button (`ROS2.run.staleWarning`);
- **Dependency picker** — builtin dependencies are now listed and pre-checked instead of hidden; candidate descriptions can be overridden via the user supplement index `ROS2.packages.userIndex`; `|` in descriptions can be escaped;
- **Generated packages** — the generated `CMakeLists.txt` pins the C++ standard for the detected ROS 2 distribution (overridable via `-DCMAKE_CXX_STANDARD`); teaching comments in generated templates are localized (English / Simplified Chinese), including Python docstrings and shebang handling;
- **IntelliSense entry overrides** — per-engine replacement tables `ROS2.ide.entryOverrides.clangd` / `.cpptools` / `.python` replace or delete individual generated entries (empty value = remove); an optional tidy mode (`ROS2.ide.clangdTidy`, default off) re-sorts the managed `.clangd` block and re-anchors its localized group comments;
- Community standards files: issue/PR templates, code of conduct and security policy.

### Changed

- `ROS2.ide.intellisenseEngine` now defaults to `auto` (follow the installed engine(s)) instead of `both`;
- `c_cpp_properties.json` maintenance is now minimal-touch and robust: the generated entry contains only `name` / `includePath` / `compileCommands`, and C++ standard fields are never written or rewritten (until the first build provides `compile_commands.json`, editors fall back to their own defaults — one build clears any squiggles); only the `ros2` entry is claimed, JSONC comments and trailing commas are tolerated, and all settings writes are serialized and atomic (temp file + rename);
- Topic subscription (button and copied command) carries the message type, so a subscription started before the publisher comes online keeps receiving.

### Fixed

- The extension no longer writes `files.watcherExclude` / `search.exclude` / `python.analysis.exclude` into workspace `settings.json` (marketplace issue #3);
- Generated `CMakeLists.txt`: teaching comment lines missing the leading `#` broke `colcon build` of freshly generated packages (marketplace issue #5); residual Chinese in generated files unified to English so non-Chinese UIs no longer produce mixed-language output;
- The "Python package generated" notification showed a raw placeholder instead of the package name (marketplace issue #7);
- Sidebar: the dangling-link icon was invisible on some VS Code versions, the leftover count was written to a slot the compact header doesn't render, and the eye button jumped sides of the refresh button when toggled;
- `.clangd` managed block: managed entries deleted by hand or lost to history (e.g. `-std=c++20`) are re-injected on sync instead of being lost forever;
- `c_cpp_properties.json` / `.clangd` changes announced in logs but not persisted (claim-stage writes were swallowed by the "no changes" gate) are now flushed to disk.

## [0.0.2] - 2026-10-07

### Added

- **Walkthrough content auto-switching**: the getting-started pages are now split into per-language files and two locale-gated walkthroughs (`ros2.uiLocale` context key) — the welcome page shows the language matching the VS Code display language instead of a mixed bilingual page;
- **Documentation site goes bilingual** (`docs/en/` + `docs/zh-cn/`, nine pages each) with real usage captures: msg / xacro / launch navigation GIFs, smart-build flow, package-contents sidebar and Test Explorer screenshots;
- **Development status note** in the README and docs: rapid iteration, primarily tested on Linux (Humble); Windows not systematically tested (status page in particular) — feedback welcome.

### Fixed

- `Ctrl+F10` one-key run: shortcut routing decided inside the handler by file type (launch files → launch arguments, py/cpp → run arguments); removes an invalid negation regex in the keybinding `when` clause that caused unconditional registration;
- README/docs accuracy pass: dead documentation links after the bilingual restructure, install-method setting keys aligned with the current `ROS2.build.installMethod` (three-value), command tables aligned verbatim with the localized command titles.

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
