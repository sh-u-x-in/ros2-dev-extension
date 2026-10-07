// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file configure-file.ts
 * config 写侧·01 一键配置【编排层】(vscode 侧,2026-09-03)。
 * 流程:右键文件 → 包定位(门面 workspace 域,最长祖先匹配)→ 角色识别 →
 *       planConfigure(纯) → 写前确认(总纲约束⑤:绝不留写后门)→ 按计划写回 →
 *       依赖现有 watcher(executable-map/event-collector、package-core)自动刷新,不手动触发。
 * 纯动作逻辑在 ./configure-actions.ts(可无头测);本文件只做交互与落盘。
 * ⚠️ 写回位置(2026-09-03):replace=整文覆盖;append=文件尾追加——后者对 package.xml 不合法,
 *    待按规格 §4 接 anchors/(insertBeforePackageClose/insertSnippetCmake 等)改为锚点插入。
 */

import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import { getLogger } from "../../../../logger";
import type { PackageCore } from "../../../package-core/api";
import {
    BuildTexts,
    ConfigurePlan,
    detectRole,
    planConfigure,
    BuildTypeName,
    ConsoleScriptTarget,
} from "./configure-actions";

const log = getLogger("configure-file");

/** 命令 ID(与 package.json contributes.commands 一致) */
export const ConfigureFileCommand = "ROS2.configureFile";

const BUILD_FILES = ["CMakeLists.txt", "package.xml", "setup.py"] as const;

async function readOptional(fileAbs: string): Promise<string> {
    try {
        return await fs.readFile(fileAbs, "utf8");
    } catch {
        return "";
    }
}

/** 包定位:门面 workspace 域(unignored+ignored)中 dir 为文件祖先的最深包 */
function locatePackage(core: PackageCore, filePath: string): { name: string; dir: string; buildType?: BuildTypeName } | undefined {
    const state = core.getState();
    const entries = [...(state.unignored ?? []), ...(state.ignored ?? [])];
    const norm = path.normalize(filePath);
    let best: { name: string; dir: string; buildType?: string } | undefined;
    for (const e of entries) {
        if (!e.name || !e.dir) { continue; }
        const dir = path.normalize(e.dir);
        if (norm === dir || norm.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) {
            if (!best || dir.length > best.dir.length) {
                best = { name: e.name, dir, buildType: e.buildType };
            }
        }
    }
    if (!best) { return undefined; }
    const bt = best.buildType;
    const valid: BuildTypeName[] = ["ament_python", "ament_cmake", "cmake"];
    return { name: best.name, dir: best.dir, buildType: valid.includes(bt as BuildTypeName) ? (bt as BuildTypeName) : undefined };
}

/** 建议 console_scripts 目标(ament_python 的 python 文件,编排层询问) */
async function askConsoleScript(pkgName: string, fileRel: string, role: string): Promise<ConsoleScriptTarget | undefined> {
    const base = (fileRel.split("/").pop() ?? "main").replace(/\.py$/, "");
    const moduleGuess = fileRel.replace(/\.py$/, "").split("/").join(".");
    const value = await vscode.window.showInputBox({
        prompt: "console_scripts 入口(name = module:func)",
        value: base + " = " + moduleGuess + ":main",
        validateInput: (s) => (/^\s*\S+\s*=\s*\S+:\S+\s*$/.test(s) ? undefined : "格式:name = module:func"),
    });
    if (!value) { return undefined; }
    const m = /^\s*(\S+)\s*=\s*(\S+):(\S+)\s*$/.exec(value);
    return m ? { name: m[1], module: m[2], func: m[3] } : undefined;
}

/** 汇总计划为确认消息 */
function describePlan(plan: ConfigurePlan): string {
    const lines = plan.writes.map((w) => {
        const mode = w.mode === "replace" ? "整文改写" : "追加";
        const snippet = w.mode === "append" && w.content ? w.content.split("\n").filter(Boolean).slice(0, 2).join(" ") : "";
        return "  · " + w.file + " [" + mode + "] " + w.summary + (snippet ? " —— " + snippet : "");
    });
    return lines.join("\n");
}

/** 一键配置主入口(命令体):返回是否已写(测试/扩展共用语义由 actions 承担) */
export async function configureFile(core: PackageCore, uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    const stat = await vscode.workspace.fs.stat(uri).then(
        (s) => s,
        () => undefined,
    );
    if (stat && (stat as { type?: number }).type === vscode.FileType.Directory) {
        void vscode.window.showInformationMessage(vscode.l10n.t("One-click configure: select a file (launch/interface/scripts/C++), not a directory"));
        return;
    }

    const pkg = locatePackage(core, filePath);
    if (!pkg) {
        void vscode.window.showWarningMessage(vscode.l10n.t("No owning ROS package found (the file must live inside a built package directory of the workspace)"));
        return;
    }
    const fileRel = path.relative(pkg.dir, filePath).split(path.sep).join(path.posix.sep);
    const role = detectRole(fileRel);
    const texts: BuildTexts = {
        cmakeText: await readOptional(path.join(pkg.dir, "CMakeLists.txt")),
        setupPyText: await readOptional(path.join(pkg.dir, "setup.py")),
        packageXmlText: await readOptional(path.join(pkg.dir, "package.xml")),
    };

    let consoleScript: ConsoleScriptTarget | undefined;
    if (role === "python" && pkg.buildType === "ament_python") {
        consoleScript = await askConsoleScript(pkg.name, fileRel, role);
        if (!consoleScript) { return; } // 用户取消
    }

    const plan = planConfigure(pkg, fileRel, texts, consoleScript);
    if (plan.note) {
        log.warn("configure-file:plan note: " + plan.note);
    }
    if (plan.already || plan.writes.length === 0) {
        const msg = plan.note ? "无需写入:" + plan.note : "该文件已配置(幂等),无需改写";
        void vscode.window.showInformationMessage(msg);
        return;
    }
    if (plan.writes.some((w) => !w.already && !w.content)) {
        // content 为空且未 already → 该动作无法生成(如无 CMakeLists.txt)
        const missing = plan.writes.filter((w) => !w.already && !w.content).map((w) => w.summary).join(";");
        void vscode.window.showWarningMessage(vscode.l10n.t("Cannot auto-configure:") + " " + missing);
        return;
    }

    // 写前确认(总纲约束⑤);按钮常量(2026-10-04 i18n 期0):显示与返回值判定同源(见 install-truth-sidebar 同款注释)
    const BTN_CONFIRM_WRITE = "确认写入";
    const header = "将改写 " + pkg.name + " 的构建文件:\n" + describePlan(plan);
    const pick = await vscode.window.showInformationMessage(header, { modal: true }, BTN_CONFIRM_WRITE, vscode.l10n.t("Cancel"));
    if (pick !== BTN_CONFIRM_WRITE) { return; }

    for (const w of plan.writes) {
        if (w.already) { continue; }
        const fileAbs = path.join(pkg.dir, w.file);
        try {
            if (w.mode === "replace") {
                await fs.writeFile(fileAbs, w.content, "utf8");
            } else {
                const cur = await readOptional(fileAbs);
                const sep = cur && !cur.endsWith("\n") ? "\n" : "";
                await fs.appendFile(fileAbs, sep + w.content, "utf8");
            }
        } catch (err) {
            void vscode.window.showErrorMessage(vscode.l10n.t("Write failed ") + w.file + ":" + String(err));
            return;
        }
    }
    // shell 可执行位(非 Windows 尽力而为)
    if (role === "shell" && process.platform !== "win32") {
        try { await fs.chmod(filePath, 0o755); } catch { /* 尽力 */ }
    }
    // 依赖现有监听自动刷新(executable-map/package-core),不手动触发
    void vscode.window.showInformationMessage(
        "已写入构建文件(" + plan.writes.filter((w) => !w.already).length + " 处)。保存后构建即可接入;" +
        (plan.note ? "\n注意:" + plan.note : ""),
    );
}

/** 命令注册(右键/命令面板共用) */
export function registerConfigureFileCommand(context: vscode.ExtensionContext, core: PackageCore | null): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(ConfigureFileCommand, async (uri?: vscode.Uri) => {
            try {
                if (!core) {
                    void vscode.window.showErrorMessage(vscode.l10n.t("package-core is not ready; reload the window and retry"));
                    return;
                }
                const target = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target) {
                    void vscode.window.showWarningMessage(vscode.l10n.t("Use \"One-click configure\" on a file in the Explorer"));
                    return;
                }
                await configureFile(core, target);
            } catch (err) {
                log.error(vscode.l10n.t("configure-file: execution failed:") + " " + String(err));
                void vscode.window.showErrorMessage(vscode.l10n.t("One-click configure failed:") + " " + String(err));
            }
        }),
    );
}
