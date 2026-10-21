// Licensed under the MIT License.

/**
 * @file presets-table.ts(2026-10-17 两拆分新增;2026-10-18 文法再收敛)
 * 预设**键值表**(设置侧表示)⇄ 内部 `ArgSlot[]`/custom/customHint 的**双向纯适配**。
 *
 * ── 背景(用户裁定,2026-10-17/18)──────────────────────────────────
 * 旧 `ROS2.<域>.shareSpec` 是嵌套对象(template/custom/argv_list 三字段,argv_list 还要
 * 数组套数组表达互斥组),设置编辑器只能进 settings.json 手写。两拆分后每域两个平级键:
 *  · `ROS2.<域>.template`(string)—— 模板文本框;
 *  · `ROS2.<域>.presets`(object,值全 string)—— 设置编辑器原生"Add Item"键值表格。
 *
 * ── presets 键文法(2026-10-18 收敛定案)─────────────────────────────
 *  · **裸键(不含未转义 `|`)= 0 号**:`${0}` 自定义输入的描述载体——键 = 输入框**上方说明**
 *    (prompt),值 = 输入框**内占位提示**(placeholder;非空覆盖调用方硬编码示例,空/缺省回落);
 *    值不作参数。多个裸键按书写顺序取**第一个**(描述与提示整组同取)。
 *  · **`槽号|描述` = 槽位条目**:槽号 `^[1-9][0-9]*$`(与引擎 `${1}..${n}` 正则同款,`0|…`
 *    显式写零按非法拒绝——只留一条正道);value = 该备选的参数串(shell 词法切分,同 argv)。
 *  · **同槽号多条 = 互斥备选组**:弹窗全部列出、生效取书写顺序第一条(引擎既有语义);
 *    槽号显式化 ⇒ 增删/重排条目不移位其它槽;缺号槽位补空组 `[]` 占位(引擎既有语义)。
 *  · **`\|` = 字面竖线**(只认首个未转义 `|` 分隔,沿用 packages.userIndex 惯例)——在裸键
 *    形态下**承重**:裸键描述想含竖线必须转义(否则被误判槽位条目 → 非法忽略);槽位描述段
 *    的裸竖线全容忍(非贪婪只切第一个,其余是字面内容)。
 *  · 容错(逐条忽略 + log):value 非字符串 / 槽号非 `^[1-9][0-9]*$` / 描述段为空 / 空键;
 *    **整表形状错**(非对象/数组)→ 返回 undefined = "未给出",由 mergeSpec 整体回落出厂;
 *    **有键但全被忽略** → 同样 undefined(防手滑垃圾键静默清空出厂预设);
 *    **空对象 `{}`** → 显式空表 `{ argv_list: [] }`(尊重"我就要没有预设")。
 *
 * ── 下游零改动 ─────────────────────────────────────────────────────
 * parse 产物拼成 `{ template?, custom?, customHint?, argv_list? }` 后仍交 `mergeSpec(raw, FACTORY)`:
 * template 键缺失/非串、custom/customHint/argv_list 缺失各自回落出厂的语义全部免费继承;
 * pick-preset/factory-l10n 拿到的仍是标量,出厂文案值相等门卫照常命中。
 */

import { getLogger } from "../../../logger";
import type { ArgPreset, ArgSlot, CommandSpec } from "./types";

/** presets-table 模块日志 */
const log = getLogger("presets-table");

/** parse 产物(partial 形态,字段缺省 = 交由 mergeSpec 回落出厂) */
export interface ParsedPresetsTable {
    /** `${0}` 自定义输入描述(首个裸键;无裸键 → undefined → mergeSpec 回落出厂 custom) */
    custom?: string;
    /** `${0}` 输入框占位提示(同上,来自裸键的 value;空/缺省 → 显示层回落调用方示例) */
    customHint?: string;
    /** 槽位表(槽号升序、缺号补空组;仅裸键/空对象时为显式空表) */
    argv_list: ArgSlot[];
}

/** 扫描首个未转义 `|`(反斜杠转义下一字符;与 create/deps/dep-lang 的 userIndex 扫描同规则) */
function firstUnescapedPipe(key: string): number {
    for (let i = 0; i < key.length; i++) {
        const ch = key[i];
        if (ch === "\\") {
            i++; // 跳过转义对
            continue;
        }
        if (ch === "|") {
            return i;
        }
    }
    return -1;
}

/** 描述段反转义:`\|` → 字面竖线(孤反斜杠原样保留,同 dep-lang 口径) */
function unescapePipes(text: string): string {
    return text.replace(/\\\|/g, "|");
}

/** 描述段转义(serialize 侧):`|` → `\|` */
function escapePipes(text: string): string {
    return text.replace(/\|/g, "\\|");
}

/** 槽位键解析(`槽号|描述`);文法不符返回 null(调用方逐条忽略 + log) */
function parseSlotKey(rawKey: string): { slot: number; describe: string } | null {
    const sep = firstUnescapedPipe(rawKey);
    if (sep < 0) {
        return null; // 无分隔符 → 不是槽位键
    }
    const prefix = rawKey.slice(0, sep);
    if (!/^[1-9][0-9]*$/.test(prefix)) {
        return null; // 槽号非 [1-9] 起头数字(含 `0|` 显式写零 → 拒绝,只留一条正道)
    }
    const describe = unescapePipes(rawKey.slice(sep + 1));
    if (describe.length === 0) {
        return null; // 描述段为空(弹窗无可显示文本)
    }
    return { slot: Number.parseInt(prefix, 10), describe };
}

/**
 * 预设键值表 → 内部形状(见文件头文法与容错口径)。
 * 返回 undefined = "未给出/整表报废",调用方不把 custom/customHint/argv_list 放进 mergeSpec 输入即可。
 */
export function parsePresetsTable(raw: unknown): ParsedPresetsTable | undefined {
    if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return undefined;
    }
    const record = raw as Record<string, unknown>;
    let custom: string | undefined;
    let customHint: string | undefined;
    const groups = new Map<number, ArgPreset[]>();
    for (const key of Object.keys(record)) {
        const value = record[key];
        const sep = firstUnescapedPipe(key);
        if (sep < 0) {
            // 裸键 = 0 号(描述 + 占位提示):值须字符串;多个按书写顺序取第一个(整组同取)
            if (custom !== undefined) {
                continue;
            }
            if (typeof value !== "string") {
                log.warn(`presets 裸键忽略(key="${key}"):value 非字符串`);
                continue;
            }
            const describe = unescapePipes(key);
            if (describe.length === 0) {
                continue; // 空键:描述与提示皆空,无意义
            }
            custom = describe;
            customHint = value;
            continue;
        }
        // 槽位键(槽号|描述)
        const parsed = parseSlotKey(key);
        if (parsed === null) {
            log.warn(`presets 条目忽略(key="${key}"):文法不符(槽号须为 ≥1 数字;裸键=0 号描述)`);
            continue;
        }
        if (typeof value !== "string") {
            log.warn(`presets 条目忽略(key="${key}"):value 非字符串`);
            continue;
        }
        const group = groups.get(parsed.slot) ?? [];
        group.push({ argv: value, describe: parsed.describe });
        groups.set(parsed.slot, group);
    }
    const hasValid = custom !== undefined || groups.size > 0;
    if (!hasValid) {
        if (Object.keys(record).length > 0) {
            return undefined; // 有键但全非法:整体回落出厂(防垃圾键静默清空预设)
        }
        return { argv_list: [] }; // 显式空对象:尊重"没有预设"
    }
    const argv_list: ArgSlot[] = [];
    if (groups.size > 0) {
        const maxSlot = Math.max(...groups.keys());
        for (let slot = 1; slot <= maxSlot; slot++) {
            const group = groups.get(slot);
            // 单条 → 裸 ArgPreset(与出厂 argv_list 形状一致,往返可逐字节相等);多条 → 互斥备选组
            argv_list.push(group === undefined || group.length === 0 ? [] : group.length === 1 ? group[0] : group);
        }
    }
    return { custom, customHint, argv_list };
}

/**
 * 内部 spec → 键值表(serialize 侧):同步锁测试用"出厂 spec 经本函数"与 manifest default
 * 对深相等;文档示例同源。custom 产**裸键**,value = customHint(出厂提示随数据下发;缺省
 * 空串 = 无占位),槽号升序、组内保书写序。注意:含**空组占位**的 spec 序列化后再 parse 会
 * **压实槽号**(空组无键可写)——出厂 spec 无空组,往返性质只对无空组形态承诺。
 */
export function serializePresetsTable(spec: Pick<CommandSpec, "custom" | "customHint" | "argv_list">): Record<string, string> {
    const out: Record<string, string> = {};
    if (spec.custom.length > 0) {
        out[escapePipes(spec.custom)] = spec.customHint ?? "";
    }
    spec.argv_list.forEach((slot, index) => {
        const group = Array.isArray(slot) ? slot : [slot];
        for (const choice of group) {
            out[`${index + 1}|${escapePipes(choice.describe)}`] = choice.argv;
        }
    });
    return out;
}
