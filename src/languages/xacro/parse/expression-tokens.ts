/**
 * expression-tokens — `${}` 表达式内部 python-ish 分词器(XG3,2026-09-24)。
 *
 * 设计:设计/xacro/14 §1.3;语义边界:设计/xacro/13 §5。
 * 定位:语法层,**不求值**。产出 token 流 + 被引用属性名候选集(refIdents),
 * 供 use-def 标定、D5 诊断、表达式内导航与补全复用。
 *
 * refIdents 提取规则(语法层近似,宁缺勿滥):
 *  - 仅 kind=ident(调用位 ident 已标为 call;关键字已标为 op);
 *  - 排除点链尾(前一 token 为 `.`:math.pi / props.a / ns.prop 的尾段);
 *  - 排除关键字实参(后一 token 为单 `=`:dict(a=1));
 *  - 排除官方求值上下文白名单(13 §5):内建直曝名 + math/python/xacro 命名空间;
 *  - 含 for/lambda 时 refIdents 含循环变量等假阳性 → hasControlFlow=true 标记,
 *    诊断类消费方(D5)应跳过,导航/补全可照常用。
 * 字符串:单双引号 + 反斜杠转义 + 三引号;f/r/b/u 前缀并入字符串 token;
 * 普通串跨行或未闭合、括号失衡 → hasSyntaxIssue。
 */
export type ExprTokenKind = "ident" | "number" | "string" | "op" | "punct" | "call" | "comment";

export interface ExprToken {
    kind: ExprTokenKind;
    from: number;            // base + 相对偏移
    to: number;
    text: string;
}

export interface ExprScanResult {
    tokens: ExprToken[];
    refIdents: string[];     // 去重后的属性引用候选(文档序)
    hasSyntaxIssue: boolean; // 引号未闭合 / 括号失衡(诊断降级提示,不做 Python 校验)
    hasControlFlow: boolean; // 含 for/lambda(推导式/lambda)——refIdents 有循环变量假阳性
}

/** 官方求值上下文直曝名单(13 §5):内建 + 数学函数/常量 + xacro 弃用直曝 */
export const EVAL_BARE_IDENTS: ReadonlySet<string> = new Set([
    // 内建直曝
    "list", "dict", "map", "len", "str", "float", "int", "bool",
    "True", "False", "None",
    "min", "max", "round",
    // math.* 无下划线名直曝
    "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt", "ceil", "comb",
    "copysign", "cos", "cosh", "degrees", "dist", "e", "erf", "erfc", "exp", "expm1",
    "fabs", "factorial", "floor", "fmod", "frexp", "fsum", "gamma", "gcd", "hypot",
    "inf", "isclose", "isfinite", "isinf", "isnan", "isqrt", "lcm", "ldexp", "lgamma",
    "log", "log10", "log1p", "log2", "modf", "nan", "nextafter", "perm", "pi", "pow",
    "prod", "radians", "remainder", "sin", "sinh", "sqrt", "tan", "tanh", "tau",
    "trunc", "ulp",
    // 2.0.7 时代 python 命名空间直曝(带弃用告警,仍可用)
    "sorted", "range", "abs", "all", "any", "complex", "divmod", "enumerate", "filter",
    "frozenset", "hash", "isinstance", "issubclass", "ord", "repr", "reversed", "slice",
    "set", "sum", "tuple", "type", "vars", "zip",
    // xacro.* 弃用直曝
    "load_yaml", "abs_filename", "dotify", "arg", "message", "warning", "error", "fatal"
]);

/** 命名空间头(点链头,不作为属性引用) */
export const EVAL_NAMESPACES: ReadonlySet<string> = new Set(["math", "python", "xacro"]);

/** Python 关键字(eval 表达式内合法出现,非属性引用) */
const PY_KEYWORDS: ReadonlySet<string> = new Set([
    "and", "or", "not", "in", "is", "if", "else", "elif", "for", "while", "lambda",
    "True", "False", "None", "pass", "del", "return", "yield", "global", "nonlocal",
    "import", "from", "as", "with", "try", "except", "finally", "raise", "assert",
    "async", "await", "class", "def"
]);

const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isWsChar = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
const FSTRING_PREFIXES: ReadonlySet<string> = new Set([
    "f", "F", "r", "R", "b", "B", "u", "U",
    "fr", "Fr", "fR", "FR", "rf", "rF", "Rf", "RF",
    "br", "Br", "bR", "BR", "rb", "rB", "Rb", "RB"
]);
const OP_CHARS = "+-*/%&|^~<>=!";

/**
 * 分词表达式原文(`${}` 定界符内内容;`$(eval ...)` 内容亦可)。
 * @param expr 表达式原文
 * @param base 表达式首字符在文档中的绝对 offset
 */
export function scanExpression(expr: string, base = 0): ExprScanResult {
    const tokens: ExprToken[] = [];
    const n = expr.length;
    let i = 0;
    let hasSyntaxIssue = false;
    let hasControlFlow = false;
    let depth = 0; // 括号平衡(仅计数)

    const push = (kind: ExprTokenKind, from: number, to: number): void => {
        tokens.push({ kind, from: base + from, to: base + to, text: expr.slice(from, to) });
    };

    while (i < n) {
        const ch = expr[i];
        if (isWsChar(ch)) {
            i++;
            continue;
        }
        if (ch === "#") {
            let j = i;
            while (j < n && expr[j] !== "\n") {
                j++;
            }
            push("comment", i, j);
            i = j;
            continue;
        }
        if (ch === "'" || ch === '"') {
            const r = scanString(expr, i, i, push);
            if (r.unterminated) {
                hasSyntaxIssue = true;
            }
            i = r.next;
            continue;
        }
        if (isIdentStart(ch)) {
            let j = i + 1;
            while (j < n && isIdentChar(expr[j])) {
                j++;
            }
            const word = expr.slice(i, j);
            // f-string 前缀:前缀词紧贴引号(python 不允许中间空白)→ 并入字符串 token
            if (FSTRING_PREFIXES.has(word) && (expr[j] === "'" || expr[j] === '"')) {
                const r = scanString(expr, j, i, push);
                if (r.unterminated) {
                    hasSyntaxIssue = true;
                }
                i = r.next;
                continue;
            }
            if (PY_KEYWORDS.has(word)) {
                if (word === "for" || word === "lambda") {
                    hasControlFlow = true;
                }
                push("op", i, j);
            } else {
                // 调用位:ident 后(可隔空白)紧跟 '('
                let m = j;
                while (m < n && isWsChar(expr[m])) {
                    m++;
                }
                push(expr[m] === "(" ? "call" : "ident", i, j);
            }
            i = j;
            continue;
        }
        if (isDigit(ch) || (ch === "." && isDigit(expr[i + 1]))) {
            const j = scanNumber(expr, i);
            push("number", i, j);
            i = j;
            continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") {
            depth++;
            push("punct", i, i + 1);
            i++;
            continue;
        }
        if (ch === ")" || ch === "]" || ch === "}") {
            depth--;
            push("punct", i, i + 1);
            i++;
            continue;
        }
        if (ch === "." || ch === "," || ch === ":" || ch === ";") {
            push("punct", i, i + 1);
            i++;
            continue;
        }
        // 运算符:连续运算符字符合并为一个 token
        let j = i;
        while (j < n && OP_CHARS.includes(expr[j])) {
            j++;
        }
        push("op", i, Math.max(j, i + 1));
        i = Math.max(j, i + 1);
    }

    if (depth !== 0) {
        hasSyntaxIssue = true;
    }

    // refIdents 提取(token 流;空白不产 token,相邻即显著)
    const refIdents: string[] = [];
    const seen = new Set<string>();
    for (let idx = 0; idx < tokens.length; idx++) {
        const t = tokens[idx];
        if (t.kind !== "ident") {
            continue;
        }
        const prev = idx > 0 ? tokens[idx - 1] : undefined;
        if (prev && prev.kind === "punct" && prev.text === "." && prev.to === t.from) {
            continue; // 点链尾
        }
        const next = idx + 1 < tokens.length ? tokens[idx + 1] : undefined;
        if (next && next.kind === "op" && next.text === "=") {
            continue; // 关键字实参 dict(a=1)
        }
        if (EVAL_BARE_IDENTS.has(t.text) || EVAL_NAMESPACES.has(t.text)) {
            continue; // 内建/命名空间
        }
        if (!seen.has(t.text)) {
            seen.add(t.text);
            refIdents.push(t.text);
        }
    }

    return { tokens, refIdents, hasSyntaxIssue, hasControlFlow };
}

/** 数字字面量:十进制/十六进制/小数/指数 */
function scanNumber(expr: string, i: number): number {
    const n = expr.length;
    if (expr.startsWith("0x", i) || expr.startsWith("0X", i)) {
        let j = i + 2;
        while (j < n && /[0-9a-fA-F]/.test(expr[j])) {
            j++;
        }
        return j;
    }
    let j = i;
    while (j < n && isDigit(expr[j])) {
        j++;
    }
    if (expr[j] === ".") {
        j++;
        while (j < n && isDigit(expr[j])) {
            j++;
        }
    }
    if (expr[j] === "e" || expr[j] === "E") {
        let m = j + 1;
        if (expr[m] === "+" || expr[m] === "-") {
            m++;
        }
        if (isDigit(expr[m])) {
            j = m;
            while (j < n && isDigit(expr[j])) {
                j++;
            }
        }
    }
    return j;
}

/**
 * 字符串扫描。
 * @param quoteAt 引号位置(prefixStart < quoteAt 时前缀一并并入 token)
 * @returns next=新索引;unterminated=普通串跨行或串未闭合
 */
function scanString(expr: string, quoteAt: number, prefixStart: number,
    push: (kind: ExprTokenKind, from: number, to: number) => void): { next: number; unterminated: boolean } {
    const n = expr.length;
    const quote = expr[quoteAt];
    const triple = quote.repeat(3);
    const isTriple = expr.startsWith(triple, quoteAt);
    const closer = isTriple ? triple : quote;
    let k = quoteAt + closer.length;
    while (k < n) {
        if (expr[k] === "\\") {
            k += 2; // 反斜杠转义跳过下一字符
            continue;
        }
        if (!isTriple && expr[k] === "\n") {
            push("string", prefixStart, k);
            return { next: k, unterminated: true }; // 普通串不可跨行
        }
        if (expr.startsWith(closer, k)) {
            push("string", prefixStart, k + closer.length);
            return { next: k + closer.length, unterminated: false };
        }
        k++;
    }
    push("string", prefixStart, n);
    return { next: n, unterminated: true };
}
