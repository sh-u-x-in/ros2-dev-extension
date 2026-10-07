// Licensed under the MIT License.

/**
 * @file smart-build.ts(2026-08-31 git mv 自 build-command.ts:旧名与 register-commands / command-ids 三方撞名,
 *   且未体现"两级选择 + 记忆"的交互流程本质)。
 * 智能构建命令(ROS2.colcon.build / Ctrl+Shift+B)。
 * 两级选择(多选包 → 参数多选/自定义输入)→ 执行 colcon build；
 * 包列表走缓存(未命中才现场 colcon list 兜底)；记忆上次选择(文件落盘)用于默认预选。
 * 2026-08-31(链路收敛 A):任务构造委托 RosTaskRunner.colcon_build(原内联 makeBuildTask 已删)。
 * 2026-08-31(#4 方案 B):包数据源经参数注入(BuildDataSource,组合根传 packageCore 实例),不再反取 extension 全局。
 * 2026-08-31(#8):空构建与有包分支彻底合并——空构建 = 包列表为空的特例,统一两级选择流程。
 * 2026-09-22(布局检查):第一个选择弹窗出现时**并发**弹出"安装布局不一致"警告(不带按钮、不阻塞;
 *   用户可无视风险走完两级选择并构建)。检查实现在 install-layout-check.ts。
 * 2026-09-22(形态检查):选完包之后按包查表(install-method-check.ts)——本次形态 vs 磁盘事实:
 *   ① 配置形态不一致时给本次构建自动加 --cmake-clean-cache;② 硬冲突(静默无效)→ 非阻塞提示。
 * 2026-09-22(**接线**):第二个弹窗由"四条固定构建配置(Release/Debug × 默认/详细)"改为
 *   **模板引擎**的通用弹窗(pick-presets):自定义输入(仅当模板含 `${0}`)+ 预设多选;
 *   命令不再由代码拼装,而是 `share-spec.expandColconBuild()` 按设置里的模板展开成整条 argv
 *   (内置模板在普通输出下与旧命令**逐字节等价**,见 share 单测)。
 */

import { getLogger } from "../../../logger";
import * as vscode from "vscode";

import * as buildMemory from "../share/build-memory";
import { checkInstallMethod } from "./install-method-check";
import { warnInstallLayoutMismatch } from "./install-layout-check";
import { showInstallMethodWarning } from "./preflight-warnings";
import { resolveInstallType } from "./install-type";
import { expandColconBuild, readColconBuildSpec } from "./share-spec";
import { pickPresets } from "../share/pick-preset";
import { COLCON_BUILD_COMMAND_ID } from "../share/defaults/colcon-build";
import { readSelectionMemory, writeSelectionMemory } from "../share/selection-memory";
import { composeApi } from "../../../ros2/api";
import type { BuildDataSource } from "./data-source";

/** 扩展日志薄封装(带 smart-build 模块前缀) */
const log = getLogger("smart-build");

/**
 * 构建 ROS 2 包:两级选择(多选包 → 参数多选/自定义输入)→ 执行 colcon build。
 * 包列表走缓存(命中即返回,未命中才现场 colcon list 兜底),记忆上次选择
 * (文件落盘 .vscode/ros2-dev-extension-state.json)用于默认预选。
 * 2026-08-31(#8):空构建与有包分支合并——空构建 = 包列表为空的特例(弹窗仍显示空列表让用户直观看到无包)。
 */
export async function runColconBuild(data: BuildDataSource | null): Promise<void> {
    log.trace("Smart build: runColconBuild entry");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        log.error("No workspace folder found; cannot build");
        vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder found"));
        return;
    }
    if (!data) {
        log.error("Package info not ready; cannot build");
        vscode.window.showErrorMessage(vscode.l10n.t("Package info not ready; cannot build (please wait and retry)"));
        return;
    }

    // ① 获取工作区包列表 + 空构建策略判定(空构建 = 包列表为空的特例,统一流程)
    const rosConfig = vscode.workspace.getConfiguration("ROS2");
    const packages = await data.getBuildPackages();
    log.debug(vscode.l10n.t("Fetched {0} workspace packages", packages.length));
    if (packages.length === 0 && !rosConfig.get<boolean>("build.allowEmptyWorkspace", true)) {
        log.info("No ROS 2 packages and empty builds not allowed; build refused");
        // 二级动作按钮(2026-10-04 i18n 期0):显示与返回值判定同源常量(见 install-truth-sidebar 同款注释)
        const BTN_ALLOW_EMPTY_BUILD = vscode.l10n.t("Allow empty builds in Settings");
        const action = await vscode.window.showWarningMessage(
            vscode.l10n.t("No ROS 2 packages found in the workspace; build refused."),
            BTN_ALLOW_EMPTY_BUILD
        );
        if (action === BTN_ALLOW_EMPTY_BUILD) {
            await vscode.commands.executeCommand("workbench.action.openSettings", "ROS2.build.allowEmptyWorkspace");
        }
        return;
    }
    if (packages.length === 0) {
        log.debug("No packages; entering empty-build flow (empty package list special case)");
    }

    // ② 读取记忆(文件落盘):包选择走 build-memory;二级参数选择走通用选择记忆(share/selection-memory)
    const state = await buildMemory.readBuildState(workspaceRoot);
    const memory = await readSelectionMemory(workspaceRoot, COLCON_BUILD_COMMAND_ID);
    log.debug(vscode.l10n.t("Memory read: presets [{0}] / {1} packages remembered", memory.picked.join(","), state.buildPackages.length));

    // 第 1 步:多选包(空构建时列表为空,弹窗让用户直观看到无包,回车继续)
    // 勾选语义(2026-08-31 #8 调整):已勾选 || 新出现的包(不在 knownPackages 快照中,用户从未对其做过排除)默认勾选
    const packageItems: vscode.QuickPickItem[] = packages.map(p => ({
        label: p.name,
        picked: state.buildPackages.length === 0 || state.buildPackages.includes(p.name) || !state.knownPackages.includes(p.name),
    }));
    // 2026-09-22(布局检查):在"第一个选择弹窗出现的同时"并发弹出安装布局不一致警告——
    // 不阻塞、不带按钮:用户可无视风险,继续走完两级选择并构建(colcon 侧该报的错照报)。
    void warnInstallLayoutMismatch(workspaceRoot, resolveInstallType().layout);
    const selected = await vscode.window.showQuickPick(packageItems, {
        canPickMany: true,
        title: packages.length === 0 ? vscode.l10n.t("Build ROS 2 Packages - Select Packages (no packages in workspace)") : vscode.l10n.t("Build ROS 2 Packages - Select Packages"),
        placeHolder: packages.length === 0 ? vscode.l10n.t("No ROS 2 packages in the workspace; press Enter to continue") : vscode.l10n.t("Select packages to build (all selected by default; uncheck to exclude)"),
    });
    if (!selected) {
        log.trace("User cancelled at package selection");
        return; // 用户取消
    }
    const selectedPackages = selected.map(s => s.label);
    log.debug(vscode.l10n.t("User selected {0} packages", selectedPackages.length));

    // 2026-09-22(形态检查):与**第二个选择项(构建配置)**并发弹通知——
    // W2/W3 依赖"选中了哪些包",精度与 W1(工作区级、随第一个选择项)不同,故放在第二级;
    // 不 await:检查完成(几 ms)即弹,与第二个弹窗并存;构建前再取结论里的 cleanCache。
    const installType = resolveInstallType();
    const methodPlanPromise = checkInstallMethod(workspaceRoot, selectedPackages, installType);
    void methodPlanPromise.then((plan) => {
        showInstallMethodWarning(plan);
    });

    // 第 2 步:参数多选(模板引擎的通用弹窗)+ 可选自定义输入
    // 2026-09-22(接线):预设/描述/是否出现自定义输入项,全部由设置里的 spec 决定;
    //   弹窗形态由 presetPickPlan 自动选择(无预设且模板不用 ${0} ⇒ 整个第二级都不弹)。
    const spec = readColconBuildSpec();
    const pick = await pickPresets(spec, {
        title: vscode.l10n.t("Build ROS 2 Packages - Select Arguments"),
        placeholder: vscode.l10n.t("Check arguments to append (multi-select; leave unchecked to use template defaults)"),
        customTitle: vscode.l10n.t("Build ROS 2 Packages - Custom Input"),
        customPlaceholder: vscode.l10n.t("e.g. --continue-on-error --cmake-args -DCMAKE_BUILD_TYPE=Debug"),
        customValue: memory.custom,
        remembered: { picked: memory.picked, custom: memory.custom.length > 0 },
    });
    if (!pick) {
        log.trace("User cancelled at argument selection");
        return;
    }
    log.debug(vscode.l10n.t("User checked {0} presets{1}", pick.picked.length, pick.custom ? vscode.l10n.t(" + custom input") : ""));

    // ③ 记住本次选择(两条记忆各写各的槽,互不覆盖):
    //  · 包选择 → build-memory;knownPackages 快照用于识别"新出现的包"并默认勾选;
    //  · 二级参数选择 → selection-memory(只记选择:预设下标 + 自定义输入的完整原文)。
    await buildMemory.writeBuildState(workspaceRoot, {
        buildPackages: selectedPackages,
        knownPackages: packages.map(p => p.name),
    });
    await writeSelectionMemory(workspaceRoot, COLCON_BUILD_COMMAND_ID, {
        picked: pick.picked,
        custom: pick.custom ?? "",
    });

    // ④ 按设置里的模板展开成整条命令行(两轴由设置解析,与上面的前瞻检查同源)
    // 取形态检查结论(通知已在第二个弹窗出现时弹出)
    const methodPlan = await methodPlanPromise;
    const expanded = expandColconBuild({
        base_path: workspaceRoot,
        packages: selectedPackages,
        clean: methodPlan.cleanCache,
        picked: pick.picked,
        custom: pick.custom,
    });
    if (expanded.empty) {
        log.error("Template expanded to empty; build cancelled (check ROS2.build.shareSpec.template)");
        vscode.window.showErrorMessage(vscode.l10n.t("Build command expanded to empty; cancelled. Check the template in setting ROS2.build.shareSpec."));
        return;
    }

    // ⑤ 执行构建(命令内容完全由模板决定;经 RosTaskRunner.colcon_build 统一执行链路)
    await composeApi.rosTaskRunner.colcon_build({
        base_path: workspaceRoot,
        packages: selectedPackages,
        argv: expanded.argv,
    });
    log.debug(vscode.l10n.t("Build executed: {0} packages, presets [{1}]", selectedPackages.length, pick.picked.join(",")));
}

// 2026-09-22(接线):原 `pickBuildConfig`(单选四条固定构建配置,createQuickPick + activeItems 预选)
// 已删除 —— 第二个弹窗改为 `share/pick-preset.pickPresets()`(通用三态 + 多选 + 可选自定义输入),
// 命令构造改为 `share-spec.expandColconBuild()` 按设置模板展开;
// ros2 层只执行调用方给的 argv(内置构造已删,无回退路径)。
