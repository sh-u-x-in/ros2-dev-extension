// Licensed under the MIT License.

/**
 * @file ros-run-spec.test.ts(2026-09-25 新增)
 * run 域接线适配层 `run/share-spec.ts` 与出厂默认(`share/defaults/ros2-run|ros2-launch.ts`)的无头单测。
 *
 * 覆盖:① 出厂模板展开 = `ros2 run <pkg> <exe>`(无参数时不留尾空段);② `${0}` 追加参数(含引号参数);
 *      ③ launch 三变量(pkg/launch_file/launch_path);④ 未知占位符原样保留;⑤ 空模板 ⇒ empty;
 *      ⑥ 设置合并(缺省回落 / 显式给空尊重用户);⑦ 记忆键按目标分槽(run 按 包/可执行;launch 按源路径)。
 *
 * 无头可跑:`npm run test-compile && npx mocha out/test/suite/ros-run-spec.test.js`
 */

import * as assert from 'assert';

import { ROS2_LAUNCH_SPEC, ros2LaunchDynamics, ros2LaunchMemoryId } from '../../src/build-tool/package-service/share/defaults/ros2-launch';
import { ROS2_RUN_SPEC, ros2RunDynamics, ros2RunMemoryId } from '../../src/build-tool/package-service/share/defaults/ros2-run';
import { expandCommand } from '../../src/build-tool/package-service/share/expand';
import { installVscodeStub, vscodeStubConfig } from './_vscode-stub';

installVscodeStub();

// 播种型用例只依赖 vscodeStubConfig(仅无头生效):真实宿主里无法播种真设置 ——
// 与 build 域 share-spec.test.ts 的存量失败同因;有头跳过,不新增基线噪音。
// 判定用 stub 的安装标志(installVscodeStub 真实宿主直接返回、不设标志;无头会设)。
const headless = ((global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled ?? false) as boolean;
const describeSeeding = headless ? describe : describe.skip;

// run/share-spec 依赖 vscode(读设置)→ 装完 stub 再 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const shareSpec = require('../../src/build-tool/package-service/run/share-spec') as typeof import('../../src/build-tool/package-service/run/share-spec');

describe('ros2-run 出厂 spec + dynamics(纯函数)', () => {
    it('默认模板展开 = ros2 run <pkg> <exe>(不输参数时不留尾空段)', () => {
        const r = expandCommand(ROS2_RUN_SPEC, { dynamics: ros2RunDynamics({ pkg: 'demo_pkg', executable: 'talker' }) });
        assert.deepStrictEqual(r.argv, ['ros2', 'run', 'demo_pkg', 'talker']);
        assert.strictEqual(r.empty, false);
        assert.deepStrictEqual(r.unknown, []);
    });

    it('${0} 追加运行参数(shell 词法切分;引号参数还原成单段)', () => {
        const r = expandCommand(ROS2_RUN_SPEC, {
            dynamics: ros2RunDynamics({ pkg: 'demo_pkg', executable: 'talker' }),
            custom: '--ros-args -r __node:=demo',
        });
        assert.deepStrictEqual(r.argv, ['ros2', 'run', 'demo_pkg', 'talker', '--ros-args', '-r', '__node:=demo']);
    });

    it('含空格的目标名自动加引号,切分后仍是单段', () => {
        const r = expandCommand(ROS2_RUN_SPEC, { dynamics: ros2RunDynamics({ pkg: 'my pkg', executable: 'my exe' }) });
        assert.deepStrictEqual(r.argv, ['ros2', 'run', 'my pkg', 'my exe']);
    });

    it('未知占位符原样保留并记入 unknown(不静默吞掉)', () => {
        const spec = { ...ROS2_RUN_SPEC, template: 'ros2 run ${pkg} ${executable} ${typo}' };
        const r = expandCommand(spec, { dynamics: ros2RunDynamics({ pkg: 'p', executable: 'e' }) });
        assert.deepStrictEqual(r.unknown, ['typo']);
        assert.ok(r.argv.indexOf('${typo}') >= 0);
    });
});

describe('ros2-launch 出厂 spec + dynamics(纯函数)', () => {
    it('默认模板展开 = ros2 launch <pkg> <file>(不输参数时不留尾空段)', () => {
        const r = expandCommand(ROS2_LAUNCH_SPEC, {
            dynamics: ros2LaunchDynamics({ pkg: 'demo_pkg', launch_file: 'demo.launch.py', launch_path: '/ws/install/demo_pkg/share/demo_pkg/launch/demo.launch.py' }),
        });
        assert.deepStrictEqual(r.argv, ['ros2', 'launch', 'demo_pkg', 'demo.launch.py']);
    });

    it('${0} 追加 launch 参数;${launch_path} 换按路径启动的模板', () => {
        const withArgs = expandCommand(ROS2_LAUNCH_SPEC, {
            dynamics: ros2LaunchDynamics({ pkg: 'p', launch_file: 'demo.launch.py' }),
            custom: 'x:=1 y:=2',
        });
        assert.deepStrictEqual(withArgs.argv, ['ros2', 'launch', 'p', 'demo.launch.py', 'x:=1', 'y:=2']);

        const byPath = expandCommand(
            { ...ROS2_LAUNCH_SPEC, template: 'ros2 launch ${launch_path} ${0}' },
            { dynamics: ros2LaunchDynamics({ pkg: 'p', launch_file: 'demo.launch.py', launch_path: '/ws/install/p/share/p/launch/demo.launch.py' }) },
        );
        assert.deepStrictEqual(byPath.argv, ['ros2', 'launch', '/ws/install/p/share/p/launch/demo.launch.py']);
    });

    it('launch_path 缺省 = 空串(模板没用它就不出现)', () => {
        const r = expandCommand(ROS2_LAUNCH_SPEC, { dynamics: ros2LaunchDynamics({ pkg: 'p', launch_file: 'f.launch.py' }) });
        assert.deepStrictEqual(r.argv, ['ros2', 'launch', 'p', 'f.launch.py']);
    });
});

describe('记忆键:按目标分槽(用户裁定 2026-09-25)', () => {
    it('ros2 run:键 = ros2.run::<pkg>/<exe>(不同目标互不串)', () => {
        assert.strictEqual(ros2RunMemoryId('demo_pkg', 'talker'), 'ros2.run::demo_pkg/talker');
        assert.notStrictEqual(ros2RunMemoryId('demo_pkg', 'talker'), ros2RunMemoryId('demo_pkg', 'listener'));
    });

    it('ros2 launch:键优先源文件路径(不同包同名 launch 不串);无源退化为安装路径', () => {
        const a = ros2LaunchMemoryId({ sourcePath: '/ws/src/a/launch/demo.launch.py', installPath: '/ws/install/a/share/a/launch/demo.launch.py' });
        const b = ros2LaunchMemoryId({ sourcePath: '/ws/src/b/launch/demo.launch.py', installPath: '/ws/install/b/share/b/launch/demo.launch.py' });
        assert.notStrictEqual(a, b, '同名 launch,路径不同 ⇒ 记忆不串');
        assert.ok(a.startsWith('ros2.launch::/ws/src/a/'));
        assert.strictEqual(
            ros2LaunchMemoryId({ installPath: '/ws/install/p/share/p/launch/x.launch.py' }),
            'ros2.launch::/ws/install/p/share/p/launch/x.launch.py',
            '无源行退化为安装路径'
        );
    });
});

describeSeeding('run 域 share-spec:设置 → spec(合并出厂默认)', () => {
    const RUN_KEY = 'run.shareSpec';
    const LAUNCH_KEY = 'launch.shareSpec';

    beforeEach(() => {
        vscodeStubConfig.reset();
    });

    it('设置缺失 → 读到的就是出厂默认;展开与纯函数用例一致', () => {
        const spec = shareSpec.readRosRunSpec();
        assert.deepStrictEqual(spec.template, ROS2_RUN_SPEC.template, '出厂默认按值相等(package.json 预存 default 时引用不同)');
        assert.deepStrictEqual(spec.argv_list, []);
        const r = shareSpec.expandRos2Run({ pkg: 'demo_pkg', executable: 'talker' });
        assert.deepStrictEqual(r.argv, ['ros2', 'run', 'demo_pkg', 'talker']);
    });

    it('显式给空 template → 尊重用户(展开为 empty,调用方拒绝执行)', () => {
        vscodeStubConfig.store[RUN_KEY] = { template: '' };
        const r = shareSpec.expandRos2Run({ pkg: 'p', executable: 'e' });
        assert.strictEqual(r.empty, true);
    });

    it('自定义模板 + picked 槽位照常生效;launch 走自己的设置键', () => {
        vscodeStubConfig.store[RUN_KEY] = {
            template: 'ros2 run ${pkg} ${executable} ${1}',
            argv_list: [{ argv: '--spin', describe: '自转' }],
        };
        const r = shareSpec.expandRos2Run({ pkg: 'p', executable: 'e', picked: [0] });
        assert.deepStrictEqual(r.argv, ['ros2', 'run', 'p', 'e', '--spin']);

        vscodeStubConfig.store[LAUNCH_KEY] = { template: 'ros2 launch ${launch_path}' };
        const l = shareSpec.expandRos2Launch({
            pkg: 'p',
            launch_file: 'demo.launch.py',
            launch_path: '/i/p/share/p/launch/demo.launch.py',
        });
        assert.deepStrictEqual(l.argv, ['ros2', 'launch', '/i/p/share/p/launch/demo.launch.py']);
    });

    it('launch_path 缺省时 ${launch_path} 展开为空(不会原样泄漏)', () => {
        vscodeStubConfig.store[LAUNCH_KEY] = { template: 'ros2 launch ${pkg} ${launch_file} ${launch_path}' };
        const l = shareSpec.expandRos2Launch({ pkg: 'p', launch_file: 'f.launch.py' });
        assert.deepStrictEqual(l.argv, ['ros2', 'launch', 'p', 'f.launch.py']);
    });
});
