/**
 * xacro-lexer — xacro `$` 层词法器(XG1,2026-09-24)。
 *
 * 设计:设计/xacro/14 §1.1;语法事实源:设计/xacro/13 §2(官方 LEXER 逐字节语义)。
 * 官方词法(ros/xacro xacro/__init__.py):
 *   DOLLAR_DOLLAR_BRACE = ^\$\$+(\{|\()   $$( / $${ 转义——剥第一个 $,其余为字面
 *   EXPR                = ^\$\{[^\}]*\}   ${...}(内禁裸 },到第一个 } 截止→无字典字面量/无嵌套)
 *   EXTENSION           = ^\$\([^\)]*\)   $(...)(内容先经 ${} 展开;$() 内再嵌裸 $ 为官方硬错)
 *   TEXT                = 其余(裸 $ 永为字面量,永不报错)
 *
 * 编辑器裁定(14 §1.1):未闭合 ${ / $( 时 token 照常产出(kind 不变、content 到段尾)+
 * issue 记录——诊断用 issue(官方等价错误),补全/导航用 token(编辑中态仍可用)。
 * $() 内允许 ${...}(官方先展开),仅裸 $ 记 dollar-in-extension。
 *
 * 定位:纯函数、无状态、无 vscode 依赖;偏移一律"base + 段内相对偏移"= 文档绝对 offset。
 */
export type DollarTokenKind = "text" | "expr" | "extension" | "ss-escape";

export interface DollarToken {
    kind: DollarTokenKind;
    from: number;            // 文档绝对 offset(含定界符)
    to: number;              // 排他
    content: string;         // expr/extension:定界符内原文;ss-escape:剥 $ 后字面(含括字符);text:原文
    contentFrom: number;     // content 区间(text 即 [from,to);ss-escape 即 [from+1,to))
    contentTo: number;
    unclosed?: boolean;      // ${ / $( 未闭合(编辑中态)
}

export interface LexIssue {
    kind: "unclosed-expr" | "unclosed-extension" | "dollar-in-extension";
    from: number;
    to: number;
}

export interface DollarLexResult {
    tokens: DollarToken[];
    issues: LexIssue[];
}

/**
 * 对一段文本(XML 属性值或文本节点)做 `$` 层扫描。
 * @param s 段文本
 * @param base 段起点在文档中的绝对 offset(缺省 0)
 */
export function lexDollar(s: string, base = 0): DollarLexResult {
    const tokens: DollarToken[] = [];
    const issues: LexIssue[] = [];
    const n = s.length;

    const pushText = (from: number, to: number): void => {
        tokens.push({
            kind: "text", from: base + from, to: base + to,
            content: s.slice(from, to), contentFrom: base + from, contentTo: base + to
        });
    };

    /** $() 内容里裸 $ 记 issue(${} 组是合法先展开,跳过其 }) */
    const checkDollarInExtension = (from: number, to: number): void => {
        let k = from;
        while (k < to) {
            if (s[k] === "$") {
                if (s[k + 1] === "{") {
                    const close = s.indexOf("}", k + 2);
                    k = close >= 0 && close < to ? close + 1 : to;
                    continue;
                }
                issues.push({ kind: "dollar-in-extension", from: base + k, to: base + k + 1 });
                k += 1;
                continue;
            }
            k += 1;
        }
    };

    let i = 0;
    while (i < n) {
        if (s[i] !== "$") {
            let j = i + 1;
            while (j < n && s[j] !== "$") {
                j++;
            }
            pushText(i, j);
            i = j;
            continue;
        }
        // 连续 $ 的 run(run≥2 且后随 {( → 转义;否则按单 $ 分派)
        let run = 1;
        while (i + run < n && s[i + run] === "$") {
            run++;
        }
        const after = i + run < n ? s[i + run] : "";
        if (run >= 2 && (after === "{" || after === "(")) {
            const end = i + run + 1;
            tokens.push({
                kind: "ss-escape", from: base + i, to: base + end,
                content: s.slice(i + 1, end), contentFrom: base + i + 1, contentTo: base + end
            });
            i = end;
            continue;
        }
        if (after === "{") {
            const close = s.indexOf("}", i + run);
            if (close >= 0) {
                const end = close + 1;
                tokens.push({
                    kind: "expr", from: base + i, to: base + end,
                    content: s.slice(i + 2, close), contentFrom: base + i + 2, contentTo: base + close
                });
                i = end;
            } else {
                issues.push({ kind: "unclosed-expr", from: base + i, to: base + n });
                tokens.push({
                    kind: "expr", from: base + i, to: base + n,
                    content: s.slice(i + 2), contentFrom: base + i + 2, contentTo: base + n, unclosed: true
                });
                i = n;
            }
            continue;
        }
        if (after === "(") {
            const close = s.indexOf(")", i + run);
            if (close >= 0) {
                const end = close + 1;
                checkDollarInExtension(i + 2, close);
                tokens.push({
                    kind: "extension", from: base + i, to: base + end,
                    content: s.slice(i + 2, close), contentFrom: base + i + 2, contentTo: base + close
                });
                i = end;
            } else {
                issues.push({ kind: "unclosed-extension", from: base + i, to: base + n });
                checkDollarInExtension(i + 2, n);
                tokens.push({
                    kind: "extension", from: base + i, to: base + n,
                    content: s.slice(i + 2), contentFrom: base + i + 2, contentTo: base + n, unclosed: true
                });
                i = n;
            }
            continue;
        }
        // 裸 $(含 $$ 后非 {(、段尾孤立 $):字面文本,到下一个 $(或串尾)
        let j = i + 1;
        while (j < n && s[j] !== "$") {
            j++;
        }
        pushText(i, j);
        i = j;
    }
    return { tokens, issues };
}

/** 快速判定一段文本是否含任何 $ 构造(text-only 时调用方可跳过后续处理) */
export function hasDollarConstruct(s: string): boolean {
    return s.indexOf("$") >= 0;
}
