// Licensed under the MIT License.

/**
 * @file preflight-warnings.ts
 * 构建前「前瞻警告」的**唯一出口** + **模式开关** + **"不再提示"按钮**。
 *
 * ── 什么是前瞻警告 ────────────────────────────────────────────────
 * 构建开始**之前**预判"安装布局 / 安装形态与磁盘现状不一致"并提示(共三类,见 `PreflightKind`)。
 * 它们与构建自身的报错/现象内容重复,故可整体关闭;关闭只影响**提示**,检查照跑、自动修正照做。
 *
 * ── 通知类型研究(2026-09-22;以本仓 `@types/vscode@1.101.0`、`engines.vscode ^1.101.0` 与官方 UX 指南为准)──
 * | 类型 | API | 生命周期 | 按钮 | 阻塞 | 本项目 |
 * |:--|:--|:--|:--|:--|:--|
 * | **非模态 toast**(用户口径:自动消息) | `showWarningMessage(msg, ...items)` | 收起时机由 VS Code 决定;**API 无 sticky/timeout 参数**(`MessageOptions` 仅有 `modal`/`detail`) | ✅ 支持(选中项由 Thenable 返回) | 不阻塞 | ✅ **采用** |
 * | **模态对话框**(死消息) | `showWarningMessage(msg, { modal: true }, ...items)` | **必须应答**才消失 | ✅ 支持(`detail` 仅模态显示) | **阻塞界面** | ❌ 会把同时打开的 QuickPick 挡死 |
 * | **进度通知**(事件消息) | `withProgress({ location: ProgressLocation.Notification })` | promise 结束即消失 | ❌ 只有 cancel(类型注释:"with an optional cancel button") | 不阻塞 | ❌ 需按钮,不适用 |
 * ⇒ 三条前瞻警告都必须与 QuickPick **并存**(W1 与第一个选择项同现、W2/W3 与第二个同现),故只能用**非模态 toast**;
 *   按钮能力恰好满足 W3 的「不再提示」。
 * 官方 UX 指南(Notifications):❌ "Send repeated notifications"、✔️ "Add a **Do not show again** option for every notification"
 *   ⇒ 重复提示是反模式;故 W3 带"不再提示",并提供类别级开关。
 *
 * ── 模式(设置 `ROS2.build.preflightWarnings`,三选一)──────────────
 *  · `on`(默认):三类都提示;
 *  · `off`:三类都不提示(检查仍执行、需要时仍自动追加 `--cmake-clean-cache`);
 *  · `ignore-silent-noop`:只忽略"形态静默无效"(构建会成功、最容易被忽视的那类)。
 *  三选一枚举,无布尔兼容(开发期不留历史包袱):非法值/缺省一律 `on`。
 */

import * as vscode from "vscode";

import { getLogger } from "../../../logger";

/** preflight-warnings 模块日志 */
const log = getLogger("preflight-warnings");

/** 设置键(前缀 ROS2. 由 getConfiguration 提供) */
export const PREFLIGHT_WARNINGS_SETTING = "build.preflightWarnings";

/** 前瞻警告模式(三选一) */
export type PreflightMode = "on" | "off" | "ignore-silent-noop";

/** 前瞻警告类别:布局不一致 / 形态硬冲突(会失败) / 形态静默无效(构建成功但不变) */
export type PreflightKind = "layout" | "conflict" | "silent-noop";

/** 「不再提示」按钮文案 */
// 2026-10-04 i18n 期2:按钮+返回值比较双角色,常量同源 t()
export const PREFLIGHT_MUTE_LABEL = vscode.l10n.t("Don't warn about this again");

/** 从设置原始值解析模式(纯函数,可单测):只有显式关闭/忽略才降级,其余一律 `on` */
export function preflightModeFrom(raw: unknown): PreflightMode {
    if (raw === "off") {
        return "off";
    }
    if (raw === "ignore-silent-noop") {
        return "ignore-silent-noop";
    }
    return "on";
}

/** 该类别在该模式下是否要提示(纯函数,可单测) */
export function shouldShowPreflight(kind: PreflightKind, mode: PreflightMode): boolean {
    if (mode === "off") {
        return false;
    }
    if (mode === "ignore-silent-noop" && kind === "silent-noop") {
        return false;
    }
    return true;
}

/** 当前模式(缺省 → `on`) */
export function getPreflightMode(): PreflightMode {
    return preflightModeFrom(vscode.workspace.getConfiguration("ROS2").get(PREFLIGHT_WARNINGS_SETTING, "on"));
}

/** 写回模式(「不再提示」按钮用):有工作区则写工作区设置,否则写用户设置 */
export async function setPreflightMode(mode: PreflightMode): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration("ROS2").update(PREFLIGHT_WARNINGS_SETTING, mode, target);
    log.info(vscode.l10n.t("Preflight warning mode written as {0} ({1} setting)", mode, target === vscode.ConfigurationTarget.Workspace ? vscode.l10n.t("workspace") : vscode.l10n.t("user")));
}

/**
 * 弹前瞻警告(**非模态 toast**;唯一出口)。
 * @param kind 类别(决定是否被 `ignore-silent-noop` 模式过滤)
 * @param message 文案
 * @param options.muteTo 提供则在通知上挂「不再提示此类警告」按钮,点击后把模式写成该值
 */
export function showPreflightWarning(
    kind: PreflightKind,
    message: string,
    options?: { muteTo?: PreflightMode },
): void {
    const mode = getPreflightMode();
    if (!shouldShowPreflight(kind, mode)) {
        log.trace(vscode.l10n.t("Preflight warning ({0}) skipped by setting (mode={1})", kind, mode));
        return;
    }
    log.debug(vscode.l10n.t("Preflight warning ({0}): {1}", kind, message.split("\n")[0]));
    const items: string[] = options?.muteTo ? [PREFLIGHT_MUTE_LABEL] : [];
    // 不 await(不阻塞调用方);仅在用户点了「不再提示」时异步写设置。
    void vscode.window.showWarningMessage(message, ...items).then((selected) => {
        if (selected === PREFLIGHT_MUTE_LABEL && options?.muteTo) {
            void setPreflightMode(options.muteTo).catch((err) => {
                log.warn(vscode.l10n.t("Failed to write preflight warning mode: {0}", err instanceof Error ? err.message : String(err)));
            });
        }
    });
}

/**
 * 形态检查结论 → 弹窗(调用方一行;类别/静音策略在此集中,避免三处重复)。
 * `plan` 用结构类型,故本模块不依赖 install-method-check(后者保持零 vscode)。
 */
export function showInstallMethodWarning(
    plan: { warning: string | null; warningKind: PreflightKind | null },
): void {
    if (!plan.warning) {
        return;
    }
    const kind: PreflightKind = plan.warningKind ?? "conflict";
    showPreflightWarning(kind, plan.warning, kind === "silent-noop" ? { muteTo: "ignore-silent-noop" } : undefined);
}
