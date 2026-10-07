// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file monitor-css-forms.ts
 * 核心状态页 CSS 后半(2026-10-03 十二轮自 ros2-monitor.ts 拆出):
 * 话题/服务条目行/图标按钮尺寸/动作回执小字/服务动作复合行与调用表单/即时悬浮/键钮/离线提示。
 * 与 monitor-css-base.ts 在 monitor-html.ts 拼接为完整 <style> 内容;样式逐行 verbatim 搬移
 * (唯 .form-call-btn 后两行 JS 风格 // 注释转为 CSS 注释——原文本就非法混在 <style> 块内)。
 */

/** 状态页样式后半:话题/服务行 → 离线提示(行序与拆分前一致) */
export const MONITOR_CSS_FORMS = `
        /* ── 话题/服务行(2026-09-26 批次1:话题表换 flex 行,行尾"订阅"行内动作;服务/动作区批次2复用) ── */
        .entry-list {
            margin: 6px 0;
        }
        .entry-row {
            display: flex;
            align-items: baseline;
            gap: 10px;
            padding: 2px 4px;
        }
        .entry-row:hover {
            background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
        }
        .entry-name {
            color: var(--vscode-foreground);
            word-break: break-all;
        }
        .entry-type {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            word-break: break-all;
        }
        /* 类型右对齐到行尾(2026-09-26 用户裁定:类型不紧跟名称) */
        .svc-header .entry-type,
        .entry-row .entry-type {
            margin-left: auto;
        }
        .entry-action {
            flex: 0 0 auto;
        }
        .entry-action.param-open-file {
            margin-left: 0;
        }
        /* 节点行(2026-10-03 十七轮):生命周期节点行尾 ▸/▾ 展开状态图卡片,卡片缩进挂行下 */
        .node-toggle {
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            user-select: none;
            padding: 0 4px;
        }
        .node-toggle:hover {
            color: var(--vscode-foreground);
        }
        .node-item > .lifecycle-node {
            margin: 6px 0 0 14px;
        }
        /* 图标按钮(2026-09-27:内联 SVG 替代 [+]/[-]/复制/订阅/调用 文本) */
        .param-tree-btn svg {
            width: 13px;
            height: 13px;
            display: block;
        }
        .entry-action svg,
        .entry-action-copy svg,
        .form-actions-line .param-open-file svg {
            width: 15px;
            height: 15px;
            display: block;
        }
        .form-call-btn svg {
            width: 15px;
            height: 15px;
            display: block;
        }
        /* 动作回执行内小字(订阅/调用/发送目标结果,渲染重建后由 commandResult 重新写入) */
        .topic-action-status, .svc-action-status, .goal-action-status {
            margin-left: 12px;
            font-size: 12px;
            font-weight: normal;
            color: var(--vscode-descriptionForeground);
        }
        /* ── 服务/动作可展开复合行 + 调用表单(2026-09-26 批次2) ── */
        .svc-header {
            display: flex;
            align-items: baseline;
            gap: 10px;
            padding: 3px 4px;
            cursor: pointer;
            user-select: none;
        }
        .svc-header:hover {
            background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
        }
        .svc-caret {
            color: var(--vscode-descriptionForeground);
            flex: 0 0 auto;
        }
        .svc-body {
            margin: 2px 0 6px 14px;
            padding: 6px 8px;
            border-left: 1px solid var(--vscode-widget-border, #555555);
        }
        .form-area {
            margin: 2px 0;
        }
        .form-row {
            display: flex;
            align-items: baseline;
            gap: 8px;
            padding: 2px 0;
            flex-wrap: wrap;
        }
        .form-label {
            color: var(--vscode-foreground);
            word-break: break-all;
        }
        .form-ftype {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            margin-left: 6px;
            word-break: break-all;
        }
        .form-input {
            background: var(--vscode-input-background, #3c3c3c);
            border: 1px solid var(--vscode-input-border, #555555);
            color: var(--vscode-input-foreground, #d4d4d4);
            border-radius: 3px;
            padding: 2px 6px;
            font-size: 12px;
            /* 2026-09-30 四轮三:三向钳制(min=width=max)——单 width 声明在 input/textarea
               上仍可能有 UA 内在尺寸差异,三向钳死后浏览器零自由度,像素级恒等 */
            box-sizing: border-box;
            width: 180px;
            min-width: 180px;
            max-width: 180px;
        }
        /* checkbox 不吃固定宽(保持原生勾选框大小) */
        input[type="checkbox"].form-input {
            width: auto;
            min-width: 0;
        }
        .form-input:focus {
            outline: 1px solid var(--vscode-focusBorder, #3794ff);
            border-color: var(--vscode-focusBorder, #3794ff);
        }
        .form-group {
            margin: 8px 0;             /* 2026-09-29 批次 C:边框间隙拉高(4px → 8px) */
            padding: 4px 8px;
            border: 1px solid var(--vscode-widget-border, #555555);
            border-radius: 3px;
        }
        .form-group-header {
            color: var(--vscode-foreground);
            font-weight: bold;
            display: flex;             /* 2026-09-30 五轮二:flex 行,行尾簇 margin-left:auto 右推 */
            align-items: center;
        }
        .form-header-end {
            margin-left: auto;         /* 行尾簇(计数/A/局部按钮)右推,视觉平衡左右 */
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        /* 折叠方块(2026-09-30 四轮):蓝色方块包三角,强调 + 独立触发区(整头点击已废) */
        .form-group-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 15px;
            height: 15px;
            margin-right: 6px;
            border: 1px solid var(--vscode-focusBorder, #3794ff);
            border-radius: 3px;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            user-select: none;
            font-size: 10px;
        }
        .form-group-toggle:hover {
            background: rgba(55, 148, 255, 0.18);
            color: var(--vscode-foreground);
        }
        .form-key-btn svg {
            width: 13px;
            height: 13px;
            display: block;
        }
        /* 组头折叠(2026-09-29 批次 C):可点组头 + 折叠态元素计数 */
        .form-group-header.collapsible {
            cursor: pointer;
            user-select: none;
        }
        .form-group-count {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            font-weight: normal;
            margin-left: 6px;
        }
        /* 复合组头名字旁基本行计数 (N)(2026-10-03 十三轮,用户裁定):与名字两空格间距
           (与参数树 .param-tree-count 的 12px 同口径),灰字弱于名字 */
        .form-head-count {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            font-weight: normal;
            margin-left: 12px;
        }
        .form-key-btn.form-key-neutral {
            color: var(--vscode-descriptionForeground);
        }
        /* 悬停增亮(2026-10-03 十一轮,用户裁定):与参数树 .param-tree-btn:hover 同口径,
           灰(descriptionForeground)→亮(foreground),展开/收起/局部双图标一体生效 */
        .form-key-btn.form-key-neutral:hover {
            color: var(--vscode-foreground);
        }
        .form-group-children {
            padding-left: 10px;
        }
        .form-element {
            margin: 2px 0;
        }
        /* 复杂数组元素间分隔线(2026-09-29 终版,用户裁定):贯穿 1px 虚线,
           灰度与 .form-group 边框(#555)一致,不用字符凑 */
        /* 元素间分隔线(十三轮补充三,用户裁定):主题蓝 focusBorder(与折叠方块同源,随主题)+
           8px 实段/8px 空段 repeating-gradient——原生 dashed 颗粒 ~3px 远看连成实线、与 #555
           边框难辨;大间隔虚线与连续实线边框在感官上明确分离 */
        .form-element-sep {
            height: 1px;
            background: repeating-linear-gradient(90deg,
                var(--vscode-focusBorder, #3794ff) 0 8px,
                transparent 8px 16px);
            margin: 6px 0 2px;
        }
        .form-element-header {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            display: flex;             /* 十三轮补充:flex 行——展开方块双向 auto margin,
                                          居中于下标与行尾簇(⊕⊟D)之间 */
            align-items: center;
        }
        .form-error-row {
            color: var(--vscode-charts-red, #f48771);
            font-size: 12px;
            padding: 2px 0;
        }
        /* 校验错误标记(2026-09-29 重设计):红描边 + 红色圆形感叹号徽标(悬浮=详情) */
        .form-input-invalid {
            border-color: var(--vscode-charts-red, #f85149) !important;
            outline: 1px solid var(--vscode-charts-red, #f85149);
        }
        /* 字符串多行框(2026-09-29):Enter = 真实换行,高度随内容自增(JS autoGrow) */
        textarea.form-input {
            box-sizing: border-box;
            width: 180px;
            min-width: 180px;
            max-width: 180px;          /* 2026-09-30 四轮三:三向钳制,与 .form-input 恒等 */
            min-height: 22px;          /* 2026-09-29:防坍缩下限 */
            font-family: inherit;      /* 2026-09-29:表单控件默认不吃继承,落入等宽默认字体——与文本框统一 */
            font-size: 12px;
            resize: none;
            overflow: hidden;
            white-space: pre-wrap;
            line-height: 1.4;
        }
        /* 红色圆形感叹号徽标:校验错误详情悬浮其上(即时悬浮层,非原生 title) */
        .form-error-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: var(--vscode-charts-red, #f85149);
            color: #ffffff;
            font-size: 10px;
            font-weight: bold;
            cursor: default;
            flex: 0 0 auto;
        }
        /* 即时悬浮提示(2026-09-29):动作图标按钮/错误徽标统一;与 ⓘ .info-tip 同视觉、零延迟 */
        .hover-tip-host {
            position: relative;
        }
        .hover-tip {
            display: none;
            position: absolute;
            left: 0;
            top: 20px;
            z-index: 30;
            width: 300px;              /* 期望宽;实际=JS 写入 min(实测自然宽,300),短提示按内容收窄(九轮) */
            max-width: 80vw;           /* 初挂兜底;悬停后由 JS 瞬时计算接管(2026-10-03 七轮) */
            box-sizing: border-box;    /* 八轮:内边距+边框计入宽度,maxWidth 即整框宽,
                                          两向选位算式不再漏这 18px(否则左铺左切/右铺右溢) */
            overflow-wrap: anywhere;   /* 与 .info-tip 同口径:极窄框下长 token 强制折行 */
            background: var(--vscode-editorHoverWidget-background, #252526);
            border: 1px solid var(--vscode-editorHoverWidget-border, #555555);
            border-radius: 3px;
            padding: 6px 8px;
            font-size: 11px;
            font-weight: normal;
            color: var(--vscode-foreground);
            text-align: left;
            white-space: pre-line;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        }
        .hover-tip-host:hover .hover-tip {
            display: block;
        }
        .form-actions-line {
            display: flex;
            align-items: center;
            gap: 4px;              /* 2026-09-29:两图标贴近(10px → 4px) */
            padding-left: 6px;     /* 2026-09-29:整行右移,不贴左缘 */
            margin-top: 6px;
        }
        /* A/D 键钮(2026-09-28):单字母动作钮,A=添加(翠绿) D=删除(红),色随主题 charts 变量 */
        .form-key-btn {
            display: inline-block;
            min-width: 14px;
            text-align: center;
            font-weight: bold;
            font-size: 11px;
            margin-left: 8px;
            cursor: pointer;
            user-select: none;
        }
        .form-key-btn:hover {
            text-decoration: underline;
        }
        .form-key-add {
            color: var(--vscode-charts-green, #3fb950);
        }
        .form-key-del {
            color: var(--vscode-charts-red, #f85149);
        }
        /* 2026-09-29:简单数组行是 flex(gap 8px),键钮自带的 margin-left 会叠成 16px ——
           行内置 0,使 [N]→D 间距与复杂数组(8px)一致 */
        .form-row .form-key-btn {
            margin-left: 0;
        }
        /* 2026-09-28 用户裁定:去蓝色基底——幽灵图标钮,与复制钮同风格,颜色随主题 */
        .form-call-btn {
            background: transparent;
            color: var(--vscode-textLink-foreground);
            border: none;
            padding: 0;
            cursor: pointer;
        }
        /* (2026-09-30 五轮:hover 特殊态删除——与复制钮完全一致:蓝色不变、无下划线无变色;
           此前曾提案"加下划线",经核实复制钮下划线因纯 SVG 内容画不出来,视觉上本就没有) */
        /* (2026-09-28 二修)bool 对外仍是框选 checkbox;.form-input-bool 窄框类随单字符方案废除 */
        /* 助手离线提示(2026-09-26:各区不再静默隐藏/清空,明确告知原因) */
        .offline-hint {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 12px;
            padding: 4px 0;
        }
        /* 2026-09-26:.param-expand/.param-collapse/.param-spinner 样式随「展开」按钮链路一并退役——
           参数值改由轮询 param dump 随数据自带、按类型着色常显,无任何按钮。 */`;
