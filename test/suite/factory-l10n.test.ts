// Licensed under the MIT License.

/**
 * @file factory-l10n.test.ts
 * 模板机制出厂文案**显示本地化门卫**(factoryText/presetLabel)的无头单测(2026-10-07 方案A+C;
 * 2026-10-18 查表区收缩;**2026-10-20 用户裁定澄清:出厂槽位描述回归查表,照抄 0 号描述原样**)。
 *
 * 覆盖:① 值相等门卫——用户自定义值/近似值一律原样透传(接缝撞库缺陷的回归锁定:
 *      模拟 zh 册后,用户值撞上册内其他键也不得被翻译);② 出厂值命中——8 条出厂常量
 *      (3 custom + 3 customHint + 2 build 槽位描述)全部走 `factory.*` ID 键查表;③ 英文兜底——查册返回
 *      键名本身(en 环境/无头 stub)时回落出厂英文常量;④ **presetLabel 裁定澄清钉**——出厂槽位
 *      描述查册译文,"照抄 0 号描述"形态原样(套用 0 号翻译正是当年混淆源),用户自定义原样。
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
const { factoryText, presetLabel } = require('../../src/build-tool/package-service/share/factory-l10n') as typeof import('../../src/build-tool/package-service/share/factory-l10n');

/** 全部 8 条出厂常量(与 factory-l10n.ts 的 FACTORY_ENTRIES 同源;漏一条即测试红) */
const FACTORY_VALUES = [
    COLCON_BUILD_SPEC.custom,
    COLCON_BUILD_SPEC.customHint,
    COLCON_BUILD_PRESETS[0].describe,
    COLCON_BUILD_PRESETS[1].describe,
    ROS2_LAUNCH_SPEC.custom,
    ROS2_LAUNCH_SPEC.customHint,
    ROS2_RUN_SPEC.custom,
    ROS2_RUN_SPEC.customHint,
];

describe('factoryText 值相等门卫(用户值永不进查册)', () => {
    it('用户自定义值原样透传', () => {
        assert.strictEqual(factoryText('my --ros-args -r x:=1'), 'my --ros-args -r x:=1');
        assert.strictEqual(factoryText(''), '');
    });
    it('近似值(出厂原文加一空格)也透传——逐字节相等才命中', () => {
        assert.strictEqual(factoryText(ROS2_RUN_SPEC.custom + ' '), ROS2_RUN_SPEC.custom + ' ');
        assert.strictEqual(factoryText(ROS2_RUN_SPEC.customHint + ' '), ROS2_RUN_SPEC.customHint + ' ');
    });
});

describe('factoryText 出厂值命中(8 条常量全走 ID 键)', () => {
    it('英文兜底环境(en 宿主/无头 stub 查册返回键名)回落出厂英文常量', () => {
        for (const value of FACTORY_VALUES) {
            assert.strictEqual(factoryText(value), value);
        }
    });
});

describe('presetLabel 条目级严格判定(2026-10-21 用户裁定:同槽位+argv+describe 逐字段相等才算出厂)', () => {
    const f = COLCON_BUILD_SPEC;
    const c1 = { slot: 1, argv: COLCON_BUILD_PRESETS[0].argv, describe: COLCON_BUILD_PRESETS[0].describe };
    const c2 = { slot: 2, argv: COLCON_BUILD_PRESETS[1].argv, describe: COLCON_BUILD_PRESETS[1].describe };

    it('en 兜底环境:出厂条目回落原文(显示=存储)', () => {
        assert.strictEqual(presetLabel(c1, f), COLCON_BUILD_PRESETS[0].describe);
        assert.strictEqual(presetLabel(c2, f), COLCON_BUILD_PRESETS[1].describe);
    });
    it('factory 缺省 → 原样;用户自定义描述原样透传', () => {
        assert.strictEqual(presetLabel(c1, undefined), c1.describe);
        assert.strictEqual(presetLabel({ slot: 1, argv: 'x', describe: 'my own preset label' }, f), 'my own preset label');
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
        'factory.run.customHint': '例:--ros-args -r __node:=demo(空输入 = 不带参数)',
        'factory.build.presetDebugLog': '详细输出 1/2:打开 debug 日志',
        'factory.build.presetConsoleCohesion': '详细输出 2/2:合并显示事件输出',
    };
    let originalT: (message: string, ...args: unknown[]) => string;

    beforeEach(() => {
        originalT = vscode.l10n.t;
        (vscode.l10n as { t: typeof originalT }).t = (message: string): string => simulatedZh[message] ?? message;
    });
    afterEach(() => {
        (vscode.l10n as { t: typeof originalT }).t = originalT;
    });

    it('0 号键(描述)出厂值经 ID 键查表得中文', () => {
        assert.strictEqual(factoryText(ROS2_RUN_SPEC.custom), simulatedZh['factory.run.custom']);
    });
    it('0 号值(占位提示)出厂值经 ID 键查表得中文', () => {
        assert.strictEqual(factoryText(ROS2_RUN_SPEC.customHint), simulatedZh['factory.run.customHint']);
    });
    it('用户值撞上册内其他键(如 Copied)不得被翻译——接缝撞库缺陷回归', () => {
        assert.strictEqual(factoryText('Copied'), 'Copied');
    });
    it('出厂条目(同槽位+argv+describe 逐字段相等)经 presetLabel 查册得中文', () => {
        assert.strictEqual(
            presetLabel({ slot: 1, argv: COLCON_BUILD_PRESETS[0].argv, describe: COLCON_BUILD_PRESETS[0].describe }, COLCON_BUILD_SPEC),
            '详细输出 1/2:打开 debug 日志'
        );
        assert.strictEqual(
            presetLabel({ slot: 2, argv: COLCON_BUILD_PRESETS[1].argv, describe: COLCON_BUILD_PRESETS[1].describe }, COLCON_BUILD_SPEC),
            '详细输出 2/2:合并显示事件输出'
        );
    });
    it('只改 Value(argv)→ 原文(0.0.4 测试"Ldebug 仍显中文"案的行为钉)', () => {
        assert.strictEqual(
            presetLabel({ slot: 1, argv: '--log-level Ldebug', describe: COLCON_BUILD_PRESETS[0].describe }, COLCON_BUILD_SPEC),
            COLCON_BUILD_PRESETS[0].describe
        );
    });
    it('只改 describe → 原文;槽位错放(出厂 2 号内容写 1 号)→ 原文', () => {
        assert.strictEqual(
            presetLabel({ slot: 1, argv: COLCON_BUILD_PRESETS[0].argv, describe: 'my tweaked label' }, COLCON_BUILD_SPEC),
            'my tweaked label'
        );
        assert.strictEqual(
            presetLabel({ slot: 1, argv: COLCON_BUILD_PRESETS[1].argv, describe: COLCON_BUILD_PRESETS[1].describe }, COLCON_BUILD_SPEC),
            COLCON_BUILD_PRESETS[1].describe
        );
    });
    it('组内出厂备选查册中文、同组用户备选原样(逐条目判定)', () => {
        const groupFactory = {
            template: 'tool ${1}',
            custom: '',
            argv_list: [[
                { argv: '--log-level debug', describe: COLCON_BUILD_PRESETS[0].describe },
                { argv: '--log-level trace', describe: 'my trace level' },
            ]],
        };
        assert.strictEqual(
            presetLabel({ slot: 1, argv: '--log-level debug', describe: COLCON_BUILD_PRESETS[0].describe }, groupFactory),
            '详细输出 1/2:打开 debug 日志'
        );
        assert.strictEqual(
            presetLabel({ slot: 1, argv: '--log-level trace', describe: 'my trace level' }, groupFactory),
            'my trace level'
        );
    });
    it('照抄 0 号描述的槽位条目原样(其 argv 对不上任何出厂备选,逐字段判定天然出局)', () => {
        assert.strictEqual(
            presetLabel({ slot: 1, argv: 'whatever', describe: ROS2_RUN_SPEC.custom }, COLCON_BUILD_SPEC),
            ROS2_RUN_SPEC.custom
        );
    });
});
