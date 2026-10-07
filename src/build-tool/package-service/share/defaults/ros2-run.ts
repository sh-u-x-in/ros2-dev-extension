// Licensed under the MIT License.

/**
 * @file defaults/ros2-run.ts(2026-09-25 新增)
 * `ros2 run` 的**出厂默认(种子)** + 「本次目标 → 命名动态参数」纯映射。
 * 与 `defaults/colcon-build.ts` 同构:spec(模板 + 预设 + 自定义描述)+ dynamics 映射 + 命令记忆 id;
 * 引擎(`../expand.ts`)、弹窗(`../pick-preset.ts`)、选择记忆(`../selection-memory.ts`)与 colcon build 共用同一份。
 *
 * ── 出厂模板只含 `${0}` ⇒ 二级弹窗形态 = input-only ─────────────────
 * 每次运行都弹**参数输入框**(预填上次的参数,记忆按 `包/可执行` 分槽),Esc = 取消本次运行;
 * `argv_list` 出厂为空 ⇒ 没有预设列表项。用户往设置里加预设/槽位后,弹窗自动升级为
 * "多选列表 + 自定义输入"形态(`presetPickPlan` 自动判定,机制与 colcon build 完全一致)。
 *
 * ── 变量口径(2 个)─────────────────────────────────────────────────
 * `${pkg}`(裸值,自动引号)/ `${executable}`(裸值,自动引号)。
 * 参数放行尾 `${0}`:不输入(空回车)= 纯 `ros2 run <pkg> <exe>`。
 *
 * 纯 TS,零 vscode,可无头单测。
 */

import { quoteShellArg } from "../expand";
import type { CommandSpec } from "../types";

/**
 * `ros2 run` 的**命令 id**:选择记忆(selection-memory)的分槽**前缀**。
 * 实际记忆键 = `${ROS2_RUN_COMMAND_ID}::<pkg>/<executable>`(`ros2RunMemoryId`)——
 * 每个可执行一个槽,互不串记忆(用户裁定 2026-09-25:参数因目标而异,不能像 colcon build 那样一条命令一个槽)。
 */
export const ROS2_RUN_COMMAND_ID = "ros2.run";

/** 出厂默认模板 + 空预设(整份存设置 `ROS2.run.shareSpec`,字段没给才回落到这里;模板 = 命令文本,引擎按 shell 词法切分) */
export const ROS2_RUN_SPEC: CommandSpec = {
    template: "ros2 run ${pkg} ${executable} ${0}",
    // (2026-10-04 i18n 期2,D3 裁定)出厂输入框描述走语言中立英文,与 manifest default 同步
    custom: "Run arguments: arguments passed to the executable (multiple segments and quotes allowed; empty input = no arguments)",
    argv_list: [],
};

/** 「本次运行目标」→ 命名动态参数片段(纯映射;调用方把目标从弹窗/侧边栏取好传进来即可) */
export interface Ros2RunDynamicsInput {
    /** 包名(${pkg}) */
    pkg: string;
    /** 可执行名(${executable}) */
    executable: string;
}

/** 目标 → 动态参数(裸值,必要时自动加引号;不含参数段 —— 参数走 `${0}`/槽位) */
export function ros2RunDynamics(input: Ros2RunDynamicsInput): Record<string, string> {
    return {
        pkg: quoteShellArg(input.pkg),
        executable: quoteShellArg(input.executable),
    };
}

/** 选择记忆键:`ros2.run::<pkg>/<executable>`(每个可执行一个槽,不同目标互不串) */
export function ros2RunMemoryId(pkg: string, executable: string): string {
    return `${ROS2_RUN_COMMAND_ID}::${pkg}/${executable}`;
}
