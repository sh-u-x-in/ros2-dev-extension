// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file status.ts
 * 环境可用性判定与工作区上下文(context key)更新。
 * 单一判定来源:state.getEnvIssue() === null(快捷键 context / 后台刷新 / 环境激活共用)。
 */

import { l10n } from "vscode";


import * as state from "./state";
import { getConfig } from "../host/config";
import { setContext } from "../host/commands";

import { getLogger } from "../../logger";

/** 环境状态模块日志 */
const log = getLogger("status");

/**
 * 打印 ROS 环境校验日志(发行版匹配 + 版本报告),仅在 activateEnvironment 调用一次,避免刷屏。
 * 发行版是固定字符串,可对照已知 ROS 2 发行版列表匹配,结果写入扩展日志。
 */
export function logRosEnvironmentStatus(): void {
    const env = state.getEnv();
    if (!env) {
        log.warn(l10n.t("Environment check: no ROS environment detected; ROS 2 features will be limited. Install ROS 2 or configure the ROS environment setup script."));
        return;
    }
    const distro = env.ROS_DISTRO;
    const version = env.ROS_VERSION;
    if (typeof distro !== "string" || distro.length === 0) {
        log.warn(l10n.t("Environment check: ROS_DISTRO (distribution name) missing; ROS 2 features will be limited. Check the ROS environment setup script."));
        return;
    }
    if (typeof version !== "string" || version.length === 0) {
        log.warn(l10n.t("Environment check: ROS_VERSION (ROS major version) missing; ROS 2 features will be limited. Check the ROS environment setup script."));
        return;
    }
    const known = state.KNOWN_ROS2_DISTROS.has(distro);
    const isRos2 = version === "2";
    const line =
        l10n.t("Environment check: ROS_VERSION={0} ({1}), distribution={2}", version, isRos2 ? "ROS 2" : l10n.t("non-ROS 2"), distro)
        + (known ? l10n.t("(known ROS 2 distribution)") : l10n.t("(not in the known ROS 2 distribution list; please verify manually)"));
    if (known) {
        log.info(line);
    } else {
        log.warn(line);
    }
}

/**
 * 更新工作区作用域的 context key(UI 可见性条件用)。
 * 含 ros2.hasRosEnvironment / ros2.allowEmptyWorkspace。
 * (2026-08-31:ros2.hasPackageXml 已移出——包判定归 package-core 权威域,由组合根
 *  packageCore.onDidChange 反应式更新,环境域不再越界判定包;本函数只负责环境/配置 key)
 */
export async function updateWorkspaceContextKeys(): Promise<void> {
    // ROS 环境是否可用(与 getEnvIssue() 同一口径,单一判定来源)——用于无包但 ROS 环境可用的工作区也能触发构建
    const hasRosEnvironment = state.getEnvIssue() === null;
    await setContext("ros2.hasRosEnvironment", hasRosEnvironment);
    log.debug(l10n.t("Context key: hasRosEnvironment={0}", hasRosEnvironment));

    // 空构建倾向(ROS2.build.allowEmptyWorkspace)——无包时是否允许空构建,参与 Ctrl+Shift+B 快捷键门控
    const allowEmptyWorkspace = getConfig("build.allowEmptyWorkspace", true);
    await setContext("ros2.allowEmptyWorkspace", allowEmptyWorkspace);
    log.debug(l10n.t("Context key: allowEmptyWorkspace={0}", allowEmptyWorkspace));
}
