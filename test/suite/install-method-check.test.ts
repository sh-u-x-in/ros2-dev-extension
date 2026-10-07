/**
 * install-method-check 单测(2026-09-22 新增;同日按用户裁定两次简化后重写)。
 *
 * 无头可跑:npx mocha out/test/suite/install-method-check.test.js
 * (被测模块零 vscode 依赖,无需 stub;logger 未注入通道时回退 console)。
 *
 * 判据(定稿):
 *  · 配置形态 = `build/<pkg>/CMakeCache.txt` 的 `AMENT_CMAKE_SYMLINK_INSTALL` —— **只决定是否自动清缓存**;
 *  · 本次**符号** → 权威信号 = **build 落点 lstat**(实体目录 ⇒ 退出码 2);
 *  · 本次**实体** → 权威信号 = **install 侧唯一探针** `<prefix>/share/ament_index/resource_index/packages/<pkg>`
 *    (软链 ⇒ 静默无效;常规文件 ⇒ 正常;缺失 ⇒ unknown 放行,**不做任何扫描**——假设 install 不被人工局部篡改)。
 * 覆盖:查表(六格 + 边界 + 时序错位)、文案、配置/落点/探针三项磁盘读、探针单条与"不扫描"锁定、端到端。
 * 软链相关断言在无法创建链接的平台(Windows 无开发者模式)自动跳过。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../../src/build-tool/package-service/build/install-method-check") as typeof import("../../src/build-tool/package-service/build/install-method-check");

type Facts = import("../../src/build-tool/package-service/build/install-method-check").InstallMethodFacts;

/** 造事实(未指定字段按"查不到"给默认) */
function facts(over: Partial<Facts> & { package: string }): Facts {
    return { landing: "missing", ...over };
}

const created: string[] = [];
function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rde-mode-"));
    created.push(root);
    return root;
}
after(() => {
    for (const d of created) {
        fs.rmSync(d, { recursive: true, force: true });
    }
});

/** 建文件软链;建不成(权限不足等)返回 false 供跳过 */
function tryLinkFile(target: string, linkPath: string): boolean {
    try {
        fs.symlinkSync(target, linkPath, "file");
        return fs.lstatSync(linkPath).isSymbolicLink();
    } catch {
        return false;
    }
}

function writeCache(root: string, pkg: string, value: string | null): void {
    const dir = path.join(root, "build", pkg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, "CMakeCache.txt"),
        value === null ? "# 无相关行\nFOO:BOOL=1\n" : `// using symlinks instead of copying resources\nAMENT_CMAKE_SYMLINK_INSTALL:BOOL=${value}\n`,
    );
}

/** 造 install 侧探针:<prefix>/share/ament_index/resource_index/packages/<pkg> */
function writeMarker(
    root: string,
    pkg: string,
    layout: "isolated" | "merged",
    kind: "link" | "file",
    options?: { linkTargetExists?: boolean },
): boolean {
    const prefix = layout === "merged" ? path.join(root, "install") : path.join(root, "install", pkg);
    const marker = path.join(prefix, "share", "ament_index", "resource_index", "packages", pkg);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    if (kind === "file") {
        fs.writeFileSync(marker, "");
        return true;
    }
    const target = path.join(root, "build", pkg, "ament_cmake_index", "share", "ament_index", "resource_index", "packages", pkg);
    if (options?.linkTargetExists) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "");
    }
    return tryLinkFile(target, marker);
}

// ─────────────────────────────────────────────────────────────
describe("install-method-check:查表(纯函数)", () => {
    it("格1/格3:本次符号 + 落点链接/缺失 → 不冲突、不清缓存", () => {
        for (const landing of ["link", "missing"] as const) {
            const d = mod.decideInstallMethod([facts({ package: "p", landing, configured: "symlink" })], "symlink");
            assert.deepStrictEqual(d.conflicts, []);
            assert.deepStrictEqual(d.silentNoop, []);
            assert.strictEqual(d.cleanCache, false);
        }
    });

    it("格2/格5:本次实体 + 配置=实体 + 落点实体目录 + 探针=实体 → 无任何提示", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", landing: "directory", configured: "copy", payload: "copy" })], "copy");
        assert.deepStrictEqual(d.conflicts, []);
        assert.deepStrictEqual(d.silentNoop, []);
        assert.strictEqual(d.cleanCache, false);
    });

    it("格6(硬冲突):本次符号 + 落点实体目录 → conflicts(退出码 2)+ 需清缓存", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p10_mix_deps_std", landing: "directory", configured: "copy" })], "symlink");
        assert.deepStrictEqual(d.conflicts, ["p10_mix_deps_std"]);
        assert.strictEqual(d.cleanCache, true);
    });

    it("重复失败:配置已是符号 + 落点仍是实体目录 → 仍报硬冲突(无需清缓存)", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", landing: "directory", configured: "symlink" })], "symlink");
        assert.deepStrictEqual(d.conflicts, ["p"]);
        assert.strictEqual(d.cleanCache, false);
    });

    it("格4(静默无效):本次实体 + 探针=软链 → silentNoop + 需清缓存", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", payload: "symlink", configured: "symlink" })], "copy");
        assert.deepStrictEqual(d.silentNoop, ["p"]);
        assert.strictEqual(d.cleanCache, true);
    });

    it("22:50 真实情形:配置=实体(已清过缓存)但探针=软链 → 仍报静默无效,且无需清缓存", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", landing: "link", payload: "symlink", configured: "copy" })], "copy");
        assert.deepStrictEqual(d.silentNoop, ["p"]);
        assert.strictEqual(d.cleanCache, false);
    });

    it("⚠️ 时序错位(cache 说实体、install 仍符号):落点是实体目录 + 探针=软链 → 必须报静默无效", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", landing: "directory", payload: "symlink", configured: "copy" })], "copy");
        assert.deepStrictEqual(d.silentNoop, ["p"], "cache 不代表 install 现状");
        assert.strictEqual(d.cleanCache, false);
    });

    it("实体方向以 install 现状为准:配置=符号但探针=实体 → 不误报(只需清缓存换向)", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", landing: "link", payload: "copy", configured: "symlink" })], "copy");
        assert.deepStrictEqual(d.silentNoop, []);
        assert.strictEqual(d.cleanCache, true);
    });

    it("不猜:探针 unknown(纯 CMake 包 / 未注册 / install 未构建)→ 放行", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", landing: "directory", payload: "unknown", configured: "copy" })], "copy");
        assert.deepStrictEqual(d.silentNoop, []);
        assert.strictEqual(d.cleanCache, false);
    });

    it("边界B1(build 被删 / install 还在):探针=软链 + 本次实体 → 静默无效", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", landing: "missing", payload: "symlink" })], "copy");
        assert.deepStrictEqual(d.silentNoop, ["p"]);
        assert.strictEqual(d.cleanCache, false);
    });

    it("边界B2(情况6 可自动修正):探针=实体 + 本次符号 → 放行", () => {
        const d = mod.decideInstallMethod(
            [facts({ package: "p", landing: "missing", payload: "copy" })], "symlink");
        assert.deepStrictEqual(d.conflicts, []);
        assert.deepStrictEqual(d.silentNoop, []);
        assert.strictEqual(d.cleanCache, false);
    });

    it("无 cache / 无该行(非 ament 包)→ 任意类型通过", () => {
        assert.strictEqual(mod.decideInstallMethod([facts({ package: "p" })], "symlink").cleanCache, false);
        assert.deepStrictEqual(mod.decideInstallMethod([facts({ package: "p" })], "copy").silentNoop, []);
    });

    it("多包聚合:冲突与静默无效各自成组", () => {
        const d = mod.decideInstallMethod([
            facts({ package: "a", landing: "directory" }),
            facts({ package: "b", payload: "symlink" }),
            facts({ package: "c", landing: "missing" }),
        ], "symlink");
        assert.deepStrictEqual(d.conflicts, ["a"]);
        assert.deepStrictEqual(d.silentNoop, []);
    });
});

describe("install-method-check:文案(必须给出可执行的修正指引)", () => {
    it("硬冲突:含退出码 2 + 先删 build/<包名> + 改设置两条路", () => {
        const msg = mod.buildInstallMethodWarning({ cleanCache: false, conflicts: ["p10"], silentNoop: [] }, "symlink");
        assert.ok(msg);
        assert.ok(msg!.includes("will fail"));
        assert.ok(msg!.includes("exit code 2"));
        assert.ok(msg!.includes("build/<package>"));
        assert.ok(msg!.includes("ROS2.build.installMethod"));
    });

    it("静默无效:含「不阻止构建」+ Up-to-date 原因 + 只删 install/<包名> 的指引", () => {
        const msg = mod.buildInstallMethodWarning({ cleanCache: false, conflicts: [], silentNoop: ["p10"] }, "copy");
        assert.ok(msg);
        assert.ok(msg!.includes("will not take effect"));
        assert.ok(msg!.includes("build not blocked"));
        assert.ok(msg!.includes("Up-to-date"));
        assert.ok(msg!.includes("install/<package>"));
        assert.ok(msg!.includes("build/ need not be deleted"));
    });

    it("自动清缓存写在提示尾部;无事 → null", () => {
        const msg = mod.buildInstallMethodWarning({ cleanCache: true, conflicts: ["p"], silentNoop: [] }, "symlink");
        assert.ok(msg!.includes("--cmake-clean-cache"));
        assert.strictEqual(
            mod.buildInstallMethodWarning({ cleanCache: true, conflicts: [], silentNoop: [] }, "copy"), null);
    });
});

describe("install-method-check:磁盘读(配置 / 落点 / 唯一探针)", () => {
    it("配置形态 CMakeCache:ON/1 → symlink;OFF/0 → copy;无该行/无文件 → undefined", async () => {
        const root = makeRoot();
        writeCache(root, "on", "ON");
        writeCache(root, "one", "1");
        writeCache(root, "off", "OFF");
        writeCache(root, "zero", "0");
        writeCache(root, "none", null);
        assert.strictEqual(await mod.readConfiguredMethod(root, "on"), "symlink");
        assert.strictEqual(await mod.readConfiguredMethod(root, "one"), "symlink");
        assert.strictEqual(await mod.readConfiguredMethod(root, "off"), "copy");
        assert.strictEqual(await mod.readConfiguredMethod(root, "zero"), "copy");
        assert.strictEqual(await mod.readConfiguredMethod(root, "none"), undefined);
        assert.strictEqual(await mod.readConfiguredMethod(root, "missing-pkg"), undefined);
    });

    it("落点 lstat:实体目录 → directory;不存在 → missing;软链 → link(建不成链则跳过)", async () => {
        const root = makeRoot();
        fs.mkdirSync(path.join(root, "build", "dirpkg", "ament_cmake_python", "dirpkg", "dirpkg"), { recursive: true });
        assert.strictEqual(await mod.inspectLanding(root, "dirpkg"), "directory");
        assert.strictEqual(await mod.inspectLanding(root, "nopkg"), "missing");

        const src = path.join(root, "src", "linkpkg", "linkpkg");
        fs.mkdirSync(src, { recursive: true });
        const link = path.join(root, "build", "linkpkg", "ament_cmake_python", "linkpkg", "linkpkg");
        fs.mkdirSync(path.dirname(link), { recursive: true });
        if (tryLinkFile(src, link)) {
            assert.strictEqual(await mod.inspectLanding(root, "linkpkg"), "link");
        }
    });

    it("唯一探针:软链 → symlink;常规文件 → copy;缺失 → unknown", async () => {
        const root = makeRoot();
        assert.strictEqual(await mod.inspectInstallPayload(root, "nopkg", "isolated"), "unknown");

        assert.strictEqual(writeMarker(root, "fpkg", "isolated", "file"), true);
        assert.strictEqual(await mod.inspectInstallPayload(root, "fpkg", "isolated"), "copy");

        const linked = writeMarker(root, "lpkg", "isolated", "link", { linkTargetExists: true });
        if (linked) {
            assert.strictEqual(await mod.inspectInstallPayload(root, "lpkg", "isolated"), "symlink");
        }

        // 悬空链(目标不存在,例如 build/ 被删但 install 保留)→ 仍是软链 ⇒ 仍判符号(实测该状态切实体会静默无效)
        const dangling = writeMarker(root, "dpkg", "isolated", "link");
        if (dangling) {
            assert.strictEqual(await mod.inspectInstallPayload(root, "dpkg", "isolated"), "symlink");
        }
    });

    it("merged 布局:探针位于 install/ 根,同样按包名精确判定(不再是盲区)", async () => {
        const root = makeRoot();
        assert.strictEqual(writeMarker(root, "mpkg", "merged", "file"), true);
        assert.strictEqual(await mod.inspectInstallPayload(root, "mpkg", "merged"), "copy");

        const linked = writeMarker(root, "mlink", "merged", "link", { linkTargetExists: true });
        if (linked) {
            assert.strictEqual(await mod.inspectInstallPayload(root, "mlink", "merged"), "symlink");
        }
    });

    it("锁定:探针缺失时**不做任何扫描**(install 树里有指向工作区的软链也判 unknown)", async () => {
        const root = makeRoot();
        const target = path.join(root, "src", "np", "np", "real.py");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "x");
        const dir = path.join(root, "install", "np", "lib", "np");
        fs.mkdirSync(dir, { recursive: true });
        const linked = tryLinkFile(target, path.join(dir, "real.py"));
        assert.strictEqual(await mod.inspectInstallPayload(root, "np", "isolated"), "unknown",
            linked ? "有工作区软链也不扫(假设 install 不被人工局部篡改)" : "无探针 → unknown");
    });

    it("锁定:package_run_dependencies / parent_prefix_path 不参与判定(即使存在 → unknown)", async () => {
        const root = makeRoot();
        for (const r of ["package_run_dependencies", "parent_prefix_path"]) {
            const f = path.join(root, "install", "rp", "share", "ament_index", "resource_index", r, "rp");
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, "x");
        }
        assert.strictEqual(await mod.inspectInstallPayload(root, "rp", "isolated"), "unknown");
    });

    it("installPrefix:isolated = install/<pkg>;merged = install/", () => {
        assert.strictEqual(mod.installPrefix("/ws", "p", "isolated"), path.join("/ws", "install", "p"));
        assert.strictEqual(mod.installPrefix("/ws", "p", "merged"), path.join("/ws", "install"));
    });
});

describe("install-method-check:端到端(checkInstallMethod)", () => {
    it("实体态夹具(配置=OFF + 落点目录)+ 本次符号 → cleanCache=true + 硬冲突提示", async () => {
        const root = makeRoot();
        const pkg = "p10_mix_deps_std";
        writeCache(root, pkg, "OFF");
        fs.mkdirSync(path.join(root, "build", pkg, "ament_cmake_python", pkg, pkg), { recursive: true });
        assert.strictEqual(writeMarker(root, pkg, "isolated", "file"), true);

        const plan = await mod.checkInstallMethod(root, [pkg], { method: "symlink", layout: "isolated" });
        assert.strictEqual(plan.cleanCache, true);
        assert.deepStrictEqual(plan.conflicts, [pkg]);
        assert.strictEqual(plan.warningKind, "conflict", "文案类别供通知层做类别级开关");
        assert.ok(plan.warning && plan.warning.includes("will fail"));
    });

    it("符号态夹具(配置=ON + 探针软链)+ 本次实体 → cleanCache=true + 静默无效提示", async () => {
        const root = makeRoot();
        const pkg = "simpkg";
        writeCache(root, pkg, "ON");
        const linked = writeMarker(root, pkg, "isolated", "link", { linkTargetExists: true });

        const plan = await mod.checkInstallMethod(root, [pkg], { method: "copy", layout: "isolated" });
        assert.strictEqual(plan.cleanCache, true, "配置是符号而本次要实体 → 需清缓存换向");
        if (linked) {
            assert.deepStrictEqual(plan.silentNoop, [pkg]);
            assert.strictEqual(plan.warningKind, "silent-noop");
            assert.ok(plan.warning && plan.warning.includes("will not take effect"));
        } else {
            assert.strictEqual(plan.warning, null, "建不成软链的平台 → 不误报(宁漏不错)");
            assert.strictEqual(plan.warningKind, null);
        }
    });

    it("边界B1 端到端:build 被删(无 cache)+ 探针为悬空软链 + 本次实体 → 提示静默无效", async () => {
        const root = makeRoot();
        const pkg = "gone";
        const linked = writeMarker(root, pkg, "isolated", "link");   // 目标(在 build/)不存在 = 悬空

        const plan = await mod.checkInstallMethod(root, [pkg], { method: "copy", layout: "isolated" });
        assert.strictEqual(plan.cleanCache, false, "无 cache → 不清缓存");
        if (linked) {
            assert.deepStrictEqual(plan.silentNoop, [pkg]);
            assert.ok(plan.warning && plan.warning.includes("will not take effect"));
        } else {
            assert.strictEqual(plan.warning, null);
        }
    });

    it("空工作区/空包列表 → 无提示、不清缓存、不抛", async () => {
        const root = makeRoot();
        const plan = await mod.checkInstallMethod(root, [], { method: "symlink", layout: "isolated" });
        assert.deepStrictEqual(plan, {
            cleanCache: false, conflicts: [], silentNoop: [], warningKind: null, warning: null,
        });
        const plan2 = await mod.checkInstallMethod(root, ["nothing"], { method: "symlink", layout: "isolated" });
        assert.strictEqual(plan2.warning, null);
        assert.strictEqual(plan2.warningKind, null);
        assert.strictEqual(plan2.cleanCache, false);
    });
});
