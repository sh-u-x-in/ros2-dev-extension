// Licensed under the MIT License.

/**
 * @file run-readiness.test.ts
 * 一键运行「安装侧就绪性拆分」纯函数测试(2026-10-13 方案甲,用户裁定)。
 *
 * 背景:跳转表全部来自 build 侧(有编译无安装也放行,而侧边栏 = install 侧观察、什么都不显示,
 * 两套证据矛盾);splitOwnerReadiness 按**侧边栏同一行口径**(lib 区 installed 可执行行)
 * 把属主分为 runnable / compiledNotInstalled,供上层给出两种不同警告。
 * 无头运行:npm run test-compile && npx mocha out/test/suite/run-readiness.test.js
 */

import * as assert from "assert";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";

// 必须在 require 被测模块之前安装 vscode stub(被测模块顶层 import vscode,无头环境不可解析)
installVscodeStub();
const req = createRequire(__filename);
const rds = req("../../src/build-tool/package-service/run/run-data-source") as any;

/** 造一行(lib 区可执行 installed 行的合理默认) */
const row = (over: Record<string, unknown> = {}) => ({
    area: "lib", name: "talker", status: "installed", executable: true, ...over,
});
const view = (pkg: string, rows: Record<string, unknown>[]) => ({ pkg, rows });

describe("splitOwnerReadiness(方案甲:一键运行安装侧就绪预检)", () => {
    // 2026-10-13 泛型透传:属主携带的额外字段(如 executable/installPath/srcPath)原样进结果侧
    it("lib 区 installed 可执行行命中 → runnable(与侧边栏同源)", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], [view("p", [row()])]);
        assert.deepStrictEqual(out.runnable, [{ pkg: "p", name: "talker", executable: "talker" }]);
        assert.deepStrictEqual(out.compiledNotInstalled, []);
    });

    it("无任何行(编译了但压根无安装规则)→ compiledNotInstalled", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], [view("p", [])]);
        assert.deepStrictEqual(out.runnable, []);
        assert.deepStrictEqual(out.compiledNotInstalled, [{ pkg: "p", name: "talker", executable: "talker" }]);
    });

    it("行 status=missing(有安装规则但 install 侧没看到)→ compiledNotInstalled", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], [view("p", [row({ status: "missing" })])]);
        assert.deepStrictEqual(out.runnable, []);
        assert.deepStrictEqual(out.compiledNotInstalled, [{ pkg: "p", name: "talker", executable: "talker" }]);
    });

    it("行存在但非可执行(library 行等)→ compiledNotInstalled", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], [view("p", [row({ executable: false })])]);
        assert.deepStrictEqual(out.runnable, []);
        assert.deepStrictEqual(out.compiledNotInstalled, [{ pkg: "p", name: "talker", executable: "talker" }]);
    });

    it("views=null(中心未就绪)→ 保守全部 runnable(不因判不了而拦截)", () => {
        const out = rds.splitOwnerReadiness([{ pkg: "p", name: "talker", executable: "talker" }], null);
        assert.deepStrictEqual(out.runnable, [{ pkg: "p", name: "talker", executable: "talker" }]);
        assert.deepStrictEqual(out.compiledNotInstalled, []);
    });

    it("混合多属主 → 按就绪性正确分层", () => {
        const owners = [
            { pkg: "p", name: "talker", executable: "talker" },
            { pkg: "p", name: "ghost", executable: "ghost" },
            { pkg: "q", name: "listener", executable: "listener" },
        ];
        const views = [
            view("p", [row({ name: "talker" }), row({ name: "ghost", status: "missing" })]),
            view("q", [row({ name: "listener" })]),
        ];
        const out = rds.splitOwnerReadiness(owners, views);
        assert.deepStrictEqual(out.runnable, [
            { pkg: "p", name: "talker", executable: "talker" },
            { pkg: "q", name: "listener", executable: "listener" },
        ]);
        assert.deepStrictEqual(out.compiledNotInstalled, [{ pkg: "p", name: "ghost", executable: "ghost" }]);
    });
});

describe("陈旧附加警告纯函数(2026-10-13:附加不阻碍/状态栏 4 秒/30 秒冷却)", () => {
    it("isStale: 双存在且源严格更新 → true;相等/安装更新/缺一侧 → false", () => {
        assert.strictEqual(rds.isStale(2000, 1000), true, "源比安装新 = 陈旧");
        assert.strictEqual(rds.isStale(1000, 1000), false, "相等(symlink 穿透等时)不警");
        assert.strictEqual(rds.isStale(1000, 2000), false, "安装更新不警");
        assert.strictEqual(rds.isStale(undefined, 1000), false, "源缺失不警(装好的那份即唯一真相)");
        assert.strictEqual(rds.isStale(2000, undefined), false, "安装缺失不警(前序闸门已拦)");
        assert.strictEqual(rds.isStale(undefined, undefined), false);
    });

    it("shouldNotifyStale: 无记录可弹;30 秒窗口内不弹;窗口外可弹;常量 = 用户裁定值", () => {
        assert.strictEqual(rds.shouldNotifyStale(undefined, 1_000_000), true, "无记录 = 首弹");
        assert.strictEqual(rds.shouldNotifyStale(1_000_000, 1_000_000 + rds.STALE_NOTIFY_COOLDOWN_MS - 1), false, "窗口内不弹");
        assert.strictEqual(rds.shouldNotifyStale(1_000_000, 1_000_000 + rds.STALE_NOTIFY_COOLDOWN_MS), true, "窗口外可弹");
        assert.strictEqual(rds.STALE_NOTIFY_COOLDOWN_MS, 30_000, "冷却 30 秒(用户裁定)");
        // 2026-10-14:状态栏 4 秒常量随"警告气泡+不再显示按钮"改版废除(STALE_STATUSBAR_TIMEOUT_MS 已删)
        assert.ok(typeof rds.STALE_MUTE_LABEL === "string" && rds.STALE_MUTE_LABEL.length > 0, "静音按钮标签应为非空串");
    });

    it("键名锁:ROS2.tool.run.staleWarning(照 preflight 键名锁先例)", () => {
        assert.strictEqual(rds.RUN_STALE_WARNING_SETTING, "tool.run.staleWarning");
    });

    it("notifyStaleIfNeeded 静默路径不抛错(源/安装缺一 = 不警;无头 stub 下不触达气泡 API)", () => {
        assert.doesNotThrow(() => rds.notifyStaleIfNeeded("run", "p", "n", undefined, undefined));
        assert.doesNotThrow(() => rds.notifyStaleIfNeeded("launch", "p", "n", undefined, undefined));
    });
});

describe("陈旧比对落点选择(2026-10-16 误报修复:devDir 目录类别名永不参与比对)", () => {
    const cppEntry = (over: Record<string, unknown> = {}) => ({
        pkg: "p", name: "node", kind: "cpp",
        installPath: "/ws/install/p/lib/p/node", installPaths: undefined, ...over,
    });
    const pyEntry = (over: Record<string, unknown> = {}) => ({
        pkg: "p", name: "script_py", kind: "console_script",
        installPath: "", installPaths: ["/ws/build/p", "/ws/install/p/lib/p/script_py"],
        pythonInstall: { devDir: "/ws/build/p", verified: false },
        ...over,
    });

    it("entry 缺失 → undefined", () => {
        assert.strictEqual(rds.staleInstallTargetOf(undefined), undefined);
    });

    it("cpp(无 pythonInstall):installPath 优先;为空走 installPaths[0](原口径不变)", () => {
        assert.strictEqual(rds.staleInstallTargetOf(cppEntry()), "/ws/install/p/lib/p/node");
        assert.strictEqual(
            rds.staleInstallTargetOf(cppEntry({ installPath: "", installPaths: ["/ws/install/p/lib/p/node"] })),
            "/ws/install/p/lib/p/node"
        );
    });

    it("python 清单实证(verified=true,copy 安装)→ 照常给 installPath", () => {
        assert.strictEqual(
            rds.staleInstallTargetOf(pyEntry({ installPath: "/ws/install/p/lib/p/script_py", pythonInstall: { verified: true } })),
            "/ws/install/p/lib/p/script_py"
        );
    });

    it("性质钉:python 无清单实证(verified=false,ament_python develop 语义)→ undefined", () => {
        assert.strictEqual(
            rds.staleInstallTargetOf(pyEntry()),
            undefined,
            "2026-10-16 误报真因:installPaths[0] 字母序恒为 devDir(build/<pkg> 目录),目录 mtime 冻结建包时刻,绝不可参与比对"
        );
        assert.strictEqual(rds.staleInstallTargetOf(pyEntry({ pythonInstall: { verified: false, devDir: "/ws/build/p" } })), undefined);
    });

    it("pythonInstall 存在但缺 verified 字段(畸形)→ 按 false 处理(保守不警)", () => {
        assert.strictEqual(rds.staleInstallTargetOf(pyEntry({ pythonInstall: { devDir: "/ws/build/p" } })), undefined);
    });
});

describe("陈旧警告触发链(2026-10-16:isFile 门绊线 + 正路径恰弹一次)", () => {
    const fs = req("fs");
    const os = req("os");
    const path = req("path");
    const vscodeMod = req("vscode") as { window: Record<string, unknown> };
    const calls: Array<unknown[]> = [];
    let patched = false;
    let original: unknown;
    let dir = "";
    let src = "";
    let installFile = "";

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rds-stale-"));
        src = path.join(dir, "node.py");
        installFile = path.join(dir, "node");
        fs.writeFileSync(src, "x");
        fs.writeFileSync(installFile, "x");
        // 正路径素材:安装文件旧于源;绊线素材:目录 mtime 拨到过去(无门时 isStale 必真)
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(installFile, old, old);
        fs.utimesSync(dir, new Date(2020, 0, 1), new Date(2020, 0, 1));
        try {
            original = vscodeMod.window.showWarningMessage;
            vscodeMod.window.showWarningMessage = (...args: unknown[]) => {
                calls.push(args);
                return Promise.resolve(undefined);
            };
            patched = true;
        } catch {
            // 真宿主 window 不可写:正路径用例自行跳过(headless 单文件为主跑口径)
        }
    });

    after(() => {
        if (patched) {
            vscodeMod.window.showWarningMessage = original;
        }
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // 临时目录清理失败无害
        }
    });

    it("绊线:installPath 是目录(误报形态)→ isFile 门使其静默不抛(无门则无头撞缺失的气泡 API 必炸)", () => {
        assert.doesNotThrow(() => rds.notifyStaleIfNeeded("run", "stale_tripwire_pkg", "n", src, dir));
    });

    it("正路径:真实文件安装落点旧于源 → 恰弹 1 次(消息含目标名);30 秒冷却内不重弹", function () {
        if (!patched) {
            this.skip();
        }
        calls.length = 0;
        rds.notifyStaleIfNeeded("run", "stale_pos_pkg", "n", src, installFile);
        assert.strictEqual(calls.length, 1, "源 > 真实文件安装落点 = 恰弹一次");
        assert.ok(String(calls[0][0]).indexOf("stale_pos_pkg/n") >= 0, "消息应含目标名(pkg/name)");
        rds.notifyStaleIfNeeded("run", "stale_pos_pkg", "n", src, installFile);
        assert.strictEqual(calls.length, 1, "30 秒同目标冷却内不重弹");
    });
});
