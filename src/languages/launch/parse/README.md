# src/languages/launch/parse/ — launch.py 文本解析

> launch 模块 2026-09-30 分层(LD-6.5)自 src/languages/launch/ 平铺迁入(git mv,历史不变)。
> launch.py 静态解析唯一实现,ui 层的链接/悬浮/跳转/补全共用同一条解析链路。

## 定位

launch.py **文件内静态解析**:注释/docstring 掩码、简单赋值变量表、include 表达式扫描(join 语义门 +
字面量)、Node 系调用定位。口径(用户 2026-09-06 定稿):假设启动文件不引入外部变量,只做文件内静态
解析;**解析不成功 → 静默**(不给假链接、不弹"未解析")。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| launch-py-parser.ts | 510 | maskPythonNoise(注释/三引号 docstring 等长掩码,offset 不变);collectSimpleVars/evalStaticExpr(字面量 / get_package_share_directory / os.path.join / 变量引用,深度限 5);scanLaunchIncludes(join+语义门 joinLooksLikeLaunch[含 AnyLaunchDescriptionSource]+字面量含 yaml;**LD-4 呈现范围收窄为末段 .launch.* 字面量引号内内容**,全跨度 covered 数组承接字面量去重;解析失败静默过滤);scanLaunchNodes(死导出遗留);pyNodeCallAt(LA-3 跳转/悬浮定位,值 range 不含引号,嵌套取内层) |

## 依赖与接线

- 入边:ui/launchpy-provider(链接+悬浮)、ui/launch-definition-provider(F12)、ui/launch-completion(LC-5 目标参数名)、core/launch-args(maskPythonNoise)、test/suite/launch-py-parser.test.ts、launch-exec-navigation.test.ts;
- 出边:languages/shared/package-map(类型)、logger、vscode(Uri 类型);
- 规则:掩码后扫描一律基于等长文本(offset 不变);凡"目标不可静态解析"一律静默过滤,不产半成品记录。

## 修改记录

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-30 02:15 | 目录化建档(LD-6.5):自 src/languages/launch/ 迁入(git mv;相对 import 上移);LD-4 落地:join 案 start/end 收窄为末段字面量引号内内容,新增 covered 全跨度数组承接字面量去重(原判定直接用 start/end,窄化后不再罩住 join 内字面量,实测双重成链 2 条链接暴露) |
| 2026-09-25 18:10 | (迁入前,原模块根)LA-3:pyNodeCallAt 新增(值 range 不含引号,嵌套取内层),见模块根 README 修改记录 |
