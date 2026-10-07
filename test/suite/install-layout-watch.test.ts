/**
 * @file install-layout-watch.test.ts
 * 安装布局信号监听的无头单测(注入 fake watcher 工厂,不需要真实 VS Code)。
 *
 * 覆盖 2026-09-16 方案 2(标记 watcher 以**文件自身**为 base)后的行为:
 *   ① 注册即挂两个 watcher:目录条目(工作区根 + `*`)+ 标记文件(文件路径 + `*`),不依赖 install/ 是否存在;
 *   ② 标记 watcher 只订阅 create;change/delete 交给轮询兜底(用户裁定);
 *   ③ 目录出现 → 防抖后发一次信号 + 到点再补查一次(有界;不再需要"补挂"标记 watcher);
 *   ④ dispose 清掉待发定时器与全部 watcher,之后不再发信号。
 */

import * as assert from "assert";
import * as path from "path";
import { installVscodeStub } from "./_vscode-stub";

// 必须先装 vscode stub 再 require 被测模块(该模块顶层 import "vscode";顶层值 import 会提前 require)
installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const watchMod = require("../../src/build-tool/package-service/config/gen/install-layout-watch") as typeof import("../../src/build-tool/package-service/config/gen/install-layout-watch");
const registerInstallLayoutWatch = watchMod.registerInstallLayoutWatch;

class FakeWatcher {
    readonly createCbs: Array<(uri?: unknown) => void> = [];
    readonly changeCbs: Array<(uri?: unknown) => void> = [];
    readonly deleteCbs: Array<(uri?: unknown) => void> = [];
    disposed = false;

    onDidCreate(cb: (uri?: unknown) => void): { dispose(): void } {
        this.createCbs.push(cb);
        return { dispose: (): void => undefined };
    }
    onDidChange(cb: (uri?: unknown) => void): { dispose(): void } {
        this.changeCbs.push(cb);
        return { dispose: (): void => undefined };
    }
    onDidDelete(cb: (uri?: unknown) => void): { dispose(): void } {
        this.deleteCbs.push(cb);
        return { dispose: (): void => undefined };
    }
    dispose(): void {
        this.disposed = true;
    }
    fireCreate(uri?: unknown): void {
        for (const cb of [...this.createCbs]) {
            cb(uri);
        }
    }
    fireChange(uri?: unknown): void {
        for (const cb of [...this.changeCbs]) {
            cb(uri);
        }
    }
    fireDelete(uri?: unknown): void {
        for (const cb of [...this.deleteCbs]) {
            cb(uri);
        }
    }
}

/** 工作区根的"install 条目"事件 uri */
const INSTALL_URI = { fsPath: "/ws/install" };
const OTHER_URI = { fsPath: "/ws/src" };

/** 标记文件 watcher 的 base(方案 2:文件自身;与模块内 path.join 同式,保证跨平台断言一致) */
const MARKER_BASE = path.join("/ws", "install/.colcon_install_layout");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("install-layout-watch(安装布局信号监听)", () => {
    function setup(dirRetryMs = 30): {
        made: Array<{ base: string; pattern: string; w: FakeWatcher }>;
        signals: string[];
        watch: { dispose(): void };
    } {
        const made: Array<{ base: string; pattern: string; w: FakeWatcher }> = [];
        const signals: string[] = [];
        const watch = registerInstallLayoutWatch({
            workspaceRoot: "/ws",
            debounceMs: 5,
            dirRetryMs,
            createWatcher: (base, pattern) => {
                const w = new FakeWatcher();
                made.push({ base, pattern, w });
                return w as never;
            },
            onLayoutSignal: (reason) => signals.push(reason),
        });
        return { made, signals, watch };
    }

    it("注册即挂两个 watcher:目录条目(根 + 松匹配 *)+ 标记文件(文件自身为 base,*);与 install/ 是否存在无关", () => {
        const a = setup();
        assert.deepStrictEqual(a.made.map((m) => `${m.base}|${m.pattern}`), [
            "/ws|*",
            `${MARKER_BASE}|*`,
        ], "目录条目 + 标记文件(方案 2:base = 文件自身)");
        assert.strictEqual(a.made[1].w.changeCbs.length, 0, "标记 watcher 只订阅 create");
        assert.strictEqual(a.made[1].w.deleteCbs.length, 0, "delete 交给 ① 与轮询兜底");
        a.watch.dispose();
    });

    it("根目录里非 install 条目的增删被忽略", async () => {
        const { made, signals, watch } = setup(1000);
        made[0].w.fireCreate(OTHER_URI);
        made[0].w.fireDelete(OTHER_URI);
        await sleep(15);
        assert.deepStrictEqual(signals, [], "其它条目不应触发重算:" + JSON.stringify(signals));
        watch.dispose();
    });

    it("目录出现:防抖后发一次信号 + 到点补查一次;标记 watcher 常驻(无补挂动作)", async () => {
        const { made, signals, watch } = setup(30);
        made[0].w.fireCreate(INSTALL_URI);
        assert.strictEqual(signals.length, 0, "防抖窗口内不应立即发信号");
        assert.strictEqual(made.length, 2, "方案 2 下标记 watcher 注册即挂,目录出现不新增 watcher");
        await sleep(15);
        assert.deepStrictEqual(signals, ["install/ 目录出现"]);
        await sleep(40);
        assert.strictEqual(signals.length, 2, "补查应到点触发一次:" + JSON.stringify(signals));
        assert.ok(signals[1].includes("补查"), signals[1]);
        made[1].w.fireCreate(); // 常驻的标记 watcher
        await sleep(15);
        assert.strictEqual(signals.length, 3, JSON.stringify(signals));
        made[1].w.fireChange(); // 未订阅 → 不应产生信号
        await sleep(15);
        assert.strictEqual(signals.length, 3, "标记 change 不产生信号(由轮询兜底):" + JSON.stringify(signals));
        watch.dispose();
    });

    it("多事件在防抖窗口内合并成一次;install/ 被删也要发信号", async () => {
        const { made, signals, watch } = setup(1000);
        made[0].w.fireDelete(INSTALL_URI);
        made[1].w.fireCreate();
        await sleep(15);
        assert.strictEqual(signals.length, 1, "窗口内多事件应合并:" + JSON.stringify(signals));
        assert.ok(signals[0].includes("install/") || signals[0].includes("标记"), signals[0]);
        watch.dispose();
    });

    it("dispose:清掉待发定时器与全部 watcher,之后事件不再发信号", async () => {
        const { made, signals, watch } = setup(30);
        made[0].w.fireCreate(INSTALL_URI);
        watch.dispose();
        assert.ok(made.every((m) => m.w.disposed), "全部 watcher 应被 dispose");
        await sleep(50);
        assert.strictEqual(signals.length, 0, "dispose 后不应再发信号(防抖 + 补查都要清掉):" + JSON.stringify(signals));
    });

    describe("兜底轮询(不押注 watch 通道的确定性保底)", () => {
        function setupPoll(initial: string | undefined, pollIntervalMs = 10): {
            signals: string[];
            setMarker(v: string | undefined): void;
            watch: { dispose(): void };
        } {
            let content = initial;
            const signals: string[] = [];
            const watch = registerInstallLayoutWatch({
                workspaceRoot: "/ws",
                debounceMs: 1,
                dirRetryMs: 100000,
                pollIntervalMs,
                readMarkerContent: () => content,
                createWatcher: () => new FakeWatcher() as never,
                onLayoutSignal: (reason) => signals.push(reason),
            });
            return { signals, setMarker: (v) => { content = v; }, watch };
        }

        it("注册时不报警(先取基线);内容变化 → 防抖后发一次", async () => {
            const { signals, setMarker, watch } = setupPoll("isolated\n");
            await sleep(30);
            assert.strictEqual(signals.length, 0, "内容没变不应报警:" + JSON.stringify(signals));
            setMarker("merged\n");
            await sleep(30);
            assert.deepStrictEqual(signals, ["安装布局标记内容变化(轮询兜底)"]);
            watch.dispose();
        });

        it("标记出现 / 消失都发信号(有内容 → undefined / undefined → 有内容)", async () => {
            const { signals, setMarker, watch } = setupPoll(undefined);
            setMarker("isolated\n");
            await sleep(30);
            assert.deepStrictEqual(signals, ["安装布局标记出现(轮询兜底)"]);
            setMarker(undefined);
            await sleep(30);
            assert.deepStrictEqual(signals, ["安装布局标记出现(轮询兜底)", "安装布局标记消失(轮询兜底)"]);
            watch.dispose();
        });

        it("pollIntervalMs = 0 → 完全关闭轮询", async () => {
            const { signals, setMarker, watch } = setupPoll("isolated\n", 0);
            setMarker("merged\n");
            await sleep(30);
            assert.strictEqual(signals.length, 0, JSON.stringify(signals));
            watch.dispose();
        });

        it("dispose 后轮询停止", async () => {
            const { signals, setMarker, watch } = setupPoll("isolated\n");
            watch.dispose();
            setMarker("merged\n");
            await sleep(30);
            assert.strictEqual(signals.length, 0, JSON.stringify(signals));
        });
    });
});
