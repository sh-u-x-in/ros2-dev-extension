/**
 * @file icons.ts
 * 状态页内联 SVG 图标(2026-09-28 镂空化重绘,用户裁定:图标必须镂空且随主题变色):
 *  - ICON_EXPAND(双层方框+右下弧线+加号)一键展开子孙/局部展开;
 *  - ICON_COLLAPSE(同款,横线)一键收起;
 *  - ICON_COPY(双框线)复制命令按钮(话题/服务/动作);
 *  - ICON_EXEC(终端窗+提示符)订阅/调用/发送 执行入口。
 * 统一规范:颜色完全由宿主 CSS 的 color 决定(currentColor / --vscode-* 变量),
 * 明暗主题自动适配;EXPAND/COLLAPSE 为 2026-10-03 用户重绘 codicon 风格(fill+evenodd 镂空外框),
 * COPY/EXEC 为描边风格(fill="none" stroke="currentColor")。
 * 内联注入(innerHTML)而非 <img>:currentColor 才能跟随主题。
 * 尺寸由宿主 CSS 控制(.xxx-btn svg { width/height }),这里不写死宽高。
 */

/** 一键展开全部子孙(2026-10-03 十四轮,用户重绘 codicon 风格:双层方框+右下弧线+居中加号;
 *  fill 型 evenodd 镂空外框,currentColor 随主题) */
export const ICON_EXPAND =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">` +
    `<path d="M14 4.27051C14.5999 4.62053 15 5.26009 15 6V11C15 13.21 13.21 15 11 15H6C5.26009 15 4.62053 14.5999 4.27051 14H11C12.65 14 14 12.65 14 11V4.27051Z"/>` +
    `<path d="M9.5 7C9.776 7 10 7.224 10 7.5C10 7.776 9.776 8 9.5 8H5.5C5.224 8 5 7.776 5 7.5C5 7.224 5.224 7 5.5 7H9.5Z"/>` +
    `<path d="M7 5.5C7 5.224 7.224 5 7.5 5C7.776 5 8 5.224 8 5.5V9.5C8 9.776 7.776 10 7.5 10C7.224 10 7 9.776 7 9.5V5.5Z"/>` +
    `<path fill-rule="evenodd" clip-rule="evenodd" d="M11 2C12.103 2 13 2.897 13 4V11C13 12.103 12.103 13 11 13H4C2.897 13 2 12.103 2 11V4C2 2.897 2.897 2 4 2H11ZM4 3C3.449 3 3 3.449 3 4V11C3 11.552 3.449 12 4 12H11C11.551 12 12 11.552 12 11V4C12 3.449 11.551 3 11 3H4Z"/>` +
    `</svg>`;

/** 一键收起全部(同款,居中横线 = 减号) */
export const ICON_COLLAPSE =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">` +
    `<path d="M14 4.27051C14.5999 4.62053 15 5.26009 15 6V11C15 13.21 13.21 15 11 15H6C5.26009 15 4.62053 14.5999 4.27051 14H11C12.65 14 14 12.65 14 11V4.27051Z"/>` +
    `<path d="M9.5 7C9.776 7 10 7.224 10 7.5C10 7.776 9.776 8 9.5 8H5.5C5.224 8 5 7.776 5 7.5C5 7.224 5.224 7 5.5 7H9.5Z"/>` +
    `<path fill-rule="evenodd" clip-rule="evenodd" d="M11 2C12.103 2 13 2.897 13 4V11C13 12.103 12.103 13 11 13H4C2.897 13 2 12.103 2 11V4C2 2.897 2.897 2 4 2H11ZM4 3C3.449 3 3 3.449 3 4V11C3 11.552 3.449 12 4 12H11C11.551 12 12 11.552 12 11V4C12 3.449 11.551 3 11 3H4Z"/>` +
    `</svg>`;

/** 复制命令(双框线,currentColor 跟随主题) */
export const ICON_COPY =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>` +
    `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

/** 执行/跳转终端(终端窗 + > 提示符 + 光标线,镂空) */
export const ICON_EXEC =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect width="18" height="18" x="3" y="3" rx="2"/>` +
    `<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/></svg>`;
