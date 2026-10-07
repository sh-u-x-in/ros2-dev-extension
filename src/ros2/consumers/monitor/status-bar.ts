// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// 2026-08-26:统一经 api/ 取实例(composeApi.environment.getEnv),不再直连环境域实现
import { composeApi } from "../../api";
import { onHelperRunningChanged } from "./helper/helper-state";
import { ShowDaemonStatusCommand } from "../../host/commands";
import { getLogger } from "../../../logger";

/** 状态栏模块日志(启动链路静态诊断在此落日志) */
const log = getLogger("status-bar");

/**
 * PATH 中定位 ros2 可执行文件(启动链路静态诊断;跨平台覆盖无扩展名/.exe/.cmd/.bat)。
 * 扩展执行 ros2 命令用的是 source 后的 env(非 process.env),PATH 取自该 env。
 */
function resolveRos2InPath(envPath: string | undefined): string | null {
    if (!envPath) {
        return null;
    }
    const dirs = envPath.split(/[;:]/).map((s) => s.trim()).filter((s) => s.length > 0);
    for (const dir of dirs) {
        for (const name of ["ros2", "ros2.exe", "ros2.cmd", "ros2.bat"]) {
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

/**
 * 状态栏:daemon 状态的显示与状态页入口(只显示,不探测)。
 * 2026-09-24:探测职责移交状态页(ros2-monitor 的 1s 探测循环,页面展开期间才运行),
 * 本组件订阅 onDaemonRunningChanged 翻转显示——在线 ✓,离线/未知只显示发行版文字。
 * 不再显示 ✗:用户会误读为"出错/可关闭"(2026-09-24 用户反馈);页面未展开时零后台探测。
 */
export class StatusBarItem {
    private item: vscode.StatusBarItem;
    /** 退订 daemon 状态广播(dispose 时用) */
    private unsubscribe: (() => void) | undefined;
    /** 启动链路静态诊断是否已输出(每会话一次) */
    private envDiagDone: boolean = false;

    public constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
        // 2026-08-26:剥离 extension.ts 依赖——命令 ID 单一事实源在 host/commands.ts
        this.item.command = ShowDaemonStatusCommand;
        this.item.tooltip = vscode.l10n.t("ROS 2 Environment status; click to open the status page (nodes / topics / services / parameters / lifecycle)");
        this.item.text = this.renderText(false);
    }

    public activate() {
        this.item.show();
        log.debug("Status bar activated (display only, no probing; click opens the status page; helper status is written by the status page probe loop)");
        this.unsubscribe = onHelperRunningChanged((running) => {
            this.item.text = this.renderText(running);
        });
        this.logEnvDiagOnce();
    }

    public dispose() {
        this.unsubscribe?.();
        this.item.dispose();
    }

    /** 在线 → ✓ + 发行版;离线/未知 → 只显示发行版(2026-09-24 去掉 ✗,避免误读为错误) */
    private renderText(running: boolean): string {
        const ros = this.rosLabel();
        return running ? `$(check) ${ros}` : ros;
    }

    /** 发行版标签(ROS_VERSION.ROS_DISTRO 来自 ros_environment 包设置的 env;未就绪退回 "ROS") */
    private rosLabel(): string {
        try {
            const env = composeApi.environment.getEnv();
            if (env && "ROS_VERSION" in env && "ROS_DISTRO" in env) {
                return `ROS${env["ROS_VERSION"]}.${env["ROS_DISTRO"]}`;
            }
        } catch {
            // env 尚未就绪,退回默认标签
        }
        return "ROS";
    }

    /**
     * 启动链路静态诊断(每会话一次,激活时;纯 env 读取,与 daemon 探测无关)。
     * 检查扩展执行 env 里 ros2 是否可用:若 PATH 无 ros2,点「启动守护进程」的 exec spawn
     * 必然失败,UI 表现为"点了没反应、仍一直不在线"。
     */
    private logEnvDiagOnce() {
        if (this.envDiagDone) {
            return;
        }
        this.envDiagDone = true;
        try {
            const envDiag = composeApi.environment.getEnv();
            const ros2Exe = resolveRos2InPath(envDiag?.PATH);
            const rosVer = envDiag?.ROS_VERSION ? String(envDiag.ROS_VERSION) : "(无)";
            const rosDistro = envDiag?.ROS_DISTRO ? String(envDiag.ROS_DISTRO) : "(无)";
            const domainRaw = envDiag?.ROS_DOMAIN_ID;
            const domain = domainRaw !== undefined && domainRaw !== "" ? String(domainRaw) : "0";
            if (ros2Exe) {
                log.info(vscode.l10n.t("Launch-chain env diagnostics: ROS_VERSION={0}, ROS_DISTRO={1}, ROS_DOMAIN_ID={2}; PATH resolved ros2 -> {3} (probe port=11511+{4})", rosVer, rosDistro, domain, ros2Exe, domain));
            } else {
                log.warn(vscode.l10n.t("Launch-chain env diagnostics: ROS_VERSION={0}, ROS_DISTRO={1}, ROS_DOMAIN_ID={2}; ros2 not found on PATH -> clicking \"Start Helper\" will fail (ros2 command not found); activate/source the ROS environment first, or investigate the activation chain", rosVer, rosDistro, domain));
            }
        } catch (error) {
            log.debug(vscode.l10n.t("Launch-chain env diagnostics failed: {0}", error instanceof Error ? error.message : String(error)));
        }
    }
}
