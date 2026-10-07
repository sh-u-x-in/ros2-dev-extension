// Licensed under the MIT License.

/**
 * 测试改造回归网 v2(2026-09-24,B6.5)。
 *
 * 覆盖本改造新增/承重的**纯逻辑**(全部为真机实物形态,非构造字符串):
 *   1. `parseJunitXml` —— pytest 6.2.5 实物:单行巨行、failure 消息带换行、`<skipped>`、汇总由用例算出;
 *   2. `parseGtestXml` —— `result="skipped"`、`value_param` 透传、`classname+name` = filter 真名;
 *   3. `parseCTestTestfileText` —— p10 实物词法:2 条注册 + 属性 + `subdirs()` + 无 add_test → 空;
 *   4. `buildGTestFilter` —— 四类宏 × 文件级的 filter 矩阵(E1 裁定);
 *   5. `result-semantics` —— 退出码语义表(pytest 0/1/4/5、gtest 0 条 → errored);
 *   6. `reportCases` —— 多实例聚合(该组需要 vscode,宿主外自动跳过);
 *   7. `nextArtifactPath` —— 并行批次产物路径唯一性(B7.1 碰撞回归);
 *   8. `packageVerdict` —— 包级零产物成因分辨(B7.3:被忽略/未构建/无注册测试/0 条);
 *   9. `packageNote` —— 包节点说明项(B7.4:COLCON_IGNORE 优先 / 空包说明 / 有测试则无);
 *  10. `discovery-queue` —— 合并窗 + 单写者链(B10:去重/后到者胜/full 覆盖/串行/失败不断链);
 *  11. 命名规则唯一来源 / 用例增量 diff / 产物目录过滤(B11/B13)。
 *
 * 纯逻辑部分 B6.6 可无头直跑(`npx mocha out/test/suite/test-provider-v2.test.js`)。
 */

import * as assert from 'assert';
import * as path from 'path';

import { parseGtestXml, parseJunitXml } from '../../src/test-provider/parsing/test-results-parser';
import { parseCTestTestfileText, parseBacktrace, declarationOf, sourceArgAtDeclaration, launchTestSourceOf, isGtestRegistration, isLaunchTestRegistration } from '../../src/test-provider/parsing/ctest-testfile-parser';
import { buildGTestFilter, gtestSuiteOf } from '../../src/test-provider/semantics/gtest-filter';
import { classifyArtifact, gtestVerdict, hasMissingResultSentinel, isPackageRunnable, launchTestVerdict, packageNote, packagePreflight, packageVerdict, pytestVerdict } from '../../src/test-provider/semantics/result-semantics';
import { nextArtifactPath } from '../../src/test-provider/runner/artifact-path';
import {
    DiscoverScope,
    TimerLike,
    createDiscoveryQueue,
    planFlush
} from '../../src/test-provider/provider/discovery-queue';
import { TestDiscoveryUtils } from '../../src/test-provider/parsing/test-discovery-utils';

/** 真机 `build/p10_mix_deps_std/CTestTestfile.cmake` 的两条注册(词法逐字一致,仅路径缩短) */
const CTEST_SAMPLE = [
    '# CMake generated Testfile for',
    'add_test([=[test_entries]=] "/usr/bin/python3" "-u" "/opt/ros/humble/share/ament_cmake_test/cmake/run_test.py" "/ws/build/p10/test_results/p10/test_entries.gtest.xml" "--package-name" "p10" "--output-file" "/ws/build/p10/ament_cmake_gtest/test_entries.txt" "--command" "/ws/build/p10/test_entries" "--gtest_output=xml:/ws/build/p10/test_results/p10/test_entries.gtest.xml")',
    'set_tests_properties([=[test_entries]=] PROPERTIES  LABELS "gtest" REQUIRED_FILES "/ws/build/p10/test_entries" TIMEOUT "60" WORKING_DIRECTORY "/ws/build/p10" _BACKTRACE_TRIPLES "/opt/ros/humble/share/ament_cmake_test/cmake/ament_add_test.cmake;125;add_test")',
    'add_test([=[test_adder]=] "/usr/bin/python3" "-u" "/opt/ros/humble/share/ament_cmake_test/cmake/run_test.py" "/ws/build/p10/test_results/p10/test_adder.gtest.xml" "--package-name" "p10" "--command" "/ws/build/p10/test_adder" "--gtest_output=xml:/ws/build/p10/test_results/p10/test_adder.gtest.xml")',
    'set_tests_properties([=[test_adder]=] PROPERTIES  LABELS "gtest" REQUIRED_FILES "/ws/build/p10/test_adder" TIMEOUT "60" WORKING_DIRECTORY "/ws/build/p10" _BACKTRACE_TRIPLES "…")',
    'subdirs("gtest")',
].join('\n');

/** pytest 6.2.5 实物形态:整个文件一行;failure 内文本带换行;含 skipped */
const JUNIT_SAMPLE =
    '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="1.5">' +
    '<testcase classname="test.test_helper" name="test_ok" time="0.010" />' +
    '<testcase classname="test.test_helper" name="test_param[a-b]" time="0.020" />' +
    '<testcase classname="test.test_flake8" name="test_flake8" time="0.080">' +
    '<failure message="AssertionError: Found 1 errors&#10; ./setup.py:40:1: E266">trace line 1\nline 2 &gt; quoted</failure>' +
    '</testcase>' +
    '<testcase classname="test.test_pep257" name="test_pep257" time="0.000"><skipped type="pytest.skip" message="unconditional skip">/ws/test_pep257.py:3: unconditional skip</skipped></testcase>' +
    '</testsuite></testsuites>';

const GTEST_SAMPLE =
    '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="2" failures="0" disabled="0" errors="0" time="0" name="AllTests">\n' +
    '  <testsuite name="EntryBasic" tests="1" failures="0" disabled="0" errors="0" time="0">\n' +
    '    <testcase name="gtest_skip_macro" status="run" result="skipped" time="0" classname="EntryBasic" />\n' +
    '  </testsuite>\n' +
    '  <testsuite name="AdderCases/AdderParamTest" tests="1" failures="0" disabled="0" errors="0" time="0">\n' +
    '    <testcase name="param_macro/0" value_param="(10, 5, 15)" status="run" result="completed" time="0" classname="AdderCases/AdderParamTest" />\n' +
    '  </testsuite>\n</testsuites>';

describe('测试结果解析 · pytest junitxml', () => {
    const suite = parseJunitXml(JUNIT_SAMPLE);

    it('按用例算出汇总(不信任 XML 汇总属性)', () => {
        assert.strictEqual(suite.tests, 4);
        assert.strictEqual(suite.failures, 1);
        assert.strictEqual(suite.skipped, 1);
    });

    it('failure 消息含换行与实体反转义', () => {
        const failed = suite.cases.find((c) => c.status === 'failed');
        assert.ok(failed !== undefined);
        assert.strictEqual(failed!.classname, 'test.test_flake8');
        assert.ok(/E266/.test(failed!.message || ''));
        assert.ok(/line 2 > quoted/.test(failed!.message || ''), '实体 &gt; 应还原为 >');
    });

    it('skipped 被识别(≠ 通过)', () => {
        const skipped = suite.cases.filter((c) => c.status === 'skipped');
        assert.strictEqual(skipped.length, 1);
        assert.strictEqual(skipped[0].name, 'test_pep257');
    });

    it('参数化实例名保留 []', () => {
        assert.ok(suite.cases.some((c) => c.name === 'test_param[a-b]'));
    });
});

describe('测试结果解析 · gtest XML', () => {
    const suite = parseGtestXml(GTEST_SAMPLE);

    it('classname 末段 + name 拼出 filter 真名', () => {
        const param = suite.cases.find((c) => c.name === 'param_macro/0');
        assert.ok(param !== undefined);
        assert.strictEqual(`${param!.classname}.${param!.name}`, 'AdderCases/AdderParamTest.param_macro/0');
    });

    it('result="skipped" → skipped,value_param 透传', () => {
        const skipped = suite.cases.find((c) => c.name === 'gtest_skip_macro');
        assert.strictEqual(skipped!.status, 'skipped');
        assert.strictEqual(suite.cases.find((c) => c.name === 'param_macro/0')!.valueParam, '(10, 5, 15)');
    });
});

describe('CTestTestfile 注册解析(实物词法)', () => {
    const parsed = parseCTestTestfileText(CTEST_SAMPLE);

    it('两条注册 + subdirs', () => {
        assert.strictEqual(parsed.registrations.length, 2);
        assert.deepStrictEqual(parsed.subdirs, ['gtest']);
    });

    it('exePath / workingDirectory / TIMEOUT / LABELS / gtestXmlPath', () => {
        const e = parsed.registrations.find((r) => r.name === 'test_entries');
        assert.ok(e !== undefined);
        assert.strictEqual(e!.exePath, '/ws/build/p10/test_entries');
        assert.strictEqual(e!.workingDirectory, '/ws/build/p10');
        assert.strictEqual(e!.timeoutSec, 60);
        assert.deepStrictEqual(e!.labels, ['gtest']);
        assert.strictEqual(e!.gtestXmlPath, '/ws/build/p10/test_results/p10/test_entries.gtest.xml');
    });

    it('无 add_test → 空(生成型子目录是常态)', () => {
        const empty = parseCTestTestfileText('# CMake generated Testfile for\nsubdirs("p12_msgs__py")\n');
        assert.strictEqual(empty.registrations.length, 0);
        assert.deepStrictEqual(empty.subdirs, ['p12_msgs__py']);
    });
});

describe('gtest filter 矩阵(E1 裁定)', () => {
    it('TEST / TEST_F / GTEST_TEST → 套件.用例', () => {
        assert.strictEqual(buildGTestFilter({ testClass: 'A', testMethod: 'a', cppMacro: 'TEST' }), 'A.a');
        assert.strictEqual(buildGTestFilter({ testClass: 'B', testMethod: 'b', cppMacro: 'TEST_F' }), 'B.b');
        assert.strictEqual(buildGTestFilter({ testClass: 'F', testMethod: 'f', cppMacro: 'GTEST_TEST' }), 'F.f');
    });

    it('TEST_P → 前缀通配 + 套件.用例 + 索引通配', () => {
        assert.strictEqual(buildGTestFilter({ testClass: 'AdderParamTest', testMethod: 'param_macro', cppMacro: 'TEST_P' }), '*/AdderParamTest.param_macro/*');
    });

    it('TYPED_TEST / TYPED_TEST_F → 套件 + 类型索引通配 + .用例', () => {
        assert.strictEqual(buildGTestFilter({ testClass: 'CubicTest', testMethod: 'typed_macro', cppMacro: 'TYPED_TEST' }), 'CubicTest/*.typed_macro');
        assert.strictEqual(buildGTestFilter({ testClass: 'X', testMethod: 'm', cppMacro: 'TYPED_TEST_F' }), 'X/*.m');
    });

    it('TYPED_TEST_P → 比 TYPED_TEST 多一层实例化前缀(两者不可混用)', () => {
        assert.strictEqual(buildGTestFilter({ testClass: 'CalcTest', testMethod: 'add', cppMacro: 'TYPED_TEST_P' }), '*/CalcTest/*.add');
    });

    it('文件级 → 不加 filter', () => {
        assert.strictEqual(buildGTestFilter({}), undefined);
        assert.strictEqual(buildGTestFilter({ testClass: 'A' }), 'A.*');
    });
});

describe('退出码语义(result-semantics)', () => {
    it('pytest:4/5 → errored(没跑起来,不是用例失败)', () => {
        for (const code of [4, 5]) {
            const v = pytestVerdict({ exitCode: code, timedOut: false, artifactPresent: true, caseCount: 0, timeoutMs: 300000 });
            assert.strictEqual(v.kind, 'errored');
        }
    });

    it('pytest:产物缺失/0 条 → errored;有产物 → report(即使退出码 1)', () => {
        assert.strictEqual(pytestVerdict({ exitCode: 1, timedOut: false, artifactPresent: false, caseCount: 0, timeoutMs: 300000 }).kind, 'errored');
        assert.strictEqual(pytestVerdict({ exitCode: 0, timedOut: false, artifactPresent: true, caseCount: 0, timeoutMs: 300000 }).kind, 'errored');
        assert.strictEqual(pytestVerdict({ exitCode: 1, timedOut: false, artifactPresent: true, caseCount: 5, timeoutMs: 300000 }).kind, 'report');
    });

    it('gtest:退出码 0 且 0 条 → errored(假绿防护)', () => {
        const v = gtestVerdict({ exitCode: 0, timedOut: false, artifactPresent: true, caseCount: 0, timeoutMs: 300000 });
        assert.strictEqual(v.kind, 'errored');
        assert.ok(/0 cases/.test((v as { reason: string }).reason));
        assert.strictEqual(gtestVerdict({ exitCode: 0, timedOut: false, artifactPresent: true, caseCount: 3, timeoutMs: 300000 }).kind, 'report');
    });
});

describe('reportCases:多实例聚合', function () {
    // run-report 在运行时需要 vscode;无宿主(无头直跑)时跳过本组,逻辑由桩测离线覆盖
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let reportCases: ((run: unknown, scope: unknown, cases: unknown[], kind: string) => void) | undefined;
    before(function () {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            reportCases = require('../../src/test-provider/run-report').reportCases;
        } catch {
            this.skip();
        }
    });

    it('参数化 3 实例聚合到父项 + 失败消息带实例名', function () {
        if (reportCases === undefined) {
            this.skip();
        }
        const calls: unknown[][] = [];
        const run = {
            started: (t: { label: string }) => calls.push(['started', t.label]),
            passed: (t: { label: string }, d?: number) => calls.push(['passed', t.label, d]),
            failed: (t: { label: string }, m: unknown, d?: number) => calls.push(['failed', t.label, (Array.isArray(m) ? m : [m]).length, d]),
            skipped: (t: { label: string }) => calls.push(['skipped', t.label]),
            errored: () => calls.push(['errored']),
        };
        const child = { id: 'c1', label: 'AdderParamTest.param_macro', uri: undefined, children: { size: 0, forEach: () => undefined } };
        const file = { id: 'f1', label: 'test_gtest_entries.cpp', uri: { fsPath: '/ws/test_gtest_entries.cpp' }, children: { size: 1, forEach: (cb: (i: unknown) => void) => cb(child) } };
        reportCases!(run, { fileItems: [file] }, [
            { classname: 'AdderCases/AdderParamTest', name: 'param_macro/0', status: 'passed', timeSec: 0.01 },
            { classname: 'AdderCases/AdderParamTest', name: 'param_macro/1', status: 'failed', timeSec: 0.02, message: '断言 A' },
        ], 'gtest');
        const terminal = calls.filter((c) => c[0] !== 'started');
        assert.strictEqual(terminal.length, 1, '两个实例应聚合为一次上报');
        assert.strictEqual(terminal[0][0], 'failed');
        assert.strictEqual(terminal[0][2], 1, '失败消息 1 条');
    });
});

describe('产物临时路径(碰撞回归,B7.1)', () => {
    it('连续两次构造必不相同(同毫秒 + 同 pid 撞名的回归)', () => {
        const a = nextArtifactPath('pytest', '/tmp-probe');
        const b = nextArtifactPath('pytest', '/tmp-probe');
        assert.notStrictEqual(a, b);
    });

    it('并行批 32 次构造 → 32 个不同路径(真机 19 进程只分到 4 个路径的回归)', () => {
        const names = new Set<string>();
        for (let i = 0; i < 32; i++) {
            names.add(nextArtifactPath(i % 2 === 0 ? 'pytest' : 'gtest', '/tmp-probe'));
        }
        assert.strictEqual(names.size, 32);
    });

    it('命名形态:ros2-ide-<kind>-<时间戳>-<pid>-<序号>.xml', () => {
        const p = nextArtifactPath('gtest', '/tmp-probe');
        assert.ok(/^ros2-ide-gtest-\d+-\d+-\d+\.xml$/.test(path.basename(p)), p);
        assert.strictEqual(path.dirname(p), path.normalize('/tmp-probe'));
    });
});

describe('包级判定(packageVerdict,B7.3)', () => {
    /** 基准:一切正常(有构建目录、有产物、有 3 条用例) */
    const base = {
        pkg: 'holle',
        buildDirPresent: true,
        colconIgnorePresent: false,
        artifactCount: 1,
        caseCount: 3,
        missingResultSentinel: false,
        exitCode: 0,
        timedOut: false,
        timeoutMs: 900000
    };

    it('产物齐全 → report(退出码不参与判定)', () => {
        assert.strictEqual(packageVerdict(base).kind, 'report');
        assert.strictEqual(packageVerdict({ ...base, exitCode: 1 }).kind, 'report');
    });

    it('超时 → errored,且优先于其他成因(不报误导性的"未构建")', () => {
        const v = packageVerdict({ ...base, timedOut: true, buildDirPresent: false, artifactCount: 0, caseCount: 0 });
        assert.strictEqual(v.kind, 'errored');
        assert.ok(/timed out/.test((v as { reason: string }).reason));
    });

    it('COLCON_IGNORE → errored,且**排在"未构建"之前**(holle 实测形态:两条件皆中)', () => {
        const v = packageVerdict({ ...base, colconIgnorePresent: true, buildDirPresent: false, artifactCount: 0, caseCount: 0 });
        assert.ok(/COLCON_IGNORE/.test((v as { reason: string }).reason));
    });

    it('未构建 → errored + colcon build 指引', () => {
        const v = packageVerdict({ ...base, buildDirPresent: false, artifactCount: 0, caseCount: 0 });
        assert.ok(/ot built yet/.test((v as { reason: string }).reason));
    });

    it('已构建但零产物 → errored:未注册测试/未启用测试', () => {
        const v = packageVerdict({ ...base, artifactCount: 0, caseCount: 0 });
        assert.ok(/no test artifacts/.test((v as { reason: string }).reason));
    });

    it('产物在但 0 条用例 → errored(与"无产物"分开报)', () => {
        const v = packageVerdict({ ...base, caseCount: 0 });
        assert.ok(/0 cases/.test((v as { reason: string }).reason));
    });

    it('产物是 colcon 占位结果 → errored(不报假失败用例)', () => {
        const v = packageVerdict({ ...base, caseCount: 1, missingResultSentinel: true });
        assert.strictEqual(v.kind, 'errored');
        assert.ok(/placeholder/.test((v as { reason: string }).reason));
    });
});

describe('包级前置闸门(packagePreflight,B8)', () => {
    it('COLCON_IGNORE → 拦截(优先于"未构建")', () => {
        const v = packagePreflight({ pkg: 'holle', colconIgnorePresent: true, buildDirPresent: false });
        assert.strictEqual(v.kind, 'errored');
        assert.ok(/COLCON_IGNORE/.test((v as { reason: string }).reason));
    });

    it('未构建 → 拦截,且消息给出两条出路(E4:两类包都必然失败)', () => {
        const v = packagePreflight({ pkg: 'hi', colconIgnorePresent: false, buildDirPresent: false });
        assert.strictEqual(v.kind, 'errored');
        const reason = (v as { reason: string }).reason;
        assert.ok(/ot built yet/.test(reason) && /colcon build hi/.test(reason), reason);
        assert.ok(/file\/case/.test(reason), '应提示"单个文件/用例不经此闸门"的出路');
    });

    it('已构建且未被忽略 → 放行', () => {
        assert.strictEqual(packagePreflight({ pkg: 'iii', colconIgnorePresent: false, buildDirPresent: true }).kind, 'report');
    });
});

describe('colcon 占位结果识别(hasMissingResultSentinel,B8)', () => {
    it('单条 pytest.missing_result → 识别为占位', () => {
        assert.strictEqual(hasMissingResultSentinel([{ name: 'pytest.missing_result' }]), true);
    });

    it('正常结果(哪怕只有一条)不误判', () => {
        assert.strictEqual(hasMissingResultSentinel([{ name: 'test_flake8' }]), false);
        assert.strictEqual(hasMissingResultSentinel([]), false);
        assert.strictEqual(
            hasMissingResultSentinel([{ name: 'pytest.missing_result' }, { name: 'test_x' }]),
            false,
            '多条用例时不是占位(占位产物恒为单条)'
        );
    });
});

describe('包节点说明项(packageNote,B7.4/B9)', () => {
    const base = { pkg: 'holle', colconIgnorePresent: false, buildDirPresent: true, childCount: 3 };

    it('带 COLCON_IGNORE → 报忽略,且优先于其余两因(holle 实测:三条件皆中)', () => {
        const note = packageNote({ ...base, colconIgnorePresent: true, buildDirPresent: false, childCount: 0 });
        assert.ok(note !== undefined && /COLCON_IGNORE/.test(note));
    });

    it('无测试文件 → "This package has no test files",且优先于"尚未构建"(构建也救不了)', () => {
        assert.strictEqual(packageNote({ ...base, buildDirPresent: false, childCount: 0 }), 'This package has no test files');
    });

    it('有测试文件但未构建 → 提示构建后即可运行(B9 新增分支)', () => {
        const note = packageNote({ ...base, buildDirPresent: false });
        assert.ok(note !== undefined && /ot built yet/.test(note) && /colcon build holle/.test(note));
    });

    it('三条件皆过 → 无说明项(有测试且已构建的包树形不变)', () => {
        assert.strictEqual(packageNote(base), undefined);
    });
});

describe('包节点可运行判定(isPackageRunnable,B9)', () => {
    const ok = { colconIgnorePresent: false, buildDirPresent: true, testFileCount: 3 };

    it('三条件全过 → 可运行(有运行按钮)', () => {
        assert.strictEqual(isPackageRunnable(ok), true);
    });

    it('任一不满足 → 不可运行(无运行按钮 + Run All 跳过)', () => {
        assert.strictEqual(isPackageRunnable({ ...ok, colconIgnorePresent: true }), false);
        assert.strictEqual(isPackageRunnable({ ...ok, buildDirPresent: false }), false);
        assert.strictEqual(isPackageRunnable({ ...ok, testFileCount: 0 }), false);
    });
});

/** 假时钟(照 `test/suite/build-map.test.ts` 的 FakeTimer 范式):窗口"到点"由测试显式触发 */
class FakeTimer implements TimerLike {
    private nextId = 0;
    private readonly tasks = new Map<number, () => void>();
    set(fn: () => void, _ms: number): unknown {
        const id = ++this.nextId;
        this.tasks.set(id, fn);
        return id;
    }
    clear(handle: unknown): void {
        this.tasks.delete(handle as number);
    }
    /** 等 0 个 tick:让链上的微任务跑完 */
    private static async settle(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    /** 触发所有已排定的窗口回调(模拟"到点") */
    async fireAll(): Promise<void> {
        const all = [...this.tasks.values()];
        this.tasks.clear();
        for (const fn of all) {
            fn();
        }
        await FakeTimer.settle();
    }
}

describe('发现队列(discovery-queue,B10)', () => {
    it('同 scope 去重:窗口内多次 schedule 只落一次(不同 path 各算一个)', async () => {
        const batches: DiscoverScope[][] = [];
        const q = createDiscoveryQueue({
            timer: new FakeTimer(),
            onFlush: async (scopes) => {
                batches.push(scopes);
            }
        });
        q.schedule({ kind: 'file', path: '/ws/a.py', op: 'upsert' });
        q.schedule({ kind: 'file', path: '/ws/a.py', op: 'upsert' });
        q.schedule({ kind: 'file', path: '/ws/b.py', op: 'upsert' });
        assert.strictEqual(q.pendingCount(), 2, '同 path 合并');
        await q.flushNow();
        assert.strictEqual(batches.length, 1);
        assert.strictEqual(batches[0].length, 2);
    });

    it('后到者胜:save→delete 落 delete(文件已被删,不该再建)', async () => {
        const batches: DiscoverScope[][] = [];
        const q = createDiscoveryQueue({
            timer: new FakeTimer(),
            onFlush: async (scopes) => {
                batches.push(scopes);
            }
        });
        q.schedule({ kind: 'file', path: '/ws/a.py', op: 'upsert' });
        q.schedule({ kind: 'file', path: '/ws/a.py', op: 'delete' });
        await q.flushNow();
        assert.strictEqual(batches[0].length, 1);
        assert.strictEqual((batches[0][0] as { op: string }).op, 'delete');
    });

    it('full 覆盖其余 scope(planFlush 只留 full)', () => {
        const planned = planFlush([
            { kind: 'file', path: '/ws/a.py', op: 'upsert' },
            { kind: 'packages' },
            { kind: 'full' }
        ]);
        assert.strictEqual(planned.length, 1);
        assert.strictEqual(planned[0].kind, 'full');
    });

    it('窗口到点自动落地(timer 路径)', async () => {
        const timer = new FakeTimer();
        let count = 0;
        const q = createDiscoveryQueue({ timer, onFlush: async () => { count++; } });
        q.schedule({ kind: 'packages' });
        await timer.fireAll();
        assert.strictEqual(count, 1);
    });

    it('单写者链:前一个没落地完,后一个不会开始(B10 的"排队"语义)', async () => {
        const order: string[] = [];
        let release: (() => void) | undefined;
        let block = true;
        const q = createDiscoveryQueue({
            timer: new FakeTimer(),
            onFlush: async (scopes) => {
                const kind = scopes[0].kind;
                order.push(`start:${kind}`);
                if (block) {
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                }
                order.push(`end:${kind}`);
            }
        });
        q.schedule({ kind: 'packages' });
        const first = q.flushNow();
        q.schedule({ kind: 'file', path: '/ws/a.py', op: 'upsert' });
        const second = q.flushNow();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(order, ['start:packages'], '第二个必须等第一个落地完');
        block = false;
        release!();
        await first;
        await second;
        assert.deepStrictEqual(order, ['start:packages', 'end:packages', 'start:file', 'end:file']);
    });

    it('失败不断链:前一个落地抛错,后一个照常(照 rosmsg chain 的 catch 语义)', async () => {
        const seen: string[] = [];
        const q = createDiscoveryQueue({
            timer: new FakeTimer(),
            onFlush: async (scopes) => {
                const kind = scopes[0].kind;
                seen.push(kind);
                if (kind === 'packages') {
                    throw new Error('boom');
                }
            }
        });
        q.schedule({ kind: 'packages' });
        await q.flushNow().catch(() => undefined);
        q.schedule({ kind: 'file', path: '/ws/a.py', op: 'upsert' });
        await q.flushNow().catch(() => undefined);
        assert.deepStrictEqual(seen, ['packages', 'file']);
    });

    it('dispose 后不再登记(扩展停用不残留)', async () => {
        let count = 0;
        const q = createDiscoveryQueue({ timer: new FakeTimer(), onFlush: async () => { count++; } });
        q.dispose();
        q.schedule({ kind: 'full' });
        assert.strictEqual(q.pendingCount(), 0);
        await q.flushNow();
        assert.strictEqual(count, 0);
    });
});

describe('测试命名规则(唯一来源,B13)', () => {
    it('回归:过去 watcher 手写清单漏掉的形态(walk 会收,但不触发重扫)', () => {
        for (const name of ['Test_foo.py', 'TEST_foo.py', 'foo_Test.py', 'foo.TEST.py', 'foo.test.py', 'TEST_bar.cpp', 'bar_Test.cpp']) {
            assert.ok(TestDiscoveryUtils.isTestFileName(name), `${name} 应属发现面`);
        }
    });

    it('常规形态照旧被认(与旧 watcher 清单的交集不变)', () => {
        for (const name of ['test_a.py', 'a_test.py', 'test_b.cpp', 'b_test.cpp']) {
            assert.ok(TestDiscoveryUtils.isTestFileName(name), name);
        }
    });

    it('非测试名不认(普通模块 / 非 .py/.cpp 文件)', () => {
        for (const name of ['a.py', 'mytest.py', 'helper.cpp', 'test_a.txt', 'test_a.cc']) {
            assert.strictEqual(TestDiscoveryUtils.isTestFileName(name), false, name);
        }
    });
});

describe('用例增量 diff(planCaseDiff,B11)', () => {
    it('新增/删除/保留三分(保留项不在计划里 ⇒ 对象不动)', () => {
        const plan = TestDiscoveryUtils.planCaseDiff(['a', 'b', 'c'], ['b', 'c', 'd']);
        assert.deepStrictEqual(plan.toAdd, ['d']);
        assert.deepStrictEqual(plan.toRemove, ['a']);
    });

    it('参数化实例按 id 精确比对', () => {
        const plan = TestDiscoveryUtils.planCaseDiff(
            ['f::test_p[x]', 'f::test_p[y]'],
            ['f::test_p[x]', 'f::test_p[z]']
        );
        assert.deepStrictEqual(plan.toAdd, ['f::test_p[z]']);
        assert.deepStrictEqual(plan.toRemove, ['f::test_p[y]']);
    });

    it('完全一致 → 空计划(重扫不重建,保住 VS Code 侧状态)', () => {
        const plan = TestDiscoveryUtils.planCaseDiff(['a', 'b'], ['a', 'b']);
        assert.deepStrictEqual(plan, { toAdd: [], toRemove: [] });
    });
});

describe('产物目录过滤(pathHasExcludedDir,B13)', () => {
    const dirs = ['build', 'install', 'log'];
    const root = path.normalize('/ws');

    it('产物目录内的文件被过滤(与 walk 默认排除同口径)', () => {
        assert.ok(TestDiscoveryUtils.pathHasExcludedDir(path.join(root, 'build', 'p', 'test_a.py'), root, dirs));
        assert.ok(TestDiscoveryUtils.pathHasExcludedDir(path.join(root, 'install', 'p', 'lib', 'test_b.py'), root, dirs));
    });

    it('源目录内的文件放行', () => {
        assert.strictEqual(TestDiscoveryUtils.pathHasExcludedDir(path.join(root, 'src', 'p', 'test', 'test_a.py'), root, dirs), false);
    });

    it('只有"整段相等"才算命中(buildx / rebuild 不算)', () => {
        assert.strictEqual(TestDiscoveryUtils.pathHasExcludedDir(path.join(root, 'src', 'buildx', 'test_a.py'), root, dirs), false);
    });

    it('工作区外不判(交给别的闸)', () => {
        assert.strictEqual(TestDiscoveryUtils.pathHasExcludedDir(path.normalize('/other/test_a.py'), root, dirs), false);
    });
});

describe('launch_test 识别(B14)', () => {
    /** 用户给的最小示范(形态取自官方 talker_listener 样例) */
    const SRC = [
        'import unittest',
        'import launch',
        'import launch_testing',
        'import launch_testing.actions',
        'import pytest',
        '',
        '@pytest.mark.launch_test',
        'def generate_test_description():',
        '    return launch.LaunchDescription([launch_testing.actions.ReadyToTest()])',
        '',
        'class TestTalkerListener(unittest.TestCase):',
        '    def test_listener_receives_message(self, proc_output):',
        '        pass',
        ''
    ].join('\n');

    /* 2026-09-24(记录驱动):原"读文件内容判断是否 launch 测试"的两条断言(基于
       `isLaunchTestSource`)已删除 —— launch 类型现在由构建记录的 `LABELS "launch_test"` 给出,
       那是权威依据;未构建的测试不进树。新的断言见下面「构建记录驱动发现」一节。 */

    it('mark 检测(仅用于说明提示):有 / 无 @pytest.mark.launch_test', () => {
        assert.strictEqual(TestDiscoveryUtils.hasLaunchMark(SRC), true);
        assert.strictEqual(TestDiscoveryUtils.hasLaunchMark('def generate_test_description():\n    pass\n'), false);
    });
});

describe('launch_test 判定与产物分类(B14)', () => {
    it('launch_test:产物缺失 → errored;0 条 → errored;有产物 → report(退出码不参与)', () => {
        const missing = launchTestVerdict({ exitCode: 1, timedOut: false, artifactPresent: false, caseCount: 0, timeoutMs: 300000 });
        assert.strictEqual(missing.kind, 'errored');
        assert.ok(/produced no result file/.test((missing as { reason: string }).reason));
        assert.strictEqual(launchTestVerdict({ exitCode: 0, timedOut: false, artifactPresent: true, caseCount: 0, timeoutMs: 300000 }).kind, 'errored');
        assert.strictEqual(launchTestVerdict({ exitCode: 1, timedOut: false, artifactPresent: true, caseCount: 2, timeoutMs: 300000 }).kind, 'report');
    });

    it('classifyArtifact:*.gtest.xml / *.xunit.xml / 其它', () => {
        assert.strictEqual(classifyArtifact('test_entries.gtest.xml'), 'gtest');
        assert.strictEqual(classifyArtifact('test_talker_launch_test.xunit.xml'), 'junit');
        assert.strictEqual(classifyArtifact('pytest.xml'), undefined);
        assert.strictEqual(classifyArtifact('CTestTestfile.cmake'), undefined);
    });
});

describe('gtest 套件名推导(gtestSuiteOf,B14-fix)', () => {
    it('普通宏:classname 就是套件名', () => {
        assert.strictEqual(gtestSuiteOf('EntryBasic'), 'EntryBasic');
        assert.strictEqual(gtestSuiteOf('AdderTest'), 'AdderTest');
    });

    it('TEST_P:实例化前缀在前,取末段', () => {
        assert.strictEqual(gtestSuiteOf('AdderCases/AdderParamTest'), 'AdderParamTest');
    });

    it('colcon 侧产物带 `<包名>.` 前缀(实测形态),要剥掉', () => {
        assert.strictEqual(gtestSuiteOf('p10_mix_deps_std.AdderTest'), 'AdderTest');
        assert.strictEqual(gtestSuiteOf('p10_mix_deps_std.CubicTest/0'), 'CubicTest');
        assert.strictEqual(gtestSuiteOf('p10_mix_deps_std.IntGroup/CalcTest/0'), 'CalcTest');
        assert.strictEqual(gtestSuiteOf('p10_mix_deps_std.AdderCases/AdderParamTest'), 'AdderParamTest');
    });

    it('TYPED_TEST / TYPED_TEST_P:末段是纯数字索引,要剥掉', () => {
        assert.strictEqual(gtestSuiteOf('CubicTest/0'), 'CubicTest');
        assert.strictEqual(gtestSuiteOf('IntGroup/CalcTest/0'), 'CalcTest');
        assert.strictEqual(gtestSuiteOf('FloatGroup/CalcTest/1'), 'CalcTest');
    });
});

/**
 * 记录驱动发现的实物夹具(2026-09-24,VM `build/p10_mix_deps_std/CTestTestfile.cmake` 逐字,仅收敛路径):
 *   · gtest 两条(`test_adder` / `test_entries`,含 `_BACKTRACE_TRIPLES` 指向 CMakeLists 226/229);
 *   · launch 一条(源文件路径写在 `--command` 里,`LABELS "launch_test"`,声明在 234)。
 */
const CTEST_GTEST_LAUNCH_SAMPLE = [
    'add_test([=[test_entries]=] "/usr/bin/python3" "-u" "/opt/ros/humble/share/ament_cmake_test/cmake/run_test.py" "/ws/build/p10/test_results/p10/test_entries.gtest.xml" "--package-name" "p10" "--output-file" "/ws/build/p10/ament_cmake_gtest/test_entries.txt" "--command" "/ws/build/p10/test_entries" "--gtest_output=xml:/ws/build/p10/test_results/p10/test_entries.gtest.xml")',
    'set_tests_properties([=[test_entries]=] PROPERTIES  LABELS "gtest" REQUIRED_FILES "/ws/build/p10/test_entries" TIMEOUT "60" WORKING_DIRECTORY "/ws/build/p10" _BACKTRACE_TRIPLES "/opt/ros/humble/share/ament_cmake_test/cmake/ament_add_test.cmake;125;add_test;/opt/ros/humble/share/ament_cmake_gtest/cmake/ament_add_gtest_test.cmake;86;ament_add_test;/opt/ros/humble/share/ament_cmake_gtest/cmake/ament_add_gtest.cmake;93;ament_add_gtest_test;/ws/src/p10/CMakeLists.txt;229;ament_add_gtest;/ws/src/p10/CMakeLists.txt;0;")',
    'add_test([=[test_talker_listener_launch_test.py]=] "/usr/bin/python3" "-u" "/opt/ros/humble/share/ament_cmake_test/cmake/run_test.py" "/ws/build/p10/test_results/p10/test_talker_listener_launch_test.py.xunit.xml" "--package-name" "p10" "--output-file" "/ws/build/p10/launch_test/x.txt" "--command" "/usr/bin/python3" "-m" "launch_testing.launch_test" "/ws/src/p10/test/talker_listener_launch_test.py" "--junit-xml=/ws/build/p10/test_results/p10/test_talker_listener_launch_test.py.xunit.xml" "--package-name=p10")',
    'set_tests_properties([=[test_talker_listener_launch_test.py]=] PROPERTIES  LABELS "launch_test" TIMEOUT "60" WORKING_DIRECTORY "/ws/build/p10" _BACKTRACE_TRIPLES "/opt/ros/humble/share/ament_cmake_test/cmake/ament_add_test.cmake;125;add_test;/opt/ros/humble/share/launch_testing_ament_cmake/cmake/add_launch_test.cmake;131;ament_add_test;/ws/src/p10/CMakeLists.txt;234;add_launch_test;/ws/src/p10/CMakeLists.txt;0;")',
].join('\n');

describe('构建记录驱动发现(C++ / launch 的名单来自 CTestTestfile,2026-09-24)', () => {
    const regs = parseCTestTestfileText(CTEST_GTEST_LAUNCH_SAMPLE).registrations;

    it('类型判定来自 LABELS(gtest / launch_test),不靠文件名或文件内容', () => {
        const gtest = regs.find((r) => r.name === 'test_entries');
        const launch = regs.find((r) => r.name === 'test_talker_listener_launch_test.py');
        assert.ok(gtest !== undefined && isGtestRegistration(gtest) && !isLaunchTestRegistration(gtest));
        assert.ok(launch !== undefined && isLaunchTestRegistration(launch) && !isGtestRegistration(launch));
    });

    it('launch:源文件路径直接来自 --command(记录即权威,无需内容嗅探)', () => {
        const launch = regs.find((r) => r.name === 'test_talker_listener_launch_test.py');
        assert.strictEqual(launchTestSourceOf(launch!), '/ws/src/p10/test/talker_listener_launch_test.py');
        assert.strictEqual(launch!.packageName, 'p10');
        assert.ok(launch!.junitXmlPath !== undefined && launch!.junitXmlPath.endsWith('.xunit.xml'));
    });

    it('--command 参数完整保留(第一个参数仍是可执行,兼容既有消费方)', () => {
        const gtest = regs.find((r) => r.name === 'test_entries');
        assert.strictEqual(gtest!.exePath, '/ws/build/p10/test_entries');
        const one = parseCTestTestfileText('add_test([=[x]=] "--command" "/a/b" "-m" "mod" "/c.py")').registrations[0];
        assert.deepStrictEqual(one.command, ['/a/b', '-m', 'mod', '/c.py']);
    });

    it('声明行反查:取最后一条 CMakeLists 三元组(跳过行号 0 的结束标记)', () => {
        const gtest = regs.find((r) => r.name === 'test_entries');
        const decl = declarationOf(gtest!);
        assert.ok(decl !== undefined);
        assert.strictEqual(decl!.line, 229);
        assert.strictEqual(decl!.macro, 'ament_add_gtest');
        assert.ok(decl!.file.endsWith('/ws/src/p10/CMakeLists.txt'));
        assert.strictEqual(declarationOf(regs.find((r) => r.name === 'test_talker_listener_launch_test.py')!)!.line, 234);
    });

    it('声明行取源文件:只认第一条配对完整的语句(真机反例:后面紧跟 target_link_libraries 与注释)', () => {
        const cmake = [
            '# 头部注释(这里的 demo.cpp 不该被当参数)',
            'if(BUILD_TESTING)',
            '  ament_add_gtest(test_adder test/test_adder.cpp)',
            '  target_link_libraries(test_adder p10_mix_deps_std)',
            '  ## 入口宏示范 (TEST_F/TEST_P/TYPED_TEST/...)',
            '  ament_add_gtest(test_entries test/test_gtest_entries.cpp)',
            'endif()',
        ].join('\n');
        assert.strictEqual(sourceArgAtDeclaration(cmake, 3), 'test/test_adder.cpp');
        assert.strictEqual(sourceArgAtDeclaration(cmake, 6), 'test/test_gtest_entries.cpp');
    });

    it('含 ${VAR} 的参数跳过(本层不解析变量);折行声明也能取到', () => {
        assert.strictEqual(sourceArgAtDeclaration('ament_add_gtest(${PROJECT_NAME}_t  test/${NAME}.cpp  src/helper.cpp)', 1), 'src/helper.cpp');
        const multiline = ['ament_add_gtest(test_x', '  test/multi_line.cpp)', ''].join('\n');
        assert.strictEqual(sourceArgAtDeclaration(multiline, 1), 'test/multi_line.cpp');
    });

    it('parseBacktrace:三元组解析(尾部残缺项忽略)', () => {
        const bt = parseBacktrace('/a/b.cmake;1;foo;/ws/src/p/CMakeLists.txt;234;add_launch_test;/ws/src/p/CMakeLists.txt;0;');
        assert.deepStrictEqual(bt, [
            { file: '/a/b.cmake', line: 1, macro: 'foo' },
            { file: '/ws/src/p/CMakeLists.txt', line: 234, macro: 'add_launch_test' },
            { file: '/ws/src/p/CMakeLists.txt', line: 0, macro: '' }
        ]);
    });
});

/**
 * 编码规则的**实物夹具**:用本机 cmake 3.22.1 生成(`/tmp/qtest`,见 B17 的源码依据)。
 * 覆盖:名字含连续 `=`(括号层数 = 1+最长连续 `=`)、值含反斜杠/引号/`$`/`;`/空格/空串、
 * 多标签(`LABELS "gtest;extra"`)、`WORKING_DIRECTORY` 含反斜杠。
 */
const CTEST_QUOTING_SAMPLE = `
add_test([=[plain_name]=] "/bin/echo" "hello")
set_tests_properties([=[plain_name]=] PROPERTIES  _BACKTRACE_TRIPLES "/tmp/qtest/CMakeLists.txt;4;add_test;/tmp/qtest/CMakeLists.txt;0;")
add_test([===[eq==name]===] "/bin/echo" "x")
set_tests_properties([===[eq==name]===] PROPERTIES  _BACKTRACE_TRIPLES "/tmp/qtest/CMakeLists.txt;5;add_test;/tmp/qtest/CMakeLists.txt;0;")
add_test([=[backslash_arg]=] "/bin/echo" "C:\path\to thing")
set_tests_properties([=[backslash_arg]=] PROPERTIES  LABELS "gtest;extra" TIMEOUT "60" WORKING_DIRECTORY "/tmp/x\\y" _BACKTRACE_TRIPLES "/tmp/qtest/CMakeLists.txt;6;add_test;/tmp/qtest/CMakeLists.txt;0;")
add_test([=[quote_arg]=] "/bin/echo" "say \\"hi\\"")
set_tests_properties([=[quote_arg]=] PROPERTIES  _BACKTRACE_TRIPLES "/tmp/qtest/CMakeLists.txt;7;add_test;/tmp/qtest/CMakeLists.txt;0;")
add_test([=[dollar_arg]=] "/bin/echo" "$HOME" "a;b")
set_tests_properties([=[dollar_arg]=] PROPERTIES  LABELS "gtest" _BACKTRACE_TRIPLES "/tmp/qtest/CMakeLists.txt;8;add_test;/tmp/qtest/CMakeLists.txt;0;")
add_test([=[empty_args]=] "/bin/echo" "" "tail")
set_tests_properties([=[empty_args]=] PROPERTIES  _BACKTRACE_TRIPLES "/tmp/qtest/CMakeLists.txt;9;add_test;/tmp/qtest/CMakeLists.txt;0;")
`;

describe('CTestTestfile 词法稳健性(B17:按 CMake 生成器源码定规则)', () => {
    const parsed = parseCTestTestfileText(CTEST_QUOTING_SAMPLE);

    it('全部语句按词法吃下(0 条 unparsed)', () => {
        assert.strictEqual(parsed.registrations.length, 6);
        assert.strictEqual(parsed.unparsed, 0);
    });

    it('名字:括号层数随名字里的连续 `=` 增长(老正则只认 `[=[…]=]` 会切错)', () => {
        assert.ok(parsed.registrations.some((r) => r.name === 'eq==name'));
        assert.ok(parsed.registrations.some((r) => r.name === 'plain_name'));
    });

    it('值:唯一转义是 \\"，反斜杠/`$`/`;`/空格/空串原样保留', () => {
        const byName = new Map(parsed.registrations.map((r) => [r.name, r]));
        assert.deepStrictEqual(byName.get('quote_arg')!.command, ['/bin/echo', 'say "hi"']);
        assert.deepStrictEqual(byName.get('backslash_arg')!.command, ['/bin/echo', 'C:\path\to thing']);
        assert.deepStrictEqual(byName.get('dollar_arg')!.command, ['/bin/echo', '$HOME', 'a;b']);
        assert.deepStrictEqual(byName.get('empty_args')!.command, ['/bin/echo', '', 'tail']);
    });

    it('属性:LABELS 按 `;` 拆开;TIMEOUT 数字化;WORKING_DIRECTORY 原样含反斜杠', () => {
        const reg = parsed.registrations.find((r) => r.name === 'backslash_arg')!;
        assert.deepStrictEqual(reg.labels, ['gtest', 'extra']);
        assert.strictEqual(reg.timeoutSec, 60);
        // 真机实物:CMake **不转义反斜杠** ⇒ 文件里是 2 个反斜杠,运行时值也是 2 个
        assert.strictEqual(reg.workingDirectory, '/tmp/x\\y');
    });

    it('NOT_AVAILABLE 占位行:标记为不可运行,不当成命令', () => {
        const one = parseCTestTestfileText('add_test([=[x]=] NOT_AVAILABLE)').registrations[0];
        assert.strictEqual(one.notAvailable, true);
        assert.deepStrictEqual(one.command, []);
    });

    it('CMP0110 OLD 的裸名字形态也能收', () => {
        const one = parseCTestTestfileText('add_test(bare_name "/bin/echo" "hi")').registrations[0];
        assert.strictEqual(one.name, 'bare_name');
        assert.deepStrictEqual(one.command, ['/bin/echo', 'hi']);
    });

    it('`--package-name v` 与 `--package-name=v` 两种写法都收;`--gtest_output=xml:` 剥子前缀', () => {
        const a = parseCTestTestfileText('add_test([=[x]=] "--package-name" "p1")').registrations[0];
        const b = parseCTestTestfileText('add_test([=[y]=] "--package-name=p1")').registrations[0];
        assert.strictEqual(a.packageName, 'p1');
        assert.strictEqual(b.packageName, 'p1');
        const g = parseCTestTestfileText('add_test([=[z]=] "/x" "--gtest_output=xml:/tmp/r.xml")').registrations[0];
        assert.strictEqual(g.gtestXmlPath, '/tmp/r.xml');
    });
});
