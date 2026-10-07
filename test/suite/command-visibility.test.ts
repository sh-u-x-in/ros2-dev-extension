// Licensed under the MIT License.

/**
 * @file command-visibility.test.ts
 * 命令面板可见性防回归锁(2026-09-30 修复批)。
 *
 * 背景:第三轮曾把隐藏配置写成顶级贡献点 `contributes.commandPalette`——VS Code 只认
 * `contributes.menus.commandPalette` 菜单,顶级键被【静默忽略】,六条 when:"false"
 * 从未生效(用户在 F5 宿主实测仍可见)。本用例读仓库 package.json 锁死两件事:
 *  ① 六个上下文专属命令必须在 menus.commandPalette 且 when="false";
 *  ② 错误位置(顶级 contributes.commandPalette)不得再出现。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

/** 上下文专属命令(需树项/右键实参,面板直呼必报警告或错误 → 面板隐藏) */
const CONTEXT_ONLY = [
    "ROS2.sidebar.runExecutable",
    "ROS2.sidebar.launchFile",
    "ROS2.sidebar.buildPackage",
    "ROS2.colcon.toggleIgnore",
    "ROS2.colcon.buildPackageRelease",
    "ROS2.colcon.buildPackageDebug",
] as const;

function loadManifest(): {
    contributes: {
        commands: Array<{ command: string }>;
        menus?: Record<string, Array<{ command: string; when?: string }>>;
        commandPalette?: unknown;
    };
} {
    const raw = fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8");
    return JSON.parse(raw);
}

describe("命令面板可见性(manifest 防回归锁)", () => {
    const pkg = loadManifest();
    const menus = pkg.contributes.menus ?? {};
    const paletteMenu = menus.commandPalette ?? [];
    const hiddenBy = new Map<string, string>();
    for (const e of paletteMenu) {
        if (e.when === "false") {
            hiddenBy.set(e.command, e.when);
        }
    }

    it("六个上下文专属命令在 menus.commandPalette 且 when=false(面板隐藏,菜单/树内可用)", () => {
        for (const name of CONTEXT_ONLY) {
            assert.strictEqual(hiddenBy.get(name), "false", `${name} 应以 when:"false" 隐藏出面板`);
        }
    });

    it("错误位置(顶级 contributes.commandPalette)不得回归(VS Code 静默忽略)", () => {
        assert.strictEqual(
            (pkg.contributes as Record<string, unknown>).commandPalette,
            undefined,
            "顶级 contributes.commandPalette 是无效贡献点,改放 menus.commandPalette"
        );
    });

    it("面板可见命令 = 全部贡献命令 − 隐藏集(数量对账)", () => {
        const all = pkg.contributes.commands.map((c) => c.command);
        const visible = all.filter((name) => !hiddenBy.has(name));
        assert.strictEqual(visible.length, all.length - CONTEXT_ONLY.length, "可见数 = 贡献数 − 隐藏数");
        // 隐藏集之外的命令不得被误隐藏
        for (const name of visible) {
            assert.ok(!CONTEXT_ONLY.includes(name as never), `${name} 不应被隐藏`);
        }
    });
});
