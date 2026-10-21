# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Dedicated switch for the Python extraPaths maintenance** (`ROS2.ide.maintainPythonPaths`, default on): turns the automatic maintenance of the two Python `extraPaths` keys in settings.json on or off independently of the engine switch — the engine switch governs only the C++ header-search sides (cpptools / clangd). Off = fully manual; regenerating the IntelliSense configuration skips the side and the per-file feedback reports it as disabled;

### Changed

- **Resident helper platform gate**: clicking **Start Helper** on any platform other than Linux/macOS (all Windows editions/architectures — `win32` covers every Windows; WSL reports as Linux and is unaffected) is refused instantly with "The resident helper is not supported on this platform yet (Linux/macOS only); it may be supported in a future release." instead of a vague triple-failure error. The allowlist form also gives exotic platforms (freebsd/aix/…) the same honest refusal, and any future platform value defaults to refused rather than silently attempting;
- **Helper preflight now reports the interpreter identity**: the structured preflight line (stderr and the helper log) carries `python=<executable> (<version>)`, and a success line lands in the helper log on every start — environments where a conda/pyenv interpreter shadows the system one are immediately diagnosable from the "rclpy missing" report;
- `gc.freeze()` is now guarded with `hasattr`, so Python 3.6 interpreters degrade gracefully (losing only GC-pause smoothing) instead of crashing with a bare AttributeError — the helper's code floor is now effectively "whatever rclpy itself requires";
- The VM helper suite now runs a `py_compile` gate over every helper `.py` with the current interpreter before starting the 42 scenarios — syntax that exceeds the supported floor turns red before any scenario runs;
- **Command palette slimmed from 18 to 14 visible entries**: the separate "Run ROS Launch File" command is gone from the palette — **One-key Run (ros2 run / ros2 launch)** already routes by the active file type (Ctrl+F10 unchanged); the show/hide leftover entries pair is hidden (the title-bar eye button remains the single control), and the row-context "Open Installed File" joins the context-only hidden set. Hidden commands keep working via their ids (keybindings unaffected).

## [0.0.4] - 2026-10-21

### Added

- Build pre-check for colcon: the smart-build entry refuses with an actionable hint when `colcon` cannot be resolved on the collected environment's PATH (zero-subprocess probe; a fresh ros-jazzy-desktop install does not include colcon, so every new machine hits a bare exit-127 otherwise). The task path (Ctrl+Shift+B / tasks.json) shows the same hint as a deduplicated (30 s) non-modal warning and still runs the task so the terminal keeps its real output;
- Resident helper extension-version governance: the helper lock file gains a fourth field — the extension version that spawned the server (transported via spawn `--ext-version` argv; legacy locks with three fields or a `0` placeholder are treated as oldest). A client that finds a server started by an **older** extension verifies the pid via the recorded start-ticks and replaces it (SIGKILL + spawn of its own version); a server from an **equal or newer** extension is shared as-is; one-sided replacement means mixed-version windows converge without kill/spawn thrash. The frozen format and comparison rules are specified in `src/ros2/consumers/monitor/helper/VERSION-CONTROL.md`; covered by a new headless suite (truth table, replace/yield/legacy/disabled flows, cross-language argv contract) and VM end-to-end scenarios X6/X7/X8;
- **Package sidebar: develop/egg-link Python exports** — symlink-installed (`develop` mode) ament_python packages previously lost their entire Python exports area: the scanner only walked `site-packages/<pkg>/`, which develop installs never populate. The develop mirror (`build/<pkg>`, injected via the egg-link) is now walked with via-link row semantics, and the `<pkg>.egg-link` bookkeeping file is listed as a generated row (its loss is silent by design — the interpreter never reads it);
- **Package sidebar: "Open Installed File"** — a row context-menu entry opens the install-side file directly (symlink rows open the link, entity rows the entity), complementing the left-click jump to source;
- **clangd Add-block managed sort** (`ROS2.ide.clangdTidy`, default off): when enabled, a block-style `Add:` section is rebuilt in canonical group order with group comments re-pinned in the UI language and user-added lines moved verbatim to the tail; the rebuild now also **injects managed flags that were never present** (previously it only re-sorted existing lines, so a missing entry such as `-std=c++20` stayed lost forever);

### Fixed

- Status page no longer mixes languages on non-Chinese VS Code hosts: hardcoded Chinese leftovers (Services/Actions section titles, the 服务/调用/动作/发送目标 labels, lifecycle transition log lines, status-bar `(无)/(已设)/(未设)` diagnostics) now go through the webview/host i18n tables with English source keys and Chinese translations — each host language renders consistently; also removed dead `import { l10n } from "vscode"` from webview bundles (calling host l10n inside a webview would crash);
- Command palette title for "Show Leftover Entries" trimmed: the parenthetical explanation moved out of the title (both en and zh);
- Interface-name diagnostics for `.msg` / `.srv` / `.action` files: when such a file is created or opened, an error diagnostic appears immediately if the base name violates the rosidl rule (pattern `^[A-Z][A-Za-z0-9]*$` — must start with an uppercase letter and contain letters/digits only). The check mirrors `rosidl_adapter` exactly, including the `Sample_` prefix / `_Goal`-style suffix stripping, so it flags precisely what the build would reject (e.g. `My_Msg.msg` fails, `Foo_Goal.msg` passes, `Foo_Request.srv` fails) — previously a non-compliant name surfaced only as a CMake configure error wrapped around a Python traceback;
- **Package sidebar: develop imports survived only by naming luck** — when an ament_python package's Python top-level directory differs from the ROS package name (a legal setuptools layout; new setuptools even normalizes the egg-link filename to dashes), the develop walk looked for `build/<pkg>/<pkg>` and silently produced zero rows. The fallback now reads the standard `top_level.txt` egg-info artifact, and develop rows resolve their source through the real mirror-link target (new `develop-link` evidence) instead of a fabricated `src/<pkg>/<pkg>/…` path that would have shown as a false missing-source error. Verified end-to-end on a ROS 2 Jazzy machine;
- **Factory preset descriptions are localized again, with strict entry-level judgment** — the 2026-10-18 "slot labels are never translated" sweep over-applied its ruling: a preset entry is treated as factory **only when, at the same slot, both its key (description) and its value (argv) are byte-identical to the factory entry** — modifying either field (even one character), placing an entry at the wrong slot, or adding your own entries makes it user configuration that is always displayed verbatim; untouched factory entries (the two *Verbose output* entries of the build picker) are localized for display again. The scalar `${0}` custom-description/placeholder fields keep their existing per-field equality. Stored settings values remain English; display follows the UI language;
- **Build picker option 2 is now the whole flag** — the factory build template no longer hard-codes `--event-handlers console_cohesion+`: unchecked builds contain no `--event-handlers` at all (colcon default output), and checking *Verbose output 2/2* inserts the complete `--event-handlers console_cohesion+` flag (its description updated to match); previously the flag was always present and option 2 appended a handler name to it;
- The **Show Leftover Entries** eye toggle keeps its position in the view-title menu: visibility is now driven by a dedicated context key instead of a configuration `when` clause (which the title-menu renderer does not re-evaluate reliably), and the menu uses explicit group ordering;
- Settings descriptions polished: the Allow Empty Workspace description no longer carries the historical merge parenthetical, and the Build Presets description was rewritten as a structured markdown list (the two key kinds as separate bullets with their semantics, shared rules in a notes line) — same information, readable layout.

### Changed

- Resident helper fence: clicking **Start Helper** without a usable ROS 2 environment is now refused instantly with the concrete reason (no more 15-second wait and background retry storm). Spawn self-healing paths all check the gate; transient spawn failures trip a breaker after 3 attempts and Python preflight failures (bitmask-encoded exit codes 100+mask identifying exactly which import/callable is broken) trip it immediately — the helper stops automatically, the page shows the decoded reason, and clicking Start again resets the breaker;
- Helper connection handshake: the first frame is now a `hello` carrying an environment fingerprint (proto version + ROS_VERSION/ROS_DISTRO/ROS_DOMAIN_ID/RMW); the server computes the same fingerprint from its own environment at startup and rejects mismatches with a `deny` frame — a window running a different environment can no longer borrow another window's helper. Unverified connections are excluded from the client count and broadcasts and are kicked after 3 s without a hello;
- Status-bar startup diagnostics now target the helper's real dependencies (python3 on PATH, ROS_DISTRO/AMENT_PREFIX_PATH) instead of the retired ros2-CLI/daemon-port check;
- Activation sequence inverted: the ROS 2 environment is detected before any gated component starts. Commands and UI register immediately (invocations queue while detection runs, typically 1–3 s), but package scanning, language indexes (rosmsg/xacro/launch), test discovery and the build-map scan start only after a usable environment is confirmed — and hot-start automatically when the environment arrives or recovers later;
- A closed environment gate now means zero background activity: no timers, file watchers, workspace walks or `ros2` CLI calls. With the gate closed the sidebar view is hidden (and shows a "ROS 2 environment unavailable" row if it is still visible), Test Explorer shows an empty tree, and opening ROS files yields empty language results until the environment recovers;
- Reload prompt: when environment refreshes keep failing (two in a row; the gate itself already closes on the first failure) or the workspace root changes, a non-modal notification offers **Reload Window / Later** (10-minute cooldown, shared by both prompts). "Later" keeps running with every environment gate closed;
- Sensor unification: the shell-config watcher, the build signal and the 60-second poll now run the full refresh path, so environment recovery re-creates the status-bar item automatically;
- Unified environment gate: the gate formula ("usable ROS 2 environment AND (workspace has packages OR empty-workspace inclination)") now lives in a single gate service shared by the build task provider and IntelliSense generation; the two inclination settings `ROS2.build.allowEmptyWorkspace` (default on) and `ROS2.ide.allowEmptyWorkspace` (default off) are merged into one key `ROS2.env.allowEmptyWorkspace` with default **off** — this is a hard switch (old keys are ignored) and a behavior change: in a workspace without packages, builds are now refused by default and the build task provider is not registered unless you enable the new key. The environment threshold is never exempted by this setting;
- Command fences: the run / launch / build / single-package-build / rosdep / create-terminal / test-refresh / test-run-all commands (including their sidebar-tree variants) now check the gate at entry and refuse with a single message (reusing the execution-layer copy) instead of walking through pickers and writing selection memory before failing; explicitly exempt: doctor (needs no environment by design), welcome, package creation, COLCON_IGNORE toggle, sidebar navigation, and the status page shell;
- The `colcon` task provider no longer resolves tasks while no usable ROS 2 environment is detected (no dialog; the provider is already unregistered in the steady state, this only closes a race window);
- `build/compile_commands.json` merging is skipped while the environment gate is closed (including stale snapshots) and a workspace root is now required — previously an empty root resolved the target to a relative path that could be written into the extension host's working directory;
- Environment availability no longer sticks to a stale snapshot: when an environment refresh fails (setup script removed, collection error, or — new verification probe — `ros2` not found in the collected snapshot's PATH), the extension reports the snapshot as stale, which immediately closes every environment gate (build task provider, IntelliSense generation, the build/run/launch/tests entry checks, and the Ctrl+Shift+B `when` clause) instead of silently continuing with the old environment. Gates reopen automatically on the next successful collection; the transition is announced via an edge-triggered event, so repeated failures do not spam;
- Settings reorganized (presentation cleanup): the run/launch key family moved under a new `tool` level — `ROS2.run.*` → `ROS2.tool.run.*` and `ROS2.launch.*` → `ROS2.tool.launch.*` (settings now display as "ROS2 › Tool › Run/Launch: …"), and the doctor/rosdep command strings became `ROS2.tool.doctorCommand` / `ROS2.tool.rosdepCommand`. This is a hard switch: values stored under the old key names are ignored (re-enter them under the new keys);
- `ROS2.packages.refreshMs` and `ROS2.packages.userIndex` moved from the search group into a new **ROS 2 Packages** group (key names unchanged); the search group is retitled **ROS 2 Scan & Discovery** (it now contains only the scan-strategy keys: `excludeFolders`, `followSymlinks` and the 12 `walkTimeout.*` budgets);
- Order collisions fixed within the Build and Run & Launch groups (two pairs of settings shared the same order value), and rows are re-sequenced so related settings sit together (pre-build warnings next to the two install axes; stale warning inside the run section; the YAML definition toggle at the end of the launch section);
- **Renamed to ROS 2 Workbench** (简体中文「ROS 2 工作台」): the previous name "RDE for ROS 2" collided with Ranch-Hand-Robotics' "Robot Developer Extensions for ROS 2". The extension identifier and settings namespace are unchanged;
- **Package sidebar: two-class install timestamps** — generated artifacts (rosidl headers, generated Python modules, egg-link bookkeeping) show a single install-side timestamp and open the install side on click (exempt from the missing-source warning, curing a frozen false ⚠ on generated headers); user-written files always show both source and install timestamps (left src / right install). A successful live re-probe now also clears a stale missing-source marker;
- **Package sidebar: freshness self-heal** — saving a source file fires a targeted sidebar refresh, and the per-package build time participates in the change fingerprint, so a pure rebuild repaints the tree without any package event; the ament_python stale-warning root cause (alphabetical first install path resolving to the build directory with a frozen mtime) is fixed;
- **Package sidebar: click-to-recheck** — clicking a row re-verifies its on-disk state (lstat/exists) and triggers a full authoritative rescan when the tree is out of sync, instead of doing nothing;
- **Run/launch true multi-instance** — launching an already-running task now silently starts another instance (native `instancePolicy: silent`, limit 8) instead of prompting to terminate the running one;
- **The extension's state file moved out of the workspace** — the selection memory (picked presets / custom input) and package-selection memory now live in VS Code's extension-private storage instead of `.vscode/ros2-dev-extension-state.json`. On first start the old file is migrated automatically and then removed, so the workspace `.vscode/` folder now only contains files other tools consume (`c_cpp_properties.json` / `.clangd` / `settings.json`);
- **Command template settings redesigned**: the three command-template settings become per-domain `template` + `presets` key-value tables with a convergent grammar — a bare key is the `${0}` custom-input description, `N|description` (N≥1) is a slot preset, `0|` is rejected, and `\|` escaping is honored; the bare-key value carries the input-box placeholder hint (factory hints are localized for display). This is a hard switch for anyone who customized the old array form — re-enter the values in the new shape;
- **User folder exclusions are honored everywhere**: `ROS2.search.excludeFolders` now filters the rosmsg, xacro and launch scans (previously half of the wiring never existed), including the event and watcher incremental paths;
- **IntelliSense regeneration feedback is per-file**: the fixed "missing entries have been filled" toast is replaced by a dynamic per-file report — what was written where (generated from scratch, filled keys, reordered, cleaned leftovers, …) and why untouched files were left alone (already canonical / engine side disabled / no `CompileFlags.Add` block, conservatively not created / nothing to maintain), rendered in the UI language. The scheduled background sync stays silent as before.

### Fixed

- A resident helper instance could turn into a zombie: reloading or closing the VS Code window that spawned it broke the helper's stderr pipe, and the next warning-level log write threw BrokenPipeError — silently killing the housekeeping thread (heartbeat broadcast, stale-client kicks and the zero-client self-exit all died with it, while request/response kept working, which made the zombie undetectable: the status badge stayed grey and stale node rows lingered). stderr writes are now guarded against broken pipes, the housekeeping/sampler loops survive per-tick exceptions with a crash trace in the disk log, and the client watchdog gained an independent heartbeat-freshness dimension (online but zero heartbeat frames for 10 s → SIGKILL and respawn), so an already-zombified server self-heals on contact;
- The reload-window prompt ("the ROS 2 environment looks broken — it worked before") could fire on machines where a ROS 2 environment never existed: the prompt only counted consecutive collection failures and the "it worked before" claim was hard-coded copy. It now requires the environment to have been collected successfully in this window — a never-working environment is a steady state that the status bar and the gates already convey, and reloading would fix nothing. The prompt also gained the **Later** button its copy referenced (dismissing the toast remains equivalent to Later);
- The helper hello handshake could never succeed: the extension sent legacy short key names (`distro`/`domain_id`/`rmw`) while the server looks up full lowercase names (`ros_distro`/`ros_domain_id`/`rmw_implementation`), so every connection was denied with "environment fingerprint mismatch" and the helper never came online. The wire keys are now derived from the server's fingerprint key table (and pinned by a cross-language contract test that reads the Python source), the deny reason now lists exactly which keys mismatched, and a denied start aborts immediately with that reason instead of spinning out the 15-second wait with a misleading timeout message;
- The helper request timeout now honors the per-call timeout parameter (ping 3 s / resync 15 s) instead of the hard-coded 30 s — a keepalive ping against a stuck server no longer hangs for half a minute;
- The rosmsg language domain ran its index initialization twice at activation (a duplicated full workspace walk, an overwritten event subscription and a duplicated `ros2 interface list`); initialization is now single-flight and deferred behind the environment gate;
- Environment recovery via the 60-second poll or a shell-config change no longer leaves the ROS status-bar item dead — environment components now reconcile on every availability flip;
- Run/launch entry refusals no longer produce a double toast: the endpoint environment check returns instead of throwing, so the stale-artifact warning fired unconditionally right after — with the new entry gates this path is no longer reached;
- Changing `ROS2.search.walkTimeout.package.*` now takes effect on the next scan without a window reload: the scan-configuration listener still watched the removed plural key `ROS2.search.walkTimeouts`, which never matches the current singular `walkTimeout.*` keys, so package-side timeouts required a reload to apply;
- The doctor fallback (setting explicitly cleared) now runs `ros2 doctor --report`, matching the factory default, instead of a bare `ros2 doctor`;
- The doctor fallback (setting explicitly cleared) now runs `ros2 doctor --report`, matching the factory default, instead of a bare `ros2 doctor`.

### Removed

- Dead setting `ROS2.ui.autoShowOutput` ("automatically open the output channel on warnings/errors"): the feature was never wired up — its only reader lived in a wrapper function that no code called.

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
