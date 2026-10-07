/**
 * 工作区消息子索引(2026-09-13 按 `手工重设计/rosmsg-v3.md`「三张表 + 四个事件 + op 流」重构,
 * 原「包名 → Map」结构与「包名实时读 core 门面 / 包变化全量重扫」路径作废)。
 *
 * 结构:写线 IndexWriter(正表/反表/包表)+ 读线 IndexReader(正表/反表副本,只经 op 同步);
 *  查询全部落读线;包表来源 = 注入的 PackageSource(PackageMap:R1 快照 / R2 就绪 / R3 原子事件)。
 *
 * 事件源:
 *  - .msg 文件事件(watcher + rename 补盲)→ 消息增加/删除(写线 → 一组 op → 读线);
 *  - 包原子事件(PackageMap 拆碎投递)→ 新增包(反表前缀扫认领)/删除包(包级继承);
 *  - 60 秒兜底 = 全量 walk 重建基线(经 op diff 收敛;timedOut 不做收敛——允许滞后不允许错误);
 *  - 节流(rosmsg-v3.md §7.2):启动取一次基线不开定时器;首次打开 .msg 才开启;关窗冻结不归零。
 *
 * 归属判定/四事件/op 细节见 tables.ts;磁盘缓存 = 正表快照(v4),反表由正表重建、包表不落盘。
 */
import { l10n } from 'vscode'; // 2026-10-04 i18n 期2
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getLogger } from "../../../logger";
import { walkOptions, walkWithTimeout, DEFAULT_EXCLUDED_DIR_NAMES } from "../../../build-tool/walk";
import {
    MSG_GLOB, WORKSPACE_CACHE_WRITE_DEBOUNCE_MS,
    RosInterfaceEntry, WorkspaceCacheFile,
    workspaceCacheToPayload, workspaceCacheFromPayload,
} from "./types";
import type { IndexOp } from "./tables";
import { IndexReader, IndexWriter, LOOSE_PKG, dirKey, normFile } from "./tables";

/** 扩展日志薄封装(工作区子索引) */
const log = getLogger("msg-ws-index");

/** 包变化的最小原子事件(PackageMap 拆碎投递;package-map.md §5 / rosmsg-v3.md §4) */
export interface PackageAtomEvent {
    kind: "add" | "remove";
    pkgName: string;
    /** 包目录,统一带尾分隔符(与包表键同一口径) */
    pkgPath: string;
}

/**
 * rosmsg 对上游(PackageMap)的最小要求(rosmsg-v3.md §7.4):R1 全量快照 / R2 就绪 / R3 原子事件。
 * PackageMap 以结构类型满足本接口;测试可注入 fake。
 */
export interface PackageSource {
    /** R1:工作区全部包(名字+目录;不触发系统包位置懒取) */
    getWorkspaceEntries(): ReadonlyArray<{ name: string; dir: string }>;
    /** R2:工作区包表就绪(core workspace 域已刷新);false = 未知,不许据此判「谁都不属」 */
    readonly workspaceReady: boolean;
    /** R3:包原子事件(add/remove;改名自动拆成 remove+add,逐条投递) */
    onPackageAtom(cb: (ev: PackageAtomEvent) => void): { dispose(): void };
    /** 幂等初始化(可选;PackageMap.initialize) */
    initialize?(): Promise<void>;
    /** RM-1(2026-09-25):包目录解析(工作区优先/系统懒取;单飞+缓存在上游)。带路径系统登记用;可选 */
    resolvePackageDir?(pkg: string): Promise<{ fsPath: string } | undefined>;
}

/** 大变更阈值:一组 op 超过此数 → 以整表批替换承接(语义 = 全量 op 组;避免逐条 splice 的 O(N²)) */
const BULK_REPLACE_THRESHOLD = 2000;

/** 工作区消息子索引(三张表 + 四个事件 + op 流) */
export class WorkspaceIndex {
    /** 写线:三张表(正表/反表/包表);事件处理完经 op 发往读线 */
    private readonly writer: IndexWriter;
    /** 读线:两张表副本(只经 op 同步);查询全部落这里 */
    private readonly reader = new IndexReader();
    /** 包表来源(PackageMap;缺省 = 无包表,一切按非法包归类) */
    private readonly packages?: PackageSource;

    /** .msg 文件监听(watcher 事件无排除参数,增量面补与 walk 同口径的产物目录过滤) */
    private watcher: vscode.FileSystemWatcher | undefined;
    /** .msg rename 补盲(Explorer 拖拽/F2 整目录移动对 glob watcher 常漏报 → 旧路径删 + 新路径增) */
    private renameSub: vscode.Disposable | undefined;
    /** 包原子事件订阅(取消句柄) */
    private packageUnsub: { dispose(): void } | undefined;
    /** 订阅与首次快照之间到达的包事件缓冲(快照建立后按序重放;处理幂等) */
    private readonly pendingAtoms: PackageAtomEvent[] = [];
    private atomsOpen = false;

    /** 工作区消息磁盘缓存文件(独立于系统缓存,按工作区隔离) */
    private workspaceCacheFile: string;
    /** 缓存所属工作区根路径(防跨工作区误用) */
    private workspaceRootForCache: string;
    /** 工作区缓存写盘防抖定时器 */
    private workspaceCacheWriteTimer: NodeJS.Timeout | undefined;

    /** 写操作单飞链(全量/增量/补登共用 = 单写者队列) */
    private chain: Promise<void> = Promise.resolve();

    /** 节流调度(rosmsg-v3.md §7.2):活动→计时推进;冻结→保留已过时间不归零 */
    private rescanActive = false;
    private rescanElapsedMs = 0;
    private rescanStartedAt: number | undefined;
    private rescanTimer: NodeJS.Timeout | undefined;

    constructor(context: vscode.ExtensionContext, packages?: PackageSource) {
        this.packages = packages;
        this.writer = new IndexWriter((ops) => this.dispatchOps(ops));
        // 工作区缓存:优先 workspaceStorage(天然按工作区隔离),回退 globalStorage + 根路径 hash
        this.workspaceRootForCache = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        if (context.storageUri) {
            this.workspaceCacheFile = path.join(context.storageUri.fsPath, "rosmsg-workspace.json");
        } else {
            this.workspaceCacheFile = path.join(context.globalStoragePath, "rosmsg-workspace-" + this.simpleHash(this.workspaceRootForCache) + ".json");
        }
        this.loadWorkspaceCache();
    }

    /* ---------- op 分发(写线 → 读线) ---------- */

    /** 小批量 → 读线逐条 apply;大批量(含首建) → 整表批替换(全量 op 组的批量实现) */
    private dispatchOps(ops: IndexOp[]): void {
        if (ops.length > BULK_REPLACE_THRESHOLD) {
            log.debug(l10n.t("ws-index: op ") + ops.length + l10n.t(" entries -> whole-table batch replace (read line)"));
            this.reader.replaceAll(this.writer.snapshotTables());
        } else if (ops.length > 0) {
            log.trace(l10n.t("ws-index: op ") + ops.length + l10n.t(" entries -> per-entry apply on read line"));
            this.reader.apply(ops);
        }
    }

    /* ---------- 启动 / 包原子事件消费 ---------- */

    /** 启动:包表就绪 → 先订阅(缓冲)→ 快照 → 重放 → 全量基线 walk → 监听(节流待命,不自动开定时器) */
    async initialize(): Promise<void> {
        // ① 包表来源就绪(PackageSource 幂等初始化;未注入 = 无包表,全部按非法包归类)
        try {
            await this.packages?.initialize?.();
        } catch (err) {
            log.warn(l10n.t("Package table source init failed:") + " " + (err as Error).message);
        }
        // ② 先订阅(缓冲)、再快照、最后重放——消除「快照/订阅」之间的丢事件窗口
        if (this.packages) {
            this.packageUnsub = this.packages.onPackageAtom((ev) => this.onPackageAtom(ev));
            if (this.packages.workspaceReady) {
                this.writer.setPackages(this.packages.getWorkspaceEntries());
            } else {
                log.warn(l10n.t("Workspace package table not ready: building with an empty table first; converges when package atomic events arrive (not-ready must not judge \"belongs to nobody\")"));
            }
        }
        this.atomsOpen = true;
        for (const ev of this.pendingAtoms.splice(0)) {
            this.applyPackageAtom(ev);
        }
        // ③ 全量基线(walk):缓存已装载则以其为基线做 diff,否则全量构建
        await this.refreshWorkspace();
        // ④ 文件监听(60s 兜底定时器不在此启动——节流:首次打开 .msg 才开启)
        this.setupWorkspaceWatcher();
        log.info(l10n.t("Workspace message index ready:") + " " + this.reader.packageNamesWithMsg().length + l10n.t(" workspace packages /") + " " + this.countEntries() + l10n.t(" messages"));
    }

    /** 包原子事件入口(缓冲期先入库;开闸后逐条消费——处理一条落地一条,不攒批) */
    private onPackageAtom(ev: PackageAtomEvent): void {
        if (!this.atomsOpen) {
            this.pendingAtoms.push(ev);
            return;
        }
        this.applyPackageAtom(ev);
    }

    /** 单条包事件落地(写线;幂等、顺序任意):add → 前缀扫认领;remove → 包级继承 */
    private applyPackageAtom(ev: PackageAtomEvent): void {
        const dirK = dirKey(ev.pkgPath);
        if (ev.kind === "add") {
            log.debug("pkg-atom:add " + ev.pkgName + " @" + path.basename(dirK));
            this.writer.addPackage(ev.pkgName, dirK);
        } else {
            log.debug("pkg-atom:remove " + ev.pkgName + " @" + path.basename(dirK));
            this.writer.removePackage(ev.pkgName, dirK);
        }
        this.scheduleWorkspaceCacheWrite();
    }

    /** 工作区写操作统一入队(全量与增量同链串行,单写者队列,消除竞态) */
    private enqueue(task: () => void | Promise<void>): Promise<void> {
        const run = this.chain.then(task);
        this.chain = run.catch(() => undefined);
        return run;
    }

    /* ---------- 全量基线(60s 兜底 / 首载 / 手动) ---------- */

    /** 全量重建基线(walk 全部工作区文件夹 → 写线 rebuild → 一组 op → 读线) */
    async refreshWorkspace(): Promise<void> {
        await this.enqueue(() => this.doRefreshWorkspace());
    }

    private async doRefreshWorkspace(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            log.warn(l10n.t("Workspace message scan failed: no workspace root"));
            return;
        }
        const files: string[] = [];
        let timedOut = false;
        const opts = walkOptions("message");
        for (const folder of folders) {
            try {
                const result = await walkWithTimeout(folder.uri.fsPath, /\.msg$/, opts);
                if (result.timedOut) {
                    timedOut = true;
                }
                for (const p of result.matches) {
                    files.push(p);
                }
            } catch (err) {
                log.warn(l10n.t("Workspace message scan failed:") + " " + folder.uri.fsPath + " (" + (err as Error).message + ")");
                return; // 扫描失败:不动表(保留旧基线)
            }
        }
        if (timedOut) {
            // 允许滞后不允许错误:部分结果不用于收敛,保留旧表等下轮(预算伪影不制造误删)
            log.warn(l10n.t("Workspace message scan timed out (") + opts.totalTimeoutMs + l10n.t(" ms); no convergence this round: keeping old table, retry next round"));
            return;
        }
        this.writer.rebuild(files);
        log.debug(l10n.t("Workspace message full rebuild finished:") + " " + files.length + l10n.t(" files, read-line package count") + " " + this.reader.packageNamesWithMsg().length);
        this.scheduleWorkspaceCacheWrite();
    }

    /* ---------- 节流(启动不开 / 首开才开 / 关窗冻结不归零) ---------- */

    /** 节流开关(UI 层接线:任一 rosmsg 文档打开 = 活动;全部关闭 = 冻结) */
    setRescanActive(active: boolean): void {
        if (active === this.rescanActive) {
            return;
        }
        this.settleElapsed();
        this.rescanActive = active;
        log.debug(l10n.t("ws-index: throttle ") + (active ? l10n.t("resumed (timer continues)") : l10n.t("frozen (timer kept, not reset)")));
        this.armRescan();
    }

    /** 结算当前推进段的已过时间(冻结/配置变化时调用) */
    private settleElapsed(): void {
        if (this.rescanStartedAt !== undefined) {
            this.rescanElapsedMs += Date.now() - this.rescanStartedAt;
            this.rescanStartedAt = undefined;
        }
    }

    /** 排定下一轮兜底重扫(活动且未排定时才动;剩余 = 周期 − 已过) */
    private armRescan(): void {
        if (this.rescanTimer) {
            clearTimeout(this.rescanTimer);
            this.rescanTimer = undefined;
        }
        if (!this.rescanActive) {
            return; // 冻结:计时保留
        }
        const period = this.readRescanIntervalMs();
        if (period <= 0) {
            return; // 配置 0/非法 = 禁用
        }
        const remaining = Math.max(0, period - this.rescanElapsedMs);
        this.rescanStartedAt = Date.now();
        this.rescanTimer = setTimeout(() => {
            this.rescanTimer = undefined;
            this.rescanElapsedMs = 0;
            this.rescanStartedAt = undefined;
            void this.refreshWorkspace();
            this.armRescan(); // 续排(读取最新配置,支持动态修改)
        }, remaining);
    }

    /** 读取兜底重扫周期(ms;ROS2.msg.workspaceRescanMs,0/非正数=禁用,默认 60000) */
    private readRescanIntervalMs(): number {
        try {
            const ms = vscode.workspace.getConfiguration("ROS2").get<number>("msg.workspaceRescanMs", 60000);
            return (typeof ms === "number" && ms > 0) ? ms : 0;
        } catch {
            return 0;
        }
    }

    /* ---------- .msg 文件事件(消息增加/删除) ---------- */

    private setupWorkspaceWatcher(): void {
        if (this.watcher) {
            return;
        }
        this.watcher = vscode.workspace.createFileSystemWatcher(MSG_GLOB, false, false, false);
        this.watcher.onDidCreate((uri) => void this.onMsgUpserted(uri));
        this.watcher.onDidChange((uri) => void this.onMsgUpserted(uri));
        this.watcher.onDidDelete((uri) => void this.onMsgDeleted(uri));
        // rename 补盲(2026-09-09):Explorer 拖拽 / F2 对 glob watcher 常以目录 rename 形态出现而漏报,
        // 此处 rename → 旧路径删 + 新路径增(与全量同链串行);整目录移动若只报文件夹对,
        // 兜底 = 兜底重扫/包原子事件共同自愈(收敛结果一致)。
        this.renameSub = vscode.workspace.onDidRenameFiles((ev) => {
            for (const file of ev.files) {
                const oldMsg = this.isMsgUri(file.oldUri);
                const newMsg = this.isMsgUri(file.newUri);
                if (!oldMsg && !newMsg) {
                    continue; // 与 .msg 无关的 rename,不触发
                }
                log.debug(l10n.t("Workspace .msg rename:") + " " + file.oldUri.fsPath + " -> " + file.newUri.fsPath);
                if (oldMsg) {
                    void this.onMsgDeleted(file.oldUri);
                }
                if (newMsg) {
                    void this.onMsgUpserted(file.newUri);
                }
            }
        });
    }

    /** 消息增加事件(create/change/rename 一侧) */
    private async onMsgUpserted(uri: vscode.Uri): Promise<void> {
        const p = uri.fsPath;
        if (this.isProductPath(p)) {
            log.trace(l10n.t("Skipping .msg event inside artifact dirs:") + " " + p);
            return;
        }
        await this.enqueue(() => {
            this.writer.addMessage(p);
            this.scheduleWorkspaceCacheWrite();
        });
    }

    /** 消息删除事件(delete/rename 一侧;迟到删除天生 no-op) */
    private async onMsgDeleted(uri: vscode.Uri): Promise<void> {
        const p = uri.fsPath;
        if (this.isProductPath(p)) {
            return;
        }
        await this.enqueue(() => {
            this.writer.removeMessage(p);
            this.scheduleWorkspaceCacheWrite();
        });
    }

    /** rename 补盲判定:索引只收 .msg,rename 两端口任一是即处理(大小写容错) */
    private isMsgUri(uri: vscode.Uri): boolean {
        return path.extname(uri.fsPath).toLowerCase() === ".msg";
    }

    /** 产物目录判定(watcher 事件无排除参数,增量面补上与 walk 同口径的默认产物目录过滤) */
    private isProductPath(p: string): boolean {
        const segs = p.split("\\").join("/").split("/");
        for (const s of segs) {
            if (DEFAULT_EXCLUDED_DIR_NAMES.includes(s)) {
                return true;
            }
        }
        return false;
    }

    /* ---------- 工作区磁盘缓存(正表快照 v4) ---------- */

    private loadWorkspaceCache(): void {
        try {
            if (!fs.existsSync(this.workspaceCacheFile)) {
                return;
            }
            const raw = fs.readFileSync(this.workspaceCacheFile, "utf8");
            const cache = JSON.parse(raw) as WorkspaceCacheFile;
            if (this.workspaceRootForCache && cache.workspaceRoot !== this.workspaceRootForCache) {
                log.debug(l10n.t("Workspace cache root mismatch; discarded"));
                return;
            }
            const snap = workspaceCacheFromPayload(cache);
            if (!snap) {
                return; // 版本不符/形态不符 → 丢弃(等 walk 重建)
            }
            // 基线装载:写线与读线各持独立数组(语义 = 基线全量同步一次)
            this.writer.loadBaseline(snap);
            this.reader.replaceAll(this.writer.snapshotTables());
            log.info(l10n.t("Workspace messages loaded from disk cache, total ") + this.countEntries());
        } catch (err) {
            log.warn(l10n.t("Workspace cache load failed:") + " " + (err as Error).message);
        }
    }

    private persistWorkspaceCache(): void {
        try {
            fs.mkdirSync(path.dirname(this.workspaceCacheFile), { recursive: true });
            const cache = workspaceCacheToPayload(this.writer.pkgRows, this.workspaceRootForCache);
            fs.writeFileSync(this.workspaceCacheFile, JSON.stringify(cache), "utf8");
            log.trace(l10n.t("Workspace message cache written:") + " " + this.workspaceCacheFile);
        } catch (err) {
            log.warn(l10n.t("Workspace cache write failed:") + " " + (err as Error).message);
        }
    }

    private scheduleWorkspaceCacheWrite(): void {
        if (this.workspaceCacheWriteTimer) {
            clearTimeout(this.workspaceCacheWriteTimer);
        }
        this.workspaceCacheWriteTimer = setTimeout(() => {
            this.workspaceCacheWriteTimer = undefined;
            log.trace(l10n.t("Workspace cache debounced write"));
            this.persistWorkspaceCache();
        }, WORKSPACE_CACHE_WRITE_DEBOUNCE_MS);
    }

    private simpleHash(s: string): string {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(16);
    }

    private countEntries(): number {
        let n = 0;
        for (const r of this.writer.pkgRows) {
            n += r.entries.length;
        }
        return n;
    }

    /* ---------- 对外查询(全部落读线;未登记冷路径借用写线包表实时判定) ---------- */

    /** 某包全部消息(补全本包/悬停/诊断) */
    getMessagesInPackage(pkg: string): RosInterfaceEntry[] {
        return this.reader.entriesOf(pkg).map((m) => this.toEntry(pkg, m.name, m.path));
    }

    /** 某包某消息(内层二分;跳转/悬停精确命中) */
    findMessage(pkg: string, name: string): RosInterfaceEntry | undefined {
        const m = this.reader.findMessage(pkg, name);
        return m ? this.toEntry(pkg, m.name, m.path) : undefined;
    }

    /**
     * 当前文件属于哪个包(补全「本包」/诊断;undefined = 非法包/未归属)。
     * 读线点查优先;未登记(.srv/.action 不入索引、新文件尚未登记)→ 借用写线包表做一次
     * 归属判定(冷路径、不落库);非法包 → undefined。
     */
    getPackageForFile(filePath: string): string | undefined {
        const owner = this.reader.ownerOf(filePath) ?? this.writer.resolveOwner(normFile(filePath));
        return owner === LOOSE_PKG ? undefined : owner;
    }

    /**
     * 裸名解析(v3 §5.3/§8.5):反表点查 → miss 补登(当成一次「消息增加」事件落库)→ 再点查;
     * 仍无(非 .msg/产物目录)→ 实时归属判定(不落库)。命中非法包桶照常查(出得去);
     * 返回定义文件路径(未命中 → undefined)。
     *
     * ⚠️ 工作区**以外**的文件(2026-09-13 定案,附录 E 第 7 条):补全/裸名/跳转对它只有
     * 【查询能力】,不做补充登记——它永远不会被 walk 收录,登记只会污染非法桶与磁盘缓存;
     * 且「本包」不存在 → 裸名直接查不到(不落入非法桶语义)。
     */
    async findBareNameDefinition(filePath: string, messageName: string): Promise<string | undefined> {
        const p = normFile(filePath);
        let owner = this.reader.ownerOf(p);
        if (owner === undefined) {
            if (!this.isInWorkspace(p)) {
                log.trace(l10n.t("Bare-name resolution skipped: file outside workspace (query-only, not registered):") + " " + p);
                return undefined;
            }
            await this.enrollFile(p);
            owner = this.reader.ownerOf(p) ?? this.writer.resolveOwner(p);
        }
        return this.reader.findMessage(owner, messageName)?.path;
    }

    /**
     * 补登(v3 §5.3):只针对「本应被 walk 收录、但尚未扫到」的文件——
     * 工作区内的 .msg(且非产物目录、存在、未登记);幂等,入队串行。
     */
    async enrollFile(filePath: string): Promise<void> {
        const p = normFile(filePath);
        if (!this.isMsgUri(vscode.Uri.file(p)) || this.isProductPath(p) || !this.isInWorkspace(p)) {
            return;
        }
        if (this.reader.ownerOf(p) !== undefined) {
            return;
        }
        if (!fs.existsSync(p)) {
            return;
        }
        await this.enqueue(() => {
            this.writer.addMessage(p);
            this.scheduleWorkspaceCacheWrite();
        });
    }

    /**
     * 文件是否位于任一工作区文件夹内(补登范围闸:walk 可达 = 可登记)。
     * 用路径前缀比较(不依赖 uri scheme,Remote 场景同样成立);Windows 大小写不敏感。
     */
    private isInWorkspace(filePath: string): boolean {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return false; // 无工作区:没有 walk,补登无意义
        }
        const p = normFile(filePath);
        const pLc = p.toLowerCase();
        for (const f of folders) {
            const root = normFile(f.uri.fsPath);
            if (p === root || p.startsWith(root + path.sep)) {
                return true;
            }
            if (process.platform === "win32") {
                const rootLc = root.toLowerCase();
                if (pLc === rootLc || pLc.startsWith(rootLc + path.sep)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 有消息的工作区包名列表(补全第 3 项用;正表外层有序,天然升序) */
    getWorkspacePackagesWithMsg(): string[] {
        return this.reader.packageNamesWithMsg();
    }

    /** 限定名前缀查询(补全第 4 项;外层/内层二分或扫段) */
    getEntriesByPrefix(prefix: string): RosInterfaceEntry[] {
        return this.reader.entriesByQualifiedPrefix(prefix).map((m) => this.toEntry(m.pkg, m.name, m.path));
    }

    /** 非法消息按名前缀(补全第 6 项;哨兵行内 lowerBound + 向扫) */
    getLooseEntriesByPrefix(prefix: string): RosInterfaceEntry[] {
        return this.reader.looseEntriesByPrefix(prefix).map((m) => this.toEntry(LOOSE_PKG, m.name, m.path));
    }

    /** 内部形态 → RosInterfaceEntry(loose 字段保留:合法包条目与非法条目在 UI 侧的既有判别键) */
    private toEntry(pkg: string, name: string, p: string): RosInterfaceEntry {
        const entry: RosInterfaceEntry = { pkg, name, source: "workspace", path: p };
        if (pkg === LOOSE_PKG) {
            entry.loose = true;
        }
        return entry;
    }

    /** 释放资源 */
    dispose(): void {
        this.watcher?.dispose();
        this.watcher = undefined;
        this.renameSub?.dispose();
        this.renameSub = undefined;
        this.packageUnsub?.dispose();
        this.packageUnsub = undefined;
        if (this.rescanTimer) {
            clearTimeout(this.rescanTimer);
            this.rescanTimer = undefined;
        }
        if (this.workspaceCacheWriteTimer) {
            clearTimeout(this.workspaceCacheWriteTimer);
            this.workspaceCacheWriteTimer = undefined;
        }
    }
}
