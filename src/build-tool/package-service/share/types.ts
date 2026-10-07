// Licensed under the MIT License.

/**
 * @file types.ts
 * 「可共享命令参数模板」机制的类型定义(纯类型,零依赖、零 vscode)。
 *
 * 机制三层(详见 设计-参数列表与命令模板.md):
 *  ① **命令模板**:命令文本(设置侧字符串,按空格与引号词法切分;兼容存量词数组)+ 占位符(存设置);
 *  ② **命名动态参数**:调用方展开时传入的实参片段(`${base_path}` / `${packages_select}` / `${executable}` / …);
 *  ③ **槽位表**:`argv_list`(每个槽可以是"单条"或"一组备选")+ `custom` 描述,填模板里的 `${1}..${n}` 与 `${0}`。
 */

/** 单条备选参数(一个可勾选的条目) */
export interface ArgPreset {
    /** 该备选展开后填入槽位的片段(可含 `${0}` 与命名动态参数) */
    argv: string;
    /** 二级弹窗里显示的描述(用户口径:描述显示在二轮输入里) */
    describe: string;
}

/**
 * **一个槽**的备选集合(2026-09-22 用户提出的"组"):
 *  · 直接写一条 `{ argv, describe }` ⇒ 该槽只有一个备选(等价于"组里只有一条");
 *  · 写一个数组 `[ {…}, {…} ]` ⇒ **同一个槽的多条备选(OR)**:弹窗里**全部列出**;
 *    勾中任意一条即填该槽;**同组多选 ⇒ 只应用"书写顺序里的第一条"**(用户裁定:一组最多生效一条),
 *    其余勾选仅用于显示,不影响展开。
 * 槽号 = 元素在 `argv_list` 里的位置(1 基)⇒ 模板里写 `${槽号}`;空数组 = 该槽没有备选(占位但不显示)。
 *
 * 例(第 2 个槽有三条互斥备选,选谁都是填 `${2}`;第 1 个槽只有一条):
 * ```jsonc
 * "argv_list": [
 *   { "argv": "--continue-on-error", "describe": "失败继续" },
 *   [ { "argv": "--cmake-args -DCMAKE_BUILD_TYPE=Debug",   "describe": "Debug 构建" },
 *     { "argv": "--cmake-args -DCMAKE_BUILD_TYPE=Release", "describe": "Release 构建" },
 *     { "argv": "--cmake-args -DCMAKE_BUILD_TYPE=RelWithDebInfo", "describe": "默认构建" } ]
 * ]
 * ```
 */
export type ArgSlot = ArgPreset | readonly ArgPreset[];

/**
 * 一条命令的参数模板规格。
 * **整份存设置**(用户裁定 Q3):template / custom / argv_list 三个字段用户都能改;
 * `defaults/` 里的出厂值只在"字段没给"时兜底(显式给空数组/空串则尊重用户)。
 */
export interface CommandSpec {
    /**
     * 命令模板:含 `${name}` 命名动态参数、`${0}` 自定义输入、`${1}..${n}` 槽位(含命令名本身)。
     * **设置侧是 string**(2026-10-07 起;09-28 曾用词数组供设置面板逐词显示,后无消费者改回),
     * 展开前按 shell 词法(空格与引号)切分,模板里可写引号包含空格的词。
     * 非字符串(含存量数组写法)在 mergeSpec 里视为"未给出",回落出厂默认。
     */
    template: string;
    /** 二级弹窗第 1 项(自定义输入)的描述 */
    custom: string;
    /** 槽位表:第 n 个元素 ↔ 模板里的 `${n}`;元素可以是单条,也可以是"该槽的多条备选" */
    argv_list: readonly ArgSlot[];
}

/** 展开输入(调用方按命令各自提供) */
export interface ExpandInput {
    /**
     * 命名动态参数(name → **片段**)。片段可为空串 = 该段整体消失。
     * 注意是"片段"而不是"值":`--packages-select a b` 这类成对参数由调用方整段拼好传进来,
     * 这样"无选中包"时该段会自然消失,不会留下裸的 `--packages-select`。
     */
    dynamics: Record<string, string>;
    /** 自定义输入(`${0}`):整段 argv,允许多参数与引号;不用 → 省略或空串 */
    custom?: string;
    /**
     * 被勾选的备选**平坦下标**(0 基;展平顺序 = 槽号升序、槽内按表的先后)。
     * 每个槽只有一条时,平坦下标恰等于槽号-1(见 `flattenArgList`)。
     * 未勾选 / 越界 → 不含该条(用户裁定 Q1:多选,不校验互斥)。
     */
    picked?: readonly number[];
}

/** 展开结果 */
export interface ExpandResult {
    /** 切分好的 argv(**含命令名**,即 argv[0] 通常是 `colcon` / `ros2`);调用方可直接执行 */
    argv: string[];
    /** 原样保留的未知占位符(去重、去掉 `${}`),供日志与诊断 —— 不静默吞掉 */
    unknown: string[];
    /** 展开后为空(调用方应拒绝执行空命令) */
    empty: boolean;
}
