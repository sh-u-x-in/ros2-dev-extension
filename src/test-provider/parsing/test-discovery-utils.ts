// Licensed under the MIT License.

import { l10n } from "vscode";

import * as fs from "fs";
import * as path from "path";
// 2026-09-24(B6):本模块已**零 vscode 依赖** —— 删掉最后两个用 vscode 的死函数
// (getCppTestExecutable / checkTestDependencies)后,纯逻辑可无头直测(B6.5)。
import { CppMacroKind } from "../provider/ros-test-provider";

import { getLogger } from "../../logger";

/** 测试发现工具模块日志 */
const log = getLogger("test-discovery");

/**
 * 测试文件命名规则的**唯一来源**(B13,2026-09-24):
 *   test 任意大小写,前缀 `test_` / 后缀 `_test` / 点后缀 `.test`(字符类穷举全部大小写组合)。
 *
 * **walk 正则与 watcher 过滤都从这里派生** —— 过去 watcher 是一份**手写的字面清单**
 * (`test_*` / `Test_*` / `*_test` / `*Test` 逐个点名),与 walk 正则口径不同源,于是
 * `Test_foo.py` / `foo_Test.py` / `foo.test.py` / `TEST_*.cpp` 这些形态**能被发现但新建时不触发重扫**
 * (树要手动刷新才更新);反向 `*Test.cpp` 又被 watcher 盯着却不为 walk 所认(白扫)。
 */
const TEST_NAME_CORE = "(?:[tT][eE][sS][tT]_.*|.*_[tT][eE][sS][tT]|.*\\.[tT][eE][sS][tT])";

/** Python 测试文件名规则(walk 的 matcher;派生自 `TEST_NAME_CORE`) */
export const PY_TEST_NAME_RE = new RegExp(`^${TEST_NAME_CORE}\\.py$`);

/** C++ 测试文件名规则(walk 的 matcher;派生自 `TEST_NAME_CORE`) */
export const CPP_TEST_NAME_RE = new RegExp(`^${TEST_NAME_CORE}\\.cpp$`);

/**
 * Utilities for discovering and parsing ROS 2 test files
 */
export class TestDiscoveryUtils {
    
    /**
     * Parse Python test file to find test classes and methods
     */
    static parsePythonTestFile(filePath: string): Array<{
        name: string;
        type: 'class' | 'method';
        line: number;
        parent?: string;
    }> {
        const results: Array<{
            name: string;
            type: 'class' | 'method';
            line: number;
            parent?: string;
        }> = [];
        
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            
            let currentClass: string | null = null;
            let classIndentation = -1;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmedLine = line.trim();
                
                // Skip empty lines and comments
                if (!trimmedLine || trimmedLine.startsWith('#')) {
                    continue;
                }
                
                // Calculate indentation level
                const indentation = line.length - line.trimStart().length;
                
                // If we're at module level (no indentation) and have a current class, reset it
                if (indentation === 0 && currentClass !== null && !trimmedLine.startsWith('class ')) {
                    currentClass = null;
                    classIndentation = -1;
                }
                
                // Detect test classes (class names containing 'Test' or ending with 'Test')
                const classMatch = trimmedLine.match(/^class\s+(\w*[Tt]est\w*)\s*\(/);
                if (classMatch) {
                    currentClass = classMatch[1];
                    classIndentation = indentation;
                    results.push({
                        name: currentClass,
                        type: 'class',
                        line: i
                    });
                    continue;
                }
                
                // Detect test methods (starting with 'test_';2026-09-24 B3:补 `async def`)
                const methodMatch = trimmedLine.match(/^(?:async\s+)?def\s+(test_\w+)\s*\(/);
                if (methodMatch) {
                    const methodName = methodMatch[1];
                    // Only set parent if we're indented under a class
                    const parent = (currentClass && indentation > classIndentation) ? currentClass : undefined;
                    results.push({
                        name: methodName,
                        type: 'method',
                        line: i,
                        parent: parent
                    });
                }
                
                // Reset current class when we encounter a new top-level class
                if (trimmedLine.startsWith('class ') && !classMatch) {
                    currentClass = null;
                    classIndentation = -1;
                }
            }
        } catch (error) {
            log.error(l10n.t("Failed to parse Python test file {0}: {1}", filePath, error instanceof Error ? error.message : String(error)));
        }
        
        return results;
    }
    
    /**
     * Parse C++ test file to find gtest **用例定义**宏(2026-09-24 B2 修正)
     *
     * 只认"定义一个用例"的宏:`TEST / TEST_F / TEST_P / TYPED_TEST / TYPED_TEST_F / TYPED_TEST_P / GTEST_TEST`。
     * 旧版白名单里混进了 `*_SUITE*` / `*_CASE*` 这些**声明**宏,而 `TYPED_TEST_SUITE(CubicTest, CubicTypes)`
     * 的两个实参恰好长得像"套件, 用例" → 实测产出过伪项 `CubicTest.CubicTypes`
     * (真机 `test_gtest_entries.cpp`:旧版 11 项 = 10 真实定义 + 1 伪项,且漏掉 `GTEST_TEST`)。
     * `INSTANTIATE_*` / `REGISTER_*` / `FRIEND_TEST` 同样不定义用例,不列。
     */
    static parseCppTestFile(filePath: string): Array<{
        name: string;
        suite: string;
        line: number;
        isFixture: boolean;
        macro: CppMacroKind;
    }> {
        const results: Array<{
            name: string;
            suite: string;
            line: number;
            isFixture: boolean;
            macro: CppMacroKind;
        }> = [];
        
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmedLine = line.trim();
                
                // Skip empty lines and comments
                if (!trimmedLine || trimmedLine.startsWith('//') || trimmedLine.startsWith('/*')) {
                    continue;
                }
                
                // 入口宏白名单(B2):**只列定义用例的宏**;长名在前避免前缀截断误匹配;
                // GTEST_TEST 是 TEST 的防撞名马甲(行为一致),宏名与 ( 之间允许空白(含换行)
                const cppTestMatch = trimmedLine.match(
                    /^(GTEST_TEST|TYPED_TEST_P|TYPED_TEST_F|TYPED_TEST|TEST_P|TEST_F|TEST)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/,
                );
                if (cppTestMatch) {
                    const [, macro, testSuite, testName] = cppTestMatch;
                    results.push({
                        name: testName,
                        suite: testSuite,
                        line: i,
                        // TEST_F / TYPED_TEST_F 用 fixture,其余非 fixture
                        isFixture: macro.endsWith('_F'),
                        macro: macro as CppMacroKind,
                    });
                }
            }
        } catch (error) {
            log.error(l10n.t("Failed to parse C++ test file {0}: {1}", filePath, error instanceof Error ? error.message : String(error)));
        }
        
        return results;
    }
    
    /* 2026-09-24(B6/T6):`parseLaunchTestFile` 已删除 —— LaunchTest 分支从未产出用例
       (发现层不产生、runner 显式禁用),属断电残留死函数。 */

    /* 2026-09-24(B4):`findPackageName`(向上找 package.xml 猜包名)已整段删除 ——
       包名真值来自 package-core workspace 域(`{name, dir, buildType}`),见 provider.collectPackages。 */

    /* 2026-09-24:`isLaunchTestSource` / `detectLaunchTestFile`(读文件内容判断"这是不是 launch 测试")
       已删除 —— launch 类型的**权威依据是构建记录**:`build/<pkg>/CTestTestfile.cmake` 的
       `add_test` + `LABELS "launch_test"`(由 `launch_testing_ament_cmake` 写入),源文件路径就在
       `--command` 的参数里(见 `ctest-testfile-parser.launchTestSourceOf`)。内容嗅探是启发式,
       记录驱动之后不再需要 —— 未构建的测试本就不该出现在树里。 */

    /** `pytest.mark.launch_test` 是否在场(仅用于说明提示:缺它时 pytest 路线不会走 launch 收集) */
    static hasLaunchMark(text: string): boolean {
        return /@\s*pytest\.mark\.launch_test/.test(text)
            || /pytestmark\s*=\s*pytest\.mark\.launch_test/.test(text);
    }

    /**
     * 文件名是否属"测试发现面"(B13):**与 walk 正则同源**,见模块顶部 `TEST_NAME_CORE`。
     * 用途:watcher 的事件过滤 —— watcher 只能按扩展名粗筛(`.py` / `.cpp` 全收),
     * 真判定在这里做,保证"watcher 认的"与"walk 收的"**完全一致**。
     */
    static isTestFileName(fileName: string): boolean {
        return PY_TEST_NAME_RE.test(fileName) || CPP_TEST_NAME_RE.test(fileName);
    }

    /**
     * 用例项的**增量 diff 计划**(B11,纯函数可单测):
     * 现有子项 id 与"重解析后应有的 id"比对 → 该删的、该加的(保留项不动,尽量保值 VS Code 侧状态)。
     */
    static planCaseDiff(currentIds: readonly string[], wantedIds: readonly string[]): {
        toAdd: string[];
        toRemove: string[];
    } {
        const current = new Set(currentIds);
        const wanted = new Set(wantedIds);
        return {
            toAdd: wantedIds.filter((id) => !current.has(id)),
            toRemove: currentIds.filter((id) => !wanted.has(id))
        };
    }

    /**
     * 路径是否落在**产物目录**内(B13,与 walk 的默认排除同口径):
     * watcher 只能按扩展名粗筛,`build/`、`install/` 下也有 `.py`/`.cpp`(生成物、安装拷贝),
     * 增量面必须补上与 walk 相同的目录名过滤,否则白算一遍。
     * 判定用相对工作区根的**路径段**比对(不依赖 uri scheme,Remote 场景同样成立)。
     */
    static pathHasExcludedDir(filePath: string, root: string, excludedDirNames: readonly string[]): boolean {
        const rel = path.relative(root, filePath);
        if (rel === '' || rel.startsWith('..')) {
            return false; // 工作区外:交给别的闸(与 rosmsg 的 isInWorkspace 同思路)
        }
        const names = new Set(excludedDirNames);
        return rel.split(/[\\/]/).some((seg) => names.has(seg));
    }

    /**
     * Python 用例项的 id(2026-09-24 B3)。
     *
     * 有父类 → `文件::类::方法`;父类缺失时(模块级函数,或**类名不含 Test**的类内方法)
     * 把**行号**并入 id —— 否则"同一文件里两个不含 Test 的类各有同名 `test_foo`"会算出
     * 同一个 id,而 `TestItemCollection.add` 对同 id 是**替换**(VS Code 契约),
     * 结果是**静默丢用例**(旧实现即如此)。
     */
    static pythonCaseId(fileItemId: string, element: { name: string; line: number; parent?: string }): string {
        return element.parent === undefined || element.parent === ''
            ? `${fileItemId}::::${element.name}@${element.line}`
            : `${fileItemId}::${element.parent}::${element.name}`;
    }

    /* 2026-09-24(B4):`findPackageName` 已删除 —— 包名真值来自 package-core workspace 域
       (`{name, dir, buildType}`,见 provider.collectPackages),不再用"向上找 package.xml"的路径启发。
       目录版 `findPackageDir` 保留:它只服务"散装测试的 cwd 兜底"。 */

    /**
     * 找 package.xml 所在目录(= 包根)。与 findPackageName 同源,只是返回目录而非名字。
     *
     * 2026-09-24(B0):供 pytest 的 cwd 使用 —— ament linter 的入口是 `main(argv=['.', ...])`,
     * `.` 按 cwd 解析;cwd=工作区根会把整个工作区(含 build/install 的 package.xml 拷贝)扫进去,
     * 实测同一个 test_xmllint 用例从 `1 passed / 3.9s` 变成 `30s+ 挂死`,且报错归因错误。
     */
    static findPackageDir(filePath: string): string | undefined {
        let currentPath = path.dirname(filePath);
        const root = path.parse(currentPath).root;

        while (currentPath && currentPath !== root) {
            if (fs.existsSync(path.join(currentPath, 'package.xml'))) {
                return currentPath;
            }
            currentPath = path.dirname(currentPath);
        }

        return undefined;
    }

    /* 2026-09-24(B6/T5·T6):以下整族已删除(死代码/死规则)——
       · `isTestFile`:发现口径的唯一真值是 walk 正则(B2 起),此处旧规则(目录名、`.cc`、
         `.launch.py`)**永不触发**,留着只会让人以为还有第二套口径
         (其私有辅助 `isTestNamed` 亦为死代码,B13 起由模块顶部 `TEST_NAME_CORE` + `isTestFileName` 取代);
       · `getPythonTestCommand`:命令拼装已收归 runner(`buildPytestArgs`,B1);
       · `checkTestDependencies`:无调用方,且其判据(pytest/colcon 可用性)已被环境门槛 `getEnvIssue` 取代。 */
}
