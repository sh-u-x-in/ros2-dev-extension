// Licensed under the MIT License.

/**
 * @file defaults/colcon-build.ts
 * `colcon build` 的**出厂默认(种子)** + 「今天的选项 → 命名动态参数」纯映射。
 *
 * ── 两轴改由**设置**接管(2026-09-22 用户裁定)──────────────────────
 * 「安装形式(符号/实体)」与「工作空间布局(合并/分包)」不再做成一堆交叉预设,而是**两个独立变量**:
 * `${install_method}`(来自 `ROS2.build.installMethod`)与 `${install_layout}`
 * (来自 `ROS2.build.installLayout`,经 `resolveInstallType()` 还原成两轴)。
 * ⇒ 4 条交叉预设与 `seedIndexForAxes()` **整体删除**;设置是这两轴的唯一来源。
 *
 * ── 预设只剩 2 条 = "详细输出"的两半(2026-09-22 用户裁定)────────────
 *  · `${1}` = `--log-level debug`(⚠️ 必须落在 verb **之前**)
 *  · `${2}` = `log_command+`(与模板字面量 `--event-handlers console_cohesion+` 合成完整的那一条)
 * 两条都勾 = 今天的"详细输出";都不勾 = 普通输出。`${log_level}` 变量**已删除**。
 *
 * ── `${0}` 保留功能但不使用 ────────────────────────────────────────
 * 默认模板里**不写** `${0}` ⇒ 二级弹窗不会出现「自定义输入」项(只列那 2 条预设);
 * 机制本身完全保留:用户把 `${0}` 加回模板,那一项与输入框就回来。
 *
 * ── 变量口径(收缩后 5 个)──────────────────────────────────────────
 * `${base_path}`(裸值,自动引号)/ `${packages_select}`(片段)/ `${clean}`(片段)/
 * `${install_method}`(片段)/ `${install_layout}`(片段)。
 * 去掉的:`${parallel}`(写死并行度无意义;改用 colcon defaults 文件或终端手敲)、
 * `${event_handlers}`、`${build_type}`(写死 `RelWithDebInfo`;要 Debug 用编辑模板或加回 `${0}`,默认模板现在**没有** `${0}`)、
 * `${packages}`(与 `${packages_select}` 重复)、`${log_level}`(改由预设 `${1}` 承载)。
 * 能力变化与遗留问题清单见设计稿 §11。
 *
 * ── 出厂模板就是"扩展构建命令"的唯一事实源 ──────────────────────────
 * 扩展侧不再有硬编码的命令构造(ros2/ 的 `toColconBuildCommand` 已删除,`colcon_build` 只执行 argv);
 * 出厂默认模板与"此前内置构造产出"**逐字节等价**(锁定用例在 test/suite/share-expand.test.ts):
 *   `colcon [--log-level debug] build <安装两轴flags> --event-handlers console_cohesion+[ log_command+] --base-paths <ws>
 *     [--packages-select …] [--parallel-workers n] [--cmake-clean-cache]
 *     --cmake-args -DCMAKE_BUILD_TYPE=<type> -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`
 * 默认模板把同样的片段搬进占位符:普通输出 + 两轴变量 ⇒ 与今天**逐字节相同**;
 * 详细输出 = 勾上两条预设(见 test/suite/share-expand.test.ts 的等价性锁定用例)。
 */

import { quoteShellArg, splitShellArgs } from "../expand";
import type { ArgPreset, CommandSpec } from "../types";

/**
 * `colcon build` 的**命令 id**:用作选择记忆(selection-memory)的分槽键,也是将来 run/launch 各自 id 的样板。
 * 与命令 ID 常量表(build/command-ids.ts 的 VS Code 命令名)**不是一回事** —— 这里只标识"哪条命令的参数"。
 */
export const COLCON_BUILD_COMMAND_ID = "colcon.build";

/** 安装两轴(形态 × 布局)——设置侧的值与"从 argv 反解"共用这个形状 */export interface ColconInstallAxes {
    /** 形态:`symlink` = `--symlink-install` 出现;`copy` = 不出现 */
    method: "symlink" | "copy";
    /** 布局:`merged` = `--merge-install` 出现;`isolated` = 不出现 */
    layout: "merged" | "isolated";
}

/**
 * 从**一段 argv 文本**反解安装两轴(纯函数)。
 * 两轴的**权威来源是设置**;本函数用于"从最终命令行回读"的场景(例如接线后前瞻检查要核对
 * 用户自定义模板实际会产生什么),只看两个 flag 是否出现,其余参数一概忽略。
 */
export function axesFromArgv(argvText: string): ColconInstallAxes {
    const tokens = splitShellArgs(argvText ?? "");
    return {
        method: tokens.includes("--symlink-install") ? "symlink" : "copy",
        layout: tokens.includes("--merge-install") ? "merged" : "isolated",
    };
}

/**
 * 出厂默认预设:**"详细输出"的两半**(用户裁定)。
 * 两条都勾 = 与今天 `toConcolBuildCommand(verbose=true)` 的输出**逐字节相同**:
 * `${1}` 补上 verb 之前的 `--log-level debug`;`${2}` 只给 handler **名**,
 * 与模板里的字面量 `--event-handlers console_cohesion+` 合成完整的那一条(不再出现重复 flag)。
 *
 * ⚠️ 这两条是**两个槽**(`${1}` 在 `build` **之前**、`${2}` 在 `--event-handlers` 之后),**故意不合成一组** ——
 * "组"(同一槽的多条备选)只能表达**同一个位置**的互斥备选;这两半位置不同(实测 `--log-level` 落到 verb
 * 之后 colcon 直接退码 2)。想加"互斥档位"(如 Debug/Release 构建类型),那才是组的正确用法:
 * 在设置里加一个槽 + 一组备选,并把它放在模板尾部(后写覆盖)。
 */
export const COLCON_BUILD_PRESETS: readonly ArgPreset[] = [
    // (2026-10-04 i18n 期2,D3 裁定)出厂预设描述走语言中立英文——这是写进用户设置的数据非 UI 铬,
    // 与 manifest default 同步(share-expand 同步锁用例比对两处相等);用户可在设置里自行改写
    { argv: "--log-level debug", describe: "Verbose output 1/2: turn on debug logging" },
    { argv: "log_command+", describe: "Verbose output 2/2: log every command invoked" },
];

/**
 * 出厂默认模板:普通输出(不勾预设)时与"此前内置构造的产出"**逐字节等价**(锁定用例保障)。
 *
 * ⚠️ 这是**一段命令文本**(2026-10-07 起设置侧表示由词数组改回字符串——数组是 09-28 为设置
 * 面板逐词显示而选的表示,功能扩展后已无消费者;同日拆除数组兼容,未分发无存量)。
 * 展开前按 shell 词法(空格/引号)切分,模板里可写引号包含空格的词。
 * `${2}` 落在字面量 `--event-handlers console_cohesion+` **之后**,而 `${2}` 只给 handler **名**
 * (`log_command+`)⇒ 勾上它时合成**一条** `--event-handlers console_cohesion+ log_command+`,
 * 与今天逐字节相同。(若你确实想整段覆盖,把那一条预设改成写全 `--event-handlers console_cohesion+ log_command+` 也行
 * —— 实测重复 `--event-handlers` 退码 0 且后一次生效,只是命令行里会出现两次。)
 * ⚠️ 模板**没有** `${0}` ⇒ 二级弹窗不出现「自定义输入」项(功能保留,加回 `${0}` 即恢复)。
 */
export const COLCON_BUILD_SPEC: CommandSpec = {
    template: "colcon ${1} build ${install_method} ${install_layout} --event-handlers console_cohesion+ ${2} --base-paths ${base_path} ${packages_select} ${clean} --cmake-args -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    custom: "Custom input: hand-write arbitrary colcon arguments (multiple segments and quotes allowed). Add ${0} to the template to enable this entry (unused in the default template)",
    argv_list: COLCON_BUILD_PRESETS.map((preset) => ({ argv: preset.argv, describe: preset.describe })),
};

/** 「今天的选项」→ 命名动态参数片段(纯映射;调用方把值从设置/弹窗取好传进来即可) */
export interface ColconBuildDynamicsInput {
    /** 工作区根(--base-paths);**必须**给 */
    base_path: string;
    /** 选中的包;空/缺省 = 全量构建(成对片段整体消失,不会留下裸的 --packages-select) */
    packages?: readonly string[];
    /** 是否需要 --cmake-clean-cache(形态检查结论;模板里删掉 `${clean}` 即等于关掉这个自动修正) */
    clean?: boolean;
    /** 安装两轴 —— **来自设置**(`resolveInstallType()`);缺省 = 实体 + 分包(两个变量都为空) */
    install_type?: ColconInstallAxes;
}

/**
 * 今天的选项 → 动态参数片段(与今日命令的拼装规则 1:1)。
 * 两轴拆成两个变量(`${install_method}` / `${install_layout}`),顺序与 `toInstallTypeFlags()` 一致
 * (先 `--symlink-install` 再 `--merge-install`)。
 */
export function colconBuildDynamics(input: ColconBuildDynamicsInput): Record<string, string> {
    const packages = input.packages ?? [];
    const axes = input.install_type;
    return {
        base_path: quoteShellArg(input.base_path),
        packages_select: packages.length > 0 ? `--packages-select ${packages.join(" ")}` : "",
        clean: input.clean ? "--cmake-clean-cache" : "",
        install_method: axes?.method === "symlink" ? "--symlink-install" : "",
        install_layout: axes?.layout === "merged" ? "--merge-install" : "",
    };
}
