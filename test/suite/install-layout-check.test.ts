/**
 * install-layout-check 单测(2026-09-22 新增,布局检查非阻塞警告)。
 *
 * 无头可跑(npx mocha out/test/suite/install-layout-check.test.js):
 * 先装 vscode stub 再 require 被测模块(模块顶层 import vscode 仅用于 showWarningMessage)。
 *
 * 覆盖:标记读取(缺失 / 非法 / 两种合法值 / 换行与大小写)、文案纯函数(一致或未知 → null;
 * 双向不一致 → 含两侧布局名、--merge-install、"不阻止构建"与两条处理建议)、checkInstallLayout 组装。
 * 不覆盖 warnInstallLayoutMismatch 的弹窗动作(stub 不提供 window.showWarningMessage;该函数只剩
 * "读标记 + 弹窗"3 行胶水),由集成宿主侧人工验证。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { installVscodeStub } from "./_vscode-stub";

installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../../src/build-tool/package-service/build/install-layout-check") as typeof import("../../src/build-tool/package-service/build/install-layout-check");

/** 建临时工作区并(可选)落布局标记 */
function makeWorkspace(marker?: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rde-layout-check-"));
    if (marker !== undefined) {
        fs.mkdirSync(path.join(root, "install"), { recursive: true });
        fs.writeFileSync(path.join(root, "install", ".colcon_install_layout"), marker);
    }
    return root;
}

describe("install-layout-check:布局标记读取", () => {
    const created: string[] = [];
    const ws = (marker?: string): string => {
        const d = makeWorkspace(marker);
        created.push(d);
        return d;
    };
    after(() => {
        for (const d of created) {
            fs.rmSync(d, { recursive: true, force: true });
        }
    });

    it("isolated / merged 原样读出(容忍换行与大小写,实测落盘形如 \"isolated\\n\")", async () => {
        assert.strictEqual(await mod.readInstallLayoutMarker(ws("isolated\n")), "isolated");
        assert.strictEqual(await mod.readInstallLayoutMarker(ws("merged\n")), "merged");
        assert.strictEqual(await mod.readInstallLayoutMarker(ws("Merged\n")), "merged");
    });

    it("install/ 不存在(首次构建前)→ undefined(视为未知,不告警)", async () => {
        assert.strictEqual(await mod.readInstallLayoutMarker(ws()), undefined);
    });

    it("内容非法 / 空 → undefined(不告警)", async () => {
        assert.strictEqual(await mod.readInstallLayoutMarker(ws("???\n")), undefined);
        assert.strictEqual(await mod.readInstallLayoutMarker(ws("")), undefined);
    });
});

describe("install-layout-check:警告文案(纯函数)", () => {
    it("布局一致 / 既有布局未知 → null(不弹窗)", () => {
        assert.strictEqual(mod.buildInstallLayoutWarning("isolated", "isolated"), null);
        assert.strictEqual(mod.buildInstallLayoutWarning("merged", "merged"), null);
        assert.strictEqual(mod.buildInstallLayoutWarning(undefined, "merged"), null);
        assert.strictEqual(mod.buildInstallLayoutWarning(undefined, "isolated"), null);
    });

    it("既有 isolated + 本次 merged:含两侧布局、--merge-install、不阻止构建、两条处理建议", () => {
        const msg = mod.buildInstallLayoutWarning("isolated", "merged");
        assert.ok(msg, "应产出文案");
        assert.ok(msg!.includes("build not blocked"), "必须先声明不阻塞");
        assert.ok(msg!.includes("\"isolated\"") && msg!.includes("\"merged\""), "须点明两侧布局");
        assert.ok(msg!.includes("--merge-install"), "须点明本次会带的参数");
        assert.ok(msg!.includes("Delete install/"), "须给处理建议一");
        assert.ok(msg!.includes("ROS2.build.installLayout"), "须给处理建议二");
    });

    it("既有 merged + 本次 isolated:反向同样成文", () => {
        const msg = mod.buildInstallLayoutWarning("merged", "isolated");
        assert.ok(msg, "应产出文案");
        assert.ok(msg!.includes("\"merged\"") && msg!.includes("\"isolated\""));
        assert.ok(msg!.includes("--merge-install"));
        assert.ok(msg!.includes("Delete install/"));
    });
});

describe("install-layout-check:checkInstallLayout(读取 + 判定组装)", () => {
    const created: string[] = [];
    const ws = (marker?: string): string => {
        const d = makeWorkspace(marker);
        created.push(d);
        return d;
    };
    after(() => {
        for (const d of created) {
            fs.rmSync(d, { recursive: true, force: true });
        }
    });

    it("磁盘 isolated:请求 merged → 有文案;请求 isolated → null;无标记 → null", async () => {
        const isoWs = ws("isolated\n");
        assert.ok(await mod.checkInstallLayout(isoWs, "merged"), "不一致应产出文案");
        assert.strictEqual(await mod.checkInstallLayout(isoWs, "isolated"), null, "一致不应告警");
        assert.strictEqual(await mod.checkInstallLayout(ws(), "merged"), null, "无标记不应告警");
    });
});
