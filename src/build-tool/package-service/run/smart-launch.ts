// Licensed under the MIT License.

/**
 * @file smart-launch.ts(2026-09-25 新增)
 * `ros2 launch` 的交互编排:
 *   命令面板 = 单级列出 install 里全部 launch 文件(label=文件名、description=包名)→ 参数弹窗 → 执行;
 *   侧边栏树入口(launch 区 ▶)= 目标已知,直接参数弹窗 → 执行(共用 executeLaunchSelection)。
 *
 * ── 记忆**按源文件路径分槽**(用户裁定 2026-09-25)──────────────────
 * 键 = `ros2.launch::<源文件绝对路径>`(无源退化为安装路径)—— 不同包允许同名 launch,
 * 按包名/文件名分槽都会串,只有路径唯一;源路径跨构建稳定,记忆跟着文件走。
 */

import * as path from "path";

import * as vscode from "vscode";

import { getLogger } from "../../../logger";
import { composeApi } from "../../../ros2/api";
import { ros2LaunchMemoryId } from "../share/defaults/ros2-launch";
import { pickPresets } from "../share/pick-preset";
import { readSelectionMemory, writeSelectionMemory } from "../share/selection-memory";
import type { LaunchTarget, RunDataSource } from "./run-data-source";
import { expandRos2Launch, readRosLaunchSpec } from "./share-spec";

/** smart-launch 模块日志 */
const log = getLogger("smart-launch");

/** 单个目标的完整启动流程:读记忆 → 参数弹窗(预填)→ 写记忆 → 展开 → 任务终端 */
async function executeLaunchSelection(workspaceRoot: string, target: LaunchTarget): Promise<void> {
    const memoryId = ros2LaunchMemoryId(target);
    const memory = await readSelectionMemory(workspaceRoot, memoryId);
    const pick = await pickPresets(readRosLaunchSpec(), {
        title: vscode.l10n.t("Launch {0} / {1} - launch arguments", target.pkg, target.name),
        placeholder: "勾选要追加的参数(多选;不勾则用模板默认)",
        customTitle: vscode.l10n.t("Launch {0} / {1} - launch arguments", target.pkg, target.name),
        customPlaceholder: vscode.l10n.t("e.g. x:=1 y:=2 (empty input = no arguments)"),
        customValue: memory.custom,
        remembered: { picked: memory.picked, custom: memory.custom.length > 0 },
    });
    if (pick === undefined) {
        log.trace("用户在参数选择处取消");
        return;
    }
    await writeSelectionMemory(workspaceRoot, memoryId, { picked: pick.picked, custom: pick.custom ?? "" });

    const expanded = expandRos2Launch({
        pkg: target.pkg,
        launch_file: target.name,
        launch_path: target.installPath,
        picked: pick.picked,
        custom: pick.custom,
    });
    if (expanded.empty) {
        vscode.window.showErrorMessage(vscode.l10n.t("Launch command expanded to empty; cancelled. Check the template in setting ROS2.launch.shareSpec."));
        return;
    }
    await composeApi.rosTaskRunner.launch({
        argv: expanded.argv,
        pkg: target.pkg,
        launch_file: target.name,
        cwd: workspaceRoot,
    });
    log.debug(vscode.l10n.t("Launch executed: {0}/{1}, presets [{2}]", target.pkg, target.name, pick.picked.join(",")));
}

/** 命令面板入口(ROS2.launch):单级选 launch 文件 → 参数弹窗 → 执行 */
export async function runRosLaunchFile(data: RunDataSource | null): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot === undefined) {
        vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder found"));
        return;
    }
    if (data === null) {
        vscode.window.showErrorMessage(vscode.l10n.t("Launch file info not ready; cannot launch (please wait and retry)"));
        return;
    }
    const targets = await data.launchFiles();
    if (targets.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t("No launch files found under install — run colcon build first (the package must install its launch/ directory into share)."));
        return;
    }
    const selected = await vscode.window.showQuickPick(
        targets.map((t) => ({ label: t.name, description: t.pkg, target: t })),
        { placeHolder: vscode.l10n.t("Select a launch file"), matchOnDescription: true },
    );
    if (selected === undefined) {
        return;
    }
    await executeLaunchSelection(workspaceRoot, selected.target);
}

/** 一键运行(Ctrl+F10,.launch.*):源文件 → launchFiles 快照按 sourcePath 匹配 → 直接启动。
 *  未命中(未构建/无映射)→ 提示先构建,不自动构建。 */
export async function launchActiveEditor(data: RunDataSource | null, srcPath: string): Promise<void> {
    let target = await data.launchFileOfSource(srcPath);
    if (target === undefined) {
        // 兜底(2026-09-30 四轮):launch 行可能源解析缺失(无源行,install-rule 未命中)——
        // 按文件名匹配安装侧目标;唯一 → 直用,多个 → QuickPick,零个 → 提示先构建
        const base = path.basename(srcPath);
        const candidates = (await data.launchFiles()).filter(
            (t) => path.basename(t.installPath) === base || t.name === base
        );
        if (candidates.length === 1) {
            target = candidates[0];
        } else if (candidates.length > 1) {
            const picked = await vscode.window.showQuickPick(
                candidates.map((c) => ({ label: `${c.pkg} · ${c.name}`, target: c })),
                { placeHolder: vscode.l10n.t("A launch file with this name exists in multiple locations; pick one to launch") }
            );
            if (picked === undefined) {
                return;
            }
            target = picked.target;
        }
    }
    if (target === undefined) {
        vscode.window.showInformationMessage(vscode.l10n.t("This file is not built or not mapped to an install-side launch file — build first (colcon build), then launch."));
        return;
    }
    await launchFileFromTree(target);
}

/** 侧边栏树入口(launch 区 ▶):目标已知,直接参数弹窗 → 执行 */
export async function launchFileFromTree(req: {
    pkg: string;
    name: string;
    installPath: string;
    sourcePath?: string;
}): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot === undefined) {
        vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder found"));
        return;
    }
    await executeLaunchSelection(workspaceRoot, {
        pkg: req.pkg,
        name: req.name,
        installPath: req.installPath,
        sourcePath: req.sourcePath,
    });
}
