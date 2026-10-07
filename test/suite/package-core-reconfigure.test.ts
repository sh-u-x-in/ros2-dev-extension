// Licensed under the MIT License.

/**
 * @file package-core-reconfigure.test.ts
 * 生效时机一致化(2026-09-28 设置体系批次 4):
 *  - DriverTimer.setIntervalMs:运行中重设周期 / 同值空操作 / 0 停用后再启动 / dispose 终止;
 *  - PackageCache.updateConfig:键比对(同键 key 不变 ⇒ 不标脏;异键 key 变化)+ 去抖到期标脏
 *    (dirty → ensureFresh 走 lazy 重建,不跑 colcon;未脏走快路径,快照同 generatedAt);
 *  - createPackageCore.reconfigure:重下发排除集进缓存键(组合根 5s 去抖监听的落地语义)。
 * 纯 TS + 真实 fs(tmp 工作区),无头 mocha(vscode stub 先装再 require;timer 零依赖可静态导入)。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";
import { createTimer } from "../../src/build-tool/package-core/event/timer";

installVscodeStub();
const req = createRequire(__filename);
const { PackageCache } = req("../../src/build-tool/package-core/data/package-cache") as typeof import("../../src/build-tool/package-core/data/package-cache");
const { createPackageCore } = req("../../src/build-tool/package-core/compose") as typeof import("../../src/build-tool/package-core/compose");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("DriverTimer.setIntervalMs(2026-09-28 reconfigure 接线)", function () {
    this.timeout(10000);

    it("运行中重设周期:加速后到点更密;0 停用后不再到点;再设正值恢复", async () => {
        const timer = createTimer(1000);
        let ticks = 0;
        const off = timer.onTick(() => ticks++);
        try {
            await sleep(120);
            const slowTicks = ticks;
            assert.ok(slowTicks <= 1, `1000ms 周期 120ms 内至多 1 次到点,实际 ${slowTicks}`);

            timer.setIntervalMs(15);
            await sleep(130);
            const fastTicks = ticks - slowTicks;
            assert.ok(fastTicks >= 4, `15ms 周期 130ms 内应 ≥4 次到点,实际 ${fastTicks}`);

            timer.setIntervalMs(0);
            await sleep(80);
            assert.strictEqual(ticks - slowTicks - fastTicks, 0, "停用(0)后不得再到点");

            timer.setIntervalMs(15);
            await sleep(70);
            assert.ok(ticks - slowTicks - fastTicks >= 1, "重新启动后应恢复到点");
        } finally {
            off();
            timer.dispose();
        }
    });

    it("同值重设 = 空操作(不打断当前节奏);dispose 后彻底停止", async () => {
        const timer = createTimer(15);
        let ticks = 0;
        timer.onTick(() => ticks++);
        try {
            await sleep(60);
            assert.ok(ticks >= 1, "启动后应到点");
            timer.setIntervalMs(15);
            await sleep(45);
            const before = ticks;
            assert.ok(before >= 2, "同值重设不得打断到点节奏");
            timer.dispose();
            await sleep(50);
            const after = ticks;
            await sleep(50);
            assert.strictEqual(ticks, after, "dispose 后不得再到点");
        } finally {
            timer.dispose();
        }
    });
});

describe("PackageCache.updateConfig(键比对 + 去抖标脏)", function () {
    this.timeout(10000);

    it("同键重设 key 不变;异键 key 变化(键比对是标脏的唯一前提)", () => {
        const cache = new PackageCache(path.join(os.tmpdir(), "pcfg-keyprobe"));
        cache.updateConfig({ excludedFolders: ["a"], followSymlinks: false });
        const k1 = cache.key;
        cache.updateConfig({ excludedFolders: ["a"], followSymlinks: false });
        assert.strictEqual(cache.key, k1, "同键 → key 不变(不触发标脏)");
        cache.updateConfig({ excludedFolders: ["a", "b"], followSymlinks: false });
        assert.notStrictEqual(cache.key, k1, "异键(排除集)→ key 变化");
        cache.updateConfig({ excludedFolders: ["a", "b"], followSymlinks: true });
        assert.strictEqual(cache.key.endsWith("follow=true"), true, "符号链接位进 key");
    });

    it("异键 → 去抖到期标脏;ensureFresh 走 lazy(不跑 colcon);未脏走快路径(同 generatedAt)", async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pcfg-dirty-"));
        try {
            const cache = new PackageCache(ws);
            cache.updateConfig({ configDebounceMs: 5 });
            let colconRuns = 0;
            cache.setColconListExecutor(async () => {
                colconRuns++;
                return [];
            });
            await cache.ensureFresh();          // 冷启动 → full(colcon + walk)
            const fullRuns = colconRuns;
            assert.ok(fullRuns >= 1, "冷启动应跑一次 colcon");

            cache.updateConfig({ excludedFolders: ["zz"], configDebounceMs: 5 });  // 异键 → 去抖后标脏
            await sleep(40);
            await cache.ensureFresh();          // dirty → lazy 重建(只 walk)
            assert.strictEqual(colconRuns, fullRuns, "配置标脏后的重建是 lazy,不得跑 colcon");

            const s1 = await cache.ensureFresh();  // 未脏 → 快路径
            const s2 = await cache.ensureFresh();
            assert.strictEqual(s1.generatedAt, s2.generatedAt, "未脏走快路径,快照不重建");
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });
});

describe("createPackageCore.reconfigure(组合根重下发)", function () {
    this.timeout(20000);

    /** 造一个 ament_python 包目录(package.xml + setup.py) */
    function writePkg(ws: string, rel: string): void {
        const dir = path.join(ws, rel);
        fs.mkdirSync(dir, { recursive: true });
        const name = path.basename(dir);
        fs.writeFileSync(
            path.join(dir, "package.xml"),
            `<?xml version="1.0"?>\n<package format="3">\n  <name>${name}</name>\n  <version>0.0.0</version>\n  <description>t</description>\n  <maintainer email="t@t">t</maintainer>\n  <license>Apache-2.0</license>\n  <export>\n    <build_type>ament_python</build_type>\n  </export>\n</package>\n`,
            "utf8",
        );
        fs.writeFileSync(path.join(dir, "setup.py"), "from setuptools import setup\n", "utf8");
    }

    it("排除集重下发 → 下次 forceRefresh 按新排除集扫描(行为级)", async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), "preconf-"));
        try {
            writePkg(ws, "src/demo");
            // 排除相对路径基于工作区根(与用户设置口径一致):排除 "vendor" = <根>/vendor 子树
            writePkg(ws, "vendor/hidden");
            const core = createPackageCore({
                workspaceRoot: ws,
                refreshIntervalMs: 0,
                enableWatcher: false,
                systemPackages: async () => [],
                config: {
                    packageCacheRefreshMs: 0,
                    buildExcludeFolders: ["vendor"],
                    followSymlinks: false,
                    walkTimeouts: { totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8 },
                },
            });
            try {
                await core.forceRefresh();
                let names = core.getState().workspace.map((w) => w.name).sort();
                assert.deepStrictEqual(names, ["demo"], "初始排除集:vendor 下的包不可见");

                core.reconfigure({
                    packageCacheRefreshMs: 0,
                    buildExcludeFolders: [],
                    followSymlinks: false,
                    walkTimeouts: { totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8 },
                });
                await core.forceRefresh();
                names = core.getState().workspace.map((w) => w.name).sort();
                assert.deepStrictEqual(names, ["demo", "hidden"], "重下发(清空排除集)后 hidden 应被扫入");
            } finally {
                core.dispose();
            }
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });
});
