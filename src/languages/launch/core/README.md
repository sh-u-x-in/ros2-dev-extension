# src/languages/launch/core/ — launch 补全纯逻辑(候选目录·上下文判定·声明提取)

> launch 模块 2026-09-30 分层(LD-6.5)自 src/languages/launch/ 平铺迁入(git mv,历史不变)。
> launch-completion-core 零 vscode 依赖可无头测;launch-args 仅依赖 parse/ 与 shared/xml-utils。

## 定位

与 ui/(vscode 提供器)解耦的纯逻辑层:三格式候选目录(结构片段/属性/kwargs/枚举/$() 命令)、
光标上下文判定(pyAttrContextAt/xmlCursorAt/yamlCursorAt/varArgTypedWordAt 等)与参数声明提取
(declaredArgs*)。供 ui/ 的补全与悬浮查询;零 vscode.languages 注册、零 UI 决策。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| launch-completion-core.ts | 1147 | 补全纯核心:Candidate 统一形态与片段目录(py 14 条保真/XML 主标签+附加/yaml 动作)、三格式光标上下文、LC-2/3 尾段 $() 判定(substCommandPrefixAt/varArgTypedWordAt,**LD-2 改值内尾段口径**——值中后续 $() 亦识别)、LC-6 kwargs 目录(PY_KWARGS 10 调用)、PY_ATTR_TAIL_RE(**LD-2 收编 output/respawn**,LC-7 py 枚举死路复活)、xmlValueSource/yamlValueSource(arg-ref 携带 typed 供词锚 range) |
| launch-args.ts | 215 | 参数声明提取(LC-1):三格式统一 LaunchArgDecl{name, default?, declOffset, declLineText}——py DeclareLaunchArgument 掩码扫描 / xml `<arg>` lezer(属性序无关)/ yaml `- arg:` 块;declLineText 供悬浮与补全文档(LD-5 首消费方);只读纯函数 |

## 依赖与接线

- 入边:ui/launch-completion(补全)、ui/launch-hover-provider(悬浮)、test/suite/launch-completion.test.ts(core 头测)、launch-exec-navigation.test.ts;
- 出边:launch-args → ../parse/launch-py-parser(maskPythonNoise)、languages/shared/xml-utils;launch-completion-core 零依赖;
- 规则:本层零 vscode、判定一律纯函数(文档文本进、结论出)。

## 修改记录

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-30 02:15 | 目录化建档(LD-6.5):两文件自 src/languages/launch/ 迁入(git mv;launch-args 相对 import 上移);LD-2 落地:substCommandPrefixAt/inVarArgPosition 改值内尾段口径(unclosedDollarParenTail)、varArgTypedWordAt 新增、PY_ATTR_TAIL_RE 收编 output/respawn、xmlValueSource/yamlValueSource arg-ref 带 typed |
| 2026-09-27 21:30 | (迁入前,原模块根)LC-1 建档 launch-args.ts + LC-2/3/6/7 core 扩展,见模块根 README 修改记录 |
