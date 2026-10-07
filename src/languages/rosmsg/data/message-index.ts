/**
 * MessageIndex 门面(2026-09-13 三张表重构):组装 工作区子索引(WorkspaceIndex,读线查询)
 * + 系统子索引(SystemIndex,有序数组二分),对外提供统一查询 API 与生命周期。
 * 常量/类型/缓存载荷纯函数见 data/types.ts。
 *
 * 数据流(rosmsg-v3.md):写线(正/反/包表) → op → 读线(正/反表副本) ← 本门面查询;
 * 包表来源 = 组合根注入的 PackageMap(PackageSource:R1 快照 / R2 就绪 / R3 原子事件)。
 */
import * as vscode from "vscode";
import { COMMON_PACKAGES } from "../shared/interface-data";
import { RosInterfaceEntry } from "./types";
import { WorkspaceIndex, PackageSource } from "./workspace-index";
import { SystemIndex } from "./system-index";

// 兼容导出(测试/barrel):常量/类型/payload 实际在 data/types.ts
export {
    MSG_GLOB, CACHE_VERSION, WORKSPACE_CACHE_VERSION, WORKSPACE_CACHE_WRITE_DEBOUNCE_MS,
    workspaceCacheToPayload, workspaceCacheFromPayload,
} from "./types";
export type { SystemCacheFile, WorkspaceCacheFile } from "./types";
export type { RosInterfaceEntry } from "./types";
export type { PackageSource, PackageAtomEvent } from "./workspace-index";

export class MessageIndex {
    private ws: WorkspaceIndex;
    private sys: SystemIndex;
    /** RM-1:带路径系统登记的目录解析上游(= 注入的 PackageMap;结构化可选能力) */
    private readonly packages?: PackageSource;

    constructor(context: vscode.ExtensionContext, refreshMs: number, envAvailable?: () => boolean, packages?: PackageSource) {
        this.ws = new WorkspaceIndex(context, packages);
        this.sys = new SystemIndex(context, refreshMs, envAvailable);
        this.packages = packages;
    }

    /** 启动:工作区(包表就绪 → 基线 walk → 监听;兜底定时器由节流待命)+ 系统(按需刷新) */
    async initialize(): Promise<void> {
        await this.ws.initialize();
        this.sys.initialize();
    }

    /** 全量重扫工作区消息(委托;兜底重扫/手动) */
    async refreshWorkspace(): Promise<void> {
        await this.ws.refreshWorkspace();
    }

    /** 节流开关(委托;UI 层接线:任一 rosmsg 文档打开 = 活动,全部关闭 = 冻结) */
    setRescanActive(active: boolean): void {
        this.ws.setRescanActive(active);
    }

    /** 更新系统索引刷新间隔(ms;委托) */
    setRefreshIntervalMs(ms: number): void {
        this.sys.setRefreshIntervalMs(ms);
    }

    /** 惰性刷新系统索引(委托;补全触发) */
    async ensureSystemFresh(): Promise<void> {
        await this.sys.ensureSystemFresh();
    }

    /** 全量重建系统索引(委托;环境变化触发) */
    async refreshSystemFull(): Promise<void> {
        await this.sys.refreshSystemFull();
    }

    /** 系统索引是否可用 */
    get isSystemAvailable(): boolean {
        return this.sys.isAvailable;
    }

    // ---------- 组合查询 ----------

    /** 所有已知包名(常用 + 工作区 + 系统),去重排序 */
    getAllPackages(): string[] {
        const set = new Set<string>(Object.keys(COMMON_PACKAGES));
        for (const pkg of this.ws.getWorkspacePackagesWithMsg()) {
            set.add(pkg);
        }
        for (const pkg of this.sys.systemPackagesList()) {
            set.add(pkg);
        }
        return Array.from(set).sort();
    }

    /** 某包下的所有消息(工作区 + 系统) */
    getMessagesInPackage(pkg: string): RosInterfaceEntry[] {
        const result: RosInterfaceEntry[] = [...this.ws.getMessagesInPackage(pkg)];
        result.push(...this.sys.systemEntriesInPackage(pkg));
        return result;
    }

    /** 某包某消息的精确工作区条目(内层二分;跳转/悬停零扫描命中;系统包走标准布局路径) */
    findMessage(pkg: string, name: string): RosInterfaceEntry | undefined {
        return this.ws.findMessage(pkg, name);
    }

    /**
     * 某包某消息的精确条目,工作区未命中时**触发系统带路径懒登记**(RM-1,2026-09-25):
     * 触碰一个系统类型即登记整包 .msg 路径(单飞+落盘),命中返回 source=system 且带 path 的条目
     * ——跳转/悬浮不再依赖请求时的标准布局点查。工作区命中优先;未注入 resolvePackageDir /
     * 系统名单未就绪 / 包不在系统侧 → undefined(调用方走点查兜底)。
     */
    async findMessageWithSystemPath(pkg: string, name: string): Promise<RosInterfaceEntry | undefined> {
        const ws = this.ws.findMessage(pkg, name);
        if (ws?.path) {
            return ws;
        }
        if (!this.sys.isAvailable || !this.packages?.resolvePackageDir) {
            return undefined;
        }
        await this.sys.registerPackagePaths(pkg, async (p) => {
            const dir = await this.packages!.resolvePackageDir!(p);
            return dir?.fsPath;
        });
        return this.sys.systemEntryWithPath(pkg, name);
    }

    /** 限定名前缀查询(补全;工作区二分/扫段 + 系统前缀二分) */
    getEntriesByPrefix(prefix: string): RosInterfaceEntry[] {
        const result: RosInterfaceEntry[] = [...this.ws.getEntriesByPrefix(prefix)];
        result.push(...this.sys.systemEntriesByPrefix(prefix));
        return result;
    }

    /** 当前文件是否在合法包内,返回包名(补全「本包」判断用;委托) */
    getPackageForFile(filePath: string): string | undefined {
        return this.ws.getPackageForFile(filePath);
    }

    /** 裸名解析(v3 §5.3:反表点查 → 补登 → 本包内按名查找;委托) */
    async findBareNameDefinition(filePath: string, messageName: string): Promise<string | undefined> {
        return this.ws.findBareNameDefinition(filePath, messageName);
    }

    /** 工作区合法包名列表(有 .msg 消息的;补全第 3 项用) */
    getWorkspacePackagesWithMsg(): string[] {
        return this.ws.getWorkspacePackagesWithMsg();
    }

    /** 系统包名列表(补全第 5 项用) */
    getSystemPackages(): string[] {
        return this.sys.systemPackagesList();
    }

    /** 非法消息按消息名前缀就近匹配(补全第 6 项用;委托) */
    getLooseEntriesByPrefix(prefix: string): RosInterfaceEntry[] {
        return this.ws.getLooseEntriesByPrefix(prefix);
    }

    /** 释放资源 */
    dispose(): void {
        this.ws.dispose();
    }
}
