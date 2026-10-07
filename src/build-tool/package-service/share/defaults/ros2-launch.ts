// Licensed under the MIT License.

/**
 * @file defaults/ros2-launch.ts(2026-09-25 新增)
 * `ros2 launch` 的**出厂默认(种子)** + 「本次目标 → 命名动态参数」纯映射。
 * 与 `defaults/colcon-build.ts` 同构(spec + dynamics + 命令记忆 id),引擎/弹窗/记忆与 colcon build 共用。
 *
 * ── 出厂模板只含 `${0}` ⇒ 二级弹窗形态 = input-only ─────────────────
 * 每次启动都弹**参数输入框**(预填上次的参数),Esc = 取消本次启动;`argv_list` 出厂为空。
 * 用户往设置里加预设后,弹窗自动升级为"多选列表 + 自定义输入"形态。
 *
 * ── 变量口径(3 个)─────────────────────────────────────────────────
 * `${pkg}`(包名,自动引号)/ `${launch_file}`(包内相对安装路径,如 `demo.launch.py`,
 * 嵌套目录保留子路径如 `nested/foo.launch.py` —— 与 `ros2 launch <pkg> <file>` 的 file 口径一致)/
 * `${launch_path}`(**安装侧绝对路径**;把模板改成 `ros2 launch ${launch_path} ${0}` 即按路径启动)。
 * 参数放行尾 `${0}`:不输入(空回车)= 纯 `ros2 launch <pkg> <file>`。
 *
 * 纯 TS,零 vscode,可无头单测。
 */

import { quoteShellArg } from "../expand";
import type { CommandSpec } from "../types";

/**
 * `ros2 launch` 的**命令 id**:选择记忆(selection-memory)的分槽**前缀**。
 * 实际记忆键 = `${ROS2_LAUNCH_COMMAND_ID}::<源文件绝对路径>`(`ros2LaunchMemoryId`)——
 * **按源文件分槽**(用户裁定 2026-09-25:不同包允许同名 launch,包名/文件名都会串,只有路径唯一);
 * 无源的行(源未解析)退化为按安装路径分槽。
 */
export const ROS2_LAUNCH_COMMAND_ID = "ros2.launch";

/** 出厂默认模板 + 空预设(整份存设置 `ROS2.launch.shareSpec`,字段没给才回落到这里;模板 = 命令文本,引擎按 shell 词法切分) */
export const ROS2_LAUNCH_SPEC: CommandSpec = {
    template: "ros2 launch ${pkg} ${launch_file} ${0}",
    // (2026-10-04 i18n 期2,D3 裁定)出厂输入框描述走语言中立英文,与 manifest default 同步
    custom: "Launch arguments: arguments passed to the launch file (multiple segments and quotes allowed, e.g. x:=1 y:=2; empty input = no arguments)",
    argv_list: [],
};

/** 「本次启动目标」→ 命名动态参数片段(纯映射) */
export interface Ros2LaunchDynamicsInput {
    /** 包名(${pkg}) */
    pkg: string;
    /** 包内相对安装路径(${launch_file};嵌套目录保留子路径) */
    launch_file: string;
    /** 安装侧绝对路径(${launch_path};缺省 = 空串,该变量在模板里展开为空) */
    launch_path?: string;
}

/** 目标 → 动态参数(裸值,必要时自动加引号) */
export function ros2LaunchDynamics(input: Ros2LaunchDynamicsInput): Record<string, string> {
    return {
        pkg: quoteShellArg(input.pkg),
        launch_file: quoteShellArg(input.launch_file),
        launch_path: quoteShellArg(input.launch_path ?? ""),
    };
}

/**
 * 选择记忆键:`ros2.launch::<目标唯一路径>`。
 * 优先**源文件绝对路径**(跨构建稳定;不同包同名 launch 不串记忆),无源退化为安装路径。
 */
export function ros2LaunchMemoryId(target: { sourcePath?: string; installPath: string }): string {
    return `${ROS2_LAUNCH_COMMAND_ID}::${target.sourcePath ?? target.installPath}`;
}
