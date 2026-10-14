// Licensed under the MIT License.

/**
 * @file l10n/templates/index.ts
 * 【生成包模板教学注释 · 语种分派器】(2026-10-12 建立)
 *
 * 作用:把 VS Code 侧的 UI 语言串(`vscode.env.language`)归一为模板注释语种,并按语种
 * 从 ./en.ts(英语源)/ ./zh-cn.ts(简体中文)取出对应注释表,交给 create/templates 渲染层。
 * 生成物为**单语**(同一文件内不混排);未支持的语言一律回退英语源。
 *
 * 横向扩展:新增语言 = 新增 `ja.ts` 等表文件(实现与 en.ts 同签名的 builder,返回类型标注为
 * en.ts 导出的 *Strings 类型以强制键集一致)→ 在下方各 resolve* 增加一个分支即可,模板零改动。
 *
 * 与 UI 文案机制(bundle.l10n.*.json + scripts/i18n_audit.py)完全无涉:本目录服务的是
 * **写进用户项目里的生成文件注释**,不是扩展运行时 UI 字符串。
 */

import {
    buildCmakeEn, buildXmlEn, buildCppNodeEn, buildPyNodeEn, buildPySetupEn, buildMiscEn,
    type CmakeCtx, type XmlCtx, type CppNodeCtx, type PyNodeCtx, type PySetupCtx, type MiscCtx,
    type CmakeStrings, type XmlStrings, type CppNodeStrings, type PyNodeStrings, type PySetupStrings, type MiscStrings,
} from "./en";
import {
    buildCmakeZh, buildXmlZh, buildCppNodeZh, buildPyNodeZh, buildPySetupZh, buildMiscZh,
} from "./zh-cn";

/** 模板注释语种(en = 源语言;横向扩展时在此联合类型中追加) */
export type TemplateCommentLang = "en" | "zh-cn";

/**
 * UI 语言串 → 模板注释语种(zh* 全系归一 zh-cn;未支持语言回退 en)。
 * 输入来自 vscode.env.language(如 "en"/"zh-cn"/"zh-tw"),空/未定义为 en。
 */
export function normalizeCommentLang(locale: string | undefined): TemplateCommentLang {
    return (locale ?? "").toLowerCase().startsWith("zh") ? "zh-cn" : "en";
}

/** cmake 模板注释表分派(CMakeLists.txt) */
export function resolveCmakeStrings(lang: TemplateCommentLang, ctx: CmakeCtx): CmakeStrings {
    return lang === "zh-cn" ? buildCmakeZh(ctx) : buildCmakeEn(ctx);
}

/** package-xml 模板注释表分派(package.xml) */
export function resolveXmlStrings(lang: TemplateCommentLang, ctx: XmlCtx): XmlStrings {
    return lang === "zh-cn" ? buildXmlZh(ctx) : buildXmlEn(ctx);
}

/** cpp-node 模板注释表分派(C++ 示范节点源) */
export function resolveCppNodeStrings(lang: TemplateCommentLang, ctx: CppNodeCtx): CppNodeStrings {
    return lang === "zh-cn" ? buildCppNodeZh(ctx) : buildCppNodeEn(ctx);
}

/** py-node 模板注释表分派(Python 示范节点源) */
export function resolvePyNodeStrings(lang: TemplateCommentLang, ctx: PyNodeCtx): PyNodeStrings {
    return lang === "zh-cn" ? buildPyNodeZh(ctx) : buildPyNodeEn(ctx);
}

/** py-setup 模板注释表分派(setup.py / setup.cfg) */
export function resolvePySetupStrings(lang: TemplateCommentLang, ctx: PySetupCtx): PySetupStrings {
    return lang === "zh-cn" ? buildPySetupZh(ctx) : buildPySetupEn(ctx);
}

/** 生成层杂项注释表分派(mixed 包 __init__.py docstring) */
export function resolveMiscStrings(lang: TemplateCommentLang, ctx: MiscCtx): MiscStrings {
    return lang === "zh-cn" ? buildMiscZh(ctx) : buildMiscEn(ctx);
}
