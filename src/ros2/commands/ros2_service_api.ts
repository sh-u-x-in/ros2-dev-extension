// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros2_service_api.ts
 * 实现 Ros2ServiceApi 接口(api/ros2-service-api.ts,需求 B 查询/状态类)。
 * 吸收旧 ros2.ts / params.ts / lifecycle.ts / daemon.ts 的查询/状态能力,
 * 统一经 CommandRunner 执行(2026-08-26:组合根注入,不再静态 import environment):
 *   - env 由 CommandRunner 从 state.getEnv() 实时取(非快照,修掉"re-source 不同步"债)
 *   - 统一 30s 超时 + UTF-8/GBK 三级解码 + 日志
 * 执行类(colcon_build / run / launch / doctor / rosdep)归 RosTaskRunner(api/ros-task-runner.ts),此处不重复。
 *
 * 错误策略(2026-09-01 定稿,null 契约):
 *   - 查询类(pkg/interface/param/lifecycle_nodes/lifecycle_get/colcon_list):失败 → resolve **null**
 *     (记日志;绝不抛、绝不 undefined);成功 → 真实值(可为空数组/空串)。
 *     null = 失败,[]/"" = 成功但空——二者不再相撞(此前失败折叠为空值导致"合法空"与"失败"不可区分)。
 *   - 操作类(lifecycle_set / daemon):失败 reject 上抛(调用方需要知道是否成功)。
 */

import { l10n } from "vscode";

import * as path from "path";

import type { LifecycleState, PackageEntry, Ros2ServiceApi } from "../api/ros2-service-api";
import type { CommandRunner } from "../api/command-runner";
import { getLogger } from "../../logger";

// 2026-08-26:声明式依赖——commandRunner 由组合根注入(compose 装配时 setCommandRunner),
// 本文件不再 import 环境域实现;接口类型经 api/(与 setRos2ServiceApi 注入模式一致)。
/** 注入的 CommandRunner 实现(未注入 → 兜底抛错,提示装配遗漏) */
let commandRunner: CommandRunner = {
    exec: async () => { throw new Error(l10n.t("commandRunner not injected; call setCommandRunner during compose assembly")); },
    spawn: () => { throw new Error(l10n.t("commandRunner not injected; call setCommandRunner during compose assembly")); },
};

/** 注入 CommandRunner 实现(compose 组合根调用;替换未注入兜底) */
export function setCommandRunner(cr: CommandRunner): void {
    commandRunner = cr;
}

/** ros2-service-api 模块日志 */
const log = getLogger("ros2-service-api");

/** 标准生命周期状态表(与旧 lifecycle.ts LIFECYCLE_STATES 一致) */
const LIFECYCLE_STATES: ReadonlyArray<{ id: number; label: string }> = [
    { id: 1, label: "unconfigured" },
    { id: 2, label: "inactive" },
    { id: 3, label: "active" },
    { id: 4, label: "finalized" },
];

/** 按行拆分并清理输出(trim + 去空行;兼容 CRLF) */
function splitLines(stdout: string): string[] {
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 错误详情:优先用 CommandRunner 已解码的 stderr(Windows 中文可读),否则 message */
function errMsg(error: unknown): string {
    if (error && typeof error === "object") {
        const e = error as { stderr?: string };
        if (e.stderr && e.stderr.trim().length > 0) {
            return e.stderr.trim();
        }
    }
    return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* 包/接口查询                                                          */
/* ------------------------------------------------------------------ */

/** ros2 pkg list → 每行一个包名 */
async function pkg_list(_opts?: {}): Promise<string[] | null> {
    try {
        const { stdout } = await commandRunner.exec("ros2 pkg list");
        return splitLines(stdout);
    } catch (error) {
        log.error(l10n.t("ros2 pkg list failed: {0}", errMsg(error)));
        return null;
    }
}

/** ros2 pkg prefix [--share] <name> → 目录路径(默认 --share,与旧行为一致) */
async function pkg_prefix(opts: { name: string; shared?: boolean }): Promise<string | null> {
    const flag = opts.shared === false ? "" : " --share";
    try {
        const { stdout } = await commandRunner.exec(`ros2 pkg prefix${flag} ${opts.name}`);
        return stdout.trim();
    } catch (error) {
        log.error(l10n.t("ros2 pkg prefix {0} failed: {1}", opts.name, errMsg(error)));
        return null;
    }
}

/** ros2 pkg executables <name> → 可执行名列表(每行 "pkg exe",取第二列) */
async function pkg_executables(opts: { name: string }): Promise<string[] | null> {
    try {
        const { stdout } = await commandRunner.exec(`ros2 pkg executables ${opts.name}`);
        return splitLines(stdout)
            .map((line) => line.split(/\s+/))
            .filter((parts) => parts.length >= 2)
            .map((parts) => parts[1]);
    } catch (error) {
        log.error(l10n.t("ros2 pkg executables {0} failed: {1}", opts.name, errMsg(error)));
        return null;
    }
}

/** ros2 pkg executables --full-path <name> → 安装侧绝对路径列表(官方 verb:--full-path 每行一个纯路径) */
async function pkg_executables_full(opts: { name: string }): Promise<string[] | null> {
    try {
        const { stdout } = await commandRunner.exec(`ros2 pkg executables --full-path ${opts.name}`);
        return splitLines(stdout)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
    } catch (error) {
        log.error(l10n.t("ros2 pkg executables --full-path {0} failed: {1}", opts.name, errMsg(error)));
        return null;
    }
}

/** ros2 interface list → 每行一个接口名(含分组标题,消费方自行过滤) */
async function interface_list(_opts?: {}): Promise<string[] | null> {
    try {
        const { stdout } = await commandRunner.exec("ros2 interface list");
        return splitLines(stdout);
    } catch (error) {
        log.error(l10n.t("ros2 interface list failed: {0}", errMsg(error)));
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

/** ros2 param list <node> → 参数名列表(过滤 "/" 开头系统参数与 ":" 结尾分组) */
async function param_list(opts: { node: string }): Promise<string[] | null> {
    try {
        const { stdout } = await commandRunner.exec(`ros2 param list ${opts.node}`);
        return splitLines(stdout)
            .filter((line) => !line.startsWith("/") && !line.endsWith(":"));
    } catch (error) {
        log.error(l10n.t("ros2 param list {0} failed: {1}", opts.node, errMsg(error)));
        return null;
    }
}

/** ros2 param get <node> <param> → 值文本(形如 "Integer value is: 10") */
async function param_get(opts: { node: string; param: string }): Promise<string | null> {
    try {
        const { stdout } = await commandRunner.exec(`ros2 param get ${opts.node} ${opts.param}`);
        return stdout.trim();
    } catch (error) {
        log.error(l10n.t("ros2 param get {0} {1} failed: {2}", opts.node, opts.param, errMsg(error)));
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/** ros2 lifecycle nodes → 节点名列表(过滤 ros2cli 提示行) */
async function lifecycle_nodes(_opts?: {}): Promise<string[] | null> {
    try {
        const { stdout } = await commandRunner.exec("ros2 lifecycle nodes");
        return splitLines(stdout).filter((line) => !line.startsWith("ros2cli"));
    } catch (error) {
        log.error(l10n.t("ros2 lifecycle nodes failed: {0}", errMsg(error)));
        return null;
    }
}

/** ros2 lifecycle get <node> → 状态(输出形如 "unconfigured [1]",按标签前缀匹配);未知状态/失败 → null */
async function lifecycle_get(opts: { node: string }): Promise<LifecycleState | null> {
    try {
        const { stdout } = await commandRunner.exec(`ros2 lifecycle get ${opts.node}`);
        const stateLabel = stdout.trim();
        for (const state of LIFECYCLE_STATES) {
            if (stateLabel.toLowerCase().startsWith(state.label)) {
                return state;
            }
        }
        log.warn(l10n.t("Unknown lifecycle state: {0}", stateLabel));
        return null;
    } catch (error) {
        log.error(l10n.t("ros2 lifecycle get {0} failed: {1}", opts.node, errMsg(error)));
        return null;
    }
}

/** ros2 lifecycle set <node> <transition 标签>;失败(含节点拒绝转换)reject 上抛。
 *  重设计阶段 2 自数字 id 改标签:标签拒绝=非零退出码(2026-10-06 VM 实机验证)。
 *  前缀 `timeout 35s`(POSIX)堵 F5 孤儿洞:阻塞转换 >30s 时,若 exthost 恰好重载,
 *  JS 超时定时器随之死亡,shell+CLI 全孤儿=永久僵尸 ROS 参与者;`timeout` 作为孤儿
 *  依然存活并在 35s 处决 CLI(exthost 活着时 exec 的 30s 进程组击杀先到,不依赖它)。 */
async function lifecycle_set(opts: { node: string; transition: string }): Promise<void> {
    const guard = process.platform === "win32" ? "" : "timeout 35s ";
    await commandRunner.exec(`${guard}ros2 lifecycle set ${opts.node} ${opts.transition}`);
}

/* ------------------------------------------------------------------ */
/* colcon 查询                                                         */
/* ------------------------------------------------------------------ */

/**
 * colcon list → 包条目(name + path)。
 * - packages_only(true):加 -p,输出每行一个路径,包名取路径 basename;
 * - 常规模式:每行 "name path"(tab/空格分隔),取前两段;
 * --log-base 指向 nul//dev/null,避免 colcon 日志污染工作区(与旧实现一致)。
 */
async function colcon_list(opts?: { base_path?: string; packages_only?: boolean }): Promise<PackageEntry[] | null> {
    const nullPath = process.platform === "win32" ? "nul" : "/dev/null";
    const packagesOnly = opts?.packages_only ?? false;
    let command = `colcon --log-base ${nullPath} list`;
    if (packagesOnly) {
        command += " -p";
    }
    if (opts?.base_path) {
        command += ` --base-paths "${opts.base_path}"`;
    }
    // colcon list 输出路径相对 base path(未给 base_path 时相对进程 cwd),可能为相对形态;
    // 统一绝对化——PackageEntry.dir 契约=工作区包绝对路径,与 walk 画像/下游 === 匹配一致
    // (2026-09-08 与 package-core/scan/colcon-list.ts 同源修复)。
    const resolveBase = opts?.base_path ?? process.cwd();
    try {
        const { stdout } = await commandRunner.exec(command);
        if (packagesOnly) {
            return splitLines(stdout).map((p) => ({ name: path.basename(p), path: path.resolve(resolveBase, p) }));
        }
        const entries: PackageEntry[] = [];
        for (const line of splitLines(stdout)) {
            const parts = line.split(/\s+/);
            if (parts.length >= 2) {
                entries.push({ name: parts[0], path: path.resolve(resolveBase, parts[1]) });
            }
        }
        return entries;
    } catch (error) {
        log.error(l10n.t("colcon list failed: {0}", errMsg(error)));
        return null;
    }
}

/** Ros2ServiceApi 实现对象(组合根注入用;接口定义在 api/ros2-service-api.ts) */
export const ros2ServiceApi: Ros2ServiceApi = {
    pkg_list,
    pkg_prefix,
    pkg_executables,
    pkg_executables_full,
    interface_list,
    param_list,
    param_get,
    lifecycle_nodes,
    lifecycle_get,
    lifecycle_set,
    colcon_list,
};
