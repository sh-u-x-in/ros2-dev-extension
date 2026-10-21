/**
 * colcon 构建前检查测试(2026-10-20;无头单跑)
 *
 * 验证:
 *  - PATH 探针:命中/缺失/空 PATH;win32 分号分隔;
 *  - 指引文案含可操作安装命令;
 *  - 任务路径去重警告:30s 窗内至多一次,重置后可再弹。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/colcon-check.test.js --exit
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../../src/build-tool/package-service/build/colcon-check") as {
    findColconOnPath(envPath?: string): string | null;
    colconMissingHint(): string;
    warnColconMissingOnce(): void;
    _resetColconCheckForTest(): void;
};

describe("colcon 构建前检查", () => {
    beforeEach(function () {
        if (!HEADLESS) { this.skip(); }
        mod._resetColconCheckForTest();
    });

    it("PATH 探针:命中返回完整路径,缺失/空返回 null;win32 分号分隔同款", function () {
        if (!HEADLESS) { this.skip(); }
        // unix 冒号例用相对目录:win32 盘符(C:)含冒号,绝对路径没法混进冒号分隔串
        const relDir = ".tmp-colcon-probe";
        fs.mkdirSync(relDir, { recursive: true });
        const relExe = path.join(relDir, "colcon");
        fs.writeFileSync(relExe, "#!/usr/bin/env python3\n");
        const winDir = fs.mkdtempSync(path.join(os.tmpdir(), "colcon-probe-"));
        try {
            const winExe = path.join(winDir, "colcon.exe");
            fs.writeFileSync(winExe, "");
            assert.strictEqual(mod.findColconOnPath(`/usr/bin:${relDir}:/bin`), relExe, "unix 冒号分隔命中(相对目录)");
            assert.strictEqual(mod.findColconOnPath(`C:\\Tools;${winDir}`), winExe, "win32 分号分隔命中");
            assert.strictEqual(mod.findColconOnPath("/usr/bin:/bin"), null, "缺失返回 null");
            assert.strictEqual(mod.findColconOnPath(""), null, "空 PATH 返回 null");
            assert.strictEqual(mod.findColconOnPath(undefined), null, "未定义返回 null");
        } finally {
            fs.rmSync(relDir, { recursive: true, force: true });
            fs.rmSync(winDir, { recursive: true, force: true });
        }
    });

    it("指引文案含可操作安装命令(python3-colcon-common-extensions)", function () {
        if (!HEADLESS) { this.skip(); }
        const hint = mod.colconMissingHint();
        assert.ok(hint.includes("colcon was not found"), "en 源串=键");
        assert.ok(hint.includes("sudo apt install python3-colcon-common-extensions"), "含安装命令");
    });

    it("任务路径警告 30s 去重:连续两次至多一弹,重置后可再弹", async function () {
        if (!HEADLESS) { this.skip(); }
        // 经 vscode 桩拦截 showWarningMessage 计数(桩返回 undefined 不弹真窗)
        const calls: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require("vscode");
        const orig = vscode.window.showWarningMessage;
        vscode.window.showWarningMessage = (msg: string) => { calls.push(msg); return Promise.resolve(undefined); };
        try {
            mod.warnColconMissingOnce();
            mod.warnColconMissingOnce();
            mod.warnColconMissingOnce();
            assert.strictEqual(calls.length, 1, "30s 去重窗内至多一弹");
            assert.ok(calls[0].includes("python3-colcon-common-extensions"), "弹的是指引文案");
            mod._resetColconCheckForTest();
            mod.warnColconMissingOnce();
            assert.strictEqual(calls.length, 2, "重置后可再弹");
        } finally {
            vscode.window.showWarningMessage = orig;
        }
    });
});
