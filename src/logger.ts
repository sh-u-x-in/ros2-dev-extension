// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file logger.ts
 * 扩展日志薄封装:在全局 LogOutputChannel 上
 * 自动附加模块前缀,分级转发到 VS Code 原生等级过滤。
 *
 * 等级过滤交给 VS Code 标准机制(输出面板右上角下拉 / env.logLevel),
 * 这里不做二次实现,保持最薄。
 *
 * 通道获取采用"注入式"(setLogChannelGetter):由 extension 激活时注入 outputChannel。
 * 这样本模块不依赖 vscode/extension,任何仅引入 logger 的纯逻辑模块
 * 也能在纯 Node 环境(含单元测试)运行——通道未注入时自动回退 console。
 *
 * 镜像(测试/无头可观测性):环境变量 RDE_ROS2_LOG_MIRROR 控制扩展日志
 * 的额外去向——OutputChannel 与 stdout/文件双写,便于无头集成测试
 * 与扩展日志互相印证。取值:
 *   - 未设置/空 → 不镜像(现状,零开销)
 *   - "console"  → 镜像到 stdout(测试进程直接可见)
 *   - 其他字符串 → 视为文件路径,逐条追加写入(如 /tmp/rde-ros2-ext.log)
 */

import * as fs from "fs";

/** 日志通道最小接口(对齐 vscode.LogOutputChannel 的五个级别方法) */
export interface LogChannel {
    trace(message: string, ...args: any[]): void;
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}

/** 全局日志通道获取器:默认返回 undefined(激活前/纯 Node 环境 → 回退 console) */
let channelGetter: () => LogChannel | undefined = () => undefined;

/**
 * 注入全局日志通道获取器(由 extension 激活完成 outputChannel 创建后调用)。
 * 通道未注入时日志回退到 console,避免丢失。
 */
export function setLogChannelGetter(getter: () => LogChannel | undefined): void {
    channelGetter = getter;
}

/** 取全局日志通道；激活完成前未初始化时返回 undefined,调用方安全跳过 */
function channel(): LogChannel | undefined {
    return channelGetter();
}

/**
 * 镜像目标(由环境变量 RDE_ROS2_LOG_MIRROR 初始化一次):
 * undefined=不镜像；"console"=stdout；其他=文件路径。
 */
const logMirror: string | undefined = (() => {
    const raw = process.env.RDE_ROS2_LOG_MIRROR;
    return raw && raw.trim() !== "" ? raw.trim() : undefined;
})();

/** 镜像写文件/控制台:失败仅告警不中断主流程(镜像是可观测性辅助,不允许影响扩展) */
function mirror(level: string, text: string): void {
    if (!logMirror) {
        return;
    }
    try {
        const line = `[${level}] ${text}`;
        if (logMirror === "console") {
            // eslint-disable-next-line no-console
            (console as any)[level](line);
        } else {
            fs.appendFileSync(logMirror, `${line}\n`, "utf8");
        }
    } catch {
        // 镜像失败(路径不可写等)静默忽略,不影响主流程
    }
}

/** 通道未就绪(激活前)时回退到 console,避免日志丢失；按 RDE_ROS2_LOG_MIRROR 镜像额外去向 */
function emit(level: "trace" | "debug" | "info" | "warn" | "error", message: string, args: any[]): void {
    const ch = channel();
    const prefixed = `[ros2-dev-extension] ${message}`;
    if (ch) {
        (ch as any)[level](prefixed, ...args);
    } else {
        // eslint-disable-next-line no-console
        (console as any)[level](prefixed, ...args);
    }
    // 镜像用不带扩展名前缀的 message(模块前缀 [module] 已有):避免每行重复 [ros2-dev-extension]
    mirror(level, message);
}

/** 带模块前缀的轻量日志器(薄封装) */
export function getLogger(module: string) {
    const fmt = (message: string) => `[${module}] ${message}`;
    return {
        trace: (message: string, ...args: any[]) => emit("trace", fmt(message), args),
        debug: (message: string, ...args: any[]) => emit("debug", fmt(message), args),
        info: (message: string, ...args: any[]) => emit("info", fmt(message), args),
        warn: (message: string, ...args: any[]) => emit("warn", fmt(message), args),
        error: (error: string | Error, ...args: any[]) => {
            const msg = error instanceof Error ? (error.stack ?? error.message) : error;
            emit("error", fmt(msg), args);
        },
    };
}
