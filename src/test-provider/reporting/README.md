# reporting/ — 结果上报

**定位**:把产物解析出的用例映射回树里的 TestItem 并上报(`run.passed/failed/skipped/errored`)。**粒度**:参数化/类型化实例不进树,聚合到宏/方法项;launch_test 的映射**只按方法名**(其 junit `classname` 带 `<包>.` 前缀,与树不同构)。

**文件**
- `run-report.ts` —— `reportCases(run, {fileItems}, cases, kind)`;`kind = pytest | gtest | launch`

**边界**:不做判定(status 已由 `parsing/` + `semantics/` 给出);不做发现。

**依赖方向**:被 `runner/`(各运行路径)、`provider/`(包级)消费;依赖 `parsing/test-results-parser` 与 `semantics/gtest-filter`。

**无头可测性**:依赖 vscode,**宿主专属**(测试中按"宿主专属组"模式跳过)。
