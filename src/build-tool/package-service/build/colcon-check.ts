/** colcon 构建前检查(2026-10-20,用户亲历:ros-jazzy-desktop 不带 colcon,构建在终端裸报
 *  exit 127「colcon: 未找到命令」——desktop 与构建工具是两个包,官方文档让单独装
 *  python3-colcon-common-extensions,每台新机器都会踩)。探测零子进程:对采集环境快照的
 *  PATH 解析 colcon(跨平台无扩展名/.exe,与 status-bar 的 python3 探针同款语义)。
 *  缺失时两条路径分别呈现:
 *  - smart-build 入口:第一句拒绝(不进两级选择弹窗);
 *  - 任务路径(resolveTask,Ctrl+Shift+B / tasks.json):30s 去重非模态警告后放行——
 *    终端里的真实 127 有信息量,保留;undefined 不接管只会换来 VS Code 泛化启动失败,更差。 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getLogger } from "../../../logger";
import { composeApi } from "../../../ros2/api";

const log = getLogger("colcon-check");

/** PATH 中定位 colcon;显式传 envPath 供测试注入,缺省取采集环境快照的 PATH */
export function findColconOnPath(envPath?: string): string | null {
    const env = envPath !== undefined ? envPath : composeApi.environment.getEnv()?.PATH;
    if (!env) {
        return null;
    }
    // 分隔符自适应:含 ";" = win32 形态按分号切(条目内盘符冒号不可切),否则 unix 按冒号切
    const dirs = (env.includes(";") ? env.split(";") : env.split(":"))
        .map((s) => s.trim()).filter((s) => s.length > 0);
    for (const dir of dirs) {
        for (const name of ["colcon", "colcon.exe"]) {
            try {
                const full = path.join(dir, name);
                if (fs.existsSync(full)) {
                    return full;
                }
            } catch {
                // 坏路径条目跳过
            }
        }
    }
    return null;
}

/** 缺失指引文案(en 源串=键,双语在册;两条路径共用同一条) */
export function colconMissingHint(): string {
    return vscode.l10n.t("colcon was not found on the ROS environment's PATH; install it with: sudo apt install python3-colcon-common-extensions, then retry.");
}

// 任务路径的去重窗(resolveTask 在列举/校验/执行阶段可能被多次调用;30s 内至多弹一次)
let lastWarnAt = 0;

/** 测试隔离缝 */
export function _resetColconCheckForTest(): void {
    lastWarnAt = 0;
}

export function warnColconMissingOnce(): void {
    const now = Date.now();
    if (now - lastWarnAt < 30_000) {
        return;
    }
    lastWarnAt = now;
    log.info("colcon not found on the environment PATH; task-path warning shown (deduped 30s)");
    void vscode.window.showWarningMessage(colconMissingHint());
}
