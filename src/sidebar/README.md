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

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-17 00:20 | **两类分类落地 + sourceMissing 误报根治(用户定义;机制详见 install-truth/README 同日条)**:①**第一类(generated,自动生成:rosidl 生成头/生成 .py/egg-link 记账)tooltip 时间只显示落点(install)单行**——源是 build 中间物,对考古无意义;②**第一类豁免 C 类源缺失报警**三消费点(iconPlanOf warning 分支/fileNodeOf ⚠ 徽标/点击探针源时间守卫)——软链生成头 build 目标丢失自然显示断链(此前 dangling 与 sourceMissing 同真时 warning 优先会盖掉);③**getTreeItem 现查成功清除 sourceMissing**(误报根治:装配层冻结的 ⚠ 此前跨渲染永久存活,p13_msgs rosidl 生成头实报案);④点击探针任意不一致后 `fire(node)` 定向重绘(显示层冻结当场愈合);⑤第二类恒双行与左 src/右 install 跳转不变。build-map 测试 +5(纯增零翻转),junit 真实 testcase 1349→1354、0 失败 |
| 2026-10-17 00:30 | **眼睛位置跳变真根因破案(用户 DevTools DOM 探针实测 + 1.124.2 源码逐层核验)**:用户带 DOM 探针输出回归——隐藏态 `[refresh, eye-closed]`、显示态 `[eye, refresh]`,显示态反转实锤;静态层逐层排除(F5 最新代码 initData 铁证/1.124.2 commit 6928394f 的 MenuService→ViewMenuActions→ViewPane 三层源码逐行按 order 升序/persisted menu-hide 全存储无键/清单 order 在位)后命中真根因:**package.json 的菜单贡献点根本不支持独立 `order` 属性**(1.124.2 menusExtensionPoint.ts `IUserFriendlyMenuItem` 仅 command/alt/when/group 四字段,`item.order` 唯一赋值点 = group 字符串 `@` 后缀解析)——10-15 写的独立 `"order": 1/2` 是**无效属性被静默忽略**,运行时三条目 order 全空,比较器退回**按命令标题字母序**(Hide < Refresh < Show,H<R<S),恰好逐字节解释全部历史观测(shown 态眼在左/hidden 态眼在右/最早两张截图)。修复=改写 `navigation@1` / `navigation@2`(group 后缀才是正道),死属性删除。**连带修正**:10-16"context-when 重渲染不可靠"假设作废(when 切换一直生效,位置自始是标题序),context key 换轨保留(无害加固);清单一处改动即修复,无代码变更 |
| 2026-10-16 23:40 | **落点时间语义终版:恒双行(用户怒批"单行无法判断先后,越改越回去"后的二次修正,再废同日 23:10 行的合并保留)**:tooltip 时间戳**恒双行**——源修改时间(数据)+ 落点修改时间(指针本体),分形判定:叶子链行(link=true)指针=链自身 lstat(installPath);经目录链行(develop 导出行/Form A 目录链行)指针=上游目录链 **lstat(viaLinkPath)**(目录链建立时刻≈安装时刻;lstat 叶子会穿透目录链拿回数据时间,那不是指针的);实体行=文件自身。字段链补 viaLinkPath+link(SidebarRow/rowsOf/TreeNode/fileNodeOf);getTreeItem 与点击探针同口径;isSymlinkForm 与 "Mtime" 册键随合并分支废除。机制详见 install-truth/README 同日条;junit 真实 testcase 1349、0 失败(断言翻转无新增) |
| 2026-10-16 23:40 | **眼睛图标切换换挂自设 context key(用户实测"图标变动仍未修复";部署 manifest 已核对在位)**:诊断=双命令显隐靠 `config.ROS2.ui.showLeftovers` when 翻转,而 view/title 标题按钮对 `config.*` 上下文的重渲染不可靠;修复=可见性改由扩展 `setContext` 推送的 `ros2.sidebar.leftoversShown` 上下文键驱动(三处接线:激活按设置回填/眼睛命令切换即推/设置页变更监听同步+重绘),`ROS2.ui.showLeftovers` 设置只作持久层(设置页同键不变);菜单 when 全换自设键(order 1/2/2 与图标声明不动)。junit 真实 testcase 1349、0 失败 |
| 2026-10-16 23:10 | **右键「打开安装侧文件」+ 落点时间语义修正(指针/数据模型,用户定义;详见 install-truth/README 同日条)**:①右键菜单本体此前完全空置,新注册 `ROS2.sidebar.openInstallSide`(菜单组 1_install,when 圈定三种文件行;软链行打开链路径=链跳链,实体行打开实体,严格限定 install/;入口先走点击探针;openPath 复用预览标签/缺文件警告);②tooltip 安装侧现查改 **lstat**(指针本体时间:叶子软链行=链接建立时刻,悬空行也显示),中文值改名「安装修改时间」→「**落点修改时间**」(英文键不动),rowTooltip 合并规则窄化——叶子软链行恢复双行(源=数据时间/落点=指针时间,可不同步),仅经目录链进入行保留合并单行(**推翻 10-14 合并裁定**);③点击探针安装侧比对同口径 lstat;陈旧运行警告保持 statSync 跟随(运行语义与考古分离)。zh 册防回退钉 +1,junit 真实 testcase 1348→1349、0 失败 |
| 2026-10-16 22:30 | **Python 导出区补采(展示面零逻辑改)**:truth 层 Form B(develop/egg-link)补采后,ament_python 包的「Python 导出」区自动出现——模块行(经 build 镜像链,viaLink→src,软链合并行文案"改了立即生效")+ `<dist>.egg-link` 记账行(generated 灰类,来源说明"记账用,解释器不读取");状态=installed/generated 走既有判定,丢失报警挂生效层(镜像链丢→❌ missing,消失行合成)。机制与口径详见 install-truth/README 同日条;junit 真实 testcase 1343→1348、0 失败 |
| 2026-10-16 20:10 | **时间戳自愈(装配契约改版,详见 install-truth/README 同日条)**:①双 mtime 的 stat 从装配层(根 getChildren 批量注入后焊死)迁 **getTreeItem 显示瞬间现查**——文件行渲染当下 stat 源/安装双侧(悬空跳过安装侧),tooltip 经 `rowTooltip` 同源重建(软链合并行/形态行/include 生成头附加行语义不变),现查值写回节点供点击探针比对;装配层每行 2 stat → 1 existsSync(只留 sourceMissing);②**Ctrl+S 定向重渲染**:`onDidSaveTextDocument`(编辑器事件零 watcher)经 sourcePath→节点索引 fire 单行,VS Code 只重渲染该行;③点击探针分诊:状态不一致→该包 `refreshIncremental([pkg])`(原全量改增量)、安装时间变→重画行+该包增量、源时间变→仅重画行、包节点新增 rc 瞬时值 vs buildTimeMs 核对(**推翻 10-14「mtime 差异不构成不一致」**);④树模型 TreeNode +6 可选字段。junit 真实 testcase 1337→1343、0 失败 |
| 2026-10-04 19:34 | i18n 期0(骨架,英文源+中文册已批):`install-truth-sidebar` openPath 源文件缺失弹窗两按钮「复制路径/打开所在目录」字面量改同源常量 BTN_COPY_PATH/BTN_OPEN_DIR——按钮同时是显示文案与返回值匹配键(双角色),l10n 化后返回值=翻译串,比较必须引用同一常量;行为零变化,全套 1307 用例 0 失败 |
| 2026-10-04 16:48 | 目录行去图标(用户裁定"资源管理器口径"):iconPlanOf dir 分支→`{tag:"none"}`(适配层三连空不设,渲染器不画图标),区头 folder 保留;详见 install-truth/README 修改记录同日条 |
| 2026-10-04 14:51 | 图标双改:树文件行接**文件图标主题**(iconPlanOf 纯函数上移 tree 模块 + getTreeItem 设 resourceUri+ThemeIcon.File;用户裁定「有源路径才换」,missing/无源/虚拟节点维持 codicon,iconOf 退役)+ 活动栏图标换 R 字母 monogram(裁定与知情项详见 install-truth/README 修改记录同日条) |
| 2026-09-29 | 建档(补各文件夹 README 批次):本目录此前无 README,演进全在源码头注释与 install-truth/README 修改记录(2026-09-21 建视图 → 09-25/26 七批:launch 区提升/黑名单硬排除/rosidl 过滤/包属性/manifest 宽限差/布局写标题/构建行内化) |
