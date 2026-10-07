// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file command-runner.ts
 * CommandRunner 接口定义(非交互命令执行,统一超时/编码/日志)。
 * 接口定义占位(接口集中 api/,2026-08-25);实现后续接入:
 *   - 实现:src/ros2/environment/command-runner.ts(合并 promisifiedExec + execColconRaw)
 * env 由实现从 EnvironmentState 实时取(自动注入),调用方不接触 env 对象。
 * 错误契约:exec 非零退出码/超时 → reject CommandExecError(见下)。
 */

import * as child_process from "child_process";

/** 非交互命令执行结果 */
export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * exec 失败时 reject 的错误(接口错误契约;实现必须保证字段齐全)。
 * - 非零退出码:code = 退出码,timedout = false;
 * - 超时 kill:code = null,timedout = true;
 * - stdout/stderr 为已解码文本(UTF-8 严格 → GBK 回退 → 宽松 UTF-8)。
 */
export interface CommandExecError extends Error {
    /** 已解码的 stdout(UTF-8/GBK 回退) */
    stdout: string;
    /** 已解码的 stderr(UTF-8/GBK 回退) */
    stderr: string;
    /** 进程退出码;被信号杀死/超时 kill 时为 null */
    code: number | null;
    /** 是否因超时被 kill */
    timedout: boolean;
}

/** 命令执行接口:自动注入当前 env;统一超时 + UTF-8/GBK 解码 + 日志(需求 A6) */
export interface CommandRunner {
    /** 执行需 env 的非交互命令;非零退出码 → reject(错误带 {stdout,stderr,code});超时 → reject(timedout) */
    exec(command: string, options?: {
        cwd?: string;
        timeoutMs?: number;             // 默认 30s
        env?: Record<string, string>;   // 覆盖项;缺省用 state.getEnv()
    }): Promise<ExecResult>;
    /** 流式执行(构建/测试需实时输出 + 超时 kill),返回子进程句柄 */
    spawn(argv: string[], options?: {
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
    }): child_process.ChildProcess;
}
