# terminal/ — 终端消费者

> ROS 环境终端的创建与注册(薄集成,单消费方 UI 层,设计上有意不进 api/)。

## 文件

| 文件 | 职责 |
|:--|:--|
| `ros-terminal.ts` | `createRosTerminal`:命令 `ROS2.createTerminal` 的行为实现(host/terminal.createTerminal + composeApi.environment.getEnv 注入 env;vscode 仅类型引用) |
| `terminal-profile.ts` | 「ROS 2 环境」TerminalProfileProvider:在「新建终端」下拉注册 `rde-ros-2.ros-environment`;跨平台注入 wrapper(bash `--rcfile`(需 `-i`)/ zsh ZDOTDIR / fish / pwsh / cmd / WSL 降级)+ 环境横幅(发行版/overlay/环境变量速览) |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):两文件职责自 `../README.md` 关键文件细节独立成档 |
