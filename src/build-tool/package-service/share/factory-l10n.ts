// Licensed under the MIT License.

/**
 * @file factory-l10n.ts(2026-10-07 方案A+C)
 * 模板机制(2026-10-17 两拆分后的 template/presets,旧 shareSpec)出厂文案的**显示本地化门卫**:值相等判定 + ID 键查表——"接缝撞库缺陷"的根治。
 *
 * ── 为什么需要门卫(缺陷史)─────────────────────────────────────────
 * `custom`/`describe` 是**用户可编辑的设置值**而非代码字面量。cdf29de 曾按"整值查册"
 * (`l10n.t(值)`)渲染:用户自定义值只要恰好等于册里任何一条键(如 `Copied`),zh-cn
 * 环境就会显示那条无关键的中文译文——用户数据被静默改写显示(用户 2026-10-05 指出)。
 * 且对账工具只认 `l10n.t(字面量)`,变量首参看不见 ⇒ 7ee7ce4 死键清账把这 5 条出厂键
 * 当死键清除,zh-cn 环境出厂描述退回英文(用户 2026-10-07 截图实测)。
 *
 * ── 方案 A+C(用户 2026-10-07 拍板)────────────────────────────────
 * · A **值相等门卫**:只有与出厂常量逐字节相等的值才进翻译,其余一律原样透传
 *   (存储永不改写;用户手打出厂原文会命中本地化——语义等价,可接受);
 * · C **ID 键命名空间**:册键用稳定 ID(`factory.*`),不用英文原文当键——构造上
 *   不可能与其他册键撞车,出厂文案将来改版也不产生孤儿键;
 * · 英文兜底:en 环境/无头测试宿主下 `l10n.t(ID)` 原样返回 ID 本身,此时回落出厂
 *   英文常量(= 源语言兜底,测试断言口径因此仍是英文源串,零影响)。
 *
 * ⚠️ factory.* 键的存活由 scripts/i18n_audit.py 从本表提取认定(变量首参对字面扫描
 * 不可见),手工删册会在下次 zh-cn 构建后复发"出厂描述显英文"。
 */

import * as vscode from "vscode";

import { COLCON_BUILD_PRESETS, COLCON_BUILD_SPEC } from "./defaults/colcon-build";
import { ROS2_LAUNCH_SPEC } from "./defaults/ros2-launch";
import { ROS2_RUN_SPEC } from "./defaults/ros2-run";
import type { CommandSpec } from "./types";

/** 一条出厂文案:稳定册键 ↔ 出厂英文值(值引用 defaults 常量,不在此复制,防两处漂移) */
interface FactoryEntry {
    readonly key: string;
    readonly value: string;
}

/**
 * 出厂文案全表(**2026-10-20 用户裁定澄清 + 2026-10-21 升格条目级判定**):
 * 0 号位 `custom`/`customHint` 各 3 条(标量字段各自严格相等)+ colcon build 两条出厂槽位描述
 * (槽位描述的翻译资格由 `presetLabel` 按**条目**判定:同槽位 + argv + describe 逐字段相等;
 * 任一字段改过/槽位错放/用户新增 → 用户配置,原样显示)。
 */
const FACTORY_ENTRIES: readonly FactoryEntry[] = [
    { key: "factory.build.custom", value: COLCON_BUILD_SPEC.custom },
    { key: "factory.build.customHint", value: COLCON_BUILD_SPEC.customHint ?? "" },
    { key: "factory.build.presetDebugLog", value: COLCON_BUILD_PRESETS[0].describe },
    { key: "factory.build.presetConsoleCohesion", value: COLCON_BUILD_PRESETS[1].describe },
    { key: "factory.launch.custom", value: ROS2_LAUNCH_SPEC.custom },
    { key: "factory.launch.customHint", value: ROS2_LAUNCH_SPEC.customHint ?? "" },
    { key: "factory.run.custom", value: ROS2_RUN_SPEC.custom },
    { key: "factory.run.customHint", value: ROS2_RUN_SPEC.customHint ?? "" },
];

/**
 * 模板机制 0 号行出厂值的**显示翻译**(pick-preset 渲染点专用;值 = custom 描述 /
 * customHint 占位提示标量):与任一出厂常量逐字节相等 → 查 `factory.*` ID 键
 * (查不到键/英文环境回落出厂英文);其余值(用户自定义)一律原样透传,永不进查册。
 */
export function factoryText(value: string): string {
    const entry = FACTORY_ENTRIES.find((candidate) => candidate.value === value);
    if (!entry) {
        return value;
    }
    const translated = vscode.l10n.t(entry.key);
    return translated === entry.key ? entry.value : translated;
}

/**
 * 槽位预设标签的显示文本(**2026-10-21 用户裁定:条目级严格判定**;pick-preset 渲染点专用)。
 *
 * 判定单位 = **条目**,且槽位一一对应(0 匹配 0、1 匹配 1、2 匹配 2):
 * 条目是出厂配置 ⟺ 出厂规格**同一槽位**上存在 `argv` 与 `describe` **都逐字节相等**的备选。
 * 只细微修改 Key(describe)或 Value(argv)任意一个 ⇒ 不是出厂配置 = 用户配置 ⇒ 整条原样显示;
 * 照抄 0 号描述的形态天然出局(其 argv 对不上任何出厂备选);`factory` 缺省(无头/未传)⇒ 原样。
 */
export function presetLabel(
    choice: { slot: number; argv: string; describe: string },
    factory?: CommandSpec
): string {
    if (factory === undefined) {
        return choice.describe;
    }
    const item = factory.argv_list?.[choice.slot - 1];
    const alternatives: readonly { argv?: unknown; describe?: unknown }[] = Array.isArray(item)
        ? item
        : item
            ? [item]
            : [];
    const isFactory = alternatives.some(
        (alt) => alt && alt.argv === choice.argv && alt.describe === choice.describe
    );
    return isFactory ? factoryText(choice.describe) : choice.describe;
}
