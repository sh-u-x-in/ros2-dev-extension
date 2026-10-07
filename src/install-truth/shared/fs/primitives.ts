/**
 * @file shared/fs/primitives.ts
 * 注入式文件系统原语(build-only 起步时只裁到"目录/文件/读文本"三件事)。
 *
 * 为什么保留注入式:单测可在任意平台复现(不依赖真实 ROS 工作区),且真实实现只有一处。
 * 历史说明:原版还有 ELF 头/shebang 嗅探(install 侧双版本适配用,build-only 不需要,已删);
 * **2026-09-21 甲-1 把 lstat/readlink 请了回来** —— 软链就是安装机制本身,形态检测(link/
 * linkDomain/dangling/executable)必须靠它们,FsStat 带 kind/mode/mtimeMs(详见 shared/README.md)。
 *
 * 纯 TS,零依赖(node 实现仅用内置 fs),可无头测试。
 */

import { l10n } from "vscode";

import * as nodeFs from "fs";
import { pdirname, pjoin, pnormalize } from "../paths";

/** 文件系统条目静态信息 */
export interface FsStat {
    /** `stat` 跟随软链,只给 file/dir/other;`lstat` 才可能给 "link" */
    kind: "file" | "dir" | "link" | "other";
    /** 字节数(目录/未知为 0) */
    size: number;
    /**
     * 最后修改时刻(epoch 毫秒;未知为 0)。
     *
     * 2026-09-21 加入:`install.log` 这类**模式相关**的安装记录必须做**陈旧守卫**
     * (symlink 构建根本不写它 → 会残留自上一次实体构建),而守卫只能靠时间戳对齐(README §4.1)。
     */
    mtimeMs: number;
    /**
     * 权限位(chmod 语义;未知为 0)。
     *
     * 2026-09-21 加入 —— 判定"能不能直接执行"要用它,且**位置很关键**:
     *   · 实体条目 → 看自身(`lstat`)
     *   · 软链条目 → 软链自身的模式恒为 `lrwxrwxrwx`,**毫无意义**,必须看**目标**(`stat`)
     */
    mode: number;
}

/** 本域全部文件访问的唯一入口(实现可替换:真实 fs / 内存 fs) */
export interface FsLike {
    /** stat(**跟随软链**;悬空链 → undefined) */
    stat(p: string): Promise<FsStat | undefined>;
    /**
     * lstat(**不跟随软链**;软链本身可见,悬空也能看见 → `kind === "link"`)。
     *
     * 2026-09-21 加入:软链是"安装机制"本身(`--symlink-install`),而"软链失效"有三种
     * —— 悬空(目标被删/重建换位)、形态漂移(链↔拷贝)、目录链断裂 —— 只靠 `stat` 全部看不见
     * (悬空链会被静默跳过,伪装成"一切正常")。这是 README §2.2 意义上的**域内观察**。
     */
    lstat(p: string): Promise<FsStat | undefined>;
    /** 软链目标(**原样字符串**:不解析相对、不递归;非软链 → undefined) */
    readlink(p: string): Promise<string | undefined>;
    /** 目录项名(非目录/缺失 → undefined;软链指向目录时按目录处理) */
    readdir(p: string): Promise<string[] | undefined>;
    /** 读文本(超上限/二进制/缺失 → undefined) */
    readText(p: string, maxBytes?: number): Promise<string | undefined>;
}

/** 文本读取上限(2MB;build 下最大的文本是 CMakeCache/cmake_install,足够) */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** 遍历时的目录名黑名单 */
export const DEFAULT_SKIP_DIRS = [".git", "__pycache__", ".pytest_cache", "node_modules", ".cache"];

// ---------------------------------------------------------------------------
// node 实现(唯一使用真实 fs 的地方)
// ---------------------------------------------------------------------------

/** 真实文件系统实现(扩展宿主运行时用;零 vscode 依赖) */
export const nodeFsLike: FsLike = {
    async stat(p) {
        try {
            const st = await nodeFs.promises.stat(p);
            const kind: FsStat["kind"] = st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
            return { kind, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode };
        } catch {
            return undefined;
        }
    },
    async lstat(p) {
        try {
            const st = await nodeFs.promises.lstat(p);
            const kind: FsStat["kind"] = st.isSymbolicLink()
                ? "link"
                : st.isFile()
                  ? "file"
                  : st.isDirectory()
                    ? "dir"
                    : "other";
            return { kind, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode };
        } catch {
            return undefined;
        }
    },
    async readlink(p) {
        try {
            return await nodeFs.promises.readlink(p);
        } catch {
            return undefined;
        }
    },
    async readdir(p) {
        try {
            return await nodeFs.promises.readdir(p);
        } catch {
            return undefined;
        }
    },
    async readText(p, maxBytes = MAX_TEXT_BYTES) {
        try {
            const st = await nodeFs.promises.stat(p);
            if (!st.isFile() || st.size > maxBytes) {
                return undefined;
            }
            const buf = await nodeFs.promises.readFile(p);
            const text = buf.toString("utf8");
            return text.indexOf("\u0000") >= 0 ? undefined : text;
        } catch {
            return undefined;
        }
    },
};

// ---------------------------------------------------------------------------
// 内存实现(单测用)
// ---------------------------------------------------------------------------

interface MemEntry {
    kind: "file" | "dir" | "link";
    text?: string;
    bytes?: Uint8Array;
    /** 软链目标(原样保留,可相对) */
    target?: string;
    /** 权限位;缺省:文件 0o644、目录 0o755(软链恒 0o777 且无意义) */
    mode?: number;
    /** 最后修改时刻(测试可显式指定,用于陈旧残留夹具);缺省 0 */
    mtimeMs?: number;
}

/** 内存文件系统(键为规范化 posix 路径;不支持软链 —— build-only 不需要) */
export class MemoryFs implements FsLike {
    private readonly entries = new Map<string, MemEntry>();

    constructor() {
        this.entries.set("/", { kind: "dir" });
    }

    /** 写目录(mtimeMs 可选,用于陈旧残留夹具) */
    addDir(p: string, mtimeMs?: number): this {
        const n = pnormalize(p);
        this.ensureParents(n);
        if (!this.entries.has(n)) {
            this.entries.set(n, { kind: "dir", mtimeMs });
        }
        return this;
    }

    /** 写文本文件(mtimeMs 可选,用于陈旧残留夹具) */
    addFile(p: string, text: string, mtimeMs?: number): this {
        const n = pnormalize(p);
        this.ensureParents(n);
        this.entries.set(n, { kind: "file", text, mtimeMs });
        return this;
    }

    /** 写二进制文件(命中读取上限/含 NUL 时 readText 返回 undefined) */
    addBinary(p: string, bytes: Uint8Array, mtimeMs?: number): this {
        const n = pnormalize(p);
        this.ensureParents(n);
        this.entries.set(n, { kind: "file", bytes, mtimeMs });
        return this;
    }

    /** 写软链(2026-09-21:软链是安装机制本身,单测必须能造;目标可相对) */
    addLink(p: string, target: string, mtimeMs?: number): this {
        const n = pnormalize(p);
        this.ensureParents(n);
        this.entries.set(n, { kind: "link", target, mtimeMs });
        return this;
    }

    /** 设置权限位(2026-09-21:权限是甲-1 的判定输入之一 —— 实体看自身,软链看目标) */
    chmod(p: string, mode: number): this {
        const e = this.entries.get(pnormalize(p));
        if (e !== undefined) {
            e.mode = mode;
        }
        return this;
    }

    stat(p: string): Promise<FsStat | undefined> {
        const c = this.canonical(pnormalize(p), 0);
        if (c === undefined) {
            return Promise.resolve(undefined);
        }
        const e = this.entries.get(c);
        return Promise.resolve(e === undefined || e.kind === "link" ? undefined : this.plain(e));
    }

    lstat(p: string): Promise<FsStat | undefined> {
        const c = this.canonicalLeaf(pnormalize(p), 0);
        const e = c === undefined ? undefined : this.entries.get(c);
        if (e === undefined) {
            return Promise.resolve(undefined);
        }
        if (e.kind === "link") {
            return Promise.resolve({ kind: "link" as const, size: 0, mtimeMs: e.mtimeMs ?? 0, mode: 0o777 });
        }
        return Promise.resolve(this.plain(e));
    }

    readlink(p: string): Promise<string | undefined> {
        const c = this.canonicalLeaf(pnormalize(p), 0);
        const e = c === undefined ? undefined : this.entries.get(c);
        return Promise.resolve(e !== undefined && e.kind === "link" ? e.target : undefined);
    }

    readdir(p: string): Promise<string[] | undefined> {
        const c = this.canonical(pnormalize(p), 0);
        if (c === undefined) {
            return Promise.resolve(undefined);
        }
        const e = this.entries.get(c);
        if (!e || e.kind !== "dir") {
            return Promise.resolve(undefined);
        }
        const prefix = c === "/" ? "/" : c + "/";
        const out: string[] = [];
        for (const key of this.entries.keys()) {
            if (key === c || !key.startsWith(prefix)) {
                continue;
            }
            const rest = key.slice(prefix.length);
            if (rest !== "" && rest.indexOf("/") < 0) {
                out.push(rest);
            }
        }
        return Promise.resolve(out);
    }

    /**
     * **逐段**解析软链,得到真实条目路径(成环/悬空 → undefined)。
     *
     * 为什么必须逐段:`MemoryFs` 以**规范路径字符串**为键,而真实内核是逐级解析的。
     * 不逐段解析的话,`install/…/site-packages/py/sss.py`(`py` 是指向 build 的目录软链)
     * 会查不到 —— 而那正是 develop 模式"扩大"的通道,必须能穿过去。
     */
    private canonical(p: string, depth: number): string | undefined {
        if (depth > 32) {
            return undefined;
        }
        const abs = p.startsWith("/");
        const segs = p.split("/").filter((s) => s !== "");
        let cur = abs ? "/" : "";
        for (let i = 0; i < segs.length; i++) {
            cur = cur === "/" ? "/" + segs[i] : cur === "" ? segs[i] : cur + "/" + segs[i];
            const e = this.entries.get(cur);
            if (e !== undefined && e.kind === "link") {
                if (e.target === undefined) {
                    return undefined;
                }
                const t = e.target.startsWith("/") ? pnormalize(e.target) : pjoin(pdirname(cur), e.target);
                const rest = segs.slice(i + 1).join("/");
                return this.canonical(rest === "" ? t : pjoin(t, rest), depth + 1);
            }
        }
        return cur === "" ? "/" : cur;
    }

    /** 同 `canonical`,但**不解析最后一段**(`lstat` / `readlink` 要看见链本身) */
    private canonicalLeaf(p: string, depth: number): string | undefined {
        const n = pnormalize(p);
        const i = n.lastIndexOf("/");
        if (i <= 0) {
            return this.entries.has(n) ? n : this.canonical(n, depth);
        }
        const parent = this.canonical(n.slice(0, i), depth);
        if (parent === undefined) {
            return undefined;
        }
        const leaf = n.slice(i + 1);
        return parent === "/" ? "/" + leaf : parent + "/" + leaf;
    }

    private plain(e: MemEntry): FsStat {
        return {
            kind: e.kind,
            size: e.bytes ? e.bytes.length : (e.text ?? "").length,
            mtimeMs: e.mtimeMs ?? 0,
            mode: e.mode ?? (e.kind === "dir" ? 0o755 : 0o644),
        };
    }

    readText(p: string, maxBytes = MAX_TEXT_BYTES): Promise<string | undefined> {
        const e = this.entries.get(pnormalize(p));
        if (!e || e.kind !== "file") {
            return Promise.resolve(undefined);
        }
        if (e.bytes) {
            return Promise.resolve(undefined); // 二进制按原语契约返回 undefined
        }
        const text = e.text ?? "";
        if (text.length > maxBytes) {
            return Promise.resolve(undefined);
        }
        return Promise.resolve(text.indexOf("\u0000") >= 0 ? undefined : text);
    }

    private ensureParents(p: string): void {
        const idx = p.lastIndexOf("/");
        if (idx <= 0) {
            return;
        }
        const parent = p.slice(0, idx);
        if (!this.entries.has(parent)) {
            this.ensureParents(parent);
            this.entries.set(parent, { kind: "dir" });
        }
    }
}

// ---------------------------------------------------------------------------
// 组合原语
// ---------------------------------------------------------------------------

/** 是否文件 */
export async function isFile(fs: FsLike, p: string): Promise<boolean> {
    const st = await fs.stat(p);
    return st !== undefined && st.kind === "file";
}

/** 是否目录 */
export async function isDir(fs: FsLike, p: string): Promise<boolean> {
    const st = await fs.stat(p);
    return st !== undefined && st.kind === "dir";
}

/** 是否存在 */
export async function exists(fs: FsLike, p: string): Promise<boolean> {
    return (await fs.stat(p)) !== undefined;
}

/** 子目录列表(排序;缺失/非目录 → 空表) */
export async function listDirs(fs: FsLike, root: string): Promise<string[]> {
    const names = await fs.readdir(root);
    if (names === undefined) {
        return [];
    }
    const out: string[] = [];
    for (const name of names.slice().sort()) {
        const p = pjoin(root, name);
        if (await isDir(fs, p)) {
            out.push(p);
        }
    }
    return out;
}

/**
 * 递归文件遍历(目录名黑名单剪枝 + 深度上限防环)。
 * build-only 不判软链,故用深度上限兜底(FsLike 已裁掉 lstat/readlink)。
 */
export async function walkFiles(
    fs: FsLike,
    root: string,
    opts?: { skipDirs?: string[]; maxDepth?: number }
): Promise<string[]> {
    const skip = new Set(opts?.skipDirs ?? DEFAULT_SKIP_DIRS);
    const maxDepth = opts?.maxDepth ?? 24;
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > maxDepth) {
            return;
        }
        const names = await fs.readdir(dir);
        if (names === undefined) {
            return;
        }
        for (const name of names.slice().sort()) {
            if (skip.has(name)) {
                continue;
            }
            const p = pjoin(dir, name);
            const st = await fs.stat(p);
            if (st === undefined) {
                continue;
            }
            if (st.kind === "dir") {
                await walk(p, depth + 1);
            } else if (st.kind === "file") {
                out.push(p);
            }
        }
    };
    await walk(root, 0);
    return out;
}

/** 按 basename 找文件(用 walkFiles;build 下最典型的用法是找 link.txt) */
export async function findFilesByName(fs: FsLike, root: string, basename: string): Promise<string[]> {
    const all = await walkFiles(fs, root);
    return all.filter((f) => f.slice(f.lastIndexOf("/") + 1) === basename);
}

// ---------------------------------------------------------------------------
// 域包含性守卫(2026-09-21;不变式三的夹具,见 README §2.2 / §3)
// ---------------------------------------------------------------------------

/**
 * 只放行「**访问路径**」以 `roots` 之一开头的调用,其余一律拒绝。
 *
 * 判定用的是**访问字符串本身**,不看软链解析后的真实位置 —— 这正是「域包含性」的定义:
 *
 *   · `build/<pkg>/<pkg>/x.py`(经 `build/<pkg>/<pkg> -> src/<pkg>/<pkg>` 软链) → **放行**
 *     它是 **build 的内容**;develop 模式下"扩大"正是靠这条软链发生的,必须能读。
 *   · `<ws>/src/<pkg>/x.py`(直接访问)                                        → **拒绝**
 *     这是**越域取证**:记录说源在哪,不等于本域有权去 src 里核对。
 *
 * 用途:单测夹具。套在 `MemoryFs` / `nodeFsLike` 外面,即可把"本域从不越域"变成可执行断言。
 */
export function guardDomain(inner: FsLike, roots: string[]): FsLike {
    const norm = roots.map((r) => pnormalize(r).replace(/\/+$/, ""));
    const allowed = (p: string): boolean => {
        const n = pnormalize(p);
        return norm.some((r) => n === r || n.startsWith(r + "/"));
    };
    const outside = (p: string): Error => new Error(l10n.t("Out-of-domain access (allowed: {0}): {1}", norm.join(" / "), p));
    return {
        stat: (p) => (allowed(p) ? inner.stat(p) : Promise.reject(outside(p))),
        lstat: (p) => (allowed(p) ? inner.lstat(p) : Promise.reject(outside(p))),
        readlink: (p) => (allowed(p) ? inner.readlink(p) : Promise.reject(outside(p))),
        readdir: (p) => (allowed(p) ? inner.readdir(p) : Promise.reject(outside(p))),
        readText: (p, maxBytes) => (allowed(p) ? inner.readText(p, maxBytes) : Promise.reject(outside(p))),
    };
}
