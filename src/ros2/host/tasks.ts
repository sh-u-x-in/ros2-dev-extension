// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file tasks.ts
 * VS Code 中转壳 · 任务执行绑定壳:构造 VS Code Task + ShellExecution 并 executeTask。
 * 薄适配,零业务逻辑;A9 任务终端经此执行命令(动态注入参数在业务层纯函数)。
 */

import * as vscode from "vscode";

export interface RunShellTaskOptions {
    env?: Record<string, string>;
    cwd?: string;
    isBackground?: boolean;
    problemMatchers?: string[];
}

/**
 * 构造并执行一个 shell 任务(在 VS Code 集成任务终端运行)。
 * 纯执行壳;命令/参数由业务层构造后传入(如构建由设置模板展开成整条 argv)。
 */
export async function runShellTask(
    name: string,
    command: string,
    args: string[] = [],
    options?: RunShellTaskOptions
): Promise<vscode.TaskExecution> {
    // 2026-09-29:定义改用已注册任务类型 ROS2(package.json taskDefinitions,required=command)。
    // 此前用内置类型 "shell" —— VS Code 会按 tasks.json 的 shell 任务校验【定义本身】
    // (要求定义顶层携带 command),不满足即在"问题"面板报「既不指定命令…将忽略该任务」;
    // 注册类型无此校验;执行体(ShellExecution)与终端名不受影响。
    const definition = { type: "ROS2", command, args };
    const task = new vscode.Task(
        definition,
        vscode.TaskScope.Workspace,
        name,
        "ROS2"
    );
    task.execution = new vscode.ShellExecution(command, args, {
        env: options?.env,
        cwd: options?.cwd,
    });
    if (options?.isBackground) {
        task.isBackground = true;
    }
    if (options?.problemMatchers) {
        task.problemMatchers = options.problemMatchers;
    }
    return vscode.tasks.executeTask(task);
}

/**
 * 订阅任务开始(薄壳,2026-09-09 重新引入)。
 * 消费方 = 环境域:记录"我方构建任务"是否在进行中,进行期间抑制 install/** 事件。
 */
export function onDidStartTask(listener: (e: vscode.TaskStartEvent) => void): vscode.Disposable {
    return vscode.tasks.onDidStartTask(listener);
}

/**
 * 订阅任务进程结束(薄壳,带 exitCode;2026-09-09 重新引入)。
 * 消费方 = 环境域:我方构建结束时**立即触发一次** overlay 刷新(1 次/构建,替代 N 包 N 次)。
 */
export function onDidEndTaskProcess(listener: (e: vscode.TaskProcessEndEvent) => void): vscode.Disposable {
    return vscode.tasks.onDidEndTaskProcess(listener);
}

// 2026-08-31:旧的 onDidEndTask 薄壳曾随"编译后刷新归属判定"链整体移除(manual build 漏事件);
// 2026-09-09:按"任务事件与文件事件交织"方案重新引入 onDidStartTask / onDidEndTaskProcess——
//   用途不同:前者给"我方构建进行中"打标记(期间忽略 install/** 风暴),后者在构建结束触发一次刷新;
//   install/** 仍保留为"用户自行构建"的退化路径(见 environment/register.ts)。
// 修改时间:2026-09-09 21:05(新增 onDidStartTask / onDidEndTaskProcess 薄壳:构建期间抑制 + 构建结束单次触发)
