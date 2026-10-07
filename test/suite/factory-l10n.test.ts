// Licensed under the MIT License.

/**
 * @file factory-l10n.test.ts
 * shareSpec 出厂文案**显示本地化门卫**(factoryText)的无头单测(2026-10-07 方案A+C)。
 *
 * 覆盖:① 值相等门卫——用户自定义值/近似值一律原样透传(接缝撞库缺陷的回归锁定:
 *      模拟 zh 册后,用户值撞上册内其他键也不得被翻译);② 出厂值命中——5 条出厂常量
 *      (3 custom + 2 preset describe)全部走 `factory.*` ID 键查表;③ 英文兜底——
 *      查册返回键名本身(en 环境/无头 stub)时回落出厂英文常量(测试断言口径=英文源串)。
 *
 * 运行方式:
 *   npm run test-compile && npx mocha out/test/suite/factory-l10n.test.js
 */

import * as assert from 'assert';
import { COLCON_BUILD_PRESETS, COLCON_BUILD_SPEC } from '../../src/build-tool/package-service/share/defaults/colcon-build';
import { ROS2_LAUNCH_SPEC } from '../../src/build-tool/package-service/share/defaults/ros2-launch';
import { ROS2_RUN_SPEC } from '../../src/build-tool/package-service/share/defaults/ros2-run';
import { installVscodeStub } from './_vscode-stub';

installVscodeStub();

// factory-l10n import vscode(查 l10n.t)→ 无头环境先装 stub 再 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode') as typeof import('vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { factoryText } = require('../../src/build-tool/package-service/share/factory-l10n') as typeof import('../../src/build-tool/package-service/share/factory-l10n');

/** 全部 5 条出厂常量(与 factory-l10n.ts 的 FACTORY_ENTRIES 同源;漏一条即测试红) */
const FACTORY_VALUES = [
    COLCON_BUILD_SPEC.custom,
    COLCON_BUILD_PRESETS[0].describe,
    COLCON_BUILD_PRESETS[1].describe,
    ROS2_LAUNCH_SPEC.custom,
    ROS2_RUN_SPEC.custom,
];

describe('factoryText 值相等门卫(用户值永不进查册)', () => {
    it('用户自定义值原样透传', () => {
        assert.strictEqual(factoryText('my --ros-args -r x:=1'), 'my --ros-args -r x:=1');
        assert.strictEqual(factoryText(''), '');
    });
    it('近似值(出厂原文加一空格)也透传——逐字节相等才命中', () => {
        assert.strictEqual(factoryText(ROS2_RUN_SPEC.custom + ' '), ROS2_RUN_SPEC.custom + ' ');
        assert.strictEqual(factoryText(ROS2_RUN_SPEC.custom.toUpperCase()), ROS2_RUN_SPEC.custom.toUpperCase());
    });
});

describe('factoryText 出厂值命中(5 条常量全走 ID 键)', () => {
    it('英文兜底环境(en 宿主/无头 stub 查册返回键名)回落出厂英文常量', () => {
        for (const value of FACTORY_VALUES) {
            assert.strictEqual(factoryText(value), value);
        }
    });
});

/**
 * 宿主跳过守卫:_vscode-stub 在真实 VS Code 宿主里【故意不劫持】(见 _vscode-stub.ts 头注),
 * 模拟 zh 册要临时改写 l10n.t——仅无头(npx mocha)运行,宿主里跳过。
 */
describe('factoryText 模拟 zh 册(接缝撞库回归)', function () {
    before(function (this: Mocha.Context) {
        const g = global as unknown as { __vscodeStubInstalled?: boolean };
        if (!g.__vscodeStubInstalled) {
            this.skip();
        }
    });

    /** 模拟 zh 册:键名 → 中文;特别注意 `Copied` 是册内真实存在的无关键(缺陷重现样本) */
    const simulatedZh: Record<string, string> = {
        'Copied': '已复制',
        'factory.run.custom': '运行参数:传给可执行文件的参数(允许多段与引号;空回车 = 不带参数)',
    };
    let originalT: (message: string, ...args: unknown[]) => string;

    beforeEach(() => {
        originalT = vscode.l10n.t;
        (vscode.l10n as { t: typeof originalT }).t = (message: string): string => simulatedZh[message] ?? message;
    });
    afterEach(() => {
        (vscode.l10n as { t: typeof originalT }).t = originalT;
    });

    it('出厂值经 ID 键查表得中文', () => {
        assert.strictEqual(factoryText(ROS2_RUN_SPEC.custom), simulatedZh['factory.run.custom']);
    });
    it('用户值撞上册内其他键(如 Copied)不得被翻译——接缝撞库缺陷回归', () => {
        assert.strictEqual(factoryText('Copied'), 'Copied');
    });
});
