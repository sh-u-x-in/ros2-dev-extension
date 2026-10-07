// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file rosmsg-tables.test.ts
 * rosmsg 三张表 + 四个事件 + op 流（`手工重设计/rosmsg-v3.md` 落地）单元测试。
 *
 * 策略：每个用例跑一遍「写线 → op → 读线」同步链路（与 WorkspaceIndex.dispatchOps 同构），
 *       并在每步之后断言【读线快照 === 写线快照】——op 流任何不同步都会在这里暴露。
 *
 * 覆盖：归属判定（最长匹配）/ 消息增加（幂等、换包先摘后挂）/ 消息删除（迟到 no-op）/
 *       删除包（包级继承、深嵌套守卫、改名顺序无关）/ 新增包（认领、跳更深、顺序无关）/
 *       全量重建 diff / op 组形态。
 */

import * as assert from 'assert';
import * as path from 'path';
import { IndexOp, IndexReader, IndexWriter, LOOSE_PKG } from '../../src/languages/rosmsg/data/tables';

/** 组装一条「写线 → op → 读线」链路（与 WorkspaceIndex.dispatchOps 同构；小数据无阈值） */
function makeLine() {
    const opLog: IndexOp[][] = [];
    const reader = new IndexReader();
    const writer = new IndexWriter((ops) => {
        opLog.push(ops.map((o) => ({ ...o })));
        reader.apply(ops);
    });
    return { writer, reader, opLog };
}

/** 读线快照必须与写线一致（op 流同步的单一断言） */
function assertConsistent(w: IndexWriter, r: IndexReader, hint: string): void {
    assert.deepStrictEqual(r.snapshot(), w.snapshotTables(), `读线应与写线一致:${hint}`);
}

const n = (p: string): string => path.normalize(p);

/* 常用目录 */
const DIR_A = '/ws/src/a';
const DIR_B = '/ws/src/a/b';
const DIR_C = '/ws/src/a/b/c';

describe('rosmsg 三张表(写线/读线) 单元测试', () => {

    describe('归属判定(枚举祖先链,最长匹配)', () => {
        it('嵌套包取最深命中;圈外 → 非法包;部分路径段不算', () => {
            const { writer } = makeLine();
            writer.setPackages([
                { name: 'a', dir: DIR_A },
                { name: 'b', dir: DIR_B },
            ]);
            assert.strictEqual(writer.resolveOwner('/ws/src/a/b/msg/X.msg'), 'b', '应取最长匹配(最深包 b)');
            assert.strictEqual(writer.resolveOwner('/ws/src/a/msg/Y.msg'), 'a');
            assert.strictEqual(writer.resolveOwner('/ws/other/Z.msg'), LOOSE_PKG);
            assert.strictEqual(writer.resolveOwner('/ws/src/msg/W.msg'), LOOSE_PKG, '父目录是 src 但不是包 → 非法');
        });
    });

    describe('消息增加', () => {
        it('新文件:入正表(正确包)与反表;op = [add];读写一致', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.addMessage('/ws/src/a/msg/X.msg');
            assert.strictEqual(reader.findMessage('a', 'X')?.path, n('/ws/src/a/msg/X.msg'));
            assert.strictEqual(reader.ownerOf('/ws/src/a/msg/X.msg'), 'a');
            assert.deepStrictEqual(opLog, [[{ kind: 'add', path: n('/ws/src/a/msg/X.msg'), pkg: 'a' }]]);
            assertConsistent(writer, reader, 'addMessage 新文件');
        });

        it('重复增加同路径同归属 → 幂等(无 op、表不变)', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.addMessage('/ws/src/a/msg/X.msg');
            const before = opLog.length;
            writer.addMessage('/ws/src/a/msg/X.msg');
            assert.strictEqual(opLog.length, before, '重复 add 不应再发 op');
            assertConsistent(writer, reader, 'addMessage 幂等');
        });

        it('无归属 → 入非法包哨兵行(loose)', () => {
            const { writer, reader } = makeLine();
            writer.addMessage('/ws/stray/X.msg');
            assert.strictEqual(reader.ownerOf('/ws/stray/X.msg'), LOOSE_PKG);
            assert.ok(reader.looseEntriesByPrefix('X').some((m) => m.name === 'X'));
            assertConsistent(writer, reader, 'addMessage 非法包');
        });

        it('换包(包表先行、条目未搬)→ 先摘后挂,op = [remove, add]', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.addMessage('/ws/src/a/msg/X.msg'); // 归 a
            // 模拟"包表变化但条目未搬"(防御路径):直接把包表换成 X 应归 b 的形态
            writer.setPackages([{ name: 'b', dir: DIR_A }]);
            writer.addMessage('/ws/src/a/msg/X.msg'); // 触发换包分支
            const last = opLog[opLog.length - 1];
            assert.deepStrictEqual(last, [
                { kind: 'remove', path: n('/ws/src/a/msg/X.msg') },
                { kind: 'add', path: n('/ws/src/a/msg/X.msg'), pkg: 'b' },
            ], '换包应发 remove+add 一组');
            assert.strictEqual(reader.findMessage('a', 'X'), undefined, '旧包行应已摘除');
            assert.strictEqual(reader.findMessage('b', 'X')?.path, n('/ws/src/a/msg/X.msg'));
            assertConsistent(writer, reader, 'addMessage 换包');
        });
    });

    describe('消息删除', () => {
        it('正常删除:两条表同步移除;op = [remove]', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.addMessage('/ws/src/a/msg/X.msg');
            writer.removeMessage('/ws/src/a/msg/X.msg');
            assert.strictEqual(reader.ownerOf('/ws/src/a/msg/X.msg'), undefined, '反表应无此路径');
            assert.deepStrictEqual(opLog[opLog.length - 1], [{ kind: 'remove', path: n('/ws/src/a/msg/X.msg') }]);
            assertConsistent(writer, reader, 'removeMessage');
        });

        it('迟到删除(路径不在表里)→ no-op', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            const before = opLog.length;
            writer.removeMessage('/ws/src/a/msg/Ghost.msg');
            assert.strictEqual(opLog.length, before, '迟到删除不应发 op');
            assertConsistent(writer, reader, 'removeMessage 迟到');
        });
    });

    describe('删除包(包级继承)', () => {
        it('外层有包:名下消息整包交给外层;op = m 条 add', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([
                { name: 'a', dir: DIR_A },
                { name: 'b', dir: DIR_B },
            ]);
            writer.addMessage('/ws/src/a/b/msg/X.msg');
            writer.addMessage('/ws/src/a/b/msg/Y.msg');
            opLog.length = 0;
            writer.removePackage('b', DIR_B);
            assert.deepStrictEqual(opLog[0].map((o) => o.kind), ['add', 'add'], '整包搬移在一组 op 内');
            assert.strictEqual(reader.findMessage('a', 'X')?.path, n('/ws/src/a/b/msg/X.msg'), 'X 应接住给 a');
            assert.strictEqual(reader.findMessage('a', 'Y')?.path, n('/ws/src/a/b/msg/Y.msg'));
            assert.strictEqual(reader.findMessage('b', 'X'), undefined);
            assertConsistent(writer, reader, 'removePackage 外层接住');
        });

        it('无外层包:名下消息掉入非法包', () => {
            const { writer, reader } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.addMessage('/ws/src/a/msg/X.msg');
            writer.removePackage('a', DIR_A);
            assert.strictEqual(reader.ownerOf('/ws/src/a/msg/X.msg'), LOOSE_PKG);
            assertConsistent(writer, reader, 'removePackage → 非法包');
        });

        it('深层守卫:更深嵌套包(c)的条目不被误搬', () => {
            const { writer, reader } = makeLine();
            writer.setPackages([
                { name: 'a', dir: DIR_A },
                { name: 'b', dir: DIR_B },
                { name: 'c', dir: DIR_C },
            ]);
            writer.addMessage('/ws/src/a/b/msg/Y.msg');   // 归 b
            writer.addMessage('/ws/src/a/b/c/msg/X.msg'); // 归 c(更深)
            writer.removePackage('b', DIR_B);
            assert.strictEqual(reader.findMessage('a', 'Y')?.path, n('/ws/src/a/b/msg/Y.msg'), 'b 的 Y 接住给 a');
            assert.strictEqual(reader.findMessage('c', 'X')?.path, n('/ws/src/a/b/c/msg/X.msg'), 'c 的 X 不受影响');
            assertConsistent(writer, reader, 'removePackage 深层守卫');
        });

        it('重复删除同包 → 幂等', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.removePackage('a', DIR_A);
            const before = opLog.length;
            writer.removePackage('a', DIR_A);
            assert.strictEqual(opLog.length, before);
            assertConsistent(writer, reader, 'removePackage 幂等');
        });

        it('包改名(同目录):remove→add 与 add→remove 两种顺序结果一致', () => {
            for (const order of ['remove-first', 'add-first'] as const) {
                const { writer, reader } = makeLine();
                writer.setPackages([{ name: 'A', dir: DIR_A }]);
                writer.addMessage('/ws/src/a/msg/X.msg'); // 归 A
                if (order === 'remove-first') {
                    writer.removePackage('A', DIR_A);
                    writer.addPackage('B', DIR_A);
                } else {
                    writer.addPackage('B', DIR_A);
                    writer.removePackage('A', DIR_A);
                }
                assert.strictEqual(reader.findMessage('B', 'X')?.path, n('/ws/src/a/msg/X.msg'),
                    `[${order}] 改名后 X 应归 B`);
                assert.strictEqual(reader.findMessage('A', 'X'), undefined, `[${order}] 旧名不应残留`);
                assertConsistent(writer, reader, `包改名 ${order}`);
            }
        });
    });

    describe('新增包(反表前缀扫认领)', () => {
        it('非法包条目被认领', () => {
            const { writer, reader, opLog } = makeLine();
            writer.addMessage('/ws/src/a/msg/X.msg'); // 尚无包 → 非法
            assert.strictEqual(reader.ownerOf('/ws/src/a/msg/X.msg'), LOOSE_PKG);
            opLog.length = 0;
            writer.addPackage('a', DIR_A);
            assert.deepStrictEqual(opLog[0], [{ kind: 'add', path: n('/ws/src/a/msg/X.msg'), pkg: 'a' }]);
            assert.strictEqual(reader.findMessage('a', 'X')?.path, n('/ws/src/a/msg/X.msg'));
            assertConsistent(writer, reader, 'addPackage 认领非法条目');
        });

        it('外层包条目被更深新增包认领', () => {
            const { writer, reader } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.addMessage('/ws/src/a/b/msg/X.msg'); // 无 b 时归 a
            assert.strictEqual(reader.ownerOf('/ws/src/a/b/msg/X.msg'), 'a');
            writer.addPackage('b', DIR_B);
            assert.strictEqual(reader.findMessage('b', 'X')?.path, n('/ws/src/a/b/msg/X.msg'), 'X 应认领给更深的 b');
            assert.strictEqual(reader.findMessage('a', 'X'), undefined);
            assertConsistent(writer, reader, 'addPackage 认领外层条目');
        });

        it('更深嵌套包(c)的条目:新增中间包(b)时被跳过', () => {
            const { writer, reader } = makeLine();
            writer.setPackages([
                { name: 'a', dir: DIR_A },
                { name: 'c', dir: DIR_C },
            ]);
            writer.addMessage('/ws/src/a/b/c/msg/X.msg'); // 归 c
            writer.addPackage('b', DIR_B);                // b 比 c 浅 → X 应跳过
            assert.strictEqual(reader.findMessage('c', 'X')?.path, n('/ws/src/a/b/c/msg/X.msg'), 'X 仍归更深的 c');
            assert.strictEqual(reader.findMessage('b', 'X'), undefined);
            assertConsistent(writer, reader, 'addPackage 跳更深');
        });

        it('顺序无关:A、B(B=A/B)同时新增,两种顺序收敛一致', () => {
            const snapshots: string[] = [];
            for (const order of ['A-first', 'B-first'] as const) {
                const { writer, reader } = makeLine();
                writer.addMessage('/ws/src/a/b/msg/X.msg'); // 先非法
                if (order === 'A-first') {
                    writer.addPackage('a', DIR_A);
                    writer.addPackage('b', DIR_B);
                } else {
                    writer.addPackage('b', DIR_B);
                    writer.addPackage('a', DIR_A);
                }
                assert.strictEqual(reader.findMessage('b', 'X')?.path, n('/ws/src/a/b/msg/X.msg'),
                    `[${order}] X 最终应归 B`);
                assertConsistent(writer, reader, `新增顺序 ${order}`);
                snapshots.push(JSON.stringify(reader.snapshot()));
            }
            assert.strictEqual(snapshots[0], snapshots[1], '两种顺序的最终表应一致');
        });

        it('重复新增同包 → 幂等', () => {
            const { writer, reader, opLog } = makeLine();
            writer.addPackage('a', DIR_A);
            const before = opLog.length;
            writer.addPackage('a', DIR_A);
            assert.strictEqual(opLog.length, before);
            assertConsistent(writer, reader, 'addPackage 幂等');
        });
    });

    describe('全量重建(rebuild 差量 diff)', () => {
        it('首建:全量 add;新增/消失/归属变化收敛', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.rebuild(['/ws/src/a/msg/X.msg', '/ws/src/a/msg/Y.msg']);
            assert.strictEqual(reader.findMessage('a', 'X')?.path, n('/ws/src/a/msg/X.msg'));
            assert.strictEqual(reader.findMessage('a', 'Y')?.path, n('/ws/src/a/msg/Y.msg'));
            assertConsistent(writer, reader, 'rebuild 首建');

            // 文件消失 → remove
            opLog.length = 0;
            writer.rebuild(['/ws/src/a/msg/X.msg']);
            assert.deepStrictEqual(opLog[0], [{ kind: 'remove', path: n('/ws/src/a/msg/Y.msg') }]);
            assert.strictEqual(reader.findMessage('a', 'Y'), undefined);
            assertConsistent(writer, reader, 'rebuild 删除收敛');

            // 空集合 → 全清
            writer.rebuild([]);
            assert.strictEqual(reader.ownerOf('/ws/src/a/msg/X.msg'), undefined);
            assertConsistent(writer, reader, 'rebuild 清空');
        });

        it('内容未变 → 无 op(不打扰)', () => {
            const { writer, reader, opLog } = makeLine();
            writer.setPackages([{ name: 'a', dir: DIR_A }]);
            writer.rebuild(['/ws/src/a/msg/X.msg']);
            opLog.length = 0;
            writer.rebuild(['/ws/src/a/msg/X.msg']);
            assert.strictEqual(opLog.length, 0, '相同文件集重建不应发 op');
            assertConsistent(writer, reader, 'rebuild 无变化');
        });
    });

    describe('读线独立行为(apply 幂等)', () => {
        it('remove 未命中 → no-op;add 同归属已存在 → no-op', () => {
            const reader = new IndexReader();
            reader.apply([{ kind: 'remove', path: n('/ws/x/Ghost.msg') }]);
            assert.strictEqual(reader.isLoaded(), true);
            reader.apply([{ kind: 'add', path: n('/ws/x/A.msg'), pkg: 'p1' }]);
            reader.apply([{ kind: 'add', path: n('/ws/x/A.msg'), pkg: 'p1' }]); // 幂等
            assert.strictEqual(reader.findMessage('p1', 'A')?.path, n('/ws/x/A.msg'));
            assert.strictEqual(reader.entriesOf('p1').length, 1, '幂等 add 不应重复条目');
            reader.apply([{ kind: 'add', path: n('/ws/x/A.msg'), pkg: 'p2' }]); // 先摘后挂
            assert.strictEqual(reader.findMessage('p1', 'A'), undefined);
            assert.strictEqual(reader.findMessage('p2', 'A')?.path, n('/ws/x/A.msg'));
        });

        it('条目查询:限定名前缀(补全场景)', () => {
            const { writer, reader } = makeLine();
            writer.setPackages([{ name: 'geometry_msgs', dir: '/ws/src/geometry_msgs' }]);
            writer.addMessage('/ws/src/geometry_msgs/msg/Point.msg');
            writer.addMessage('/ws/src/geometry_msgs/msg/Pose.msg');
            writer.addMessage('/ws/src/geometry_msgs/msg/Twist.msg');
            const hits = reader.entriesByQualifiedPrefix('geometry_msgs/P');
            assert.deepStrictEqual(hits.map((h) => h.name), ['Point', 'Pose'], '应按名升序且只含 P 前缀');
            const all = reader.entriesByQualifiedPrefix('geometry_msgs/');
            assert.strictEqual(all.length, 3);
        });
    });
});
