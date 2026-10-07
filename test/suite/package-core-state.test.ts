// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-core-state.test.ts
 * package-core 数据层状态 null 语义单元测试(2026-09-01 五域 null 契约)。
 *
 * 纯 TS(state.ts / derive.ts 零 vscode 依赖),可直接 mocha 运行:
 *   npm run test-compile && npx mocha out/test/suite/package-core-state.test.js
 *
 * 语义:五个域(PackageDataState)一律 null = 未刷新/未知;[] = 已刷新且确实没有;
 * 派生域(workspace / all)任一上游 null → null(未知传播)。
 */

import * as assert from 'assert';
import { emptyState, domainSig } from '../../src/build-tool/package-core/data/state';
import { deriveWorkspace, deriveAll, fallbackUnignoredFromWalk } from '../../src/build-tool/package-core/data/derive';
import type { PackageScanEntry } from '../../src/build-tool/package-core/scan/package-scan';

describe('package-core state null 语义', () => {
    it('emptyState: 五域全部为 null(未刷新=未知, 区别于已刷新但空的 [])', () => {
        const s = emptyState();
        assert.strictEqual(s.workspace, null);
        assert.strictEqual(s.unignored, null);
        assert.strictEqual(s.ignored, null);
        assert.strictEqual(s.system, null);
        assert.strictEqual(s.all, null);
    });

    it('domainSig: null 与 [] 必须区分(null → "!null", [] → "")', () => {
        assert.strictEqual(domainSig(null), '!null');
        assert.strictEqual(domainSig([]), '');
        assert.notStrictEqual(domainSig(null), domainSig([]));
        // 有数据时与空/null 都不同
        assert.notStrictEqual(domainSig([{ name: 'a', dir: '/x' }]), domainSig([]));
    });

    it('domainSig: 含 buildType(设计 D1)——类型就绪/翻转触发域变化,顺序无关', () => {
        const typed = [{ name: 'a', dir: '/x', buildType: 'ament_python' }];
        assert.strictEqual(
            domainSig([...typed, { name: 'b', dir: '/y', buildType: 'ament_cmake' }]),
            domainSig([{ name: 'b', dir: '/y', buildType: 'ament_cmake' }, ...typed]) // 顺序无关
        );
        // 类型翻转 → 签名变(域事件会发)
        assert.notStrictEqual(
            domainSig([{ name: 'a', dir: '/x', buildType: 'ament_python' }]),
            domainSig([{ name: 'a', dir: '/x', buildType: 'ament_cmake' }])
        );
        // 类型就绪(undefined → 值)→ 签名变(D4:域层不发布 undefined,就绪后补发)
        assert.notStrictEqual(
            domainSig([{ name: 'a', dir: '/x', buildType: undefined }]),
            domainSig([{ name: 'a', dir: '/x', buildType: 'ament_python' }])
        );
        // 系统包 buildType "" 与工作区类型区分
        assert.notStrictEqual(
            domainSig([{ name: 's', dir: '', buildType: '' }]),
            domainSig([{ name: 's', dir: '', buildType: 'ament_python' }])
        );
    });

    it('deriveWorkspace: 两源皆数组 → 合并去重;任一 null → null', () => {
        const u = [{ name: 'a', dir: '/a' }];
        const i = [{ name: 'b', dir: '/b' }, { name: 'a', dir: '/a' }];
        const w = deriveWorkspace(u, i);
        assert.ok(w && w.length === 2); // a 去重
        assert.strictEqual(deriveWorkspace(null, []), null);
        assert.strictEqual(deriveWorkspace([], null), null);
        assert.strictEqual(deriveWorkspace(null, null), null);
    });

    it('fallbackUnignoredFromWalk(设计 D2):只收合法非忽略包,输出带 buildType(walk 合法条目必带类型)', () => {
        const mk = (over: Partial<PackageScanEntry>): PackageScanEntry => ({
            dir: '/x', name: 'a', buildType: 'ament_python', hasColconIgnore: false, parentIsSrc: true, isValid: true, ...over,
        });
        const r = fallbackUnignoredFromWalk([
            mk({ dir: '/a', name: 'pa' }),
            mk({ dir: '/b', name: 'pb', buildType: 'ament_cmake' }),
            mk({ dir: '/ign', name: 'pi', ignoredBy: 'same-dir' }),       // 被 COLCON_IGNORE(同目录)→ 不收
            mk({ dir: '/anc', name: 'pc', ignoredBy: 'ancestor' }),       // 祖先忽略 → 不收
            mk({ dir: '/ov', name: 'pd', ignoredBy: 'overlap' }),         // 嵌套重叠 → 不收
            mk({ dir: '/bad', isValid: false }),                       // 不合法 → 不收
            mk({ dir: '/no-name', name: undefined, isValid: true }),   // 缺 name → 不收(防御)
        ]);
        assert.deepStrictEqual(r, [
            { name: 'pa', dir: '/a', buildType: 'ament_python' },
            { name: 'pb', dir: '/b', buildType: 'ament_cmake' },
        ]);
    });

    it('deriveAll: 两源皆数组 → 合并;system null(未刷新)→ all null(未知传播,不冒充空)', () => {
        const ws = [{ name: 'a', dir: '/a' }];
        const sys = [{ name: 'std_msgs', dir: '' }];
        const all = deriveAll(ws, sys);
        assert.ok(all && all.length === 2);
        assert.strictEqual(deriveAll(ws, null), null);          // system 未刷新 → all 未知
        assert.strictEqual(deriveAll(null, sys), null);          // workspace 未刷新 → all 未知
        assert.deepStrictEqual(deriveAll(ws, []), ws);          // system 已刷新但空 → all = workspace(非 null)
        assert.deepStrictEqual(deriveAll([], []), []);          // 都刷新且空 → [] (成功但空)
    });
});
