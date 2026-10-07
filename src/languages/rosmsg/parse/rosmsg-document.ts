/**
 * rosmsg(.msg/.srv/.action)结构模型与解析器
 *
 * 把消息文件解析成结构化文档(段、字段、常量、分隔线、非法行),
 * 补全/诊断/悬停/跳转全部基于此模型,避免各功能各写正则。
 */

import type { TextDocument } from "vscode";
import * as path from "path";
import { getLogger } from "../../../logger";

/** 扩展日志薄封装(带 rosmsg-doc 模块前缀) */
const log = getLogger("rosmsg-doc");

/** 消息文件类型 */
export type RosMsgKind = "msg" | "srv" | "action";

/** 字段类型(含数组信息) */
export interface FieldTypeInfo {
    /** 无数组部分的基础类型,如 "uint8"、"geometry_msgs/Point" */
    base: string;
    /** 含数组的原始类型文本,如 "uint8[]"、"uint8[4]" */
    raw: string;
    /** 是否为数组 */
    isArray: boolean;
    /** 数组长度:undefined=动态数组, "N"=定长, ""=空 [] */
    arraySize?: string;
}

/** 字段或常量声明 */
export interface RosMsgField {
    kind: "field" | "constant";
    type: FieldTypeInfo;
    name: string;
    defaultValue?: string;
    comment?: string;
    /** @optional 注解(同行前缀或独立行前置修饰) */
    optional?: boolean;
    line: number;
    /** 类型起始列(0-based) */
    typeColumn: number;
    /** 名称起始列(0-based,补全/诊断精确指向) */
    nameColumn: number;
    /** 整行原文 */
    text: string;
}

/** 结构错误行(由解析器统一产出) */
export interface RosMsgInvalidLine {
    line: number;
    text: string;
    reason: string;
    severity: "error" | "warning";
}

/** 段(按 --- 分隔):0=request, 1=response, 2=feedback(action) */
export interface RosMsgSection {
    index: number;
    fields: RosMsgField[];
}

/** 结构化文档模型 */
export interface RosMsgDocument {
    kind: RosMsgKind;
    /** 文档版本(缓存失效用) */
    version: number;
    lines: string[];
    /** "---" 分隔线所在行号 */
    separators: number[];
    /** 疑似分隔线所在行号(格式非法但计入数量,避免修正后数量突变) */
    suspectSeparators: number[];
    sections: RosMsgSection[];
    comments: Map<number, string>;
    invalidLines: RosMsgInvalidLine[];
}

/** 根据扩展名判定文件类型 */
export function kindOf(fileName: string): RosMsgKind {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === ".action") {
        return "action";
    }
    if (ext === ".srv") {
        return "srv";
    }
    return "msg";
}

/** 期望的分隔线数量:msg=0, srv=1, action=2 */
export function expectedSeparators(kind: RosMsgKind): number {
    switch (kind) {
        case "action":
            return 2;
        case "srv":
            return 1;
        default:
            return 0;
    }
}

// 字段/常量声明: [@optional ]类型[数组] 名称 [= 默认值] [# 注释]
// 值组用 (.*?) 而非 (\S.*?):等号后无值/仅空格时仍能识别"常量缺少值",而非误判为无法识别行
// 末尾 \s* 容忍名称后的尾随空格(无等号/注释时也能识别)
const FIELD_RE = /^\s*(@optional\s+)?([a-zA-Z0-9_/]+)(\[[^\]]*\])?\s+([a-zA-Z0-9_]+)(\s*=\s*(.*?))?(\s*#\s*(.*))?\s*$/;
// 独立一行的 @optional 注解(rosidl 允许:修饰下一个字段/常量;可带行尾注释,如 "@optional # 说明")
const OPTIONAL_ALONE_RE = /^@optional(\s*#.*)?$/i;
// 疑似分隔线:整行仅由破折号与空白组成(如 "- - -")
const SUSPECT_SEP_RE = /^[\s-]+$/;

/**
 * 解析文档为结构模型
 */
export function parseRosMessageDocument(document: TextDocument): RosMsgDocument {
    const kind = kindOf(document.fileName);
    const lines = document.getText().split(/\r?\n/);

    const separators: number[] = [];
    const suspectSeparators: number[] = [];
    const comments = new Map<number, string>();
    const invalidLines: RosMsgInvalidLine[] = [];
    const fields: RosMsgField[] = [];
    // 独立行 @optional 的待应用标记(修饰下一个字段/常量;按 rosidl 语义,空行/注释行不重置)
    let pendingOptional = false;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();

        // 注释行
        const commentMatch = trimmed.match(/^#\s*(.+)$/);
        if (commentMatch) {
            comments.set(i, commentMatch[1].trim());
            continue;
        }
        if (trimmed === "") {
            continue;
        }

        // 破折号线(整行仅由破折号与空白组成):分隔线候选
        if (SUSPECT_SEP_RE.test(trimmed)) {
            const dashCount = (trimmed.match(/-/g) || []).length;
            // 无空格的连续破折号(如 "---"、"-----"、"--")
            const isContinuous = /^-+$/.test(trimmed);

            if (isContinuous) {
                // 未顶格(行首有前导空白)→ 分隔线必须顶格
                if (/^\s/.test(raw)) {
                    suspectSeparators.push(i);
                    invalidLines.push({
                        line: i, text: raw,
                        reason: "分隔线 \"---\" 必须顶格(行首不能有空格)",
                        severity: "warning"
                    });
                    continue;
                }
                if (dashCount === 3) {
                    // 顶格且恰好 3 个:带尾随空白 → 收紧对齐 rosidl(要求整行严格为 "---")
                    if (/[ \t]/.test(raw)) {
                        suspectSeparators.push(i);
                        invalidLines.push({
                            line: i, text: raw,
                            reason: "分隔线 \"---\" 后不应有尾随内容(整行需严格为 \"---\")",
                            severity: "warning"
                        });
                        continue;
                    }
                    // 顶格且无尾随 → 合法分隔线(段边界;@optional 不跨段,重置待应用标记)
                    separators.push(i);
                    pendingOptional = false;
                    continue;
                }
                if (dashCount > 3) {
                    // 顶格但破折号数量超过标准 3 个 → 符号幅过多
                    suspectSeparators.push(i);
                    invalidLines.push({
                        line: i, text: raw,
                        reason: `分隔线破折号过多(当前 ${dashCount} 个,标准为 3 个)`,
                        severity: "warning"
                    });
                    continue;
                }
                // 1~2 个连续破折号 → 疑似分隔线(不足 3 个)
                suspectSeparators.push(i);
                invalidLines.push({
                    line: i, text: raw,
                    reason: `疑似 "---" 分隔线(破折号不足 3 个,当前 ${dashCount} 个)`,
                    severity: "warning"
                });
                continue;
            }

            // 带空格的破折号线(如 "- - -"):保持原有的疑似判定
            if (trimmed.includes(" ") || trimmed.includes("\t")) {
                suspectSeparators.push(i);
                invalidLines.push({
                    line: i, text: raw,
                    reason: "疑似 \"---\" 分隔线,破折号之间不应有空格",
                    severity: "warning"
                });
                continue;
            }
        }

        // 独立一行的 @optional 注解:修饰下一个字段/常量(rosidl 用法,可带行尾注释)
        if (OPTIONAL_ALONE_RE.test(trimmed)) {
            if (pendingOptional) {
                invalidLines.push({
                    line: i, text: raw,
                    reason: "重复的 @optional 注解(rosidl 不允许连续多个 @optional)",
                    severity: "error"
                });
                continue;
            }
            pendingOptional = true;
            continue;
        }

        // 字段/常量声明
        const m = FIELD_RE.exec(raw);
        if (m) {
            const typeRaw = m[2];
            const brackets = m[3];
            const name = m[4];
            const hasEquals = m[5] !== undefined;
            const value = m[6];
            const fieldComment = trimmed.match(/#\s*(.+)$/)?.[1]?.trim();

            const isArray = !!brackets;
            const arraySize = brackets ? brackets.slice(1, -1) : undefined;

            // 数组长度校验:非负整数(定长)、空(变长)或 <=N(有界)均合法
            if (isArray && arraySize !== undefined && arraySize !== "" && !/^(\d+|<=\d+)$/.test(arraySize)) {
                invalidLines.push({
                    line: i, text: raw,
                    reason: `数组长度非法:"${brackets}" 应为非负整数或 <=N 有界数组`,
                    severity: "error"
                });
            }

            // 常量声明缺值
            if (hasEquals && (value === undefined || value === "")) {
                invalidLines.push({
                    line: i, text: raw,
                    reason: "常量声明缺少值(应为 类型 名称 = value)",
                    severity: "error"
                });
            }

            const typeColumn = raw.indexOf(typeRaw);
            const typeEnd = typeColumn + typeRaw.length + (brackets ? brackets.length : 0);
            const nameColumn = raw.indexOf(name, typeEnd);

            fields.push({
                kind: hasEquals ? "constant" : "field",
                type: { base: typeRaw, raw: typeRaw + (brackets || ""), isArray, arraySize },
                name,
                defaultValue: value,
                comment: fieldComment,
                line: i,
                typeColumn,
                nameColumn: nameColumn < 0 ? typeEnd : nameColumn,
                text: raw,
                // @optional 注解:同行前缀(m[1])或独立行前置修饰;无注解时为 undefined(可选属性未设置)
                optional: (m[1] || pendingOptional) ? true : undefined
            });
            pendingOptional = false;
            continue;
        }

        // 无法识别(错误的结构,提升为 error)
        invalidLines.push({
            line: i, text: raw,
            reason: "错误的结构,无法识别(应为 类型[数组] 名称 [= 默认值])",
            severity: "error"
        });
    }

    // 按 --- 分段
    const bounds = [-1, ...separators, lines.length];
    const sections: RosMsgSection[] = [];
    for (let s = 0; s < bounds.length - 1; s++) {
        sections.push({ index: s, fields: [] });
    }
    for (const f of fields) {
        let seg = 0;
        for (let s = 0; s < bounds.length - 1; s++) {
            if (f.line > bounds[s] && f.line < bounds[s + 1]) {
                seg = s;
                break;
            }
        }
        sections[seg].fields.push(f);
    }

    // 分隔线数量校验:疑似分隔线也计入总数,避免"修好格式后数量突变"的接力式诊断
    const expected = expectedSeparators(kind);
    const separatorTotal = separators.length + suspectSeparators.length;
    if (separatorTotal !== expected) {
        const lastLine = Math.max(0, lines.length - 1);
        invalidLines.push({
            line: lastLine, text: lines[lastLine],
            reason: `"${kind}" 文件需要 ${expected} 个 "---" 分隔线,当前有 ${separatorTotal} 个(含疑似 ${suspectSeparators.length} 个)`,
            severity: "error"
        });
    }

    log.trace(`结构解析完成:${document.uri},${sections.length} 段 / ${fields.length} 字段 / ${invalidLines.length} 结构问题`);
    return {
        kind, version: document.version, lines, separators, suspectSeparators,
        sections, comments, invalidLines
    };
}

/** 补全上下文:判断光标所在行的位置属于哪个阶段 */
export type CompletionContextKind = "type" | "name" | "default" | "none";

export function getCompletionContext(lineBefore: string): CompletionContextKind {
    // 已出现 "=" → 默认值/常量值位
    if (lineBefore.includes("=")) {
        return "default";
    }
    const stripped = lineBefore.replace(/[a-zA-Z0-9_/]*$/, "");
    const s = stripped.trim();
    // 行首或 @optional 修饰符后 → 类型位
    if (s === "" || /^@optional$/i.test(s)) {
        return "type";
    }
    // 已有一个类型(可带数组)且后面跟空白 → 名称位
    if (/^\s*(?:@optional\s+)?[a-zA-Z0-9_/]+(?:\[[^\]]*\])?\s+$/.test(stripped)) {
        return "name";
    }
    return "none";
}
