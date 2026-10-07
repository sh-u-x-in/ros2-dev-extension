/**
 * rosmsg 消息索引共享类型与载荷纯函数。
 * 常量 / 条目类型 / 磁盘缓存格式 + workspace 缓存载荷转换（单测直接 import）。
 *
 * 2026-09-13 重构（rosmsg-v3.md）：工作区缓存换成【正表快照】格式（v4）——
 * 反表由正表重建、包表不落盘（启动后由 PackageMap 快照重建）；旧「包 → 条目 Map」格式作废。
 */
import type { PkgRow, TablesSnapshot } from "./tables";
import { tablesFromPkgRows } from "./tables";

// 严格只扫描 .msg 消息:rosidl 中字段类型只能是内置或 msg(srv/action 不能作为字段类型,
// 亦无嵌套),纳入 srv/action 只会让补全出现不该有的条目
export const MSG_GLOB = "**/*.msg";
export const CACHE_VERSION = 5;            // v5(2026-09-25 RM-1):系统索引增带路径登记(pkgMsgFiles/pkgMsgDirs);v4(2026-09-03 R1)键剥 msg/ 段
export const WORKSPACE_CACHE_VERSION = 4;   // v4(2026-09-13 三张表重构):正表快照 [[包名, [[名, 路径]...]]...](含非法包哨兵行)
export const WORKSPACE_CACHE_WRITE_DEBOUNCE_MS = 500;    // 工作区缓存写盘防抖

/** 单个消息类型条目 */
export interface RosInterfaceEntry {
    /** 包名(合法=package.xml 真实名;非法=目录路径) */
    pkg: string;
    /** 消息名(不含扩展名) */
    name: string;
    /** 数据来源 */
    source: "workspace" | "system" | "common";
    /** 定义文件路径(仅工作区来源有) */
    path?: string;
    /** 非法位置(无 package.xml 的散乱文件)标记:按纯路径归类,与合法包隔离 */
    loose?: boolean;
}

/** 磁盘缓存格式:系统消息为有序 "pkg/Name" 数组(RM-1 增带路径登记) */
export interface SystemCacheFile {
    version: number;
    updatedAt: number;
    /** 有序 "pkg/Name" 列表(字典序,可直接前缀二分) */
    interfaces: string[];
    /** RM-1 带路径懒登记:包 → share/<pkg>/msg 下已登记的 .msg 文件名(不含扩展名) */
    pkgMsgFiles?: Record<string, string[]>;
    /** RM-1:包 → 接口目录绝对路径(与 pkgMsgFiles 同批登记;路径重建用) */
    pkgMsgDirs?: Record<string, string>;
}

/** 工作区缓存格式(独立于系统缓存,按工作区隔离;v4 = 正表快照) */
export interface WorkspaceCacheFile {
    version: number;
    /** 缓存所属工作区根路径(防跨工作区误用) */
    workspaceRoot: string;
    updatedAt: number;
    /** 正表快照:[包名, [[消息名, 消息路径]...]][](含非法包哨兵行;反表由它重建) */
    pkgRows: Array<[string, Array<[string, string]>]>;
}

/** 正表行 → 缓存载荷(纯函数,供单测) */
export function workspaceCacheToPayload(pkgRows: readonly PkgRow[], workspaceRoot: string): WorkspaceCacheFile {
    return {
        version: WORKSPACE_CACHE_VERSION,
        workspaceRoot,
        updatedAt: Date.now(),
        pkgRows: pkgRows.map((r) => [r.pkg, r.entries.map((m) => [m.name, m.path])]),
    };
}

/** 缓存载荷 → 两张表快照(纯函数,供单测);版本不符/形态不符返回 undefined */
export function workspaceCacheFromPayload(payload: WorkspaceCacheFile | undefined): TablesSnapshot | undefined {
    if (!payload || payload.version !== WORKSPACE_CACHE_VERSION || !Array.isArray(payload.pkgRows)) {
        return undefined;
    }
    return tablesFromPkgRows(payload.pkgRows);
}