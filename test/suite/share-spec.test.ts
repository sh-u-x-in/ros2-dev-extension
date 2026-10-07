// Licensed under the MIT License.

/**
 * @file share-spec.test.ts
 * 接线适配层 `build/share-spec.ts` 的无头单测:设置 → (合并出厂默认) → 展开成 argv。
 *
 * 无头可跑:`npm run test-compile && npx mocha out/test/suite/share-spec.test.js`
 * 被测模块依赖 vscode(读设置 + resolveInstallType)→ 先装 stub,并用 `vscodeStubConfig` 播种设置项。
 *
 * 重点:① 设置项缺失 ⇒ 整份出厂默认;② **显式给空数组不复原默认**(预设可全删);③ 模板是唯一来源
 * (模板里没写的变量不出现,例如 `${clean}` 不在模板里 ⇒ clean 参数不出现);④ 空模板 ⇒ empty。
 */

import * as assert from 'assert';

import { COLCON_BUILD_SPEC } from '../../src/build-tool/package-service/share/defaults/colcon-build';
import { installVscodeStub, vscodeStubConfig } from './_vscode-stub';

installVscodeStub();

// share-spec 依赖 vscode → 装完 stub 再 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const shareSpec = require('../../src/build-tool/package-service/build/share-spec') as typeof import('../../src/build-tool/package-service/build/share-spec');

const KEY = 'build.shareSpec';

/** 每个用例前清空设置播种,并把两轴钉死成"实体 + 分包"(平台无关,便于断言) */
function resetSettings(): void {
    vscodeStubConfig.reset();
    vscodeStubConfig.store['build.installMethod'] = 'copy';
    vscodeStubConfig.store['build.installLayout'] = 'isolated';
}

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

describe('share-spec:设置 → spec(合并出厂默认)', function () {
    before(function (this: Mocha.Context) {
        skipIfRealHost(this); // stub 播种键在宿主无效(真配置),见 skipIfRealHost 注
    });

    beforeEach(resetSettings);

    it('设置项缺失 → 整份出厂默认', () => {
        const spec = shareSpec.readColconBuildSpec();
        assert.deepStrictEqual(spec.template, COLCON_BUILD_SPEC.template, '整份出厂默认 = 值相等(package.json 预存 default 时引用不同)');
        assert.deepStrictEqual(spec.argv_list, COLCON_BUILD_SPEC.argv_list);
        assert.strictEqual(spec.custom, COLCON_BUILD_SPEC.custom);
    });

    it('只给 template → 其余字段回落出厂默认', () => {
        vscodeStubConfig.store[KEY] = { template: 'colcon build --base-paths ${base_path}' };
        const spec = shareSpec.readColconBuildSpec();
        assert.strictEqual(spec.template, 'colcon build --base-paths ${base_path}');
        assert.deepStrictEqual(spec.argv_list, COLCON_BUILD_SPEC.argv_list, 'argv_list 未给 ⇒ 用默认');
        assert.strictEqual(spec.custom, COLCON_BUILD_SPEC.custom);
    });

    it('**显式给空 argv_list → 保持空**(预设可全删,不得被默认悄悄还原)', () => {
        vscodeStubConfig.store[KEY] = { template: 'colcon build', argv_list: [] };
        const spec = shareSpec.readColconBuildSpec();
        assert.deepStrictEqual(spec.argv_list, []);
    });

    it('显式给空串 template → 尊重用户(展开为空,而不是回落默认模板)', () => {
        vscodeStubConfig.store[KEY] = { template: '' };
        const r = shareSpec.expandColconBuild({ base_path: '/tmp/ws' });
        assert.strictEqual(r.empty, true);
        assert.deepStrictEqual(r.argv, []);
    });
});

describe('share-spec:展开成 argv(模板是唯一来源)', function () {
    before(function (this: Mocha.Context) {
        skipIfRealHost(this);
    });

    beforeEach(resetSettings);

    it('默认模板 + 两包 + clean:argv 与内置构造逐字节一致', () => {
        const r = shareSpec.expandColconBuild({ base_path: '/tmp/ws', packages: ['a', 'b'], clean: true });
        assert.deepStrictEqual(r.argv, [
            'colcon', 'build',
            '--event-handlers', 'console_cohesion+',
            '--base-paths', '/tmp/ws',
            '--packages-select', 'a', 'b',
            '--cmake-clean-cache',
            '--cmake-args', '-DCMAKE_BUILD_TYPE=RelWithDebInfo', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
        ]);
        assert.deepStrictEqual(r.unknown, []);
    });

    it('两轴来自设置:开符号 + 合并 → 两个 flag 都出现(与前瞻检查同源)', () => {
        vscodeStubConfig.store['build.installMethod'] = 'symlink';
        vscodeStubConfig.store['build.installLayout'] = 'merged';
        const argv = shareSpec.expandColconBuild({ base_path: '/ws' }).argv;
        if (process.platform === 'win32') {
            assert.ok(!argv.includes('--symlink-install'), 'Windows 恒实体:设置不得生效');
            assert.ok(argv.includes('--merge-install'));
        } else {
            assert.ok(argv.includes('--symlink-install'));
            assert.ok(argv.includes('--merge-install'));
        }
    });

    it('模板里没写的变量不出现:模板不含 ${clean} ⇒ clean 参数不出现', () => {
        vscodeStubConfig.store[KEY] = { template: 'colcon build --base-paths ${base_path} ${packages_select}' };
        const argv = shareSpec.expandColconBuild({ base_path: '/ws', packages: ['a'], clean: true }).argv;
        assert.deepStrictEqual(argv, ['colcon', 'build', '--base-paths', '/ws', '--packages-select', 'a']);
    });

    it('用户模板里的 ${0} 与预设槽:勾选 + 自定义输入都生效', () => {
        vscodeStubConfig.store[KEY] = {
            template: 'colcon build --base-paths ${base_path} ${packages_select} ${1} ${0}',
            custom: 'C',
            argv_list: [{ argv: '--continue-on-error', describe: 'd' }],
        };
        const argv = shareSpec.expandColconBuild({
            base_path: '/tmp/ws', packages: ['a', 'b'], picked: [0], custom: '--force',
        }).argv;
        assert.deepStrictEqual(argv, [
            'colcon', 'build', '--base-paths', '/tmp/ws',
            '--packages-select', 'a', 'b',
            '--continue-on-error', '--force',
        ]);
    });

    it('未知占位符原样保留(不静默剔除),记入 unknown', () => {
        vscodeStubConfig.store[KEY] = { template: 'colcon build --base-paths ${basepath}' };
        const r = shareSpec.expandColconBuild({ base_path: '/ws' });
        assert.deepStrictEqual(r.argv, ['colcon', 'build', '--base-paths', '${basepath}']);
        assert.deepStrictEqual(r.unknown, ['basepath']);
    });

    it('base_path 含空格 → 自动加引号,仍是单个 argv', () => {
        const argv = shareSpec.expandColconBuild({ base_path: '/tmp/a b' }).argv;
        const index = argv.indexOf('--base-paths');
        assert.strictEqual(argv[index + 1], '/tmp/a b');
    });
});
