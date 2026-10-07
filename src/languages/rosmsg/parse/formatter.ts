/**
 * rosmsg(.msg/.srv/.action)文档格式化
 *
 * 纯逻辑函数,不依赖 VS Code API,可直接单测(纯 node)。
 *
 * 规则:
 *  - 按 "---" 分段,梯度分档对齐:以最短类型长度为起点、按可配置步长(默认 11)分档
 *  - 每档对齐线 = 档内最大类型长度 + 2;间距恒在 [2, 步长]
 *  - 常量等号规范化: X=0 → X = 0
 *  - 行内注释保留,前补两个空格
 *  - 注释行 / 分隔线保留;连续空行合并为 1 个(末尾同理)
 *  - 无法识别的行保留原样(仅去尾空格)
 *  - @optional 注解(同行或独立一行均识别,对齐 rosidl):
 *    - 单行模式:综合长度 = "@optional " + 类型长度,参与分档对齐(名称列与普通字段对齐)
 *    - 双行模式:合并总长超过阈值(默认 60,可配置)时,@optional 独立顶格一行,字段行按类型长度对齐
 *    - 单/双行动态切换:双行来源若合并总长 < 阈值 → 合并单行(独立行行尾注释提取为上方注释行);
 *      单行来源若合并总长 > 阈值 → 拆双行;恰等于阈值维持现状
 */

// 字段行: 类型[数组] 名称 [= 值] [# 注释](不含 @optional 前缀;前缀单独剥离)
// 末尾 \s* 容忍名称后的尾随空格(无等号/注释时也能识别)
const FIELD_RE =
    /^\s*([a-zA-Z0-9_/]+)(\[[^\]]*\])?\s+([a-zA-Z0-9_]+)(?:\s*=\s*(.*?))?(?:\s*#\s*(.*))?\s*$/;
// 独立一行的 @optional 注解(rosidl 允许,可带行尾注释)
const OPTIONAL_ALONE_RE = /^@optional(\s*#.*)?$/i;
// 同行 @optional 前缀(剥离用)
const OPTIONAL_PREFIX_RE = /^\s*@optional\s+/i;

/** 解析出的字段行 */
interface ParsedFieldLine {
    /** 是否带 @optional(同行前缀或独立行前置) */
    optional: boolean;
    /** 是否来自独立行 @optional(源结构为双行) */
    fromAloneLine: boolean;
    /** 独立行 @optional 上的行尾注释(双行来源时) */
    optComment?: string;
    /** 含数组括号的完整类型文本(如 "float64[]") */
    type: string;
    name: string;
    /** undefined=无等号, ""=等号后无值 */
    value?: string;
    comment?: string;
}

/** 解析字段行体(不含 @optional 前缀) */
function parseFieldBody(raw: string): ParsedFieldLine | undefined {
    const m = FIELD_RE.exec(raw);
    if (!m) {
        return undefined;
    }
    return {
        optional: false,
        fromAloneLine: false,
        type: m[1] + (m[2] || ""),
        name: m[3],
        value: m[4] !== undefined ? m[4].trim() : undefined,
        comment: m[5] !== undefined ? m[5].trim() : undefined,
    };
}

/** 提取独立行 "@optional # 说明" 的行尾注释("#" 之后内容) */
function optAloneComment(trimmed: string): string | undefined {
    const hash = trimmed.indexOf("#");
    return hash >= 0 ? trimmed.slice(hash + 1).trim() : undefined;
}

/** 合并单行总长(@optional 前缀 + 类型 + 空格 + 名称 + 值 + 注释;不含对齐填充) */
function combinedLen(f: ParsedFieldLine): number {
    let len = (f.optional ? "@optional ".length : 0) + f.type.length + 1 + f.name.length;
    if (f.value !== undefined) {
        len += f.value === "" ? 2 : 3 + f.value.length;
    }
    if (f.comment !== undefined) {
        len += 3 + f.comment.length;
    }
    return len;
}

/** 对齐用长度:单行综合(@optional + 类型)或双行/普通仅类型 */
function alignLen(f: ParsedFieldLine, mode: "single" | "double"): number {
    return f.optional && mode === "single" ? "@optional ".length + f.type.length : f.type.length;
}

/**
 * 格式化消息文档内容(纯函数)
 * @param content 文档全文
 * @param gradientStep 梯度分档步长(字符),默认 11;同档跨度 ≤ 步长-1,间距恒在 [2, 步长]
 * @param lineThreshold 单/双行切换阈值(字符),默认 60
 * @returns 格式化后的全文
 */
export function formatRosMessageContent(content: string, gradientStep = 11, lineThreshold = 60): string {
    const lines = content.split(/\r?\n/);

    // 逐行解析:字段(含单/双行判定)/独立 @optional 行/其他(注释/空行/分隔线/无法识别)
    type Entry =
        | { kind: "field"; field: ParsedFieldLine; mode: "single" | "double"; align: number }
        | { kind: "opt-alone"; comment?: string }
        | undefined;
    const parsed: Entry[] = [];
    const separators: number[] = [];
    const consumedAlone = new Set<number>();
    let pendingAlone: { comment?: string; index: number } | undefined;

    const isolateAlone = () => {
        if (pendingAlone) {
            parsed[pendingAlone.index] = { kind: "opt-alone", comment: pendingAlone.comment };
            pendingAlone = undefined;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();

        if (/^-{3,}\s*$/.test(trimmed)) {
            isolateAlone();
            parsed.push(undefined);
            separators.push(i);
            continue;
        }

        // 独立一行的 @optional(rosidl 用法:修饰下一个字段/常量)
        if (OPTIONAL_ALONE_RE.test(trimmed)) {
            const idx = parsed.length;
            const comment = optAloneComment(trimmed);
            parsed.push({ kind: "opt-alone", comment });
            pendingAlone = { comment, index: idx };
            continue;
        }

        // 同行 @optional 前缀剥离
        let body = raw;
        let hasPrefix = false;
        const pm = OPTIONAL_PREFIX_RE.exec(raw);
        if (pm) {
            hasPrefix = true;
            body = raw.slice(pm[0].length);
        }

        const wasAlone = !!pendingAlone;
        const f = parseFieldBody(body);
        if (f) {
            f.optional = hasPrefix || wasAlone;
            f.fromAloneLine = wasAlone;
            if (wasAlone && pendingAlone) {
                f.optComment = pendingAlone.comment;
                consumedAlone.add(pendingAlone.index);
                pendingAlone = undefined;
            }
            // 单/双行判定(阈值):双行来源总长 < 阈值 → 单行;单行来源总长 > 阈值 → 双行;等于维持现状
            let mode: "single" | "double" = "single";
            if (f.optional) {
                const cl = combinedLen(f);
                mode = f.fromAloneLine
                    ? (cl < lineThreshold ? "single" : "double")
                    : (cl > lineThreshold ? "double" : "single");
            }
            parsed.push({ kind: "field", field: f, mode, align: alignLen(f, mode) });
        } else {
            isolateAlone();
            parsed.push(undefined);
        }
    }
    isolateAlone();

    // 梯度分档对齐:以段内最短对齐长度为起点,按步长 gradientStep 分档;
    // 每档对齐线 = 档内最大对齐长度 + 2(名称列)。
    const bounds = [-1, ...separators, lines.length];
    const segAlign: { minLen: number; buckets: Map<number, number> }[] = [];
    for (let s = 0; s < bounds.length - 1; s++) {
        let minLen = Number.POSITIVE_INFINITY;
        for (let i = bounds[s] + 1; i < bounds[s + 1]; i++) {
            const e = parsed[i];
            if (e && e.kind === "field") {
                minLen = Math.min(minLen, e.align);
            }
        }
        const buckets = new Map<number, number>();
        for (let i = bounds[s] + 1; i < bounds[s + 1]; i++) {
            const e = parsed[i];
            if (!e || e.kind !== "field") {
                continue;
            }
            const len = e.align;
            const b = Math.floor((len - minLen) / gradientStep);
            buckets.set(b, Math.max(buckets.get(b) ?? 0, len));
        }
        segAlign.push({ minLen, buckets });
    }

    // 输出:字段按单/双行展开,独立 @optional 行由字段分支消费
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const e = parsed[i];

        // 独立 @optional 行:被字段消费则跳过(字段分支输出);孤立则保留原样
        if (e && e.kind === "opt-alone") {
            if (consumedAlone.has(i)) {
                continue;
            }
            out.push(raw.replace(/\s+$/, ""));
            continue;
        }
        if (!e || e.kind !== "field") {
            // 整行注释顶格(去前导空格);空行/分隔线/无法识别行:保留原样,仅去尾空格
            const trimmed = raw.trim();
            if (trimmed.startsWith("#")) {
                out.push(trimmed);
            } else {
                out.push(raw.replace(/\s+$/, ""));
            }
            continue;
        }

        // 字段:定位所在段并计算名称列
        let seg = 0;
        for (let s = 0; s < bounds.length - 1; s++) {
            if (i > bounds[s] && i < bounds[s + 1]) {
                seg = s;
                break;
            }
        }
        const { minLen, buckets } = segAlign[seg];
        const len = e.align;
        const b = Math.floor((len - minLen) / gradientStep);
        const targetCol = (buckets.get(b) ?? len) + 2;
        const spacing = targetCol - len;

        if (e.mode === "double") {
            // 双行:@optional 独立顶格一行(带其行尾注释),字段行按类型长度对齐
            out.push(e.field.optComment ? `@optional  # ${e.field.optComment}` : "@optional");
        } else if (e.field.fromAloneLine && e.field.optComment) {
            // 双行→单行:独立行行尾注释提取为上方独立注释行(不丢失)
            out.push(`# ${e.field.optComment}`);
        }

        // 字段行:单行含 @optional 前缀(综合对齐);双行仅类型
        const typePart = e.mode === "single" && e.field.optional ? `@optional ${e.field.type}` : e.field.type;
        let line = `${typePart}${" ".repeat(spacing)}${e.field.name}`;
        if (e.field.value !== undefined) {
            line += e.field.value === "" ? " =" : ` = ${e.field.value}`;
        }
        if (e.field.comment !== undefined) {
            line += `  # ${e.field.comment}`;
        }
        out.push(line);
    }

    // 合并连续空行(最多保留 1 个),文档末尾空行也合并为单个结尾换行
    const merged: string[] = [];
    let prevBlank = false;
    for (const line of out) {
        const blank = line.trim() === "";
        if (blank && prevBlank) {
            continue;
        }
        merged.push(line);
        prevBlank = blank;
    }
    return merged.join("\n");
}
