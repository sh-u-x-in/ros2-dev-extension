/**
 * @file paths.ts
 * 极简 posix 路径工具(install 真值域内部统一使用 '/' 语义)。
 *
 * 为什么不用 node path:本域的分析对象是 ROS 工作区(install/build/src)的
 * 生成物路径,语义恒为 posix;且测试用 MemoryFs 以字符串为键,若混入 Windows
 * 分隔符会出现"同一个文件两个键"。故此处自持一套最小实现,避免平台差异。
 * 纯 TS,零依赖,可无头测试。
 */

/** 拼接并规范化(结果不含末尾斜杠,根除外) */
export function pjoin(...parts: string[]): string {
    return pnormalize(parts.filter((p) => p !== "").join("/"));
}

/** 规范化:折叠 '//'、'.'、'..'(不去根) */
export function pnormalize(p: string): string {
    if (!p) {
        return ".";
    }
    const abs = p.startsWith("/");
    const out: string[] = [];
    for (const seg of p.split("/")) {
        if (seg === "" || seg === ".") {
            continue;
        }
        if (seg === "..") {
            if (out.length > 0 && out[out.length - 1] !== "..") {
                out.pop();
            } else if (!abs) {
                out.push("..");
            }
            continue;
        }
        out.push(seg);
    }
    const body = out.join("/");
    if (abs) {
        return "/" + body;
    }
    return body === "" ? "." : body;
}

/** 是否为绝对路径 */
export function pisAbsolute(p: string): boolean {
    return p.startsWith("/");
}

/** 父目录('/a' → '/',相对单段 → '.') */
export function pdirname(p: string): string {
    const n = pnormalize(p);
    const i = n.lastIndexOf("/");
    if (i < 0) {
        return ".";
    }
    if (i === 0) {
        return "/";
    }
    return n.slice(0, i);
}

/** 末段名 */
export function pbasename(p: string): string {
    const n = pnormalize(p);
    const i = n.lastIndexOf("/");
    return i < 0 ? n : n.slice(i + 1);
}

/** 扩展名(含点,小写保留原样;无扩展名返回 "") */
export function pextname(p: string): string {
    const b = pbasename(p);
    const i = b.lastIndexOf(".");
    if (i <= 0) {
        return "";
    }
    return b.slice(i);
}

/** 绝对化:相对路径以 base 为基准 */
export function presolve(base: string, p: string): string {
    if (pisAbsolute(p)) {
        return pnormalize(p);
    }
    return pnormalize(pjoin(base, p));
}

/** child 相对 parent 的路径(parent 不是前缀时返回 undefined) */
export function prelative(child: string, parent: string): string | undefined {
    const c = pnormalize(child);
    const p = pnormalize(parent);
    if (c === p) {
        return "";
    }
    const prefix = p.endsWith("/") ? p : p + "/";
    if (c.startsWith(prefix)) {
        return c.slice(prefix.length);
    }
    return undefined;
}

/** 路径分段 */
export function psplit(p: string): string[] {
    const n = pnormalize(p);
    return n === "/" ? [""] : n.split("/").filter((s) => s !== "");
}

/**
 * 安装侧路径归一化键(2026-09-14,P0-1:按可执行绝对路径反查条目)。
 *
 * 规则(逐条对应消费场景):
 *   1. `\` → `/`:Windows 清单/进程命令行里的路径也要能命中(本域统一 posix 语义);
 *   2. `pnormalize`:折叠 `//`、`.`、`..`,去尾斜杠 —— 同一文件的多种写法归一;
 *   3. **仅 Windows 形态(盘符开头)统一小写**:Linux 大小写敏感,绝不能整体小写,
 *      否则 `/ws/A` 与 `/ws/a` 会被误并成一个键。
 * 不做 realpath(本域 FsLike 有意不含 readlink;软链别名改由 build 内可推导的
 * `JumpEntry.buildPath` 提供,见 center/query.ts 的 byInstallPath)。
 */
export function normalizeInstallKey(p: string): string {
    const posix = pnormalize(p.replace(/\\/g, "/"));
    return /^[A-Za-z]:\//.test(posix) ? posix.toLowerCase() : posix;
}
