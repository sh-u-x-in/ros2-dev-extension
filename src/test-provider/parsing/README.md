# parsing/ — 纯解析

**定位**:把"官方记录"(`.xunit/.gtest XML`、`CTestTestfile.cmake`)与"源码里的测试定义"解析成结构化数据。**禁止 import vscode**(保证 `npx mocha` 无头直跑)。

**文件**
- `test-results-parser.ts` —— junit(pytest/launch_test)与 gtest XML → `ParsedCase/ParsedSuite`
- `ctest-testfile-parser.ts` —— `CTestTestfile.cmake` 的 `add_test` 词法(注册名/可执行/WORKING_DIRECTORY/TIMEOUT/LABELS)+ 递归读盘
- `test-discovery-utils.ts` —— **命名规则唯一来源**(`TEST_NAME_CORE` + PY/CPP 正则 + `isTestFileName`,与 walk/watcher 同源)、用例 id(`pythonCaseId`)、diff(`planCaseDiff`)

**边界**:不做判定、不做上报、不读配置;后续若拆分,`test-naming.ts`(命名)与 `case-diff.ts`(diff)是预留的切缝。

**依赖方向**:叶子,无人可依赖(除 `provider/runner` 消费);被 `runner/`、`reporting/`、`provider/` 消费。

**无头可测性**:全部零 vscode,`npx mocha` 直跑。
