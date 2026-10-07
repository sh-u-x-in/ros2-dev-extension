// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file terminal-run.ts
 * 实现 TerminalRun(api/terminal-run.ts):普通集成终端执行。
 * 动机(2026-09-26):任务终端随任务生死——用户终止 ros2 run/echo 后整个终端被清除,
 * 无法原地改造命令;普通集成终端常驻,提示符可继续输入,历史命令可改参重跑。
 * env 经 createTerminal options 注入环境快照(系统+工作区),与 consumers/terminal 同模式;
 * 环境门槛与 ros_task_runner 同一判定(getEnvIssue 唯一出口),失败经返回值带回、不弹 toast
 * ——反馈方式(行内/提示条)由调用方决定。
 * 执行通道(2026-09-27 定稿,用户点破"环境终端横幅为什么总是可见"):新建终端走
 * **bash --rcfile 启动前注入**——命令写进 wrapper,随 shell 启动在首个提示符前执行,
 * 可见性与横幅同源(零等待、零 PTY 竞态);关键=shellArgs 必须带 -i(交互模式),
 * 否则 bash 忽略 --rcfile、wrapper 整体不执行(上一轮输出不可见的真因)。
 * 复用已有终端走 sendText(shell 在跑,回显正常、瞬时)。
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { getLogger } from "../../logger";
import { getEnv, environmentState } from "../environment";
import { createTerminal, detectUserShell } from "../host/terminal";
import { getWorkspaceRoot } from "../host/fs";

import type { RunNormalTerminalOptions, RunNormalTerminalResult, TerminalRun } from "../api/terminal-run";

/** terminal-run 模块日志 */
const log = getLogger("terminal-run");

/** 已存活终端复用重发前的小延时:避开同终端上一条命令尚在收尾的瞬间 */
const RESEND_GRACE_MS = 150;

/** 同名同命令去重窗口(2026-09-27):连续点击/双击的重复分发在窗口内吞掉——
 *  ros2 service call 单次 1~2s,1s 内的同名同命令重发几乎必是误触 */
const DEDUP_WINDOW_MS = 1000;
let lastSent: { name: string; command: string; at: number } | undefined;

async function runInNormalTerminal(opts: RunNormalTerminalOptions): Promise<RunNormalTerminalResult> {
    const envIssue = environmentState.getEnvIssue();
    if (envIssue !== null) {
        return { ok: false, error: vscode.l10n.t("No usable ROS 2 environment detected. Reason: {0}", envIssue) };
    }
    if (!opts.command.trim()) {
        return { ok: false, error: vscode.l10n.t("Command is empty; cancelled") };
    }
    if (lastSent && lastSent.name === opts.name && lastSent.command === opts.command
        && Date.now() - lastSent.at < DEDUP_WINDOW_MS) {
        log.warn(vscode.l10n.t("Ignoring duplicate request with same name and command within {0} ms: \"{1}\"", DEDUP_WINDOW_MS, opts.name));
        return { ok: true, reused: true };
    }
    // 按名复用:同名终端存在 → 聚焦;重复调用类按需重发,常驻订阅类只聚焦(防同终端叠加两个 echo)
    const existing = vscode.window.terminals.find((t) => t.name === opts.name);
    if (existing) {
        existing.show(true);
        if (opts.resendOnReuse === true) {
            lastSent = { name: opts.name, command: opts.command, at: Date.now() };
            setTimeout(() => { sendCommand(existing, opts.command); }, RESEND_GRACE_MS);
        }
        log.debug(vscode.l10n.t("Reusing terminal \"{0}\" (resend={1})", opts.name, String(opts.resendOnReuse === true)));
        return { ok: true, reused: true };
    }
    const shell = detectInjectionShell();
    const wrapper = shell ? writeCommandWrapper(opts.command) : undefined;
    const terminal = createTerminal({
        name: opts.name,
        cwd: opts.cwd ?? getWorkspaceRoot(),
        env: getEnv(),
        shellPath: wrapper ? shell.executable : undefined,
        shellArgs: wrapper ? ["--noprofile", "--rcfile", wrapper, "-i"] : undefined,
    });
    terminal.show(true);
    lastSent = { name: opts.name, command: opts.command, at: Date.now() };
    if (wrapper) {
        // 命令随 shell 启动在首个提示符前执行(可见性与环境终端横幅同源):零等待、零 PTY 竞态
        log.debug(vscode.l10n.t("Terminal \"{0}\" created; command runs via rcfile at startup: {1}", opts.name, opts.command));
    } else {
        // 非 bash shell 无通用 rcfile 机制:回退 sendText 直写(回显异常风险仅限此类环境)
        log.debug(vscode.l10n.t("Terminal \"{0}\" created ({1} has no rcfile injection); writing directly via sendText: {2}", opts.name, shell ? shell.name : "shell", opts.command));
        sendCommand(terminal, opts.command);
    }
    return { ok: true, reused: false };
}

/** 取执行用 sendCommand:直写 PTY(复用路径:shell 在跑,回显正常) */
function sendCommand(terminal: vscode.Terminal, command: string): void {
    // 2026-09-30 四轮:先关历史展开再发命令 —— 复用路径命令打到【交互提示符】,
    // !x 会被 history expansion 吞掉(用户实测「!@#: event not found」);新建终端路径由 wrapper 的 set +H 覆盖
    terminal.sendText("set +H", true);
    terminal.sendText(command, true);
}

/** POSIX 单引号转义(与 terminal-profile 的 shQuote 同款) */
function shQuote(value: string): string {
    return "'" + value.replace(/'/g, `'\\''`) + "'";
}

/**
 * 检测注入目标 shell:优先 vscode.env.shell(与 terminal-profile 的 detectTerminalShell 同口径),
 * 兜底 detectUserShell。仅 bash 支持 --rcfile 预载;其他 shell 返回 undefined → 回退 sendText。
 */
function detectInjectionShell(): { name: string; executable?: string } | undefined {
    const shellEnv = vscode.env.shell;
    if (shellEnv) {
        const base = path.basename(shellEnv).toLowerCase();
        if (base.includes("bash")) {
            return { name: "bash", executable: shellEnv };
        }
        return undefined;
    }
    const info = detectUserShell();
    return info.name.toLowerCase().includes("bash") ? { name: "bash", executable: info.executable } : undefined;
}

/**
 * 写命令注入 wrapper(环境终端横幅同款机制,2026-09-27 用户点破后采纳):
 * source 用户 bashrc → 回显一行命令(形如键入)→ eval 执行 → history -s 进历史
 * (上箭头可改参重跑)。注意:调用方 shellArgs 必须带 -i——bash 的 --rcfile
 * 仅对交互 shell 生效,缺 -i 时 wrapper 被整体跳过(上一轮"输出不可见"的真因)。
 */
function writeCommandWrapper(command: string): string | undefined {
    const dir = path.join(os.tmpdir(), "ros2-dev-extension-terminal");
    try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `rde-cmd-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sh`);
        // 2026-09-29 转义修复(VM 实测接收端对比,六组恶意值矩阵):命令【原样写一行直接执行】——
        // 旧实现 `__rde_cmd=shQuote(cmd)` + `eval "$__rde_cmd"` 双层解析,交互 rcfile 环境下
        // '\'' 转义序列被当字面量,含单引号/空格的参数值六组全 FAIL(参数串值/请求发不出);
        // 直接行单次解析,与用户手敲完全同构,六组全 PASS(含 ' " $ 空格 换行 反斜杠)。
        // 多版本官方解析核对(humble call.py:80 / jazzy:90 / rolling:102)均为单 argv → yaml.safe_load,无版本差异。
        const lines = [
            "# --- ros2-dev-extension command injection (bash) ---",
            "if [ -r \"$HOME/.bashrc\" ]; then",
            "  . \"$HOME/.bashrc\"",
            "fi",
            // 2026-09-30 四轮:关历史展开(set +H)——交互会话里 !x 会被 history expansion 吞掉
            // (用户实测「!@#: event not found」),含 ! 的参数值必须关掉;↑ 重跑同样安全
            "set +H",
            command,
            `history -s ${shQuote(command)}`,   // 历史存原命令(shQuote 整体引成一词,↑ 复原原样)
            "",
        ];
        fs.writeFileSync(file, lines.join("\n"), "utf8");
        return file;
    } catch (err) {
        log.warn(vscode.l10n.t("Failed to write command injection wrapper; falling back to sendText: {0}", err instanceof Error ? err.message : String(err)));
        return undefined;
    }
}

/** TerminalRun 实现(组合根注入用;接口定义在 api/terminal-run.ts) */
export const terminalRun: TerminalRun = runInNormalTerminal;
