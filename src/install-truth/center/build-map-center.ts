/**
 * @file center/build-map-center.ts
 * build-only 数据中心(独立生命周期):**唯一输入 build/**。
 *
 * 为什么独立于 package-core:
 *   package-core 跟的是 src 域(package.xml / COLCON_IGNORE / 构建配置);
 *   本中心跟的是 build/ 域(编译产物)。两者天然不同步,故独立数据源、独立失效源
 *   (build/** 变化、构建任务结束)、独立就绪契约。
 *
 * 为什么不再需要 install/ 与"双版本适配":
 *   可执行跳转所需的记录(link.txt / .o.d / egg-info / 安装规则)全在 build/<pkg>,
 *   四象限(iso/merged × entity/symlink)实测为**固有信息**(见
 *   `discover/buildonly-四象限报告.md` §2)→ 旧版围绕 install 的形态检测、
 *   egg-info 双落点、候选 X_OK 扫描等适配层全部裁掉。
 *
 * 工程形态(对齐库内既成模式:package-core / 旧 executable-map):
 *   单飞 + 合并、双缓冲原子替换、内容指纹 no-op 抑制、null 就绪契约、逐包独立容错。
 *   watcher/定时器一律由接线层注入(本文件不含 vscode)。
 *
 * 纯 TS,零依赖,可无头测试。
 */

import { l10n } from "vscode";

import { FsLike, nodeFsLike } from "../shared/fs/primitives";
import { BuildMapSnapshot, BuildPackage, JumpEntry, PackageAreas } from "../shared/models";
import { pjoin } from "../shared/paths";
import { locateBuildRoot } from "../scan/build-root";
import { collectAreas } from "../scan/installed";
import { collectJumps } from "../scan/jumps";
import { discoverBuildPackages, inferType, PKG_NAME_RE, readTraits } from "../scan/packages";

/** 映射整体变化事件载荷(订阅方可直接读只读快照) */
export interface BuildMapChangeEvent {
    map: BuildMapSnapshot;
}

/** 快照构建器(可注入,便于单测构造状态) */
export type BuildMapBuilder = (
    fs: FsLike,
    workspaceRoot: string,
    reason: string,
    now: () => number
) => Promise<BuildMapSnapshot>;

/**
 * 一次性构建快照(无状态入口;CLI/测试/一次性分析可用)。
 * 不做缓存、不发事件 —— 需要持续跟随请用 BuildMapCenter。
 */
export async function buildBuildMapSnapshot(
    fs: FsLike,
    workspaceRoot: string,
    reason = "manual",
    now: () => number = () => Date.now()
): Promise<BuildMapSnapshot> {
    const t0 = now();
    const ctx = await locateBuildRoot(fs, workspaceRoot);
    if (ctx === undefined) {
        throw new Error(l10n.t("build/ not found (build-only mode requires build artifacts): {0}", workspaceRoot));
    }
    const packages = await discoverBuildPackages(fs, ctx);
    // 2026-09-24(测试改造 B0):收口 includeUninstalled —— 测试可执行**永远** installed=false
    // (ament_add_gtest 不安装测试二进制,实测 install_manifest.txt / symlink_install_manifest.txt 均未命中),
    // 而"已构建但未安装"本身就是事实,展示层过滤不属于 truth 层(install-truth/README.md §2.1.3)。
    const { jumps, warnings } = await collectJumps(fs, ctx, packages, { includeUninstalled: true });
    // 安装内容解算(三区 + include):install 侧观察 + build 侧记录对账(README §2)
    const { areas, warnings: areaWarnings } = await collectAreas(fs, ctx, packages, jumps);
    return {
        workspaceRoot: ctx.workspaceRoot,
        buildRoot: ctx.buildRoot,
        srcRoot: ctx.srcRoot,
        packages,
        jumps,
        areas,
        warnings: warnings.concat(areaWarnings),
        durationMs: now() - t0,
        builtAt: now(),
        reason,
    };
}

/**
 * 内容指纹(no-op 抑制用):
 * 只取影响消费方决策的字段(包/特征/跳转名/类型/源/分级/**安装与路径类字段**),顺序无关。
 *
 * 2026-09-14(P0-1/2/3):补入 `installed` / `installPath` / `installPaths` / `buildPath` /
 * `compilePaths` —— 这些正是调试侧要决策的字段(是否注入、会话命名),此前不在指纹里
 * 会导致"只改了安装或路径信息"时不发事件。
 * 2026-09-21:`compilePathsExistLocally` 已删除(域包含性:不判域外存在性),指纹同步移除。
 * 2026-09-30:行生成抽取为 pkgRow/jumpRows/areaRow(与 `packageFingerprints` 共用原子),
 * **全局指纹输出逐字节不变**(既有断言兜底)。
 */
export function fingerprintOfSnapshot(s: BuildMapSnapshot): string {
    const parts: string[] = [`build=${s.buildRoot}`, `src=${s.srcRoot}`];
    for (const name of Array.from(s.packages.keys()).sort()) {
        parts.push(pkgRow(s.packages.get(name) as BuildPackage));
    }
    for (const name of Array.from(s.jumps.keys()).sort()) {
        parts.push(...jumpRows(name, s.jumps.get(name) as JumpEntry[]));
    }
    // 安装内容解算(2026-09-21):区/相对路径/对账状态/生成物与库标记/源落点,全部入指纹
    for (const name of Array.from(s.areas.keys()).sort()) {
        parts.push(areaRow(name, s.areas.get(name) as PackageAreas));
    }
    parts.sort();
    return fnv1a(parts.join("\n"));
}

/* ── 指纹行原子(2026-09-30 抽取;全局指纹与逐包指纹共用,改一处必查另一处) ── */

/** 单包特征行(P) */
function pkgRow(pkg: BuildPackage): string {
    return [
        "P",
        pkg.name,
        pkg.type,
        pkg.traits.cmake ? "1" : "0",
        pkg.traits.amentCmake ? "1" : "0",
        pkg.traits.python ? "1" : "0",
        pkg.traits.rosidl ? "1" : "0",
        pkg.traits.colcon ? "1" : "0",
    ].join("|");
}

/** 单包全部跳转行(J;按条目原序) */
function jumpRows(name: string, entries: JumpEntry[]): string[] {
    return entries.map((e) =>
        [
            "J",
            name,
            e.name,
            e.kind,
            e.tier,
            e.unresolved ? "1" : "0",
            e.srcPaths.join(";"),
            e.installed ? "1" : "0",
            e.installPath,
            (e.installPaths ?? []).join(";"),
            e.buildPath ?? "",
            (e.compilePaths ?? []).join(";"),
            e.pythonInstall === undefined
                ? ""
                : [
                      e.pythonInstall.scriptPath ?? "",
                      e.pythonInstall.sitePackagesDir ?? "",
                      e.pythonInstall.moduleFile ?? "",
                  ].join(";"),
        ].join("|")
    );
}

/** 单包安装内容行(A) */
function areaRow(name: string, a: PackageAreas): string {
    const body = a.files
        .map(
            (f) =>
                `${f.area}:${f.relPath}:${f.agreement}${f.generated ? ":G" : ""}${f.library ? ":L" : ""}` +
                `:${f.linkDomain ?? "-"}${f.viaLinkDomain === undefined ? "" : "v" + f.viaLinkDomain}${f.dangling ? ":D" : ""}` +
                (f.sourcePath === undefined ? "" : `:${f.sourcePath}`)
        )
        .join(";");
    return ["A", name, a.layout, body].join("|");
}

/**
 * 逐包指纹(2026-09-30):包名 → 该包全部 P/J/A 行的指纹。
 * 供 `onPackagesChanged` 差分 —— 构建信号主动刷新后,只有"包真的变了"才广播包名。
 * 与全局指纹同源不同聚:全局 = 全部行排序后哈希;逐包 = 该包行排序后哈希。
 */
export function packageFingerprints(s: BuildMapSnapshot): Map<string, string> {
    const out = new Map<string, string>();
    const names = new Set<string>([...s.packages.keys(), ...s.jumps.keys(), ...s.areas.keys()]);
    for (const name of names) {
        const rows: string[] = [];
        const pkg = s.packages.get(name);
        if (pkg !== undefined) {
            rows.push(pkgRow(pkg));
        }
        const js = s.jumps.get(name);
        if (js !== undefined) {
            rows.push(...jumpRows(name, js));
        }
        const a = s.areas.get(name);
        if (a !== undefined) {
            rows.push(areaRow(name, a));
        }
        out.set(name, fnv1a(rows.sort().join("\n")));
    }
    return out;
}

/** 逐包指纹差分(新增 ∪ 变更 ∪ 删除;升序;无变化 → 空表) */
export function diffPackageFingerprints(prev: Map<string, string>, next: Map<string, string>): string[] {
    const out: string[] = [];
    for (const [name, fp] of next) {
        if (prev.get(name) !== fp) {
            out.push(name); // 新增或变更
        }
    }
    for (const name of prev.keys()) {
        if (!next.has(name)) {
            out.push(name); // 删除
        }
    }
    return out.sort();
}

function fnv1a(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

/** 数据中心选项 */
export interface BuildMapCenterOptions {
    /** 工作区根(含 build/;亦接受 build 根本身) */
    workspaceRoot: string;
    /** 文件系统实现(默认真实 fs;单测注入 MemoryFs) */
    fs?: FsLike;
    /** 时钟注入(测试确定性) */
    now?: () => number;
    /** 快照构建器注入(默认 buildBuildMapSnapshot) */
    builder?: BuildMapBuilder;
    /**
     * 惰性刷新的最小间隔(毫秒,默认 0 = 不节流,与"调用即刷新"语义一致):
     * 置脏后若消费者密集查询,避免同一轮反复全量扫描。
     * 注意:主动刷新(`refresh` / `refreshAfterBuildSignal`)不受此限(总是执行)。
     * (2026-09-30 修注:此前注释写"默认 500",与实现 `?? 0` 不符,按实现更正。)
     */
    minRefreshIntervalMs?: number;
}

/**
 * 构建信号刷新的原因串(2026-09-30):`refreshAfterBuildSignal()` 以它调 `refresh`,
 * `buildOnce` 据此判定"已就绪时走 rc-mtime 增量门"。手动/其它原因一律全量。
 */
// 2026-10-04 i18n:内部 reason ID 改语言中立英文(比较键不随语言变,日志泄漏面随之英文,不进册)
export const BUILD_SIGNAL_REASON = "build signal";

/** build-only 数据中心 */
export class BuildMapCenter {
    private readonly fs: FsLike;
    private readonly now: () => number;
    private readonly builder: BuildMapBuilder;
    /** 就绪后的只读承载;null = 未就绪(首次构建未完成) */
    private state: BuildMapSnapshot | null = null;
    /** 最近一次构建失败原因(保留上次好值) */
    private lastError: string | undefined;
    /** 单飞:任一时刻最多一个构建链;进行中又来请求 → 标脏,链尾补刷 */
    private pending: Promise<void> | undefined;
    private dirty = false;
    private lastReason = "init";
    private fingerprint = "";
    /** 逐包指纹(与 fingerprint 同轮更新;差分 onPackagesChanged 用) */
    private pkgFingerprints = new Map<string, string>();
    /** 上次成功构建的时刻(惰性刷新节流用) */
    private lastRefreshAt = 0;
    private readonly minRefreshIntervalMs: number;
    private readonly listeners = new Set<(ev: BuildMapChangeEvent) => void>();
    /** 包级差分订阅(2026-09-30;测试域按包重发现用) */
    private readonly pkgListeners = new Set<(names: string[]) => void>();
    /**
     * rc-mtime 记账(增量门):包名 → 上次扫描时 `build/<pkg>/colcon_build.rc` 的 mtimeMs
     * (-1 = 该包无 rc)。每次成功构建后整体重记;门判定:与当前值不等 / 上次无 rc → 重扫。
     */
    private rcAtScan = new Map<string, number>();

    constructor(private readonly opts: BuildMapCenterOptions) {
        this.fs = opts.fs ?? nodeFsLike;
        this.now = opts.now ?? (() => Date.now());
        this.builder = opts.builder ?? buildBuildMapSnapshot;
        this.minRefreshIntervalMs = opts.minRefreshIntervalMs ?? 0;
    }

    /** 工作区根(接线层排障用) */
    getWorkspaceRoot(): string {
        return this.opts.workspaceRoot;
    }

    /** 当前快照;null = 未就绪 */
    getState(): BuildMapSnapshot | null {
        return this.state;
    }

    /** 是否已就绪 */
    isReady(): boolean {
        return this.state !== null;
    }

    /** 最近一次构建失败原因(undefined = 无失败) */
    getLastError(): string | undefined {
        return this.lastError;
    }

    /** 是否有待处理的失效 */
    isDirty(): boolean {
        return this.dirty;
    }

    /**
     * 惰性刷新(消费方调用前使用):**见脏即立即重扫**。
     * 静态解析很轻(roa2_ws ≈ 0.4s),故不做轮询/静默检测 —— 由"谁要看"驱动刷新。
     * 节流:连续调用时同一 `minRefreshIntervalMs` 窗口内最多重扫一次(置脏标记仍保留)。
     */
    async ensureFresh(reason = "consumer"): Promise<void> {
        if (this.state === null) {
            await this.refresh(reason);
            return;
        }
        if (!this.dirty) {
            return;
        }
        if (this.minRefreshIntervalMs > 0 && this.now() - this.lastRefreshAt < this.minRefreshIntervalMs) {
            return; // 节流窗口内:保留脏标记,下次再刷
        }
        await this.refresh(reason);
    }

    /** 订阅整体变化;返回取消函数 */
    onDidChange(listener: (ev: BuildMapChangeEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * 订阅**包级差分**(2026-09-30):每次成功构建后逐包指纹对比,
     * 新增/变更/删除的包名才广播(升序;首扫无前快照 → 不发)。
     * 语义 = "包真的变了"(取代 2026-09-24 起"文件被碰过"的 onBuildTouch)。
     */
    onPackagesChanged(listener: (names: string[]) => void): () => void {
        this.pkgListeners.add(listener);
        return () => {
            this.pkgListeners.delete(listener);
        };
    }

    /** 包的可执行跳转清单(未就绪/无该包 → undefined) */
    jumpsOf(pkg: string): JumpEntry[] | undefined {
        return this.state === null ? undefined : this.state.jumps.get(pkg);
    }

    /** 查单条跳转(未就绪/未找到 → undefined) */
    find(pkg: string, name: string): JumpEntry | undefined {
        const list = this.jumpsOf(pkg);
        if (list === undefined) {
            return undefined;
        }
        return list.filter((e) => e.name === name)[0];
    }

    /** 包名(字典序;未就绪 → 空表) */
    packageNames(): string[] {
        return this.state === null ? [] : Array.from(this.state.packages.keys()).sort();
    }

    /** 单包信息 */
    package(name: string): BuildPackage | undefined {
        return this.state === null ? undefined : this.state.packages.get(name);
    }

    /** 标脏(失效):build/** 变化、构建任务结束、工作区切换 —— 由接线层调用 */
    invalidate(reason: string): void {
        this.dirty = true;
        this.lastReason = reason;
    }

    /**
     * 构建信号驱动的刷新(2026-09-30;幂等 = 单飞 + 合并,见 `refresh`)。
     * 未就绪 → 全量首扫;已就绪 → **rc-mtime 增量门**:逐包 stat `colcon_build.rc`,
     * 只重扫重写过的包(实测:单包构建恰 1 包重写 → 重扫 ≈69ms/包;全量构建全部重写 → 退化为
     * 全量,但后台跑 + 双缓冲旧数据照常服务 + 指纹不变不打扰下游)。
     * 触发源:extension.ts 订阅 `environmentFacade.onBuildSignal`(手工重设计/13)。
     */
    refreshAfterBuildSignal(): Promise<void> {
        return this.refresh(BUILD_SIGNAL_REASON);
    }

    /** 刷新(单飞 + 合并) */
    refresh(reason = "manual"): Promise<void> {
        if (this.pending !== undefined) {
            this.invalidate(reason);
            return this.pending;
        }
        this.pending = this.runLoop(reason).then(
            () => {
                this.pending = undefined;
            },
            () => {
                this.pending = undefined;
            }
        );
        return this.pending;
    }

    /** 释放 */
    dispose(): void {
        this.listeners.clear();
        this.pkgListeners.clear();
        this.state = null;
        this.pending = undefined;
        this.dirty = false;
        this.rcAtScan.clear();
    }

    private async runLoop(reason: string): Promise<void> {
        let current = reason;
        do {
            this.dirty = false;
            await this.buildOnce(current);
            current = this.lastReason;
        } while (this.dirty);
    }

    private async buildOnce(reason: string): Promise<void> {
        const t0 = this.now();
        try {
            if (reason === BUILD_SIGNAL_REASON && this.state !== null) {
                await this.buildIncremental(t0, reason);
            } else {
                await this.buildFull(t0, reason);
            }
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }

    /** 全量构建(首扫/手动/换根/增量门失效回退;权威口径) */
    private async buildFull(t0: number, reason: string): Promise<void> {
        const snapshot = await this.builder(this.fs, this.opts.workspaceRoot, reason, this.now);
        snapshot.durationMs = this.now() - t0;
        this.finishBuild(snapshot);
        // rc-mtime 记账(增量门的地基):全部包记当前 rc mtime(无 rc → -1,下轮保守重扫)
        const book = new Map<string, number>();
        for (const name of snapshot.packages.keys()) {
            book.set(name, await this.rcMtimeOf(snapshot.buildRoot, name));
        }
        this.rcAtScan = book;
    }

    /**
     * 增量构建(构建信号专属;前置:`state !== null` 且 reason = 构建信号)。
     * 门判定 → 零变化快速路 / 按包重扫 → 与前快照按包合成 → 统一收尾(指纹 + 双事件)。
     */
    private async buildIncremental(t0: number, reason: string): Promise<void> {
        const prev = this.state as BuildMapSnapshot;
        const ctx = await locateBuildRoot(this.fs, this.opts.workspaceRoot);
        if (ctx === undefined) {
            throw new Error(l10n.t("build/ not found (build-only mode requires build artifacts): {0}", this.opts.workspaceRoot));
        }
        const names = (await this.fs.readdir(ctx.buildRoot)) ?? [];
        const candidates: string[] = [];
        for (const name of names.slice().sort()) {
            if (name.startsWith(".") || name === "COLCON_IGNORE" || !PKG_NAME_RE.test(name)) {
                continue;
            }
            const st = await this.fs.stat(pjoin(ctx.buildRoot, name));
            if (st !== undefined && st.kind === "dir") {
                candidates.push(name);
            }
        }
        // 门判定:逐包 stat rc;不等 / 上次无 rc / 新目录 → 重扫(保守:宁可多扫,不可漏新)
        const rcNow = new Map<string, number>();
        const changed: string[] = [];
        for (const name of candidates) {
            const m = await this.rcMtimeOf(ctx.buildRoot, name);
            rcNow.set(name, m);
            const prevRc = this.rcAtScan.get(name);
            if (!prev.packages.has(name) || prevRc === undefined || prevRc === -1 || prevRc !== m) {
                changed.push(name);
            }
        }
        const removed = Array.from(prev.packages.keys()).filter((n) => !rcNow.has(n));
        if (changed.length === 0 && removed.length === 0) {
            return; // 快速路:零扫描零事件(no-op 构建产物未变)
        }
        // 按包合成:未变的包连数据带跳转原样保留
        const packages = new Map(prev.packages);
        const jumps = new Map(prev.jumps);
        const areas = new Map(prev.areas);
        const warnings = prev.warnings.slice();
        for (const n of removed) {
            packages.delete(n);
            jumps.delete(n);
            areas.delete(n);
            rcNow.delete(n);
        }
        // 逐包重扫(逐包容错:单包失败保前值 + 记警告,不污染其它包)
        const scanSet = new Map<string, BuildPackage>();
        for (const n of changed) {
            try {
                const traits = await readTraits(this.fs, pjoin(ctx.buildRoot, n), n);
                if (!traits.cmake && !traits.python && !traits.colcon) {
                    // 特征全失(目录被清空等)→ 按删除处置
                    packages.delete(n);
                    jumps.delete(n);
                    areas.delete(n);
                    rcNow.delete(n);
                    continue;
                }
                scanSet.set(n, {
                    name: n,
                    buildDir: pjoin(ctx.buildRoot, n),
                    type: inferType(traits),
                    traits,
                });
            } catch (err) {
                warnings.push(l10n.t("Incremental rescan {0} failed; keeping previous value: {1}", n, err instanceof Error ? err.message : String(err)));
            }
        }
        if (scanSet.size > 0) {
            // 2026-09-24(测试改造 B0)同口径:测试可执行永远 installed=false
            const { jumps: j2, warnings: w2 } = await collectJumps(this.fs, ctx, scanSet, { includeUninstalled: true });
            const { areas: a2, warnings: w3 } = await collectAreas(this.fs, ctx, scanSet, j2);
            for (const [n, v] of j2) {
                jumps.set(n, v);
            }
            for (const [n, v] of a2) {
                areas.set(n, v);
            }
            warnings.push(...w2, ...w3);
            for (const [n, v] of scanSet) {
                packages.set(n, v);
            }
        }
        this.rcAtScan = rcNow;
        this.finishBuild({
            workspaceRoot: prev.workspaceRoot,
            buildRoot: ctx.buildRoot,
            srcRoot: ctx.srcRoot,
            packages,
            jumps,
            areas,
            warnings,
            durationMs: this.now() - t0,
            builtAt: this.now(),
            reason,
        });
    }

    /** `build/<pkg>/colcon_build.rc` 的 mtimeMs(无/非文件 → -1) */
    private async rcMtimeOf(buildRoot: string, name: string): Promise<number> {
        const st = await this.fs.stat(pjoin(buildRoot, name, "colcon_build.rc"));
        return st !== undefined && st.kind === "file" ? st.mtimeMs : -1;
    }

    /** 统一收尾:整体指纹 + 逐包差分 → 双缓冲原子替换 → 按需双事件(全程无"映射真空期") */
    private finishBuild(snapshot: BuildMapSnapshot): void {
        const fingerprint = fingerprintOfSnapshot(snapshot);
        const newPkgFp = packageFingerprints(snapshot);
        const firstReady = this.state === null;
        const mapChanged = firstReady || fingerprint !== this.fingerprint;
        const touched = firstReady ? [] : diffPackageFingerprints(this.pkgFingerprints, newPkgFp);
        this.state = snapshot;
        this.fingerprint = fingerprint;
        this.pkgFingerprints = newPkgFp;
        this.lastRefreshAt = this.now();
        this.lastError = undefined;
        if (mapChanged) {
            this.fire({ map: snapshot });
        }
        if (touched.length > 0) {
            this.firePackages(touched);
        }
    }

    private fire(ev: BuildMapChangeEvent): void {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(ev);
            } catch {
                // 订阅方异常不影响数据中心
            }
        }
    }

    /** 包级差分广播(订阅方异常不影响数据中心) */
    private firePackages(names: string[]): void {
        for (const listener of Array.from(this.pkgListeners)) {
            try {
                listener(names);
            } catch {
                // 订阅方异常不影响数据中心
            }
        }
    }
}
