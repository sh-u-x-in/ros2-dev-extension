// Licensed under the MIT License.

/**
 * @file build-memory.ts(2026-09-22 自 build/ 上移进 share/:与"记忆"相关的模块统一收在共享层)
 * **包选择记忆**(仅 build 域使用):上次勾选的包 + 上次全部包名快照,供弹窗默认预选。
 *
 * ⚠️ 二级参数(预设/自定义输入)的选择**不在这里** —— 那部分由通用记忆模块
 * `selection-memory.ts` 负责(按命令 id 分槽,run/launch 将来复用同一份记忆文件)。
 * 落盘位置与并发/原子性一律交给 `state-file.ts`(本文件只认识自己的 2 个字段)。
 */

import { l10n } from "vscode";

import { getLogger } from "../../../logger";

import { readStateFile, updateStateFile } from "./state-file";

/** 扩展日志薄封装(带 build-memory 模块前缀) */
const log = getLogger("build-memory");

/**
 * 构建状态记忆(状态文件里属于本模块的 2 个字段:**只记"包"的选择**)。
 */
export interface BuildState {
    /** 上次勾选的包名列表(空数组表示默认全选) */
    buildPackages: string[];
    /**
     * 上次保存时的全部包名快照:用于识别"新出现的包"——新包默认勾选(用户从未对其做过排除选择)。
     * 非可选:readBuildState 恒返回数组(形状不对 → 空数组 = 默认全选),消费方无需判 undefined。
     */
    knownPackages: string[];
}

/**
 * 读取构建状态记忆;文件不存在 / 损坏 / 字段形状不对时逐字段回退默认值。
 */
export async function readBuildState(workspaceRoot: string): Promise<BuildState> {
    log.debug(l10n.t("Reading build state memory: {0}", workspaceRoot));
    const parsed = await readStateFile(workspaceRoot);
    return {
        buildPackages: Array.isArray(parsed.buildPackages) ? parsed.buildPackages : [],
        knownPackages: Array.isArray(parsed.knownPackages) ? parsed.knownPackages : [],
    };
}

/**
 * 写入构建状态记忆:经 updateStateFile 只改本模块的字段,
 * 状态文件里其它写者的字段(含 `selectionMemory` 记忆模块的槽)原样保留,且并发写不会互相覆盖。
 * 写失败静默降级(见 state-file.ts)。
 */
export async function writeBuildState(workspaceRoot: string, state: BuildState): Promise<void> {
    log.debug(l10n.t("Writing build state memory: {0} packages", state.buildPackages.length));
    await updateStateFile(workspaceRoot, (draft) => {
        draft.buildPackages = state.buildPackages;
        draft.knownPackages = state.knownPackages;
    });
}
