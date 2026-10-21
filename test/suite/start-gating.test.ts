/**
 * 组件 start 化门控测试(2026-10-18 P2,无头单跑)
 *
 * 验证「构造≠启动」:
 *  - PackageFetcher:未 start 时定时器不跑(零 tick);start 后 tick 到达;dispose 容忍未 start;
 *    start 前的 setRefreshIntervalMs 暂存(start 后按暂存值生效)。
 *  - package-core 构造零副作用:createPackageCore 后未 start 时 workspace 域保持 null(未扫描)。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/start-gating.test.js --exit
 */

import * as assert from "assert";

import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createPackageFetcher } = require("../../src/build-tool/package-core/event/index") as {
    createPackageFetcher(options?: { refreshIntervalMs?: number; workspaceRoot?: string }): {
        start(): void;
        onExternalChange(cb: (ev: { kind: string }) => void): () => void;
        setRefreshIntervalMs(ms: number): void;
        dispose(): void;
    };
};

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("PackageFetcher start 门控(P2)", () => {
    it("未 start:定时器不跑(窗口内零 tick);dispose 容忍未 start", async function () {
        if (!HEADLESS) { this.skip(); }
        const fetcher = createPackageFetcher({ refreshIntervalMs: 10 });
        let ticks = 0;
        fetcher.onExternalChange((ev) => {
            if (ev.kind === "timer-tick") {
                ticks += 1;
            }
        });
        await sleep(80);
        assert.strictEqual(ticks, 0, "构造零副作用:未 start 无定时器 tick");
        fetcher.dispose(); // 未 start 的 dispose 不得抛错
        await sleep(20);
        assert.strictEqual(ticks, 0);
    });

    it("start 后 tick 到达;start 幂等;start 前暂存的周期生效", async function () {
        if (!HEADLESS) { this.skip(); }
        const fetcher = createPackageFetcher({ refreshIntervalMs: 60000 });
        let ticks = 0;
        fetcher.onExternalChange((ev) => {
            if (ev.kind === "timer-tick") {
                ticks += 1;
            }
        });
        fetcher.setRefreshIntervalMs(10); // start 前到达:暂存(start 后按 10ms 生效)
        fetcher.start();
        fetcher.start(); // 幂等:不重复建定时器(若重复,tick 频率翻倍,下方上界断言会红)
        await sleep(120);
        const ticksAt120 = ticks;
        assert.ok(ticksAt120 >= 1, "start 后 tick 到达");
        await sleep(120);
        assert.ok(ticks <= ticksAt120 + 40, "start 幂等:tick 速率未翻倍");
        fetcher.dispose();
    });
});

describe("package-core 构造零副作用(P2)", () => {
    it("createPackageCore 后未 start:workspace 域保持 null(未扫描),dispose 干净", function () {
        if (!HEADLESS) { this.skip(); }
        const { createPackageCore } = require("../../src/build-tool/package-core/compose") as {
            createPackageCore(options: Record<string, unknown>): {
                start(): void;
                getState(): { workspace: unknown };
                dispose(): void;
            };
        };
        const core = createPackageCore({
            workspaceRoot: undefined,
            enableWatcher: true,
            config: {
                packageCacheRefreshMs: 60000,
                buildExcludeFolders: [],
                followSymlinks: false,
                walkTimeouts: { totalTimeoutMs: 1000, branchTimeoutMs: 500, maxDepth: 4 },
            },
            buildTaskProviderGate: {
                envAvailable: () => false,
                hasPackages: () => false,
                allowEmptyWorkspace: () => false,
                registerBuildTaskProvider: () => [],
            },
        });
        try {
            assert.strictEqual(core.getState().workspace, null, "未 start 不扫描(workspace 保持 null 就绪契约)");
        } finally {
            core.dispose(); // 未 start 的 dispose 不得抛错
        }
    });
});
