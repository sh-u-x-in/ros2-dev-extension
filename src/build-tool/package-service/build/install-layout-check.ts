// Licensed under the MIT License.

/**
 * @file install-layout-check.ts(2026-09-22 新增)
 * 构建前【非阻塞】安装布局检查:读 `<ws>/install/.colcon_install_layout`(布局既成事实),
 * 与本次构建将使用的布局比对;不一致 → 产出警告文案并弹出,**不阻止构建继续**(用户可无视风险执行)。
 *
 * ── 为什么必须提示(VM 实测,colcon-core 0.21.0) ──────────────────────
 * colcon 把布局钉在 install 基座上,拒绝在同一 install 目录混用两种布局:
 *   既有 isolated + 本次 --merge-install → 退出码 1:
 *     "The install directory 'install' was created with the layout 'isolated'.
 *      Please remove the install directory, pick a different one or remove the
 *      '--merge-install' option."
 *   既有 merged + 本次不加参数(isolated) → 退出码 1(提示 add the '--merge-install' option)
 * 故布局只能"清理 install/ 后重建"或"改回既有布局",不存在静默切换。
 *
 * ── 边界 ────────────────────────────────────────────────────────
 *  - 只读标记 + 出文案 + 弹警告,不改设置、不删目录、不阻塞构建;
 *  - 布局决策政策仍唯一归 install-type.ts(resolveInstallType);本模块接收"本次请求布局"入参;
 *  - 形态轴(copy/symlink)**不检查**:colcon 不记录形态、也不阻止混用(实测 marker=isolated 下
 *    --symlink-install 退出码 0),属已知残留问题,不在本检查范围内;
 *  - 标记缺失/不可读/内容非法 → 视为"未知",不告警(colcon 首次构建会自己落盘)。
 */

import { l10n } from "vscode";

import * as fs from "fs";
import * as path from "path";

import { getLogger } from "../../../logger";
import { showPreflightWarning } from "./preflight-warnings";
import type { ColconInstallLayout } from "../../../ros2/api";

/** install-layout-check 模块日志 */
const log = getLogger("install-layout-check");

/** 布局标记相对工作区根的位置(colcon 在 install 基座创建时写一次,已存在不重写) */
export const INSTALL_LAYOUT_MARKER = path.join("install", ".colcon_install_layout");

/** 布局 → 本次构建会用的 CLI 参数(仅用于警告文案,解释"不一致"具体差在哪) */
const LAYOUT_FLAG_HINT: Record<ColconInstallLayout, string> = {
    merged: "--merge-install",
    isolated: l10n.t("no install flag (colcon default)"),
};

/**
 * 读安装布局标记(既有工作区的事实):
 * 内容为 "isolated"/"merged"(实测落盘形如 "isolated\n")→ 该值;缺失/不可读/非法 → undefined。
 */
export async function readInstallLayoutMarker(workspaceRoot: string): Promise<ColconInstallLayout | undefined> {
    const marker = path.join(workspaceRoot, INSTALL_LAYOUT_MARKER);
    try {
        const text = (await fs.promises.readFile(marker, "utf8")).trim().toLowerCase();
        if (text === "isolated" || text === "merged") {
            return text;
        }
        log.debug(l10n.t("Unrecognized layout marker content (\"{0}\"); treating as unknown (no warning): {1}", text, marker));
        return undefined;
    } catch {
        log.trace(l10n.t("Layout marker missing/unreadable; treating as unknown (no warning): {0}", marker));
        return undefined;
    }
}

/**
 * 生成布局不一致的警告文案(纯函数):既有布局未知或与本次一致 → null。
 * 文案口径:先给结论(不阻止构建),再给差异与后果,最后给两条可选处理。
 */
export function buildInstallLayoutWarning(
    existing: ColconInstallLayout | undefined,
    requested: ColconInstallLayout,
): string | null {
    if (!existing || existing === requested) {
        return null;
    }
    return l10n.t("Install layout mismatch (build not blocked): install/ currently uses \"{0}\" ({1}),", existing, LAYOUT_FLAG_HINT[existing])
        + l10n.t("this build will use \"{0}\" ({1}).", requested, LAYOUT_FLAG_HINT[requested])
        + l10n.t("colcon refuses to mix layouts in one install directory; the build is expected to fail (exit code 1).")
        + l10n.t("Delete install/ and rebuild with the new layout, or set ROS2.build.installLayout back to \"{0}\".", existing);
}

/** 检查并返回警告文案(既有布局未知/一致 → null);调用方决定怎么展示 */
export async function checkInstallLayout(
    workspaceRoot: string,
    requested: ColconInstallLayout,
): Promise<string | null> {
    const existing = await readInstallLayoutMarker(workspaceRoot);
    if (existing && existing !== requested) {
        log.warn(l10n.t("Install layout mismatch: existing \"{0}\" vs requested \"{1}\" (warning only, build not blocked)", existing, requested));
    }
    return buildInstallLayoutWarning(existing, requested);
}

/**
 * 构建前布局检查 + 弹警告(**非阻塞**)。
 * 关键:只 await 读标记的 I/O,弹窗走 `showPreflightWarning`(受 `ROS2.build.preflightWarnings` 总开关控制)——
 * 调用方可在"第一个选择弹窗出现时"并发触发本函数,警告与弹窗同时出现,
 * 用户无视警告继续走完选择流程仍会正常构建(风险自负)。
 */
export async function warnInstallLayoutMismatch(
    workspaceRoot: string,
    requested: ColconInstallLayout,
): Promise<void> {
    try {
        const warning = await checkInstallLayout(workspaceRoot, requested);
        if (warning) {
            showPreflightWarning("layout", warning);
        }
    } catch (err) {
        // 检查本身绝不阻断构建:异常只留痕
        log.warn(l10n.t("Layout check error (ignored, build not blocked): {0}", err instanceof Error ? err.message : String(err)));
    }
}
