# parse/ — rosmsg 解析纯层

> .msg/.srv/.action 文本解析与格式化(零 vscode 渲染决策)。域级总览见 `../README.md`。

## 文件(3 TS)

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `rosmsg-document.ts` | 333 | 结构模型/解析器:字段/常量/注解行解析 + getCompletionContext(光标上下文判定) |
| `formatter.ts` | 262 | 格式化纯函数:列对齐梯度分档(读 `ROS2.msg.formatGradientStep`)+ @optional 单/双行切换阈值(`formatLineThreshold`) |
| `semantic-token-builder.ts` | 51 | **死代码(R13 后无运行消费者,仅单测保留)**:语义 token 构建器;2026-08-16 决策——semantic token 覆盖 TextMate 致配色时序错乱,provider 空注册后整体退役 |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):三文件职责自头注独立成档;semantic-token-builder 死代码状态如实钉明(有单测消费,不属零引用清理范围) |
