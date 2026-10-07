// Licensed under the MIT License.

/**
 * @file expand.ts
 * 命令模板展开(纯函数,零 vscode,可无头单测)。
 *
 * ── 占位符与展开顺序(用户裁定)────────────────────────────────────
 *  | 占位符 | 含义 | 时机 |
 *  |:--|:--|:--|
 *  | `${0}` | **自定义输入**(二级弹窗第 1 项,选中后弹输入框;整段 argv 允许多参数/引号) | **最先**——先在每条预设
 *    `argv` 内部替换(用户要求:`${0}` 可被预设内嵌,如 `{ "argv": "--install-base ${0}" }`),再在模板里替换 |
 *  | `${1}`..`${n}` | **第 n 个槽**的文本(槽内可有多条**备选**;勾中者按表内先后依次拼接;下标 1 基,没勾 → 空串) | 第 2 步 |
 *  | `${<name>}` | 调用方传入的命名动态参数(`base_path` / `packages_select` / …) | 第 3 步 |
 *  | 其它 `${x}` | **原样保留 + 记入 `unknown`**(不静默吞掉) | — |
 *
 * 数字槽在**预设内部不解析**(只解析 `${0}` 与命名动态参数)——避免"预设套预设"的递归歧义;
 * 展开是**单遍**替换:替换进去的文本不会再被扫描(`String.replace` 语义),因此不存在二次展开与递归风险。
 *
 * ── 切分 ───────────────────────────────────────────────────────────
 * 模板展开后按 **shell 词法**切分(单引号 / 双引号 / 反斜杠转义;引号语义保留);
 * 空 token 丢弃(即 `""` 不产生参数)。与用户自己敲终端等价,**扩展不额外加壳、不做转义改写**。
 */

import type { ArgPreset, ArgSlot, CommandSpec, ExpandInput, ExpandResult } from "./types";

/** 预留位词法 `${...}`;名字限定为字母数字下划线(含空名,便于诊断) */
const PLACEHOLDER = /\$\{([A-Za-z0-9_]*)\}/g;

/** 预设槽名:**就是序号本身** `${1}`/`${12}`(不带任何前缀);`${0}` 单列(= 自定义输入) */
const SLOT_NAME = /^[1-9][0-9]*$/;

/**
 * shell 词法切分(单引号 / 双引号 / 反斜杠转义)。
 * 未闭合的引号按"到串尾都是字面量"处理(不报错——用户自己写的模板,报错也帮不上忙)。
 */
export function splitShellArgs(text: string): string[] {
    const out: string[] = [];
    let cur = "";
    let started = false;   // 该 token 是否已开始(区分"空 token"与"无 token")
    let quote: "\"" | "'" | null = null;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote === "'") {
            if (ch === "'") {
                quote = null;
            } else {
                cur += ch;
            }
            continue;
        }
        if (quote === "\"") {
            if (ch === "\\" && i + 1 < text.length) {
                i++;
                cur += text[i];
            } else if (ch === "\"") {
                quote = null;
            } else {
                cur += ch;
            }
            continue;
        }
        if (ch === "'" || ch === "\"") {
            quote = ch;
            started = true;
            continue;
        }
        if (ch === "\\" && i + 1 < text.length) {
            i++;
            cur += text[i];
            started = true;
            continue;
        }
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            if (started) {
                out.push(cur);
                cur = "";
                started = false;
            }
            continue;
        }
        cur += ch;
        started = true;
    }
    if (started) {
        out.push(cur);
    }
    return out;
}

/**
 * 需要时给**单个实参**加引号(供调用方拼"片段"用,例如工作区路径含空格)。
 * 只在必要时加,且用双引号 + 反斜杠转义,保证 `splitShellArgs` 能还原成同一个实参。
 */
export function quoteShellArg(value: string): string {
    if (value.length > 0 && !/[\s"'\\$`]/.test(value)) {
        return value;
    }
    return `"${value.replace(/([\\"$`])/g, "\\$1")}"`;
}

/** 单遍替换一条文本里的占位符(替换进去的内容不再扫描) */
function substitute(
    text: string,
    resolve: (name: string) => string,
): string {
    return text.replace(PLACEHOLDER, (_match, name: string) => resolve(name));
}

/** 展开上下文:负责"名字 → 文本",并记录未知占位符 */
class Resolver {
    public readonly unknown = new Set<string>();

    public constructor(
        private readonly dynamics: Record<string, string>,
        private readonly custom: string,
        private readonly allowSlots: boolean,
        private readonly slotTexts: readonly string[] | null,
    ) { }

    public resolve(name: string): string {
        if (name === "0") {
            return this.custom;
        }
        const slot = SLOT_NAME.test(name);
        if (slot) {
            if (!this.allowSlots || this.slotTexts === null) {
                this.unknown.add(name);            // 预设内部不解析数字槽
                return `\${${name}}`;
            }
            const index = Number(name) - 1;
            const text = this.slotTexts[index];
            return text === undefined ? "" : text;  // 越界 → 空(设计稿 §4)
        }
        if (Object.prototype.hasOwnProperty.call(this.dynamics, name)) {
            return this.dynamics[name] ?? "";
        }
        this.unknown.add(name);
        return `\${${name}}`;                      // 未知 → 原样保留
    }
}

/**
 * 展平后的单个可选条目(弹窗勾选与"选择记忆"都用它的**平坦下标**)。
 * 展平顺序 = 槽号升序、槽内按表的先后 ⇒ 每个槽只有一条时,`index === slot - 1`。
 */
export interface FlatChoice extends ArgPreset {
    /** 所属槽位(1 基,对应模板里的 `${slot}`) */
    slot: number;
    /** 在展平表里的下标(0 基) */
    index: number;
}

/** 把 `argv_list`(槽可以是单条或一组)展平成"可选条目"表;空组不产出条目(槽号仍然占位) */
export function flattenArgList(argv_list: readonly ArgSlot[] | undefined | null): FlatChoice[] {
    const out: FlatChoice[] = [];
    (argv_list ?? []).forEach((item, position) => {
        const slot = position + 1;
        const choices: readonly ArgPreset[] = Array.isArray(item) ? item : [item as ArgPreset];
        for (const choice of choices) {
            if (!choice || typeof choice !== "object") {
                continue;
            }
            out.push({
                slot,
                index: out.length,
                argv: typeof choice.argv === "string" ? choice.argv : "",
                describe: typeof choice.describe === "string" ? choice.describe : "",
            });
        }
    });
    return out;
}

/** 该 spec 里是否有可勾选的条目(空组 / 空表 ⇒ false) */
export function hasArgChoices(argv_list: readonly ArgSlot[] | undefined | null): boolean {
    return flattenArgList(argv_list).length > 0;
}

/**
 * 展开命令模板 → argv。
 *
 * 步骤(设计稿 §4):
 *  ① **被勾选**的每条备选各自展开(`${0}` 与命名动态参数;备选内不解析槽位);
 *  ② 每条槽取"**书写顺序里第一条被勾中的备选**"——同一个槽(组)内多选时**只应用第一条**,
 *     其余勾选照旧显示在弹窗里但不参与展开(用户裁定 2026-09-22:"一组最多只会有一个被应用");
 *  ③ 模板内展开 `${0}` / `${i}` / `${<name>}`;④ shell 词法切分;⑤ 结果为空则 `empty: true`。
 *
 * 注意:若"第一条被勾中的备选"本身展开为空串(例如"无附加参数"那种备选),该槽就是空 ——
 * **不会顺延到第二条**(保持"勾了谁就是谁"的可预期性)。
 */
export function expandCommand(spec: CommandSpec, input: ExpandInput): ExpandResult {
    const dynamics = input.dynamics ?? {};
    const custom = input.custom ?? "";
    const picked = new Set(input.picked ?? []);
    const choices = flattenArgList(spec.argv_list);

    // ①② 备选内展开 → 每个槽只认第一条被勾中者
    const presetResolver = new Resolver(dynamics, custom, false, null);
    const slotText = new Map<number, string>();
    let maxSlot = 0;
    for (const choice of choices) {
        maxSlot = Math.max(maxSlot, choice.slot);
        if (!picked.has(choice.index) || slotText.has(choice.slot)) {
            continue;                                  // 未勾选,或该槽已经由书写顺序更靠前的一条占定
        }
        slotText.set(choice.slot, substitute(choice.argv, (name) => presetResolver.resolve(name)));
    }
    const slotTexts: string[] = [];
    for (let slot = 1; slot <= maxSlot; slot++) {
        slotTexts.push(slotText.get(slot) ?? "");
    }

    // ③④⑤ 模板内展开 + 切分
    const templateResolver = new Resolver(dynamics, custom, true, slotTexts);
    const text = substitute(spec.template, (name) => templateResolver.resolve(name));
    const argv = splitShellArgs(text).filter((token) => token.length > 0);
    const unknown = new Set<string>([...presetResolver.unknown, ...templateResolver.unknown]);
    return { argv, unknown: [...unknown].sort(), empty: argv.length === 0 };
}

/**
 * 模板里是否用到自定义输入(`${0}`)。
 *
 * 用途(用户裁定):**模板里没有 `${0}` 时,二级弹窗不显示「自定义输入」项** ——
 * 放进去也无处落地,只会让用户白输一段被丢掉的参数。
 * 词法与展开一致:`${0}` 是精确匹配(`${01}`/`${00}` 都不是槽名,按未知占位符处理)。
 */
export function usesCustomPlaceholder(template: string): boolean {
    return /\$\{0\}/.test(template);
}

/**
 * 合并设置里的 spec 与出厂默认(**按"字段是否给出"合并,不按"是否为空"**):
 *  · 设置项整个缺失(`undefined`/`null`/非对象)⇒ 整份用出厂默认;
 *  · 字段给了(哪怕是**空串**、**空数组**)⇒ **尊重用户**,不再回落默认
 *    —— 这样"把预设全删干净"(`argv_list: []`)才不会被默认值悄悄还原。
 */
export function mergeSpec(
    raw: Partial<CommandSpec> | undefined | null,
    fallback: CommandSpec,
): CommandSpec {
    const cloneFallback = (): CommandSpec => ({
        template: fallback.template,
        custom: fallback.custom,
        argv_list: cloneArgList(fallback.argv_list),
    });
    if (!raw || typeof raw !== "object") {
        return cloneFallback();
    }
    const rawList: unknown = (raw as { argv_list?: unknown }).argv_list;
    return {
        template: normalizeTemplateField((raw as { template?: unknown }).template) ?? fallback.template,
        custom: typeof raw.custom === "string" ? raw.custom : fallback.custom,
        argv_list: Array.isArray(rawList) ? normalizeSpec({ argv_list: rawList } as Partial<CommandSpec>).argv_list : cloneFallback().argv_list,
    };
}

/** template 字段归一:字符串原样;其它(数字/存量数组写法等)⇒ undefined = 视为未给出,回落出厂默认 */
function normalizeTemplateField(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** 深拷贝槽位表(组要逐条复制,免得调用方改到出厂默认对象) */
function cloneArgList(argv_list: readonly ArgSlot[]): ArgSlot[] {
    return argv_list.map((slot) =>
        Array.isArray(slot)
            ? slot.map((choice) => ({ argv: choice.argv, describe: choice.describe }))
            : { argv: (slot as ArgPreset).argv, describe: (slot as ArgPreset).describe },
    );
}

/** 归一化一条备选;非法(非对象)⇒ null(由调用方决定丢弃还是留一个空槽) */
function normalizeChoice(item: unknown): ArgPreset | null {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
    }
    const o = item as { argv?: unknown; describe?: unknown };
    return {
        argv: typeof o.argv === "string" ? o.argv : "",
        describe: typeof o.describe === "string" ? o.describe : "",
    };
}

/**
 * 归一化 spec:缺字段补空(设置里的半成品也能用;真正的出厂默认由各命令 `defaults/` 负责合并)。
 * 槽位表的元素允许是**单条**或**一组**(数组);组内的非法项丢弃,整条非法项 ⇒ 留一个**空组**
 * (占位但不产出可选条目,这样后续槽号不会错位)。纯函数,不读设置、不碰 vscode。
 */
export function normalizeSpec(raw: Partial<CommandSpec> | undefined | null): CommandSpec {
    const rawList: unknown = raw?.argv_list;
    const argvList = Array.isArray(rawList) ? (rawList as unknown[]) : [];
    return {
        template: normalizeTemplateField(raw?.template) ?? "",
        custom: typeof raw?.custom === "string" ? raw.custom : "",
        argv_list: argvList.map((item): ArgSlot => {
            if (Array.isArray(item)) {
                return item
                    .map(normalizeChoice)
                    .filter((choice): choice is ArgPreset => choice !== null);
            }
            return normalizeChoice(item) ?? [];
        }),
    };
}
