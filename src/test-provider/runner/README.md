# runner/ — 执行层

**定位**:"怎么跑"。拼命令、spawn、超时/取消/输出回灌;**只执行,不判成败**——成败由 `semantics/` 的 verdict 依据产物判定。

**文件**
- `ros-test-runner.ts` —— 分流(`runTest`)+ 四条运行路径(文件/用例级 pytest、gtest、launch_test 整文件、包级 colcon test)
- `artifact-path.ts` —— 临时产物唯一路径(`nextArtifactPath`,防并行撞名)

**边界**:不读树状态之外的全局;不决定"该不该跑"以外的策略;包级运行的前置闸门见 `packagePreflight`(semantics)。

**依赖方向**:可 import `semantics/`(verdict)、`parsing/`(XML 解析)、`reporting/`(上报);被 `provider/` 调。

**无头可测性**:全部需宿主;纯逻辑已外移(`artifact-path`、verdict、filter 均在别处可无头测)。
