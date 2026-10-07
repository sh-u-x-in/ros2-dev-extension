// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file single-package.ts(2026-09-25 第五批新增)
 * **单包构建的公共执行体**:右键文件夹构建(register-commands.ts)与包内容侧边栏的
 * "构建此包"(src/sidebar)共用同一入口 —— 按包名执行,参数套用"选择记忆"(不弹窗)。
 * 2026-09-25 用户:"为每个包接入单包构建(不知道是什么时候丢的)" —— 即此入口。
 *
 * 执行链与右键单包一致(2026-09-22 接线版):形态检查(必要时自动 --cmake-clean-cache)
 * + 布局警告并发 → `expandColconBuildWithMemory`(记忆展开,Release 模板默认构建类型)
 * → `RosTaskRunner.colcon_build`;Debug 变体在展开结果之后追加覆盖参数(实测重复 --cmake-args 安全)。
 */

import * as vscode from "vscode";

import { composeApi } from "../../../ros2/api";
import { getLogger } from "../../../logger";
import { checkInstallMethod } from "./install-method-check";
import { warnInstallLayoutMismatch } from "./install-layout-check";
import { showInstallMethodWarning } from "./preflight-warnings";
import { resolveInstallType } from "./install-type";
import { expandColconBuildWithMemory } from "./share-spec";
import type { BuildDataSource } from "./data-source";

/** single-package 模块日志 */
const log = getLogger("single-package");

/**
 * 按**包名**构建单个包(套用选择记忆;Debug 变体追加 -DCMAKE_BUILD_TYPE=Debug 覆盖模板)。
 * 包必须在可构建列表里(被 COLCON_IGNORE 的包不放行 —— colcon 会报包不存在)。
 */
export async function buildSinglePackageByName(
    data: BuildDataSource | null,
    name: string,
    variant: "release" | "debug" = "release"
): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder found"));
        return;
    }
    if (!data) {
        vscode.window.showErrorMessage(vscode.l10n.t("Package info not ready; cannot build (please wait and retry)"));
        return;
    }
    const buildable = await data.getBuildPackages();
    const hit = buildable.find((p) => p.name === name);
    if (!hit) {
        vscode.window.showWarningMessage(vscode.l10n.t("Package {0} is not buildable (ignored by COLCON_IGNORE, or not a package of this workspace)", name));
        return;
    }

    log.debug(vscode.l10n.t("Single-package build ({0}): {1}", variant, name));
    // 与右键单包同款:检查与警告并发弹出,不阻塞选择(无弹窗流程)
    const installType = resolveInstallType();
    const methodPlan = await checkInstallMethod(workspaceRoot, [name], installType);
    showInstallMethodWarning(methodPlan);
    void warnInstallLayoutMismatch(workspaceRoot, installType.layout);

    const expanded = await expandColconBuildWithMemory({
        base_path: workspaceRoot,
        packages: [name],
        clean: methodPlan.cleanCache,
    });
    if (expanded.empty) {
        vscode.window.showErrorMessage(vscode.l10n.t("Build command expanded to empty; cancelled. Check the template in setting ROS2.build.shareSpec."));
        return;
    }
    const argv = variant === "debug" ? [...expanded.argv, "--cmake-args", "-DCMAKE_BUILD_TYPE=Debug"] : expanded.argv;
    await composeApi.rosTaskRunner.colcon_build({
        base_path: workspaceRoot,
        packages: [name],
        argv,
    });
    log.debug(vscode.l10n.t("Single-package build executed: {0} ({1}), preset memory applied", name, variant));
}
