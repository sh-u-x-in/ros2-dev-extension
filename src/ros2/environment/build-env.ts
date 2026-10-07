// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file build-env.ts(2026-09-22 新增)
 * "构建专用环境":从当前 env 快照中**剔除本工作区自身的条目**,供 `colcon build` 使用。
 *
 * ── 为什么需要 ───────────────────────────────────────────────────
 * 环境快照(`env-collect`)按设计 source 了 `<ws>/install/setup.bash` —— 这对 **intellisense / 调试 / 运行**
 * 是必需的(要 overlay),但 **构建不需要自己的工作区 overlay**:
 *  · 把本工作区 install 带进构建 env ⇒ `colcon-override-check` 报
 *    "Some selected packages are already built in one or more underlay workspaces"(自我覆盖);
 *  · 更实际的风险:CMake 可能**先从旧 install 找到头文件/库**(include 顺序),以及 install 的陈旧载荷被判定
 *    `Up-to-date` 而跳过(实体↔符号切换的"静默无效"由此放大,见知识文档 §2.2);
 *  · 工作区**内部**的依赖解析由 colcon 按拓扑顺序自行注入各包前缀完成,不依赖 source 本工作区
 *    (这正是标准 `colcon build` 流程——干净终端里 `colcon build` 也能编全工作区)。
 * ⇒ 构建时只保留**真正的 underlay**:系统(`/opt/ros/<distro>`)+ 其它被依赖的工作区。
 *
 * ── 边界(改这里必须守住)────────────────────────────────────────
 *  1. **只剔"本工作区根之下"的条目**(复用 `env-compare.isWorkspaceEntry`,与外部环境判定同一口径);
 *     **其它工作区/系统的一律保留**(否则会真的缺依赖 —— 那才是饮鸩止渴);
 *  2. 只处理**已知路径型变量白名单**(不做"所有字符串都按分隔符拆"的盲处理),外加少量已知标量前缀变量;
 *  3. 过滤后为空的变量**整键删除**(不留空串),避免工具把空值当成"配置了一个空前缀";
 *  4. 分隔符取 `path.delimiter`(POSIX `:` / Windows `;`);
 *  5. 纯函数 + 一次浅拷贝,**不修改快照本身**(运行/调试用的 `getEnv()` 保持原样)。
 */

import * as path from "path";

import { getWorkspaceRoot } from "../host/fs";
import { isWorkspaceEntry } from "./env-compare";
import * as state from "./state";

/** 按路径分隔符拆分、需要剔除本工作区条目的变量(构建环境) */
export const BUILD_ENV_PATH_KEYS: readonly string[] = [
    // ROS 前缀链(override 警告与 find_package 的主因)
    "AMENT_PREFIX_PATH",
    "COLCON_PREFIX_PATH",
    "CMAKE_PREFIX_PATH",
    // 运行期路径
    "PATH",
    "LD_LIBRARY_PATH",
    "PYTHONPATH",
    "PKG_CONFIG_PATH",
    "CMAKE_MODULE_PATH",
    // 仿真资源(常被工作区 install 注入)
    "GAZEBO_MODEL_PATH",
    "GAZEBO_PLUGIN_PATH",
    "IGN_GAZEBO_RESOURCE_PATH",
    "IGN_GAZEBO_SYSTEM_PLUGIN_PATH",
];

/** 单值型前缀变量:值落在本工作区内 → 整键删除(避免指向本工作区 install) */
export const BUILD_ENV_SCALAR_KEYS: readonly string[] = ["AMENT_CURRENT_PREFIX"];

/**
 * 把一份环境快照过滤成"构建专用环境"(纯函数,可无头单测):
 *  · 未提供环境 / 工作区根为空 → 原样浅拷贝;
 *  · 路径型变量:逐条目剔除"本工作区之下"的条目;过滤后为空 → 删键;
 *  · 标量前缀变量:值落在本工作区内 → 删键;
 *  · 其它变量:原样保留。
 * 分隔符与大小写/反斜杠问题统一交给 `env-compare.isWorkspaceEntry`(2026-09-22 起平台无关)。
 */
export function stripWorkspaceEntries(
    env: Record<string, string> | undefined,
    workspaceRoot: string,
): Record<string, string> {
    const out: Record<string, string> = {};
    if (!env) {
        return out;
    }
    if (workspaceRoot.length === 0) {
        return { ...env };
    }
    const sep = path.delimiter;
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") {
            continue; // 环境快照理论上全是字符串;非字符串直接丢弃
        }
        if (BUILD_ENV_SCALAR_KEYS.includes(key)) {
            if (!isWorkspaceEntry(value, workspaceRoot)) {
                out[key] = value;
            }
            continue;
        }
        if (!BUILD_ENV_PATH_KEYS.includes(key)) {
            out[key] = value;
            continue;
        }
        const kept = value
            .split(sep)
            .filter((entry) => entry.length > 0 && !isWorkspaceEntry(entry, workspaceRoot));
        if (kept.length > 0) {
            out[key] = kept.join(sep);
        }
    }
    return out;
}

/**
 * 构建专用 env(由当前快照派生):
 * 未采集到环境时返回 `undefined`(与 `getEnv()` 语义一致,调用方的环境门槛会先行拦截)。
 */
export function getBuildEnv(): Record<string, string> | undefined {
    const env = state.getEnv() as Record<string, string> | undefined;
    if (!env) {
        return undefined;
    }
    return stripWorkspaceEntries(env, getWorkspaceRoot() ?? "");
}
