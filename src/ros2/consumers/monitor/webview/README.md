# webview/ — 状态页前端

> 状态页 webview 的前端 TS(由扩展侧编译为独立 bundle,HTML 以经典 `<script src>` 加载)。

## 文件

| 文件 | 职责 |
|:--|:--|
| `ros2_webview_main.ts` | 入口 + 消息中枢(webpack entry,禁 export):window.onload、助手启停按钮、window message 唯一分发器、webviewReady 握手、数据指纹不变跳过重渲染、节点区/话题/服务/动作/参数渲染调度、易失日志世代作废 |
| `shared/i18n.ts` | 前端 i18n 运行时:t() 查 L10n 册(bundle 1421 键;无头测试回退英文源)(期4 新增,二十轮分层归 shared/) |
| `shared/context.ts` | `vscode = acquireVsCodeApi()` 单点获取 + sendLog 日志转发(十九轮批3 自 dom-utils 迁入) |
| `shared/dom-utils.ts` | DOM 工具层(零 vscode 依赖):容器清空、指纹规范化序列化、剪贴板复制、动作反馈小字、buildCollapsibleSection 可折叠区块(十七轮) |
| `shared/hover-tip.ts` | 即时悬浮:placeTipInViewport(七~十轮:瞬时选位/两向呼吸边/按内容收窄/亚像素防折行)+ attachHoverTip + buildInfoIcon |
| `panels/topics-panel.ts` | 话题列表 flex 行(订阅/复制命令) |
| `panels/lifecycle-panel.ts` | 节点区(十七轮):节点行 + 生命周期卡片内联(状态图/缩放/迁移触发/transitionsInFlight 守卫/详情缓存/每节点完整图开关);终端回执日志经 lifecycle-log |
| `panels/lifecycle-log.ts` | 生命周期回执终端日志域(十九轮批4a 拆出):按节点记忆(易失:助手世代更替全清/节点消失清该节点)、HH:MM:SS.mmm 格式、封顶 200 行、DOM 构建/追加/回放 |
| `panels/param-tree.ts` | 参数文件树:折叠集合/面包屑压缩/五色值/截断「…共 N 项」/打开完整内容落盘;叶子不显 (1)、分支行尾 [][-] 成对(十六轮) |
| `forms/form-model.ts` | 表单模型层:字段树/状态树类型、类型谓词、初始化回填、请求 JSON 组装、可折叠路径收集(防环:fields→model→render→panel 单向) |
| `forms/form-fields.ts` | 表单字段交互:类型灰字(基本行右推行尾)、textarea 自增高、校验红描边+!徽标、键盘流转 attachFormInputKeys |
| `forms/form-render.ts` | 表单渲染层:组头折叠方块、局部一键展开/收起、消息组/消息数组/基本数组/标量行(行序十三轮) |
| `forms/form-panel.ts` | 服务/动作区块:复合行展开即渲染、整区重绘(焦点按字段路径存活)、formStates 清理 |
| `graph/state-graph.ts` | 生命周期状态图 SVG 渲染编排(hover 样式/marker/边与节点绘制/label 防碰撞;视图数据见 state-graph-view.ts,布局域见 state-graph-layout.ts) |
| `graph/state-graph-view.ts` | 状态图视图数据域(十九轮批4a 拆出):静态转换表/语义集合/unknown 条件过滤/StateGraphNode/buildGraphView(完整图/压缩过渡态/静态表兜底) |
| `graph/state-graph-layout.ts` | 状态图布局几何域:dagre 布局、曲线采样/弧长参数化、锚点顺序打点、label 测宽(canvas+Node 回退) |
| `shared/icons.ts` | 内联 SVG 图标(EXPAND/COLLAPSE 为 2026-10-03 用户重绘 codicon 风格 fill+evenodd;COPY/EXEC 描边风格;统一 currentColor 随主题 + `--vscode-*` 变量) |

## 硬约束(踩过的坑)

**产物必须为经典脚本**——webpack 该 entry 禁用 `experiments.outputModule` / `libraryTarget:"module"`,
否则产物带顶层 `export`,经典 `<script>` 加载即抛 SyntaxError,**整段前端不执行**
(2026-09-09「点击无反应 + 占位永驻 + 无前端日志」的总根因)。验证:`node --check` 通过、无顶层 export。

## 修改记录

> 轮次图例:批次1-3 与 四~六轮 = 2026-09 下旬表单/键盘迭代系列;七~十轮 = 2026-10-03 悬浮框系列;
> 十一轮起 = 2026-10-03 表单行序/状态页/生命周期系列(补 N 为同轮追加)。
| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):icons.ts(09-28 新增)入表;经典脚本硬约束从 consumers/README 落到本目录文档 |
| 2026-10-03 | 十二轮拆分(单文件 <500 行):ros2_webview_main.ts 2139 行 → 入口 312 + 10 模块(namespace 转 ES 模块,依赖单向无环);state-graph.ts 702 行 → 455 + state-graph-layout.ts 257;产物名 ros2_webview_main.js 与 state-graph 导出不变(测试 require 兼容);顺带去除未用 STANDARD_STATES 导入 |
| 2026-10-03 | 十三轮行序重排(用户裁定):复合组头=方块·名字·(N)·A(仅数组)/行尾=类型·元素个数(仅数组)·展开·收起;基本行=名字·输入框·类型;(N)=基本行计数(countBasicRows,宿主内全部可输入行嵌套全算,所有复合组头都放,与名字 12px 两空格间距,与元素数语义不同故行尾计数保留);服务/动作行一键展开/收起移至服务行尾(类型之后,展开且有字段时显示,stopPropagation 防误触发行折叠) |
| 2026-10-03 | 十七轮:五大区块(节点/话题/服务/动作/参数)标题行尾 ▾/▸ 可折叠(buildCollapsibleSection+sectionCollapsed 跨刷新记忆,默认全展开);生命周期独立区块取消并入节点区(renderNodesSection:生命周期节点行尾 ▸/▾ 展开=原卡片,折叠不渲染 SVG,展开集合/完整图开关模块级记忆,generateColumnTable 零引用删除) |
| 2026-10-03 | 十四轮:展开/收起图标换用户重绘 codicon 风格(EXPAND/COLLAPSE fill+evenodd 镂空,COPY/EXEC 描边不变);十五轮:基本行类型标识右推行缘(appendTypeDim pushRight);十六轮:参数树叶子去 (1)、分支行尾 [][-] 成对 |
| 2026-10-03 | 十八轮:生命周期交互收口——转换回执后刷新 + triggerTransition in-flight 守卫 + 详情缓存防蒸发(P1/P2);转换协议键 transitionId 修 rid 覆盖(UI 转换全坏真因);补三 完整图开关降为每节点属性;补四 回执改终端式日志区(lifecycle-log:HH:MM:SS.mmm/封顶 200 行/图下独立块,toast 退役);补九 日志易失化(助手世代更替全清/节点消失清该节点) |
| 2026-10-03 | 二十轮目录分层:webview 17 模块收四子层——shared/(context/i18n/dom-utils/hover-tip/icons,含期4新增 i18n.ts)/panels/(topics/lifecycle/lifecycle-log/param-tree)/forms/(model/fields/render/panel)/graph/(state-graph 三件);入口 ros2_webview_main.ts 留根(webpack entry 与产物名零改动);组内 29 处相对导入重写;test 与 scripts/state-graph-render.cjs 路径连带 |
| 2026-10-03 | 十九轮全面修正(审计驱动):批1 复制命令引号转义真 bug;批3 分层微调(section 图标参数化、sendLog 迁 context、dom-utils 零 vscode 依赖);批4a 三文件拆分(param-helper-client→protocol/tree-build;lifecycle-panel→lifecycle-log;state-graph→state-graph-view);批5 注释/命名修正(helperAction 线字段/helper-* id/轮询措辞清理);批6 README 三份同步+轮次图例 |
