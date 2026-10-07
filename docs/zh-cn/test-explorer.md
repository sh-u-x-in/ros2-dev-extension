# 测试资源管理器

扩展与 VS Code 测试资源管理器集成,直接在编辑器内发现并运行 ROS 2 测试:包级/文件级测试项在编辑器中标注,结果按用例回显,不可构建/不可运行项明确标注:

![ROS 2 测试资源管理器侧边栏、编辑器标定与结果回显](../assets/test-explorer.png)

## 支持的测试类型

测试资源管理器自动发现以下测试:

* **Python(pytest)** —— 由 `pytest` 收集的测试(`unittest.TestCase` 用例同样由 pytest 驱动)
* **C++ GTest** —— Google Test 定义的测试(`TEST` / `TEST_F` / `TEST_P` / `TYPED_TEST` / `TYPED_TEST_F` / `TYPED_TEST_P` / `GTEST_TEST`)
* **Launch 测试**(`launch_testing`,如 `*_launch_test.py`)—— **整文件运行**(框架无按用例选择器);其按用例子项仅为结果展示槽位

> **不可运行项是「标注」,不是静默跳过。** 每个真实测试项都带 `runnable` 标签,Run profile 绑定该标签(VS Code 只执行带标签项)。信息性子项(包下方的「为什么没有测试」说明)与 launch 测试的用例槽位因此**没有运行按钮**,也绝不会被「运行全部」选中。`build/<包>` 尚不存在的包,其包级运行入口在构建前同样不可用。

## 使用测试资源管理器

1. 打开 VS Code 测试视图(活动栏烧瓶图标)
2. 扩展自动发现 ROS 2 工作区中的测试
3. 测试按 **包 → 测试文件 → 用例** 三级组织,使用包域真实包名(`package.xml <name>`),不同包的同名文件可区分
4. 点 **运行** 执行测试;视图工具栏提供**刷新**按钮
5. 过滤:在过滤框输入名称、`@ext:py` 或 `@tag:pytest` / `@tag:gtest` / `@tag:pkg:<name>`(每项都带这些标签)

## 测试如何执行(三种粒度)

| 粒度 | Python(ament_python) | C++(ament_cmake gtest) | Launch 测试 |
|:--|:--|:--|:--|
| **包级**(点包节点) | `colcon test --packages-select <包>`,结果读 `build/<包>/pytest.xml` | 同命令,结果读 `build/<包>/test_results/**/*.gtest.xml` | 同命令,结果读 `build/<包>/test_results/**/*.xunit.xml` |
| **文件级**(点测试文件) | `python3 -m pytest <文件> --junitxml=<临时>`,**cwd = 包目录** | `<exe> --gtest_output=xml:<临时>`(可执行从 `build/<包>/CTestTestfile.cmake` 解析) | `python3 -m launch_testing.launch_test <文件> --junit-xml=<临时>`(cwd 优先 `build/<包>`) |
| **用例级**(点用例) | `<文件>::<类>::<方法>` 选择器 | `--gtest_filter=<真名>`,如 `TEST_P` 用 `*/AdderParamTest.param_macro/*` | —(仅整文件) |

判定永远以**结果工件**(junit / gtest XML)为准,不只看退出码:`pytest` 退出码 `4`/`5` 表示「未收集到任何用例」(报 errored 而非 failed);`gtest` 在过滤无命中时同样退出 0(该情形报 errored 而非静默通过)。

扩展**不替你构建**:测试可执行缺失时该项报 errored 并提示先 `colcon build <包>`(官方流程即先构建后测试)。包级运行还有**前置闸门**:`COLCON_IGNORE` 的包与无 `build/<包>` 的包会被立即报告(根本不启动 colcon 进程)。

## 测试发现

**各语言的清单来源**(2026-09-24 更新):

* **Python(pytest)** —— 对工作区做源码扫描,找 `test_*.py` / `*_test.py` / `*.test.py`(大小写不敏感)。**不在任何 ROS 包内**的文件也会列出(纯 pytest 文件本就可直跑),归入「(未归类)」节点。
* **C++(gtest)与 launch 测试** —— 来自**构建记录**:`build/<包>/CTestTestfile.cmake` 的 `add_test` 注册。测试种类取自 `LABELS`(`gtest` / `launch_test`),可执行(gtest)或源文件路径(launch)取自注册的 `--command`,声明位置(`CMakeLists.txt:<行>`)取自 `_BACKTRACE_TRIPLES`——显示在条目描述里。因此:
  * 从未构建的 `.cpp` 测试**不显示**(没有可运行的东西——这正是官方「先构建后测试」流程,扩展绝不代构建);
  * `*_launch_test.py` 不再需要内容嗅探——注册即权威;
  * `colcon build <包>` 后自动重读该包注册(无需手动刷新),注册消失的测试会被摘除。

发现是**增量**的,不做周期性全扫:

* 保存测试文件只重析**该文件**(旧结果立即失效)——用例的增删即时反映到树;
* 创建/删除测试文件只增/删该文件节点;
* 新增/改名/删除包(或切换 `COLCON_IGNORE`)只更新受影响的包;
* `colcon build <包>` 自动更新该包状态(运行入口 /「未构建」标注);
* 手动全量重扫随时可用:视图**刷新**按钮或 `ROS2.tests.refresh` 命令(会报告发现了多少项)。自动重扫在文件扫描超时时保留旧树;手动刷新强制落地。

### 排除测试发现

可将特定文件夹排除出测试发现(与包扫描共用配置),把第三方/子模块测试挡在测试资源管理器外:

**设置:**
- **ROS2.search.excludeFolders**:文件夹路径(或目录名)列表

**示例配置**(`.vscode/settings.json`):

```json
{
  "ROS2.search.excludeFolders": [
    "build",
    "install",
    "log",
    "node_modules",
    "${workspaceFolder}/external",
    "submodules"
  ]
}
```

**支持的路径格式:**
- 绝对路径:`/absolute/path/to/exclude`
- 相对路径 / 目录名:`submodules`、`external`(相对工作区根)
- 变量替换:`${workspaceFolder}/external`

文件夹被排除后,其内部一切(含子目录中的测试文件)在测试发现中被忽略。
