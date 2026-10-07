/**
 * macro-params — xacro 宏 params 属性全语法解析器(XG2,2026-09-24)。
 *
 * 设计:设计/xacro/14 §1.2;语法事实源:设计/xacro/13 §3.2。
 * 官方实现(ros/xacro xacro/__init__.py,ros2 分支):
 *   default_value = r'''\$\{.*?\}|\$\(.*?\)|(?:'.*?'|\".*?\"|[^\s'\"]+)+|'''
 *   re_macro_arg  = r'^\s*([^\s:=]+?)\s*:?=\s*(\^\|?)?(default_value)(?:\s+|$)(.*)'
 *   parse_macro_arg(s):正则命中 → 带 `=` 的参数(name/:= 或 =/^/^|/默认值);未命中 →
 *   **空白切分兜底:第一个空白 token 整体作为参数名**(官方行为,含 `a:='x`/`a:b` 等病态)。
 *
 * 关键官方语义(逐条核对源码得出,静态模型按此镜像):
 *  - `*块`/`**字典` 的星号是参数名一部分(params 列表存 `*origin`);调用点每个块参数
 *    按声明序消费一个子元素(`**` 不"收集全部剩余",区别仅在其 insert_block 为 content-only)。
 *  - `a:=`(空默认)经 defaultmap 存 (None,None) → 调用时不生效 → **等效必填**。
 *  - 默认值首字符为未闭合 `${`/`$(` 时,退化为字面裸串(如 `a:=${b c` → 默认值 `${b`)。
 *  - 引号串默认不可跨行(`'.*?'` 的 `.` 不匹配换行)。
 *
 * 定位:纯函数、无状态;偏移 = base + params 值内相对偏移。
 */
export type MacroParamKind = "scalar" | "block" | "dict";
export type MacroParamDefaultKind = "none" | "value" | "forward" | "forward-or-default";

export interface MacroParam {
    /** 官方参数名(含 * / ** 前缀,与官方 params 列表一致) */
    name: string;
    kind: MacroParamKind;
    defaultKind: MacroParamDefaultKind;
    /** 默认值原文(:= 后原文,引号串含引号;^| 的回退值)。defaultKind=none 时为 undefined */
    defaultValue?: string;
    from: number;                // 整个参数 token(名字+默认值)绝对 offset
    to: number;                  // 排他
    nameFrom: number;            // 名字部分(不含 */** 前缀)起始 offset
    nameTo: number;              // 名字部分结束 offset
}

const isWs = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";

/** 默认值是否为官方语义下的"有效默认" */
function effectiveDefaultKind(kind: MacroParamDefaultKind, rawDefault: string): MacroParamDefaultKind {
    if (kind === "value" && rawDefault.length === 0) {
        return "none"; // 官方 defaultmap 存 (None,None) → 调用时不生效 → 等效必填
    }
    if (kind === "forward-or-default" && (rawDefault ?? "").length === 0) {
        return "forward"; // 官方 `a:=^|` 存 (a,None) ≡ `a:=^`
    }
    return kind;
}

/**
 * 解析宏 params 属性值全量参数。
 * @param paramsText params 属性值原文(未求值)
 * @param base params 值首字符在文档中的绝对 offset
 */
export function parseMacroParams(paramsText: string, base = 0): MacroParam[] {
    const out: MacroParam[] = [];
    const n = paramsText.length;
    let i = 0;

    while (i < n) {
        while (i < n && isWs(paramsText[i])) {
            i++;
        }
        if (i >= n) {
            break;
        }

        // ---- 正则路径:名字 [^\s:=]+ + 可选 (ws* :?= ws*) (^|?) 默认值 ----
        const nameStart = i;
        let nameEnd = i;
        while (nameEnd < n && paramsText[nameEnd] !== " " && paramsText[nameEnd] !== "\t"
            && paramsText[nameEnd] !== "\n" && paramsText[nameEnd] !== "\r"
            && paramsText[nameEnd] !== "\f" && paramsText[nameEnd] !== "\v"
            && paramsText[nameEnd] !== ":" && paramsText[nameEnd] !== "=") {
            nameEnd++;
        }

        let k = nameEnd;
        while (k < n && isWs(paramsText[k])) {
            k++;
        }
        let sepEnd = -1;
        if (paramsText[k] === ":" && paramsText[k + 1] === "=") {
            sepEnd = k + 2;
        } else if (paramsText[k] === "=") {
            sepEnd = k + 1;
        }

        if (nameEnd > nameStart && sepEnd >= 0) {
            k = sepEnd;
            while (k < n && isWs(paramsText[k])) {
                k++;
            }
            // (\^\|?)? —— ^ 与 | 之间不跳空白(官方 \s* 仅在 :?= 之后)
            let dk: MacroParamDefaultKind = "value";
            if (paramsText[k] === "^") {
                k++;
                if (paramsText[k] === "|") {
                    k++;
                    dk = "forward-or-default";
                } else {
                    dk = "forward";
                }
            }
            // 默认值:先试 ${...} / $(...),再试 (?:'.*?'|".*?"|[^\s'"]+)+ 循环,空亦合法
            const defStart = k;
            if (paramsText.startsWith("${", k)) {
                const close = paramsText.indexOf("}", k + 2);
                if (close >= 0) {
                    k = close + 1;
                }
            } else if (paramsText.startsWith("$(", k)) {
                const close = paramsText.indexOf(")", k + 2);
                if (close >= 0) {
                    k = close + 1;
                }
            }
            // 拼接组循环(引号串须同行闭合;裸串排除空白与引号)
            while (k < n && !isWs(paramsText[k])) {
                const ch = paramsText[k];
                if (ch === "'" || ch === '"') {
                    const close = paramsText.indexOf(ch, k + 1);
                    const nl = paramsText.indexOf("\n", k + 1);
                    if (close < 0 || (nl >= 0 && nl < close)) {
                        break; // 引号串未(同行)闭合 → 该迭代失败
                    }
                    k = close + 1;
                    continue;
                }
                // 裸串 [^\s'"]+
                let j = k;
                while (j < n && !isWs(paramsText[j]) && paramsText[j] !== "'" && paramsText[j] !== '"') {
                    j++;
                }
                k = j;
            }
            // 官方 (?:\s+|$):默认值后必须空白或串尾;失败 → 整体退兜底
            if (k < n && !isWs(paramsText[k])) {
                // 落兜底:整 token 为名
                let j = nameStart;
                while (j < n && !isWs(paramsText[j])) {
                    j++;
                }
                out.push(makeParam(paramsText, nameStart, j, j, base));
                i = j;
                continue;
            }
            const rawDefault = paramsText.slice(defStart, k);
            out.push(makeParam(paramsText, nameStart, nameEnd, k, base, dk, rawDefault));
            i = k;
            continue;
        }

        // ---- 兜底路径(官方 parse_macro_arg else 分支):整 token 作为参数名 ----
        let j = nameStart;
        while (j < n && !isWs(paramsText[j])) {
            j++;
        }
        out.push(makeParam(paramsText, nameStart, j, j, base));
        i = j;
    }
    return out;
}

/**
 * @param nameEnd 名字区间结束(正则路径=名字 run 结束,不含 :=default;兜底路径=token 结束)
 * @param tokenEnd 整个参数 token 结束(含默认值)
 */
function makeParam(text: string, nameStart: number, nameEnd: number, tokenEnd: number, base: number,
    dk?: MacroParamDefaultKind, rawDefault?: string): MacroParam {
    const name = text.slice(nameStart, nameEnd);
    const kind: MacroParamKind = name.startsWith("**") ? "dict" : name.startsWith("*") ? "block" : "scalar";
    const stars = name.length - name.replace(/^\*+/, "").length;
    const finalKind: MacroParamDefaultKind = dk ? effectiveDefaultKind(dk, rawDefault ?? "") : "none";
    const hasValue = (finalKind === "value" || finalKind === "forward-or-default") && !!rawDefault && rawDefault.length > 0;
    return {
        name,
        kind,
        defaultKind: finalKind,
        defaultValue: hasValue ? rawDefault : undefined,
        from: base + nameStart,
        to: base + tokenEnd,
        nameFrom: base + nameStart + stars,
        nameTo: base + nameStart + Math.max(stars, name.length)
    };
}
