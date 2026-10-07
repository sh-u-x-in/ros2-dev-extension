// Licensed under the MIT License.

/**
 * @file register-commands.ts(2026-09-25 新增)
 * run 域命令注册:`ROS2.run` / `ROS2.launch`(命令面板;id 沿用上游遗留常量,编排全部换新)。
 * 2026-09-25 起 `ros2/registry/core.ts` 不再注册这两条(旧 ros-cli 编排已删除)——注册者换成 run 域。
 */

import * as path from "path";

import * as vscode from "vscode";

import { ensureErrorMessageOnException } from "../../../error-utils";
import { getLogger } from "../../../logger";
import { LaunchCommand, RunCommand } from "./command-ids";
import { isLaunchFileName } from "./launch-detect";
import type { RunDataSource } from "./run-data-source";
import { launchActiveEditor, runRosLaunchFile } from "./smart-launch";
import { runActiveEditor, runRosExecutable } from "./smart-run";

/** register-commands 模块日志 */
const log = getLogger("run-register-commands");

/**
 * 注册 run 域命令(组合根注入数据源;null = 数据源未就绪,命令内部如实提示)。
 * 返回 Disposable 供 context.subscriptions 收口(对齐 sidebar/registerInstallTruthSidebar 模式)。
 */
export function registerRosRunCommands(context: vscode.ExtensionContext, data: RunDataSource | null): vscode.Disposable[] {
    void context;
    log.trace("Registering run/launch commands");
    // 2026-09-29 一键运行:键位实参 { source: "activeEditor" } → 解析激活文件直接运行
    // (ownersOfSource / launchFiles 快照匹配);无实参 = 面板选单流程不变。
    // 2026-10-07 单键位定稿:ctrl+f10 只挂 ROS2.run,when 用正向正则仅判"可运行文件";
    // run/launch 分流在下方 handler 按真实文件名做——键位层 resourceFilename 按键瞬间可能滞后
    // (VS Code 上下文键旧值),按文件类型分流的 when 不可靠(实测 launch.xml 被判成 .py 旧值)。
    const run = vscode.commands.registerCommand(RunCommand, (arg?: { source?: string }) => {
        ensureErrorMessageOnException(async () => {
            log.trace(`执行命令:${RunCommand}`);
            if (arg?.source === "activeEditor") {
                const file = vscode.window.activeTextEditor?.document.uri.fsPath;
                if (file) {
                    // 2026-10-07 分流入 handler:键位层 resourceFilename 在按键瞬间可能是旧值(VS Code 上下文键滞后),
                    // 只有 handler 里的 activeTextEditor 恒为真实文件 —— 单键位 + 此处按文件类型路由。
                    if (isLaunchFileName(path.basename(file))) {
                        await launchActiveEditor(data, file);
                    } else {
                        await runActiveEditor(data, file);
                    }
                    return;
                }
            }
            await runRosExecutable(data);
        });
    });
    const launch = vscode.commands.registerCommand(LaunchCommand, (arg?: { source?: string }) => {
        ensureErrorMessageOnException(async () => {
            log.trace(`执行命令:${LaunchCommand}`);
            if (arg?.source === "activeEditor") {
                const file = vscode.window.activeTextEditor?.document.uri.fsPath;
                if (file) { await launchActiveEditor(data, file); return; }
            }
            await runRosLaunchFile(data);
        });
    });
    return [run, launch];
}
