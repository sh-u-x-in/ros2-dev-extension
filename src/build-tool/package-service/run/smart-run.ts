// Licensed under the MIT License.

/**
 * @file smart-run.ts(2026-09-25 新增)
 * `ros2 run` 的交互编排 —— 仿 build/smart-build.ts 的"选择 + 记忆":
 *   命令面板 = 选包 → 选可执行 → 参数弹窗(pickPresets,记忆预填)→ 展开模板 → 任务终端执行 → 回写记忆;
 *   侧边栏树入口(lib 区 ▶)= 目标已知,跳过选择,直接参数弹窗 → 执行(共用 executeRunSelection)。
 *
 * ── 与 build 的关键差异(用户裁定 2026-09-25)────────────────────────
 * **每次都弹参数窗**、**记忆按目标分槽**(`ros2.run::<pkg>/<exe>`)——
 * 构建的参数对包均匀(静默套记忆收益高);运行参数因目标而异,静默套用收益低,但记忆预填省重敲。
 */

import * as vscode from "vscode";

import { getLogger } from "../../../logger";
import { composeApi } from "../../../ros2/api";
import { ros2RunMemoryId } from "../share/defaults/ros2-run";
import { pickPresets } from "../share/pick-preset";
import { readSelectionMemory, writeSelectionMemory } from "../share/selection-memory";
import { expandRos2Run, readRosRunSpec } from "./share-spec";
import { notifyStaleIfNeeded } from "./run-data-source";
import type { RunDataSource } from "./run-data-source";

/** smart-run 模块日志 */
const log = getLogger("smart-run");

/** 单个目标的完整运行流程:读记忆 → 参数弹窗(预填)→ 写记忆 → 展开 → 任务终端。
 *  stale(2026-10-13):仅 Ctrl+F10 源文件路径传入(源/安装双路径)——参数确认 + 展开成功后,
 *  若源比安装产物新,弹一条非模态警告气泡(纯附加,不等待不拦截;2026-10-14 起带「不再显示」按钮);面板/▶ 路径不传不查。 */
async function executeRunSelection(workspaceRoot: string, pkg: string, executable: string, stale?: { srcPath?: string; installPath?: string }): Promise<void> {
    const memory = await readSelectionMemory(workspaceRoot, ros2RunMemoryId(pkg, executable));
    const pick = await pickPresets(readRosRunSpec(), {
        title: vscode.l10n.t("Run {0}/{1} - run arguments", pkg, executable),
        placeholder: "勾选要追加的参数(多选;不勾则用模板默认)",
        customTitle: vscode.l10n.t("Run {0}/{1} - run arguments", pkg, executable),
        customPlaceholder: vscode.l10n.t("e.g. --ros-args -r __node:=demo (empty input = no arguments)"),
        customValue: memory.custom,
        remembered: { picked: memory.picked, custom: memory.custom.length > 0 },
    });
    if (pick === undefined) {
        log.trace("User cancelled at argument selection");
        return;
    }
    await writeSelectionMemory(workspaceRoot, ros2RunMemoryId(pkg, executable), {
        picked: pick.picked,
        custom: pick.custom ?? "",
    });

    const expanded = expandRos2Run({ pkg, executable, picked: pick.picked, custom: pick.custom });
    if (expanded.empty) {
        vscode.window.showErrorMessage(vscode.l10n.t("Run command expanded to empty; cancelled. Check the template in setting ROS2.run.shareSpec."));
        return;
    }
    // 运行照常先行;陈旧附加警告(2026-10-13,用户裁定「附加不阻碍」)随后——不等待,2026-10-14 起为警告气泡+「不再显示」按钮
    const running = composeApi.rosTaskRunner.run({ argv: expanded.argv, pkg, executable, cwd: workspaceRoot });
    notifyStaleIfNeeded("run", pkg, executable, stale?.srcPath, stale?.installPath);
    await running;
    log.debug(vscode.l10n.t("Run executed: {0}/{1}, presets [{2}]", pkg, executable, pick.picked.join(",")));
}

/** 命令面板入口(ROS2.run):选包 → 选可执行 → 参数弹窗 → 执行 */
export async function runRosExecutable(data: RunDataSource | null): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot === undefined) {
        vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder found"));
        return;
    }
    if (data === null) {
        vscode.window.showErrorMessage(vscode.l10n.t("Executable info not ready; cannot run (please wait and retry)"));
        return;
    }
    const packages = await data.listPackages();
    if (packages.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t("No built & installed packages found — run colcon build first, then run."));
        return;
    }
    const pkg = await vscode.window.showQuickPick(packages, { placeHolder: vscode.l10n.t("Select a package") });
    if (pkg === undefined) {
        return;
    }
    const executables = await data.executablesOf(pkg);
    if (executables.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t("Package {0} has no executables (for Python packages check that console_scripts entry points are exported).", pkg));
        return;
    }
    const executable = await vscode.window.showQuickPick(executables, { placeHolder: vscode.l10n.t("Select an executable of {0}", pkg) });
    if (executable === undefined) {
        return;
    }
    await executeRunSelection(workspaceRoot, pkg, executable);
}

/** 一键运行(Ctrl+F10,.py/.cpp):源文件 → ownersOfSource → 所属可执行直接运行。
 *  双警告(2026-10-13 方案甲,用户裁定):①0 属主 = 完全未编译/无映射 → 提示先构建;
 *  ②属主全在但安装侧未就绪 = 已编译未安装(或安装失败/无安装规则)→ 警告先 colcon build。
 *  多属主 → QuickPick 选;不自动构建。 */
export async function runActiveEditor(data: RunDataSource | null, srcPath: string): Promise<void> {
    if (data === null) {
        vscode.window.showErrorMessage(vscode.l10n.t("Executable info not ready; cannot run (please wait and retry)"));
        return;
    }
    const owners = await data.ownersOfSource(srcPath);
    // 警告①:完全未编译(或源未映射)—— 跳转表无任何记录
    if (owners.runnable.length === 0 && owners.compiledNotInstalled.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t("This file is not built or not mapped to an install-side executable — build first (colcon build), then run."));
        return;
    }
    // 警告②:已编译但安装侧未就绪(没装/装失败/无安装规则)—— 跳转表有记录但 lib 区无 installed 可执行行
    if (owners.runnable.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t(
            "Compiled but not installed: {0} mapped executable(s) are missing from the install tree — run colcon build to install, then retry.",
            owners.compiledNotInstalled.length));
        return;
    }
    let target = owners.runnable[0];
    if (owners.runnable.length > 1) {
        const picked = await vscode.window.showQuickPick(
            owners.runnable.map((o) => ({ label: `${o.pkg} · ${o.executable}`, target: o })),
            { placeHolder: vscode.l10n.t("This source file maps to multiple executables; pick one to run") }
        );
        if (picked === undefined) {
            return;
        }
        target = picked.target;
    }
    await runExecutableFromTree(target, { srcPath: target.srcPath, installPath: target.installPath });
}

/** 侧边栏树入口(lib 区 ▶):目标已知,跳过选择,直接参数弹窗 → 执行。
 *  stale 仅 Ctrl+F10 路径传入(侧边栏 ▶ 无源语境,不做陈旧判定)。 */
export async function runExecutableFromTree(req: { pkg: string; executable: string }, stale?: { srcPath?: string; installPath?: string }): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot === undefined) {
        vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder found"));
        return;
    }
    await executeRunSelection(workspaceRoot, req.pkg, req.executable, stale);
}
