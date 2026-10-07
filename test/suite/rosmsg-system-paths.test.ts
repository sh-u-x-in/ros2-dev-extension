/**
 * rosmsg 系统带路径懒登记单测(RM-1,2026-09-25;设计:14 号外 RosMsg LA/RM 批次)
 *
 * 覆盖:登记(触碰即登记整包)/ 带路径条目命中与未命中 / 名单变化修剪 / 磁盘缓存恢复 / 门控。
 * SystemIndex 经 fake ExtensionContext(globalStoragePath=临时目录)+ applySystemSnapshot 注入名单。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { SystemIndex } from "../../src/languages/rosmsg/data/system-index";

/** fake ExtensionContext(仅 globalStoragePath) */
function fakeContext(): { ctx: never; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rde-rosmsg-sys-"));
    return { ctx: { globalStoragePath: dir } as never, dir };
}

/** 造一个"系统包"目录:share/<pkg>/msg/*.msg */
function makePkgDir(root: string, pkg: string, names: string[]): string {
    const msgDir = path.join(root, pkg, "msg");
    fs.mkdirSync(msgDir, { recursive: true });
    for (const n of names) {
        fs.writeFileSync(path.join(msgDir, n + ".msg"), "int32 x");
    }
    return path.join(root, pkg);
}

describe("rosmsg 系统带路径懒登记(RM-1)", () => {
    it("触碰即登记整包:命中返回 source=system + path;未含名字返回 undefined", async () => {
        const { ctx, dir } = fakeContext();
        try {
            const pkgDir = makePkgDir(dir, "std_msgs", ["Int32", "Float32"]);
            const index = new SystemIndex(ctx, 600000);
            index.applySystemSnapshot(["std_msgs/Int32", "std_msgs/Float32"]);
            const registered = await index.registerPackagePaths("std_msgs", async () => pkgDir);
            assert.strictEqual(registered, true);
            const hit = index.systemEntryWithPath("std_msgs", "Int32");
            assert.ok(hit, "Int32 应带路径命中");
            assert.strictEqual(hit.source, "system");
            assert.strictEqual(hit.path, path.join(pkgDir, "msg", "Int32.msg"));
            assert.ok(fs.existsSync(hit.path));
            assert.strictEqual(index.systemEntryWithPath("std_msgs", "Nope"), undefined, "未含名字不命中");
            assert.strictEqual(index.systemEntryWithPath("other", "Int32"), undefined, "未登记包不命中");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("单飞与幂等:重复登记不重复处理;resolveDir 失败返回 false 不登记", async () => {
        const { ctx, dir } = fakeContext();
        try {
            const pkgDir = makePkgDir(dir, "demo_msgs", ["A"]);
            const index = new SystemIndex(ctx, 600000);
            index.applySystemSnapshot(["demo_msgs/A"]);
            let calls = 0;
            const resolve = async (): Promise<string | undefined> => {
                calls++;
                return pkgDir;
            };
            await Promise.all([
                index.registerPackagePaths("demo_msgs", resolve),
                index.registerPackagePaths("demo_msgs", resolve)
            ]);
            assert.strictEqual(calls, 1, "并发应单飞(一次 resolveDir)");
            await index.registerPackagePaths("demo_msgs", resolve);
            assert.strictEqual(calls, 1, "已登记幂等短路");
            const ok = await index.registerPackagePaths("never_pkg", async () => undefined);
            assert.strictEqual(ok, false, "目录解析失败 → 不登记");
            assert.strictEqual(index.systemEntryWithPath("never_pkg", "A"), undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("名单变化修剪:包从系统名单消失 → 登记撤销", async () => {
        const { ctx, dir } = fakeContext();
        try {
            const pkgDir = makePkgDir(dir, "demo_msgs", ["A"]);
            const index = new SystemIndex(ctx, 600000);
            index.applySystemSnapshot(["demo_msgs/A"]);
            await index.registerPackagePaths("demo_msgs", async () => pkgDir);
            assert.ok(index.systemEntryWithPath("demo_msgs", "A"));
            index.applySystemSnapshot(["other/X"]); // demo_msgs 从名单消失
            assert.strictEqual(index.systemEntryWithPath("demo_msgs", "A"), undefined, "修剪后应撤销");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("磁盘缓存恢复:新实例(v5 载荷)直接获得带路径登记", async () => {
        const { ctx, dir } = fakeContext();
        try {
            const pkgDir = makePkgDir(dir, "std_msgs", ["Int32"]);
            const first = new SystemIndex(ctx, 600000);
            first.applySystemSnapshot(["std_msgs/Int32"]);
            await first.registerPackagePaths("std_msgs", async () => pkgDir);
            // 新实例:同 globalStoragePath;applySystemSnapshot 恢复名单后登记即查即得
            const second = new SystemIndex(ctx, 600000);
            second.applySystemSnapshot(["std_msgs/Int32"]);
            const hit = second.systemEntryWithPath("std_msgs", "Int32");
            assert.ok(hit && hit.path === path.join(pkgDir, "msg", "Int32.msg"), "登记应从 v5 缓存恢复");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
