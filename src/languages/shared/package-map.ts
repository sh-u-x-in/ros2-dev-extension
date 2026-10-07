/**
 * 共享 ROS 包路径映射
 *
 * 供 xacro / launch 等语言模块复用,解析包定位表达式:
 *  - $(find pkg)/rest、$(find-pkg-share pkg)/rest
 *  - package://pkg/rest(06 设计 P0)
 *  - 统一文件引用入口 resolveFileRef(06 §2.2)
 *
 * 双来源(2026-09-04 链收尾:系统名单吃 package-core system 域,不再自调 ros2 pkg list):
 *  - 工作区包表:package-core workspace 域(extension 把 core.onDidChange workspace → refreshWorkspace)
 *  - 系统包:名单 = core.system 域(acceptSystem 喂入;extension 在 env 变化 → core.refreshSystem → ev.system 后喂入);
 *    目录 = 位置懒获取(ros2 pkg prefix,用到才查,单飞缓存);命中系统包名但位置未取 → 本次 undefined,
 *    就绪后 fire onDirLoaded
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getLogger } from "../../logger";
import type { Ros2ServiceApi } from "../../ros2/api";
import { composeApi } from "../../ros2/api";
import { getPackageCore } from "../../build-tool/package-core/api";

/** 命令域查询实例(经组合根注入;只依赖 api/ 接口类型) */
const ros2ServiceApi: Ros2ServiceApi = composeApi.ros2ServiceApi;

const log = getLogger("package-map");

// 排除产物目录:统一用共享 DEFAULT_EXCLUDED_DIR_NAMES(见 excluded-paths.ts,目录名级任意层级)
// 兜底(无共享缓存)与主路径同口径走 walk:共享排除集合/超时/深度/符号跟随设置

/** 系统包位置就绪事件载荷(07 挂接 → pending 边重解析) */
export interface SystemDirLoadedEvent {
    pkg: string;
    dir: vscode.Uri;
}

/** 包的可执行条目(LJ-5,2026-10-01):name = 安装名(路径 basename),path = 安装侧绝对路径 */
export interface SystemExecutable {
    name: string;
    path: string;
}

/**
 * 包变化的最小原子事件(2026-09-13 落地 package-map.md §5;消费方 = rosmsg 包表)。
 * 由本类把 core 的全量差量【拆碎】后逐条投递——改名/移动自然成为一对 remove + add,
 * 不需要第三种事件类型;顺序任意(消费方逐条消费、处理幂等)。
 */
export interface PackageAtomEvent {
    kind: "add" | "remove";
    pkgName: string;
    /** 包目录,统一带尾分隔符(与下游包表键同一口径;package-map.md §5.2 硬要求) */
    pkgPath: string;
}

/** 目录键:归一化 + 统一带尾分隔符(与 rosmsg 包表键同一口径) */
const toDirKey = (dir: string): string => {
    const n = path.normalize(dir);
    return n.endsWith(path.sep) ? n : n + path.sep;
};

export class PackageMap {
    private packages = new Map<string, vscode.Uri>();
    /** 系统包名集合(来源 = package-core system 域,acceptSystem 喂入;2026-09-04 起不自调 ros2 pkg list) */
    private systemPackageNames = new Set<string>();
    /** 系统包位置缓存(懒获取成功后落盘) */
    private systemPackageDirs = new Map<string, vscode.Uri>();
    private pendingDirFetches = new Map<string, Promise<void>>();
    /** 系统可执行名单缓存(LJ-5;pkg → 条目;CLI 查询成功后落盘,含"成功但空" []) */
    private systemExecutables = new Map<string, SystemExecutable[]>();
    private pendingExecFetches = new Map<string, Promise<SystemExecutable[] | undefined>>();
    private dirLoadedEmitter = new vscode.EventEmitter<SystemDirLoadedEvent>();
    private systemListEmitter = new vscode.EventEmitter<void>();
    /** 包原子事件发射器(拆碎投递;rosmsg 消费) */
    private packageAtomEmitter = new vscode.EventEmitter<PackageAtomEvent>();
    /** 系统名单是否已知(core system 域已刷新,含"成功但空");false = 未刷新/失败 */
    private systemKnown = false;
    /** 工作区包表是否已知(core workspace 域已刷新;false = 未知,不许据此判「谁都不属」) */
    private workspaceKnown = false;
    /** 包变化差集的上一版快照(name → dir;基线由 initialize 建立,之后随每次 refreshWorkspace 滚动) */
    private lastEntries = new Map<string, string>();
    /** initialize 幂等(多次调用只跑一次基线扫描) */
    private initPromise: Promise<void> | undefined;
    private initialized = false;
    /** 系统包位置查询缝(2026-09-28 修复批:可注入;缺省 = ros2ServiceApi.pkg_prefix。测试注入假 map 免真 ros2) */
    private readonly fetchPkgPrefix: (name: string) => Promise<string | null>;
    /** 系统可执行名单查询缝(LJ-5:可注入;缺省 = ros2ServiceApi.pkg_executables_full) */
    private readonly fetchPkgExecutablesFull: (name: string) => Promise<string[] | null>;

    constructor(
        pkgPrefix?: (name: string) => Promise<string | null>,
        pkgExecutablesFull?: (name: string) => Promise<string[] | null>
    ) {
        this.fetchPkgPrefix = pkgPrefix ?? ((name) => ros2ServiceApi.pkg_prefix({ name }));
        this.fetchPkgExecutablesFull = pkgExecutablesFull ?? ((name) => ros2ServiceApi.pkg_executables_full({ name }));
    }

    /** 系统包位置懒获取完成时触发(07 挂接 reparsePending) */
    readonly onDirLoaded: vscode.Event<SystemDirLoadedEvent> = this.dirLoadedEmitter.event;

    /** 系统名单更新通知(2026-09-04:core system 域更新 → acceptSystem 后触发;2026-09-13 起含"环境回推"——名单未变也触发;rosmsg 据此重建系统消息) */
    readonly onSystemListChanged: vscode.Event<void> = this.systemListEmitter.event;

    /**
     * 包原子事件(2026-09-13:package-map.md §5 落地)——把 core 全量差量拆碎成最小原子逐条投递。
     * 与 refreshWorkspace/acceptSystem 链【并行】,不替代:内部包表自身仍按原链更新。
     */
    readonly onPackageAtom: vscode.Event<PackageAtomEvent> = this.packageAtomEmitter.event;

    /** 工作区包表是否已就绪(core workspace 域已刷新;rosmsg R2 门控:未知时不许判「谁都不属」) */
    get workspaceReady(): boolean {
        return this.workspaceKnown;
    }

    /** R1:工作区全部包(名字+目录)快照——不触发系统包位置懒取(package-map.md §6 硬约束 2) */
    getWorkspaceEntries(): Array<{ name: string; dir: string }> {
        const out: Array<{ name: string; dir: string }> = [];
        for (const [name, uri] of this.packages) {
            out.push({ name, dir: uri.fsPath });
        }
        return out;
    }

    /** 系统名单是否已就绪(core system 域已刷新;供诊断 D7 / rosmsg 门控) */
    get systemAvailable(): boolean {
        return this.systemKnown;
    }

    /**
     * 全部已知包名(2026-09-05 新增,launch 补全/校验用):工作区包名(排序)在前,系统包名(名单就绪时)在后去重。
     * 系统名单未就绪(systemAvailable=false)时只含工作区包——避免把"未知"当"不存在"。
     */
    getPackageNames(): string[] {
        const names = Array.from(this.packages.keys()).sort();
        if (this.systemKnown) {
            for (const n of Array.from(this.systemPackageNames).sort()) {
                if (!names.includes(n)) {
                    names.push(n);
                }
            }
        }
        return names;
    }

    /** 初始化(幂等:并发/重复调用只跑一次基线扫描;测试与多消费方共用安全) */
    initialize(): Promise<void> {
        if (this.initialized) {
            return Promise.resolve();
        }
        if (!this.initPromise) {
            this.initPromise = this.doInitialize().finally(() => {
                this.initPromise = undefined;
            });
        }
        return this.initPromise;
    }

    private async doInitialize(): Promise<void> {
        // 工作区包表:立即扫描(读 package-core workspace 域)。
        // 系统名单:不在此加载——由 extension 在 env 变化 → core.refreshSystem() → ev.system 后 acceptSystem 喂入。
        await this.scanPackages();
        this.lastEntries = this.currentEntries(); // 基线快照:不投递事件(首次静默)
        this.initialized = true;
        log.debug(`包映射初始化完成:${this.packages.size} 个工作区包(就绪=${this.workspaceKnown};系统名单待 core.system 域就绪后喂入)`);
    }

    /** 刷新工作区包表(事件驱动:core workspace 域变化)——扫描后把差量拆碎、逐条投递原子事件 */
    async refreshWorkspace(): Promise<void> {
        await this.scanPackages();
        this.emitWorkspaceDiff();
    }

    /**
     * 差量拆碎投递(package-map.md §5.3):键 = (包名, 包路径) 有序对——
     * 目录改名 / 包改名都自然成为一对 remove + add;顺序固定为【先 remove 后 add】。
     */
    private emitWorkspaceDiff(): void {
        const prev = this.lastEntries;
        const next = this.currentEntries();
        this.lastEntries = next;
        for (const [name, dir] of prev) {
            if (next.get(name) !== dir) {
                this.packageAtomEmitter.fire({ kind: "remove", pkgName: name, pkgPath: toDirKey(dir) });
            }
        }
        for (const [name, dir] of next) {
            if (prev.get(name) !== dir) {
                this.packageAtomEmitter.fire({ kind: "add", pkgName: name, pkgPath: toDirKey(dir) });
            }
        }
    }

    /** 当前工作区包表快照(name → 目录路径) */
    private currentEntries(): Map<string, string> {
        const m = new Map<string, string>();
        for (const [name, uri] of this.packages) {
            m.set(name, uri.fsPath);
        }
        return m;
    }

    /**
     * 采纳 package-core system 域(2026-09-04 链收尾:名单不再自调 ros2 pkg list)。
     * entries = 域条目(null = 未刷新/失败 → 清空并标记不可用;[] = 成功但空)。
     * 清掉已消失包的目录缓存;并**总是** fire onSystemListChanged(2026-09-13 对齐:env 回推语义——
     * 调用方只在"环境变化后刷新"或"种子"时调用,即使名单未变也要通知下游重推,如 rosmsg 系统索引)。
     */
    acceptSystem(entries: ReadonlyArray<{ name: string }> | null): void {
        // LJ-5:可执行名单依赖环境内容(overlay 顺序/安装内容),env 回推即可能变——
        // 两分支都整体失效(与目录缓存的"只清消失包"不同:名单按需懒查,重查代价一次 CLI)
        this.systemExecutables.clear();
        this.pendingExecFetches.clear();
        if (!entries) {
            this.systemKnown = false;
            this.systemPackageNames.clear();
            this.systemPackageDirs.clear();
            this.systemListEmitter.fire();
            return;
        }
        const next = new Set<string>();
        for (const e of entries) {
            next.add(e.name);
        }
        const changed = next.size !== this.systemPackageNames.size
            || Array.from(next).some((n) => !this.systemPackageNames.has(n));
        this.systemPackageNames = next;
        this.systemKnown = true;
        if (changed) {
            for (const dirPkg of Array.from(this.systemPackageDirs.keys())) {
                if (!next.has(dirPkg)) {
                    this.systemPackageDirs.delete(dirPkg);
                }
            }
        }
        // 2026-09-13:无条件 fire(env 回推语义;名单未变时消费方仍需重推,如消息索引依赖环境内容)
        this.systemListEmitter.fire();
    }

    /**
     * 查包根目录,两级查找(06 §0.2):
     *  1. 工作区包表命中 → 直接返回
     *  2. 系统包名集合命中 → 位置已缓存返回;未缓存触发懒获取(本次 undefined,就绪后 onDirLoaded)
     *  均未命中 → undefined
     */
    get(pkg: string): vscode.Uri | undefined {
        const dir = this.packages.get(pkg);
        if (dir) {
            return dir;
        }
        if (this.systemPackageNames.has(pkg)) {
            const sysDir = this.systemPackageDirs.get(pkg);
            if (sysDir) {
                return sysDir;
            }
            this.ensureSystemDirFetched(pkg);
            return undefined; // 本次悬空,位置就绪后事件通知
        }
        return undefined;
    }

    /**
     * 解析包目录(可等待版,2026-09-03 完善):
     *  - 工作区包/已缓存系统包:同步返回(同 get());
     *  - 系统包未缓存:触发懒取并**等待完成**(复用 pendingDirFetches 单飞,即一次 ros2 pkg prefix 的代价),
     *    成功后缓存并 fire onDirLoaded,本次即返回目录;
     *  - 包不存在(工作区/系统均未收录)或环境未就绪:undefined。
     * 供需要"本次查询就要结果"的消费方(如 rosmsg 定义跳转 / launch XML 链接的包过滤)使用——
     * 语言域不再各自调 ros2ServiceApi 目录查询(兑现 2026-08-23《优化-系统包访问统一入口》);名单 = core.system 域。
     */
    async resolvePackageDir(pkg: string): Promise<vscode.Uri | undefined> {
        const cached = this.get(pkg);
        if (cached) {
            return cached;
        }
        // get() 已对系统名集合命中触发懒取(pendingDirFetches 单飞);等待即可
        const pending = this.pendingDirFetches.get(pkg);
        if (pending) {
            await pending;
            return this.systemPackageDirs.get(pkg);
        }
        return undefined;
    }

    /**
     * 包的可执行名单(LJ-5,2026-10-01;2026-09-05 17:33 CLI 路线复活):
     * `ros2 pkg executables --full-path <pkg>` 工作区/系统包通吃——环境已 source(系统 + overlay),
     * CLI 即运行时同源,不自扫目录不做布局推断。
     *  - 缓存命中(含"成功但空" [])即返;未缓存单飞一次查询并缓存;
     *  - 失败/环境未就绪 → undefined 不缓存(可重试,fetchSystemDir 同语义);
     *  消费方:launch exec 补全(工作区 install-truth 未命中时兜底名单)与跳转
     *  (系统包直接落安装路径,2026-10-01 用户新裁定;工作区跳源定稿不变)。
     */
    async executablesOf(pkg: string): Promise<SystemExecutable[] | undefined> {
        const cached = this.systemExecutables.get(pkg);
        if (cached) {
            return cached;
        }
        const pending = this.pendingExecFetches.get(pkg);
        if (pending) {
            return pending;
        }
        const p = this.fetchSystemExecutables(pkg);
        this.pendingExecFetches.set(pkg, p);
        return p.finally(() => this.pendingExecFetches.delete(pkg));
    }

    /** 单飞查询一个包的可执行名单(成功缓存;失败 undefined 不缓存) */
    private async fetchSystemExecutables(pkg: string): Promise<SystemExecutable[] | undefined> {
        try {
            const paths = await this.fetchPkgExecutablesFull(pkg);
            if (paths === null) {
                return undefined;
            }
            const entries: SystemExecutable[] = paths.map((p) => {
                const name = p.split(/[\\/]/).pop() ?? p;
                return { name, path: p };
            });
            this.systemExecutables.set(pkg, entries);
            return entries;
        } catch (err) {
            log.debug(`系统可执行名单获取失败:${pkg}:${(err as Error).message}`);
            return undefined;
        }
    }

    /** 解析 $(find pkg)/rest 或 $(find-pkg-share pkg)/rest */
    resolveFindExpr(raw: string): vscode.Uri | undefined {
        const rel = raw.trim();
        const findRe = /\$\(\s*find(?:\s*-\s*pkg-share)?\s+([a-zA-Z0-9_-]+)\s*\)\s*\/?(.*)$/;
        const fm = rel.match(findRe);
        if (!fm) {
            return undefined;
        }
        const pkg = fm[1];
        const rest = fm[2].trim();
        const pkgDir = this.get(pkg);
        if (!pkgDir) {
            log.debug(`$(find) 包未命中:${pkg}(raw=${raw})`);
            return undefined;
        }
        if (!rest) {
            return pkgDir;
        }
        return vscode.Uri.file(path.join(pkgDir.fsPath, ...rest.split(/[/\\]/)));
    }

    private async scanPackages(): Promise<void> {
        const packages = new Map<string, vscode.Uri>();
        let known = false;
        try {
            // 【问题5 批2】2026-09-02(设计 D3):读门面 workspace 域(单一数据源,含 walk 兜底与类型就绪语义),
            // 不再 import 物理 cache。口径:workspace 域 = 合法真包(unignored+ignored,含被忽略包——包表需要全部;
            // 未声明/未知 build_type / 构建文件不匹配 / 损坏 XML 的孤立 package.xml 由域层过滤)。
            const core = getPackageCore();
            if (!core) {
                // 2026-08-30 同口径:兜底自遍历已移除——package-core 由 extension 装配时必建,
                // 缺失仅防御性处理,不再自实现 walk + 真包判定。
                log.warn("包数据中心未装配,跳过工作区包扫描");
            } else {
                let state = core.getState();
                if (state.workspace === null) {
                    await core.forceRefresh(); // 域未就绪:强制刷新(单飞共享)后重读
                    state = core.getState();
                }
                const ws = state.workspace;
                if (ws) {
                    known = true; // R2:域已刷新(含「成功但空」)——与 null(未知)严格区分
                    for (const e of ws) {
                        packages.set(e.name, vscode.Uri.file(e.dir));
                    }
                    log.debug(`package-map:从门面 workspace 域派生 ${packages.size} 个工作区真包`);
                }
            }
        } catch (err) {
            log.warn(`package.xml 扫描失败:${(err as Error).message}`);
        }
        this.packages = packages;
        this.workspaceKnown = known;
    }

    /**
     * 解析 package://pkg/rest(06 §2.1)
     */
    resolvePackageUri(raw: string): vscode.Uri | undefined {
        const rel = raw.trim();
        const m = rel.match(/^package:\/\/([^/]+)(\/.*)?$/);
        if (!m) {
            return undefined;
        }
        const pkg = m[1];
        const rest = (m[2] ?? "").replace(/^\/+/, "");
        const dir = this.get(pkg); // 未命中触发系统包懒获取
        if (!dir) {
            log.debug(`package:// 包未命中:${pkg}(raw=${raw})`);
            return undefined;
        }
        if (!rest) {
            return dir;
        }
        return vscode.Uri.file(path.join(dir.fsPath, ...rest.split(/[/\\]/)));
    }

    /**
     * 统一文件引用解析入口(06 §2.2):$(find ...) / package:// / ${} / 相对路径
     */
    resolveFileRef(raw: string, fromUri: vscode.Uri): vscode.Uri | undefined {
        const rel = raw.trim();
        if (!rel) {
            return undefined;
        }
        if (rel.indexOf("$(") >= 0) {
            return this.resolveFindExpr(rel);
        }
        if (rel.startsWith("package://")) {
            return this.resolvePackageUri(rel);
        }
        if (rel.indexOf("${") >= 0) {
            return undefined; // ${} 静态不可解析
        }
        const base = path.dirname(fromUri.fsPath);
        return vscode.Uri.file(path.resolve(base, rel));
    }

    /** 触发单个系统包位置懒获取(幂等) */
    private ensureSystemDirFetched(pkg: string): void {
        if (this.systemPackageDirs.has(pkg) || this.pendingDirFetches.has(pkg)) {
            return;
        }
        const p = this.fetchSystemDir(pkg);
        this.pendingDirFetches.set(pkg, p);
        void p.finally(() => this.pendingDirFetches.delete(pkg));
    }

    /** 懒获取一个系统包位置并缓存(直接 ros2 pkg prefix,名单已在 acceptSystem;成功 fire onDirLoaded) */
    private async fetchSystemDir(pkg: string): Promise<void> {
        try {
            const pkgPath = await this.fetchPkgPrefix(pkg);
            if (pkgPath) {
                const dir = vscode.Uri.file(pkgPath);
                this.systemPackageDirs.set(pkg, dir);
                log.trace(`系统包位置懒获取:${pkg} -> ${pkgPath}`);
                this.dirLoadedEmitter.fire({ pkg, dir });
            }
        } catch (err) {
            log.debug(`系统包位置获取失败:${pkg}:${(err as Error).message}`);
        }
    }
}
