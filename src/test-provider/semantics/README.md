# semantics/ — 纯判定

**定位**:"这个结果/状态该怎么解读"。全部是**纯函数**,判定规则集中于此,禁止散落在 runner/provider。

**文件**
- `result-semantics.ts` —— 四类 verdict(`pytestVerdict`/`gtestVerdict`/`launchTestVerdict`/`packageVerdict`)+ 前置闸门(`packagePreflight`)+ 包门面(`packageNote`/`isPackageRunnable`)+ 占位结果识别(`hasMissingResultSentinel`)+ 产物分类(`classifyArtifact`)
- `gtest-filter.ts` —— gtest 真名 filter(`buildGTestFilter`)+ 套件名推导(`gtestSuiteOf`,处理 TYPED_TEST 索引与 colcon 的 `<包>.` 前缀)

**边界**:不做 IO、不 import vscode、不做上报;判定规则变更必须带单测(退出码语义表见测试)。

**依赖方向**:叶子;被 `runner/`(判定)、`provider/`(门面)消费。

**无头可测性**:全部零 vscode,`npx mocha` 直跑。
