# commands/ — 域外命令注册入口

> **注意区分**:`ros2/commands` = 命令域**接口实现**(Ros2ServiceApi/RosTaskRunner);本目录 = 挂在域外的**注册杂项**
> (测试命令/欢迎页),`index.ts` 的 `registerAllCommands` 统一入口分发。

## 文件

| 文件 | 职责 |
|:--|:--|
| `index.ts` | `registerAllCommands` 统一入口,分发 4 路——ros2/registry 的 terminal+core、本目录 tests+welcome;文件内注释记录 launch-tree/colcon/create 各注册的迁出史 |
| `tests.ts` | `registerTestCommands`:测试发现刷新/运行全部/调试全部(经 extension 的 rosTestProvider + Commands) |
| `welcome.ts` | `registerWelcomeCommand`:欢迎演练(WALKTHROUGH_ID ← src/onboarding.ts) |
| ~~`launch-tree.ts`~~ | 整文件注释墓碑(2026-08-28 launch-tree 废弃),2026-09-29 零引用清理物理删除(git 历史可查) |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-04 20:35 | i18n 期2 首批:tests.ts 刷新弹窗+未初始化警告(双处同串)+4 日志、welcome.ts/index.ts 3 日志改 `vscode.l10n.t("英文源")`+中文进 bundle(「Executing command: {0}」跨文件共享键);详见 src/README 修改记录同日条 |
| 2026-09-29 | 建档(补各文件夹 README 批次):与 ros2/commands 的易混淆点写明;launch-tree.ts 墓碑删除注记 |
