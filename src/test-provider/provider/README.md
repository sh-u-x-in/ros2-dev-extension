# provider/ — 树与控制器

**定位**:唯一持有 `vscode.TestController` 的一层。负责:测试树(包→文件→用例)、发现(全量 + 队列式增量)、运行分流、包节点的"门面"(说明项 + `runnable` 标签)。

**文件**
- `ros-test-provider.ts` —— 门面:控制器、`runTests` 分流(包级/文件/用例)、`runAllLeaves`、`gatherAllTests`、`packageScopeOf`
- `discovery-queue.ts` —— 发现请求队列(合并窗 + 单写者链;`full/packages/package/file` 四种作用域)

**边界**:不拼测试命令、不解析产物(那是 `runner/` 与 `parsing/` 的事);持 `testController` 的只有本目录。

**依赖方向**:可 import `runner/`(执行)、`reporting/`(上报)、`semantics/`、`parsing/`、`../build-tool/*`;**被** `src/extension.ts` import。

**无头可测性**:`discovery-queue.ts` 零 vscode,可直接 mocha;`ros-test-provider.ts` 需宿主(测试里用桩 + 宿主专属组跳过)。
