// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file register-commands.ts(2026-08-31 git mv 自 colcon-command.ts:与 command-ids.ts 对偶——本文件是注册逻辑,那边是 ID 常量表)。
 * colcon 构建相关命令注册(2026-08-30 自 src/commands/colcon.ts 收编,git mv 保留历史)。
 * 职责边界(与 package-service/build 的关系):
 *  - 本文件 = 轻命令注册:忽略切换(COLCON_IGNORE)+ 右键单包构建(Release/Debug);
 *    数据来源经参数注入(BuildDataSource,组合根传 packageCore 实例——2026-08-31 #4 方案 B,
 *    不再反取 extension 全局;包名 + 路径,不直接读 package.xml 文件);
 *  - smart-build.ts = 智能构建(Ctrl+Shift+B)业务主体,本文件仅委托;
 *  - install-layout-check.ts = 构建前安装布局检查(不一致 → 非阻塞警告,两个入口共用);
 *  - install-method-check.ts = 构建前安装形态检查(查六格矩阵 → 自动 --cmake-clean-cache + 非阻塞提示);
 *  - colcon-task-provider.ts = colcon 任务提供器(ColconProvider,解析 tasks.json 自定义 colcon 任务);
 *    构建执行统一经 RosTaskRunner.colcon_build(2026-08-31 链路收敛 A,原 makeColconPackageTask 已删)。
 * 组装:经本子域 index.ts 导出,过渡期由 commands/index.ts 转发,远期 extension 直连。
 */

import { getLogger } from "../../../logger";
import * as vscode from "vscode";
import * as path from "path";

import { ensureErrorMessageOnException } from "../../../error-utils";
import { ColconBuildCommand, ColconBuildPackageDebugCommand, ColconBuildPackageReleaseCommand, ColconToggleIgnoreCommand } from "./command-ids";
import { buildSinglePackageByName } from "./single-package";
import * as smartBuild from "./smart-build";
import type { BuildDataSource } from "./data-source";

/** 扩展日志薄封装(带 register-commands 模块前缀) */
const log = getLogger("register-commands");

/**
 * 本地 findPackageForPath(2026-08-30:数据源切 package-core.getBuildPackages,与智能构建同口径)。
 * 仅"可构建包"(unignored,getBuildPackages 命中缓存立即返回/未命中只跑 colcon list)可被单包构建;
 * 被 COLCON_IGNORE 的包(ignored)命中时返回 status=ignored,由调用方提示,不放行构建(colcon 会报包不存在)。
 */
async function findPackageForPath(data: BuildDataSource | null, folderPath: string): Promise<{ name: string; status: "buildable" | "ignored" } | undefined> {
    if (!data) {
        return undefined;
    }
    const state = data.getState();
    if (!state) {
        return undefined;
    }
    // 命中判定:folderPath 等于包目录,或位于包目录之下(包内任意子路径)
    const hit = (p: { name: string; dir: string }): boolean =>
        folderPath === p.dir || folderPath.startsWith(p.dir + path.sep);
    // 可构建列表(与智能构建同一数据源:getBuildPackages = unignored)
    const buildable = await data.getBuildPackages();
    const b = buildable.find(hit);
    if (b) {
        return { name: b.name, status: "buildable" };
    }
    // 被忽略包:不构建,提示用户
    const ig = (state.ignored ?? []).find(hit);
    if (ig) {
        return { name: ig.name, status: "ignored" };
    }
    return undefined;
}

/**
 * 注册 colcon 构建相关命令:忽略切换(COLCON_IGNORE)+ 右键单包构建(Release/Debug)+ 智能构建委托。
 */
export function registerColconCommands(context: vscode.ExtensionContext, data: BuildDataSource | null): void {
    log.trace("Registering colcon commands");
    // 命令:切换 COLCON_IGNORE 忽略状态(右键文件夹)
    vscode.commands.registerCommand(ColconToggleIgnoreCommand, async (uri: vscode.Uri) => {
        ensureErrorMessageOnException(async () => {
            log.trace(vscode.l10n.t("Executing command: {0}", ColconToggleIgnoreCommand));
            if (!uri || !uri.fsPath) {
                vscode.window.showErrorMessage(vscode.l10n.t("Right-click a folder to toggle its COLCON_IGNORE status"));
                return;
            }

            // 翻转 COLCON_IGNORE(2026-08-28:切 package-core.toggleIgnore,取代旧壳 toggleColconIgnore + flushPackagesSyncNow)
            if (!data) {
                vscode.window.showErrorMessage(vscode.l10n.t("Package info not ready; cannot toggle ignore status (please wait and retry)"));
                return;
            }
            const nowIgnored = await data.toggleIgnore(uri.fsPath);

            const message = nowIgnored
                ? vscode.l10n.t("COLCON_IGNORE created; the directory will be ignored: {0}", uri.fsPath)
                : vscode.l10n.t("COLCON_IGNORE removed; the directory will build again: {0}", uri.fsPath);
            log.info(message);
            vscode.window.showInformationMessage(message);
        });
    });

    // TODO: 旧"按包名配置忽略"的右键菜单上下文(ros2.packageIgnored / ROS2.colcon.updateIgnoredContext)已废弃,
    // 忽略判定统一走 COLCON_IGNORE 文件标记;若需右键菜单按忽略态显隐,待重新设计。

    // 命令:右键单包构建 Release(RelWithDebInfo 优化构建)
    vscode.commands.registerCommand(ColconBuildPackageReleaseCommand, async (uri: vscode.Uri) => {
        ensureErrorMessageOnException(async () => {
            if (!uri || !uri.fsPath) {
                vscode.window.showErrorMessage(vscode.l10n.t("Right-click a folder to build a package"));
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder found"));
                return;
            }

            // 按路径查找包(2026-08-30:仅可构建包放行,被忽略包提示)
            const found = await findPackageForPath(data, uri.fsPath);
            if (!found) {
                vscode.window.showWarningMessage(vscode.l10n.t("No ROS 2 package found at this location"));
                return;
            }
            if (found.status === "ignored") {
                vscode.window.showWarningMessage(vscode.l10n.t("Package {0} is ignored by COLCON_IGNORE; cannot build it directly", found.name));
                return;
            }

            log.debug(vscode.l10n.t("Building package (Release): {0}", found.name));
            // 2026-09-25(第五批):执行体抽到 single-package.buildSinglePackageByName ——
            // 与包内容侧边栏的"构建此包"共用同一入口(检查/警告并发 + 记忆展开 + 执行)
            await buildSinglePackageByName(data, found.name, "release");
        });
    });

    // 命令:右键单包构建 Debug(调试构建)
    vscode.commands.registerCommand(ColconBuildPackageDebugCommand, async (uri: vscode.Uri) => {
        ensureErrorMessageOnException(async () => {
            if (!uri || !uri.fsPath) {
                vscode.window.showErrorMessage(vscode.l10n.t("Right-click a folder to build a package"));
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder found"));
                return;
            }

            // 按路径查找包(2026-08-30:仅可构建包放行,被忽略包提示)
            const found = await findPackageForPath(data, uri.fsPath);
            if (!found) {
                vscode.window.showWarningMessage(vscode.l10n.t("No ROS 2 package found at this location"));
                return;
            }
            if (found.status === "ignored") {
                vscode.window.showWarningMessage(vscode.l10n.t("Package {0} is ignored by COLCON_IGNORE; cannot build it directly", found.name));
                return;
            }

            log.debug(vscode.l10n.t("Building package (Debug): {0}", found.name));
            await buildSinglePackageByName(data, found.name, "debug");
        });
    });

    // 智能构建:Ctrl+Shift+B 两级选择(多选包 + 单选构建配置),带记忆
    vscode.commands.registerCommand(ColconBuildCommand, () => {
        ensureErrorMessageOnException(async () => {
            log.trace(vscode.l10n.t("Executing command: {0}", ColconBuildCommand));
            await smartBuild.runColconBuild(data);
        });
    });
}