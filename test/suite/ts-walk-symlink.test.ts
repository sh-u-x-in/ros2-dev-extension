// Licensed under the MIT License.

/**
 * @file ts-walk-symlink.test.ts(2026-10-18 平铺批 rider-1 新增)
 * 纯 TS 降级路径符号链接遍历的回归钉:修复前 ts-walk 先判 isDirectory(链接恒 false)再判
 * symlink ⇒ followSymlinks=true 也永远不跟随;修复后顺序反转,真值表:
 *   链接 + follow=false → 不进;链接 + follow=true → 进(链接指向文件时 readdir ENOTDIR 静默跳过);
 *   目录名排除对链接同样生效(名字在排除集内,即使可跟随也不进)。
 *
 * win32 建目录链接需开发者模式/管理员权限:创建失败即用例守卫跳过(环境不具备,非逻辑失败)。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/ts-walk-symlink.test.js
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub';

installVscodeStub();

// ts-walk import vscode(l10n)→ 无头先装 stub 再 require;直连纯 TS 实现(不走 walk-utils 的 native 优先)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { walkWithTimeout } = require('../../src/build-tool/walk/base/ts-walk') as {
    walkWithTimeout(root: string, pattern: RegExp | string, options: {
        branchTimeoutMs: number; totalTimeoutMs: number; maxDepth: number;
        excludedDirNames?: ReadonlySet<string>; followSymlinks?: boolean;
    }): Promise<{ matches: string[]; timedOut: boolean }>;
};

describe('ts-walk 符号链接(rider-1:判定顺序修复回归钉)', () => {
    let tmpRoot: string;
    let outside: string;
    let linkPath: string;
    let canSymlink = true;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-walk-link-'));
        outside = path.join(tmpRoot, 'outside');
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(outside, 'target-marker.xml'), '<x/>');
        linkPath = path.join(tmpRoot, 'link');
        try {
            fs.symlinkSync(outside, linkPath, 'dir');
        } catch {
            canSymlink = false; // win32 无开发者模式/权限:环境不具备,跳过
        }
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function run(followSymlinks: boolean, excluded?: ReadonlySet<string>) {
        return walkWithTimeout(tmpRoot, /target-marker\.xml$/, {
            totalTimeoutMs: 5000,
            branchTimeoutMs: 1000,
            maxDepth: 8,
            followSymlinks,
            excludedDirNames: excluded,
        });
    }

    it('follow=true → 穿越链接,命中链接内侧文件', async function () {
        if (!canSymlink) { this.skip(); }
        const r = await run(true);
        assert.ok(r.matches.some((m) => m.includes(`${path.sep}link${path.sep}`)), '经链接命中: ' + JSON.stringify(r.matches));
    });

    it('follow=false → 不穿越链接,零命中', async function () {
        if (!canSymlink) { this.skip(); }
        const r = await run(false);
        assert.deepStrictEqual(r.matches, []);
    });

    it('follow=true 但链接名在排除集 → 不进(目录名排除对链接同样生效)', async function () {
        if (!canSymlink) { this.skip(); }
        const r = await run(true, new Set(['link']));
        assert.deepStrictEqual(r.matches, []);
    });
});
