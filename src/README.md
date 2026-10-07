# src/ — 扩展源码根

> 扩展 TypeScript 源码;入口 `extension.ts`,webpack 打包产物 `dist/extension.js`(package.json `main`)。
> 各子域结构与设计详见各目录 README(本文件只做一层导航)。

## 一层清单

| 文件/目录 | 一句话 |
|---|---|
| `extension.ts` | 扩展主入口:激活/生命周期/组合根装配(packageCore → PackageMap 喂入 → 各域注册) |
| `logger.ts` | `getLogger` 日志薄封装(统一进「ROS 2」LogOutputChannel,模块前缀) |
| `onboarding.ts` | 欢迎演练 walkthrough(ROS2.showWelcome;`ui.showWelcomeOnStartup` 弹窗) |
| `error-utils.ts` | 共享错误处理(`ensureErrorMessageOnException` 等) |
| `vscode-utils.ts` | vscode 工具(如 `createOutputChannel`) |
| `telemetry-helper.ts` | 遥测薄封装 |
| `cpp-formatter.ts` | ROS C++ 风格/clang-format 整理(源自 roscpp_code_format) |
| `ros2/` | 核心域:环境/命令执行/api 组合根/状态页消费者/命令注册(见 ros2/README.md) |
| `build-tool/` | 包数据 + 构建服务(见 build-tool/README.md) |
| `test-provider/` | 测试域:发现/执行/上报(见 test-provider/README.md) |
| `commands/` | 域外命令注册入口(测试命令/欢迎页;见 commands/README.md) |
| `install-truth/` | install/build 两源真值域(见 install-truth/README.md) |
| `languages/` | 语言服务:rosmsg/xacro/launch/py·cpp 片段(见 languages/README.md) |
| `sidebar/` | 侧边栏「包内容」视图适配层(见 sidebar/README.md) |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-04 20:35 | i18n 期2 首批(02 号档案=入口与根命令,显示+日志一并做):extension.ts 2 弹窗+5 日志、onboarding.ts 欢迎弹窗 4 串(「不再显示」双角色调用点常量)+6 日志、cpp-formatter 3 日志、vscode-utils 端口 throw 1——全部改 `vscode.l10n.t("英文源")`,中文译文收 `l10n/bundle.l10n.zh-cn.json`;无头 stub l10n.t 补 {N} 插值替换(与真实宿主同语义);全套 1307 用例 0 失败 |
| 2026-09-29 | 建档(补各文件夹 README 批次):src 根一层导航——文件一句话 + 各子域指路;设计文档参考 `设计/ARCHITECTURE/` |
