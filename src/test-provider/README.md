# test-provider/ — ROS 2 测试域（发现 · 执行 · 上报）

> **定位**：回答"这个工作区**有哪些测试、怎么跑、结果是什么**"。
> 三类测试:`pytest`(ament_python)、`gtest`(ament_add_gtest)、`launch_test`(launch_testing,整文件粒度)。

## 三条铁律
1. **判定以官方产物为准**(`build/<pkg>/pytest.xml`、`test_results/**/*.gtest|*.xunit.xml`);退出码只用来识别"没跑起来"(pytest 4/5、XML 零条)。
2. **不隐式构建**:colcon test 不负责构建;未构建 → 阻断并指引 `colcon build <pkg>`(E4:两类包未构建都必然失败)。
3. **分层不混流**:并行运行的子进程输出**必须绑定到具体测试项**(`appendOutput(chunk, undefined, item)`),否则互相插字。

## 目录
| 目录 | 职责 |
|:--|:--|
| `provider/` | 唯一持有 `vscode.TestController` 的一层:树(包→文件→用例)、生命周期、发现队列、运行分流 |
| `runner/` | 执行层:拼命令 + spawn + 超时/取消;**只执行,不判成败** |
| `parsing/` | 纯解析(**禁止 import vscode**):junit/gtest XML、CTestTestfile、命名规则唯一来源、用例 diff |
| `semantics/` | 纯判定(**禁止 import vscode**):四类 verdict、包说明项/可运行、gtest 真名 |
| `reporting/` | 产物用例 → TestItem 映射与上报(依赖 `vscode.TestMessage`,故单列) |

## 依赖方向(单向)
`provider → runner/reporting → semantics/parsing`;`parsing/`、`semantics/` **不得** import `vscode` 或上层。

## 验证
`npm run test-compile` → `npx mocha out/test/suite/test-provider-v2.test.js out/test/suite/test-provider.test.js`(基线随批次更新)。
