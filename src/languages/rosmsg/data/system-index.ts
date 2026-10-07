/**
 * 系统消息子索引(2026-09-04 拆分自 data/message-index.ts,门面 = MessageIndex 组合)。
 * 职责:ros2 interface list → 二段 pkg/Name 有序数组 + 前缀二分;惰性重建;系统磁盘缓存。
 * 系统包目录不在此(那属 shared/PackageMap.resolvePackageDir,2026-09-03 收拢)。
 */
import * as path from "path";
import * as fs from "fs";
import { l10n, type ExtensionContext } from "vscode";
import { getLogger } from "../../../logger";
import { composeApi } from "../../../ros2/api";
import type { Ros2ServiceApi } from "../../../ros2/api";
import { CACHE_VERSION, RosInterfaceEntry, SystemCacheFile } from "./types";

/** 命令域查询实例(经组合根注入) */
const ros2ServiceApi: Ros2ServiceApi = composeApi.ros2ServiceApi;
/** 扩展日志薄封装(系统子索引) */
const log = getLogger("msg-sys-index");

export class SystemIndex {
    /** 系统消息索引:有序 "pkg/Name" 数组(字典序,前缀二分查询) */
    private systemSorted: string[] = [];
    /** 系统消息涉及的包名集合(构建时同步维护) */
    private systemPackages = new Set<string>();
    /** RM-1 带路径懒登记:包 → share/<pkg>/msg 下 .msg 文件名(不含扩展名;触碰该包时一次 readdir) */
    private pkgMsgFiles = new Map<string, string[]>();
    /** RM-1:包 → 接口目录绝对路径(与 pkgMsgFiles 同批) */
    private pkgMsgDirs = new Map<string, string>();
    /** RM-1 按包单飞(避免并发重复 readdir/写盘) */
    private pathSingleFlight = new Map<string, Promise<boolean>>();
    private diskCacheFile: string;
    private refreshMs: number;
    /** 最近一次系统索引刷新时间 */
    private lastSystemRefresh = 0;
    /** 系统索引是否可用(ros2 环境) */
    private systemAvailable = false;
    /** 系统索引是否已检查过 */
    private systemChecked = false;
    /** 环境可用判定(2026-09-04 链收尾:经注入回调,缺省 undefined=不门控;替代直连 ros2 getEnvIssue) */
    private readonly envAvailable?: () => boolean;

    constructor(context: ExtensionContext, refreshMs: number, envAvailable?: () => boolean) {
        this.diskCacheFile = path.join(context.globalStoragePath, "rosmsg-index.json");
        this.refreshMs = refreshMs;
        this.envAvailable = envAvailable;
        this.loadDiskCache();
    }

    /** 启动:标记已检查并按需刷新(缓存空 → 立即全量;有缓存 → 惰性) */
    initialize(): void {
        this.systemChecked = true;
        if (this.systemSorted.length === 0) {
            void this.refreshSystemFull();
        } else {
            void this.ensureSystemFresh();
        }
    }

    /** 系统索引是否可用 */
    get isAvailable(): boolean {
        return this.systemAvailable;
    }

    /** 系统包名列表(ros2 interface list 枚举,补全第 5 项用) */
    systemPackagesList(): string[] {
        return Array.from(this.systemPackages).sort();
    }

    /** 某包下的系统消息(前缀二分) */
    systemEntriesInPackage(pkg: string): RosInterfaceEntry[] {
        return this.prefixRange(this.systemSorted, pkg + "/").map((key) => this.systemEntryFromKey(key));
    }

    /** 按前缀查系统消息(前缀二分) */
    systemEntriesByPrefix(prefix: string): RosInterfaceEntry[] {
        return this.prefixRange(this.systemSorted, prefix).map((key) => this.systemEntryFromKey(key));
    }

    // ---------- RM-1 带路径懒登记(2026-09-25) ----------

    /**
     * 登记某系统包的全部 .msg 路径(按包单飞):
     * resolveDir(通常 = PackageMap.resolvePackageDir,工作区/系统两级)→ readdir share/<pkg>/msg
     * → 登记 文件名表 + 目录,随系统缓存落盘(v5)。**触发即登记整包**——跳转/悬浮一个类型,
     * 同包其余类型一并可得。包不在系统名单 / 目录解析失败 → false(不登记,点查兜底照旧)。
     */
    async registerPackagePaths(
        pkg: string,
        resolveDir: (pkg: string) => Promise<string | undefined>
    ): Promise<boolean> {
        if (this.pathSingleFlight.has(pkg)) {
            return this.pathSingleFlight.get(pkg)!;
        }
        const job = (async (): Promise<boolean> => {
            if (!this.systemAvailable || !this.systemPackages.has(pkg)) {
                return false; // 名单未就绪/包不在系统侧:不登记(工作区包由工作区索引负责)
            }
            if (this.pkgMsgFiles.has(pkg)) {
                return true; // 已登记(幂等)
            }
            const dir = await resolveDir(pkg);
            if (!dir) {
                log.debug(l10n.t("System package path registration failed (directory unresolved): {0}", pkg));
                return false;
            }
            const msgDir = path.join(dir, "msg");
            let names: string[] = [];
            try {
                names = fs.readdirSync(msgDir)
                    .filter((f) => f.endsWith(".msg"))
                    .map((f) => f.slice(0, -4))
                    .sort();
            } catch {
                names = []; // 目录不存在/无权限 → 登记空集(防重复探测),点查兜底照旧
            }
            this.pkgMsgDirs.set(pkg, msgDir);
            this.pkgMsgFiles.set(pkg, names);
            this.writeDiskCache();
            log.debug(l10n.t("System package path registered: {0} -> {1} .msg files ({2})", pkg, names.length, msgDir));
            return true;
        })();
        this.pathSingleFlight.set(pkg, job);
        try {
            return await job;
        } finally {
            this.pathSingleFlight.delete(pkg);
        }
    }

    /** 已登记系统消息的带路径条目(未登记/未含该名/文件已消失 → undefined) */
    systemEntryWithPath(pkg: string, name: string): RosInterfaceEntry | undefined {
        const files = this.pkgMsgFiles.get(pkg);
        const dir = this.pkgMsgDirs.get(pkg);
        if (!files || files.indexOf(name) < 0 || !dir) {
            return undefined;
        }
        const p = path.join(dir, name + ".msg");
        if (!fs.existsSync(p)) {
            return undefined;
        }
        return { pkg, name, source: "system", path: p };
    }

    /** 更新系统索引刷新间隔(ms;运行中修改 ROS2.msg.systemRefreshMinutes 时调用) */
    setRefreshIntervalMs(ms: number): void {
        this.refreshMs = Math.max(1, ms);
        log.debug(l10n.t("System index refresh interval updated:") + " " + Math.round(this.refreshMs / 1000) + "s");
    }

    /** 惰性入口:未过期则跳过,过期则全量重建 */
    async ensureSystemFresh(): Promise<void> {
        if (!this.systemChecked) { return; }
        if (Date.now() - this.lastSystemRefresh < this.refreshMs) {
            log.trace(l10n.t("System index not expired; skipping refresh"));
            return;
        }
        log.trace(l10n.t("System index expired; triggering full rebuild"));
        await this.refreshSystemFull();
    }

    /** 全量枚举 ros2 interface list → 仅消息 → 键剥 msg/ 段存二段 pkg/Name → 排序数组 + 覆盖写盘 */
    async refreshSystemFull(): Promise<void> {
        // 环境门控(2026-09-04 链收尾):由注入的 envAvailable 判定(core.system 域就绪 = 环境可用),
        // 不再直连 ros2 环境域;未注入(独立/测试)不门控
        if (this.envAvailable && !this.envAvailable()) {
            this.systemAvailable = false;
            log.debug(l10n.t("System message index refresh skipped: system list not ready (rebuilt via onSystemListChanged/ev.system once ready)"));
            return;
        }
        const lines = await this.runInterfaceList();
        if (!lines) { return; }
        const msgLines = lines
            .filter((line) => {
                const parts = line.split("/");
                return parts.length === 3 && parts[1] === "msg";
            })
            .map((line) => {
                const first = line.indexOf("/");
                const last = line.lastIndexOf("/");
                return line.slice(0, first) + "/" + line.slice(last + 1);
            });
        msgLines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        this.systemSorted = msgLines;
        this.systemPackages.clear();
        for (const line of lines) {
            const slash = line.indexOf("/");
            if (slash > 0) { this.systemPackages.add(line.slice(0, slash)); }
        }
        this.systemAvailable = true;
        this.lastSystemRefresh = Date.now();
        // RM-1:环境名单变化 → 按新名单修剪带路径登记(名单里消失的包一并撤销)
        for (const pkg of Array.from(this.pkgMsgFiles.keys())) {
            if (!this.systemPackages.has(pkg)) {
                this.pkgMsgFiles.delete(pkg);
                this.pkgMsgDirs.delete(pkg);
            }
        }
        this.writeDiskCache();
        log.debug("系统消息索引全量重建完成,共 " + lines.length + " 条 / " + this.systemPackages.size + " 个包");
    }

    /**
     * 注入系统名单快照(与 refreshSystemFull 同效的名单面;2026-09-25 RM-1):
     * 供测试注入,也为"上游直接给出名单"的场景保留入口——不触发 CLI,直接建表+修剪登记+落盘。
     */
    applySystemSnapshot(keys: string[]): void {
        const msgKeys = keys
            .filter((k) => k.split("/").length === 2)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        this.systemSorted = msgKeys;
        this.systemPackages.clear();
        for (const key of msgKeys) {
            this.systemPackages.add(key.slice(0, key.indexOf("/")));
        }
        this.systemAvailable = true;
        this.lastSystemRefresh = Date.now();
        // 与 refreshSystemFull 同口径:名单变化 → 修剪带路径登记
        for (const pkg of Array.from(this.pkgMsgFiles.keys())) {
            if (!this.systemPackages.has(pkg)) {
                this.pkgMsgFiles.delete(pkg);
                this.pkgMsgDirs.delete(pkg);
            }
        }
        this.writeDiskCache();
    }

    /** 全量枚举 ros2 interface list(经命令域 interface_list;失败 null) */
    private async runInterfaceList(): Promise<string[] | undefined> {
        try {
            const lines = await ros2ServiceApi.interface_list({});
            if (lines === null) {
                this.systemAvailable = false;
                log.warn(l10n.t("ros2 interface list failed (falling back to workspace + built-in)"));
                return undefined;
            }
            return lines;
        } catch (err) {
            this.systemAvailable = false;
            log.warn(l10n.t("ros2 interface list failed (falling back to workspace + built-in):") + " " + (err as Error).message);
            return undefined;
        }
    }

    private loadDiskCache(): void {
        try {
            if (!fs.existsSync(this.diskCacheFile)) { return; }
            const raw = fs.readFileSync(this.diskCacheFile, "utf8");
            const cache = JSON.parse(raw) as SystemCacheFile;
            if (cache.version !== CACHE_VERSION || !Array.isArray(cache.interfaces)) { return; }
            this.systemSorted = cache.interfaces;
            this.systemPackages.clear();
            for (const key of this.systemSorted) {
                const slash = key.indexOf("/");
                if (slash > 0) { this.systemPackages.add(key.slice(0, slash)); }
            }
            // RM-1:带路径登记随缓存恢复(v5 起)
            this.pkgMsgFiles.clear();
            this.pkgMsgDirs.clear();
            if (cache.pkgMsgFiles) {
                for (const [pkg, files] of Object.entries(cache.pkgMsgFiles)) {
                    if (Array.isArray(files)) { this.pkgMsgFiles.set(pkg, files); }
                }
            }
            if (cache.pkgMsgDirs) {
                for (const [pkg, dir] of Object.entries(cache.pkgMsgDirs)) {
                    if (typeof dir === "string") { this.pkgMsgDirs.set(pkg, dir); }
                }
            }
            this.lastSystemRefresh = cache.updatedAt || 0;
            log.debug("系统消息索引从磁盘加载,共 " + this.systemSorted.length + " 条 / " + this.systemPackages.size + " 个包"
                + "(带路径登记 " + this.pkgMsgFiles.size + " 包)");
        } catch (err) {
            log.warn(l10n.t("Disk cache load failed:") + " " + (err as Error).message);
        }
    }

    private writeDiskCache(): void {
        try {
            fs.mkdirSync(path.dirname(this.diskCacheFile), { recursive: true });
            const pkgMsgFiles: Record<string, string[]> = {};
            for (const [pkg, files] of this.pkgMsgFiles) {
                pkgMsgFiles[pkg] = files;
            }
            const pkgMsgDirs: Record<string, string> = {};
            for (const [pkg, dir] of this.pkgMsgDirs) {
                pkgMsgDirs[pkg] = dir;
            }
            const cache: SystemCacheFile = {
                version: CACHE_VERSION,
                updatedAt: this.lastSystemRefresh,
                interfaces: this.systemSorted,
                pkgMsgFiles,
                pkgMsgDirs,
            };
            fs.writeFileSync(this.diskCacheFile, JSON.stringify(cache), "utf8");
            log.trace(l10n.t("System message index written to disk:") + " " + this.diskCacheFile);
        } catch (err) {
            log.warn(l10n.t("Disk cache write failed:") + " " + (err as Error).message);
        }
    }

    // ---------- 前缀二分 ----------

    private lowerBound(arr: string[], target: string): number {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) { lo = mid + 1; } else { hi = mid; }
        }
        return lo;
    }

    private prefixRange(arr: string[], prefix: string): string[] {
        const lo = this.lowerBound(arr, prefix);
        const hi = this.lowerBound(arr, prefix + "\uffff");
        return arr.slice(lo, hi);
    }

    private systemEntryFromKey(key: string): RosInterfaceEntry {
        const slash = key.indexOf("/");
        return { pkg: key.slice(0, slash), name: key.slice(slash + 1), source: "system" };
    }
}