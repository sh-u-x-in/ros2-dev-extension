// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file intellisense-report.ts
 * 配置生成【报表话术层】(2026-10-20 动态反馈,用户裁定"改了哪些部分+没改的原因,不用固定文本涵盖所有"):
 * SyncFileReport[] → 多行通知文案。纯查表 + l10n,零 IO 零写盘;命令层(extension.ts)调用,
 * 无头测试直测本模块。事实键封闭清单见 intellisense-api.ts SyncFileReport 注释。
 */

import { l10n } from "vscode";

import type { SyncFileReport } from "./intellisense-api";

/** 文件侧显示名(cpp/clangd 是字面文件名零翻译;python 带 (python) 后缀) */
const FILE_LABEL: Record<SyncFileReport["file"], string> = {
    cpp: "c_cpp_properties.json",
    clangd: ".clangd",
    python: "settings.json (python)",
};

/** 未写盘原因话术(查表;键见 SyncFileReport.idle) */
const IDLE_PHRASE: Record<NonNullable<SyncFileReport["idle"]>, string> = {
    "no-change": "already canonical; not written",
    "disabled": "engine side disabled (ROS2.ide.intellisenseEngine)",
    "conservative": "no CompileFlags/Add block; conservatively not created",
    "empty": "no Python paths to maintain",
};

/** 事实 → 话术(cpp/clangd/python 通用查表;组合键在 factsPhrase 内特殊拼装) */
function factsPhrase(r: SyncFileReport): string {
    const f = r.facts;
    const parts: string[] = [];
    const n = (k: string): number => f[k] ?? 0;
    if (r.file === "cpp") {
        if (f.generated !== undefined) {
            parts.push(l10n.t("created from scratch ({0} includePath entries)", f.generated));
        }
        if (f.surgical !== undefined) {
            parts.push(l10n.t("missing includePath key filled ({0} entries; other fields untouched)", f.surgical));
        }
        if (f.claimed !== undefined) {
            parts.push(l10n.t("ros2 configuration claimed (appended)"));
        }
        if (f.dedup !== undefined) {
            parts.push(l10n.t("removed {0} duplicate ros2 configurations", f.dedup));
        }
        if (f.reorder !== undefined) {
            parts.push(l10n.t("includePath normalized ({0} managed + {1} user entries kept)", n("managed"), n("leftover")));
        }
        if (f.usrClean !== undefined) {
            parts.push(l10n.t("cleared {0} legacy /usr/include entries", f.usrClean));
        }
        if (f.staleClean !== undefined) {
            parts.push(l10n.t("cleared {0} stale build-artifact entries", f.staleClean));
        }
        if (f.ovClean !== undefined) {
            parts.push(l10n.t("cleared {0} entry-override legacy entries", f.ovClean));
        }
    } else if (r.file === "clangd") {
        if (f.generated !== undefined) {
            parts.push(l10n.t("file created ({0} flags / {1} workspace / {2} install / {3} distro)", n("genFlags"), n("genWs"), n("genInstall"), n("genSys")));
        }
        if (f.dbMigrated !== undefined) {
            parts.push(l10n.t("CompilationDatabase folded into CompileFlags"));
        }
        if (f.removed !== undefined) {
            parts.push(l10n.t("normalized away {0} lines (legacy form/duplicate)", f.removed));
        }
        if (f.ovReplaced !== undefined) {
            parts.push(l10n.t("entry overrides applied in place ({0} lines)", f.ovReplaced));
        }
        if (f.orphan !== undefined) {
            parts.push(l10n.t("cleaned {0} orphan group markers", f.orphan));
        }
        if (f.tidy !== undefined) {
            parts.push(l10n.t("Add block rebuilt in canonical order (user lines kept at tail)"));
        }
        if (f.addFlat !== undefined) {
            parts.push(l10n.t("filled {0} missing entries at list head (markerless legacy file)", f.addFlat));
        } else if (f.addFlags !== undefined || f.addWs !== undefined || f.addInstall !== undefined || f.addSys !== undefined) {
            parts.push(l10n.t("filled missing entries ({0} flags / {1} workspace / {2} install / {3} distro)", n("addFlags"), n("addWs"), n("addInstall"), n("addSys")));
        }
        if (f.flowAdded !== undefined) {
            parts.push(l10n.t("flow style: filled {0} missing entries", f.flowAdded));
        }
    } else {
        if (f.rewritten !== undefined) {
            if (f.added !== undefined) {
                parts.push(l10n.t("updated {0} keys (added {1} entries)", f.rewritten, f.added));
            } else {
                parts.push(l10n.t("normalized order on {0} keys", f.rewritten));
            }
        }
        if (f.ovClean !== undefined) {
            parts.push(l10n.t("cleared {0} entry-override legacy entries", f.ovClean));
        }
    }
    return parts.join(", ");
}

/**
 * 报表 → 多行通知文案:
 *  · 有任一文件写盘 → headline「已更新」+ 每文件一行(写盘的事实短语 / 未写的 idle 原因);
 *  · 全部未写盘 → headline「已检查,均已规范」+ 每文件一行 idle 原因。
 * 行内以 "\n" 连接(VS Code 通知支持多行)。
 */
export function renderSyncReportMessage(report: SyncFileReport[]): string {
    const lines = report.map((r) => {
        const label = FILE_LABEL[r.file];
        if (r.written) {
            return `${label}: ${factsPhrase(r)}`;
        }
        const idle = r.idle ?? "no-change";
        return `${label}: ${l10n.t(IDLE_PHRASE[idle])}`;
    });
    const anyWritten = report.some((r) => r.written);
    const headline = anyWritten
        ? l10n.t("ROS 2 IntelliSense configuration updated:")
        : l10n.t("ROS 2 IntelliSense configuration checked; everything already canonical:");
    return [headline, ...lines].join("\n");
}
