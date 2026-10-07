/**
 * @file api.ts
 * build-only 真值域对外门面(唯一出口)。
 *
 * 分层层级(依赖单向向下,禁止反向 import):
 *   api.ts      门面:唯一对外出口(类型 + 工厂 + 便捷函数)
 *   center/     第 2 层:数据中心(有状态:快照/事件/失效/就绪契约)
 *   scan/       第 1 层:纯解析(无状态:fs + build 路径 → 结论对象)
 *   shared/     第 0 层:基础设施(路径 / 模型 / 注入式 fs 原语)
 *
 * 坐标系(build-only 裁切版,用户裁定 2026-09-13):
 *   **唯一输入 = `build/`**。可执行跳转所需的记录(link.txt/.o.d/egg-info/安装规则)
 *   在四象限(iso/merged × entity/symlink)实测为固有信息 → 不需要 install/,
 *   也不关心构建类型与安装形态。
 *   与 main 插件 core 的关系是**并列**:core 跟 src 域,本域跟 build 域,生命周期独立。
 *
 * 消费者(后续):launch 可执行名校验/hover、debugger sourceFileMap、一键运行/测试的名单。
 * 本轮只提供数据与事件,不接线、不做 UI。
 *
 * 纯 TS,零依赖(仅 node 内置 fs),可无头测试。
 */

export type {
    BuildMapSnapshot,
    BuildPackage,
    BuildTarget,
    BuildTraits,
    BuildTypeName,
    InstallRule,
    JumpEntry,
    JumpKind,
    PythonInstall,
    PythonMeta,
    TargetKind,
    Tier,
} from "./shared/models";
export { createJumpEntry, TIER_LABEL } from "./shared/models";

export type { FsLike, FsStat } from "./shared/fs/primitives";
export {
    DEFAULT_SKIP_DIRS,
    MAX_TEXT_BYTES,
    MemoryFs,
    exists,
    findFilesByName,
    guardDomain,
    isDir,
    isFile,
    listDirs,
    nodeFsLike,
    walkFiles,
} from "./shared/fs/primitives";

export { pbasename, pextname, pjoin, prelative, normalizeInstallKey } from "./shared/paths";

export type { BuildContext } from "./scan/build-root";
export { locateBuildRoot } from "./scan/build-root";
export type { AreaFile, AreaName, PackageAreas } from "./shared/models";
export {
    areaOf,
    classifyPrefixRel,
    collectAreas,
    installRootOf,
    isConventionGenerated,
    looksLikeLibrary,
    pickDirSource,
    readInstallLayout,
    sourceFromRules,
    sourceFromRulesRef,
} from "./scan/installed";
export { discoverBuildPackages, inferType, readTraits } from "./scan/packages";
export {
    HDR_EXTS,
    SRC_EXTS,
    collectTargets,
    parseDText,
    parseLinkLibs,
    parseLinkObjects,
    parseLinkOutput,
    parseLinkOutputPath,
} from "./scan/targets";
export { devModuleCandidates, moduleSourceCandidates, readPythonMeta, splitEntry } from "./scan/python-meta";
export { collectInstallRules, parseInstallLine, scriptExecutablesFromRules } from "./scan/install-rules";
export type { ManifestInfo } from "./scan/manifests";
export {
    MANIFEST_FILES,
    derivedInstallCandidates,
    findInstalledPath,
    findInstalledPathsBySuffix,
    findModuleInstalledPath,
    findSitePackagesDir,
    freshnessBaselineMs,
    isInstalled,
    readManifests,
} from "./scan/manifests";
export type { JumpCollection } from "./scan/jumps";
export { collectJumps, jumpSourceOf, sourceBasename, summarizeJump } from "./scan/jumps";

export type { BuildMapBuilder, BuildMapCenterOptions, BuildMapChangeEvent } from "./center/build-map-center";
export { BUILD_SIGNAL_REASON, BuildMapCenter, buildBuildMapSnapshot, diffPackageFingerprints, fingerprintOfSnapshot, packageFingerprints } from "./center/build-map-center";
export type { ExecIndex, ExecutableLookup, LookupStatus, SidebarPackageView, SidebarRow } from "./center/query";
export { ExecIndexCache, ExecutableResolver, buildExecIndex, installFormOf, lookupByPath, lookupExecutable, rowsOf, suggestNames } from "./center/query";
// 注:`center/shared-center.ts`(按根共享实例)**刻意不进本桶** ——
// 消费方按路径直连:`import { acquireSharedBuildCenter } from "../install-truth/center/shared-center"`。
// (2026-09-30:`center/trigger.ts` 整体退役 —— 失效源改为构建信号主动刷新,见 手工重设计/13;
//  旧 `BUILD_WATCH_PATTERNS`/`BuildMapTrigger`/`isRelevantBuildPath`/`packageOfBuildPath` 导出同批移除。)

import { FsLike, nodeFsLike } from "./shared/fs/primitives";
import { BuildMapCenter, BuildMapCenterOptions } from "./center/build-map-center";

/** 一站式创建:默认注入真实 fs */
export function createBuildMapCenter(
    opts: Omit<BuildMapCenterOptions, "fs"> & { fs?: FsLike }
): BuildMapCenter {
    return new BuildMapCenter({ ...opts, fs: opts.fs ?? nodeFsLike });
}
