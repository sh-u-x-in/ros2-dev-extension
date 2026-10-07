// Licensed under the MIT License.

/**
 * @file share-spec.ts(2026-09-25 新增)
 * 「可共享命令参数模板」与 run 域的**接线适配层** —— 与 `build/share-spec.ts` 同构:
 * 读设置(`ROS2.run.shareSpec` / `ROS2.launch.shareSpec`)→ 与出厂默认合并 → 展开成本次的整条 argv。
 *
 * ── 与 build 的唯一差别:记忆键**按目标分槽** ────────────────────────
 * 构建的参数对包是均匀的(一条命令一个槽够用);run/launch 的参数因目标而异(用户裁定 2026-09-25),
 * 记忆键 = `ros2.run::<pkg>/<exe>` 与 `ros2.launch::<源文件路径>`(定义在 share/defaults 各自模块,
 * 纯函数 ⇒ 可无头单测;本文件只做"读设置 + 装填动态参数 + 展开"的 vscode 接线)。
 */

import * as vscode from "vscode";

import { getLogger } from "../../../logger";
import { ROS2_LAUNCH_SPEC, ros2LaunchDynamics } from "../share/defaults/ros2-launch";
import { ROS2_RUN_SPEC, ros2RunDynamics } from "../share/defaults/ros2-run";
import { expandCommand, mergeSpec } from "../share/expand";
import type { CommandSpec, ExpandResult } from "../share/types";

/** share-spec 模块日志 */
const log = getLogger("run-share-spec");

/** 设置键(前缀 `ROS2.` 由 getConfiguration 提供) */
export const ROS_RUN_SETTING = "run.shareSpec";
export const ROS_LAUNCH_SETTING = "launch.shareSpec";

/** 读设置里的 run spec:字段缺失回落出厂默认;显式给空则尊重用户(见 mergeSpec) */
export function readRosRunSpec(): CommandSpec {
    const raw = vscode.workspace.getConfiguration("ROS2").get<Partial<CommandSpec>>(ROS_RUN_SETTING);
    return mergeSpec(raw, ROS2_RUN_SPEC);
}

/** 读设置里的 launch spec(同上) */
export function readRosLaunchSpec(): CommandSpec {
    const raw = vscode.workspace.getConfiguration("ROS2").get<Partial<CommandSpec>>(ROS_LAUNCH_SETTING);
    return mergeSpec(raw, ROS2_LAUNCH_SPEC);
}

/** run 域交给引擎的输入 */
export interface Ros2RunRequest {
    pkg: string;
    executable: string;
    /** 二级弹窗勾选的预设下标(0 基) */
    picked?: readonly number[];
    /** 二级弹窗的自定义输入(模板含 ${0} 时) */
    custom?: string;
}

/** 展开本次 `ros2 run` 的完整命令行(含命令名;未知占位符原样保留 + 记日志) */
export function expandRos2Run(req: Ros2RunRequest): ExpandResult {
    const result = expandCommand(readRosRunSpec(), {
        dynamics: ros2RunDynamics({ pkg: req.pkg, executable: req.executable }),
        picked: req.picked,
        custom: req.custom,
    });
    if (result.unknown.length > 0) {
        log.warn(vscode.l10n.t("Unknown placeholders in command template (kept as-is on the command line): {0}", result.unknown.join(", ")));
    }
    log.debug(vscode.l10n.t("Expanded run command ({0} segments): {1}", result.argv.length, result.argv.join(" ")));
    return result;
}

/** launch 域交给引擎的输入 */
export interface Ros2LaunchRequest {
    pkg: string;
    /** 包内相对安装路径(嵌套目录保留子路径) */
    launch_file: string;
    /** 安装侧绝对路径(${launch_path};缺省 = 空) */
    launch_path?: string;
    picked?: readonly number[];
    custom?: string;
}

/** 展开本次 `ros2 launch` 的完整命令行(含命令名;未知占位符原样保留 + 记日志) */
export function expandRos2Launch(req: Ros2LaunchRequest): ExpandResult {
    const result = expandCommand(readRosLaunchSpec(), {
        dynamics: ros2LaunchDynamics({ pkg: req.pkg, launch_file: req.launch_file, launch_path: req.launch_path }),
        picked: req.picked,
        custom: req.custom,
    });
    if (result.unknown.length > 0) {
        log.warn(vscode.l10n.t("Unknown placeholders in command template (kept as-is on the command line): {0}", result.unknown.join(", ")));
    }
    log.debug(vscode.l10n.t("Expanded launch command ({0} segments): {1}", result.argv.length, result.argv.join(" ")));
    return result;
}
