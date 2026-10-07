// Licensed under the MIT License.

/**
 * @file pick-preset.ts
 * 通用「二级参数弹窗」:预设**与用户平级**(整份 spec 都在设置里,用户可把预设全删干净),
 * 因此二级弹窗有**三种形态** ——
 *
 *  | 模板含 `${0}` | 预设条数 | 形态 | 行为 |
 *  |:--|:--|:--|:--|
 *  | 否 | 0 | `none` | **完全不弹**:没有任何占位符要填,直接构建 |
 *  | 是 | 0 | `input-only` | **直接弹手动输入框**(跳过列表);**Esc = 取消本次流程**;空输入回车 = 不加参数继续 |
 *  | 其余 | — | `list` | 弹多选列表(第 1 项 `自定义输入`,选中后追加输入框);**Esc 一律 = 取消本次流程**(列表 Esc、输入框 Esc 都是);输入框空串回车 = 不加自定义、其余勾选照用 |
 *
 * 与具体命令无关 —— `colcon build` / `ros2 run` / `ros2 launch` / `ros2 test` 复用同一个组件,
 * 调用方只需要提供自己的 `CommandSpec`(用户裁定 Q1:多选;描述显示为弹窗项的描述)。
 *
 * 本文件与 `factory-l10n.ts`(出厂文案显示门卫)是 `share/` 里仅有的 vscode 依赖
 * (纯 UI 壳,不含任何命令逻辑);展开算法在 `expand.ts`(纯函数)。
 */

import * as vscode from "vscode";

import { getLogger } from "../../../logger";
import { usesCustomPlaceholder } from "./expand";
import { factoryText } from "./factory-l10n";
import { flattenArgList, hasArgChoices } from "./expand";
import type { CommandSpec } from "./types";

/** pick-preset 模块日志 */
const log = getLogger("pick-preset");

/** 自定义输入项的固定 label(列表形态下恒为第一项) */
export const CUSTOM_ITEM_LABEL = vscode.l10n.t("Custom input");

/** 二级弹窗的形态(见文件头表格) */
export type PresetPickPlan = "none" | "input-only" | "list";

/**
 * 判定二级弹窗该走哪种形态(纯函数,便于单测):
 * 预设"跟用户平级"⇒ 用户可以一条不剩;模板也可以不用 `${0}` ⇒ 于是**根本不需要第二级**。
 */
export function presetPickPlan(spec: CommandSpec): PresetPickPlan {
    const hasCustom = usesCustomPlaceholder(spec.template);
    const hasPresets = hasArgChoices(spec.argv_list);
    if (!hasCustom && !hasPresets) {
        return "none";
    }
    if (hasCustom && !hasPresets) {
        return "input-only";
    }
    return "list";
}

/** 二级弹窗的返回(取消 = undefined,由调用方区分"取消"与"没勾任何东西") */
export interface PresetPick {
    /** 自定义输入内容;未勾选或输入框被取消 → undefined */
    custom?: string;
    /** 勾选的备选**平坦下标**(0 基,升序;展平顺序 = 槽号升序、槽内按表内先后) */
    picked: number[];
}

/**
 * 构造弹窗项(纯函数,便于单测/复用):
 * **仅当模板用到 `${0}` 时**,第 1 项才是「自定义输入」(用户裁定:模板里没有 `${0}` 就不弹);
 * 其后是**展平后的每条备选**(同槽的多条备选会并排列出);`describe` 作 label、`argv` 作 description、
 * `detail` 标注它填哪个槽(如"→ 填入 `${3}`"),让用户看清"这几条是同一个槽的备选"。
 */
export function makePresetItems(
    spec: CommandSpec,
    remembered?: { picked?: readonly number[]; custom?: boolean },
): PresetItem[] {
    const picked = new Set(remembered?.picked ?? []);
    const items: PresetItem[] = [];
    if (usesCustomPlaceholder(spec.template)) {
        items.push({
            label: CUSTOM_ITEM_LABEL,
            description: factoryText(spec.custom),
            picked: remembered?.custom ?? false,
            isCustom: true,
        });
    }
    for (const choice of flattenArgList(spec.argv_list)) {
        items.push({
            label: choice.describe.length > 0 ? factoryText(choice.describe) : choice.argv,
            description: choice.argv,
            detail: vscode.l10n.t("-> fills {0}", "${" + choice.slot + "}"),
            picked: picked.has(choice.index),
            presetIndex: choice.index,
        });
    }
    return items;
}

/**
 * 弹窗项:带内部标记(第 1 项 = 自定义输入;其余带 `presetIndex`)。
 * 用标记而不是"label 反查"——`describe` 允许重复,反查会串位。
 */
export interface PresetItem extends vscode.QuickPickItem {
    /** 是否为「自定义输入」项 */
    isCustom?: boolean;
    /** 预设下标(0 基) */
    presetIndex?: number;
}

/** 二级弹窗的可选参数 */
export interface PickPresetOptions {
    /** 弹窗标题 */
    title?: string;
    /** 弹窗占位提示 */
    placeholder?: string;
    /** 自定义输入框的标题(缺省 = 弹窗标题) */
    customTitle?: string;
    /** 自定义输入框的占位提示 */
    customPlaceholder?: string;
    /** 预填的自定义输入(如上次输入) */
    customValue?: string;
    /** 默认勾选(记忆) */
    remembered?: { picked?: readonly number[]; custom?: boolean };
}

/**
 * 弹出二级参数输入(按 `presetPickPlan` 自动选择"不弹 / 只弹输入框 / 弹多选列表")。
 * 返回 `undefined` 表示**用户取消**(调用方应中止本次流程);返回对象(可能为空)表示可以继续。
 */
export async function pickPresets(
    spec: CommandSpec,
    options: PickPresetOptions = {},
): Promise<PresetPick | undefined> {
    const plan = presetPickPlan(spec);

    // 形态 ①:没有任何占位符要填(预设被删干净 + 模板不用 ${0})⇒ 完全不弹
    if (plan === "none") {
        log.debug("Second stage: no presets and the template has no custom placeholder -> no second stage");
        return { picked: [] };
    }

    // 形态 ②:只有自定义输入 ⇒ 直接跳输入框
    if (plan === "input-only") {
        log.debug("Second stage: custom input only -> input box shown directly");
        const value = await vscode.window.showInputBox({
            title: options.customTitle ?? options.title,
            prompt: factoryText(spec.custom),
            placeHolder: options.customPlaceholder,
            value: options.customValue ?? "",
        });
        if (value === undefined) {
            log.trace("Second stage: manual input cancelled (aborting this flow)");
            return undefined;
        }
        if (value.trim().length === 0) {
            log.trace("Second stage: manual input empty; continuing without arguments");
            return { picked: [] };
        }
        return { custom: value, picked: [] };
    }

    // 形态 ③:列表(第 1 项自定义输入 + 预设多选)
    const selected = await vscode.window.showQuickPick(makePresetItems(spec, options.remembered), {
        canPickMany: true,
        title: options.title,
        placeHolder: options.placeholder,
    });
    if (!selected) {
        log.trace("Second-stage dialog: user cancelled");
        return undefined;
    }

    const picked: number[] = [];
    let wantsCustom = false;
    for (const item of selected) {
        if (item.isCustom) {
            wantsCustom = true;
            continue;
        }
        if (typeof item.presetIndex === "number") {
            picked.push(item.presetIndex);
        }
    }
    picked.sort((a, b) => a - b);

    let custom: string | undefined;
    if (wantsCustom) {
        const value = await vscode.window.showInputBox({
            title: options.customTitle ?? options.title,
            prompt: factoryText(spec.custom),
            placeHolder: options.customPlaceholder,
            value: options.customValue ?? "",
        });
        if (value === undefined) {
            // Esc 一律 = 取消(与列表 Esc、input-only 的 Esc 同一语义);空串回车才是"不追加,继续"
            log.trace("Second-stage dialog: custom input cancelled (aborting this flow)");
            return undefined;
        }
        if (value.trim().length > 0) {
            custom = value;
        } else {
            log.trace("Second-stage dialog: custom input empty; nothing appended (other checks still applied)");
        }
    }

    log.debug(vscode.l10n.t("Second-stage dialog: {0} presets checked{1}", picked.length, custom ? vscode.l10n.t(" + custom input") : ""));
    return { custom, picked };
}
