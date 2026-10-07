/**
 * PackageMap 单元测试
 *
 * 策略:反射注入 private 状态(packages/systemPackageNames/systemPackageDirs),
 *      测两级查找 / resolveFileRef / resolveFindExpr / resolvePackageUri / 懒获取 onDirLoaded。
 *      不依赖真实 ros2(懒获取经构造器 pkgPrefix 注入假查询,2026-09-28 修复批:实现已直连
 *      ros2ServiceApi.pkg_prefix,旧反射注入的 systemPackagesMap 字段在类上不存在,是死缝隙)。
 */

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

import { PackageMap, PackageAtomEvent, SystemDirLoadedEvent } from "../../src/languages/shared/package-map";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function samePath(actual: string | undefined, expected: string): void {
    assert.strictEqual(path.normalize(actual ?? ""), path.normalize(expected));
}

function makeWorkspaceMap(entries: [string, string][]): Map<string, vscode.Uri> {
    const m = new Map<string, vscode.Uri>();
    for (const [k, v] of entries) {
        m.set(k, vscode.Uri.file(v));
    }
    return m;
}

/** 反射注入 private 状态,不跑 initialize(避免依赖 findFiles/ros2) */
function makePackageMap(opts: {
    workspace?: [string, string][];
    systemNames?: string[];
    systemDirs?: [string, string][];
    systemPackagesMap?: { [name: string]: () => Promise<string> };
}): PackageMap {
    const pm = new PackageMap((name) => {
        const entry = opts.systemPackagesMap?.[name];
        return entry ? entry() : Promise.resolve(null);
    });
    const anyPm = pm as any;
    if (opts.workspace) {
        anyPm.packages = makeWorkspaceMap(opts.workspace);
    }
    if (opts.systemNames) {
        anyPm.systemPackageNames = new Set(opts.systemNames);
    }
    if (opts.systemDirs) {
        anyPm.systemPackageDirs = makeWorkspaceMap(opts.systemDirs);
    }
    if (opts.systemPackagesMap) {
        anyPm.systemPackagesMap = opts.systemPackagesMap;
    }
    return pm;
}

/* ------------------------------------------------------------------ */
/* 测试                                                               */
/* ------------------------------------------------------------------ */

describe("PackageMap 单元测试", () => {
    describe("get 两级查找", () => {
        it("工作区优先(即使系统也有同名包)", () => {
            const pm = makePackageMap({
                workspace: [["my_pkg", "/ws/src/my_pkg"]],
                systemNames: ["my_pkg"]
            });
            samePath(pm.get("my_pkg")?.fsPath, "/ws/src/my_pkg");
        });

        it("系统列表命中 + 位置已缓存 → 返回系统位置", () => {
            const pm = makePackageMap({
                systemNames: ["std_msgs"],
                systemDirs: [["std_msgs", "/opt/ros/jazzy/share/std_msgs"]]
            });
            samePath(pm.get("std_msgs")?.fsPath, "/opt/ros/jazzy/share/std_msgs");
        });

        it("均未命中 → undefined", () => {
            const pm = makePackageMap({});
            assert.strictEqual(pm.get("ghost_pkg"), undefined);
        });
    });

    describe("resolveFileRef / resolveFindExpr / resolvePackageUri", () => {
        it("resolveFindExpr:$(find 工作区包)/rest", () => {
            const pm = makePackageMap({ workspace: [["my_pkg", "/ws/src/my_pkg"]] });
            samePath(pm.resolveFindExpr("$(find my_pkg)/xacro/foo.xacro")?.fsPath,
                path.join("/ws/src/my_pkg", "xacro", "foo.xacro"));
        });

        it("resolveFindExpr:未命中 → undefined", () => {
            const pm = makePackageMap({});
            assert.strictEqual(pm.resolveFindExpr("$(find ghost_pkg)/a.xacro"), undefined);
        });

        it("resolvePackageUri:package://pkg/rest", () => {
            const pm = makePackageMap({ workspace: [["my_pkg", "/ws/src/my_pkg"]] });
            samePath(pm.resolvePackageUri("package://my_pkg/meshes/base.stl")?.fsPath,
                path.join("/ws/src/my_pkg", "meshes", "base.stl"));
        });

        it("resolveFileRef:相对路径(基于 fromUri 目录)", () => {
            const pm = makePackageMap({});
            const from = vscode.Uri.file(path.join("/ws/src/my_pkg", "urdf", "robot.xacro"));
            const target = pm.resolveFileRef("../meshes/base.stl", from);
            assert.ok(target, "相对路径应解析出目标");
            // 跨平台:../ 从 from 目录向上 → 落在 my_pkg/meshes/base.stl(避免 Windows 无盘符/盘符补全差异)
            assert.ok(target.fsPath.endsWith(path.join("my_pkg", "meshes", "base.stl")),
                "应向上解析到 my_pkg/meshes/base.stl");
        });

        it("resolveFileRef:${} → undefined(静态不可解析)", () => {
            const pm = makePackageMap({});
            const from = vscode.Uri.file("/ws/a.xacro");
            assert.strictEqual(pm.resolveFileRef("${p}/x.xacro", from), undefined);
        });

        it("resolveFileRef:空 → undefined", () => {
            const pm = makePackageMap({});
            assert.strictEqual(pm.resolveFileRef("", vscode.Uri.file("/ws/a.xacro")), undefined);
        });
    });

    describe("系统包位置懒获取 + onDirLoaded(重型,注入 map)", () => {
        it("get 命中系统名未缓存 → 触发懒获取 → onDirLoaded → 再 get 返回位置", async () => {
            const pm = makePackageMap({
                systemNames: ["std_msgs"],
                systemPackagesMap: {
                    "std_msgs": async () => "/opt/ros/jazzy/share/std_msgs"
                }
            });
            // 首次 get:命中系统名但未缓存 → 本次 undefined,触发懒获取
            assert.strictEqual(pm.get("std_msgs"), undefined);
            // 等待 onDirLoaded 事件
            const loaded = new Promise<SystemDirLoadedEvent>(resolve => {
                pm.onDirLoaded(e => resolve(e));
            });
            const ev = await loaded;
            assert.strictEqual(ev.pkg, "std_msgs");
            samePath(ev.dir.fsPath, "/opt/ros/jazzy/share/std_msgs");
            // 再次 get:缓存命中
            samePath(pm.get("std_msgs")?.fsPath, "/opt/ros/jazzy/share/std_msgs");
        });

        it("位置获取失败(注入 map 无该包)→ onDirLoaded 不触发,get 保持 undefined", async () => {
            const pm = makePackageMap({
                systemNames: ["ghost_pkg"],
                systemPackagesMap: {} // map 里没有 ghost_pkg
            });
            assert.strictEqual(pm.get("ghost_pkg"), undefined);
            let fired = false;
            pm.onDirLoaded(() => { fired = true; });
            // 给异步懒获取一点时间(失败路径)
            await new Promise(r => setTimeout(r, 50));
            assert.strictEqual(fired, false, "失败不应触发 onDirLoaded");
            assert.strictEqual(pm.get("ghost_pkg"), undefined);
        });
    });

    describe("工作区包原子事件(2026-09-13 拆碎投递)", () => {
        /** 反射设置旧快照/新包表后,直接触发差量投递(不跑 initialize,避免依赖 core);
         *  路径统一走 Uri.fsPath 归一(与 currentEntries 同口径;Windows 上也正确) */
        function runDiff(prev: [string, string][], next: [string, string][]) {
            const pm = new PackageMap();
            const anyPm = pm as any;
            const events: PackageAtomEvent[] = [];
            pm.onPackageAtom((ev) => events.push(ev));
            anyPm.lastEntries = new Map(prev.map(([k, v]) => [k, vscode.Uri.file(v).fsPath]));
            anyPm.packages = makeWorkspaceMap(next);
            anyPm.emitWorkspaceDiff();
            return { events, anyPm };
        }

        it("纯新增 → add;pkgPath 带尾分隔符(与下游包表键同口径)", () => {
            const { events, anyPm } = runDiff([], [["pkg_a", "/ws/src/pkg_a"]]);
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].kind, "add");
            assert.strictEqual(events[0].pkgName, "pkg_a");
            assert.ok(events[0].pkgPath.endsWith(path.sep), "pkgPath 应带尾分隔符");
            assert.strictEqual(anyPm.lastEntries.get("pkg_a"), vscode.Uri.file("/ws/src/pkg_a").fsPath, "快照应滚动到新版本");
        });

        it("纯删除 → remove", () => {
            const { events } = runDiff([["pkg_a", "/ws/src/pkg_a"]], []);
            assert.deepStrictEqual(events.map((e) => `${e.kind}:${e.pkgName}`), ["remove:pkg_a"]);
        });

        it("包改名(name 变、dir 不变)→ 一对 remove + add(不得因 dir 相同而漏", () => {
            const { events } = runDiff([["A", "/ws/src/a"]], [["B", "/ws/src/a"]]);
            assert.deepStrictEqual(events.map((e) => `${e.kind}:${e.pkgName}`), ["remove:A", "add:B"],
                "差集键应为 (名, 路径) 有序对:先 remove 后 add");
        });

        it("目录改名(名同、dir 变)→ 一对 remove + add", () => {
            const { events } = runDiff([["A", "/ws/src/a"]], [["A", "/ws/src/a2"]]);
            assert.deepStrictEqual(events.map((e) => `${e.kind}`), ["remove", "add"]);
        });

        it("内容未变 → 不投递", () => {
            const { events } = runDiff([["A", "/ws/src/a"]], [["A", "/ws/src/a"]]);
            assert.strictEqual(events.length, 0);
        });
    });
});

describe("PackageMap 系统可执行名单 executablesOf(LJ-5,2026-10-01)", () => {

    /** 构造器第二注入缝:pkgExecutablesFull 假查询(计数) */
    function makeWithExec(fake: (name: string) => Promise<string[] | null>): PackageMap {
        return new PackageMap(undefined, fake);
    }

    it("查询成功:解析 basename 并缓存(第二次不发 CLI)", async () => {
        let calls = 0;
        const pm = makeWithExec(async (n) => {
            calls++;
            return [`/opt/ros/humble/lib/${n}/talker`, "/opt/ros/humble/lib/other/a.b.exe"];
        });
        const first = await pm.executablesOf("demo_pkg");
        assert.deepStrictEqual(first, [
            { name: "talker", path: `/opt/ros/humble/lib/demo_pkg/talker` },
            { name: "a.b.exe", path: "/opt/ros/humble/lib/other/a.b.exe" },
        ]);
        const second = await pm.executablesOf("demo_pkg");
        assert.strictEqual(calls, 1, "缓存命中不应再发 CLI");
        assert.strictEqual(first, second, "缓存应返回同一数组");
    });

    it("并发单飞:同包并发只发一次 CLI", async () => {
        let calls = 0;
        const pm = makeWithExec(async (n) => {
            calls++;
            return new Promise<string[]>((res) => setTimeout(() => res([`/p/lib/${n}/a`]), 10));
        });
        const [a, b] = await Promise.all([pm.executablesOf("p"), pm.executablesOf("p")]);
        assert.strictEqual(calls, 1, "并发应被单飞合并");
        assert.deepStrictEqual(a, b);
    });

    it("失败(null)→ undefined 不缓存,下次可重试", async () => {
        let fail = true;
        let calls = 0;
        const pm = makeWithExec(async (n) => {
            calls++;
            return fail ? null : [`/p/lib/${n}/a`];
        });
        assert.strictEqual(await pm.executablesOf("p"), undefined, "失败应 undefined");
        fail = false;
        const ok = await pm.executablesOf("p");
        assert.ok(ok && ok.length === 1, "失败后应可重试成功");
        assert.strictEqual(calls, 2, "失败不缓存 → 重试真实发生");
    });

    it("空名单:缓存并返回 [](与失败 undefined 区分)", async () => {
        let calls = 0;
        const pm = makeWithExec(async () => {
            calls++;
            return [];
        });
        assert.deepStrictEqual(await pm.executablesOf("p"), []);
        assert.deepStrictEqual(await pm.executablesOf("p"), []);
        assert.strictEqual(calls, 1, "空名单也是成功,应缓存");
    });

    it("acceptSystem 失效:env 回推后重新查询", async () => {
        let calls = 0;
        const pm = makeWithExec(async () => {
            calls++;
            return ["/p/lib/x/a"];
        });
        await pm.executablesOf("x");
        pm.acceptSystem([{ name: "x" }]);
        await pm.executablesOf("x");
        assert.strictEqual(calls, 2, "env 回推应清缓存");
    });
});
