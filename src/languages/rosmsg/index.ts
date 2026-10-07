/**
 * rosmsg 域唯一出口(2026-09-04 重组:按模块分组 shared/parse/ui/data)。
 * 外部(extension/测试)只经本文件 import,内部结构可自由调整。
 */
export { registerRosMessageProviders } from "./ui/providers";
export { MessageIndex } from "./data/message-index";
export type { RosInterfaceEntry, WorkspaceCacheFile, SystemCacheFile } from "./data/message-index";
// 2026-09-13 三张表重构:包表来源契约(PackageMap 结构满足;测试可注入 fake)
export type { PackageSource, PackageAtomEvent } from "./data/message-index";
