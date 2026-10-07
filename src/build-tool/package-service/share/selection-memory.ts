// Licensed under the MIT License.

/**
 * @file selection-memory.ts(2026-09-22 新增)
 * **选择记忆**:把"上次二级弹窗里选了什么"记下来,供下次默认预选。
 * 与具体命令无关(按**命令 id** 分槽),`colcon build` 是第一个使用者;`ros2 run` / `ros2 launch` 可直接复用。
 *
 * ── 只记"选择",且自定义输入记**完整内容** ─────────────────────────
 * 记忆 = `{ picked: number[], custom: string }`:
 *  · `picked` = 勾选的预设下标(0 基;读取时过滤非法项、去重、升序);
 *  · `custom` = 自定义输入的**完整原文**(不 trim、不截断 —— 下次原样回填输入框)。
 *
 * ── 存储(复用工作区状态文件)──────────────────────────────────────
 * 写进 `.vscode/ros2-dev-extension-state.json` 的 `selectionMemory` 字段,形状是"命令 id → 记忆":
 * ```json
 * { "selectionMemory": { "colcon.build": { "picked": [0, 1], "custom": "--force" } } }
 * ```
 * 读写一律经 `./state-file.ts`(单写者队列 + 原子覆盖),且**只动自己这层键** ⇒
 * 其它命令的记忆、以及其它域拥有的字段都不会被覆盖。
 *
 * 本模块不依赖 vscode(只依赖状态文件层与 logger)⇒ 可无头单测。
 */

import { l10n } from "vscode";

import { getLogger } from "../../../logger";

import { readStateFile, updateStateFile } from "./state-file";

/** selection-memory 模块日志 */
const log = getLogger("selection-memory");

/** 状态文件里的字段名(多命令共用一个字典:命令 id → 该命令的选择记忆) */
export const SELECTION_MEMORY_FIELD = "selectionMemory";

/** 一条命令的"上次选择" */
export interface SelectionMemory {
    /** 勾选的预设下标(0 基;读取时:非法项丢弃、去重、升序) */
    picked: number[];
    /** 自定义输入的完整内容(空串 = 上次没输入;原样保存,不做 trim) */
    custom: string;
}

/** 空记忆(读取不到 / 形状不对时的返回值;每次新建,避免被就地修改) */
export function emptySelectionMemory(): SelectionMemory {
    return { picked: [], custom: "" };
}

/**
 * 归一化任意输入 → 合法记忆(纯函数):非对象 → 空;`picked` 过滤非整数/负数、去重、升序;`custom` 非字符串 → 空。
 */
export function normalizeSelectionMemory(raw: unknown): SelectionMemory {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return emptySelectionMemory();
    }
    const obj = raw as { picked?: unknown; custom?: unknown };
    const picked = Array.isArray(obj.picked)
        ? obj.picked.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0)
        : [];
    return {
        picked: [...new Set(picked)].sort((a, b) => a - b),
        custom: typeof obj.custom === "string" ? obj.custom : "",
    };
}

/** 从状态数据里取出"命令 id → 记忆"这一层(非法形状一律当空字典) */
function readMemoryMap(data: Record<string, unknown>): Record<string, unknown> {
    const map = data[SELECTION_MEMORY_FIELD];
    return map && typeof map === "object" && !Array.isArray(map)
        ? { ...(map as Record<string, unknown>) }
        : {};
}

/** 读一条命令的选择记忆(读不到 → 空记忆) */
export async function readSelectionMemory(workspaceRoot: string, commandId: string): Promise<SelectionMemory> {
    const data = await readStateFile(workspaceRoot);
    const memory = normalizeSelectionMemory(readMemoryMap(data)[commandId]);
    log.debug(l10n.t("Selection memory read [{0}]: presets [{1}]{2}", commandId, memory.picked.join(","), memory.custom.length > 0 ? l10n.t(" + custom input") : ""));
    return memory;
}

/** 读全部命令的记忆(诊断/调试用;形状已归一化) */
export async function readAllSelectionMemory(workspaceRoot: string): Promise<Record<string, SelectionMemory>> {
    const data = await readStateFile(workspaceRoot);
    const out: Record<string, SelectionMemory> = {};
    for (const [commandId, raw] of Object.entries(readMemoryMap(data))) {
        out[commandId] = normalizeSelectionMemory(raw);
    }
    return out;
}

/**
 * 写一条命令的选择记忆(**只改这一条键**:同层其它命令、以及其它域字段原样保留)。
 * 写失败静默降级(由 state-file 层保证)。
 */
export async function writeSelectionMemory(
    workspaceRoot: string,
    commandId: string,
    memory: SelectionMemory,
): Promise<void> {
    const normalized = normalizeSelectionMemory(memory);
    await updateStateFile(workspaceRoot, (draft) => {
        const map = readMemoryMap(draft);
        map[commandId] = normalized;
        draft[SELECTION_MEMORY_FIELD] = map;
    });
    log.debug(l10n.t("Selection memory written [{0}]: presets [{1}]{2}", commandId, normalized.picked.join(","), normalized.custom.length > 0 ? l10n.t(" + custom input") : ""));
}
