// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file env-collect.ts
 * 环境快照采集(2026-09-15 环境体系重设计)。
 *
 * 口径(设计稿"压缩方案"):启动终端 → 依次 source 系统 + 工作空间 → 打印 env,
 * 作为一轮"完整快照"。交互式登录 shell(--login -i)保证用户 shell 配置全链生效
 * (非交互 bash 会被 ~/.bashrc 的非交互守卫拦截,source 行不执行——2026-09-15 实测)。
 *
 * 平台:
 *  - Linux/macOS:bash 交互链(本采集器统一走 bash);
 *  - Windows:退化为两次 sourceSetupFile(rde-common 旧机制,vcvarsall/pixi 链),行为与重设计前一致。
 *
 * 失败处理(验货):关键变量缺失 / 条目数异常 → 返回失败原因,调用方保留旧快照。
 * 采集可行性由用户环境保证(责任转嫁):不作跨机器兼容兜底。
 */

import { l10n } from "vscode";


import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";

import { getConfig } from "../host/config";
import { getWorkspaceRoot } from "../host/fs";
import { sourceSetupFile, getDistros, getRosSetupScript } from "./setup-script";
import { getLogger } from "../../logger";

/** 环境采集模块日志 */
const log = getLogger("env-collect");

/** 采集超时(用户 .bashrc 可能较慢) */
const COLLECT_TIMEOUT_MS = 60000;
/** 输出缓冲上限 */
const COLLECT_MAX_BUFFER = 1024 * 1024;
/** 验货:条目数下限(正常环境约 60+ 条) */
const MIN_ENV_ENTRIES = 10;

/** 采集结果:成功带 env;失败带 reason(二选一) */
export interface CollectOutcome {
    /** 成功时的完整快照(系统 + 工作空间) */
    env?: Record<string, string>;
    /** 失败原因(未通过验货 / 执行失败);成功时为 undefined */
    reason?: string;
}

/** 解析 `env` 输出(KEY=VALUE 行;键非空且不含空格) */
function parseEnvOutput(stdout: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of stdout.split(/\r?\n/)) {
        const idx = line.indexOf("=");
        if (idx <= 0) {
            continue;
        }
        const key = line.slice(0, idx).trim();
        if (key.length === 0 || key.includes(" ")) {
            continue;
        }
        env[key] = line.slice(idx + 1);
    }
    return env;
}

/** POSIX 单引号转义(路径可含空格/特殊字符) */
function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 解析系统 setup 脚本路径:用户配置脚本(rosSetupScript / pixi 推导)优先,
 * 否则按 distro(配置或自动发现)拼 /opt/ros/<distro>/setup.bash(Windows 为 x64/setup.bat)。
 */
async function resolveSystemSetupScript(): Promise<{ script: string } | { error: string }> {
    // 用户配置脚本(rosSetupScript / pixi 推导)优先;但文件不存在时回退标准发现流程
    //(对齐重设计前行为:配置指向未构建工作空间——如 '${workspaceFolder}/install/setup.bash'——时不能卡死)
    const configured = getRosSetupScript();
    if (configured) {
        if (fs.existsSync(configured)) {
            return { script: configured };
        }
        log.warn(l10n.t("Configured ROS environment setup script does not exist; falling back to standard discovery: {0}", configured));
    }
    let distro = getConfig("env.distro", "");
    if (!distro) {
        const distros = await getDistros();
        if (distros.length === 0) {
            return { error: l10n.t("No ROS 2 distribution found (/opt/ros is empty)") };
        }
        if (distros.length > 1) {
            return { error: l10n.t("Multiple ROS 2 distributions found ({0}); configure ROS2.env.distro", distros.join(", ")) };
        }
        distro = distros[0];
    }
    const script = process.platform === "win32"
        ? path.join("C:", "opt", "ros", distro, "x64", "setup.bat")
        : path.join("/opt/ros", distro, "setup.bash");
    if (!fs.existsSync(script)) {
        return { error: l10n.t("System setup script does not exist: {0}", script) };
    }
    return { script };
}

/** 通用验货:通过返回 null;失败返回原因(关键变量存在 + 条目数下限) */
function validateSnapshot(env: Record<string, string>): string | null {
    if (!env.ROS_DISTRO) {
        return l10n.t("ROS_DISTRO missing (system chain not in effect)");
    }
    if (!env.AMENT_PREFIX_PATH) {
        return l10n.t("AMENT_PREFIX_PATH missing");
    }
    const n = Object.keys(env).length;
    if (n < MIN_ENV_ENTRIES) {
        return l10n.t("Abnormal entry count ({0} < {1})", n, MIN_ENV_ENTRIES);
    }
    return null;
}

/** Unix:bash 交互链单次采集(系统 + 工作空间) */
async function collectUnix(): Promise<CollectOutcome> {
    const sysOrError = await resolveSystemSetupScript();
    if ("error" in sysOrError) {
        return { reason: sysOrError.error };
    }
    const sysScript = sysOrError.script;
    const wsRoot = getWorkspaceRoot();
    const wsScript = wsRoot ? path.join(wsRoot, "install", "setup.bash") : "";
    const hasWs = wsScript.length > 0 && fs.existsSync(wsScript);
    if (!hasWs) {
        log.debug(l10n.t("Workspace not built yet ({0} not found); collecting system environment only", wsScript || "install/setup.bash"));
    }

    const innerCommand = [
        `source ${shellQuote(sysScript)}`,
        hasWs ? `source ${shellQuote(wsScript)}` : "",
        "env",
    ].filter((s) => s.length > 0).join("; ");
    const fullCommand = `/bin/bash --login -i -c ${shellQuote(innerCommand)}`;

    log.trace(l10n.t("Collect command (bash interactive chain; ws {0}): {1}", hasWs ? l10n.t("with") : l10n.t("without"), fullCommand));
    const { stdout, stderr, error } = await new Promise<{ stdout: string; stderr: string; error?: Error }>((resolve) => {
        child_process.exec(
            fullCommand,
            {
                cwd: wsRoot ?? process.cwd(),
                timeout: COLLECT_TIMEOUT_MS,
                maxBuffer: COLLECT_MAX_BUFFER,
            },
            (err, out, errOut) => resolve({ stdout: out ?? "", stderr: errOut ?? "", error: err ?? undefined })
        );
    });

    const env = parseEnvOutput(stdout);
    const checkError = validateSnapshot(env);
    if (checkError) {
        const stderrBrief = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
        const reason = error ? `${checkError};exec:${error.message}` : checkError;
        log.warn(l10n.t("Collection verification failed: {0}{1}", reason, stderrBrief ? l10n.t("; stderr: {0}", stderrBrief) : ""));
        return { reason };
    }
    // 附加校验:系统脚本确实生效(AMENT_PREFIX_PATH 含系统脚本目录)
    const sysDir = path.dirname(sysScript);
    if (!env.AMENT_PREFIX_PATH.split(":").some((p) => p === sysDir)) {
        const reason = l10n.t("System script not in effect (AMENT_PREFIX_PATH lacks {0})", sysDir);
        log.warn(l10n.t("Collection verification failed: {0}", reason));
        return { reason };
    }
    // 诊断(非失败):ws setup 存在但未进入环境(如脚本损坏/半构建)——构建后"环境没进来"最常见困惑点,留痕
    // 2026-09-16 修正:兼容 isolated 布局(colcon 默认)——每个包的前缀是 <ws>/install/<包名>;
    // 根 <ws>/install 本身只在 merged 布局(--merge-install)才出现在 AMENT_PREFIX_PATH。
    // 原检查只认"精确等于 <ws>/install",isolated 工作区(如 roa2_ws)必然误报。
    if (hasWs && wsRoot) {
        const wsInstall = path.join(wsRoot, "install");
        const inOverlay = env.AMENT_PREFIX_PATH.split(":").some((p) => p === wsInstall || p.startsWith(wsInstall + path.sep));
        if (!inOverlay) {
            log.warn(l10n.t("Workspace setup sourced but not in effect (AMENT_PREFIX_PATH lacks {0} and its sub-prefixes); check the build artifacts", wsInstall));
        }
    }
    return { env };
}

/** Windows:保底路径——两次 sourceSetupFile(rde-common 链:vcvarsall/pixi/带链) */
async function collectWindowsLegacy(): Promise<CollectOutcome> {
    const sysOrError = await resolveSystemSetupScript();
    if ("error" in sysOrError) {
        return { reason: sysOrError.error };
    }
    try {
        let env: any = await sourceSetupFile(sysOrError.script, undefined);
        const wsRoot = getWorkspaceRoot();
        const wsScript = wsRoot ? path.join(wsRoot, "install", "setup.bat") : "";
        if (wsScript.length > 0 && fs.existsSync(wsScript)) {
            env = await sourceSetupFile(wsScript, env);
        }
        const snapshot: Record<string, string> = env ?? {};
        const checkError = validateSnapshot(snapshot);
        if (checkError) {
            log.warn(l10n.t("Windows collection verification failed: {0}", checkError));
            return { reason: checkError };
        }
        return { env: snapshot };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(l10n.t("Windows collection failed: {0}", reason));
        return { reason };
    }
}

/** 采集一轮完整环境快照(系统 + 工作空间) */
export async function collectEnvironmentSnapshot(): Promise<CollectOutcome> {
    log.debug("Starting environment snapshot collection");
    const result = process.platform === "win32"
        ? await collectWindowsLegacy()
        : await collectUnix();
    if (result.env) {
        log.debug(l10n.t("Collection succeeded ({0} variables)", Object.keys(result.env).length));
    } else {
        log.warn(l10n.t("Collection failed, keeping old snapshot: {0}", result.reason ?? l10n.t("no reason given")));
    }
    return result;
}
