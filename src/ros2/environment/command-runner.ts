// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file command-runner.ts
 * 实现 CommandRunner 接口(api/command-runner.ts,需求 A6):非交互命令执行的统一原语。
 * 合并旧两套原语(2026-08-25):
 *   - build-tool/packages/colcon-exec.ts 的 execColconRaw(30s 超时 + GBK 解码)
 *   - commands/ros2.ts 的 promisifiedExec + decodeExecError(无超时)
 * 统一:30s 默认超时、UTF-8 严格 → GBK → 宽松 UTF-8 三级解码、trace/error 日志;
 * env 由实现从 state.getEnv() 实时取(非快照),调用方不接触 env 对象。
 * 消费方迁移后,旧两套原语即可删除。
 */

import { l10n } from "vscode";

import * as child_process from "child_process";

import type { CommandExecError as CommandExecErrorBase, CommandRunner, ExecResult } from "../api/command-runner";

import { getLogger } from "../../logger";
import { getEnv } from "./state";

/** command-runner 模块日志 */
const log = getLogger("command-runner");

/** 默认超时(ms):与旧 execColconRaw 的 30s 兜底一致,避免命令挂起永久 pending */
const DEFAULT_TIMEOUT_MS = 30000;

/** 默认 stdout/stderr 缓冲上限:child_process.exec 默认 1MB,colcon 大输出可能超限,放宽到 10MB */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * 解码子进程输出:优先按 UTF-8 严格解码；若含非法序列(Windows 中文系统下 cmd/colcon
 * 输出为 GBK/CP936),回退 GBK 解码；再失败则宽松 UTF-8(替换非法字节)兜底。
 * 使用 Node 内置 util.TextDecoder,零新增依赖。
 * (逻辑与旧 colcon-exec.ts 的 decodeChildOutput 一致,迁入统一原语)
 */
function decodeChildOutput(data: Buffer | string): string {
    if (typeof data === "string") {
        return data;
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
        // 非 UTF-8(常见于 Windows 中文系统 cmd/colcon 输出 GBK/CP936):回退 GBK 解码
        log.trace("command-runner: output is not UTF-8; falling back to GBK decoding (Chinese Windows output)");
        try {
            return new TextDecoder("gbk").decode(data);
        } catch {
            log.trace("command-runner: GBK decoding failed; lenient UTF-8 fallback");
            return new TextDecoder("utf-8", { fatal: false }).decode(data);
        }
    }
}

/** 取执行用 env:显式覆盖项优先;否则 state.getEnv()(实时,非快照);未 source 时回退 process.env */
function resolveEnv(override?: Record<string, string>): NodeJS.ProcessEnv {
    const base = override ?? getEnv();
    if (!base) {
        return process.env;
    }
    return base as NodeJS.ProcessEnv;
}

/** exec 失败时 reject 的错误:类型定义集中 api/command-runner.ts(CommandExecError) */

/** 击杀超时命令:win32 必须树杀(taskkill /T)——只杀直系 shell(cmd.exe),孙进程会
 *  握着 stdio 管道继续活(exec 回调也永不触发,测试实测);POSIX 的 sh -c "单条命令"
 *  经 dash exec 优化后 child 即真身,直杀即净(多命令串的孙进程风险由调用方 `timeout`
 *  兜底,如 lifecycle_set 的 35s 守卫;exec 不落实 detached,进程组击杀不可用——VM 实测
 *  PGID≠PID)。 */
function killCommandTree(child: child_process.ChildProcess): void {
    try {
        if (process.platform === "win32" && child.pid) {
            child_process.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"],
                { windowsHide: true, stdio: "ignore" });
            return;
        }
    } catch { /* 落直杀 */ }
    try { child.kill("SIGKILL"); } catch { /* 已死忽略 */ }
}


/** 执行需 env 的非交互命令:统一超时(默认 30s)+ 三级解码 + 日志;env 从 state 实时取 */
export function exec(command: string, options?: {
    cwd?: string;
    timeoutMs?: number;            // 默认 30s;超时 → kill 并以 timedout 标记 reject
    env?: Record<string, string>;  // 覆盖项;缺省用 state.getEnv()
}): Promise<ExecResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = resolveEnv(options?.env);
    log.trace(`exec: ${command} (cwd=${options?.cwd ?? process.cwd()}, timeout=${timeoutMs}ms)`);

    return new Promise<ExecResult>((resolve, reject) => {
        let timedout = false;
        const child = child_process.exec(
            command,
            {
                cwd: options?.cwd,
                env,
                // 以原始字节捕获,避免 child_process.exec 默认 UTF-8 解码导致 Windows 中文(GBK)乱码
                encoding: "buffer" as const,
                maxBuffer: DEFAULT_MAX_BUFFER,
                windowsHide: true,
            },
            (error, stdout: Buffer | string, stderr: Buffer | string) => {
                const stdoutText = decodeChildOutput(stdout);
                const stderrText = decodeChildOutput(stderr);
                if (error) {
                    // 失败(非零退出码 / 超时 kill / spawn 错误):携带已解码输出与语义标记
                    const err = error as CommandExecErrorBase;
                    err.stdout = stdoutText;
                    err.stderr = stderrText;
                    // 超时标记:手动定时器置位;kill 后 error.killed=true 且无退出码,双重印证
                    err.timedout = timedout || (error.killed === true && (err.code === null || err.code === undefined));
                    if (err.timedout && !stderrText) {
                        err.stderr = l10n.t("Command execution timed out ({0} ms): {1}", timeoutMs, command);
                    }
                    log.error(l10n.t("exec failed: {0} (code={1}, timedout={2}): {3}", command, String(err.code), String(err.timedout), stderrText || error.message));
                    reject(err);
                } else {
                    log.debug(l10n.t("exec completed: {0} (stdout {1} chars)", command, stdoutText.length));
                    resolve({ stdout: stdoutText, stderr: stderrText, code: 0 });
                }
            }
        );
        // 超时处置(接管 exec 内建 timeout):win32 树杀 / POSIX 直杀,见 killCommandTree
        const timer = setTimeout(() => {
            timedout = true;
            log.warn(l10n.t("exec timed out ({0} ms), killing process tree: {1}", timeoutMs, command));
            killCommandTree(child);
        }, timeoutMs);
        child.once("exit", () => clearTimeout(timer));
        child.once("error", () => clearTimeout(timer));
    });
}

/** 流式执行(构建/测试需实时输出 + 超时 kill),返回子进程句柄;env 从 state 实时取 */
export function spawn(argv: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;  // 超时自动 kill(不强制默认:流式场景由调用方按需指定)
}): child_process.ChildProcess {
    const env = resolveEnv(options?.env);
    log.trace(`spawn: ${argv.join(" ")} (cwd=${options?.cwd ?? process.cwd()}${options?.timeoutMs ? `, timeout=${options.timeoutMs}ms` : ""})`);

    const child = child_process.spawn(argv[0], argv.slice(1), {
        cwd: options?.cwd,
        env,
        windowsHide: true,
    });

    if (options?.timeoutMs) {
        const timer = setTimeout(() => {
            log.warn(l10n.t("spawn timed out ({0} ms), killing: {1}", options.timeoutMs, argv.join(" ")));
            child.kill();
        }, options.timeoutMs);
        child.once("exit", () => clearTimeout(timer));
        child.once("error", () => clearTimeout(timer));
    }

    return child;
}

/** CommandRunner 实现对象(组合根/门面注入用;接口定义在 api/command-runner.ts) */
export const commandRunner: CommandRunner = { exec, spawn };
