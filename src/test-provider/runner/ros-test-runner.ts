// Licensed under the MIT License.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import { composeApi } from "../../ros2/api";
import { ExecutableResolver } from "../../install-truth/api";
// 2026-09-24:改用**共享**的 build-map 数据中心(与侧边栏同一实例 ⇒ 消双份全量扫描;
// 并因 shared-center 已接电构建 watcher,`colcon build` 之后映射会正确置脏、不再是旧快照)
import { acquireSharedBuildCenter } from "../../install-truth/center/shared-center";
import { TestType, RosTestData } from "../provider/ros-test-provider";
import { ParsedCase, ParsedSuite, parseGtestXml, parseJunitXml } from "../parsing/test-results-parser";
import { parseCTestTestfile } from "../parsing/ctest-testfile-parser";
import { nextArtifactPath } from "./artifact-path";
import { buildGTestFilter } from "../semantics/gtest-filter";
import { classifyArtifact, gtestVerdict, hasMissingResultSentinel, launchTestVerdict, packagePreflight, packageVerdict, pytestVerdict } from "../semantics/result-semantics";
import { reportCases } from "../reporting/run-report";

import { getLogger } from "../../logger";

/** 测试运行模块日志 */
const log = getLogger("test-runner");

/**
 * 一次进程执行的规格(2026-09-24 测试改造 B1,计划 §3-B1)。
 * 关键点:`xmlPath` 是**结果真值**的落点;`onChunk` 负责把输出回灌给「测试结果」面板。
 */
interface ExecSpec {
    command: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    xmlPath?: string;
    onChunk?: (chunk: string) => void;
    cancellation?: vscode.CancellationToken;
}

/** 进程执行结果 —— 只描述"跑成什么样",不描述"测试过没过" */
interface ExecOutcome {
    exitCode: number | undefined;
    timedOut: boolean;
}

/**
 * Handles running and debugging ROS 2 tests using existing launch mechanisms
 */
export class RosTestRunner {

    /** install-truth 解析器(B2:测试可执行定位);按工作区根缓存,换根重建 */
    private resolver: ExecutableResolver | undefined;
    private resolverRoot: string | undefined;

    /** 取(必要时建)工作区对应的 install-truth 解析器(2026-09-24:挂在**共享**数据中心上) */
    private ensureResolver(workspaceRoot: string): ExecutableResolver {
        if (this.resolver === undefined || this.resolverRoot !== workspaceRoot) {
            const shared = acquireSharedBuildCenter(workspaceRoot);
            this.resolver = new ExecutableResolver(shared.center);
            this.resolverRoot = workspaceRoot;
            log.info(vscode.l10n.t("Test executable resolver bound to workspace: {0} (shared build-map center)", workspaceRoot));
        }
        return this.resolver;
    }

    /** 释放解析器引用(B2;数据中心是**共享**的,由 shared-center 统一释放) */
    public dispose(): void {
        this.resolver = undefined;
        this.resolverRoot = undefined;
    }

    /**
     * Run a test using the appropriate ROS 2 mechanism
     */
    async runTest(
        testData: RosTestData,
        run?: vscode.TestRun,
        testItem?: vscode.TestItem,
        onChunk?: (chunk: string) => void,
        cancellation?: vscode.CancellationToken
    ): Promise<void> {
        log.debug(vscode.l10n.t("Running test: type={0}, file={1}", testData.type, testData.filePath));
        if (testData.kind === 'package') {
            // B5 之前包级运行未接线(provider 不会把包节点送到这里;防御性拦截,不静默跑错东西)
            throw new Error(vscode.l10n.t("Package-level test run not wired up yet (package {0})", testData.packageName ?? '?'));
        }
        switch (testData.type) {
            case TestType.PythonPytest:
                return this.runFileOrCase(testData, run, testItem, onChunk, cancellation);
            case TestType.CppGtest:
                return this.runCppTest(testData, run, testItem, onChunk, cancellation);
            case TestType.LaunchTest:
                return this.runLaunchTestFile(testData, run, testItem, onChunk, cancellation);
            default:
                throw new Error(vscode.l10n.t("Unsupported test type: {0}", testData.type));
        }
    }

    /** 环境门槛(T9):不可用 → `errored` + 可读原因(复用 environment 域唯一判定 `getEnvIssue`) */
    private rejectIfNoEnv(run: vscode.TestRun | undefined, testItem: vscode.TestItem | undefined): boolean {
        const envIssue = composeApi.environment.getEnvIssue();
        if (envIssue === null) {
            return false;
        }
        this.errorOn(
            run,
            testItem,
            vscode.l10n.t("No usable ROS 2 environment detected; cannot run tests. Reason: {0}. Configure and activate a ROS environment (ROS2.rosSetupScript / ROS2.pixiRoot) first, then retry.", envIssue)
        );
        return true;
    }

    /** 统一的 errored 上报(A2:与"用例失败"分级) */
    private errorOn(run: vscode.TestRun | undefined, testItem: vscode.TestItem | undefined, text: string): void {
        log.warn(text);
        if (run !== undefined && testItem !== undefined) {
            run.errored(testItem, new vscode.TestMessage(text));
        }
    }

    /** 读产物文件;不存在/不可读 → undefined */
    private async readArtifact(xmlPath: string): Promise<string | undefined> {
        try {
            return await fs.promises.readFile(xmlPath, 'utf8');
        } catch {
            return undefined;
        }
    }

    /** 删临时产物(尽力而为,失败不影响结果) */
    private async removeArtifact(xmlPath: string): Promise<void> {
        try {
            await fs.promises.unlink(xmlPath);
        } catch {
            // 忽略:临时文件清理失败不改变测试结论
        }
    }

    /**
     * 包级运行(B5,计划 §0.1 三粒度之"包"):**官方栈那一层** = `colcon test --packages-select <pkg>`,
     * 判定解析官方产物(不读退出码 —— 实测恒 0)。
     *
     * 产物落点(E2 裁定,VM 实测):
     *   - ament_python:`build/<pkg>/pytest.xml`(junit;`build/<pkg>/test_results/` 为空);
     *   - ament_cmake/gtest:`build/<pkg>/test_results/<pkg>/*.gtest.xml`。
     * `--return-code-on-test-failure`(E3:Humble 支持)仅作日志辅助,不参与判定。
     */
    async runPackageTests(
        testData: RosTestData,
        run: vscode.TestRun | undefined,
        pkgItem: vscode.TestItem | undefined,
        scope: { py: vscode.TestItem[]; cpp: vscode.TestItem[]; launch: vscode.TestItem[] },
        onChunk?: (chunk: string) => void,
        cancellation?: vscode.CancellationToken
    ): Promise<void> {
        const pkg = testData.packageName;
        if (pkg === undefined || pkg === '') {
            this.errorOn(run, pkgItem, vscode.l10n.t('Package-level run missing package name; giving up'));
            return;
        }
        if (this.rejectIfNoEnv(run, pkgItem)) {
            return;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) {
            this.errorOn(run, pkgItem, vscode.l10n.t('No workspace folder found; package-level run aborted'));
            return;
        }

        const env = await composeApi.environment.resolvedEnv();
        const timeoutMs = 900000; // 包级测试含编译/启动开销:15 分钟

        // ---- B8 前置闸门:**spawn 之前**判定,不满足条件就不启动任何进程 ----
        // 依据(E4:colcon 源码 + 真机实跑,两类包同结论):
        //   · COLCON_IGNORE → colcon 完全忽略该包("ignoring unknown package");
        //   · 未构建 → C++ 侧 `assert os.path.exists(build_base)` 直接崩,
        //     Python 侧缺 `install/<pkg>/share/<pkg>/package.sh` 走不到测试 —— 均必然失败且零产物。
        // 启动只会浪费一次调用并制造 colcon 噪音,故在此拦下。
        const buildPkgDir = path.join(workspaceRoot, 'build', pkg);
        const buildDirPresent = fs.existsSync(buildPkgDir);
        // COLCON_IGNORE 的判定只看包目录自身(本工作区实测形态:src/<pkg>/COLCON_IGNORE)
        const colconIgnorePresent = testData.pkgDir !== undefined
            && fs.existsSync(path.join(testData.pkgDir, 'COLCON_IGNORE'));
        const preflight = packagePreflight({
            pkg: pkg,
            colconIgnorePresent: colconIgnorePresent,
            buildDirPresent: buildDirPresent
        });
        if (preflight.kind === 'errored') {
            log.info(vscode.l10n.t("Package-level run blocked by preflight gate: {0} ({1})", pkg, preflight.reason));
            this.errorOn(run, pkgItem, preflight.reason);
            return;
        }

        log.info(vscode.l10n.t("Package-level run: colcon test --packages-select {0}", pkg));
        const outcome = await this.executeProcess({
            command: ['colcon', 'test', '--packages-select', pkg, '--return-code-on-test-failure'],
            cwd: workspaceRoot,
            env: env,
            timeoutMs: timeoutMs,
            onChunk: onChunk,
            cancellation: cancellation
        });

        // ---- 判定:只认官方产物;零产物的**成因分辨**交 packageVerdict(B7.3) ----
        // 用户实测困惑:"未产出测试结果(colcon 退出码 0)"对上 holle(带 COLCON_IGNORE、本无测试)
        // 是误导 —— 被忽略/未构建/无注册测试 与 真跑失败 必须分开报。
        const junitXml = await this.readArtifact(path.join(buildPkgDir, 'pytest.xml'));
        const junitCases: ParsedCase[] = junitXml === undefined ? [] : parseJunitXml(junitXml).cases;

        // B14:test_results 下有两类官方产物 —— `*.gtest.xml`(gtest)与 `*.xunit.xml`(launch_test 等 ament 测试)
        const artifacts = await this.findArtifacts(path.join(buildPkgDir, 'test_results'));
        const gtestCases: ParsedCase[] = [];
        for (const artifact of artifacts.gtest) {
            const xml = await this.readArtifact(artifact);
            if (xml !== undefined) {
                gtestCases.push(...parseGtestXml(xml).cases);
            }
        }
        const launchCases: ParsedCase[] = [];
        for (const artifact of artifacts.junit) {
            const xml = await this.readArtifact(artifact);
            if (xml !== undefined) {
                launchCases.push(...parseJunitXml(xml).cases);
            }
        }

        const all = junitCases.concat(gtestCases, launchCases);
        const verdict = packageVerdict({
            pkg: pkg,
            buildDirPresent: buildDirPresent,
            colconIgnorePresent: colconIgnorePresent,
            missingResultSentinel: hasMissingResultSentinel(junitCases),
            artifactCount: (junitXml === undefined ? 0 : 1) + artifacts.gtest.length + artifacts.junit.length,
            caseCount: all.length,
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            timeoutMs: timeoutMs
        });
        if (verdict.kind === 'errored') {
            this.errorOn(run, pkgItem, verdict.reason);
            return;
        }

        if (run !== undefined) {
            // 按语言分派 scopes(映射规则不同:junit 点分模块 / gtest classname+name)
            reportCases(run, { fileItems: scope.py.length > 0 ? scope.py : (pkgItem === undefined ? [] : [pkgItem]) }, junitCases, 'pytest');
            if (gtestCases.length > 0) {
                reportCases(run, { fileItems: scope.cpp.length > 0 ? scope.cpp : (pkgItem === undefined ? [] : [pkgItem]) }, gtestCases, 'gtest');
            }
            if (launchCases.length > 0) {
                reportCases(run, { fileItems: scope.launch.length > 0 ? scope.launch : (pkgItem === undefined ? [] : [pkgItem]) }, launchCases, 'launch');
            }
        }
        log.info(vscode.l10n.t("Package-level run finished: {0}, {1} cases (pytest {2} / gtest {3} / launch {4})", pkg, all.length, junitCases.length, gtestCases.length, launchCases.length));
    }

    /**
     * 递归收集测试产物(有界深度,容忍 test_results 下的多层布局),按官方后缀分类(B14):
     * `*.gtest.xml` → gtest;`*.xunit.xml` → junit 系(launch_test 等 ament 测试)。
     */
    private async findArtifacts(root: string, depth = 0): Promise<{ gtest: string[]; junit: string[] }> {
        const out = { gtest: [] as string[], junit: [] as string[] };
        if (depth > 3) {
            return out;
        }
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(root, { withFileTypes: true });
        } catch {
            return out;
        }
        for (const e of entries) {
            const full = path.join(root, e.name);
            if (e.isDirectory()) {
                const sub = await this.findArtifacts(full, depth + 1);
                out.gtest.push(...sub.gtest);
                out.junit.push(...sub.junit);
            } else if (e.isFile()) {
                const kind = classifyArtifact(e.name);
                if (kind === 'gtest') {
                    out.gtest.push(full);
                } else if (kind === 'junit') {
                    out.junit.push(full);
                }
            }
        }
        return out;
    }

    /**
     * Python 文件级 / 用例级统一入口(2026-09-24 B3:收敛 `PythonUnitTest` / `PythonPytest` 两分支)。
     *
     * 两级只在**选择器**上不同(`buildPytestArgs` 内按 `testData` 有无 `testMethod` 决定:
     * 文件级 = 文件绝对路径,用例级 = `文件::类::方法`),执行/判定/上报完全一致,
     * 故不再按类型分叉。
     */
    private runFileOrCase(
        testData: RosTestData,
        run: vscode.TestRun | undefined,
        testItem: vscode.TestItem | undefined,
        onChunk?: (chunk: string) => void,
        cancellation?: vscode.CancellationToken
    ): Promise<void> {
        return this.runPythonTest(testData, run, testItem, onChunk, cancellation);
    }

    /**
     * Run Python test using pytest or unittest
     */
    private async runPythonTest(
        testData: RosTestData,
        run: vscode.TestRun | undefined,
        testItem: vscode.TestItem | undefined,
        onChunk?: (chunk: string) => void,
        cancellation?: vscode.CancellationToken
    ): Promise<void> {
        if (this.rejectIfNoEnv(run, testItem)) {
            return;
        }
        // 2026-09-24(B0):pytest 的 cwd **必须是包目录** —— ament linter 的入口是
        // `main(argv=['.', ...])`,`.` 按 cwd 解析;cwd=工作区根会把整个工作区(含 build/install
        // 里的 package.xml 拷贝)扫进去,实测同一用例从 `1 passed / 3.9s` 变成 `30s+ 挂死`,
        // 且失败归因错误(报的是别处的错)。
        const pkgDir = testData.pkgDir;
        if (!pkgDir) {
            this.errorOn(run, testItem, vscode.l10n.t("Cannot locate the package directory under test (no package.xml upward); giving up"));
            return;
        }

        const built = this.buildPytestArgs(testData);
        const env = await composeApi.environment.resolvedEnv();
        const timeoutMs = 300000;
        const outcome = await this.executeProcess({
            command: built.args,
            cwd: pkgDir,
            env: env,
            timeoutMs: timeoutMs,
            xmlPath: built.xmlPath,
            onChunk: onChunk,
            cancellation: cancellation
        });

        // ---- 判定:一律以 junitxml 产物为准;退出码只用来识别"没跑起来"(计划 §0.1;B6 抽为纯函数) ----
        const xml = await this.readArtifact(built.xmlPath);
        const suite: ParsedSuite = xml === undefined ? { tests: 0, failures: 0, skipped: 0, cases: [] } : parseJunitXml(xml);
        const verdict = pytestVerdict({
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            artifactPresent: xml !== undefined,
            caseCount: suite.tests,
            timeoutMs: timeoutMs
        });
        if (verdict.kind === 'errored') {
            this.errorOn(run, testItem, verdict.reason);
            await this.removeArtifact(built.xmlPath);
            return;
        }
        if (run !== undefined && testItem !== undefined) {
            reportCases(run, { fileItems: [testItem] }, suite.cases, "pytest");
        }
        await this.removeArtifact(built.xmlPath);
    }

    /**
     * B14:launch_test **整文件**运行 —— 命令与 colcon 注册命令**逐字同源**
     * (`launch_testing_ament_cmake/cmake/add_launch_test.cmake`:
     *  `python3 -m launch_testing.launch_test <file> --junit-xml=<path> --package-name=<pkg>`)。
     *
     * 粒度:只能整文件(launch_test 无方法级选择器);结果 XML 到**方法级**(每个 unittest 方法一个 testcase)。
     * cwd:取 `build/<pkg>`(与 colcon 的 WORKING_DIRECTORY 一致;未构建时退回包目录)。
     */
    private async runLaunchTestFile(
        testData: RosTestData,
        run?: vscode.TestRun,
        testItem?: vscode.TestItem,
        onChunk?: (chunk: string) => void,
        cancellation?: vscode.CancellationToken
    ): Promise<void> {
        if (this.rejectIfNoEnv(run, testItem)) {
            return;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const buildPkgDir = workspaceRoot === undefined || testData.packageName === undefined || testData.packageName === ''
            ? undefined
            : path.join(workspaceRoot, 'build', testData.packageName);
        const cwd = buildPkgDir !== undefined && fs.existsSync(buildPkgDir)
            ? buildPkgDir
            : testData.pkgDir;
        if (cwd === undefined) {
            this.errorOn(run, testItem, vscode.l10n.t('launch_test run missing working directory (no workspace/package directory found)'));
            return;
        }

        const xmlPath = nextArtifactPath('launch');
        const args = [
            'python3', '-m', 'launch_testing.launch_test',
            testData.filePath,
            `--junit-xml=${xmlPath}`
        ];
        if (testData.packageName !== undefined && testData.packageName !== '') {
            args.push(`--package-name=${testData.packageName}`);
        }
        const env = await composeApi.environment.resolvedEnv();
        const timeoutMs = 300000; // launch 测试要起节点:colcon 侧默认 60s 偏紧
        const outcome = await this.executeProcess({
            command: args,
            cwd: cwd,
            env: env,
            timeoutMs: timeoutMs,
            xmlPath: xmlPath,
            onChunk: onChunk,
            cancellation: cancellation
        });

        const xml = await this.readArtifact(xmlPath);
        const suite: ParsedSuite = xml === undefined ? { tests: 0, failures: 0, skipped: 0, cases: [] } : parseJunitXml(xml);
        const verdict = launchTestVerdict({
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            artifactPresent: xml !== undefined,
            caseCount: suite.tests,
            timeoutMs: timeoutMs
        });
        if (verdict.kind === 'errored') {
            this.errorOn(run, testItem, verdict.reason);
            await this.removeArtifact(xmlPath);
            return;
        }
        if (run !== undefined && testItem !== undefined) {
            reportCases(run, { fileItems: [testItem] }, suite.cases, 'launch');
        }
        await this.removeArtifact(xmlPath);
    }

    /**
     * Run C++ test using ROS 2 testing infrastructure
     */
    private async runCppTest(
        testData: RosTestData,
        run: vscode.TestRun | undefined,
        testItem: vscode.TestItem | undefined,
        onChunk?: (chunk: string) => void,
        cancellation?: vscode.CancellationToken
    ): Promise<void> {
        if (!testData.packageName) {
            throw new Error(vscode.l10n.t("C++ test package name not found"));
        }
        if (this.rejectIfNoEnv(run, testItem)) {
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) {
            throw new Error(vscode.l10n.t("No workspace folder found"));
        }

        const env = await composeApi.environment.resolvedEnv();

        // ---- B2:可执行定位链 v2 —— **记录面为准**,不再猜名、不再隐式构建 ----
        // 计划 §B2.2:① CTestTestfile 注册(权威运行参数) × install-truth 反向索引(源 → 目标名)求交;
        //            ② 回退:仅 install-truth(`lookup().entry.buildPath`);
        //            ③ 全失 → errored + 指引(官方流程 build → test 分离)。
        const pkg = testData.packageName;
        const buildPkgDir = path.join(workspaceRoot, 'build', pkg);
        const resolver = this.ensureResolver(workspaceRoot);
        const registrations = await parseCTestTestfile(buildPkgDir);
        log.debug(vscode.l10n.t("  CTest registrations of package {0}: {1}", pkg, registrations.map((r) => r.name).join(', ') || vscode.l10n.t('(none)')));

        let executablePath: string | undefined;
        let cwd = buildPkgDir;
        let timeoutMs = 300000;

        const owners = await resolver.ownersOfSource(testData.filePath);
        const owner = owners === null || owners.length === 0
            ? undefined
            : (owners.find((o) => o.pkg === pkg) ?? owners[0]);

        if (owner !== undefined) {
            const reg = registrations.find((r) => r.name === owner.name);
            if (reg !== undefined && reg.exePath !== undefined) {
                executablePath = reg.exePath;
                if (reg.workingDirectory !== undefined) {
                    cwd = reg.workingDirectory;
                }
                if (reg.timeoutSec !== undefined) {
                    timeoutMs = reg.timeoutSec * 1000;
                }
                log.debug(vscode.l10n.t("  CTest registration hit: {0} (labels={1}, cwd={2}, timeout={3} ms)", reg.name, reg.labels.join('|') || '-', cwd, timeoutMs));
            } else {
                const lookup = await resolver.lookup(owner.pkg, owner.name);
                if (lookup !== null && lookup.status === 'ok' && lookup.entry?.buildPath !== undefined) {
                    executablePath = lookup.entry.buildPath;
                    log.debug(vscode.l10n.t("  install-truth fallback: {0}/{1} -> {2}", owner.pkg, owner.name, executablePath));
                }
            }
        }

        if (executablePath === undefined) {
            this.errorOn(run, testItem, vscode.l10n.t("Registered test executable not found (package {0} not built, or the file is not registered via ament_add_gtest) — run colcon build {0} first", pkg));
            return;
        }
        if (!fs.existsSync(executablePath)) {
            this.errorOn(run, testItem, vscode.l10n.t("Test executable does not exist: {0} — run colcon build {1} first", executablePath, pkg));
            return;
        }

        // 2026-09-24(B7.1):产物路径走 `nextArtifactPath`(进程内单调序号)——
        // 原 `Date.now()-pid` 拼法在并行批次里会同毫秒撞名,造成误报"未产生结果文件"/结果串台。
        const xmlPath = nextArtifactPath('gtest');
        const testArgs = this.buildGTestArgs(testData, xmlPath);

        const outcome = await this.executeProcess({
            command: [executablePath, ...testArgs],
            cwd: cwd,
            env: env,
            timeoutMs: timeoutMs,
            xmlPath: xmlPath,
            onChunk: onChunk,
            cancellation: cancellation
        });

        // ---- 判定:以 gtest XML 为准;**0 条 = errored**(实测 0 命中退出码仍为 0,是假绿) ----
        const xml = await this.readArtifact(xmlPath);
        const suite: ParsedSuite = xml === undefined ? { tests: 0, failures: 0, skipped: 0, cases: [] } : parseGtestXml(xml);
        const verdict = gtestVerdict({
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            artifactPresent: xml !== undefined,
            caseCount: suite.tests,
            timeoutMs: timeoutMs
        });
        if (verdict.kind === 'errored') {
            this.errorOn(run, testItem, verdict.reason);
            await this.removeArtifact(xmlPath);
            return;
        }
        if (run !== undefined && testItem !== undefined) {
            reportCases(run, { fileItems: [testItem] }, suite.cases, "gtest");
        }
        await this.removeArtifact(xmlPath);
    }

    /* 2026-09-24(B2):`buildTestExecutable` 已删除 —— 官方流程 build → test 分离,
       未构建时按 errored 指引用户自行 `colcon build <pkg>`(计划 §B2.2 / §7.5)。
       `buildGTestArgs` 在下方(与 `buildPytestArgs` 相邻处),此处不再重复定义。 */

    /**
     * gtest filter 拼法(B2;真名规则与实测见计划 §B2.3 与 E1 裁定)。
     * 纯逻辑已抽到 `gtest-filter.ts`(可无头单测,B6.5),此处仅做转发。
     */
    private gtestFilterOf(testData: RosTestData): string | undefined {
        return buildGTestFilter(testData);
    }

    /**
     * 拼 pytest 命令行(B1):
     *   - **删 `-x`**(首错即停:单用例无害,文件级/包级会截断后续用例);
     *   - 加 `--junitxml`(结果真值,落 os.tmpdir);
     *   - 保留 `-v -p no:cacheprovider -p no:nose --tb=short`;
     *   - 选择器:用例级 `<file>::<Class>::<method>`,文件级 = 文件绝对路径。
     */
    private buildPytestArgs(testData: RosTestData): { args: string[]; xmlPath: string } {
        // 2026-09-24(B7.1):本函数是**同步**链(pytest 侧无 await 介入),并行批下同毫秒必撞名
        // ⇒ 必须走 `nextArtifactPath` 的唯一序号(真机实证:19 进程只分到 4 个路径)。
        const xmlPath = nextArtifactPath('pytest');
        const args = [
            'python3', '-m', 'pytest',
            '-v',
            '-p', 'no:cacheprovider',
            '-p', 'no:nose',
            '--tb=short',
            `--junitxml=${xmlPath}`
        ];
        let selector = testData.filePath;
        if (testData.testClass && testData.testMethod) {
            selector = `${testData.filePath}::${testData.testClass}::${testData.testMethod}`;
        } else if (testData.testMethod) {
            selector = `${testData.filePath}::${testData.testMethod}`;
        }
        args.push(selector);
        return { args, xmlPath };
    }

    /**
     * Build Google Test command line arguments
     *
     * B2:filter 一律经 `gtestFilterOf`(按入口宏分派真名通配),
     * 不再直接用 `Suite.Case` —— 那对参数化/类型化用例会命中 0 条并**假绿**(E1 判决)。
     */
    private buildGTestArgs(testData: RosTestData, xmlPath: string): string[] {
        const args: string[] = [];
        const filter = this.gtestFilterOf(testData);
        if (filter !== undefined) {
            args.push(`--gtest_filter=${filter}`);
        }

        // 2026-09-24(B1):补**路径** —— 原先只写 `xml`(无路径),XML 落进 cwd 且没人读;
        // 现在落 os.tmpdir 并交给 parseGtestXml 判成败。
        args.push(`--gtest_output=xml:${xmlPath}`);
        args.push('--gtest_color=yes');

        return args;
    }

    /**
     * 执行一个进程(B1,取代原 `executeTestCommand`):**不做任何 passed/failed 判定**。
     * 职责 = spawn(`shell:false`)+ stdout/stderr 逐块回灌(`onChunk`,供「测试结果」面板)
     *        + 超时 SIGKILL + 取消即 kill(A7)+ 返回退出码。
     * 判定交给产物(XML)与调用方 —— 退出码语义在 pytest / gtest / colcon 三处各不相同(速查 §0.3)。
     */
    private executeProcess(spec: ExecSpec): Promise<ExecOutcome> {
        return new Promise<ExecOutcome>((resolve) => {
            log.debug(vscode.l10n.t("Executing: {0} (cwd={1})", spec.command.join(' '), spec.cwd));
            const proc = cp.spawn(spec.command[0], spec.command.slice(1), {
                env: spec.env,
                cwd: spec.cwd,
                stdio: 'pipe',
                shell: false
            });

            let settled = false;
            let timedOut = false;
            let tail = '';
            let timer: NodeJS.Timeout | undefined;

            const finish = (exitCode: number | undefined): void => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer !== undefined) {
                    clearTimeout(timer);
                }
                resolve({ exitCode: exitCode, timedOut: timedOut });
            };

            const onData = (data: Buffer): void => {
                const text = data.toString();
                tail = (tail + text).slice(-4000); // 只留尾部:仅在"无产物"时用于诊断
                if (spec.onChunk !== undefined) {
                    spec.onChunk(text);
                }
            };
            if (proc.stdout) {
                proc.stdout.on('data', onData);
            }
            if (proc.stderr) {
                proc.stderr.on('data', onData);
            }

            proc.on('close', (code) => {
                const exitCode = code ?? undefined;
                log.info(vscode.l10n.t("Process exited, code: {0}{1}", exitCode, exitCode === 0 ? '' : vscode.l10n.t('\nOutput tail:\n{0}', tail)));
                finish(exitCode);
            });

            proc.on('error', (error) => {
                log.error(vscode.l10n.t("Process failed to start: {0}", error.message));
                finish(undefined);
            });

            timer = setTimeout(() => {
                timedOut = true;
                log.warn(vscode.l10n.t("Process timed out ({0} ms); killed", spec.timeoutMs));
                proc.kill('SIGKILL');
                finish(undefined);
            }, spec.timeoutMs);

            // A7/计划 B1.2:取消即杀子进程(原先只查一次 token、不杀,取消不彻底)
            if (spec.cancellation !== undefined) {
                spec.cancellation.onCancellationRequested(() => {
                    log.info(vscode.l10n.t('Cancellation received; terminating test process'));
                    proc.kill('SIGKILL');
                    finish(undefined);
                });
            }
        });
    }

    /* 2026-09-24(B2):`findTestExecutable` / `searchForExecutable` 已删除 ——
       可执行定位改走 CTestTestfile 注册 + install-truth 反向索引(见 runCppTest)。 */
}