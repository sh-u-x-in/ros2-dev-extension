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
| 2026-10-18 | **统一命令围栏(P1)**:新增 gated-command.ts——registerGatedCommand(调用时查门:注册先于环境检测;实参透传:旧错误边界不转发参数;异常兜底内联)+ GATE_REFUSALS 五域拒绝文案(键=既有执行层同键,字面量集中此处保证 i18n 审计可见)。12 门内注册点统一(run/launch/build×3/rosdep/createTerminal/tests×2/sidebar×3);豁免显式化:doctor/showWelcome/create×3/toggleIgnore/侧边栏纯 fs 5 条/showDaemonStatus;regenerateIntellisenseConfig 不入门(自带 env/packages 解释门,wrapper 会埋掉解释)。tests.ts 两命令改包装器(无环境从逐包 N 条 errored 变入口一句拒绝;执行层 rejectIfNoEnv 保留=Test Explorer 纵深);测试=gated-command 套件 4 例 |
| 2026-10-04 20:35 | i18n 期2 首批:tests.ts 刷新弹窗+未初始化警告(双处同串)+4 日志、welcome.ts/index.ts 3 日志改 `vscode.l10n.t("英文源")`+中文进 bundle(「Executing command: {0}」跨文件共享键);详见 src/README 修改记录同日条 |
| 2026-09-29 | 建档(补各文件夹 README 批次):与 ros2/commands 的易混淆点写明;launch-tree.ts 墓碑删除注记 |
