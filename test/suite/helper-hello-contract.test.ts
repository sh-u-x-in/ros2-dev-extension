// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file helper-hello-contract.test.ts
 * 助手 hello 指纹握手——跨语言契约防漂移测试网(2026-10-18,无头)
 *
 * 事故:客户端曾发短键名 distro/domain_id/rmw,服务端(kernel.HELPER_FINGERPRINT_KEYS)
 * 按 key.lower() 取不到值归一 "0" ⇒ 恒 deny 踢除;单测只断言过 ros_version 一键,
 * 三个键错了全绿。本套件四层防线:
 *  A. 跨语言契约锁——fs 读 Python 源码提取字面量与 TS 常量逐字节对账(提取失败=显式红);
 *  B. 事故墓碑——旧短键集对服务端键集的交集钉死,此 bug 永不无声回归;
 *  C. buildHelloEnv 归一化真值表 + 假 socket 全帧;
 *  D. deny 行为组(熔断信号/不重拉/代数接管)+ 启动确认窗三态。
 *
 * 运行:npm run test-compile && node -e "(stubs)mocha out/test/suite/helper-hello-contract.test.js"
 * (或全量 npm test 的集成宿主——本套件仅无头跑,HEADLESS 守卫跳过集成宿主)
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

// 仓库根:编译产物在 out/test/suite,上溯三级;**绝不经 out/ 读源码**
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ROOT = path.resolve(__dirname, "../../..");

const KERNEL_SRC = fs.readFileSync(path.join(ROOT, "assets/ros/param_helper_lib/kernel.py"), "utf-8");
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "assets/ros/param_helper_lib/server.py"), "utf-8");
const OPS_SRC = fs.readFileSync(path.join(ROOT, "assets/ros/param_helper_lib/ops.py"), "utf-8");
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, "src/ros2/consumers/monitor/helper/param-helper-client.ts"), "utf-8");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const protocol = require("../../src/ros2/consumers/monitor/helper/param-helper-protocol") as {
    HELPER_FINGERPRINT_KEYS: readonly string[];
    HELLO_ENV_KEYS: readonly string[];
    HELLO_ENV_SOURCES: Readonly<Record<string, string>>;
    HELPER_PROTO_VERSION: string;
    HELPER_SOCKET_PATH: string;
    HELPER_LOCK_PATH: string;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("../../src/ros2/consumers/monitor/helper/param-helper-client") as {
    startParamHelper(script: string): number;
    stopParamHelper(): void;
    _resetForTest(): void;
    buildHelloEnv(): Record<string, string>;
    helperFailureSignal(gen: number): { kind: "tripped"; reason: string } | { kind: "superseded" } | undefined;
    setParamHelperEnvFacade(facade: { getEnv(): unknown; getEnvIssue(): string | null } | undefined): void;
    setParamHelperFailureCallback(cb: ((reason: string) => void) | undefined): void;
    setParamHelperCommandRunner(cr: unknown): void;
    setSocketFactoryForTest(factory: ((path: string, handlers: unknown) => unknown) | undefined): void;
    setHelperPushCallback(cb: ((frame: Record<string, unknown>) => void) | undefined): void;
    describeHelperState(): string;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const state = require("../../src/ros2/environment/state") as {
    _resetForTest(): void;
    setEnv(env: Record<string, string>): void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const flows = require("../../src/ros2/consumers/monitor/page/monitor-helper-flows") as {
    startHelperFlow(panel: unknown): Promise<void>;
    waitForHelperState(
        expected: boolean,
        timeoutMs?: number,
        failureProbe?: () => { kind: "tripped"; reason: string } | { kind: "superseded" } | undefined,
        runningProbe?: () => Promise<boolean>
    ): Promise<{ status: string; reason?: string }>;
};

// ---- 源码提取器(提取失败必须显式红,禁止静默跳过——提取器失效本身就是漂移) ----

function extractKernelFingerprintKeys(): string[] {
    const m = KERNEL_SRC.match(/^HELPER_FINGERPRINT_KEYS\s*=\s*\(([\s\S]*?)\)/m);
    assert.ok(m, "kernel.py 未提取到 HELPER_FINGERPRINT_KEYS——提取器失效或键表迁移,修提取器而非跳过");
    const keys = [...m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]);
    assert.ok(keys.length > 0, "kernel.py 键表提取为空");
    return keys;
}

function extractKernelString(name: string): string {
    const m = KERNEL_SRC.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"));
    assert.ok(m, `kernel.py 未提取到 ${name}`);
    return m[1];
}

function extractServerOps(): Set<string> {
    const m = OPS_SRC.match(/^OPS\s*=\s*\{([\s\S]*?)^\}/m);
    assert.ok(m, "ops.py 未提取到 OPS 表");
    const ops = new Set([...m[1].matchAll(/"([a-z_]+)"\s*:/g)].map((x) => x[1]));
    ops.add("ping"); // 服务端 ping 在 worker.py 就地应答,不入 OPS 表(worker.py:73)
    return ops;
}

function extractClientOps(): Set<string> {
    // request( 与 requestSerialTolerant( 都要收(get_param_values 走后者),Set 去重(ping 两处)
    const ops = new Set(
        [...CLIENT_SRC.matchAll(/(?:request|requestSerialTolerant)\(\s*"([a-z_]+)"/g)].map((x) => x[1])
    );
    assert.ok(ops.size > 0, "TS 客户端未提取到任何 op 字面量");
    return ops;
}

/** 假 socket 全链路harness:start → 工厂捕获 handlers → 手动 onConnect/喂帧 */
function makeHarness(env: Record<string, unknown> | undefined) {
    const writes: string[] = [];
    const failures: string[] = [];
    const pushes: Array<Record<string, unknown>> = [];
    let spawnCalls = 0;
    let handlers: {
        onConnect: () => void;
        onData: (chunk: Buffer) => void;
        onClose: () => void;
        onError: (err: Error) => void;
    } | null = null;
    client._resetForTest();
    client.setParamHelperEnvFacade(
        env === undefined ? undefined : { getEnv: () => env, getEnvIssue: () => null }
    );
    client.setParamHelperFailureCallback((r: string) => failures.push(r));
    client.setHelperPushCallback((f) => pushes.push(f));
    client.setParamHelperCommandRunner({
        exec: async () => undefined,
        spawn: () => { spawnCalls += 1; throw new Error("本套件不真 spawn"); },
    });
    client.setSocketFactoryForTest((_p: string, h: never) => {
        handlers = h;
        return { write: (d: string) => writes.push(d), destroy: () => { /* noop */ } };
    });
    const generation = client.startParamHelper("/tmp/param_helper.py");
    assert.ok(handlers, "start 后 socket 工厂应被同步调用(tryConnectOnce)");
    return {
        writes,
        failures,
        pushes,
        handlers: handlers as unknown as NonNullable<typeof handlers>,
        generation,
        spawnCalls: () => spawnCalls,
        feed: (frame: unknown) => (handlers as unknown as NonNullable<typeof handlers>).onData(
            Buffer.from(JSON.stringify(frame) + "\n", "utf-8")
        ),
    };
}

function helloFrameOf(writes: string[]): { frame: Record<string, unknown>; index: number } {
    const index = writes.findIndex((w) => w.includes('"hello"'));
    assert.ok(index >= 0, "首帧应为 hello");
    return { frame: JSON.parse(writes[index]) as Record<string, unknown>, index };
}

function resyncIdOf(writes: string[]): number {
    const line = writes.find((w) => w.includes('"op":"resync"'));
    assert.ok(line, "应已发出 resync 帧");
    const frame = JSON.parse(line) as { id: number };
    return frame.id;
}

/** 服务端带明细的 deny reason(修④后形态;前缀不变+失配键清单) */
const DENY = "environment fingerprint mismatch: ros_distro client='0' server='humble'";

describe("助手 hello 契约网", () => {
    // ⚠️ 钩子必须在 describe 内:顶层钩子=Mocha 全局钩子,this.skip() 会把整个
    // 集成宿主的全部套件跳成假绿(2026-10-18 现场教训)。本套件双宿主可跑:
    // 无头装 stub,集成宿主用真 vscode——契约锁在 npm test 质量门内生效。
    beforeEach(function () {
        if (!HEADLESS) { return; }
        state._resetForTest();
    });

    afterEach(() => {
        client._resetForTest();
        state._resetForTest();
    });
    describe("A. 跨语言契约锁(源码提取对账)", () => {
        it("kernel 键集 == TS HELPER_FINGERPRINT_KEYS(排序逐字节)", () => {
            const kernelKeys = extractKernelFingerprintKeys().sort();
            const tsKeys = [...protocol.HELPER_FINGERPRINT_KEYS].sort();
            assert.deepStrictEqual(tsKeys, kernelKeys);
        });

        it("键数=4 且无重名(键表自身卫生)", () => {
            const kernelKeys = extractKernelFingerprintKeys();
            assert.strictEqual(kernelKeys.length, 4);
            assert.strictEqual(new Set(kernelKeys).size, 4);
        });

        it("PROTO_VERSION 逐字节一致", () => {
            assert.strictEqual(protocol.HELPER_PROTO_VERSION, extractKernelString("PROTO_VERSION"));
        });

        it("socket 路径逐字节一致", () => {
            assert.strictEqual(protocol.HELPER_SOCKET_PATH, extractKernelString("SOCKET_PATH"));
        });

        it("锁文件路径逐字节一致", () => {
            assert.strictEqual(protocol.HELPER_LOCK_PATH, extractKernelString("LOCK_PATH"));
        });

        it("op 名集合一致(ops.py OPS 表 + ping ↔ TS request 字面量)", () => {
            assert.deepStrictEqual(extractClientOps(), extractServerOps());
        });

        it("server.py 比对循环吃 HELPER_FINGERPRINT_KEYS 常量(禁旁路硬编码)", () => {
            assert.ok(
                SERVER_SRC.includes("for key in HELPER_FINGERPRINT_KEYS"),
                "比对循环必须遍历 kernel 键表常量"
            );
        });
    });

    describe("B. 事故墓碑(2026-10-18 短键名恒 deny)", () => {
        it("旧短键集对服务端键集的交集恰为 {ros_version}——旧实现必 deny,钉死永不回归", () => {
            const serverLower = new Set(extractKernelFingerprintKeys().map((k) => k.toLowerCase()));
            const legacy = ["ros_version", "distro", "domain_id", "rmw"];
            const hit = legacy.filter((k) => serverLower.has(k));
            assert.deepStrictEqual(hit, ["ros_version"], "旧短键 3/4 取不到值——这正是事故机制");
        });

        it("现行 TS wire 键集 == 服务端键集小写(修复后恒匹配)", () => {
            const serverLower = extractKernelFingerprintKeys().map((k) => k.toLowerCase()).sort();
            assert.deepStrictEqual([...protocol.HELLO_ENV_KEYS].sort(), serverLower);
        });
    });

    describe("C. TS 侧自洽锁(派生关系)", () => {
        it("HELLO_ENV_KEYS 恰为 HELPER_FINGERPRINT_KEYS 逐项小写(顺序一致)", () => {
            assert.deepStrictEqual(
                [...protocol.HELLO_ENV_KEYS],
                protocol.HELPER_FINGERPRINT_KEYS.map((k) => k.toLowerCase())
            );
        });

        it("HELLO_ENV_SOURCES[key] == 该键的大写形态(查表映射自洽)", () => {
            for (const key of protocol.HELLO_ENV_KEYS) {
                assert.strictEqual(protocol.HELLO_ENV_SOURCES[key], key.toUpperCase());
            }
        });

        it("buildHelloEnv 输出键集 == HELLO_ENV_KEYS(不多不少)", () => {
            client._resetForTest();
            client.setParamHelperEnvFacade({ getEnv: () => ({}), getEnvIssue: () => null });
            assert.deepStrictEqual(
                Object.keys(client.buildHelloEnv()).sort(),
                [...protocol.HELLO_ENV_KEYS].sort()
            );
        });
    });

    describe("D. buildHelloEnv 归一化真值表(未设归一 0)", () => {
        const withEnv = (env: Record<string, unknown> | undefined): Record<string, string> => {
            client._resetForTest();
            client.setParamHelperEnvFacade(
                env === undefined ? undefined : { getEnv: () => env, getEnvIssue: () => null }
            );
            return client.buildHelloEnv();
        };

        it("门面未注入 → 四键全 0", () => {
            assert.deepStrictEqual(withEnv(undefined), {
                ros_version: "0", ros_distro: "0", ros_domain_id: "0", rmw_implementation: "0",
            });
        });

        it("空快照 {} → 四键全 0", () => {
            assert.deepStrictEqual(withEnv({}), {
                ros_version: "0", ros_distro: "0", ros_domain_id: "0", rmw_implementation: "0",
            });
        });

        it("事故环境 golden(humble,domain/rmw 未设)逐字节", () => {
            assert.deepStrictEqual(withEnv({ ROS_VERSION: "2", ROS_DISTRO: "humble" }), {
                ros_version: "2", ros_distro: "humble", ros_domain_id: "0", rmw_implementation: "0",
            });
        });

        it("全键 golden(rolling/domain 7/rmw fastrtps)原样透传", () => {
            assert.deepStrictEqual(
                withEnv({ ROS_VERSION: "2", ROS_DISTRO: "rolling", ROS_DOMAIN_ID: "7", RMW_IMPLEMENTATION: "rmw_fastrtps_cpp" }),
                { ros_version: "2", ros_distro: "rolling", ros_domain_id: "7", rmw_implementation: "rmw_fastrtps_cpp" }
            );
        });

        it("数字 0 → \"0\"(与未设同形,有意口径)", () => {
            assert.strictEqual(withEnv({ ROS_DOMAIN_ID: 0 }).ros_domain_id, "0");
        });

        it("数字 7 → \"7\"", () => {
            assert.strictEqual(withEnv({ ROS_DOMAIN_ID: 7 }).ros_domain_id, "7");
        });

        it("空串 → \"0\"", () => {
            assert.strictEqual(withEnv({ RMW_IMPLEMENTATION: "" }).rmw_implementation, "0");
        });

        it("null → \"0\"", () => {
            assert.strictEqual(withEnv({ ROS_DISTRO: null }).ros_distro, "0");
        });

        it("undefined → \"0\"", () => {
            assert.strictEqual(withEnv({ ROS_VERSION: undefined }).ros_version, "0");
        });
    });

    describe("E. hello 全帧(假 socket 捕获)", () => {
        it("proto 与协议版本一致", () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            h.handlers.onConnect();
            assert.strictEqual(helloFrameOf(h.writes).frame.hello?.constructor, Object);
            const hello = (helloFrameOf(h.writes).frame as { hello: { proto: string } }).hello;
            assert.strictEqual(hello.proto, protocol.HELPER_PROTO_VERSION);
        });

        it("env 键集精确等于 HELLO_ENV_KEYS(不多不少)", () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            h.handlers.onConnect();
            const env = (helloFrameOf(h.writes).frame as { hello: { env: Record<string, string> } }).hello.env;
            assert.deepStrictEqual(Object.keys(env).sort(), [...protocol.HELLO_ENV_KEYS].sort());
        });

        it("值全为 string 且信封字段(client/id/time)在位", () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble", ROS_DOMAIN_ID: 7 });
            h.handlers.onConnect();
            const frame = helloFrameOf(h.writes).frame as {
                client: string; id: number; time: number;
                hello: { env: Record<string, unknown> };
            };
            for (const v of Object.values(frame.hello.env)) {
                assert.strictEqual(typeof v, "string");
            }
            assert.ok(frame.client.startsWith("exthost-"));
            assert.strictEqual(typeof frame.id, "number");
            assert.strictEqual(typeof frame.time, "number");
        });

        it("hello 先于 resync(同连接帧序)", () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            h.handlers.onConnect();
            const helloIdx = helloFrameOf(h.writes).index;
            const resyncIdx = h.writes.findIndex((w) => w.includes('"op":"resync"'));
            assert.ok(resyncIdx > helloIdx, "hello 必须先于 resync");
        });
    });

    describe("F. deny 行为组(假 socket 投喂)", () => {
        it("deny → 失败回调逐字透传 reason(含服务端明细),探针命中 tripped", () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            h.handlers.onConnect();
            h.feed({ service: 5101, time: 1, "cl-num": 0, deny: { reason: DENY } });
            assert.strictEqual(h.failures.length, 1);
            assert.ok(h.failures[0].includes(DENY), `应逐字含服务端明细: ${h.failures[0]}`);
            const sig = client.helperFailureSignal(h.generation);
            assert.ok(sig && sig.kind === "tripped" && sig.reason.includes(DENY));
        });

        it("trip 后不重拉(spawn 零调用),desiredRunning 复位", () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            h.handlers.onConnect();
            h.feed({ service: 5101, time: 1, "cl-num": 0, deny: { reason: DENY } });
            assert.strictEqual(h.spawnCalls(), 0);
            assert.ok(client.describeHelperState().includes("desiredRunning=false"));
        });

        it("重按 Start = 代数前进:旧探针 superseded,新代熔断已复位", () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            h.handlers.onConnect();
            h.feed({ service: 5101, time: 1, "cl-num": 0, deny: { reason: DENY } });
            const gen2 = client.startParamHelper("/tmp/param_helper.py");
            assert.ok(gen2 > h.generation, "代数必须单调前进");
            assert.deepStrictEqual(client.helperFailureSignal(h.generation), { kind: "superseded" });
            assert.strictEqual(client.helperFailureSignal(gen2), undefined);
        });

        it("resync 回应正常通过:不触发熔断,graph push 直达(会话守卫放行本代)", async () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            h.handlers.onConnect();
            const id = resyncIdOf(h.writes);
            h.feed({ service: 9, time: 2, "cl-num": 1, response: { client: "srv", id, time: 2, success: true, data: { nodes: [] } } });
            await new Promise((r) => setImmediate(r)); // resync 续体是微任务,让一轮事件循环跑完
            assert.strictEqual(client.helperFailureSignal(h.generation), undefined);
            assert.strictEqual(h.failures.length, 0);
            assert.ok(h.pushes.some((p) => p.kind === "graph"), "resync 快照应折算 graph push");
        });

        it("_resetForTest 清失败信号(测试隔离)", () => {
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            h.handlers.onConnect();
            h.feed({ service: 5101, time: 1, "cl-num": 0, deny: { reason: DENY } });
            client._resetForTest();
            // reset 后旧代语义上已不复存在(superseded 合法),不变式=不再有 tripped
            const sig = client.helperFailureSignal(h.generation);
            assert.ok(sig === undefined || sig.kind === "superseded", "reset 后不得再有 tripped 信号");
            assert.strictEqual(client.helperFailureSignal(0), undefined);
        });
    });

    describe("G. 启动确认窗三态(waitForHelperState,探针/超时/runningProbe 注入)", () => {
        it("tripped:探针命中即刻返回,不耗超时预算", async () => {
            const t0 = Date.now();
            const result = await flows.waitForHelperState(
                true, 30000, () => ({ kind: "tripped", reason: "boom" }), async () => false
            );
            assert.deepStrictEqual(result, { status: "tripped", reason: "boom" });
            assert.ok(Date.now() - t0 < 5000, "熔断路径不得陪跑超时窗");
        });

        it("superseded:被更新的启动接管即静默返回", async () => {
            const result = await flows.waitForHelperState(
                true, 30000, () => ({ kind: "superseded" }), async () => false
            );
            assert.strictEqual(result.status, "superseded");
        });

        it("timeout:小超时注入下返回 timeout(不真等 15s)", async () => {
            const t0 = Date.now();
            const result = await flows.waitForHelperState(true, 250, undefined, async () => false);
            assert.strictEqual(result.status, "timeout");
            assert.ok(Date.now() - t0 < 4000, `超时路径被拖长: ${Date.now() - t0}ms`);
        });

        it("ok:期望达成即返回", async () => {
            const result = await flows.waitForHelperState(true, 1000, undefined, async () => true);
            assert.strictEqual(result.status, "ok");
        });

        it("成功判定后再复查:熔断恰在达成后落地 → 不认 ok", async () => {
            let calls = 0;
            const probe = (): { kind: "tripped"; reason: string } | undefined => {
                calls += 1;
                return calls >= 2 ? { kind: "tripped", reason: "late-deny" } : undefined;
            };
            const result = await flows.waitForHelperState(true, 1000, probe, async () => true);
            assert.strictEqual(result.status, "tripped");
            assert.strictEqual(result.reason, "late-deny");
        });

        it("startHelperFlow 全链路:deny 后快速终结,页面只收 starting(原因走回调直达,不发误导超时文案)", async function () {
            // A/B/D/F 平台白名单门(2026-10-18):win32 开发机在环境门之前就被平台文案拒绝,
            // 走不到 deny 链——本例验证 deny 快速终结语义,仅 posix 宿主可跑
            if (process.platform === "win32") {
                this.skip();
            }
            state.setEnv({ ROS_VERSION: "2", ROS_DISTRO: "humble" }); // 入口环境门开
            const sent: Array<{ helperAction?: string; message?: string }> = [];
            const panel = { webview: { postMessage: async (m: never) => { sent.push(m); return true; } } };
            const h = makeHarness({ ROS_VERSION: "2", ROS_DISTRO: "humble" });
            const t0 = Date.now();
            const flow = flows.startHelperFlow(panel);
            h.handlers.onConnect();
            h.feed({ service: 5101, time: 1, "cl-num": 0, deny: { reason: DENY } });
            await flow;
            assert.ok(Date.now() - t0 < 10000, `deny 后应在探针下一个 tick 内终结,实耗 ${Date.now() - t0}ms`);
            assert.deepStrictEqual(
                sent.map((m) => m.helperAction),
                ["starting"],
                "只应有 starting 一条;错误原因由 failureCallback 直达,不得再发超时文案"
            );
            assert.ok(h.failures[0].includes(DENY));
        });
    });
});
