// Licensed under the MIT License.

/**
 * @file gtest-filter.ts
 * `--gtest_filter` 真名拼装(2026-09-24 测试改造 B2/B6)。
 *
 * 为什么单独成文件:**这是纯逻辑,必须可无头单测**(B6.5 的 filter 矩阵);
 * 放在 `RosTestRunner` 里就得拉起整个 vscode/ros2 依赖链,单测跑不动。
 *
 * 真名规则(gtest):`<实例化前缀>/<套件>.<用例>/<索引>`,四类宏各取所需 ——
 *   TEST / TEST_F / GTEST_TEST → `套件.用例`
 *   TEST_P                      → 前缀通配 + `套件.用例` + 索引通配(实测 3 tests)
 *   TYPED_TEST / TYPED_TEST_F   → `套件` + 类型索引通配 + `.用例`(实测 3 tests)
 *   TYPED_TEST_P                → 比 TYPED_TEST **多一层实例化前缀**(实测 4 tests;两者不可混用)
 * 文件级(无 testMethod)→ 不设 filter,全量跑。
 */

import { CppMacroKind } from "../provider/ros-test-provider";

/** filter 拼装所需的字段(与 RosTestData 的结构子集) */
export interface GTestFilterInput {
    testClass?: string;
    testMethod?: string;
    cppMacro?: CppMacroKind;
}

/**
 * 由用例数据推出 `--gtest_filter` 的值;`undefined` = 不加 filter(文件级)。
 */
export function buildGTestFilter(testData: GTestFilterInput): string | undefined {
    const suite = testData.testClass;
    const name = testData.testMethod;
    if (name === undefined || name === '') {
        return suite === undefined || suite === '' ? undefined : `${suite}.*`;
    }
    if (suite === undefined || suite === '') {
        return name;
    }
    switch (testData.cppMacro) {
        case 'TEST_P':
            return `*/${suite}.${name}/*`;
        case 'TYPED_TEST':
        case 'TYPED_TEST_F':
            return `${suite}/*.${name}`;
        case 'TYPED_TEST_P':
            return `*/${suite}/*.${name}`;
        default:
            return `${suite}.${name}`;
    }
}

/**
 * 从 gtest XML 的 `classname` 反推**套件名**(B14-fix)。
 *
 * 实测的四种形态(见 E5/14:40 批次的真机 XML):
 *   · `EntryBasic`                → `EntryBasic`        (TEST / TEST_F / GTEST_TEST)
 *   · `AdderCases/AdderParamTest` → `AdderParamTest`    (TEST_P:实例化前缀在**前**)
 *   · `CubicTest/0`               → `CubicTest`         (TYPED_TEST:类型索引在**后**,且是纯数字)
 *   · `IntGroup/CalcTest/0`       → `CalcTest`          (TYPED_TEST_P:前缀 + 套件 + 索引)
 *
 * 旧实现只取 `split('/').pop()` ⇒ 类型化测试拿到的是 `0`,映射永远不中、
 * 结果被静默聚合到文件项(真机实证:26 条用例只落到 2 个目标项)。
 */
export function gtestSuiteOf(classname: string): string {
    const parts = classname.split('/');
    if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
        parts.pop();
    }
    const last = parts[parts.length - 1];
    // colcon 侧注册命令产出的 classname 带 `<包名>.` 前缀(实测 `p10_mix_deps_std.AdderTest`),
    // 而本扩展自己直跑的没有该前缀 ⇒ 两种都要能对上(真机:不带此剥离时 26 条用例只有 11 条命中)。
    const dot = last.lastIndexOf('.');
    return dot >= 0 ? last.slice(dot + 1) : last;
}
