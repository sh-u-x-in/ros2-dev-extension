// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-core-datalayer.test.ts
 * 数据层(DataLayer)域层改造无头测试(2026-09-02 设计:package-core出口简化与buildType事件化)。
 *
 * 覆盖(设计 D2/D4):
 *  1. colconReady=false → unignored 域 = walk 兜底(合法非忽略包,带类型);
 *  2. colconReady=true(colcon 注入)→ unignored 域 = colcon 权威名单;名单差异触发域事件;
 *  3. 名单相同 → 签名相同 → 不打扰(无事件);
 *  4. colcon 权威条目类型未齐(undefined)→ 该域不发布(类型就绪才发,D4);
 *  5. 域签名含 buildType:类型翻转触发域事件(D1);
 *  6. timer-tick 只重建工作区,不刷系统(2026-09-04 系统/定时解耦);
 *  7. refreshSystem():env 变化驱动的独立系统刷新,只刷 system/all 域。
 * 纯 TS(fake fetcher + fake cache),可 mocha 无头运行:
 *   npm run test-compile && npx mocha out/test/suite/package-core-datalayer.test.js
 */

import * as assert from "assert";
import { DataLayer } from "../../src/build-tool/package-core/data";
import type { PackageCache, PackageSnapshot } from "../../src/build-tool/package-core/data/package-cache";
import type { PackageFetcher, DriverEvent } from "../../src/build-tool/package-core/event/contracts";
import type { PackageChangeEvent, PackageDataState } from "../../src/build-tool/package-core/data/state";

/** 极简发射器(fake 用) */
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

/** fake fetcher:可手动触发驱动事件 */
function makeFetcher(): { fetcher: PackageFetcher; fire: (ev: DriverEvent) => void } {
    const em = new Emitter<DriverEvent>();
    return {
        fetcher: {
            onExternalChange: (cb) => em.on(cb),
            setRefreshIntervalMs: () => undefined,
            dispose: () => undefined,
        },
        fire: (ev) => em.fire(ev),
    };
}

/** fake cache:手动控制快照,模拟 colconReady 翻转 / 类型未齐 / 标记对账等场景 */
type SnapLike = Omit<PackageSnapshot, "ignoreMarkers" | "whitelist" | "blacklist">;
function makeCache(): {
    cache: PackageCache;
    setSnapshot: (s: SnapLike) => void;
    fireContentChange: () => void;
    snap: () => PackageSnapshot | undefined;
} {
    let snap: PackageSnapshot | undefined;
    const em = new Emitter<PackageSnapshot>();
    const wrap = (s: SnapLike): PackageSnapshot => ({ ignoreMarkers: [], whitelist: [], blacklist: [], ...s });
    const emptySnap = (): PackageSnapshot => wrap({
        unignore: [], ignore: [], entries: [], timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
    });
    return {
        cache: {
            getSnapshot: () => snap,
            onContentChange: (cb) => em.on(cb),
            invalidate: () => undefined,
            ensureFresh: async () => snap ?? emptySnap(),
            rebuild: async () => snap ?? emptySnap(),
            syncUnignore: async () => (snap ? snap.unignore : []),
            getWorkspaceRoot: () => "/ws",
        } as unknown as PackageCache,
        setSnapshot: (s) => { snap = wrap(s); },
        fireContentChange: () => { if (snap) { em.fire(snap); } },
        snap: () => snap,
    };
}

/** 造一个合法 walk 画像条目(hasColconIgnore → ignoredBy same-dir,与 ignore-classify 派生口径一致) */
const entry = (
    dir: string, name: string, buildType: string,
    hasColconIgnore = false, isValid = true,
    ignoredBy?: "same-dir" | "ancestor" | "overlap",
) => ({
    dir, name, buildType, hasColconIgnore, ignoredBy: ignoredBy ?? (hasColconIgnore ? "same-dir" : undefined),
    parentIsSrc: true, isValid,
});

const waitTick = () => new Promise<void>((r) => setImmediate(r));

describe("package-core DataLayer 域层(设计 D2/D4)", () => {
    it("colconReady=false → unignored 域 = walk 兜底(合法非忽略包,带类型)", async () => {
        const { fetcher } = makeFetcher();
        const c = makeCache();
        c.setSnapshot({
            unignore: [], // colcon 未注入
            ignore: [{ name: "pi", path: "/ign", buildType: "ament_python" }], // 被忽略包(真实由 cache walk 派生)
            entries: [
                entry("/a", "pa", "ament_python"),
                entry("/b", "pb", "ament_cmake"),
                entry("/ign", "pi", "ament_python", true), // 被忽略 → 不入兜底
                entry("/bad", "px", "ament_python", false, false), // 不合法 → 不入兜底
            ],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        const data = new DataLayer(fetcher, c.cache);
        await data.forceRefresh();
        const st = data.getState();
        assert.deepStrictEqual(
            (st.unignored ?? []).map((e) => e.name).sort(),
            ["pa", "pb"], // 兜底:合法非忽略
        );
        assert.strictEqual((st.unignored ?? [])[0].buildType, "ament_python"); // 兜底条目带类型
        assert.strictEqual(st.ignored?.length, 1); // ignore 域透传快照 ignore
    });

    it("colcon 注入(colconReady=true):名单差异 → unignored 域切换并触发域事件", async () => {
        const { fetcher } = makeFetcher();
        const c = makeCache();
        c.setSnapshot({
            unignore: [], ignore: [], entries: [entry("/a", "pa", "ament_python"), entry("/b", "pb", "ament_cmake")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        const data = new DataLayer(fetcher, c.cache);
        await data.forceRefresh();
        assert.strictEqual((data.getState().unignored ?? []).length, 2); // 兜底 2 个

        // colcon 权威:祖先忽略后只剩 pa
        const events: PackageChangeEvent[] = [];
        const unsub = data.onDidChange((ev) => events.push(ev));
        c.setSnapshot({
            unignore: [{ name: "pa", path: "/a", buildType: "ament_python" }],
            ignore: [{ name: "pi", path: "/ign", buildType: "ament_python" }],
            entries: [entry("/a", "pa", "ament_python")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: true,
        });
        c.fireContentChange(); // 模拟 cache.onContentChange(colcon 注入完成)
        await waitTick();
        const st = data.getState();
        assert.deepStrictEqual((st.unignored ?? []).map((e) => e.name), ["pa"]); // 切到 colcon 权威
        assert.ok(events.some((ev) => ev.unignored !== undefined), "名单变化应触发 unignored 域事件");
        unsub();
    });

    it("colcon 注入名单与兜底相同 → 域签名相同 → 不打扰(无事件)", async () => {
        const { fetcher } = makeFetcher();
        const c = makeCache();
        c.setSnapshot({
            unignore: [], ignore: [], entries: [entry("/a", "pa", "ament_python")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        const data = new DataLayer(fetcher, c.cache);
        await data.forceRefresh();
        const events: PackageChangeEvent[] = [];
        const unsub = data.onDidChange((ev) => events.push(ev));
        // colcon 结果 = 兜底同一包(同 name@dir@buildType)
        c.setSnapshot({
            unignore: [{ name: "pa", path: "/a", buildType: "ament_python" }],
            ignore: [],
            entries: [entry("/a", "pa", "ament_python")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: true,
        });
        c.fireContentChange();
        await waitTick();
        assert.deepStrictEqual((data.getState().unignored ?? []).map((e) => e.name), ["pa"]);
        assert.strictEqual(events.length, 0, "内容未变(source 切换但名单同)不应打扰下游");
        unsub();
    });

    it("colcon 权威条目类型未齐(undefined)→ 该域不发布(D4:类型就绪才发)", async () => {
        const { fetcher } = makeFetcher();
        const c = makeCache();
        // 初始:walk 未跑(entries 空)→ 兜底为空 → unignored 域 = []
        c.setSnapshot({
            unignore: [], ignore: [], entries: [],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        const data = new DataLayer(fetcher, c.cache);
        await data.forceRefresh();
        assert.deepStrictEqual(data.getState().unignored, []);
        const events: PackageChangeEvent[] = [];
        const unsub = data.onDidChange((ev) => events.push(ev));
        // colcon 注入但类型未合并(模拟旧执行器无类型,walk 未跑)→ undefined 不发布,域保持旧值 []
        c.setSnapshot({
            unignore: [{ name: "pa", path: "/a" }], // buildType undefined
            ignore: [],
            entries: [],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: true,
        });
        c.fireContentChange();
        await waitTick();
        assert.deepStrictEqual(data.getState().unignored, []);
        assert.strictEqual(events.some((ev) => ev.unignored !== undefined), false);
        // 类型补齐(walk 合并)→ 域就绪才发布(一次完整事件)
        c.setSnapshot({
            unignore: [{ name: "pa", path: "/a", buildType: "ament_python" }],
            ignore: [],
            entries: [entry("/a", "pa", "ament_python")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: true,
        });
        c.fireContentChange();
        await waitTick();
        assert.deepStrictEqual(data.getState().unignored, [{ name: "pa", dir: "/a", buildType: "ament_python" }]);
        assert.ok(events.some((ev) => ev.unignored !== undefined), "类型就绪应补发 unignored 域事件");
        unsub();
    });

    it("buildType 翻转(域签名含类型,D1)→ 触发 unignored 域事件", async () => {
        const { fetcher } = makeFetcher();
        const c = makeCache();
        c.setSnapshot({
            unignore: [], ignore: [], entries: [entry("/a", "pa", "ament_python")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        const data = new DataLayer(fetcher, c.cache);
        await data.forceRefresh();
        const events: PackageChangeEvent[] = [];
        const unsub = data.onDidChange((ev) => events.push(ev));
        c.setSnapshot({
            unignore: [], ignore: [], entries: [entry("/a", "pa", "ament_cmake")], // 类型翻转
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        c.fireContentChange();
        await waitTick();
        assert.strictEqual((data.getState().unignored ?? [])[0].buildType, "ament_cmake");
        assert.ok(events.some((ev) => ev.unignored !== undefined), "buildType 翻转应触发域事件(旧签名 name@dir 感知不到)");
        unsub();
    });

    it("timer-tick 只重建工作区,不刷新系统(系统刷新与 60s 定时解耦,2026-09-04)", async () => {
        const { fetcher, fire } = makeFetcher();
        const c = makeCache();
        c.setSnapshot({
            unignore: [], ignore: [],
            entries: [entry("/a", "pa", "ament_python")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        let systemCalls = 0;
        const systemProvider = async (): Promise<string[] | null> => { systemCalls++; return ["sysA"]; };
        const data = new DataLayer(fetcher, c.cache, systemProvider);
        await data.forceRefresh(); // 等构造内首载 settle
        systemCalls = 0; // 归零:只统计 timer-tick 之后是否调用系统提供者
        assert.strictEqual(data.getState().system, null, "冷启动 system 域 = 未知,不由工作区刷新填充");

        fire({ kind: "timer-tick" });
        await waitTick();
        await waitTick();
        await waitTick(); // rebuild 异步落定
        assert.strictEqual(systemCalls, 0, "60s 定时器不应调用系统包提供者(pkg list)");
        assert.strictEqual(data.getState().system, null, "timer-tick 不应填充 system 域");
        assert.deepStrictEqual(
            (data.getState().unignored ?? []).map((e) => e.name).sort(),
            ["pa"], // 工作区照常(rebuild 路径)
        );
    });

    it("refreshSystem():独立系统刷新(env 变化驱动)——只刷 system/all 域,不发工作区事件", async () => {
        const { fetcher } = makeFetcher();
        const c = makeCache();
        c.setSnapshot({
            unignore: [], ignore: [],
            entries: [entry("/a", "pa", "ament_python")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        let systemCalls = 0;
        const systemProvider = async (): Promise<string[] | null> => { systemCalls++; return ["sysA", "sysB"]; };
        const data = new DataLayer(fetcher, c.cache, systemProvider);
        await data.forceRefresh();
        assert.strictEqual(systemCalls, 0, "首载/工作区刷新不调用系统提供者");
        const events: PackageChangeEvent[] = [];
        const unsub = data.onDidChange((ev) => events.push(ev));

        await data.refreshSystem();
        assert.strictEqual(systemCalls, 1, "refreshSystem 应调用一次系统提供者");
        const sys = data.getState().system ?? [];
        assert.deepStrictEqual(sys.map((e) => e.name).sort(), ["sysA", "sysB"]);
        assert.strictEqual(sys[0].buildType, "", "系统包 buildType 恒为空串(类型统一)");
        assert.strictEqual(sys[0].dir, "", "系统包 dir 懒取为空");
        assert.deepStrictEqual((data.getState().unignored ?? []).map((e) => e.name), ["pa"], "工作区域不受影响");
        assert.strictEqual(events.some((ev) => ev.workspace !== undefined), false, "系统刷新不应触碰工作区域/发 workspace 事件");
        assert.ok(events.some((ev) => ev.system !== undefined), "system 域变化应发事件");
        assert.ok(events.some((ev) => ev.all !== undefined), "all(派生)应随 system 变化发事件");
        unsub();
    });

    it("refreshSystem():列表相同 → system 事件仍必发(环境回推,手稿 §10 对齐)", async () => {
        const { fetcher } = makeFetcher();
        const c = makeCache();
        c.setSnapshot({
            unignore: [], ignore: [],
            entries: [entry("/a", "pa", "ament_python")],
            timedOut: false, elapsedMs: 0, generatedAt: 0, contentFingerprint: "", colconReady: false,
        });
        const systemProvider = async (): Promise<string[] | null> => ["sysA", "sysB"];
        const data = new DataLayer(fetcher, c.cache, systemProvider);
        await data.forceRefresh();

        const events: PackageChangeEvent[] = [];
        const unsub = data.onDidChange((ev) => events.push(ev));

        await data.refreshSystem(); // ① null → 值:常规变化事件
        assert.ok(events.some((ev) => ev.system !== undefined), "首次刷新应发 system");

        events.length = 0;
        await data.refreshSystem(); // ② 列表未变:env 驱动 = 必发(回推)
        const pushed = events.find((ev) => ev.system !== undefined);
        assert.ok(pushed, "列表未变时 env 驱动刷新仍应发 system 事件(回推)");
        assert.deepStrictEqual(
            (pushed?.system ?? []).map((e) => e.name).sort(),
            (pushed?.oldSystem ?? []).map((e) => e.name).sort(),
            "回推时新值 = 旧值(差值 0,由消费方自算)",
        );
        assert.ok(!events.some((ev) => ev.all !== undefined), "派生 all 无真实变化 → 不打扰");

        events.length = 0;
        await data.forceRefresh(); // ③ 非 env 路径:不强制 system(防回归)
        assert.ok(!events.some((ev) => ev.system !== undefined), "工作区路径(forceRefresh)不强制 system");
        unsub();
    });
});
