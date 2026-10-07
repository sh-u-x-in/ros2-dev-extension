// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros-terminal-profile.ts
 * ROS 环境终端配置文件(TerminalProfileProvider):
 * 在"新建终端"下拉框中提供"ROS 2 环境"配置,复用 extension.env 注入 ROS 环境,
 * 并在终端最上方打印已加载环境 banner,便于用户确认加载了哪个发行版、可手动补充。
 *
 * 跨平台策略(按 detectTerminalShell 识别):
 *  - Linux/macOS bash/sh : --noprofile --rcfile <wrapper>,wrapper 先 source ~/.bashrc 再注入
 *  - Linux/macOS zsh     : ZDOTDIR=<临时目录>,临时目录内 .zshrc 先 source ~/.zshrc 再注入
 *  - fish                : --init-command "banner; set -gx ...",config.fish 默认加载、-C 在其后执行
 *  - Windows PowerShell  : -NoExit -File <init.ps1>,$PROFILE 默认加载、脚本内 $env: 注入
 *  - Windows cmd         : /k <init.bat>,cmd 无 profile、直接 set 注入
 *  - WSL (wsl.exe)       : 暂不自动注入,降级为普通 shell 并提示
 *
 * 顺序保证:用户 shell 启动文件(bashrc/zshrc/config.fish/$PROFILE)先加载(不跳过),
 * 随后才注入扩展 env(export/set/$env:),实现"注入覆盖启动文件"。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// 2026-08-26:文件自 consumers/ 移入 consumers/terminal/,相对路径补一层 ../(编译错误修复)
import { getLogger } from "../../../logger";
// 2026-08-26:统一经 api/ 取实例(composeApi.environment),不再直连环境域实现
import { composeApi } from "../../api";
import { detectUserShell } from "../../host/terminal";

/** 扩展日志薄封装(带 terminal-profile 模块前缀) */
const log = getLogger("terminal-profile");

/** 下拉框里显示的 profile 名称(id 需与 package.json contributes.terminal.profiles 一致) */
export const ROS_TERMINAL_PROFILE_ID = "ros2-dev-extension.ros-environment";
// (2026-10-04 i18n 期2)标题英文源+zh-cn 册译文,与 manifest profile 标题同译(bundle 键 "ROS 2 Environment")
export const ROS_TERMINAL_PROFILE_TITLE = vscode.l10n.t("ROS 2 Environment");

/** 注入脚本目录(系统临时目录下固定位置,每次提供时覆盖写入最新 wrapper) */
function initDir(): string {
    return path.join(os.tmpdir(), "ros2-dev-extension-terminal");
}

/** 检测到的终端 shell 信息 */
interface TerminalShellInfo {
    name: string;
    executable: string;
}

/**
 * 检测实际终端 shell。
 * 优先用 VS Code 检测到的默认 shell(vscode.env.shell),覆盖 detectUserShell
 * 在 Windows 上恒返回 cmd 的局限(用户默认可能是 PowerShell / Git Bash / WSL)。
 */
function detectTerminalShell(): TerminalShellInfo {
    log.trace(vscode.l10n.t("Detecting terminal shell type"));
    const shellEnv = vscode.env.shell;
    if (shellEnv) {
        const base = path.basename(shellEnv).toLowerCase();
        if (/^(powershell|pwsh)/.test(base)) {
            log.debug(vscode.l10n.t("Detected shell: pwsh ({0})", shellEnv));
            return { name: "pwsh", executable: shellEnv };
        }
        if (base === "cmd.exe" || base === "cmd") {
            return { name: "cmd", executable: shellEnv };
        }
        if (base.includes("wsl")) {
            return { name: "wsl", executable: shellEnv };
        }
        if (base.includes("fish")) {
            return { name: "fish", executable: shellEnv };
        }
        if (base.includes("zsh")) {
            return { name: "zsh", executable: shellEnv };
        }
        if (base.endsWith("sh.exe") || base.includes("bash")) {
            return { name: "bash", executable: shellEnv };
        }
        if (base === "sh") {
            return { name: "sh", executable: shellEnv };
        }
        if (base.includes("csh") || base.includes("tcsh")) {
            return { name: "csh", executable: shellEnv };
        }
    }
    const info = detectUserShell();
    return { name: info.name, executable: info.executable };
}

/** 组装终端顶部 banner:显示已加载的发行版 / 全局脚本 / 工作区 overlay */
function buildBanner(): string[] {
    log.trace(vscode.l10n.t("Assembling terminal environment banner"));
    const env = composeApi.environment.getEnv() || {};
    const NOT_DETECTED = vscode.l10n.t("(not detected)");
    const distro = typeof env.ROS_DISTRO === "string" && env.ROS_DISTRO ? env.ROS_DISTRO : NOT_DETECTED;
    const version = typeof env.ROS_VERSION === "string" ? env.ROS_VERSION : "";
    const setup = distro !== NOT_DETECTED
        ? (process.platform === "win32" ? `C:\\opt\\ros\\${distro}\\x64\\setup.bat` : `/opt/ros/${distro}/setup.sh`)
        : "";

    const lines: string[] = [];
    lines.push("──────────────────────────────────────────────");
    lines.push(vscode.l10n.t("  [ROS 2 Environment] Loaded distribution: {0}", distro));
    lines.push(`  ROS_DISTRO=${distro}   ROS_VERSION=${version}`);
    if (setup) {
        lines.push(vscode.l10n.t("  Global script: {0}", setup));
    }
    // 工作区 overlay:colcon/ament 环境前缀(可含多个,取第一个)
    const prefix = env.COLCON_PREFIX_PATH || env.AMENT_PREFIX_PATH || "";
    if (typeof prefix === "string" && prefix) {
        lines.push(`  Overlay: ${prefix.split(path.delimiter)[0]}`);
    }
    // 环境变量速览(2026-08-26:替代 colcon 缓存包列表——consumers 不再跨域依赖 build-tool)
    const quickEnv: Array<[string, unknown]> = [
        ["ROS_DOMAIN_ID", env.ROS_DOMAIN_ID],
        ["RMW_IMPLEMENTATION", env.RMW_IMPLEMENTATION],
        ["ROS_LOCALHOST_ONLY", env.ROS_LOCALHOST_ONLY],
    ];
    const shown = quickEnv
        .filter(([, v]) => typeof v === "string" && v)
        .map(([k, v]) => `${k}=${v}`);
    if (shown.length > 0) {
        lines.push(vscode.l10n.t("  Environment variables: {0}", shown.join("  ")));
    } else {
        lines.push(vscode.l10n.t("  Environment variables: (no extra ROS variables set)"));
    }
    lines.push("──────────────────────────────────────────────");
    return lines;
}

/** 待注入的 env 键值对(复用 extension.env,排除进程私有变量) */
function envEntries(): Array<[string, string]> {
    const env = composeApi.environment.getEnv() || process.env;
    const excluded = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PS1"]);
    const entries: Array<[string, string]> = [];
    // 循环:遍历进程环境变量,剔除私有变量后收集待注入项
    for (const key of Object.keys(env)) {
        const value = env[key];
        if (typeof value === "string" && !excluded.has(key)) {
            entries.push([key, value]);
        }
    }
    return entries;
}

/** POSIX(sh/bash/zsh)单引号转义 */
function shQuote(value: string): string {
    return "'" + value.replace(/'/g, `'\\''`) + "'";
}

/** PowerShell 单引号字符串转义(内部单引号 → 两个单引号) */
function pwshQuote(value: string): string {
    return "'" + value.replace(/'/g, "''") + "'";
}

/** fish 双引号字符串转义 */
function fishQuote(value: string): string {
    return '"' + value.replace(/(["\\$`])/g, "\\$1") + '"';
}

// ---------------------------------------------------------------------------
// 各平台 wrapper 脚本生成
// ---------------------------------------------------------------------------

/** bash/sh wrapper:先 source ~/.bashrc,再 banner,最后注入 env */
function buildBashWrapper(banner: string[], entries: Array<[string, string]>): string {
    const lines: string[] = [];
    lines.push("# --- ros2-dev-extension ROS environment terminal injection (bash) ---");
    lines.push("# 1) source user ~/.bashrc (not skipped)");
    lines.push(`if [ -r "$HOME/.bashrc" ]; then`);
    lines.push(`  . "$HOME/.bashrc"`);
    lines.push(`fi`);
    lines.push("# 2) loaded environment banner");
    lines.push(`cat <<'RDE_BANNER'`);
    lines.push(banner.join("\n"));
    lines.push(`RDE_BANNER`);
    lines.push("# 3) inject extension env (overrides startup file settings)");
    for (const [key, value] of entries) {
        lines.push(`export ${key}=${shQuote(value)}`);
    }
    lines.push("");
    return lines.join("\n");
}

/** zsh wrapper:放临时 ZDOTDIR 的 .zshrc,先 source ~/.zshrc 再注入 */
function buildZshWrapper(banner: string[], entries: Array<[string, string]>): string {
    const lines: string[] = [];
    lines.push("# --- ros2-dev-extension ROS environment terminal injection (zsh) ---");
    lines.push("# 1) source user ~/.zshrc (not skipped)");
    lines.push(`if [ -r "$HOME/.zshrc" ]; then`);
    lines.push(`  . "$HOME/.zshrc"`);
    lines.push(`fi`);
    lines.push("# 2) loaded environment banner");
    lines.push(`cat <<'RDE_BANNER'`);
    lines.push(banner.join("\n"));
    lines.push(`RDE_BANNER`);
    lines.push("# 3) inject extension env (overrides startup file settings)");
    for (const [key, value] of entries) {
        lines.push(`export ${key}=${shQuote(value)}`);
    }
    lines.push("");
    return lines.join("\n");
}

/** fish:--init-command(config.fish 默认加载,-C 在其后执行,顺序正确) */
function buildFishInitCommand(banner: string[], entries: Array<[string, string]>): string {
    const cmds: string[] = [];
    // banner 逐行 printf
    const bannerArgs = banner.map((line) => `'${line}'`).join(" ");
    cmds.push(`printf '%s\\n' ${bannerArgs}`);
    for (const [key, value] of entries) {
        cmds.push(`set -gx ${key} ${fishQuote(value)}`);
    }
    return cmds.join("; ");
}

/** PowerShell init.ps1:$PROFILE 默认加载,脚本内 $env: 注入覆盖 */
function buildPwshInitScript(banner: string[], entries: Array<[string, string]>): string {
    const lines: string[] = [];
    lines.push("# --- ros2-dev-extension ROS environment terminal injection (PowerShell) ---");
    lines.push("try {");
    for (const line of banner) {
        lines.push(`  Write-Host ${pwshQuote(line)}`);
    }
    lines.push("  # inject extension env (overrides $PROFILE settings)");
    for (const [key, value] of entries) {
        lines.push(`  $env:${key} = ${pwshQuote(value)}`);
    }
    lines.push("} catch {");
    lines.push(`  Write-Host "[ros2-dev-extension] ${vscode.l10n.t("ROS environment injection failed")}: $($_.Exception.Message)"`);
    lines.push("}");
    return lines.join("\n");
}

/** cmd init.bat:cmd 无 profile,直接 set 注入 */
function buildCmdInitBatch(banner: string[], entries: Array<[string, string]>): string {
    const lines: string[] = [];
    lines.push("@echo off");
    lines.push("setlocal");
    lines.push("echo.");
    for (const line of banner) {
        // echo 中特殊字符(如 %、!、&)在批处理中需注意；banner 一般为中文/路径/括号,安全
        lines.push(`echo ${line}`);
    }
    lines.push("echo.");
    lines.push("rem inject extension env (override)");
    for (const [key, value] of entries) {
        lines.push(`set "${key}=${value}"`);
    }
    lines.push("endlocal");
    return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// 写入 wrapper 并构造 TerminalProfile
// ---------------------------------------------------------------------------

/** 将内容写入固定目录下的文件(覆盖写),返回完整路径 */
function writeInitFile(relative: string, content: string): string {
    log.debug(vscode.l10n.t("Writing terminal injection script: {0}", relative));
    const dir = initDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, relative);
    fs.writeFileSync(file, content, "utf8");
    return file;
}

/** 构造跨平台 TerminalProfile(复用 extension.env) */
function buildTerminalProfile(): vscode.TerminalProfile {
    log.trace(vscode.l10n.t("Building ROS environment terminal profile"));
    const shell = detectTerminalShell();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // 非 ROS 环境:退化为普通 VS Code 终端——不生成临时脚本、不注入、不 banner,
    // 行为靠拢"bashrc 覆盖进程环境"的默认终端。
    // 复用统一环境判定 environmentFacade.getEnvIssue() === null(单一判定来源,2026-08-25 收口)。
    if (composeApi.environment.getEnvIssue() !== null) {
        log.debug(vscode.l10n.t("ROS environment unavailable; degrading to plain terminal"));
        const plain: vscode.TerminalOptions = {
            name: ROS_TERMINAL_PROFILE_TITLE,
            shellPath: shell.executable,
        };
        if (cwd) {
            plain.cwd = cwd;
        }
        return new vscode.TerminalProfile(plain);
    }

    const banner = buildBanner();
    const entries = envEntries();

    const options: vscode.TerminalOptions = { name: ROS_TERMINAL_PROFILE_TITLE };

    log.debug(vscode.l10n.t("Building terminal injection config for {0} branch", shell.name));
    switch (shell.name) {
        case "bash": {
            // bash 用 --rcfile 注入 wrapper(非登录交互 shell)
            const wrapper = writeInitFile("ros-env-bash.sh", buildBashWrapper(banner, entries));
            options.shellPath = shell.executable;
            options.shellArgs = ["--noprofile", "--rcfile", wrapper, "-i"];
            if (cwd) {
                options.cwd = cwd;
            }
            break;
        }
        case "sh": {
            // POSIX sh/dash:无 --rcfile 等价物,用 ENV 变量指向 wrapper(交互 POSIX sh 读取 $ENV)
            const wrapper = writeInitFile("ros-env-sh.sh", buildBashWrapper(banner, entries));
            options.shellPath = shell.executable;
            options.shellArgs = ["-i"];
            options.env = { ENV: wrapper };
            if (cwd) {
                options.cwd = cwd;
            }
            break;
        }
        case "zsh": {
            // zsh 用 ZDOTDIR 指向临时目录,其中的 .zshrc 为注入 wrapper
            const zdotdir = path.join(initDir(), "zdotdir");
            fs.mkdirSync(zdotdir, { recursive: true });
            const zshrc = path.join(zdotdir, ".zshrc");
            fs.writeFileSync(zshrc, buildZshWrapper(banner, entries), "utf8");
            options.shellPath = shell.executable;
            options.shellArgs = ["-i"];
            // 仅注入 ZDOTDIR(其余继承 VS Code 环境)；ROS env 在 wrapper 内、~/.zshrc 之后注入
            options.env = { ZDOTDIR: zdotdir };
            if (cwd) {
                options.cwd = cwd;
            }
            break;
        }
        case "fish": {
            options.shellPath = shell.executable;
            options.shellArgs = ["--init-command", buildFishInitCommand(banner, entries)];
            if (cwd) {
                options.cwd = cwd;
            }
            break;
        }
        case "pwsh": {
            const script = writeInitFile("ros-env-init.ps1", buildPwshInitScript(banner, entries));
            options.shellPath = shell.executable;
            options.shellArgs = ["-NoExit", "-File", script];
            if (cwd) {
                options.cwd = cwd;
            }
            break;
        }
        case "cmd": {
            const batch = writeInitFile("ros-env-init.bat", buildCmdInitBatch(banner, entries));
            options.shellPath = shell.executable;
            options.shellArgs = ["/k", batch];
            if (cwd) {
                options.cwd = cwd;
            }
            break;
        }
        case "wsl": {
            // WSL 暂不自动注入(需 Linux 侧脚本,见文件头说明)；降级为普通 shell
            options.shellPath = shell.executable;
            break;
        }
        default: {
            options.shellPath = shell.executable;
            options.env = composeApi.environment.getEnv() || process.env;
            break;
        }
    }

    return new vscode.TerminalProfile(options);
}

/**
 * 注册"ROS 2 环境"终端配置文件。
 * 需在 package.json 声明:activationEvents 的 onTerminalProfile:<id>、
 * contributes.terminal.profiles 的 { id, title }。
 */
export function registerRosTerminalProfileProvider(context: vscode.ExtensionContext): void {
    log.trace(vscode.l10n.t("Registering ROS environment terminal profile provider"));
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(ROS_TERMINAL_PROFILE_ID, {
            provideTerminalProfile(_token: vscode.CancellationToken): vscode.TerminalProfile {
                return buildTerminalProfile();
            },
        }),
    );
}
