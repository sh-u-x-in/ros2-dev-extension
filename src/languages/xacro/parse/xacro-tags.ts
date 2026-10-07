/**
 * xacro-tags — xacro 固定标签模型与官方常量表(XG4,2026-09-24)。
 *
 * 设计:设计/xacro/14 §1.4;语法事实源:设计/xacro/13 §3/§4/§5。
 * 官方分发链(eval_all)按 tagName 字符串精确比较,固定标签恰 10 个;
 * `element_inject` 非官方(GitHub 全库搜索 0 命中,2026-09-24 核实)——旧模块
 * XACRO_KEYWORDS 的幽灵词条由此修正。
 * 前缀必须字面为 `xacro:`(2.0.8 起无前缀标签不再处理);大小写敏感(00 §7-4)。
 */

export type FixedTag =
    | "property" | "macro" | "insert_block" | "if" | "unless"
    | "include" | "arg" | "element" | "attribute" | "call";

export const FIXED_TAGS: readonly FixedTag[] = [
    "property", "macro", "insert_block", "if", "unless",
    "include", "arg", "element", "attribute", "call"
];

/** xacro 内建标签名集合(去前缀裸名)——X-F3 单一来源(原 provider-utils/diagnostic-provider 双份,
 *  且含非官方词条 element_inject,2026-09-24 修正;消费方:宏调用判定过滤) */
export const XACRO_KEYWORDS: ReadonlySet<string> = new Set(FIXED_TAGS);

export interface TagAttrSpec {
    required: string[];
    optional: string[];
}

/** 各固定标签属性签名(官方 check_attrs/reqd_attrs 调用逐条对照) */
export const TAG_ATTRS: Record<FixedTag, TagAttrSpec> = {
    property: { required: ["name"], optional: ["value", "default", "remove", "scope", "lazy_eval"] },
    macro: { required: ["name"], optional: ["params"] },
    insert_block: { required: ["name"], optional: [] },
    if: { required: ["value"], optional: [] },
    unless: { required: ["value"], optional: [] },
    include: { required: ["filename"], optional: ["ns", "optional"] },
    arg: { required: ["name", "default"], optional: [] },
    element: { required: ["xacro:name"], optional: [] },
    attribute: { required: ["name", "value"], optional: [] },
    call: { required: ["macro"], optional: [] }
};

/** tagName → 固定标签;无 `xacro:` 前缀或非固定名 → null(无前缀按普通元素,2.0.8 起) */
export function fixedTagOf(tagName: string): FixedTag | null {
    if (!tagName.startsWith("xacro:")) {
        return null;
    }
    const rest = tagName.slice(6);
    return (FIXED_TAGS as readonly string[]).includes(rest) ? rest as FixedTag : null;
}

/** tagName → 宏名(去 `xacro:` 前缀,可含点);固定标签/无前缀 → null */
export function macroNameOf(tagName: string): string | null {
    if (!tagName.startsWith("xacro:")) {
        return null;
    }
    const rest = tagName.slice(6);
    return rest.length > 0 && !(FIXED_TAGS as readonly string[]).includes(rest) ? rest : null;
}

/** $() 替换参数命令集:官方 commands 表(find/env/optenv/dirname/arg)+ eval 特例 + xacro 原生 cwd。
 *  find-pkg-share 非官方(launch 专属),扩展宽容识别、不报未知命令。 */
export const SUBST_COMMANDS: ReadonlySet<string> = new Set([
    "find", "find-pkg-share", "arg", "env", "optenv", "dirname", "eval", "cwd"
]);

export interface EvalGlobalInfo {
    kind: "function" | "constant" | "namespace";
    detail: string;
}

/** 官方 `${}` 求值上下文(XG7 补全数据源;完整名单见 13 §5) */
export const EVAL_GLOBALS: ReadonlyMap<string, EvalGlobalInfo> = buildEvalGlobals();

function buildEvalGlobals(): Map<string, EvalGlobalInfo> {
    const m = new Map<string, EvalGlobalInfo>();
    const fn = (detail: string): EvalGlobalInfo => ({ kind: "function", detail });
    const cst = (detail: string): EvalGlobalInfo => ({ kind: "constant", detail });
    m.set("math", { kind: "namespace", detail: "数学命名空间(math.sin(x)、math.pi)" });
    m.set("python", { kind: "namespace", detail: "python 命名空间(python.sorted(...))" });
    m.set("xacro", { kind: "namespace", detail: "xacro 命名空间(xacro.load_yaml(...))" });
    // 内建直曝
    m.set("list", fn("list(iterable) → 列表"));
    m.set("dict", fn("dict(a=1, b=2) → 字典(${ } 内禁裸 {},字典用它)"));
    m.set("map", fn("map(f, seq) → 映射"));
    m.set("len", fn("len(seq) → 长度"));
    m.set("str", fn("str(x) → 字符串"));
    m.set("float", fn("float(x) → 浮点"));
    m.set("int", fn("int(x) → 整数"));
    m.set("bool", fn("bool(x) → 布尔(2.1.0 起)"));
    m.set("min", fn("min(a, b, ...) → 最小值"));
    m.set("max", fn("max(a, b, ...) → 最大值"));
    m.set("round", fn("round(x[, n]) → 四舍五入"));
    m.set("True", cst("真"));
    m.set("False", cst("假"));
    m.set("None", cst("空值"));
    // 常用数学直曝(全表见 expression-tokens EVAL_BARE_IDENTS)
    m.set("pi", cst("π = 3.14159...(math.pi 直曝)"));
    m.set("e", cst("自然常数 e(math.e 直曝)"));
    m.set("radians", fn("radians(deg) → 角度转弧度"));
    m.set("degrees", fn("degrees(rad) → 弧度转角度"));
    m.set("sin", fn("sin(x) → 正弦(弧度)"));
    m.set("cos", fn("cos(x) → 余弦(弧度)"));
    m.set("tan", fn("tan(x) → 正切(弧度)"));
    m.set("sqrt", fn("sqrt(x) → 平方根"));
    m.set("hypot", fn("hypot(x, y) → 欧氏范数"));
    m.set("abs", fn("abs(x) → 绝对值(python.abs 直曝,告警弃用)"));
    m.set("sorted", fn("sorted(seq) → 排序(python.sorted 直曝,告警弃用)"));
    m.set("range", fn("range(n) → 序列(python.range 直曝,告警弃用)"));
    m.set("load_yaml", fn("load_yaml(file) → 加载 YAML 为可点访问结构"));
    m.set("abs_filename", fn("abs_filename(spec) → 相对当前文件的绝对路径"));
    m.set("dotify", fn("dotify(d) → 包装字典支持点访问"));
    m.set("arg", fn("arg(name) → 读 xacro 参数(xacro.arg)"));
    m.set("message", fn("message(...) → 打印信息(返回空串可内嵌)"));
    m.set("warning", fn("warning(...) → 打印警告(返回空串可内嵌)"));
    m.set("error", fn("error(...) → 打印错误(返回空串可内嵌)"));
    m.set("fatal", fn("fatal(...) → 打印并终止处理"));
    return m;
}
