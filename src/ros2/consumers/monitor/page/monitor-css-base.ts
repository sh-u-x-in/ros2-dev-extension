// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file monitor-css-base.ts
 * 核心状态页 CSS 前半(2026-10-03 十二轮自 ros2-monitor.ts 拆出):
 * 菜单栏/状态行/可折叠区块骨架/生命周期节点卡片与状态徽章/ⓘ 悬浮标注/参数树/
 * 转换回执终端式日志区/滚动条恒显。
 * 与 monitor-css-forms.ts 在 monitor-html.ts 拼接为完整 <style> 内容;样式逐行 verbatim 搬移。
 */

/** 状态页样式前半:菜单栏 → 参数树(行序与拆分前一致) */
export const MONITOR_CSS_BASE = `
        html {
            scrollbar-gutter: stable;  /* 十三轮补充(用户两案取"预留"):右侧恒留滚动条槽——
                                          展开/收起跨过一屏临界时内容不再左右跳动;
                                          槽内滚动条仅实际可滚动时绘制,不满屏时只是空槽 */
            overflow-y: scroll;        /* 十八轮补六:滚动条永久在位——实测缩放状态图会改变页面
                                          总高使滚动条消失/出现,全部 100% 宽元素随之 ±17px;
                                          gutter 预留槽外再强制常显,双保险钉死宽度 */
        }
        .menu-bar {
            background-color: var(--vscode-editorWidget-background, #2d2d30);
            padding: 10px;
            margin-bottom: 20px;
            border-radius: 4px;
            display: flex;
            gap: 10px;
            align-items: center;
        }
        .menu-button {
            background-color: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .menu-button:hover {
            background-color: var(--vscode-button-hoverBackground, #1177bb);
        }
        .menu-button:disabled {
            background-color: var(--vscode-disabledForeground, #666666);
            cursor: not-allowed;
        }
        .menu-button.stop {
            background-color: var(--vscode-charts-red, #d73a49);
        }
        .menu-button.stop:hover {
            background-color: var(--vscode-charts-red, #d73a49);
            filter: brightness(1.15);
        }
        .status-message {
            margin-left: 15px;
            font-style: italic;
            color: var(--vscode-foreground);
        }
        .section {
            margin: 20px 0;
        }
        .section h3 {
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-widget-border, #444444);
            padding-bottom: 5px;
        }
        /* 可折叠区块(2026-10-03 十七轮,用户裁定):五大标题行尾 ▾/▸,收起只藏内容体,
           状态跨刷新记忆;大系统下可收起不需要的区块快速到达目标 */
        .section-header {
            display: flex;
            align-items: center;
        }
        .section-toggle {
            margin-left: auto;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            user-select: none;
            font-size: 14px;
            padding: 0 4px;
        }
        .section-toggle:hover {
            color: var(--vscode-foreground);
        }
        .lifecycle-node {
            background-color: var(--vscode-editorWidget-background, #2d2d30);
            margin: 10px 0;
            padding: 15px;
            border-radius: 4px;
            border: 1px solid var(--vscode-widget-border, #444444);
        }
        .sg-toggle {
    font-size: 12px;
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    margin-left: 8px;
}.sg-toggle input {
    vertical-align: middle;
    cursor: pointer;
}
        /* 转换回执终端式日志区(十八轮补四,用户裁定):toast(3s 闪没/长文挤压图谱)退役,
           改卡片下方持久日志——等宽/终端底色/限高滚动,历史按节点回放,格式 HH:MM:SS >> 内容 */
        .lifecycle-log {
            margin-top: 8px;
            padding: 6px 8px;
            max-height: 120px;
            overflow-y: auto;
            background: var(--vscode-terminal-background, #1e1e1e);
            color: var(--vscode-terminal-foreground, #cccccc);
            border: 1px solid var(--vscode-widget-border, #555555);
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family, Consolas, monospace);
            font-size: 11px;
            line-height: 1.5;
        }
        .lifecycle-log-line {
            white-space: pre-wrap;
            word-break: break-all;
        }
        /* 二十一(用户裁定:日志加色):时间戳暗灰,内容按级别着色 */
        .lifecycle-log-ts {
            color: var(--vscode-descriptionForeground);
            margin-right: 8px;
        }
        .lifecycle-log-msg.log-pending {
            color: var(--vscode-charts-yellow, #cca700);
        }
        .lifecycle-log-msg.log-success {
            color: var(--vscode-charts-green, #89d185);
        }
        .lifecycle-log-msg.log-error {
            color: var(--vscode-charts-red, #f48771);
        }
.lifecycle-node-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        /* 2026-08-26⑫:状态图缩放(方案一)——滚动容器 + 缩放工具条 */
        .node-header-right {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .svg-zoom-wrap {
            max-height: 300px;
            overflow: auto;
            border-radius: 4px;
            margin-top: 4px;
        }
        .svg-zoom-tools {
            display: flex;
            gap: 4px;
        }
        .svg-zoom-tools button {
            background: var(--vscode-button-secondaryBackground, #3c3c3c);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-widget-border, #555555);
            border-radius: 3px;
            font-size: 11px;
            line-height: 1;
            padding: 3px 7px;
            cursor: pointer;
        }
        .svg-zoom-tools button:hover { background: var(--vscode-button-secondaryHoverBackground, #4d4d4d); }
        .node-name {
            font-weight: bold;
            color: var(--vscode-foreground);
        }
        .node-state {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
        }
        .state-unconfigured { background-color: #6c757d; color: white; }
        .state-inactive { background-color: #ffc107; color: black; }
        .state-active { background-color: #28a745; color: white; }
        .state-finalized { background-color: #dc3545; color: white; }
        /* (十九轮批2:旧版行内状态图 .sg-row/.sg-node/.sg-edge 族与 .transitions/.transition-btn
           已删——SVG 自绘状态图(2026-08-26)与图边点击(设计)替代,零引用尸体) */
        /* ── ⓘ 悬浮标注(2026-09-24:替代原"使用说明"折叠块,说明悬浮在对应区块旁;
              2026-09-26:缩小字号 + 上标位置(悬在所标注标题右上角);cursor 改 default,去掉帮助"?"光标) ── */
        /* ── 常驻状态徽章(K 批,2026-10-07):"状态"链接质感,悬浮框逐帧解读心跳 ── */
        /* 行尾锚定(用户裁定 2026-10-07):margin 加在挂载元素(flex 子元素)上——
            加在内层徽章上无效,它不是 flex 子元素 */
        #helper-status-badge {
            margin-left: auto;
        }
        .helper-status-badge {
            font-size: 12px;
            color: var(--vscode-textLink-foreground, #3794ff);
            text-decoration: underline;
            cursor: default;
            user-select: none;
        }
        .helper-status-badge.offline {
            color: var(--vscode-descriptionForeground);
            text-decoration: none;
        }
        .info-icon {
            position: relative;
            display: inline-block;
            margin-left: 5px;
            font-size: 11px;
            font-weight: normal;
            vertical-align: super;
            color: var(--vscode-descriptionForeground);
            cursor: default;
            user-select: none;
        }
        .info-icon:hover {
            color: var(--vscode-focusBorder, #3794ff);
        }
        .info-tip {
            display: none;
            position: absolute;
            left: 0;
            top: 20px;
            z-index: 30;
            /* 确定式宽度(2026-09-26 二次修正:width:max-content + calc(100vw-…) 上限在 webview 内不生效,
               单行提示撑出面板;改固定宽 + 视口百分比封顶 + 强制折行;
               2026-10-03 七轮:悬停时 JS 瞬时接管选位与宽度(placeTipInViewport),
               420px=期望宽、90vw=初挂兜底;九轮:短于一行按实测自然宽收窄,长行才封 420 折行) */
            width: 420px;
            max-width: 90vw;
            box-sizing: border-box;
            overflow-wrap: anywhere;
            padding: 8px 10px;
            background: var(--vscode-editorHoverWidget-background, #252526);
            border: 1px solid var(--vscode-widget-border, #555555);
            border-radius: 4px;
            color: var(--vscode-foreground);
            font-size: 12px;
            font-weight: normal;
            line-height: 1.6;
            text-align: left;
            white-space: pre-line;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        }
        .info-icon:hover .info-tip {
            display: block;
        }
        /* ── 参数树(2026-09-26 弃表格:表格只能平铺,表达不出 节点→参数 从属结构) ── */
        .param-tree {
            margin: 6px 0;
        }
        .param-tree-node-header {
            display: flex;
            align-items: center;
            font-weight: bold;
            color: var(--vscode-foreground);
            padding: 4px 6px;
            margin: 4px 0 2px 0;
            background: var(--vscode-sideBarSectionHeader-background);
            border-radius: 3px;
            cursor: pointer;
            user-select: none;
            word-break: break-all;
        }
        /* 分支文件夹行(层级文件夹,弱于节点层的视觉权重) */
        .param-tree-branch-header {
            display: flex;
            align-items: center;
            color: var(--vscode-foreground);
            padding: 3px 6px;
            cursor: pointer;
            user-select: none;
            word-break: break-all;
        }
        .param-tree-branch-header:hover {
            color: var(--vscode-foreground);
        }
        /* (N) 计数独立 span:间距 ≥ 两个空格宽,杜绝误读为名称一部分(2026-09-26) */
        .param-tree-count {
            margin-left: 12px;
            flex: 0 0 auto;
        }
        /* 面包屑压缩分隔符:白色加粗,亮且与参数名明确区分(有意不用".");
           2026-10-03 浅色适配:改 foreground 随主题 */
        .param-tree-sep {
            color: var(--vscode-foreground);
            font-weight: bold;
        }
        /* 行尾动作区:分支 [+] 一键展开 / 节点 [+] [-] 一键展开收起 */
        /* 2026-09-28 修:容器必须是 flex——子按钮 svg 是 display:block,内联容器会被块级子元素
           碎片化(匿名块盒),两个按钮各占一行(凭空多一个换行) */
        .param-tree-actions {
            display: flex;
            align-items: center;
            margin-left: auto;
            flex: 0 0 auto;
        }
        .param-tree-btn {
            margin-left: 8px;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            user-select: none;
        }
        .param-tree-btn:hover {
            color: var(--vscode-foreground);
        }
        /* 截断数组"打开完整内容"入口(全值落盘临时文件,不在页面渲染) */
        .param-open-file {
            margin-left: 10px;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            user-select: none;
            font-size: 12px;
        }
        .param-open-file:hover {
            text-decoration: underline;
        }
        .param-tree-children {
            margin-left: 10px;
            padding-left: 14px;
            border-left: 1px solid var(--vscode-widget-border, #555555);
        }
        /* 值子行(2026-09-26 全条目化):参数名条目展开后的子行,内容为五色类型化值 */
        .param-tree-value-row {
            color: var(--vscode-foreground);
            padding: 2px 0;
            word-break: break-all;
            overflow-wrap: anywhere;
        }
        .param-tree-empty {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }`;
