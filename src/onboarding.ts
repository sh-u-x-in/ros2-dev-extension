// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file onboarding.ts
 * 欢迎演练(walkthrough)流程:首次安装 / 大版本升级 / ROS 未检测到时展示。
 */

import * as vscode from "vscode";

import { getLogger } from "./logger";
import * as vscode_utils from "./vscode-utils";
import { probeValidWorkspacePackages } from "./build-tool/package-core/api";

/** 欢迎演练模块日志 */
const log = getLogger("onboarding");

/**
 * The walkthrough ID for the getting started guide (格式 = <publisher>.<name>#<walkthrough id>,必须与 package.json 一致)。
 * 2026-10-07:walkthrough 正文 md 不走 l10n,按 UI 语言二选一(package.json 双 walkthrough 以 ros2.uiLocale 门控,
 * 本函数与之同口径)。
 */
export function gettingStartedWalkthroughId(): string {
    return vscode.env.language === "zh-cn"
        ? "sh-u-x-in.ros2-dev-extension#ros2.gettingStarted.zh"
        : "sh-u-x-in.ros2-dev-extension#ros2.gettingStarted";
}

/**
 * 把当前 UI 语言写入上下文键 ros2.uiLocale(欢迎页双 walkthrough 的 when 门控依据;
 * zh-cn 显示中文版,其余显示英文版。须在激活早期调用,键未设置时两套 walkthrough 均不显示)。
 */
export function setUiLocaleContext(): void {
    void vscode.commands.executeCommand("setContext", "ros2.uiLocale", vscode.env.language);
    log.debug(`UI locale context set: ros2.uiLocale=${vscode.env.language}`);
}
// (2026-10-04 i18n 期2)弹窗文案改为调用点 l10n.t 取串:英文源=无对应语言册时的兜底显示,
// 中文译文收在 l10n/bundle.l10n.zh-cn.json;「不再显示」是双角色串(按钮文案+返回值比较键),比较必须用同一常量
const LAST_SHOWN_WELCOME_VERSION_KEY = "onboarding.lastShownWelcomeVersion";
/** globalState 键语义:上次展示欢迎演练的扩展版本(扩展私有存储,不再进用户设置面板) */

/**
 * 读「上次展示欢迎的版本」。globalState 为空时回退读一次旧设置键 ROS2.lastShownWelcomeVersion
 * (读到即迁入 globalState),避免旧安装升级扩展后重复弹欢迎。
 */
function readLastShownWelcomeVersion(context: vscode.ExtensionContext): string {
    const stored = context.globalState.get<string>(LAST_SHOWN_WELCOME_VERSION_KEY, "");
    if (stored) {
        return stored;
    }
    const legacy = vscode_utils.getExtensionConfiguration().get<string>("lastShownWelcomeVersion", "");
    if (legacy) {
        void context.globalState.update(LAST_SHOWN_WELCOME_VERSION_KEY, legacy);
    }
    return legacy;
}

/**
 * 需要时展示欢迎演练(首次安装、版本升级,或 ROS 未检测到)。
 */
export async function showWelcomeIfNeeded(context: vscode.ExtensionContext): Promise<void> {
    setUiLocaleContext();
    const config = vscode_utils.getExtensionConfiguration();
    const showWelcomeOnStartup = config.get("ui.showWelcomeOnStartup", true);
    log.debug(vscode.l10n.t("Welcome walkthrough toggle check: showWelcomeOnStartup={0}", showWelcomeOnStartup));
    
    // Check if user has disabled the welcome screen
    if (!showWelcomeOnStartup) {
        return;
    }

    // Double-check this is a ROS workspace before showing walkthrough.
    // (2026-08-31:改走 package-core 探测谓词 probeValidWorkspacePackages——包判定归 package-core;
    //  仅单次决策,不考虑后续更新,刻意减少复杂度;若需反应式走 getState + onDidChange)
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const hasPackageXml = root ? await probeValidWorkspacePackages(root) : false;
    if (!hasPackageXml) {
        log.debug("Skipping welcome walkthrough: workspace does not contain package.xml.");
        return;
    }

    // Get current extension version and compare with last shown version
    const currentVersion = context.extension.packageJSON.version as string;
    const lastShownVersion = readLastShownWelcomeVersion(context);
    // Show the walkthrough with a slight delay to ensure VS Code is ready
    setTimeout(async () => {
        if (shouldShowWelcome(lastShownVersion, currentVersion)) {
            log.info(vscode.l10n.t("Showing welcome walkthrough: last version {0} -> current {1}",
                lastShownVersion || vscode.l10n.t("(none)"), currentVersion));
            const UPDATED_WELCOME_PROMPT = vscode.l10n.t("RDE for ROS 2 has been updated. Show the welcome page?");
            const UPDATED_WELCOME_PROMPT_YES = vscode.l10n.t("Yes");
            const UPDATED_WELCOME_PROMPT_NO = vscode.l10n.t("No");
            const UPDATED_WELCOME_PROMPT_NEVER = vscode.l10n.t("Don't Show Again");
            const selection = await vscode.window.showInformationMessage(
                    UPDATED_WELCOME_PROMPT,
                    UPDATED_WELCOME_PROMPT_YES,
                    UPDATED_WELCOME_PROMPT_NO,
                    UPDATED_WELCOME_PROMPT_NEVER
                );

            void context.globalState.update(LAST_SHOWN_WELCOME_VERSION_KEY, currentVersion);
            if (selection === UPDATED_WELCOME_PROMPT_NEVER) {
                await config.update("ui.showWelcomeOnStartup",
                    false, vscode.ConfigurationTarget.Global);
                return;
            } else if (selection === UPDATED_WELCOME_PROMPT_NO || selection === undefined) {
                return;
            } else {
                vscode.commands.executeCommand('workbench.action.openWalkthrough', gettingStartedWalkthroughId());
            }
        }
    }, 5000);
}

/**
 * 比较两个语义版本,决定是否展示欢迎。
 * 欢迎在首次安装以及大/小版本升级时展示,补丁版本升级有意忽略。
 *
 * @param lastVersion 上次展示的版本(从未展示则为空字符串)
 * @param currentVersion 当前扩展版本
 * @returns 是否应展示欢迎(首次安装或大/小版本升级)
 */
export function shouldShowWelcome(lastVersion: string, currentVersion: string): boolean {
    // Show on first install (lastVersion is empty)
    if (!lastVersion) {
        log.debug("Should-show-welcome decision: first install, showing welcome");
        return true;
    }

    // Product decision: compare major/minor only, ignore patch updates for welcome prompts.
    const show = vscode_utils.compareVersions(lastVersion, currentVersion, true) < 0;
    log.debug(vscode.l10n.t("Should-show-welcome decision: {0} vs {1} -> {2}", lastVersion, currentVersion, String(show)));
    return show;
}

/**
 * 在超时时间内解析用户欢迎弹窗选择,超时默认返回 undefined。
 */
export async function resolveWelcomePromptSelectionWithTimeout(
    selectionPromise: Thenable<string | undefined>,
    timeoutMs: number,
): Promise<string | undefined> {
    if (timeoutMs <= 0) {
        return undefined;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
        timeoutHandle = setTimeout(() => {
            log.debug(vscode.l10n.t("Welcome dialog not answered within {0} ms; treating as timeout", timeoutMs));
            resolve(undefined);
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            Promise.resolve(selectionPromise),
            timeoutPromise,
        ]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
