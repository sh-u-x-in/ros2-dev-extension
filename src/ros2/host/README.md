# host/ — VS Code 中转壳

**薄适配,零业务逻辑**:集中封装 vscode 专有 API,业务层经此访问,不直接 import vscode;整层可 mock 测试。
聚合出口 `index.ts` re-export 全部子模块。

## 模块清单

| 文件 | 封装 | 说明 |
|---|---|---|
| `commands.ts` | **命令 ID 常量**(单一事实源)+ `setContext` | `ShowDaemonStatusCommand`/`CreateTerminalCommand` 等 `ROS2.*` ID;consumers/registry 一律从此取,不硬编码 |
| `config.ts` | `getConfig` / `onConfigChanged` / `updateConfig` | `vscode.workspace.getConfiguration("ROS2")` 类型化读取 |
| `fs.ts` | `createFileSystemWatcher` / `getWorkspaceRoot` / `onDidChangeWorkspaceFolders` | 文件监听/工作区根 |
| `tasks.ts` | `runShellTask` + `onDidStartTask` / `onDidEndTaskProcess` | 构造 VS Code Task + ShellExecution + executeTask(A9 任务终端);2026-09-09 新增任务生命周期薄壳(构建进行中抑制 install/**、结束单次刷新);**2026-09-28 任务 source 由 `shell` 改为 `ROS2`**(问题定位器归属扩展) |
| `terminal.ts` | `createTerminal` + re-export `detectUserShell`(rde-common) | 终端创建绑定壳;**2026-09-27 `CreateTerminalOptions` 增 `shellPath`/`shellArgs`**(供 bash `--rcfile` 启动前注入等定制,消费方 = 调用终端 history -s / terminal-run) |
| `window.ts` | `showQuickPick`/`showInputBox`/`showInformationMessage`/`showErrorMessage`/`setStatusBarMessage` | 弹窗/状态栏绑定壳 |

## 注意

- `commands.ts` 的命令 ID 与 `package.json contributes.commands` 一致,改 ID 需同步两处;
- consumers 的 UI 集成层(状态页 webview、终端 profile)仍可直接 import vscode(既成惯例),host 薄壳服务于**业务逻辑层**。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 文档补登(2026-09-09 后 7 个提交触及本目录,模块清单无增删):①terminal.ts `CreateTerminalOptions` 增 `shellPath`/`shellArgs`(2026-09-27 a534a2b/b87a8ba);②tasks.ts 任务 source `shell`→`ROS2`(2026-09-28 4780aad);其余为键名/注释连带 |
| 2026-09-09 21:05 | `tasks.ts` 新增 `onDidStartTask` / `onDidEndTaskProcess` 薄壳(消费方 = environment/register.ts):供"我方构建任务进行中抑制 install/**、构建结束单次刷新"使用;旧的 onDidEndTask 归属判定链仍保持移除状态(用途不同) |
| 2026-08-28 12:52 | 创建 host/ README(vscode 中转壳模块清单) |
| 2026-08-28 12:56 | 时间标注统一精确到时分;尾部新增修改记录便于溯源。正文引用的历史日期(2026-08-24 ~ 2026-08-26)为设计/代码注释标注日期,非文件操作时间 |
| 2026-08-31 18:33 | fs.ts getWorkspaceRoot 内部 `vscode.workspace.rootPath` 迁移为 `workspaceFolders?.[0]?.uri.fsPath`(废弃 API 清理,行为等价) |

<!-- 文件末尾修改时间:2026-09-29(补登 terminal options 与任务 source 两批,详见上表 2026-09-29 行) -->

