// Licensed under the MIT License.

/**
 * @file command-ids.ts(2026-09-25 新增)
 * run 域的 VS Code 命令 ID。
 * `ROS2.run` / `ROS2.launch` 是上游遗留的既有 id(package.json 已注册、用户可能绑了键)——
 * **重做不改 id**(单一事实源仍在 `ros2/host/commands.ts`,本文件只转口:注册者换成 run 域,常量不搬家)。
 */

export { LaunchCommand, RunCommand } from "../../../ros2/host/commands";
