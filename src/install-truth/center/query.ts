/**
 * @file center/query.ts
 * 消费方数据结构与查询门面(为 launch 等消费方准备)。
 *
 * 设计依据:消费方(launch 的 `executable=` 校验/hover/补全、debugger 的 sourceFileMap)
 * 实际只会问这五类问题,故这里把它们一次性固化成**扁平索引 + 统一裁决**:
 *   ① 这个名字在当前工作区能跑吗?→ `lookup()`:ok / 包未构建 / 名字不存在(给建议)/ 源未解析
 *   ② 这个包能跑哪些?→ `namesOf()`
 *   ③ 所有能跑的名字(跨包补全)?→ `allNames()`
 *   ④ 它来自哪个源文件?→ `sourcesOf()`
 *   ⑤ 这个源文件对应哪些可执行(反向)?→ `ownersOfSource()`
 *
 * 关键约定:
 *   · **未就绪(null)≠ 空**:中心未就绪时一律返回 null,消费方不得当成"没有";
 *   · 索引按快照**懒构建 + 引用比较**失效(快照换了才重建),不额外持有状态机;
 *   · 裁决文案(中性的"包是否已构建/名字是否拼错")直接可用于 hover/诊断,不承诺未构建=不存在。
 *
 * 纯 TS,零依赖,可无头测试。
 */

import { l10n } from "vscode";

import { AreaFile, AreaName, BuildMapSnapshot, JumpEntry, PackageAreas } from "../shared/models";
import type { BuildTypeName } from "../shared/models";
import { normalizeInstallKey, pbasename } from "../shared/paths";
import { BuildMapCenter } from "./build-map-center";

/** 扁平索引(一次构建,多次 O(1) 查询) */
export interface ExecIndex {
    /** "pkg/name" → 条目 */
    byKey: Map<string, JumpEntry>;
    /** 包 → 有序可执行名(列表/补全) */
    namesByPkg: Map<string, string[]>;
    /** 全部命令名(去重排序;跨包补全) */
    allNames: string[];
    /** 源文件 → 归属条目(反向查询;一个源可被多个目标编入) */
    bySource: Map<string, Array<{ pkg: string; name: string }>>;
    /** 名字 → 所属包(重名可多包,排序;跨包补全的行内标包,2026-10-01 用户裁定) */
    byName: Map<string, string[]>;
    /**
     * **安装侧绝对路径 → 条目**(2026-09-14,P0-1:按路径反查;调试侧运行期入口)。
     * 键经 `normalizeInstallKey`(反斜杠/折叠/Windows 小写);来源 =
     * `JumpEntry.installPaths`(清单落点,含 Python 模块文件与 site-packages 目录)
     * ∪ `JumpEntry.buildPath`(build 内链接输出 —— symlink 安装下 `/proc/<pid>/exe` 读到的形态)。
     * 一条路径可多归属(罕见):取排序后第一个作主,`message` 里列全部。
     */
    byInstallPath: Map<string, JumpEntry[]>;
}

/** 查询裁决(launch 消费方按 status 分支,message 可直接展示) */
export type LookupStatus = "ok" | "pkg-not-built" | "exe-not-found" | "source-unresolved" | "path-unknown";

/** 一次查询的结果 */
export interface ExecutableLookup {
    status: LookupStatus;
    pkg: string;
    name: string;
    /** status=ok/source-unresolved 时给出条目 */
    entry?: JumpEntry;
    /** 人话说明(中性文案,可直接进 hover/诊断) */
    message: string;
    /** 名字未命中时的同包候选(前缀/包含匹配,最多 5 条) */
    suggestions: string[];
}

/** 由快照构建扁平索引 */
export function buildExecIndex(snapshot: BuildMapSnapshot): ExecIndex {
    const byKey = new Map<string, JumpEntry>();
    const namesByPkg = new Map<string, string[]>();
    const bySource = new Map<string, Array<{ pkg: string; name: string }>>();
    const byName = new Map<string, string[]>();
    const byInstallPath = new Map<string, JumpEntry[]>();
    const addInstallKey = (key: string, entry: JumpEntry): void => {
        const k = normalizeInstallKey(key);
        const list = byInstallPath.get(k) ?? [];
        if (list.indexOf(entry) < 0) {
            list.push(entry);
        }
        byInstallPath.set(k, list);
    };
    for (const [pkg, list] of snapshot.jumps) {
        const names: string[] = [];
        for (const e of list) {
            byKey.set(`${pkg}/${e.name}`, e);
            names.push(e.name);
            const nameOwners = byName.get(e.name) ?? [];
            if (!nameOwners.includes(pkg)) {
                nameOwners.push(pkg);
            }
            byName.set(e.name, nameOwners);
            for (const src of e.srcPaths) {
                const owners = bySource.get(src) ?? [];
                owners.push({ pkg, name: e.name });
                bySource.set(src, owners);
            }
            // P0-1:安装侧路径(含 Python 模块文件/site-packages 目录)与 build 侧别名
            for (const p of e.installPaths ?? []) {
                addInstallKey(p, e);
            }
            if (e.installPath !== "") {
                addInstallKey(e.installPath, e);
            }
            if (e.buildPath !== undefined) {
                addInstallKey(e.buildPath, e);
            }
        }
        namesByPkg.set(pkg, names.slice().sort());
    }
    // 多归属时保证确定性(主条目 = 排序第一个)
    for (const [k, list] of byInstallPath) {
        list.sort((a, b) => (a.pkg === b.pkg ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.pkg < b.pkg ? -1 : 1));
        byInstallPath.set(k, list);
    }
    for (const [n, pkgs] of byName) {
        byName.set(n, pkgs.sort());
    }
    const allNames = Array.from(new Set(Array.from(namesByPkg.values()).reduce<string[]>((a, b) => a.concat(b), []))).sort();
    return { byKey, namesByPkg, allNames, bySource, byName, byInstallPath };
}

/** 子序列判定(talkr 是 talker 的子序列 → 打字漏字符也能提示) */
function isSubsequence(needle: string, hay: string): boolean {
    let i = 0;
    for (const ch of hay) {
        if (i < needle.length && ch === needle[i]) {
            i++;
        }
    }
    return i === needle.length;
}

/** 编辑距离(小字符串,标准 DP) */
function levenshtein(a: string, b: string): number {
    const prev: number[] = [];
    const cur: number[] = [];
    for (let j = 0; j <= b.length; j++) {
        prev[j] = j;
    }
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++) {
            prev[j] = cur[j];
        }
    }
    return prev[b.length];
}

/**
 * 名字建议(同包内):前缀 → 子串 → 模糊(编辑距离 ≤ 容差 或 子序列)。
 * 真跑动机:launch 里 executable= 写错是最常见的报错之一,提示必须能覆盖"少字/错字/换序"。
 */
export function suggestNames(index: ExecIndex, pkg: string, name: string, limit = 5): string[] {
    const list = index.namesByPkg.get(pkg) ?? [];
    const lower = name.toLowerCase();
    const scored: Array<{ n: string; rank: number; d: number }> = [];
    const tolerance = Math.max(2, Math.floor(lower.length / 3));
    for (const n of list) {
        const ln = n.toLowerCase();
        let rank = 3;
        let d = 99;
        if (ln.startsWith(lower)) {
            rank = 0;
            d = ln.length - lower.length;
        } else if (ln.indexOf(lower) >= 0) {
            rank = 1;
            d = ln.length - lower.length;
        } else {
            const dist = levenshtein(ln, lower);
            if (dist <= tolerance) {
                rank = 2;
                d = dist;
            } else if (isSubsequence(lower, ln)) {
                rank = 2;
                d = ln.length - lower.length;
            } else {
                continue;
            }
        }
        scored.push({ n, rank, d });
    }
    scored.sort((a, b) => (a.rank - b.rank) || (a.d - b.d) || (a.n < b.n ? -1 : 1));
    return scored.slice(0, limit).map((s) => s.n);
}

/** 统一裁决:这个名字能不能跑、源在哪、为什么不能 */
export function lookupExecutable(
    index: ExecIndex,
    snapshot: BuildMapSnapshot,
    pkg: string,
    name: string
): ExecutableLookup {
    if (!snapshot.packages.has(pkg)) {
        // 包不在本工作区(系统包/underlay/拼错)→ 明确区分,避免误报"名字错"
        return {
            status: "pkg-not-built",
            pkg,
            name,
            message: l10n.t("Package {0} is not in this workspace (from system/underlay, or not built yet)", pkg),
            suggestions: [],
        };
    }
    const entry = index.byKey.get(`${pkg}/${name}`);
    if (entry === undefined) {
        const suggestions = suggestNames(index, pkg, name);
        const hint = suggestions.length > 0 ? l10n.t("; did you mean: {0}", suggestions.join(", ")) : "";
        return {
            status: "exe-not-found",
            pkg,
            name,
            message: l10n.t("Package {0} is built but has no executable {1}{2}", pkg, name, hint),
            suggestions,
        };
    }
    if (entry.unresolved || entry.srcPaths.length === 0) {
        return {
            status: "source-unresolved",
            pkg,
            name,
            entry,
            message: l10n.t("{0}/{1} exists but source unresolved: {2}", pkg, name, entry.unresolvedReason || l10n.t("no provenance record")),
            suggestions: [],
        };
    }
    return {
        status: "ok",
        pkg,
        name,
        entry,
        message: `${pkg}/${name} → ${entry.srcPaths[0]}`,
        suggestions: [],
    };
}

/**
 * 按**安装侧绝对路径**裁决(2026-09-14,P0-1;调试侧运行期入口)。
 *
 * 语义(与按名字查的 `lookupExecutable` 对齐,但键换成路径):
 *   - **未命中 → `path-unknown`**:这是正常结论(系统包 / 临时脚本 / 包装器 / 非本工作区目标),
 *     不是错误,消费方据此"不注入调试器 + 明示原因";
 *   - **多归属** → 主条目取排序第一个,message 里列全部候选(罕见:两个条目包装同一路径);
 *   - 命中但源未解析 → `source-unresolved`;其余 → `ok`。
 * 注:不需要 snapshot —— 路径命中即意味着该包就在本工作区(与 `pkg-not-built` 互斥)。
 */
export function lookupByPath(index: ExecIndex, installedPath: string): ExecutableLookup {
    const key = normalizeInstallKey(installedPath);
    const hits = index.byInstallPath.get(key) ?? [];
    if (hits.length === 0) {
        return {
            status: "path-unknown",
            pkg: "",
            name: pbasename(key),
            message: l10n.t("Path does not belong to any installed target in this workspace: {0}", installedPath),
            suggestions: [],
        };
    }
    const entry = hits[0];
    const suffix =
        hits.length > 1
            ? l10n.t("(this path has {0} owners: {1}; taking the first)", hits.length, hits.map((e) => `${e.pkg}/${e.name}`).join(", "))
            : "";
    if (entry.unresolved || entry.srcPaths.length === 0) {
        return {
            status: "source-unresolved",
            pkg: entry.pkg,
            name: entry.name,
            entry,
            message: l10n.t("{0}/{1} exists but source unresolved: {2}{3}", entry.pkg, entry.name, entry.unresolvedReason || l10n.t("no provenance record"), suffix),
            suggestions: [],
        };
    }
    return {
        status: "ok",
        pkg: entry.pkg,
        name: entry.name,
        entry,
        message: `${entry.pkg}/${entry.name} → ${entry.srcPaths[0]}${suffix}`,
        suggestions: [],
    };
}

/**
 * **侧边栏一行**(2026-09-21):数据完整到"拿这个就能渲染"。
 *
 * 只描述**事实与标记**,不替消费方决定显示什么(隐藏生成物 / 隐藏库 / 是否显示未安装 = 展示策略)。
 * 数组顺序 = 稳定排序顺序(区序 `lib → import → share → include`,同区内按名字),可直接照渲染。
 */
export interface SidebarRow {
    area: AreaName;
    /** 区内展示名(= `AreaFile.relPath`;lib 区就是命令名) */
    name: string;
    /**
     * 行状态(互斥,判定优先级:`missing` > `generated` > `source-unresolved` > `installed`):
     *   `missing`            = 记录(清单)里有、install 侧没看到 —— 这行最该被看见
     *   `generated`          = 约定生成物,或源落在 build 内(消费方默认隐藏)
     *   `source-unresolved`  = 名字在,但源落点拿不到(给中性原因,不报错)
     *   `installed`          = 正常可用
     */
    status: "installed" | "missing" | "generated" | "source-unresolved";
    /** 源箭头(可点击);`entryAttr` 非空时形如 `…/helper.py:main` —— **展示用** */
    source?: string;
    /**
     * 源落点的**纯路径**(不含 `:attr`)—— **机器用**(点击跳转 / 映射)。
     * 2026-09-21 加:展示串带 `:main`,直接拿去当文件路径会打不开。
     */
    sourcePath?: string;
    sourceEvidence?: AreaFile["sourceEvidence"];
    /** 内容来源引用(2026-09-25 第五批:悬浮栏可逆搜索 —— 规则/记录文件名等;见 AreaFile.sourceRef) */
    sourceRef?: string;
    /** console_script 入口属性(`:main` 的那个 main;仅 lib 区可能非空) */
    entryAttr?: string;
    /** 徽标素材 */
    library: boolean;
    generated: boolean;
    /** 形态(甲-1):是不是软链 / 指向哪一层 / 悬空 / 可执行 */
    link?: boolean;
    linkTarget?: string;
    linkDomain?: "src" | "build" | "outside";
    /** 该行是**经哪条上游目录软链**进来的(扩大成因) */
    viaLinkDomain?: "src" | "build" | "outside";
    dangling?: boolean;
    executable?: boolean;
    /** 绝对落点 */
    installPath: string;
}

/** 一个包的侧边栏视图(三区合一数组;消费方按 `area` 分组) */
export interface SidebarPackageView {
    pkg: string;
    /** 安装前缀(isolated = `install/<pkg>`;merged = `install`) */
    prefix: string;
    layout: PackageAreas["layout"];
    /**
     * 包**安装类型**(2026-09-25 第三批,用户裁定"以 install 的为准";`installFormOf(rows)` 推导):
     * `"symlink"` = 符号安装 / `"copy"` = 实体安装 / `"unknown"` = 无观察(空包/纯 manifest-only),不猜。
     */
    installForm?: "symlink" | "copy" | "unknown";
    /** 包**构建类型**(`BuildPackage.type`,即 `inferType`:`ament_cmake|ament_python|cmake|python-or-unknown`;包不在 packages 表 → undefined) */
    buildType?: BuildTypeName;
    rows: SidebarRow[];
}

/**
 * 包的**安装类型**(2026-09-25 第三批,用户裁定"以 install 的为准";纯函数,可无头单测):
 *  · observed 行带**软链痕迹** → `"symlink"`:文件本身是链(`link === true`),或经上游目录软链进来
 *    (`viaLinkDomain` 非空 —— develop 直通属于后者,文件本身不是链);
 *  · 有 observed 行且全为真实文件 → `"copy"`;
 *  · 无观察(空包 / 纯 manifest-only 反向行) → `"unknown"` —— **不猜**
 *    (对齐 build 域 install-method-check 的纪律「形态事实读不到就是 undefined,绝不猜」;
 *     CMakeCache 是**配置域**不是 install 现状 —— 见 install-method-check.ts 头注实测反例,不参与判定)。
 */
export function installFormOf(rows: readonly SidebarRow[]): "symlink" | "copy" | "unknown" {
    const observed = rows.filter((r) => r.status !== "missing");
    if (observed.some((r) => r.link === true || r.viaLinkDomain !== undefined)) {
        return "symlink";
    }
    if (observed.some((r) => r.link === false)) {
        return "copy";
    }
    return "unknown";
}

/**
 * 由安装内容解算结果派生**侧边栏行**(纯函数;不访问 fs、不需要 center)。
 *
 * `jumps` 只为取 `entryTarget`(lib 区的 `:main`);不传也能用,只是没有 `entryAttr`。
 */
export function rowsOf(pkgAreas: PackageAreas, jumps?: JumpEntry[]): SidebarRow[] {
    const targetOf = (installPath: string): string | undefined => {
        if (jumps === undefined) {
            return undefined;
        }
        for (const e of jumps) {
            if (e.entryTarget === undefined) {
                continue;
            }
            if (e.installPath === installPath || (e.installPaths ?? []).indexOf(installPath) >= 0) {
                return e.entryTarget;
            }
        }
        return undefined;
    };
    return pkgAreas.files.map((f) => {
        const entryTarget = targetOf(f.installPath);
        const i = entryTarget === undefined ? -1 : entryTarget.indexOf(":");
        const entryAttr = i < 0 ? undefined : entryTarget!.slice(i + 1);
        const status: SidebarRow["status"] =
            f.agreement === "manifest-only"
                ? "missing"
                : f.generated
                  ? "generated"
                  : f.sourcePath === undefined
                    ? "source-unresolved"
                    : "installed";
        return {
            area: f.area,
            name: f.relPath,
            status,
            source: f.sourcePath === undefined ? undefined : entryAttr ? `${f.sourcePath}:${entryAttr}` : f.sourcePath,
            sourcePath: f.sourcePath,
            sourceEvidence: f.sourceEvidence,
            sourceRef: f.sourceRef,
            entryAttr,
            library: f.library,
            generated: f.generated,
            link: f.link,
            linkTarget: f.linkTarget,
            linkDomain: f.linkDomain,
            viaLinkDomain: f.viaLinkDomain,
            dangling: f.dangling,
            executable: f.executable,
            installPath: f.installPath,
        };
    });
}

/** 索引缓存:按快照引用失效(中心换快照才重建) */
export class ExecIndexCache {
    private lastSnapshot: BuildMapSnapshot | null = null;
    private index: ExecIndex | null = null;

    /** 取当前索引;未就绪 → null */
    get(center: BuildMapCenter): ExecIndex | null {
        const snapshot = center.getState();
        if (snapshot === null) {
            this.lastSnapshot = null;
            this.index = null;
            return null;
        }
        if (snapshot !== this.lastSnapshot || this.index === null) {
            this.index = buildExecIndex(snapshot);
            this.lastSnapshot = snapshot;
        }
        return this.index;
    }
}

/**
 * launch 侧推荐使用的门面:把"中心 + 索引 + 裁决"收成一个对象。
 * 所有方法在**未就绪**时返回 null(消费方据此显示 loading/或走系统包回退),而不是空数组。
 */
export class ExecutableResolver {
    private readonly cache = new ExecIndexCache();
    /** 落点索引缓存(按快照引用失效;同 ExecIndexCache 的做法) */
    private areaIndexRef: BuildMapSnapshot | null = null;
    private areaIndex: Map<string, AreaFile> | null = null;

    constructor(private readonly center: BuildMapCenter) {}

    /** 是否已就绪 */
    isReady(): boolean {
        return this.center.isReady();
    }

    /** 订阅变化(直接转发中心事件;launch 用它刷新诊断/补全缓存) */
    onDidChange(listener: () => void): () => void {
        return this.center.onDidChange(() => listener());
    }

    /**
     * 查询前的新鲜度保证(惰性刷新):
     * 未就绪 → 首次构建;置脏 → 立即重扫(带最小间隔节流)。
     * 消费方**不需要**自己监听 watcher 或定时刷新,直接 await 查询即可。
     */
    ensureFresh(reason = "consumer"): Promise<void> {
        return this.center.ensureFresh(reason);
    }

    /** 单条裁决(未就绪 → null) */
    async lookup(pkg: string, name: string): Promise<ExecutableLookup | null> {
        await this.ensureFresh("lookup");
        const index = this.cache.get(this.center);
        const snapshot = this.center.getState();
        if (index === null || snapshot === null) {
            return null;
        }
        return lookupExecutable(index, snapshot, pkg, name);
    }

    /** 包 → 可执行名(未就绪 → null) */
    async namesOf(pkg: string): Promise<string[] | null> {
        await this.ensureFresh("namesOf");
        const index = this.cache.get(this.center);
        return index === null ? null : index.namesByPkg.get(pkg) ?? [];
    }

    /** 全部可执行名(跨包补全;未就绪 → null) */
    async allNames(): Promise<string[] | null> {
        await this.ensureFresh("allNames");
        const index = this.cache.get(this.center);
        return index === null ? null : index.allNames;
    }

    /** 名字 → 源(未就绪/未命中 → null;命中但未解析 → 空数组) */
    async sourcesOf(pkg: string, name: string): Promise<string[] | null> {
        await this.ensureFresh("sourcesOf");
        const index = this.cache.get(this.center);
        if (index === null) {
            return null;
        }
        const entry = index.byKey.get(`${pkg}/${name}`);
        return entry === undefined ? null : entry.srcPaths.slice();
    }

    /** 名字 → 所属包(重名可多包,排序;未就绪 → null;未命中 → 空数组;2026-10-01 用户裁定行内标包) */
    async ownersOfName(name: string): Promise<string[] | null> {
        await this.ensureFresh("ownersOfName");
        const index = this.cache.get(this.center);
        if (index === null) {
            return null;
        }
        return (index.byName.get(name) ?? []).slice();
    }

    /** 源 → 归属(反向;未就绪 → null) */
    async ownersOfSource(srcPath: string): Promise<Array<{ pkg: string; name: string }> | null> {
        await this.ensureFresh("ownersOfSource");
        const index = this.cache.get(this.center);
        if (index === null) {
            return null;
        }
        return (index.bySource.get(srcPath) ?? []).slice();
    }

    /**
     * **按安装侧绝对路径**裁决(2026-09-14,P0-1;调试侧运行期入口)。
     * 未就绪 → null;未命中 → `path-unknown`(正常结论,不是错误)。
     * 典型输入:wrapper 上报的 `argv[0]`、`/proc/<pid>/exe` 读到的解析后路径
     * (后者在 symlink 安装下命中 `JumpEntry.buildPath` 别名)。
     */
    async resolveByPath(installedPath: string): Promise<ExecutableLookup | null> {
        await this.ensureFresh("resolveByPath");
        const index = this.cache.get(this.center);
        if (index === null) {
            return null;
        }
        return lookupByPath(index, installedPath);
    }

    /** 当前快照(同步;高级用法,调用方自行保证新鲜度) */
    snapshot(): BuildMapSnapshot | null {
        return this.center.getState();
    }

    // -----------------------------------------------------------------------
    // 安装内容解算的三个区(2026-09-21;最小门面)
    //
    // 风格与上面一致:未就绪 → `null`(≠ 空);**空区返回 `[]`**(键存在但确实为空)。
    // 过滤(隐藏生成物 / 隐藏库 / 只取 .py)一律**下沉到消费方** —— truth 层只给全集 + 标记。
    // -----------------------------------------------------------------------

    /**
     * 全部包的安装内容解算(同步只读)。
     * 侧边栏应当用这个 + `onDidChange`,**不要**每展开一个节点都 `await ensureFresh()`
     * (`minRefreshIntervalMs` 默认 0 → 会反复全量重扫)。
     */
    areasSnapshot(): Map<string, PackageAreas> | null {
        const snapshot = this.center.getState();
        return snapshot === null ? null : snapshot.areas;
    }

    /** 单包四区(未就绪 → null;包存在但什么都没装 → 空 files) */
    async areasOf(pkg: string): Promise<PackageAreas | null> {
        await this.ensureFresh("areasOf");
        const snapshot = this.center.getState();
        return snapshot === null ? null : snapshot.areas.get(pkg) ?? null;
    }

    /** 某一区(未就绪 → null;**该区为空 → `[]`**,与"没有这个包"区分开) */
    async filesOf(pkg: string, area: AreaName): Promise<AreaFile[] | null> {
        await this.ensureFresh("filesOf");
        const snapshot = this.center.getState();
        if (snapshot === null) {
            return null;
        }
        const pkgAreas = snapshot.areas.get(pkg);
        return pkgAreas === undefined ? null : pkgAreas.files.filter((f) => f.area === area);
    }

    /** 已装出来的包名(未就绪 → null) */
    async installedPackages(): Promise<string[] | null> {
        await this.ensureFresh("installedPackages");
        const snapshot = this.center.getState();
        return snapshot === null ? null : Array.from(snapshot.areas.keys()).sort();
    }

    /**
     * 落点路径 → 条目(未就绪 → null;未命中 → undefined)。
     * 键经 `normalizeInstallKey`(吸收反斜杠 / 折叠 / 尾斜杠等写法变体)。
     */
    async findInstalledFile(installPath: string): Promise<AreaFile | undefined | null> {
        await this.ensureFresh("findInstalledFile");
        const index = this.areaIndexOf();
        return index === null ? null : index.get(normalizeInstallKey(installPath));
    }

    /**
     * **侧边栏整棵树**(同步只读):每个包 → 三区行(已按稳定顺序排好)。
     * 侧边栏渲染用它 + `onDidChange`;**不要**每展开一个节点都 `await`(会反复全量重扫)。
     */
    sidebarSnapshot(): SidebarPackageView[] | null {
        const snapshot = this.center.getState();
        if (snapshot === null) {
            return null;
        }
        const out: SidebarPackageView[] = [];
        for (const pkg of Array.from(snapshot.areas.keys()).sort()) {
            const view = this.viewOf(snapshot, pkg);
            if (view !== undefined) {
                out.push(view);
            }
        }
        return out;
    }

    /** 同一个视图(异步;先 `ensureFresh`) */
    async sidebarView(): Promise<SidebarPackageView[] | null> {
        await this.ensureFresh("sidebarView");
        return this.sidebarSnapshot();
    }

    /** 单包行视图(未就绪 → null;包不存在 → null) */
    async packageView(pkg: string): Promise<SidebarPackageView | null> {
        await this.ensureFresh("packageView");
        const snapshot = this.center.getState();
        return snapshot === null ? null : this.viewOf(snapshot, pkg) ?? null;
    }

    private viewOf(snapshot: BuildMapSnapshot, pkg: string): SidebarPackageView | undefined {
        const pkgAreas = snapshot.areas.get(pkg);
        if (pkgAreas === undefined) {
            return undefined;
        }
        const rows = rowsOf(pkgAreas, snapshot.jumps.get(pkg));
        // 2026-09-25(第三批):包级属性随视图下发 —— 安装类型以 install 观察为准,构建类型取 build traits
        return {
            pkg,
            prefix: pkgAreas.prefix,
            layout: pkgAreas.layout,
            installForm: installFormOf(rows),
            buildType: snapshot.packages.get(pkg)?.type,
            rows,
        };
    }

    /** 落点索引(懒建,按快照引用失效) */
    private areaIndexOf(): Map<string, AreaFile> | null {
        const snapshot = this.center.getState();
        if (snapshot === null) {
            this.areaIndexRef = null;
            this.areaIndex = null;
            return null;
        }
        if (snapshot !== this.areaIndexRef || this.areaIndex === null) {
            const m = new Map<string, AreaFile>();
            for (const pkgAreas of snapshot.areas.values()) {
                for (const f of pkgAreas.files) {
                    const key = normalizeInstallKey(f.installPath);
                    if (!m.has(key)) {
                        m.set(key, f);
                    }
                }
            }
            this.areaIndex = m;
            this.areaIndexRef = snapshot;
        }
        return this.areaIndex;
    }
}
