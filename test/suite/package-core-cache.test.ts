// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-core-cache.test.ts
 * package-core PackageCache【真实缓存】回归测试(2026-09-06):
 *
 * 背景(远端问题):新生成的纯 python 包无法进入检测——colcon 权威名单停留在"上次 colcon list"
 * (创建之前)的旧名单,walk 重建(60s 周期/watcher 失效/ingest 后重建)从不重跑 colcon、
 * 也不把 walk 新发现的合法包并回 unignore;commitFromSnapshot 用旧名单整体覆盖 ingest 增量,
 * 事件链看似断裂、60s 定期检查也修不好。
 *
 * 修复:doRebuild 重建前先刷新 colcon 权威(syncUnignore),保证 unignore 跟随文件系统。
 *
 * 纯 TS + 真实 fs(walk 走临时目录),无头 mocha:
 *   npm run test-compile && npx mocha out/test/suite/package-core-cache.test.js
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";
import type { PackageCache as PackageCacheType, WorkspacePackage } from "../../src/build-tool/package-core/data/package-cache";

// walk(walk-options)顶层依赖 vscode → 无头环境先装 stub 再 require 被测模块
installVscodeStub();
const req = createRequire(__filename);
const { PackageCache } = req("../../src/build-tool/package-core/data/package-cache") as typeof import("../../src/build-tool/package-core/data/package-cache");

/** 造一个 analyzer 认可的 ament_python 包目录(src/<name>/package.xml + setup.py) */
async function writePkg(ws: string, name: string): Promise<void> {
    const dir = path.join(ws, "src", name);
    await fs.promises.mkdir(dir, { recursive: true });
    const xml = `<?xml version="1.0"?>\n<package format="3">\n  <name>${name}</name>\n  <version>0.0.0</version>\n  <description>t</description>\n  <maintainer email="t@t">t</maintainer>\n  <license>Apache-2.0</license>\n  <export>\n    <build_type>ament_python</build_type>\n  </export>\n</package>\n`;
    await fs.promises.writeFile(path.join(dir, "package.xml"), xml, "utf8");
    await fs.promises.writeFile(path.join(dir, "setup.py"), "from setuptools import setup\n", "utf8");
}

describe("package-core PackageCache 真实缓存(2026-09-06 新包检测修复)", () => {
    let tmp: string;
    let ws: string;
    let cache: PackageCacheType;
    let colconRuns = 0;

    /** colcon list 执行器桩:实时读 fs 下 src/* 含 package.xml 的包(同目录 COLCON_IGNORE 跳过,模拟 colcon 行为) */
    function makeExecutor() {
        return async (): Promise<WorkspacePackage[]> => {
            colconRuns++;
            const out: WorkspacePackage[] = [];
            let names: string[] = [];
            try {
                names = (await fs.promises.readdir(path.join(ws, "src"), { withFileTypes: true }))
                    .filter((e) => e.isDirectory())
                    .map((e) => e.name);
            } catch {
                return out;
            }
            for (const n of names) {
                try {
                    await fs.promises.access(path.join(ws, "src", n, "package.xml"));
                } catch {
                    continue; // 无 package.xml → 不算包
                }
                try {
                    await fs.promises.access(path.join(ws, "src", n, "COLCON_IGNORE"));
                    continue; // colcon 跳过 COLCON_IGNORE 目录
                } catch {
                    // 未被忽略 → 收录
                }
                out.push({ name: n, path: path.join(ws, "src", n), buildType: "ament_python" });
            }
            return out;
        };
    }

    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkgcache-test-"));
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

    it("新生成包:colconReady 后 invalidate→rebuild 纳入 unignore(回归:原实现名单永陈旧)", async () => {
        await writePkg(ws, "aa");
        let snap = await cache.rebuild();
        assert.ok(snap.colconReady, "rebuild 前置 colcon 刷新 → colconReady=true");
        assert.deepStrictEqual(snap.unignore.map((w) => w.name), ["aa"], "初始 unignore=[aa]");

        // 模拟"create 新包"落盘(此时上次 colcon 名单仍是旧 aa)
        await writePkg(ws, "bb");
        cache.invalidate();
        snap = await cache.rebuild();
        const names = snap.unignore.map((w) => w.name);
        assert.ok(names.includes("bb"), `新生成包 bb 应进入 unignore(实测:${names.join(",")})`);
        assert.ok(snap.colconReady);
    });

    it("60s 定时路径(rebuild)与懒重建(ensureFresh)同样纠偏,且重建确实重跑 colcon", async () => {
        await writePkg(ws, "aa");
        await cache.rebuild();
        const runsAfterFirst = colconRuns;
        assert.ok(runsAfterFirst >= 1);

        await writePkg(ws, "cc");
        // 定时器路径:直接 rebuild(不 invalidate 也强制重建)→ 仍先刷新 colcon
        const s1 = await cache.rebuild();
        assert.ok(s1.unignore.map((w) => w.name).includes("cc"), "定时 rebuild 应纳入新包");
        assert.ok(colconRuns > runsAfterFirst, "rebuild 必须重跑 colcon(否则名单永陈旧)");

        // 懒重建路径:invalidate → ensureFresh
        await writePkg(ws, "dd");
        cache.invalidate();
        const s2 = await cache.ensureFresh();
        assert.ok(s2.unignore.map((w) => w.name).includes("dd"), "懒重建应纳入新包");
    });

    it("colcon 权威剪枝:目录删除后 rebuild 从 unignore 消失(名单跟随文件系统)", async () => {
        await writePkg(ws, "aa");
        await writePkg(ws, "ee");
        await cache.rebuild();
        assert.strictEqual(cache.getSnapshot()!.unignore.length, 2);
        await fs.promises.rm(path.join(ws, "src", "ee"), { recursive: true, force: true });
        await cache.rebuild();
        const names = cache.getSnapshot()!.unignore.map((w) => w.name);
        assert.deepStrictEqual(names, ["aa"], "删除的包应从 unignore 消失:" + names.join(","));
    });

    it("ignore 派生不受影响:COLCON_IGNORE 同目录包入 ignore 而非 unignore", async () => {
        await writePkg(ws, "aa");
        await writePkg(ws, "ign");
        await fs.promises.writeFile(path.join(ws, "src", "ign", "COLCON_IGNORE"), "");
        await cache.rebuild();
        const snap = cache.getSnapshot()!;
        assert.deepStrictEqual(snap.unignore.map((w) => w.name), ["aa"]);
        assert.deepStrictEqual(snap.ignore.map((w) => w.name), ["ign"], "同目录 COLCON_IGNORE → ignore");
    });
});
