// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-core-events.test.ts
 * 事件链路(2026-09-06 §12.3/12.4):
 *  - DataLayer 双通道路由:池事件 → 懒重建(refresh);标记事件 → cache.applyMarkerSync(不重建);
 *    timer-tick → full rebuild;事件带 dirs + 预过滤:全部无关 → 丢弃;无 dirs → 保守触发;
 *  - event/batcher:去抖窗口内 create/modify/delete(op 折叠)与同 dir 去重 → 单事件带 dirs。
 * 纯 TS,无头 mocha(vscode stub 先装再 require;batcher 零依赖可直接导入)。
 */

import * as assert from "assert";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";
import type { PackageCache, PackageSnapshot } from "../../src/build-tool/package-core/data/package-cache";
import type { PackageFetcher, DriverEvent } from "../../src/build-tool/package-core/event/contracts";
// batcher 纯 TS 零 vscode 依赖,可静态导入
import { createDebouncedDirBatcher } from "../../src/build-tool/package-core/event/batcher";

installVscodeStub();
const req = createRequire(__filename);
const { DataLayer } = req("../../src/build-tool/package-core/data") as typeof import("../../src/build-tool/package-core/data");

class Emitter<T> {
    private ls = new Set<(p: T) => void>();
    readonly on = (cb: (p: T) => void): (() => void) => {
        this.ls.add(cb);
        return () => this.ls.delete(cb);
    };
    fire(p: T): void {
        for (const l of [...this.ls]) {
            l(p);
        }
    }
}

function makeFetcher(): { fetcher: PackageFetcher; fire: (ev: DriverEvent) => void } {
    const em = new Emitter<DriverEvent>();
    return {
        fetcher: { onExternalChange: (cb) => em.on(cb), setRefreshIntervalMs: () => undefined, dispose: () => undefined },
        fire: (ev) => em.fire(ev),
    };
}

interface Counters {
    invalid: number; ensure: number; rebuild: number; sync: number;
}
function makeTrackedCache(): {
    cache: PackageCache;
    counters: Counters;
    markers: string[][];
} {
    const em = new Emitter<PackageSnapshot>();
    const counters: Counters = { invalid: 0, ensure: 0, rebuild: 0, sync: 0 };
    const markers: string[][] = [];
    const empty: PackageSnapshot = {
        unignore: [], ignore: [], entries: [], ignoreMarkers: [], whitelist: [], blacklist: [],
        timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
    };
    return {
        cache: {
            getSnapshot: () => empty,
            onContentChange: (cb) => em.on(cb),
            invalidate: () => { counters.invalid++; },
            ensureFresh: async () => { counters.ensure++; return empty; },
            rebuild: async () => { counters.rebuild++; return empty; },
            syncUnignore: async () => { counters.sync++; return []; },
            applyMarkerSync: async (dirs: string[]) => { markers.push(dirs); },
            getWorkspaceRoot: () => "/ws",
        } as unknown as PackageCache,
        counters,
        markers,
    };
}

const norm = (p: string): string => p.replace(/[\\/]+/g, "/");
const waitTick = () => new Promise<void>((r) => setImmediate(r));
const settle = async (): Promise<void> => { await waitTick(); await waitTick(); await waitTick(); };

describe("package-core DataLayer 事件双通道路由(2026-09-06 §12.4)", () => {
    /** 构造 DataLayer + 预过滤(给定无关目录)并等待构造内首载落定,随后归零计数 */
    async function makeData(irrelevantDirs: string[] = []) {
        const { fetcher, fire } = makeFetcher();
        const t = makeTrackedCache();
        const excluded = new Set(irrelevantDirs.map(norm));
        const data = new DataLayer(fetcher, t.cache, undefined, {
            isDirRelevant: (d) => !excluded.has(norm(d)),
        });
        await settle();
        t.counters.invalid = 0; t.counters.ensure = 0; t.counters.rebuild = 0; t.counters.sync = 0;
        return { data, fire, t, dispose: () => data.dispose() };
    }

    it("池事件(无 dirs)→ 懒重建(invalidate + ensureFresh),不 rebuild", async () => {
        const { fire, t, dispose } = await makeData();
        fire({ kind: "workspace-package-changed" });
        await settle();
        assert.strictEqual(t.counters.invalid, 1);
        assert.strictEqual(t.counters.ensure, 1);
        assert.strictEqual(t.counters.rebuild, 0);
        assert.strictEqual(t.markers.length, 0);
        dispose();
    });

    it("池事件 dirs 全无关(排除目录)→ 直接丢弃,零动作", async () => {
        const irrelevant = ["/ws/build/out", "/ws/install/x"];
        const { fire, t, dispose } = await makeData(irrelevant);
        fire({ kind: "workspace-package-changed", dirs: [norm("/ws/build/out")] });
        await settle();
        assert.strictEqual(t.counters.invalid, 0);
        assert.strictEqual(t.counters.ensure, 0);
        dispose();
    });

    it("池事件 dirs 有相关 → 触发懒重建", async () => {
        const { fire, t, dispose } = await makeData(["/ws/build"]);
        fire({ kind: "workspace-package-changed", dirs: ["/ws/build/a", "/ws/src/pkg"] });
        await settle();
        assert.strictEqual(t.counters.invalid, 1);
        assert.strictEqual(t.counters.ensure, 1);
        dispose();
    });

    it("标记事件(dir 相关)→ applyMarkerSync(带 dirs),不 invalidate/ensure/rebuild", async () => {
        const { fire, t, dispose } = await makeData();
        fire({ kind: "ignore-marker-changed", dirs: ["/ws/src/a"] });
        await settle();
        assert.deepStrictEqual(t.markers, [["/ws/src/a"]]);
        assert.strictEqual(t.counters.invalid, 0);
        assert.strictEqual(t.counters.ensure, 0);
        assert.strictEqual(t.counters.rebuild, 0);
        dispose();
    });

    it("标记事件 dirs 全无关 → 丢弃,零动作", async () => {
        const irrelevant = ["/ws/log/a"];
        const { fire, t, dispose } = await makeData(irrelevant);
        fire({ kind: "ignore-marker-changed", dirs: [norm("/ws/log/a")] });
        await settle();
        assert.strictEqual(t.markers.length, 0);
        assert.strictEqual(t.counters.invalid, 0);
        dispose();
    });

    it("标记事件无 dirs(旧形态)→ 保守走懒重建兜底", async () => {
        const { fire, t, dispose } = await makeData();
        fire({ kind: "ignore-marker-changed" });
        await settle();
        assert.strictEqual(t.counters.invalid, 1);
        assert.strictEqual(t.counters.ensure, 1);
        dispose();
    });

    it("timer-tick → full rebuild(不 ensureFresh)", async () => {
        const { fire, t, dispose } = await makeData();
        fire({ kind: "timer-tick" });
        await settle();
        assert.strictEqual(t.counters.rebuild, 1);
        assert.strictEqual(t.counters.invalid, 0);
        dispose();
    });
});

describe("event/batcher 去抖聚合(§12.3,op 折叠 + dir 去重)", () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    it("窗口内同 kind 多 op(create/modify/delete)折叠为一次且 dirs 去重", async () => {
        const events: Array<{ kind: string; dirs: string[] }> = [];
        const b = createDebouncedDirBatcher(20, (ev) => events.push(ev));
        // create/modify/delete 同一文件 → 同一 dir(路径一致),窗口内折叠
        b.schedule("workspace-package-changed", "/ws/src/a");
        b.schedule("workspace-package-changed", "/ws/src/a");
        b.schedule("workspace-package-changed", "/ws/src/a");
        b.schedule("workspace-package-changed", "/ws/src/b");
        await sleep(60);
        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(events[0].dirs.sort(), ["/ws/src/a", "/ws/src/b"]);
        b.dispose();
    });

    it("不同 kind 各自聚合为独立事件", async () => {
        const events: Array<{ kind: string; dirs: string[] }> = [];
        const b = createDebouncedDirBatcher(20, (ev) => events.push(ev));
        b.schedule("workspace-package-changed", "/ws/src/a");
        b.schedule("ignore-marker-changed", "/ws/src/a");
        await sleep(60);
        assert.strictEqual(events.length, 2);
        const kinds = events.map((e) => e.kind).sort();
        assert.deepStrictEqual(kinds, ["ignore-marker-changed", "workspace-package-changed"]);
        b.dispose();
    });

    it("跨窗口各发一次;dispose 丢弃未发事件", async () => {
        const events: Array<{ kind: string; dirs: string[] }> = [];
        const b = createDebouncedDirBatcher(20, (ev) => events.push(ev));
        b.schedule("workspace-package-changed", "/ws/src/a");
        await sleep(60);
        b.schedule("workspace-package-changed", "/ws/src/a");
        b.dispose(); // 未到窗口 → 第二组不发出
        await sleep(60);
        assert.strictEqual(events.length, 1);
    });
});
