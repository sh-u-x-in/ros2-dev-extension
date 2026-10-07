// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-core-v3.test.ts
 * PackageCache V3 真实缓存回归(2026-09-06 四项修复 §12 + §12.12):
 *  - P4:lazy 重建只 walk 不跑 colcon(colconRuns 不增),新包并集补入;60s(full)重跑 colcon 且删除收敛;
 *  - P2:祖先 COLCON_IGNORE → ignore 域(ancestor),不进 unignore/兜底;
 *  - P1:嵌套合法包 → ignore 域(overlap),外层照常在 unignore;
 *  - V3:full pair 认证白名单(onlylist)/黑名单(walk-only);lazy 快删(交集证据)/黑名单除名/白名单不动;
 *  - applyMarkerSync:同目录/祖先标记创建 → 即时 ignore;解除 → 回交集;全程不跑 colcon;
 *  - colcon 失败:名单保留 + lazy 增量,白/黑名单不动。
 * 纯 TS + 真实 fs,无头 mocha(先装 vscode stub 再 require)。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";
import type { PackageCache as PackageCacheType, WorkspacePackage } from "../../src/build-tool/package-core/data/package-cache";

installVscodeStub();
const req = createRequire(__filename);
const { PackageCache } = req("../../src/build-tool/package-core/data/package-cache") as typeof import("../../src/build-tool/package-core/data/package-cache");

/** 造一个 analyzer 认可的 ament_python 包目录(相对 ws 的 rel 路径 + package.xml + setup.py) */
async function writePkgRel(ws: string, rel: string): Promise<void> {
    const dir = path.join(ws, rel);
    await fs.promises.mkdir(dir, { recursive: true });
    const name = path.basename(dir);
    const xml = `<?xml version="1.0"?>\n<package format="3">\n  <name>${name}</name>\n  <version>0.0.0</version>\n  <description>t</description>\n  <maintainer email="t@t">t</maintainer>\n  <license>Apache-2.0</license>\n  <export>\n    <build_type>ament_python</build_type>\n  </export>\n</package>\n`;
    await fs.promises.writeFile(path.join(dir, "package.xml"), xml, "utf8");
    await fs.promises.writeFile(path.join(dir, "setup.py"), "from setuptools import setup\n", "utf8");
}

const names = (list: { name: string }[]): string[] => list.map((w) => w.name).sort();

describe("package-core PackageCache V3(2026-09-06 四项修复/§12.12)", () => {
    let tmp: string;
    let ws: string;
    let cache: PackageCacheType;
    let colconRuns: number;

    /** 默认 colcon 桩:src 下直接子目录中含 package.xml 且无 COLCON_IGNORE 的收录(≈ colcon 一层视图) */
    function makeExecutor(extra?: WorkspacePackage[]): () => Promise<WorkspacePackage[]> {
        return async (): Promise<WorkspacePackage[]> => {
            colconRuns++;
            const out: WorkspacePackage[] = [];
            let namesList: string[] = [];
            try {
                namesList = (await fs.promises.readdir(path.join(ws, "src"), { withFileTypes: true }))
                    .filter((e) => e.isDirectory())
                    .map((e) => e.name);
            } catch {
                return [...(extra ?? [])];
            }
            for (const n of namesList) {
                const d = path.join(ws, "src", n);
                try {
                    await fs.promises.access(path.join(d, "package.xml"));
                } catch {
                    continue;
                }
                try {
                    await fs.promises.access(path.join(d, "COLCON_IGNORE"));
                    continue;
                } catch {
                    // 收录
                }
                out.push({ name: n, path: d, buildType: "ament_python" });
            }
            for (const w of extra ?? []) {
                if (!out.some((x) => x.path === w.path)) {
                    out.push(w);
                }
            }
            return out;
        };
    }

    /** colcon 桩:仅返回给定名单(模拟"只列这些"的权威视图;walk 全量真实 fs) */
    function makeExecutorOnly(list: WorkspacePackage[]): () => Promise<WorkspacePackage[]> {
        return async (): Promise<WorkspacePackage[]> => {
            colconRuns++;
            return list.map((w) => ({ ...w }));
        };
    }

    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkgcore-v3-"));
        ws = path.join(tmp, "ws");
        await fs.promises.mkdir(path.join(ws, "src"), { recursive: true });
        colconRuns = 0;
        cache = new PackageCache(ws, { excludedFolders: [], configDebounceMs: 50 });
        cache.setColconListExecutor(makeExecutor());
    });

    afterEach(() => {
        cache.dispose();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("P4-lazy:只 walk 不跑 colcon,新包并集补入(§12.12 lazy 增量)", async () => {
        await writePkgRel(ws, "src/aa");
        await cache.rebuild(); // full
        assert.ok(colconRuns >= 1);
        const runs = colconRuns;

        await writePkgRel(ws, "src/bb");
        cache.invalidate();
        await cache.ensureFresh(); // lazy
        const s = cache.getSnapshot()!;
        assert.ok(names(s.unignore).includes("bb"), "lazy 应并集补入新包");
        assert.strictEqual(colconRuns, runs, "lazy 绝不跑 colcon");
    });

    it("P2-祖先忽略:src/vendor 标记 → demo 入 ignore(ancestor),不进 unignore", async () => {
        await writePkgRel(ws, "src/vendor/demo");
        await fs.promises.writeFile(path.join(ws, "src", "vendor", "COLCON_IGNORE"), "");
        await cache.rebuild(); // full:colcon 一层视图无 demo;walk 全量发现
        const s = cache.getSnapshot()!;
        assert.ok(names(s.ignore).includes("demo"), "祖先遮蔽 → ignore 域:" + names(s.ignore).join(","));
        assert.ok(!names(s.unignore).includes("demo"), "不进 unignore");
        const entry = s.entries.find((e) => path.basename(e.dir) === "demo");
        assert.strictEqual(entry?.ignoredBy, "ancestor");
    });

    it("P1-嵌套重叠:内层入 ignore(overlap),外层照常在 unignore", async () => {
        await writePkgRel(ws, "src/outer");
        await writePkgRel(ws, "src/outer/inner");
        await cache.rebuild();
        const s = cache.getSnapshot()!;
        assert.deepStrictEqual(names(s.unignore), ["outer"], "colcon 只列外层");
        assert.ok(names(s.ignore).includes("inner"), "内层重叠 → ignore 域:" + names(s.ignore).join(","));
        assert.strictEqual(s.entries.find((e) => path.basename(e.dir) === "inner")?.ignoredBy, "overlap");
    });

    it("V3-pair 认证:phantom(仅 list)→ 白名单常驻;bb(仅 walk)→ 黑名单抑制并集", async () => {
        const phantom = path.join(ws, "src", "phantom"); // 不存在于 fs:walk 不可见 → 仅 list
        await writePkgRel(ws, "src/aa");
        await writePkgRel(ws, "src/bb"); // 存在但 colcon 桩不列 → 仅 walk
        cache.setColconListExecutor(makeExecutorOnly([
            { name: "aa", path: path.join(ws, "src", "aa"), buildType: "ament_python" },
            { name: "phantom", path: phantom, buildType: "ament_python" },
        ]));
        await cache.rebuild(); // full:pair 认证
        let s = cache.getSnapshot()!;
        assert.ok(s.whitelist.includes(phantom), "仅 list 见 → 白名单");
        assert.ok(names(s.unignore).includes("phantom"), "白名单成员保留在 unignore");
        assert.ok(s.blacklist.some((d) => path.basename(d) === "bb"), "仅 walk 见 → 黑名单");
        assert.ok(!names(s.unignore).includes("bb"), "黑名单成员不进 unignore");

        // lazy:bb 仍 walk 可见 → 黑名单抑制并集补入;phantom 无 walk 证据 → 白名单不动
        cache.invalidate();
        s = await cache.ensureFresh();
        assert.ok(!names(s.unignore).includes("bb"), "lazy 不解除黑名单(仍 walk 可见)");
        assert.ok(names(s.unignore).includes("phantom"), "lazy 不裁决白名单成员");
        assert.ok(s.whitelist.includes(phantom));
    });

    it("V3-快删:交集证据成员删除 → lazy 即删(不跑 colcon)", async () => {
        await writePkgRel(ws, "src/aa");
        await writePkgRel(ws, "src/bb");
        await cache.rebuild();
        assert.strictEqual(names(cache.getSnapshot()!.unignore).length, 2);
        const runs = colconRuns;
        await fs.promises.rm(path.join(ws, "src", "bb"), { recursive: true, force: true });
        cache.invalidate();
        const s = await cache.ensureFresh(); // lazy
        assert.deepStrictEqual(names(s.unignore), ["aa"], "交集证据删除 → lazy 即删");
        assert.strictEqual(colconRuns, runs, "快删不跑 colcon");
    });

    it("V3-黑名单退出:list 看见 → 转交集;walk 不再见 → 除名出域", async () => {
        await writePkgRel(ws, "src/aa");
        await writePkgRel(ws, "src/bb");
        cache.setColconListExecutor(makeExecutorOnly([
            { name: "aa", path: path.join(ws, "src", "aa"), buildType: "ament_python" },
        ])); // 不含 bb → 黑名单
        await cache.rebuild();
        assert.deepStrictEqual(names(cache.getSnapshot()!.unignore), ["aa"]);

        // list 看见 bb → 黑名单移除并立即进 unignore(交集)
        cache.setColconListExecutor(makeExecutorOnly([
            { name: "aa", path: path.join(ws, "src", "aa"), buildType: "ament_python" },
            { name: "bb", path: path.join(ws, "src", "bb"), buildType: "ament_python" },
        ]));
        await cache.rebuild();
        let s = cache.getSnapshot()!;
        assert.deepStrictEqual(names(s.unignore), ["aa", "bb"], "list 看见 → 转交集");
        assert.strictEqual(s.blacklist.length, 0);

        // walk 不再见(删除)→ 出域(lazy 快删;交集证据)
        await fs.promises.rm(path.join(ws, "src", "bb"), { recursive: true, force: true });
        cache.invalidate();
        s = await cache.ensureFresh();
        assert.ok(!names(s.unignore).includes("bb"), "删除 → 出域");
    });

    it("applyMarkerSync-同目录:标记创建 → 即时 ignore;删除 → 回交集;全程不跑 colcon", async () => {
        // 纯 walk 世界(无 colcon 权威):避免"嵌套/遮蔽被黑名单"干扰成员迁移断言
        cache.setColconListExecutor(async () => { colconRuns++; throw new Error("no colcon"); });
        await writePkgRel(ws, "src/aa");
        await cache.rebuild();
        assert.deepStrictEqual(names(cache.getSnapshot()!.unignore), ["aa"], "无权威 → walk 并集");
        const runs = colconRuns;

        const aaDir = path.join(ws, "src", "aa");
        await fs.promises.writeFile(path.join(aaDir, "COLCON_IGNORE"), "");
        await cache.applyMarkerSync([aaDir]);
        let s = cache.getSnapshot()!;
        assert.deepStrictEqual(names(s.unignore), [], "标记创建 → 移出 unignore");
        assert.ok(names(s.ignore).includes("aa"), "同目录标记 → ignore");

        await fs.promises.unlink(path.join(aaDir, "COLCON_IGNORE"));
        await cache.applyMarkerSync([aaDir]);
        s = cache.getSnapshot()!;
        assert.deepStrictEqual(names(s.unignore), ["aa"], "解除忽略 → 回交集区(乐观)");
        assert.strictEqual(colconRuns, runs, "applyMarkerSync 不跑 colcon");
    });

    it("applyMarkerSync-祖先:子树成员迁移(ignore ⇄ unignore),不跑 colcon", async () => {
        cache.setColconListExecutor(async () => { colconRuns++; throw new Error("no colcon"); });
        await writePkgRel(ws, "src/vendor/demo");
        await cache.rebuild(); // 无权威 → walk 并集,demo 入 unignore
        assert.ok(names(cache.getSnapshot()!.unignore).includes("demo"));
        const runs = colconRuns;

        const vendorDir = path.join(ws, "src", "vendor");
        await fs.promises.writeFile(path.join(vendorDir, "COLCON_IGNORE"), "");
        await cache.applyMarkerSync([vendorDir]);
        let s = cache.getSnapshot()!;
        assert.ok(!names(s.unignore).includes("demo"), "祖先标记 → 移出 unignore");
        assert.ok(names(s.ignore).includes("demo"), "祖先遮蔽 → ignore(ancestor)");

        await fs.promises.unlink(path.join(vendorDir, "COLCON_IGNORE"));
        await cache.applyMarkerSync([vendorDir]);
        s = cache.getSnapshot()!;
        assert.ok(names(s.unignore).includes("demo"), "解除祖先遮蔽 → 回交集");
        assert.strictEqual(colconRuns, runs, "applyMarkerSync 不跑 colcon");
    });

    it("colcon 失败:保留旧名单 + lazy 增量,白/黑名单不动,不误删", async () => {
        await writePkgRel(ws, "src/aa");
        await cache.rebuild();
        assert.ok(cache.getSnapshot()!.colconReady);
        const runs = colconRuns;

        // colcon 桩开始抛错 → full 降级为增量(不认证),名单保留
        cache.setColconListExecutor(async () => { colconRuns++; throw new Error("colcon boom"); });
        await writePkgRel(ws, "src/bb");
        cache.invalidate();
        await cache.ensureFresh(); // lazy 路径(只 walk)
        let s = cache.getSnapshot()!;
        assert.deepStrictEqual(names(s.unignore), ["aa", "bb"], "失败路径仍并集补入,不误删");
        assert.ok(s.colconReady, "colconReady 保留旧真值");

        // full 失败:名单保留(不认证)
        cache.invalidate();
        await cache.rebuild();
        s = cache.getSnapshot()!;
        assert.deepStrictEqual(names(s.unignore).sort(), ["aa", "bb"], "full 失败 → 名单保留");
        assert.ok(colconRuns > runs);
    });
});
