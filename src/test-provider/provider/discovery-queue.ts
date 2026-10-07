// Licensed under the MIT License.

/**
 * @file discovery-queue.ts
 * 发现请求的**合并窗 + 单写者队列**(B10,2026-09-24;方向见实施计划 §0.3)。
 *
 * 为什么需要它(现状两个毛病):
 *   ① `discoverTests` 过去用 `isDiscovering` 布尔做守卫 —— 发现进行中来的请求**直接丢弃**;
 *      全量 walk 预算上限 30s,期间的"保存文件 / 建包 / 点刷新"全丢,此后若无新事件,树停在旧状态。
 *   ② 任何变化都触发**全量**(两次全工作区 walk + 全树 replace),代价与变化大小无关。
 * 本模块提供两样东西(照 rosmsg `workspace-index.ts:171-176` 与 install-truth
 * `build-map-center.ts` 的既有范式,不另造机制):
 *   · **合并窗**:同一 scope 去重、窗口滑动(默认 200ms),合并编辑器保存风暴;
 *   · **单写者链**:所有落地任务在一条 promise 链上**串行**,失败不断链 ⇒ 全量与增量不会交错。
 * 纯逻辑 + 可注入定时器 ⇒ 可无头单测。(2026-09-30 注:原参照 install-truth/center/trigger.ts,该文件已随构建事件化退役;TimerLike 结构保持不变。)
 */

/** 定时器注入(单测假时钟用;与 install-truth 的 `TimerLike` 同构) */
export interface TimerLike {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

/** 默认定时器(真实环境) */
export const defaultTimer: TimerLike = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * 一次发现请求的作用域(粒度由大到小):
 *  - `full`    :整工作区全量(初始发现 / 手动刷新 / 兜底;`force` = 手动触发 ⇒ 超时也强制落地);
 *  - `packages`:包域**差量**(package-core 的 workspace 域变化;只增/删/改受影响的包);
 *  - `package` :单个包的**状态**刷新(note/runnable;B9 的 build 目录 watcher 将接到这里);
 *  - `file`    :单个测试文件的挂/摘(`upsert` = 新建或内容变化,由落地方按"在不在树里"自行判定)。
 */
export type DiscoverScope =
    | { kind: "full"; force?: boolean }
    | { kind: "packages" }
    | { kind: "package"; name: string }
    | { kind: "file"; path: string; op: "upsert" | "delete" };

/** 去重键:同键的相邻请求合并(后到者胜,见 `mergeScope`) */
export function scopeKey(scope: DiscoverScope): string {
    switch (scope.kind) {
        case "full":
            return "full";
        case "packages":
            return "packages";
        case "package":
            return `package:${scope.name}`;
        case "file":
            return `file:${scope.path}`;
    }
}

/**
 * 同一 scope 的两次请求合并:`full` 的 `force` 取并(手动优先);
 * 其余"后到者胜"——它反映最新事实(save→delete 应落 delete,delete→create 应落 upsert)。
 */
export function mergeScope(prev: DiscoverScope, next: DiscoverScope): DiscoverScope {
    if (prev.kind === "full" && next.kind === "full") {
        return { kind: "full", force: prev.force === true || next.force === true };
    }
    return next;
}

/** 一次 flush 的落地顺序(与去重无关):`full` 覆盖其余;**先包后文件** */
export function planFlush(scopes: readonly DiscoverScope[]): DiscoverScope[] {
    const full = scopes.find((s) => s.kind === "full");
    if (full !== undefined) {
        return [full]; // 全量已覆盖其余一切 scope(且保留 force 语义)
    }
    const order: Record<DiscoverScope["kind"], number> = { full: 0, packages: 1, package: 2, file: 3 };
    return [...scopes].sort((a, b) => order[a.kind] - order[b.kind]);
}

export interface DiscoveryQueueOptions {
    /** 串行落地(provider 提供);抛错被吞掉,不断链 */
    onFlush: (scopes: DiscoverScope[]) => Promise<void>;
    timer?: TimerLike;
    /** 合并窗(毫秒),默认 200 */
    coalesceMs?: number;
}

export interface DiscoveryQueue {
    /** 登记一个作用域(去重 + 窗口滑动);到点后经单写者链落地 */
    schedule(scope: DiscoverScope): void;
    /** 立即落地(手动刷新用);返回的 Promise 在本次落地完成后 resolve */
    flushNow(): Promise<void>;
    /** 待落地的作用域个数(诊断用) */
    pendingCount(): number;
    dispose(): void;
}

export function createDiscoveryQueue(opts: DiscoveryQueueOptions): DiscoveryQueue {
    const timer = opts.timer ?? defaultTimer;
    const coalesceMs = opts.coalesceMs ?? 200;
    const pending = new Map<string, DiscoverScope>();
    let handle: unknown;
    let chain: Promise<void> = Promise.resolve();
    let disposed = false;

    /** 单写者链:全量/增量同链串行;失败不断链(照 rosmsg workspace-index.ts:171-176) */
    const enqueue = (task: () => Promise<void>): Promise<void> => {
        const run = chain.then(task);
        chain = run.catch(() => undefined);
        return run;
    };

    const flush = (): Promise<void> => {
        if (handle !== undefined) {
            timer.clear(handle);
            handle = undefined;
        }
        if (pending.size === 0) {
            return chain; // 无待办:等已排队的任务收尾即可
        }
        const scopes = planFlush([...pending.values()]);
        pending.clear();
        return enqueue(() => opts.onFlush(scopes));
    };

    return {
        schedule(scope: DiscoverScope): void {
            if (disposed) {
                return;
            }
            const key = scopeKey(scope);
            const prev = pending.get(key);
            pending.set(key, prev === undefined ? scope : mergeScope(prev, scope));
            if (handle !== undefined) {
                timer.clear(handle); // 滑动窗:随每次 schedule 重新计时(trailing)
            }
            handle = timer.set(() => {
                handle = undefined;
                void flush();
            }, coalesceMs);
        },
        flushNow: flush,
        pendingCount: () => pending.size,
        dispose(): void {
            disposed = true;
            if (handle !== undefined) {
                timer.clear(handle);
                handle = undefined;
            }
            pending.clear();
        }
    };
}
