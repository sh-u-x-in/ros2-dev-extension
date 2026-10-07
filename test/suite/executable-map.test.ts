// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file executable-map.test.ts
 * ExecutableMap 读侧中心无头单测(2026-09-02,设计:出口简化后的消费侧重写 + 单飞合并/no-op 治理)。
 *
 * 覆盖:
 *  1. 首载全量:refresh 后 map 就绪并通知一次;空结果也通知(everBuilt——"已就绪但无包"可区分);
 *  2. 双缓冲:全量重建期间 get 读到旧值,替换后才通知(无"map 真空期");
 *  3. 单飞合并:突发多事件 → 串行重建链(每次取最新状态),无并发无乱序,结果=最新;
 *  4. no-op 抑制:内容未变的重建/增量不通知下游;
 *  5. 增量 updatePackage:内容变化通知、无变化抑制;全量在跑时并入链尾(不做部分/全量交错)。
 * 纯 TS(fake 数据源 + fake fs,可 gated 控制时序),mocha 无头运行:
 *   npm run test-compile && npx mocha out/test/suite/executable-map.test.js
 */

import * as assert from "assert";
import {
    ExecutableMap,
    ExecutableMapDataSource,
    ExecutableMapFs,
} from "../../src/build-tool/package-service/config/exe-map/executable-map";

const SETUP_PA = "from setuptools import setup\nsetup(name='pa', version='0.1.0', entry_points={'console_scripts': ['talker = pa.talker:main']})";
const SETUP_PC = "from setuptools import setup\nsetup(name='pc', version='0.1.0', entry_points={'console_scripts': ['listener = pc.listener:main']})";
const SETUP_PA_EXTRA = "from setuptools import setup\nsetup(name='pa', version='0.1.0', entry_points={'console_scripts': ['talker = pa.talker:main', 'extra_cmd = pa.extra:main']})";
const CMAKE_PB = "cmake_minimum_required(VERSION 3.8)\nproject(pb)\nadd_executable(node_b src/main.cpp)\nament_export_executables(node_b)";

/** 目录文件夹具:key = 相对两段(如 "p/a/setup.py") */
const FILES: Record<string, string> = {
    "p/a/setup.py": SETUP_PA,
    "p/b/CMakeLists.txt": CMAKE_PB,
    "p/c/setup.py": SETUP_PC,
};

/** fake fs:可 gated(手动放行),统计读取次数;key = 归一化相对两段(如 "p/a/setup.py") */
class FakeFs implements ExecutableMapFs {
    calls = 0;
    gated = false;
    private pending: Array<() => void> = [];
    constructor(public files: Record<string, string>) { }
    readText(file: string): Promise<string | undefined> {
        this.calls++;
        // win/posix 归一:path.join('/p/a','setup.py') 在 win 产生盘符/斜杠差异 → 滤空段后全段 join
        // (目录键形如 "p/a/setup.py",与 FILES 键一致)
        const parts = file.replace(/\\/g, "/").split("/").filter(Boolean);
        const key = parts.join("/");
        const value = this.files[key];
        if (!this.gated) {
            return Promise.resolve(value);
        }
        return new Promise((res) => this.pending.push(() => res(value)));
    }
    release(n?: number): void {
        const arr = n === undefined ? this.pending.splice(0) : this.pending.splice(0, n);
        for (const f of arr) {
            f();
        }
    }
}

/** fake 门面数据源:可控 unignored 名单 + 手动发事件 */
class FakeSource {
    list: Array<{ name: string; dir: string; buildType: string }> | null = null;
    private cbs = new Set<(ev: unknown) => void>();
    getState(): unknown {
        return { workspace: null, unignored: this.list, ignored: [], system: [], all: null, generatedAt: 0 };
    }
    onDidChange(cb: (ev: unknown) => void): () => void {
        this.cbs.add(cb);
        return () => this.cbs.delete(cb);
    }
    fire(): void {
        const ev = { unignored: this.list };
        for (const cb of [...this.cbs]) {
            cb(ev);
        }
    }
}

const E = (dir: string, name: string, buildType: "ament_python" | "ament_cmake") => ({ dir, name, buildType });
const A = E("/p/a", "pa", "ament_python");
const B = E("/p/b", "pb", "ament_cmake");
const C = E("/p/c", "pc", "ament_python");

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

function make(fs: FakeFs): { map: ExecutableMap; src: FakeSource; events: () => number } {
    const src = new FakeSource();
    let events = 0;
    const map = new ExecutableMap(src as unknown as ExecutableMapDataSource, fs);
    map.onDidChange(() => {
        events++;
    });
    return { map, src, events: () => events };
}

describe("ExecutableMap(门面数据源 + 单飞合并/no-op)", function () {
    this.timeout(10000);

    /** 放行所有已入队读 + 之后新读自动 resolve(链是逐包串行等读,不能一次 release 掉未入队的) */
    const autoRelease = (fs: FakeFs): void => {
        fs.gated = false;
        fs.release(1000);
    };

    it("null 就绪契约:未就绪 getAll=null;首建就绪通知一次;空名单就绪=空 Map(非 null)并再通知", async () => {
        const fs = new FakeFs(FILES);
        const { map, src, events } = make(fs);
        assert.strictEqual(map.getAll(), null, "首建前视图 = null(未就绪,区别于空)");
        assert.strictEqual(map.get("pa"), undefined, "未就绪时 get 也不可用(undefined)");

        src.list = [A, B];
        await map.refresh();
        assert.ok(map.getAll() !== null, "首建完成 → 就绪(Map,可能空)");
        assert.deepStrictEqual([...map.getAll()!.keys()].sort(), ["pa", "pb"]);
        assert.strictEqual(map.executablesOf("pa")[0]?.kind, "consoleScript");
        assert.strictEqual(map.executablesOf("pb")[0]?.name, "node_b");
        assert.strictEqual(events(), 1, "null→Map 就绪宣布通知一次");

        // 空名单:就绪后确实无包 → Map(空)而非 null,且内容变化(non-empty→empty)通知一次
        src.list = [];
        await map.refresh();
        assert.ok(map.getAll() !== null, "已就绪后 getAll 恒为 Map(不因空回退 null)");
        assert.strictEqual(map.getAll()!.size, 0);
        assert.strictEqual(events(), 2);
    });

    it("updatePackage 首建前(map=null)→ 并入全量链,不产生半就绪视图", async () => {
        const fs = new FakeFs(FILES);
        const { map, src, events } = make(fs);
        assert.strictEqual(map.getAll(), null);
        src.list = [A];
        await map.updatePackage("/p/a"); // 未就绪:应触发全量而非部分增量
        await flush();
        assert.ok(map.getAll() !== null);
        assert.deepStrictEqual([...map.getAll()!.keys()], ["pa"]);
        assert.strictEqual(events(), 1, "全量完成=就绪宣布一次");
    });

    it("双缓冲:全量重建期间 get 读到旧值,替换后才通知(无 map 真空期)", async () => {
        const fs = new FakeFs(FILES);
        fs.gated = true;
        const { map, src, events } = make(fs);
        src.list = [A];
        const p1 = map.refresh();
        fs.release(1);
        await p1;
        assert.strictEqual(map.getAll().size, 1);
        assert.strictEqual(events(), 1);

        // 触发现有 list 变化 → 全量在跑(gated),期间读旧值
        src.list = [A, B];
        const p2 = map.refresh();
        await flush(); // 让 doRefresh 进入并停在 fs 读上
        assert.strictEqual(map.getAll().size, 1, "重建期间应读到旧 map(无真空)");
        assert.strictEqual(events(), 1, "替换前不应通知");
        autoRelease(fs); // 放行当前读 + 之后新读自动 resolve(逐包串行)
        await p2;
        assert.strictEqual(map.getAll().size, 2, "替换后新 map 完整");
        assert.strictEqual(events(), 2);
    });

    it("单飞合并:突发多事件 → 串行链(每轮取最新),无并发乱序,结果=最新", async () => {
        const fs = new FakeFs(FILES);
        const { map, src, events } = make(fs);
        src.list = [A];
        await map.refresh();
        const baseCalls = fs.calls;
        const baseEvents = events();

        // 连续 3 个事件:第 1 个起链(读 [A,B]),第 2/3 个标脏 → 链尾以最新 [A,B,C] 补刷(读 3)
        src.list = [A, B];
        src.fire();
        src.list = [A];
        src.fire();
        src.list = [A, B, C];
        src.fire();
        await flush();
        assert.strictEqual(fs.calls - baseCalls, 2 + 3, "共两轮重建:2 次读取 + 3 次读取(无并发放大)");
        assert.strictEqual(events() - baseEvents, 2, "两轮内容变化各通知一次");
        assert.deepStrictEqual([...map.getAll().keys()].sort(), ["pa", "pb", "pc"], "结果=最新状态");
    });

    it("no-op 抑制:内容未变的事件/增量不通知下游", async () => {
        const fs = new FakeFs(FILES);
        const { map, src, events } = make(fs);
        src.list = [A];
        await map.refresh();
        assert.strictEqual(events(), 1);

        // 同内容再发一次域事件 → 会多一轮重建读取,但不通知
        src.fire();
        await flush();
        assert.strictEqual(events(), 1, "内容未变不应通知");

        // 增量:改文件但可执行入口不变(空白/注释级改动)→ 不通知
        await map.updatePackage("/p/a");
        const before = events();
        await map.updatePackage("/p/a"); // 内容未变(同一文本)
        assert.strictEqual(events(), before, "增量无实际变化不应通知");
    });

    it("增量 updatePackage:内容变化通知;全量在跑时并入链尾", async () => {
        const fs = new FakeFs(FILES);
        const { map, src, events } = make(fs);
        src.list = [A];
        await map.refresh();
        assert.deepStrictEqual(map.executablesOf("pa").map((e) => e.name), ["talker"]);

        // 文件增加一个入口 → 增量更新 + 通知
        fs.files["p/a/setup.py"] = SETUP_PA_EXTRA;
        await map.updatePackage("/p/a");
        assert.deepStrictEqual(map.executablesOf("pa").map((e) => e.name).sort(), ["extra_cmd", "talker"]);
        assert.strictEqual(events(), 2);

        // 全量在跑(gated)时 updatePackage → 并入链尾,最终由全量覆盖(含新包 B)
        fs.gated = true;
        src.list = [A, B];
        const p = map.refresh();
        await flush(); // doRefresh 停在 fs 读
        await map.updatePackage("/p/a"); // 应早退并入链尾,不产生部分交错
        assert.deepStrictEqual([...map.getAll().keys()].sort(), ["pa"], "全量在跑期间不做部分增量(无交错)");
        autoRelease(fs);
        await p;
        await flush();
        assert.deepStrictEqual([...map.getAll().keys()].sort(), ["pa", "pb"], "链尾全量含最新名单");
        assert.ok(events() >= 3);
    });
});
