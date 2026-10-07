// Licensed under the MIT License.

import { l10n } from 'vscode'; // 2026-10-04 i18n 期2
/**
 * @file result-semantics.ts
 * 退出码 / 产物 → 结论 的**纯逻辑**(2026-09-24 测试改造 B6)。
 *
 * 为什么单独成文件:这套判定是整条链最容易错的地方(实测三种"谎"),必须可无头单测(B6.5 第 7 组):
 *   - pytest:退出码 `4`/`5` = 用法错误/未收集到用例(**不是**用例失败);产物缺失 = 没跑起来;
 *     产物有 0 条 = 同理;
 *   - gtest:退出码**恒 0**,连"0 命中"也是 0(E1 前的假绿来源)⇒ 只能看产物条数;
 *   - 两者都:**判定以产物为准,退出码只用于识别"没跑起来"**。
 */

/** 一条链路的判定结论 */
export type RunVerdict =
    | { kind: "report" }
    | { kind: "errored"; reason: string };

/** pytest 的判定输入 */
export interface PytestVerdictInput {
    exitCode: number | undefined;
    timedOut: boolean;
    /** `--junitxml` 产物是否存在/可读 */
    artifactPresent: boolean;
    /** 产物里解析出的用例条数 */
    caseCount: number;
    timeoutMs: number;
}

/** pytest:0/1 = 真跑过(1 = 有用例失败);4/5 = 用法错误/未收集;产物缺失或 0 条 = 没跑起来 */
export function pytestVerdict(input: PytestVerdictInput): RunVerdict {
    const exitCode = input.exitCode;
    if (exitCode === 4 || exitCode === 5) {
        return { kind: "errored", reason: l10n.t("pytest collected no cases / usage error (exit code {0}); check the selector and test files", exitCode) };
    }
    if (!input.artifactPresent) {
        const why = input.timedOut ? l10n.t("timeout ({0} s)", Math.round(input.timeoutMs / 1000)) : `退出码 ${exitCode}`;
        return { kind: "errored", reason: l10n.t("pytest produced no result file ({0})", why) };
    }
    if (input.caseCount === 0) {
        return { kind: "errored", reason: l10n.t("pytest result empty (0 cases, exit code {0})", exitCode) };
    }
    return { kind: "report" };
}

/** gtest 的判定输入 */
export interface GtestVerdictInput {
    exitCode: number | undefined;
    timedOut: boolean;
    /** `--gtest_output=xml` 产物是否存在/可读 */
    artifactPresent: boolean;
    /** 产物里解析出的用例条数 */
    caseCount: number;
    timeoutMs: number;
}

/** gtest:退出码不可信(0 命中也是 0)⇒ 只认产物;产物缺失或 0 条 = errored(假绿防护) */
export function gtestVerdict(input: GtestVerdictInput): RunVerdict {
    if (!input.artifactPresent) {
        const why = input.timedOut ? l10n.t("timeout ({0} s)", Math.round(input.timeoutMs / 1000)) : `退出码 ${input.exitCode}`;
        return { kind: "errored", reason: l10n.t("gtest produced no result file ({0})", why) };
    }
    if (input.caseCount === 0) {
        return { kind: "errored", reason: l10n.t("gtest result has 0 cases (selector missed / cases not registered) — reported as errored to avoid a false green") };
    }
    return { kind: "report" };
}

/** 包级判定输入(B7.3:零产物必须分辨成因) */
export interface PackageVerdictInput {
    /** 包名(仅用于消息) */
    pkg: string;
    /** `build/<pkg>` 是否存在 */
    buildDirPresent: boolean;
    /** 包源码目录下是否有 COLCON_IGNORE 标记 */
    colconIgnorePresent: boolean;
    /** 收集到的产物文件数(`build/<pkg>/pytest.xml` + `*.gtest.xml`) */
    artifactCount: number;
    /** 产物里解析出的用例条数 */
    caseCount: number;
    /** 产物是否为 colcon 的占位结果(`pytest.missing_result` 单条,见 hasMissingResultSentinel) */
    missingResultSentinel: boolean;
    exitCode: number | undefined;
    timedOut: boolean;
    timeoutMs: number;
}

/**
 * 包级(colcon test)判定:判定仍只认官方产物,但**零产物的成因必须分辨**——
 * 用户实测困惑:"未产出测试结果(colcon 退出码 0)"对 holle(带 COLCON_IGNORE、本无测试)是误导。
 * 分支顺序即优先级:超时 → 被忽略(最能解释"永远测不了") → 未构建(可操作) → 无产物 → 产物 0 条。
 */
export function packageVerdict(input: PackageVerdictInput): RunVerdict {
    const secs = Math.round(input.timeoutMs / 1000);
    if (input.timedOut) {
        return { kind: "errored", reason: l10n.t("Package {0} tests timed out ({1} s); process terminated", input.pkg, secs) };
    }
    if (input.colconIgnorePresent) {
        return { kind: "errored", reason: l10n.t("Package {0} carries a COLCON_IGNORE marker: colcon will not build/test it (remove the marker and retry)", input.pkg) };
    }
    if (!input.buildDirPresent) {
        return { kind: "errored", reason: l10n.t("Package {0} is not built yet: run colcon build {0} first", input.pkg) };
    }
    if (input.artifactCount === 0) {
        return { kind: "errored", reason: l10n.t("Package {0} has no test artifacts: no tests registered, or testing was not enabled at build time (rebuild with -DBUILD_TESTING=ON)", input.pkg) };
    }
    if (input.missingResultSentinel) {
        return { kind: "errored", reason: l10n.t("pytest of package {0} produced no real result (colcon placeholder kept): the test process may have crashed early; check the output panel", input.pkg) };
    }
    if (input.caseCount === 0) {
        return { kind: "errored", reason: l10n.t("Test artifacts of package {0} contain 0 cases (colcon exit code {1})", input.pkg, input.exitCode) };
    }
    return { kind: "report" };
}

/**
 * colcon 的 Python 测试任务会**先写一份占位结果**(`colcon_core/task/python/test/pytest.py:142-151`:
 * 1 条 `pytest.missing_result` 的 failed),pytest 真跑完才覆盖它。
 * 若 pytest 提前崩溃(占位留存),按产物解析会报出**一条名为 pytest.missing_result 的假失败**——
 * 识别它,改按 errored 上报。
 */
export function hasMissingResultSentinel(cases: Array<{ name: string }>): boolean {
    return cases.length === 1 && cases[0].name === "pytest.missing_result";
}

/** 包级"运行前置闸门"的判定输入(B8) */
export interface PackagePreflightInput {
    /** 包名(仅用于消息) */
    pkg: string;
    /** 包源码目录下是否有 COLCON_IGNORE 标记 */
    colconIgnorePresent: boolean;
    /** `build/<pkg>` 是否存在 */
    buildDirPresent: boolean;
}

/**
 * 包级运行的前置闸门(B8):**在 spawn colcon 之前**判定,不满足就**不启动任何进程**。
 *
 * 依据(E4:colcon 源码 + 真机实跑,**两类包都必然失败**,故这是事实判断而非策略选择):
 *   - `COLCON_IGNORE`:colcon 完全忽略该包(`ignoring unknown package`)→ 必然零产物;
 *   - 未构建 —— C++:`colcon_cmake/task/cmake/test.py:44` `assert os.path.exists(build_base)`
 *     直接崩("Has this package been built before?");Python:任务前置需要包的环境脚本
 *     `install/<pkg>/share/<pkg>/package.sh`,实跑报 "Check that the following packages have been built"
 *     且零产物(`colcon test` 不负责构建,官方流程是 build → test 分离)。
 *   - 出路:先构建;或**只想跑单个文件/用例就直接点它**(文件/用例级不经此闸门)。
 */
export function packagePreflight(input: PackagePreflightInput): RunVerdict {
    if (input.colconIgnorePresent) {
        return { kind: "errored", reason: l10n.t("Package {0} carries a COLCON_IGNORE marker: colcon will not build/test it (remove the marker and retry)", input.pkg) };
    }
    if (!input.buildDirPresent) {
        return {
            kind: "errored",
            reason: l10n.t("Package {0} is not built yet: colcon test needs build artifacts (run colcon build {0} first; to run a single file/case just click it directly, bypassing this gate)", input.pkg)
        };
    }
    return { kind: "report" };
}

/** 包节点"说明项"的判定输入(B7.4 / B9) */
export interface PackageNoteInput {
    /** 包名(用于"尚未构建"的指引文案) */
    pkg: string;
    /** 包源码目录下是否有 COLCON_IGNORE 标记 */
    colconIgnorePresent: boolean;
    /** `build/<pkg>` 是否存在 */
    buildDirPresent: boolean;
    /** 该包节点下已挂载的测试子项数(文件项个数) */
    childCount: number;
}

/**
 * 包节点的**静态说明**(B7.4/B9):让每个包节点都可展开,展开即见"为什么这里没有测试/不能运行"。
 * 优先级:COLCON_IGNORE → 无测试文件 → 未构建。
 *   · COLCON_IGNORE 在前 —— 它解释"为什么连构建都不会发生",比"无测试文件"更根本;
 *   · "无测试文件"排在"未构建"前 —— 没有测试时构建也救不了,提示构建是误导。
 *
 * 注意:这是**发现时刻的快照**(B9 起由 build 目录 watcher 在构建完成后自动重扫);
 * 运行期仍以 `packageVerdict` / `packagePreflight` 为准。
 */
export function packageNote(input: PackageNoteInput): string | undefined {
    if (input.colconIgnorePresent) {
        return l10n.t("Carries a COLCON_IGNORE marker (colcon will not build/test this package)");
    }
    if (input.childCount === 0) {
        return l10n.t("This package has no test files");
    }
    if (!input.buildDirPresent) {
        return l10n.t("Not built yet (this package becomes runnable after colcon build {0})", input.pkg);
    }
    return undefined;
}

/** 包节点"可运行"判定输入(B9) */
export interface PackageRunnableInput {
    colconIgnorePresent: boolean;
    buildDirPresent: boolean;
    /** 发现层挂到该包下的测试文件项数 */
    testFileCount: number;
}

/**
 * 包节点是否**可运行**(B9):决定是否给它打 `runnable` 标签(无标签 ⇒ 无运行按钮、Run All 跳过)。
 *
 * 三条与"没得跑"的事实严格对应(E4 已证"未构建 ⇒ colcon test 必失败"):
 *   ① 被 `COLCON_IGNORE` 忽略 —— colcon 完全忽略该包;
 *   ② 未构建 —— C++ 侧 colcon 直接 assert 崩、Python 侧缺 `package.sh` 走不到测试;
 *   ③ 本包没有已发现的测试 —— 跑了也只会有"没有测试产物"。
 * 与 `packagePreflight` 的关系:闸门管**运行期**真值(两条),本函数管**入口可见性**(三条);
 * 第三条不进闸门 —— 避免把"我们没发现"误判成"禁止运行"(launch_testing 早期就吃过这个亏)。
 */
export function isPackageRunnable(input: PackageRunnableInput): boolean {
    return !input.colconIgnorePresent
        && input.buildDirPresent
        && input.testFileCount > 0;
}

/** launch_test 的判定输入(B14) */
export interface LaunchTestVerdictInput {
    exitCode: number | undefined;
    timedOut: boolean;
    /** `--junit-xml` 产物是否存在/可读 */
    artifactPresent: boolean;
    caseCount: number;
    timeoutMs: number;
}

/**
 * launch_test(B14)判定:走 `python3 -m launch_testing.launch_test … --junit-xml=<path>`
 * (**与 colcon 注册命令逐字同源**,见 add_launch_test.cmake)。
 * 退出码语义与 pytest 不同(pytest 的 4/5 是它自己的收集语义)⇒ 只看产物:
 * 产物缺失 = 没跑起来;产物存在但 0 条用例 = 没断言可报。
 */
export function launchTestVerdict(input: LaunchTestVerdictInput): RunVerdict {
    if (!input.artifactPresent) {
        const why = input.timedOut ? l10n.t("timeout ({0} s)", Math.round(input.timeoutMs / 1000)) : `退出码 ${input.exitCode}`;
        return { kind: "errored", reason: l10n.t("launch_test produced no result file ({0})", why) };
    }
    if (input.caseCount === 0) {
        return { kind: "errored", reason: l10n.t("launch_test result has 0 cases — check that the test file contains ReadyToTest() and case methods") };
    }
    return { kind: "report" };
}

/**
 * 测试产物按文件名分类(B14)。两种官方后缀都收:
 *   · `*.gtest.xml` —— gtest(`ament_add_gtest`);
 *   · `*.xunit.xml` —— launch_test / 其它 ament 测试(`AMENT_TEST_RESULTS_DIR/<pkg>/<TARGET>.xunit.xml`)。
 */
export function classifyArtifact(fileName: string): "gtest" | "junit" | undefined {
    if (fileName.endsWith(".gtest.xml")) {
        return "gtest";
    }
    if (fileName.endsWith(".xunit.xml")) {
        return "junit";
    }
    return undefined;
}
