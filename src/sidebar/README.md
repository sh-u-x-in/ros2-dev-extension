# sidebar/ — 「包内容」侧边栏视图

> install-truth 真值域的展示适配层:树模型(纯 TS 可无头测)+ 薄 vscode 适配。
> 视图 = 活动栏「ROS 2 包」→ 包 → 展示区(lib / launch / Python 导出 / 资源 / 头文件)→ 行。
> 数据与设计事实源 = `../install-truth/README.md`(两源立论/调用纪律/修改记录七批)。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `install-truth-tree.ts` | 497 | **纯树模型(零 vscode)**:SIMPLE_DISPLAY 裁剪开关、isRosidlIntermediate(rosidl 中间产物过滤)、五展示区(launch 为 share 提升区)、foldRowsToTree(目录树折叠 + 单分支合并)、iconPlanOf(行图标决策:有源路径→文件图标主题,其余语义 codicon)、openTargetOf/runPayloadOf/packageNodeOf(installFormOf 以 install 观察为准 / buildType / 目录前置)、layoutOfViews、buildTree |
| `install-truth-sidebar.ts` | 326 | **薄适配层**:命令 ID 常量(ros2.installTruth / refresh / openSource / runExecutable / launchFile / buildPackage)、InstallTruthSidebarProvider(惰性绑定工作区、预览标签跳转、iconPlanOf→resourceUri+ThemeIcon.File 翻译、▶ 委托 run 域)、registerInstallTruthSidebar(extension.ts:337 接线,注入 packageCore) |

## 依赖方向

消费 `install-truth` api(共享数据中心 shared-center)+ `run`/`launch-detect`(直连,避 vscode 链)+ `build` 的 buildSinglePackageByName;
被 `extension.ts` 注册。树模型单测挂在 `test/suite/build-map.test.ts`。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-04 19:34 | i18n 期0(骨架,英文源+中文册已批):`install-truth-sidebar` openPath 源文件缺失弹窗两按钮「复制路径/打开所在目录」字面量改同源常量 BTN_COPY_PATH/BTN_OPEN_DIR——按钮同时是显示文案与返回值匹配键(双角色),l10n 化后返回值=翻译串,比较必须引用同一常量;行为零变化,全套 1307 用例 0 失败 |
| 2026-10-04 16:48 | 目录行去图标(用户裁定"资源管理器口径"):iconPlanOf dir 分支→`{tag:"none"}`(适配层三连空不设,渲染器不画图标),区头 folder 保留;详见 install-truth/README 修改记录同日条 |
| 2026-10-04 14:51 | 图标双改:树文件行接**文件图标主题**(iconPlanOf 纯函数上移 tree 模块 + getTreeItem 设 resourceUri+ThemeIcon.File;用户裁定「有源路径才换」,missing/无源/虚拟节点维持 codicon,iconOf 退役)+ 活动栏图标换 R 字母 monogram(裁定与知情项详见 install-truth/README 修改记录同日条) |
| 2026-09-29 | 建档(补各文件夹 README 批次):本目录此前无 README,演进全在源码头注释与 install-truth/README 修改记录(2026-09-21 建视图 → 09-25/26 七批:launch 区提升/黑名单硬排除/rosidl 过滤/包属性/manifest 宽限差/布局写标题/构建行内化) |
