// Licensed under the MIT License.

/**
 * @file share-expand.test.ts
 * 可共享「命令参数模板」机制的无头单测(纯逻辑;`pick-preset` 经 `_vscode-stub` 装载,不依赖 VS Code 宿主)。
 *
 * 覆盖:① shell 词法切分与引号;② 占位符语义(`${0}` 可被预设内嵌 / 槽名 `${1}`..`${n}` / 多选填槽 / 未知占位符原样保留);
 *      ③ 归一化半成品设置;④ **两条预设 = 详细输出的两半** + `axesFromArgv` 反解;
 *      ⑤ **命名动态参数清单的表驱动锁定**(5 个;被去掉的必须是"未知占位符");
 *      ⑥ 默认模板与今天 `toConcolBuild` 命令的等价性(四组合逐字节 + 详细输出);
 *      ⑦ 默认模板**没有** `${0}` ⇒ 弹窗不出现「自定义输入」项;⑧ 二级弹窗三态与 Esc 语义。
 *
 * 运行方式:
 *   npm run test-compile && npx mocha out/test/suite/share-expand.test.js
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { expandCommand, flattenArgList, mergeSpec, normalizeSpec, quoteShellArg, splitShellArgs, usesCustomPlaceholder } from '../../src/build-tool/package-service/share/expand';
import { COLCON_BUILD_PRESETS, COLCON_BUILD_SPEC, axesFromArgv, colconBuildDynamics } from '../../src/build-tool/package-service/share/defaults/colcon-build';
import { ROS2_RUN_SPEC } from '../../src/build-tool/package-service/share/defaults/ros2-run';
import { ROS2_LAUNCH_SPEC } from '../../src/build-tool/package-service/share/defaults/ros2-launch';
import type { CommandSpec } from '../../src/build-tool/package-service/share/types';
import { installVscodeStub, vscodeStubWindow } from './_vscode-stub';

installVscodeStub();

// pick-preset import vscode(纯 UI 壳)→ 无头环境先装 stub 再 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pickPreset = require('../../src/build-tool/package-service/share/pick-preset') as typeof import('../../src/build-tool/package-service/share/pick-preset');

/** 简易 spec 构造(测展开语义用;接受只读预设表,内部复制一份) */
function spec(
    template: string,
    argv_list: readonly { argv: string; describe: string }[] = [],
    custom = '自定义',
): CommandSpec {
    return { template, custom, argv_list: argv_list.map(p => ({ argv: p.argv, describe: p.describe })) };
}

const P123 = [
    { argv: '--one', describe: '1' },
    { argv: '--two', describe: '2' },
    { argv: '--three', describe: '3' },
];

const WS = '/tmp/ws';

describe('splitShellArgs(shell 词法切分)', () => {
    it('按空白切分并折叠多余空白', () => {
        assert.deepStrictEqual(splitShellArgs('  a   b\t c \n'), ['a', 'b', 'c']);
    });
    it('双引号内保留空格与引号语义', () => {
        assert.deepStrictEqual(splitShellArgs('--install-base "/tmp/a b"'), ['--install-base', '/tmp/a b']);
    });
    it('单引号同样保留字面量', () => {
        assert.deepStrictEqual(splitShellArgs("--x 'a b' c"), ['--x', 'a b', 'c']);
    });
    it('反斜杠转义空格与引号', () => {
        assert.deepStrictEqual(splitShellArgs('a\\ b "c\\"d"'), ['a b', 'c"d']);
    });
    it('整段多参数自定义输入(--cmake-args -Dfoo=bar)', () => {
        assert.deepStrictEqual(splitShellArgs('--cmake-args -Dfoo=bar'), ['--cmake-args', '-Dfoo=bar']);
    });
    it('未闭合引号按到串尾字面量处理(不抛错)', () => {
        assert.deepStrictEqual(splitShellArgs('a "b c'), ['a', 'b c']);
    });
});

describe('quoteShellArg(调用方拼片段时的引号)', () => {
    it('无特殊字符不加引号', () => {
        assert.strictEqual(quoteShellArg('/tmp/ws'), '/tmp/ws');
    });
    it('含空格 → 加双引号且可被还原为单个实参', () => {
        const quoted = quoteShellArg('/tmp/a b');
        assert.strictEqual(quoted, '"/tmp/a b"');
        assert.deepStrictEqual(splitShellArgs(`--base-paths ${quoted}`), ['--base-paths', '/tmp/a b']);
    });
    it('含双引号 → 反斜杠转义后仍还原', () => {
        const quoted = quoteShellArg('/tmp/a"b');
        assert.deepStrictEqual(splitShellArgs(`--x ${quoted}`), ['--x', '/tmp/a"b']);
    });
});

describe('expandCommand(占位符语义)', () => {
    it('命名动态参数按片段替换,空片段自然消失', () => {
        const r = expandCommand(spec('tool --a ${x} --b ${y}'), { dynamics: { x: '', y: 'V' } });
        assert.deepStrictEqual(r.argv, ['tool', '--a', '--b', 'V']);
        assert.deepStrictEqual(r.unknown, []);
    });

    it('${0} 自定义输入单独使用', () => {
        assert.deepStrictEqual(expandCommand(spec('tool ${0}'), { dynamics: {}, custom: '--verbose --jobs 2' }).argv,
            ['tool', '--verbose', '--jobs', '2']);
    });

    it('${0} 优先在预设内部展开(功能保留:用户加回 ${0} 即可让预设引用手输内容)', () => {
        const s = spec('tool ${1}', [{ argv: '--install-base ${0}', describe: '自定义安装目录' }]);
        assert.deepStrictEqual(expandCommand(s, { dynamics: {}, custom: '/tmp/out', picked: [0] }).argv,
            ['tool', '--install-base', '/tmp/out']);
    });

    it('槽名就是序号本身:${2} ${1} 按槽位填(与书写顺序无关)', () => {
        assert.deepStrictEqual(expandCommand(spec('tool ${2} ${1}', P123), { dynamics: {}, picked: [0, 1] }).argv,
            ['tool', '--two', '--one']);
    });

    it('${n1} / ${n0} / ${n} 都不是槽名 → 命中未知占位符(不被当成第 n 条)', () => {
        const r = expandCommand(spec('tool ${n1} ${n0} ${n}', P123), { dynamics: {} });
        assert.deepStrictEqual(r.argv, ['tool', '${n1}', '${n0}', '${n}']);
        assert.deepStrictEqual(r.unknown, ['n', 'n0', 'n1']);
    });

    it('预设未勾选 → 该槽为空', () => {
        assert.deepStrictEqual(expandCommand(spec('tool ${1} ${2}', P123), { dynamics: {}, picked: [1] }).argv,
            ['tool', '--two']);
    });

    it('多选多条预设 → 各填各的槽(与勾选顺序无关,按槽位号)', () => {
        assert.deepStrictEqual(expandCommand(spec('tool ${1} ${2} ${3}', P123), { dynamics: {}, picked: [2, 0] }).argv,
            ['tool', '--one', '--three']);
    });

    it('两条预设同时勾选 → 两段都填(不校验语义,由 colcon 判定)', () => {
        const s = spec('tool ${1} --mid ${2}', COLCON_BUILD_PRESETS);
        assert.deepStrictEqual(expandCommand(s, { dynamics: {}, picked: [0, 1] }).argv, [
            'tool',
            '--log-level', 'debug',
            '--mid',
            'log_command+',
        ]);
    });

    it('预设内也可引用命名动态参数', () => {
        const s = spec('tool ${1}', [{ argv: '--packages-select ${packages_select}', describe: 'x' }]);
        assert.deepStrictEqual(expandCommand(s, { dynamics: { packages_select: 'a b' }, picked: [0] }).argv,
            ['tool', '--packages-select', 'a', 'b']);
    });

    it('预设内不解析槽位(避免预设套预设)', () => {
        const s = spec('tool ${1}', [{ argv: '--x ${2}', describe: 'x' }, { argv: '--y', describe: 'y' }]);
        const r = expandCommand(s, { dynamics: {}, picked: [0] });
        assert.deepStrictEqual(r.argv, ['tool', '--x', '${2}']);
        assert.deepStrictEqual(r.unknown, ['2']);
    });

    it('越界的槽位展开为空(设计稿 §4)', () => {
        assert.deepStrictEqual(expandCommand(spec('tool ${1} ${5}'), { dynamics: {}, picked: [0] }).argv, ['tool']);
    });

    it('未知占位符原样保留并记入 unknown(不静默吞掉)', () => {
        const r = expandCommand(spec('tool ${nope} --x'), { dynamics: {} });
        assert.deepStrictEqual(r.argv, ['tool', '${nope}', '--x']);
        assert.deepStrictEqual(r.unknown, ['nope']);
    });

    it('替换进去的文本不会被二次扫描(单遍替换)', () => {
        assert.deepStrictEqual(expandCommand(spec('tool ${a}'), { dynamics: { a: '${b}', b: 'X' } }).argv,
            ['tool', '${b}']);
    });

    it('同槽位重复出现 → 两处都填', () => {
        assert.deepStrictEqual(expandCommand(spec('tool ${1} --mid ${1}', P123), { dynamics: {}, picked: [0] }).argv,
            ['tool', '--one', '--mid', '--one']);
    });

    it('展开结果为空 → empty: true(调用方应拒绝执行)', () => {
        const r = expandCommand(spec('${0} ${1}'), { dynamics: {}, custom: '   ' });
        assert.strictEqual(r.empty, true);
        assert.deepStrictEqual(r.argv, []);
    });

    it('带空格的动态参数片段(已由调用方引号包裹)保持单实参', () => {
        assert.deepStrictEqual(expandCommand(spec('tool --base-paths ${base_path}'), { dynamics: { base_path: quoteShellArg('/tmp/a b') } }).argv,
            ['tool', '--base-paths', '/tmp/a b']);
    });
});

describe('normalizeSpec / mergeSpec(半成品设置与出厂默认的合并)', () => {
    it('normalizeSpec:缺字段补空、非法 argv_list 项被过滤', () => {
        assert.deepStrictEqual(normalizeSpec({ template: 'tool' } as Partial<CommandSpec>), { template: 'tool', custom: '', argv_list: [] });
    });
    it('normalizeSpec:undefined/null 也不抛错', () => {
        assert.deepStrictEqual(normalizeSpec(undefined), { template: '', custom: '', argv_list: [] });
        assert.deepStrictEqual(normalizeSpec(null), { template: '', custom: '', argv_list: [] });
    });
    it('mergeSpec:设置项缺失 → 整份出厂默认(且是副本,改不动默认)', () => {
        const merged = mergeSpec(undefined, COLCON_BUILD_SPEC);
        assert.strictEqual(merged.template, COLCON_BUILD_SPEC.template);
        assert.deepStrictEqual(merged.argv_list, COLCON_BUILD_SPEC.argv_list);
        (merged.argv_list[0] as { argv: string }).argv = 'MUTATED';
        assert.notStrictEqual((COLCON_BUILD_SPEC.argv_list[0] as { argv: string }).argv, 'MUTATED', '不得改到出厂默认对象');
    });
    it('mergeSpec:按"字段是否给出"合并 —— 未给的回落默认,显式给空则尊重用户', () => {
        const onlyTemplate = mergeSpec({ template: 'T' }, COLCON_BUILD_SPEC);
        assert.strictEqual(onlyTemplate.template, 'T');
        assert.deepStrictEqual(onlyTemplate.argv_list, COLCON_BUILD_SPEC.argv_list);
        assert.strictEqual(onlyTemplate.custom, COLCON_BUILD_SPEC.custom);

        const emptied = mergeSpec({ argv_list: [], template: '' }, COLCON_BUILD_SPEC);
        assert.deepStrictEqual(emptied.argv_list, [], '显式空数组不得被默认还原');
        assert.strictEqual(emptied.template, '', '显式空串不得被默认还原');
        assert.strictEqual(emptied.custom, COLCON_BUILD_SPEC.custom, 'custom 未给 ⇒ 回落默认');
    });
    it('mergeSpec:argv_list 里的非法项被过滤(整条非法 ⇒ 留空组占位,槽号不错位)', () => {
        const merged = mergeSpec({ argv_list: [{ argv: '--a', describe: 'A' }, 42 as unknown as { argv: string; describe: string }] }, COLCON_BUILD_SPEC);
        assert.deepStrictEqual(merged.argv_list, [{ argv: '--a', describe: 'A' }, []]);
        assert.deepStrictEqual(flattenArgList(merged.argv_list).map(c => [c.slot, c.argv]), [[1, '--a']]);
    });
});

describe('出厂预设 = 详细输出的两半(不再有安装交叉预设)', () => {
    it('只有两条:argv 与 描述 固定(第 2 条只给 handler 名,避免重复 flag)', () => {
        assert.deepStrictEqual(COLCON_BUILD_PRESETS.map(p => p.argv), [
            '--log-level debug',
            'log_command+',
        ]);
        assert.ok(COLCON_BUILD_PRESETS.every(p => p.describe.length > 0), '每条预设都要有描述(弹窗要显示)');
        assert.deepStrictEqual(
            flattenArgList(COLCON_BUILD_SPEC.argv_list).map(c => c.argv),
            COLCON_BUILD_PRESETS.map(p => p.argv),
        );
    });

    it('预设只有 {argv, describe} 两个字段(无元数据、无特权)', () => {
        COLCON_BUILD_PRESETS.forEach(preset => {
            assert.deepStrictEqual(Object.keys(preset).sort(), ['argv', 'describe']);
        });
    });

    it('axesFromArgv:两轴反解只看两个 flag(顺序无关、其它参数忽略)', () => {
        assert.deepStrictEqual(axesFromArgv('--symlink-install --merge-install'), { method: 'symlink', layout: 'merged' });
        assert.deepStrictEqual(axesFromArgv('--merge-install --symlink-install'), { method: 'symlink', layout: 'merged' });
        assert.deepStrictEqual(axesFromArgv('--symlink-install'), { method: 'symlink', layout: 'isolated' });
        assert.deepStrictEqual(axesFromArgv('--merge-install'), { method: 'copy', layout: 'merged' });
        assert.deepStrictEqual(axesFromArgv(''), { method: 'copy', layout: 'isolated' });
        assert.deepStrictEqual(axesFromArgv('--install-base /tmp/x --continue-on-error'), { method: 'copy', layout: 'isolated' });
        assert.deepStrictEqual(axesFromArgv('--install-base "/tmp/a b" --symlink-install'), { method: 'symlink', layout: 'isolated' });
        assert.deepStrictEqual(axesFromArgv('--log-level debug --event-handlers console_cohesion+'), { method: 'copy', layout: 'isolated' });
    });
});

describe('命名动态参数清单(表驱动锁定:文档与实现不得漂移)', () => {
    it('收缩后是 5 个:两轴 + 路径 + 包 + clean', () => {
        assert.deepStrictEqual(colconBuildDynamics({
            base_path: '/home/ros2/roa2_ws',
            packages: ['p10_mix_deps_std', 'p11_use_adder'],
            clean: true,
            install_type: { method: 'symlink', layout: 'merged' },
        }), {
            base_path: '/home/ros2/roa2_ws',                                         // 裸值(无空格 → 不加引号)
            packages_select: '--packages-select p10_mix_deps_std p11_use_adder',      // 片段(自带 flag)
            clean: '--cmake-clean-cache',
            install_method: '--symlink-install',                                      // 两轴 = 两个独立变量(设置接管)
            install_layout: '--merge-install',
        });
    });

    it('两轴四种组合 → 两个变量各自为空或带 flag(缺省 = 实体 + 分包)', () => {
        const combos: Array<[{ method: 'symlink' | 'copy'; layout: 'merged' | 'isolated' }, string, string]> = [
            [{ method: 'symlink', layout: 'merged' }, '--symlink-install', '--merge-install'],
            [{ method: 'symlink', layout: 'isolated' }, '--symlink-install', ''],
            [{ method: 'copy', layout: 'merged' }, '', '--merge-install'],
            [{ method: 'copy', layout: 'isolated' }, '', ''],
        ];
        combos.forEach(([axes, method, layout]) => {
            const d = colconBuildDynamics({ base_path: WS, install_type: axes });
            assert.strictEqual(d.install_method, method, `${axes.method}/${axes.layout} 的 install_method`);
            assert.strictEqual(d.install_layout, layout, `${axes.method}/${axes.layout} 的 install_layout`);
        });
        const dflt = colconBuildDynamics({ base_path: WS });
        assert.strictEqual(dflt.install_method, '');
        assert.strictEqual(dflt.install_layout, '');
        assert.deepStrictEqual(axesFromArgv(`${dflt.install_method} ${dflt.install_layout}`), { method: 'copy', layout: 'isolated' });
    });

    it('空/缺省:无包 → packages_select 空串;clean=false → 空串', () => {
        const d = colconBuildDynamics({ base_path: '/ws', packages: [], clean: false });
        assert.strictEqual(d.packages_select, '');
        assert.strictEqual(d.clean, '');
    });

    it('base_path 含空格 → 自动加引号,展开后仍是单个 argv', () => {
        const d = colconBuildDynamics({ base_path: '/tmp/a b' });
        assert.strictEqual(d.base_path, '"/tmp/a b"');
        assert.deepStrictEqual(expandCommand(spec('colcon build --base-paths ${base_path}'), { dynamics: d }).argv,
            ['colcon', 'build', '--base-paths', '/tmp/a b']);
    });

    it('被收缩掉的变量名现在是"未知占位符"(原样保留 + 记日志)', () => {
        const d = colconBuildDynamics({ base_path: '/ws', packages: ['a'] });
        for (const gone of ['parallel', 'event_handlers', 'build_type', 'packages', 'log_level']) {
            assert.ok(!(gone in d), `${gone} 不应再是动态参数`);
        }
        const r = expandCommand(spec('tool ${parallel} ${event_handlers} ${build_type} ${packages} ${log_level}'), { dynamics: d });
        assert.deepStrictEqual(r.argv, ['tool', '${parallel}', '${event_handlers}', '${build_type}', '${packages}', '${log_level}']);
        assert.deepStrictEqual(r.unknown, ['build_type', 'event_handlers', 'log_level', 'packages', 'parallel']);
    });

    it('拼错变量名 → 原样保留 + 记入 unknown(不会静默变空)', () => {
        const r = expandCommand(spec('colcon build --base-paths ${basepath}'), {
            dynamics: colconBuildDynamics({ base_path: '/ws' }),
        });
        assert.deepStrictEqual(r.argv, ['colcon', 'build', '--base-paths', '${basepath}']);
        assert.deepStrictEqual(r.unknown, ['basepath']);
    });
});

describe('默认 spec:与今天 toConcolBuild 的等价性(等价性锁定)', () => {
    /** 今天普通模式的 argv = ["colcon", ...toConcolBuildCommand({...})](顺序照抄该函数) */
    function todayNonVerboseArgv(flags: string[], packages: string[], clean: boolean): string[] {
        const args: string[] = ['build', ...flags];
        args.push('--event-handlers', 'console_cohesion+');
        args.push('--base-paths', WS);
        if (packages.length > 0) {
            args.push('--packages-select', ...packages);
        }
        if (clean) {
            args.push('--cmake-clean-cache');
        }
        args.push('--cmake-args', '-DCMAKE_BUILD_TYPE=RelWithDebInfo', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON');
        return ['colcon', ...args];
    }

    it('两轴四种组合(不勾预设)→ 与今天的 argv 逐字节一致', () => {
        const combos: Array<[{ method: 'symlink' | 'copy'; layout: 'merged' | 'isolated' }, string[]]> = [
            [{ method: 'symlink', layout: 'merged' }, ['--symlink-install', '--merge-install']],
            [{ method: 'symlink', layout: 'isolated' }, ['--symlink-install']],
            [{ method: 'copy', layout: 'merged' }, ['--merge-install']],
            [{ method: 'copy', layout: 'isolated' }, []],
        ];
        combos.forEach(([axes, flags]) => {
            const dynamics = colconBuildDynamics({ base_path: WS, packages: ['a', 'b'], clean: true, install_type: axes });
            const r = expandCommand(COLCON_BUILD_SPEC, { dynamics });
            assert.deepStrictEqual(r.argv, todayNonVerboseArgv(flags, ['a', 'b'], true), `${axes.method}/${axes.layout} 不等价`);
            assert.deepStrictEqual(r.unknown, []);
        });
    });

    it('无包(全量)+ 无 clean → 无裸 --packages-select、无 --cmake-clean-cache', () => {
        const dynamics = colconBuildDynamics({ base_path: WS, packages: [], clean: false, install_type: { method: 'copy', layout: 'isolated' } });
        const r = expandCommand(COLCON_BUILD_SPEC, { dynamics });
        assert.deepStrictEqual(r.argv, todayNonVerboseArgv([], [], false));
        assert.ok(!r.argv.includes('--packages-select'));
        assert.ok(!r.argv.includes('--cmake-clean-cache'));
    });

    /** 今天详细模式的 argv = ["colcon", ...toConcolBuildCommand({verbose: true, ...})] */
    function todayVerboseArgv(flags: string[], packages: string[], clean: boolean): string[] {
        const args: string[] = ['--log-level', 'debug', 'build', ...flags];
        args.push('--event-handlers', 'console_cohesion+', 'log_command+');
        args.push('--base-paths', WS);
        if (packages.length > 0) {
            args.push('--packages-select', ...packages);
        }
        if (clean) {
            args.push('--cmake-clean-cache');
        }
        args.push('--cmake-args', '-DCMAKE_BUILD_TYPE=RelWithDebInfo', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON');
        return ['colcon', ...args];
    }

    it('详细输出 = 勾上两条预设:与今天 verbose=true 的 argv **逐字节相同**(且只有一条 --event-handlers)', () => {
        const dynamics = colconBuildDynamics({ base_path: WS, packages: ['a'], install_type: { method: 'symlink', layout: 'isolated' } });
        const r = expandCommand(COLCON_BUILD_SPEC, { dynamics, picked: [0, 1] });
        assert.deepStrictEqual(r.argv, todayVerboseArgv(['--symlink-install'], ['a'], false));
        assert.strictEqual(r.argv.filter(t => t === '--event-handlers').length, 1, '不得出现重复的 --event-handlers');
        assert.deepStrictEqual(r.unknown, []);
    });

    it('只勾第 1 条 = 只有 debug 日志;只勾第 2 条 = 只加 log_command+', () => {
        const dynamics = colconBuildDynamics({ base_path: WS });
        const onlyLog = expandCommand(COLCON_BUILD_SPEC, { dynamics, picked: [0] }).argv;
        assert.deepStrictEqual(onlyLog.slice(0, 4), ['colcon', '--log-level', 'debug', 'build']);
        assert.ok(onlyLog.includes('console_cohesion+') && !onlyLog.includes('log_command+'));
        const onlyCmd = expandCommand(COLCON_BUILD_SPEC, { dynamics, picked: [1] }).argv;
        assert.ok(!onlyCmd.includes('--log-level'));
        const handlers = onlyCmd[onlyCmd.indexOf('--event-handlers') + 1];
        assert.strictEqual(handlers, 'console_cohesion+');
        assert.strictEqual(onlyCmd[onlyCmd.indexOf('--event-handlers') + 2], 'log_command+');
    });

    it('默认模板**没有** ${0} ⇒ 传进来的自定义输入被忽略(功能保留但默认不使用)', () => {
        const dynamics = colconBuildDynamics({ base_path: WS, packages: ['a'] });
        const r = expandCommand(COLCON_BUILD_SPEC, { dynamics, custom: '--continue-on-error' });
        assert.ok(!r.argv.includes('--continue-on-error'), '默认模板未用 ${0},自定义输入不应出现');
        assert.strictEqual(usesCustomPlaceholder(COLCON_BUILD_SPEC.template), false);
    });
});

describe('模板是自由文本:顺序 / 位置 / 重复 / 省略全由用户决定', () => {
    it('槽位顺序自由:${3} 可以排在 ${1} 前面', () => {
        assert.deepStrictEqual(expandCommand(spec('tool ${3} ${1}', P123), { dynamics: {}, picked: [0, 2] }).argv,
            ['tool', '--three', '--one']);
    });

    it('槽位位置自由:可以放在 verb 之前(实际的 ${1} = --log-level debug 就放在 build 前)', () => {
        const s = spec('colcon ${1} build --base-paths ${base_path}', COLCON_BUILD_PRESETS);
        assert.deepStrictEqual(expandCommand(s, { dynamics: { base_path: '/ws' }, picked: [0] }).argv,
            ['colcon', '--log-level', 'debug', 'build', '--base-paths', '/ws']);
    });

    it('占位符可以完全不出现:模板退化成一条纯字面量命令', () => {
        const r = expandCommand(spec('colcon build --continue-on-error'), { dynamics: { base_path: '/ws' } });
        assert.deepStrictEqual(r.argv, ['colcon', 'build', '--continue-on-error']);
        assert.deepStrictEqual(r.unknown, []);
    });

    it('甚至可以换掉整条命令(引擎对命令名/verb 无假设)', () => {
        const s = spec('ros2 run ${pkg} ${executable} ${1}');
        assert.deepStrictEqual(expandCommand(s, { dynamics: { pkg: 'demo', executable: 'talker' } }).argv,
            ['ros2', 'run', 'demo', 'talker']);
    });
});

describe('模板里没有 ${0} ⇒ 不弹「自定义输入」', () => {
    it('usesCustomPlaceholder:默认模板 false;加回 ${0} 后 true', () => {
        assert.strictEqual(usesCustomPlaceholder(COLCON_BUILD_SPEC.template), false);
        assert.strictEqual(usesCustomPlaceholder(`${COLCON_BUILD_SPEC.template} \${0}`), true);
        assert.strictEqual(usesCustomPlaceholder('tool ${01}'), false);
        assert.strictEqual(usesCustomPlaceholder(''), false);
    });

    it('makePresetItems:默认模板只有 2 条预设项(无自定义项);加回 ${0} 才有第 1 项', () => {
        const items = pickPreset.makePresetItems(COLCON_BUILD_SPEC);
        assert.strictEqual(items.length, 2);
        assert.ok(!items.some(i => i.isCustom));
        assert.deepStrictEqual(items.map(i => i.presetIndex), [0, 1]);
        assert.strictEqual(items[0].label, COLCON_BUILD_PRESETS[0].describe);
        assert.strictEqual(items[0].description, COLCON_BUILD_PRESETS[0].argv);

        const withCustom = pickPreset.makePresetItems({
            ...COLCON_BUILD_SPEC,
            template: `${COLCON_BUILD_SPEC.template} \${0}`,
        });
        assert.strictEqual(withCustom.length, 3);
        assert.strictEqual(withCustom[0].label, pickPreset.CUSTOM_ITEM_LABEL);
        assert.strictEqual(withCustom[0].isCustom, true);
    });
});

/**
 * 宿主跳过守卫:_vscode-stub 在真实 VS Code 宿主里【故意不劫持】(见 _vscode-stub.ts 头注),
 * 依赖 stub 播种/弹窗队列的用例在宿主里必然读到真配置/弹真窗口 → 仅无头(npx mocha)运行。
 */
function skipIfRealHost(context: Mocha.Context): void {
    const g = global as unknown as { __vscodeStubInstalled?: boolean };
    if (!g.__vscodeStubInstalled) {
        context.skip();
    }
}

describe('二级弹窗的三种形态(可整个不要 / 只剩手动输入 / 多选列表)', function () {
    before(function (this: Mocha.Context) {
        skipIfRealHost(this); // pickPresets 在宿主弹真输入框,无人交互必超时
    });

    /** 有 ${0} + 有预设 → 列表里含"自定义输入" */
    const listWithCustom: CommandSpec = { ...COLCON_BUILD_SPEC, template: `${COLCON_BUILD_SPEC.template} \${0}` };
    const listSpec = COLCON_BUILD_SPEC;                 // 2 条预设、无 ${0}
    const inputOnlySpec = spec('tool ${0}');            // 无预设、有 ${0}
    const emptySpec = spec('tool --x');                 // 无预设、无 ${0}

    it('presetPickPlan:三种形态判定', () => {
        assert.strictEqual(pickPreset.presetPickPlan(listWithCustom), 'list');
        assert.strictEqual(pickPreset.presetPickPlan(listSpec), 'list');
        assert.strictEqual(pickPreset.presetPickPlan(inputOnlySpec), 'input-only');
        assert.strictEqual(pickPreset.presetPickPlan(emptySpec), 'none');
    });

    it('none:一个弹窗都不弹,直接返回空选择(调用方照常构建)', async () => {
        vscodeStubWindow.reset();
        assert.deepStrictEqual(await pickPreset.pickPresets(emptySpec, {}), { picked: [] });
        assert.strictEqual(vscodeStubWindow.quickPickCalls, 0);
        assert.strictEqual(vscodeStubWindow.inputBoxCalls, 0);
    });

    it('input-only:跳过列表,直接弹手动输入框', async () => {
        vscodeStubWindow.reset();
        vscodeStubWindow.inputBoxResponses.push('--install-base /tmp/a');
        assert.deepStrictEqual(await pickPreset.pickPresets(inputOnlySpec, {}), { custom: '--install-base /tmp/a', picked: [] });
        assert.strictEqual(vscodeStubWindow.quickPickCalls, 0, '不得弹列表');
        assert.strictEqual(vscodeStubWindow.inputBoxCalls, 1);
    });

    it('input-only:空输入回车 = 不加参数继续;**Esc = 取消本次流程**', async () => {
        vscodeStubWindow.reset();
        vscodeStubWindow.inputBoxResponses.push('   ');
        assert.deepStrictEqual(await pickPreset.pickPresets(inputOnlySpec, {}), { picked: [] });
        vscodeStubWindow.inputBoxResponses.push(undefined);
        assert.strictEqual(await pickPreset.pickPresets(inputOnlySpec, {}), undefined);
    });

    it('list(默认模板):只勾预设 → 不弹输入框', async () => {
        vscodeStubWindow.reset();
        const items = pickPreset.makePresetItems(listSpec);
        vscodeStubWindow.quickPickResponses.push([items[0], items[1]]);
        assert.deepStrictEqual(await pickPreset.pickPresets(listSpec, {}), { custom: undefined, picked: [0, 1] });
        assert.strictEqual(vscodeStubWindow.inputBoxCalls, 0);
    });

    it('list(含自定义项):勾了自定义输入 → 追加输入框并取到内容', async () => {
        vscodeStubWindow.reset();
        const items = pickPreset.makePresetItems(listWithCustom);
        vscodeStubWindow.quickPickResponses.push([items[0], items[1]]);   // 自定义 + 预设下标 0
        vscodeStubWindow.inputBoxResponses.push('--continue-on-error');
        assert.deepStrictEqual(await pickPreset.pickPresets(listWithCustom, {}), { custom: '--continue-on-error', picked: [0] });
    });

    it('Esc 一律 = 取消:列表 Esc、自定义输入框 Esc 都返回 undefined(不"保留勾选继续")', async () => {
        vscodeStubWindow.reset();
        vscodeStubWindow.quickPickResponses.push(undefined);
        assert.strictEqual(await pickPreset.pickPresets(listWithCustom, {}), undefined);

        vscodeStubWindow.reset();
        const items = pickPreset.makePresetItems(listWithCustom);
        vscodeStubWindow.quickPickResponses.push([items[0], items[2]]);   // 自定义 + 预设下标 1
        vscodeStubWindow.inputBoxResponses.push(undefined);               // Esc → 取消
        assert.strictEqual(await pickPreset.pickPresets(listWithCustom, {}), undefined);
    });

    it('输入框**空串回车** ≠ Esc:不追加自定义,其余勾选照用', async () => {
        vscodeStubWindow.reset();
        const items = pickPreset.makePresetItems(listWithCustom);
        vscodeStubWindow.quickPickResponses.push([items[0], items[2]]);   // 自定义 + 预设下标 1
        vscodeStubWindow.inputBoxResponses.push('   ');                    // 空输入回车
        assert.deepStrictEqual(await pickPreset.pickPresets(listWithCustom, {}), { custom: undefined, picked: [1] });
    });

    it('预设全删但模板仍用 ${0} → 走 input-only,不报错', () => {
        const deletedAll: CommandSpec = { ...COLCON_BUILD_SPEC, template: 'tool ${0}', argv_list: [] };
        assert.strictEqual(pickPreset.presetPickPlan(deletedAll), 'input-only');
        assert.strictEqual(pickPreset.makePresetItems(deletedAll).length, 1);
    });

    it('预设全删 + 模板去掉 ${0} → 引擎照常展开(只是没有第二级)', () => {
        const bare: CommandSpec = { template: 'colcon build --base-paths ${base_path}', custom: '', argv_list: [] };
        assert.strictEqual(pickPreset.presetPickPlan(bare), 'none');
        assert.deepStrictEqual(expandCommand(bare, { dynamics: { base_path: '/ws' } }).argv,
            ['colcon', 'build', '--base-paths', '/ws']);
    });
});

describe('槽内多条备选(组):展示全部、同组只应用书写顺序里的第一条', () => {
    /** 槽1 = 三条备选(组),槽2 = 单条 */
    const grouped: CommandSpec = {
        template: 'tool ${1} --mid ${2}',
        custom: 'C',
        argv_list: [
            [
                { argv: '--a', describe: '备选 A' },
                { argv: '--b', describe: '备选 B' },
                { argv: '--c', describe: '备选 C' },
            ],
            { argv: '--solo', describe: '单条' },
        ],
    };

    it('flattenArgList:展平顺序 = 槽号升序、槽内按书写先后;单条写法的 index 恰为 slot-1(老记忆兼容)', () => {
        const flat = flattenArgList(COLCON_BUILD_SPEC.argv_list);
        assert.deepStrictEqual(flat.map(c => [c.slot, c.index]), [[1, 0], [2, 1]], '每个槽只有一条 ⇒ index = slot-1');

        const groupedFlat = flattenArgList(grouped.argv_list);
        assert.deepStrictEqual(groupedFlat.map(c => [c.slot, c.index, c.argv]), [
            [1, 0, '--a'], [1, 1, '--b'], [1, 2, '--c'], [2, 3, '--solo'],
        ]);
    });

    it('同组三选 ⇒ 只应用第一条(--a);其余勾选不参与展开', () => {
        assert.deepStrictEqual(expandCommand(grouped, { dynamics: {}, picked: [0, 1, 2] }).argv,
            ['tool', '--a', '--mid']);
    });

    it('同组只勾第二条 ⇒ 应用第二条;勾第二+第三 ⇒ 仍取第二条', () => {
        assert.deepStrictEqual(expandCommand(grouped, { dynamics: {}, picked: [1] }).argv,
            ['tool', '--b', '--mid']);
        assert.deepStrictEqual(expandCommand(grouped, { dynamics: {}, picked: [1, 2] }).argv,
            ['tool', '--b', '--mid']);
    });

    it('跨槽互不影响:槽1 取组内第一条,槽2 取它那一条', () => {
        assert.deepStrictEqual(expandCommand(grouped, { dynamics: {}, picked: [2, 3] }).argv,
            ['tool', '--c', '--mid', '--solo']);
    });

    it('"第一条被勾中的备选"展开为空 ⇒ 该槽为空,**不顺延**到第二条', () => {
        const withEmptyFirst: CommandSpec = {
            template: 'tool ${1}',
            custom: '',
            argv_list: [[{ argv: '', describe: '无附加参数' }, { argv: '--x', describe: 'X' }]],
        };
        assert.deepStrictEqual(expandCommand(withEmptyFirst, { dynamics: {}, picked: [0, 1] }).argv, ['tool']);
        assert.deepStrictEqual(expandCommand(withEmptyFirst, { dynamics: {}, picked: [1] }).argv, ['tool', '--x']);
    });

    it('空组占位但不产出条目 ⇒ 后续槽号不错位', () => {
        const withEmptyGroup: CommandSpec = {
            template: 'tool ${1} ${2} ${3}',
            custom: '',
            argv_list: [{ argv: '--one', describe: '1' }, [], { argv: '--three', describe: '3' }],
        };
        const flat = flattenArgList(withEmptyGroup.argv_list);
        assert.deepStrictEqual(flat.map(c => [c.slot, c.index]), [[1, 0], [3, 1]], '空组不产出条目,但槽号仍是 3');
        assert.deepStrictEqual(expandCommand(withEmptyGroup, { dynamics: {}, picked: [1] }).argv,
            ['tool', '--three']);
    });

    it('全是空组 ⇒ 视为"没有预设"(presetPickPlan 走 none / 弹窗不显示条目)', () => {
        const allEmpty: CommandSpec = { template: 'tool --x', custom: '', argv_list: [[], []] };
        assert.strictEqual(pickPreset.presetPickPlan(allEmpty), 'none');
        assert.deepStrictEqual(pickPreset.makePresetItems(allEmpty), []);
    });

    it('弹窗**展示全部**备选,并标注各自填哪个槽(detail)', () => {
        const items = pickPreset.makePresetItems(grouped);
        assert.deepStrictEqual(items.map(i => i.label), ['备选 A', '备选 B', '备选 C', '单条']);
        assert.deepStrictEqual(items.map(i => i.presetIndex), [0, 1, 2, 3]);
        assert.strictEqual(items[0].detail, '-> fills ${1}');
        assert.strictEqual(items[2].detail, '-> fills ${1}', '同组三条都指向同一个槽');
        assert.strictEqual(items[3].detail, '-> fills ${2}');
    });

    it('记忆按下标预勾:同组勾了两条时,两条都会被预勾(展开仍只取第一条)', () => {
        const items = pickPreset.makePresetItems(grouped, { picked: [0, 2] });
        assert.deepStrictEqual(items.map(i => i.picked), [true, false, true, false]);
    });

    it('normalizeSpec:组内非法项丢弃;整条非法项 ⇒ 留一个空组(不挤掉后面槽号)', () => {
        const normalized = normalizeSpec({
            argv_list: [
                [{ argv: '--a', describe: 'A' }, 42, null],
                'not-an-object',
                { argv: '--c', describe: 'C' },
            ],
        } as unknown as Partial<CommandSpec>);
        assert.deepStrictEqual(normalized.argv_list, [
            [{ argv: '--a', describe: 'A' }],
            [],
            { argv: '--c', describe: 'C' },
        ]);
        assert.deepStrictEqual(flattenArgList(normalized.argv_list).map(c => [c.slot, c.argv]), [[1, '--a'], [3, '--c']]);
    });

    it('mergeSpec:组也深拷贝(改合并结果不会动到出厂默认)', () => {
        const fallback: CommandSpec = { template: 't', custom: '', argv_list: [[{ argv: '--a', describe: 'A' }]] };
        const merged = mergeSpec(undefined, fallback);
        const mergedGroup = merged.argv_list[0] as unknown as { argv: string }[];
        mergedGroup[0].argv = 'MUTATED';
        const fallbackGroup = fallback.argv_list[0] as unknown as { argv: string }[];
        assert.strictEqual(fallbackGroup[0].argv, '--a');
    });
});

describe('模板 = 字符串(设置侧唯一表示,2026-10-07 起拆除数组兼容)', () => {
    it('出厂模板 = 历史自由文本(逐字节锁定,防默认命令漂移)', () => {
        assert.strictEqual(COLCON_BUILD_SPEC.template,
            'colcon ${1} build ${install_method} ${install_layout} '
            + '--event-handlers console_cohesion+ ${2} '
            + '--base-paths ${base_path} ${packages_select} ${clean} '
            + '--cmake-args -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_EXPORT_COMPILE_COMMANDS=ON');
        assert.strictEqual(ROS2_RUN_SPEC.template, 'ros2 run ${pkg} ${executable} ${0}');
        assert.strictEqual(ROS2_LAUNCH_SPEC.template, 'ros2 launch ${pkg} ${launch_file} ${0}');
    });

    it('mergeSpec:设置给字符串模板 → 尊重;非字符串(存量数组写法/数字)→ 视为未给,回落出厂默认', () => {
        const str = mergeSpec({ template: 'colcon build' }, COLCON_BUILD_SPEC);
        assert.strictEqual(str.template, 'colcon build');
        const arr = mergeSpec({ template: ['colcon', 'build'] as unknown as string }, COLCON_BUILD_SPEC);
        assert.strictEqual(arr.template, COLCON_BUILD_SPEC.template, '数组写法不再被接受(未分发,无存量)');
        const junk = mergeSpec({ template: 42 as unknown as string }, COLCON_BUILD_SPEC);
        assert.strictEqual(junk.template, COLCON_BUILD_SPEC.template);
    });

    it('normalizeSpec:undefined / 数字 template ⇒ 空串(半成品容忍)', () => {
        assert.strictEqual(normalizeSpec({ template: undefined } as Partial<CommandSpec>).template, '');
        assert.strictEqual(normalizeSpec({ template: 42 } as unknown as Partial<CommandSpec>).template, '');
    });
});

describe('package.json 预存默认与出厂 spec 同步(锁:两处默认不得漂移)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
        contributes: { configuration: Array<{ properties: Record<string, { default?: unknown }> }> };
    };
    const props: Record<string, { default?: unknown }> = {};
    pkg.contributes.configuration.forEach(b => Object.assign(props, b.properties));

    it('三命令的 default(template/custom/argv_list)与 defaults/*.ts 出厂值一致', () => {
        const pairs: Array<[string, CommandSpec]> = [
            ['ROS2.build.shareSpec', COLCON_BUILD_SPEC],
            ['ROS2.run.shareSpec', ROS2_RUN_SPEC],
            ['ROS2.launch.shareSpec', ROS2_LAUNCH_SPEC],
        ];
        for (const [key, factorySpec] of pairs) {
            const d = props[key].default as CommandSpec;
            assert.ok(d, `${key} 必须预存 default(设置面板直接可见可改)`);
            assert.deepStrictEqual(d.template, factorySpec.template, `${key} template 漂移`);
            assert.strictEqual(d.custom, factorySpec.custom, `${key} custom 漂移`);
            assert.deepStrictEqual(d.argv_list, factorySpec.argv_list, `${key} argv_list 漂移`);
        }
    });
});
