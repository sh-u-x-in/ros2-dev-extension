/**
 * @file i18n.ts
 * webview 端翻译查表(2026-10-04 期4,用户裁定方案 B):
 * 宿主拼 HTML 时按 VS Code 显示语言注入 window.__I18N(zh-cn 册或空表);
 * 本模块只做查表 + {N} 位置插值,查不到回退英文源串。经典脚本,零依赖。
 */

// 宿主注入的册(zh-cn)或空表;无头测试(node)下退回 globalThis 查找,取不到即回退英文源
const I18N: Record<string, string> | undefined =
    (typeof window !== "undefined" ? (window as { __I18N?: Record<string, string> }).__I18N : undefined) ??
    (globalThis as { __I18N?: Record<string, string> }).__I18N;

/** 翻译查表:英文源串 → 当前语言串(未注入册/未命中 = 英文源);args 按 {N} 位置插值 */
export function t(message: string, ...args: Array<string | number | boolean>): string {
    const dict = I18N;
    let s = dict && dict[message] !== undefined ? dict[message] : message;
    if (args.length > 0) {
        s = s.replace(/\{(\d+)\}/g, (raw, i) => {
            const v = args[Number(i)];
            return v === undefined ? raw : String(v);
        });
    }
    return s;
}
