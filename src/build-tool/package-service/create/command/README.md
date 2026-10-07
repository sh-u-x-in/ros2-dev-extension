# command/ — 命令注册与交互向导

> create 子域的用户侧入口。**唯一允许依赖 VS Code API 的层**;生成器/命名/依赖域保持纯逻辑可测。
> 创建:2026-09-04 17:11(等价变换分类后补各子目录 README)。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `create-command.ts` | 命令注册壳:3 条右键命令(`ROS2.createCppPackage` / `createPythonPackage` / `createMixedPackage`),经 `ensureErrorMessageOnException` 包裹,委托交互入口 | vscode、`./create-package-command` |
| `create-package-command.ts` | 交互向导:目标目录 → 包名(实时校验 + 文件夹冲突重输)→ 依赖多选(`deps/dep-pick`)→ 示范节点(C++/Python 各一次)→ 映射顺延 → 调生成器 → 写盘 → `packageCore.ingestPackageCreated` | vscode、fs、`../generate/*`、`../naming/package-folder`、`../deps/dep-pick`、extension(packageCore) |

## 边界与依赖方向

- 弹窗顺序:包名 → 依赖(QuickPick 多选 + 可选自定义)→ 示范节点(C++/Python 各一次);任一阶段 Esc = 终止整个流程(返回 null),不写盘;
- 名称语义(create/README §4/§7):C++/脚本输入 = 文件基名(宽范围,可含连字符)原样写盘,节点名经 `naming/names` 有损映射(`-`→`_`)与顺延;Python 模块(mixed/ament_python)输入即标识符恒等;
- 本层不掺校验/模板逻辑,只编排与 UI;生成产物决定权在 `../generate` + `../templates`。

## 扩展位(后续调整入口)

- 新增创建命令/入口:在本目录注册 + 向导加分支;
- 弹窗文案、输入框口径(文件基名 vs 模块名)只改 `create-package-command.ts`;
- 生成包内容升级不落本层(改 `../templates`)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-07 | 向导 5 弹窗标题化(flowTitle 流名 + 「① Package name」式步骤键拼装;⚠️ l10n.t 首参必须字面量——三元合并式首参对 i18n 对账工具不可见,flowTitle 与 Python 节点框已改分支各写字面量)+ 占位符/Python prompt 清残 + 成功 toast kindLabel 碎片(Hybrid 键) |
| 2026-09-04 17:11 | 建档:create/ 分类后补子目录 README——command/(注册壳 + 交互向导)职责与边界 |
