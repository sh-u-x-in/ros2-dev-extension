// Licensed under the MIT License.

/**
 * @file factory-l10n.ts(2026-10-07 方案A+C)
 * shareSpec 出厂文案的**显示本地化门卫**:值相等判定 + ID 键查表——"接缝撞库缺陷"的根治。
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

/** 一条出厂文案:稳定册键 ↔ 出厂英文值(值引用 defaults 常量,不在此复制,防两处漂移) */
interface FactoryEntry {
    readonly key: string;
    readonly value: string;
}

/**
 * 出厂文案全表:3 条 `custom`(colcon build / ros2 run / ros2 launch)+ 2 条预设
 * `describe`(colcon build 的"详细输出"两半);与 manifest default 由同步锁用例
 * (share-spec.test.ts)保障一致。
 */
const FACTORY_ENTRIES: readonly FactoryEntry[] = [
    { key: "factory.build.custom", value: COLCON_BUILD_SPEC.custom },
    { key: "factory.build.presetDebugLog", value: COLCON_BUILD_PRESETS[0].describe },
    { key: "factory.build.presetLogCommand", value: COLCON_BUILD_PRESETS[1].describe },
    { key: "factory.launch.custom", value: ROS2_LAUNCH_SPEC.custom },
    { key: "factory.run.custom", value: ROS2_RUN_SPEC.custom },
];

/**
 * shareSpec 值的**显示翻译**(pick-preset 渲染点专用):
 * 与任一出厂常量逐字节相等 → 查 `factory.*` ID 键(查不到键/英文环境回落出厂英文);
 * 其余值(用户自定义)一律原样透传,永不进查册。
 */
export function factoryText(value: string): string {
    const entry = FACTORY_ENTRIES.find((candidate) => candidate.value === value);
    if (!entry) {
        return value;
    }
    const translated = vscode.l10n.t(entry.key);
    return translated === entry.key ? entry.value : translated;
}
