/**
 * xacro 语言模块域唯一出口(2026-09-07 目录化,对齐 rosmsg index.ts 形态)。
 *
 * 对外仅经本文件 import(extension 装配 / 测试公共面):
 *  - registerXacroProviders:装配(共享 PackageMap → IncludeGraph → watcher → 提供器注册)
 *  - XacroDefinitionProvider / XacroDocumentLinkProvider(include 文件级链接)/ XacroHoverProvider
 *  - extractLeadingComment:悬浮文档注释提取(单测)
 * 注:DocumentLink 于 2026-09-07 先全量断电,后按分层语义恢复为"仅 include(文件级)"。
 * 内部目录:core(include-graph/watcher)/ parse(context-locator)/ data(urdf-docs)/
 *          ui(提供器实现 + 共享工具 provider-utils + 装配 providers)/ 详见各子 README。
 */
export {
    registerXacroProviders,
    XacroDefinitionProvider,
    XacroDocumentLinkProvider,
    XacroHoverProvider,
    extractLeadingComment
} from "./ui/providers";
