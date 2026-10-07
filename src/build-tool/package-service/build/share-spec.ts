// Licensed under the MIT License.

/**
 * @file share-spec.ts(2026-09-22 接线新增)
 * 「可共享命令参数模板」与构建域的**接线适配层**:读设置 → 与出厂默认合并 → 展开成本次构建的 argv。
 *
 * ── 为什么适配层放在 build 域 ──────────────────────────────────────
 *  · 引擎(`share/`)不认识 vscode(除通用弹窗),也不认识任何具体命令;
 *  · `ros2/` 是下层,不认识模板 —— 它只收**现成 argv**(`ColconBuildOptions.argv`);
 *  · 于是"读设置 + 装填命名动态参数"这一步落在**中间层**(build 域),依赖方向保持 build → ros2。
 *
 * ── 两轴从哪来 ────────────────────────────────────────────────────
 * `${install_method}` / `${install_layout}` 的值来自**设置**(`resolveInstallType()`),
 * 与两项前瞻检查(`checkInstallMethod` / `warnInstallLayoutMismatch`)**同源** ⇒ 检查的形态与构建的形态必然一致。
 */

import * as vscode from "vscode";

import { getLogger } from "../../../logger";
import { COLCON_BUILD_COMMAND_ID, COLCON_BUILD_SPEC, colconBuildDynamics } from "../share/defaults/colcon-build";
import { expandCommand, mergeSpec } from "../share/expand";
import { readSelectionMemory } from "../share/selection-memory";
import type { CommandSpec, ExpandResult } from "../share/types";
import { resolveInstallType } from "./install-type";

/** share-spec 模块日志 */
const log = getLogger("share-spec");

/** 设置键(前缀 `ROS2.` 由 getConfiguration 提供) */
export const SHARE_SPEC_SETTING = "build.shareSpec";

/**
 * 读设置里的 spec:字段缺失回落出厂默认;**显式给空**(如 `argv_list: []`)则尊重用户(见 `mergeSpec`)。
 * 设置项整体不存在 ⇒ 整份出厂默认 == 今天的内置命令(逐字节等价,由单测锁定)。
 */
export function readColconBuildSpec(): CommandSpec {
    const raw = vscode.workspace.getConfiguration("ROS2").get<Partial<CommandSpec>>(SHARE_SPEC_SETTING);
    return mergeSpec(raw, COLCON_BUILD_SPEC);
}

/** 构建域交给引擎的输入(两轴不在此暴露:它们由设置解析,见文件头)*/
export interface ColconBuildRequest {
    /** 工作区根(${base_path}) */
    base_path: string;
    /** 本次选中的包(${packages_select});空/缺省 = 全量构建 */
    packages?: readonly string[];
    /** 形态检查结论:需要时自动加 --cmake-clean-cache(${clean}) */
    clean?: boolean;
    /** 二级弹窗勾选的预设下标(0 基) */
    picked?: readonly number[];
    /** 二级弹窗的自定义输入(仅当模板里用到 ${0} 时才会出现) */
    custom?: string;
}

/**
 * 展开本次构建的完整命令行(含命令名,即 argv[0] 通常是 `colcon`)。
 * 未知占位符会原样保留在 argv 里 —— 这里只记日志,**不擅自剔除**(拼错要当场暴露)。
 */
export function expandColconBuild(req: ColconBuildRequest): ExpandResult {
    const spec = readColconBuildSpec();
    const dynamics = colconBuildDynamics({
        base_path: req.base_path,
        packages: req.packages,
        clean: req.clean,
        install_type: resolveInstallType(),
    });
    const result = expandCommand(spec, { dynamics, picked: req.picked, custom: req.custom });
    if (result.unknown.length > 0) {
        log.warn(vscode.l10n.t("Unknown placeholders in command template (kept as-is on the command line): {0}", result.unknown.join(", ")));
    }
    log.debug(vscode.l10n.t("Expanded build command ({0} segments): {1}", result.argv.length, result.argv.join(" ")));
    return result;
}

/**
 * **右键单包构建用**:不弹任何参数选择,直接套用"选择记忆"(勾过的预设 + 上次自定义输入);
 * **记忆为空 ⇒ `picked=[]` / `custom=""`** ⇒ 等价于"直接用模板"(设置没写就是出厂默认模板)。
 * 与智能构建的区别只有一处:智能构建会先弹窗让人改，这里不弹。
 */
export async function expandColconBuildWithMemory(req: ColconBuildRequest): Promise<ExpandResult> {
    const memory = await readSelectionMemory(req.base_path, COLCON_BUILD_COMMAND_ID);
    return expandColconBuild({ ...req, picked: memory.picked, custom: memory.custom });
}
