// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-rename.ts
 * config 写侧·02 工作包重命名【编排层】(vscode,2026-09-03)。
 * 订阅 executable-map.onNameMismatch(三方名不一致事件:目录名/package.xml/配置内名)→
 * 弹 modal 选项(以文件夹名称为准 → 改写声明 / 忽略本次)→ 确认后读构建文件 →
 * planRenameByFolder(纯)→ 整文写回 → 提示;写回后由现有监听/缓存自动刷新。
 * 防骚扰:启动冷却 + 会话内按 (dir|directoryName) 去重(应用/忽略后不再弹,声明名再变才重弹)。
 */

import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import { getLogger } from "../../../../logger";
import type { NameMismatchEvent } from "../exe-map/types";
import { planRenameByFolder, RenamePlan, RenameTargets } from "./rename-actions";

const log = getLogger("package-rename");

/** 触发源窄接口(结构化兼容 ExecutableMap.onNameMismatch) */
export interface NameMismatchSource {
    onNameMismatch(cb: (ev: NameMismatchEvent) => void): () => void;
}

/** 启动冷却(毫秒):激活初期首载解析触发的既有不一致不弹窗(待讨论①:仅"变化后"触发) */
const STARTUP_COOLDOWN_MS = 15000;

/** 会话去重:key = dir|directoryName,应用/忽略后不再弹(声明名变化 → key 变 → 重弹) */
const settled = new Set<string>();
let activatedAt = Date.now();

async function readOptional(fileAbs: string): Promise<string> {
    try {
        return await fs.readFile(fileAbs, "utf8");
    } catch {
        return "";
    }
}

/** 处理一次不一致事件(可由测试注入 prompt/fs?v1 直接 vscode 交互) */
async function handleMismatch(ev: NameMismatchEvent): Promise<void> {
    const { dir, packageName, directoryName, buildType } = ev;
    if (Date.now() - activatedAt < STARTUP_COOLDOWN_MS) {
        log.trace(vscode.l10n.t("package-rename: startup cooldown; skipping mismatch dialog:") + " " + dir);
        return;
    }
    const key = dir + "|" + directoryName;
    if (settled.has(key)) { return; }

    const targets: RenameTargets = {
        packageXml: await readOptional(path.join(dir, "package.xml")),
        cmakeText: await readOptional(path.join(dir, "CMakeLists.txt")),
        setupPyText: await readOptional(path.join(dir, "setup.py")),
    };
    const plan: RenamePlan = planRenameByFolder(directoryName, targets);
    if (!plan.changed) {
        // 没有可改写的声明(或已一致)→ 静默(待讨论:也记录,避免反复)
        settled.add(key);
        return;
    }
    const summary = plan.files.map((f) => "  · " + f.file + " → " + f.summary.split(" → ").pop()).join("\n");
    const msg =
        "文件夹名「" + directoryName + "」与包内声明(package.xml=" + packageName + (ev.declaredName && ev.declaredName !== packageName ? ", 配置内=" + ev.declaredName : "") + ", buildType=" + buildType + ")不一致。\n将按文件夹名改写:\n" + summary;
    // 弹窗按钮常量(2026-10-04 i18n 期0):显示与返回值判定同源(见 install-truth-sidebar 同款注释)
    const BTN_RENAME_BY_FOLDER = "以文件夹名称为准,改写声明";
    const BTN_SKIP_RENAME = "忽略本次";
    const pick = await vscode.window.showInformationMessage(
        msg,
        { modal: true },
        BTN_RENAME_BY_FOLDER,
        BTN_SKIP_RENAME,
    );
    if (pick !== BTN_RENAME_BY_FOLDER) {
        settled.add(key);
        return;
    }
    for (const f of plan.files) {
        if (!f.content) { continue; }
        try {
            await fs.writeFile(path.join(dir, f.file), f.content, "utf8");
        } catch (err) {
            void vscode.window.showErrorMessage(vscode.l10n.t("Rewrite failed ") + f.file + ":" + String(err));
            return;
        }
    }
    settled.add(key);
    // 写回由现有监听(package-core watcher → 缓存刷新 → executable-map 重建)自动闭环;不手动刷新
    void vscode.window.showInformationMessage(vscode.l10n.t("Rewrote {0} file(s) after the folder name ({1}). Check in-code references manually.", plan.files.length, directoryName));
}

/** 注册订阅(extension 在 executableMap 实例化后调用) */
export function registerNameMismatchHandler(context: vscode.ExtensionContext, source: NameMismatchSource | null): void {
    if (!source) { return; }
    const unsub = source.onNameMismatch((ev) => {
        void handleMismatch(ev).catch((err) => log.warn(vscode.l10n.t("package-rename: mismatch handling failed:") + " " + String(err)));
    });
    context.subscriptions.push({ dispose: () => unsub() });
}

/** 供测试/手动:清除会话去重与冷却(不导出对外?导出供测试) */
export function _resetRenameState(): void {
    settled.clear();
    activatedAt = Date.now() - STARTUP_COOLDOWN_MS - 1;
}
