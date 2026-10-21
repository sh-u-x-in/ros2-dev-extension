// Licensed under the MIT License.

/**
 * @file exclude-postfilter.test.ts(2026-10-18 后剪枝批新增)
 * 用户 excludeFolders **后剪枝**纯函数的无头单测:
 *  ① path-exclude 新 normalize 出口(resolveExcludeFoldersNormalized / isPathExcludedNormalized,
 *     win32 大小写折叠,镜像 test-provider 私有先例的公共收编);
 *  ② rosmsg 事件/增量面双判(isExcludedMsgSource = 内置名段 ∪ 用户路径);
 *  ③ xacro watcher 增量门(isExcludedXacroSource,含附带瑕疵修复的行为钉:build/ 段命中)。
 *
 * 纯函数,零 vscode 依赖,双宿主真跑。
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/exclude-postfilter.test.js
 */

import * as assert from 'assert';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub';

// 被测链顶层拉 vscode(l10n/Configuration)→ 无头先装 stub 再 require
installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isPathExcludedNormalized, resolveExcludeFoldersNormalized } = require('../../src/build-tool/walk/base/path-exclude') as typeof import('../../src/build-tool/walk/base/path-exclude');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isExcludedMsgSource } = require('../../src/languages/rosmsg/data/workspace-index') as { isExcludedMsgSource(p: string, ex: string[]): boolean };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isExcludedXacroSource } = require('../../src/languages/xacro/core/xacro-watcher') as { isExcludedXacroSource(p: string, ex: string[]): boolean };

const WIN = process.platform === 'win32';

describe('path-exclude normalize 出口(解析 + 比对,win32 折叠)', () => {
    const wsRoot = WIN ? 'D:/workspaces/demo_ws' : '/workspaces/demo_ws';

    it('解析:${workspaceFolder} 替换 / 相对路径按根 / 绝对路径原样', () => {
        const r = resolveExcludeFoldersNormalized(wsRoot, [
            '${workspaceFolder}/third',
            'vendor',
            WIN ? 'D:/abs/elsewhere' : '/abs/elsewhere',
        ]);
        assert.strictEqual(r.length, 3);
        assert.strictEqual(r[0], path.normalize(WIN ? 'd:/workspaces/demo_ws/third' : '/workspaces/demo_ws/third'), '${workspaceFolder} 替换');
        assert.ok(r[1].toLowerCase().endsWith('vendor'), '相对路径按根解析');
        assert.ok(r[2].toLowerCase().endsWith('elsewhere'), '绝对路径原样');
    });

    it('比对:目录边界(含等于),win32 大小写折叠', () => {
        const excluded = resolveExcludeFoldersNormalized(wsRoot, ['third']);
        const under = WIN ? 'd:/workspaces/demo_ws/third/pkg/a.msg' : '/workspaces/demo_ws/third/pkg/a.msg';
        const equal = WIN ? 'D:/WORKSPACES/demo_ws/THIRD' : '/workspaces/demo_ws/third';
        const outside = WIN ? 'd:/workspaces/demo_ws/thirdparty/a.msg' : '/workspaces/demo_ws/thirdparty/a.msg';
        assert.strictEqual(isPathExcludedNormalized(under, excluded), true, '目录内命中');
        assert.strictEqual(isPathExcludedNormalized(equal, excluded), true, '等于排除目录本身也命中');
        assert.strictEqual(isPathExcludedNormalized(outside, excluded), false, 'thirdparty 是不同目录,前缀不得误伤');
    });
});

describe('rosmsg isExcludedMsgSource(事件/增量面双判)', () => {
    const userExcluded = resolveExcludeFoldersNormalized(
        WIN ? 'D:/ws' : '/ws',
        ['myvendor'],
    );

    it('内置目录名段命中(前剪枝口径,任意层级)', () => {
        const base = WIN ? 'd:/ws' : '/ws';
        assert.strictEqual(isExcludedMsgSource(base + '/build/x/a.msg', userExcluded), true);
        assert.strictEqual(isExcludedMsgSource(base + '/src/sub/install/deep/b.msg', userExcluded), true);
    });

    it('用户路径命中(后剪枝,目录边界)', () => {
        const base = WIN ? 'd:/ws' : '/ws';
        assert.strictEqual(isExcludedMsgSource(base + '/myvendor/pkg/a.msg', userExcluded), true);
        assert.strictEqual(isExcludedMsgSource(base + '/src/keep/a.msg', userExcluded), false);
    });

    it('win32 折叠:用户填大写、事件路径大小写不同仍命中', () => {
        const base = WIN ? 'd:/ws' : '/ws';
        const p = WIN ? 'D:/WS/MyVendor/pkg/a.msg' : base + '/MyVendor/pkg/a.msg';
        if (WIN) {
            assert.strictEqual(isExcludedMsgSource(p, userExcluded), true);
        } else {
            // POSIX 大小写敏感:不同写法即不同路径(语义钉)
            assert.strictEqual(isExcludedMsgSource(p, userExcluded), false);
        }
    });
});

describe('xacro isExcludedXacroSource(watcher 增量门,含附带瑕疵修复钉)', () => {
    const userExcluded = resolveExcludeFoldersNormalized(
        WIN ? 'D:/ws' : '/ws',
        ['myvendor'],
    );

    it('内置目录名段命中——build/install 里新增的 .xacro 不再入图(附带瑕疵修复的行为钉)', () => {
        const base = WIN ? 'd:/ws' : '/ws';
        assert.strictEqual(isExcludedXacroSource(base + '/build/pkg/gen/a.xacro', userExcluded), true);
        assert.strictEqual(isExcludedXacroSource(base + '/install/pkg/share/b.urdf', userExcluded), true);
    });

    it('用户路径命中;正常源码路径不命中', () => {
        const base = WIN ? 'd:/ws' : '/ws';
        assert.strictEqual(isExcludedXacroSource(base + '/myvendor/desc/c.xacro', userExcluded), true);
        assert.strictEqual(isExcludedXacroSource(base + '/src/desc/c.xacro', userExcluded), false);
    });
});
