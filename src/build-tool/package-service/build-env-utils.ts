// Copyright (c) Andrew Short. All rights reserved.
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 本文件已废弃(DEPRECATED,2026-08-28)——不再参与编译,内容注释保留,仅作历史参考。
// 去向:配置生成(createConfigFiles / maintainIncludeConfigs)按 package-core 重新设计迁入
// //   package-core(config-gen),数据源切 package-core 快照/事件,不再依赖旧壳 colcon-utils;
// //   mergeCompileCommands 另行落位(ros2/ 或独立模块);updateCppProperties 等命令入口重新接线;
// // 定性:外部模块(既非 package-core 也非 ros2/),不作为 package-core 设计约束,整体废弃。
// 参考依据:设计/重构/package-core重新设计/DESIGN.md
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// 以下为原文件全部内容(整体注释,仅供历史参考,不参与编译)。
// ───────────────────────────────────────────────────────────────────────────
// // Licensed under the MIT License.
//
// import * as path from "path";
// import { promises as fsPromises } from "fs";
// import * as vscode from "vscode";
//
// import * as extension from "../../extension";
// import * as telemetry from "../../telemetry-helper";
// import * as vscode_utils from "../../vscode-utils";
// import * as buildState from "../tasks/build-state";
// import * as colconUtils from "../packages/colcon-utils";
// import { getEnv } from "../../ros2/environment";
// import { composeApi } from "../../ros2/api";
// import type { Ros2ServiceApi } from "../../ros2/api";
//
// import { getLogger } from "../../logger";
//
// // Import common utilities
// import { makeWorkspaceRelative } from "@ranchhandrobotics/rde-common";
//
// // Re-export for backwards compatibility
// export { makeWorkspaceRelative };
//
// /** 命令域查询实例(经组合根注入;只依赖 api/ 接口类型) */
// const ros2ServiceApi: Ros2ServiceApi = composeApi.ros2ServiceApi;
//
// /**
//  * 收集 ROS include 目录:CMAKE_PREFIX_PATH / AMENT_PREFIX_PATH 下存在的 include。
//  * 原 rosApi.getIncludeDirs 能力迁为本地实现(env 由环境域门面实时取,非快照)。
//  */
// async function getRosIncludeDirs(): Promise<string[]> {
//     const env = getEnv();
//     const includeDirs: string[] = [];
//     if (!env) {
//         return includeDirs;
//     }
//     const prefixPaths: Set<string> = new Set();
//     const cmakePrefix = env.CMAKE_PREFIX_PATH;
//     const amentPrefix = env.AMENT_PREFIX_PATH;
//     if (cmakePrefix) {
//         cmakePrefix.split(path.delimiter).forEach((prefix: string) => prefixPaths.add(prefix));
//     }
//     if (amentPrefix) {
//         amentPrefix.split(path.delimiter).forEach((prefix: string) => prefixPaths.add(prefix));
//     }
//     for (const dir of prefixPaths) {
//         const include = path.join(dir, "include");
//         try {
//             await fsPromises.access(include);
//             includeDirs.push(include);
//         } catch {
//             // include 目录不存在,跳过
//         }
//     }
//     return includeDirs;
// }
//
// /**
//  * 收集工作区 include 目录:colcon list -p → 各包路径下的 include。
//  * 原 rosApi.getWorkspaceIncludeDirs 能力迁为 Ros2ServiceApi.colcon_list + 存在性检查。
//  */
// async function getWorkspaceIncludeDirs(workspaceDir: string): Promise<string[]> {
//     const entries = await ros2ServiceApi.colcon_list({ base_path: workspaceDir, packages_only: true });
//     const includes: string[] = [];
//     for (const entry of entries) {
//         const include = path.join(entry.path, "include");
//         try {
//             await fsPromises.access(include);
//             includes.push(include);
//         } catch {
//             // include 目录不存在,跳过
//         }
//     }
//     return includes;
// }
//
// // ============================================================================
// // 配置文件自动增删(设计方案:设计/配置文件自动增删方案.md)
// // 包列表变化时自动增删 IDE 头文件搜索路径(include 条目):
// //   A 侧:cpptools / .vscode/c_cpp_properties.json 的 includePath(${workspaceFolder}/.../include/** 形态)
// //   B 侧:clangd / .clangd 的 CompileFlags.Add(-I<绝对路径>/include 形态)
// // 统一机制:包 diff(按路径)→ 有感删除(通知 + 黑名单 + 复核)→ 写队列(P6)→ 原子覆盖(P5)。
// // 触发:复用 10s 收口(finalizeCacheUpdate → activateEnvironment)调用 maintainIncludeConfigs()。
// // ============================================================================
//
// /**
//  * 绝对 include 路径 → c_cpp_properties.json includePath 条目(A 侧唯一权威转换)。
//  * 增量增删与整体重写共用此函数(R-A1),杜绝两套逻辑漂移。
//  * 工作区内:${workspaceFolder}/<rel>/include/**(POSIX 分隔符)；工作区外:<abs>/include/**
//  */
// export function toCppIncludeEntry(absInclude: string, workspaceRoot: string): string {
//     const relativePath = makeWorkspaceRelative(absInclude, workspaceRoot);
//     if (relativePath !== absInclude) {
//         if (relativePath === "") {
//             return "${workspaceFolder}/**";
//         }
//         const vscodeRelativePath = relativePath.split(path.sep).join(path.posix.sep);
//         return path.posix.join("${workspaceFolder}", vscodeRelativePath, "**");
//     }
//     return path.join(absInclude, "**");
// }
//
// // ---- 引擎开关(ROS2.ide.intellisenseEngine) ----
// type IntellisenseEngine = "auto" | "cpptools" | "clangd" | "both" | "none";
//
// interface ActiveSides {
//     cpptools: boolean;
//     clangd: boolean;
// }
//
// const INTELLISENSE_ENGINES: IntellisenseEngine[] = ["auto", "cpptools", "clangd", "both", "none"];
//
// function getIntellisenseEngine(): IntellisenseEngine {
//     const v = vscode_utils.getExtensionConfiguration().get<IntellisenseEngine>("ide.intellisenseEngine", "both");
//     return INTELLISENSE_ENGINES.includes(v) ? v : "both";
// }
//
// function isClangdExtensionInstalled(): boolean {
//     return !!vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd");
// }
//
// /**
//  * 解析引擎开关 → 启用的维护侧。
//  * auto:cpptools/clangd 只装一个用那个；都装/都没装 → 双侧维护。
//  */
// function resolveActiveSides(): ActiveSides {
//     log.trace(`解析启用的维护侧:引擎=${getIntellisenseEngine()}`);
//     switch (getIntellisenseEngine()) {
//         case "cpptools": return { cpptools: true, clangd: false };
//         case "clangd": return { cpptools: false, clangd: true };
//         case "none": return { cpptools: false, clangd: false };
//         case "auto": {
//             const cpp = vscode_utils.isCppToolsExtensionInstalled();
//             const cld = isClangdExtensionInstalled();
//             if (cpp && !cld) { return { cpptools: true, clangd: false }; }
//             if (cld && !cpp) { return { cpptools: false, clangd: true }; }
//             return { cpptools: true, clangd: true };
//         }
//         case "both":
//         default: return { cpptools: true, clangd: true };
//     }
// }
//
// // ---- 写队列(P6:文件锁防重入,任何时刻单写者) ----
// let writeChain: Promise<void> = Promise.resolve();
//
// function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
//     const result = writeChain.then(task);
//     // 吞掉失败避免链中断(失败由调用方 catch)
//     writeChain = result.then(() => undefined, () => undefined);
//     return result;
// }
//
// /** 配置文件自动增删模块日志 */
// const log = getLogger("cfg-auto");
//
// /** 配置文件自动增删统一日志(输出到扩展输出面板,便于调试)。 */
// function logCfg(msg: string): void {
//     log.info(msg);
// }
//
// // ---- 黑名单(P4:持久化到 .vscode/rde-ros-2-state.json 的 includeBlacklist 字段) ----
// interface IncludeBlacklist {
//     cpp: { [entry: string]: number };    // A 侧条目字符串 → 加入时间戳
//     clangd: { [entry: string]: number }; // B 侧条目字符串(-I<abs>)→ 加入时间戳
// }
//
// async function readBlacklist(workspaceRoot: string): Promise<IncludeBlacklist> {
//     const state = await buildState.readStateFile(workspaceRoot);
//     const bl = state && typeof state === "object" ? state.includeBlacklist : undefined;
//     if (!bl || typeof bl !== "object") {
//         return { cpp: {}, clangd: {} };
//     }
//     return {
//         cpp: bl.cpp && typeof bl.cpp === "object" ? bl.cpp : {},
//         clangd: bl.clangd && typeof bl.clangd === "object" ? bl.clangd : {},
//     };
// }
//
// async function writeBlacklist(workspaceRoot: string, list: IncludeBlacklist): Promise<void> {
//     const state = await buildState.readStateFile(workspaceRoot);
//     await buildState.writeStateFile(workspaceRoot, { ...state, includeBlacklist: list });
// }
//
// // ---- 包 include 辅助 ----
// function absIncludeForPackage(pkg: colconUtils.Package, workspaceRoot: string): string {
//     const pkgPath = path.isAbsolute(pkg.path) ? pkg.path : path.resolve(workspaceRoot, pkg.path);
//     return path.join(pkgPath, "include");
// }
//
// async function packageHasIncludeDir(pkg: colconUtils.Package, workspaceRoot: string): Promise<boolean> {
//     try {
//         await fsPromises.access(absIncludeForPackage(pkg, workspaceRoot));
//         return true;
//     } catch {
//         return false;
//     }
// }
//
// // ---- 有感删除(P3):删除候选 + 通知 + 复核 ----
// interface RemovalCandidate {
//     side: "cpp" | "clangd";
//     pkg: colconUtils.Package;
//     entry: string; // A: includePath 条目；B: -I<abs> 条目
// }
//
// const DELETION_CONFIRM_TIMEOUT_MS = 10000;
//
// /**
//  * 删除确认通知:多条删除合并为一条通知(R5)；超时默认不删(安全侧)。
//  * 返回 true=用户同意删除；false=拒绝/超时。
//  */
// async function requestDeletionConfirmation(candidates: RemovalCandidate[]): Promise<boolean> {
//     if (candidates.length === 0) {
//         return false;
//     }
//     log.debug(`弹窗确认删除 ${candidates.length} 条 include 条目`);
//     const names = candidates.map(c => c.pkg.name).join("、");
//     const message = candidates.length === 1
//         ? `检测到包“${names}”已从工作区消失,是否从配置中移除其 include 条目？`
//         : `检测到 ${candidates.length} 个包已从工作区消失(${names}),是否从配置中移除其 include 条目？`;
//     return new Promise<boolean>((resolve) => {
//         const timeout = setTimeout(() => {
//             log.debug("删除确认超时,默认保留");
//             resolve(false);
//         }, DELETION_CONFIRM_TIMEOUT_MS);
//         void vscode.window.showWarningMessage(message, "删除", "保留").then((choice) => {
//             clearTimeout(timeout);
//             log.debug(`用户选择:${choice === "删除" ? "删除" : "保留"}`);
//             resolve(choice === "删除");
//         });
//     });
// }
//
// /**
//  * 删除前复核包是否仍缺席(R6/R-A7):按 <pkg>/package.xml 的"结构 + 名称"复核。
//  * 返回 true=包确实已消失(可删)；false=包仍存在/已恢复/目录被占用(不删)。
//  * 说明:设计 §4.4/R-A7 文字把通过/失败条件写反,此处按 R6"复核该包当前仍缺席,否则放弃删除"语义实现——
//  * package.xml 缺失/非法 = 包已消失 → 删；package.xml 合法且 name 匹配 = 包还在 → 不删。
//  */
// async function recheckPackageStillAbsent(pkg: colconUtils.Package, workspaceRoot: string): Promise<boolean> {
//     log.trace(`复核包 ${pkg.name} 是否仍缺席`);
//     const pkgPath = path.isAbsolute(pkg.path) ? pkg.path : path.resolve(workspaceRoot, pkg.path);
//     const valid = await colconUtils.isValidPackageXml(pkgPath);
//     if (!valid) {
//         return true; // package.xml 不存在/结构不合法 → 包确实缺席 → 可删
//     }
//     const name = await colconUtils.getPackageNameFromXml(pkgPath);
//     return name !== pkg.name; // 名称不匹配 = 目录被占用 → 视为未缺席 → 不删
// }
//
// function logRecheckSkip(c: RemovalCandidate): void {
//     log.warn(`复核未通过,跳过删除 include 条目(包 ${c.pkg.name} 仍存在/已恢复/目录被占用):${c.entry}`);
// }
//
// // ---- A 侧渲染器:.vscode/c_cpp_properties.json 增量 ----
//
// interface SideResult {
//     candidates: RemovalCandidate[];
//     additions: string[];
// }
//
// /**
//  * A 侧收集:读取现有 c_cpp_properties.json,计算新增条目(宽松查重)+ 消失候选(绝对字符串匹配)。
//  * 文件缺失/损坏时返回空候选(写入阶段回退整体重写)。
//  */
// async function collectCppSide(workspaceRoot: string, addedPkgs: colconUtils.Package[], removedPkgs: colconUtils.Package[]): Promise<SideResult> {
//     log.trace("收集 A 侧(cpptools)include 变更");
//     const filePath = path.join(workspaceRoot, ".vscode", "c_cpp_properties.json");
//     const additions: string[] = [];
//     // 循环:为新增包计算 include 条目
//     for (const pkg of addedPkgs) {
//         if (await packageHasIncludeDir(pkg, workspaceRoot)) {
//             additions.push(toCppIncludeEntry(absIncludeForPackage(pkg, workspaceRoot), workspaceRoot));
//         }
//     }
//     const candidates: RemovalCandidate[] = [];
//     try {
//         const config = JSON.parse(await fsPromises.readFile(filePath, "utf-8"));
//         const ros2Config = (config.configurations || []).find((c: any) => c && c.name === "ros2");
//         if (ros2Config && Array.isArray(ros2Config.includePath)) {
//             const includePath: string[] = ros2Config.includePath;
//             for (const pkg of removedPkgs) {
//                 if (await packageHasIncludeDir(pkg, workspaceRoot)) {
//                     continue; // include 目录还在:包并未真正消失,跳过
//                 }
//                 const entry = toCppIncludeEntry(absIncludeForPackage(pkg, workspaceRoot), workspaceRoot);
//                 if (includePath.includes(entry)) {
//                     candidates.push({ side: "cpp", pkg, entry });
//                 }
//             }
//         }
//     } catch {
//         // 文件缺失/损坏:增量无对象,写入阶段回退整体重写
//     }
//     return { candidates, additions };
// }
//
// /**
//  * A 侧写入(锁内读-改-写,P5/P6):插入新增条目 + 删除已确认条目(含复核)。
//  * 返回本次实际删除 / 复核未通过的候选。
//  */
// async function applyCppChanges(
//     workspaceRoot: string,
//     additions: string[],
//     confirmedDeletions: RemovalCandidate[],
// ): Promise<{ deleted: RemovalCandidate[]; kept: RemovalCandidate[] }> {
//     const filePath = path.join(workspaceRoot, ".vscode", "c_cpp_properties.json");
//     const deleted: RemovalCandidate[] = [];
//     const kept: RemovalCandidate[] = [];
//     await enqueueWrite(async () => {
//         let config: any;
//         try {
//             config = JSON.parse(await fsPromises.readFile(filePath, "utf-8"));
//         } catch {
//             // R-A6:文件缺失/损坏 → 回退整体重写；本次确认删除全部视为未删
//             await updateCppPropertiesInternal();
//             kept.push(...confirmedDeletions);
//             return;
//         }
//         const ros2Config = (config.configurations || []).find((c: any) => c && c.name === "ros2");
//         if (!ros2Config) {
//             // R-A6:无 ros2 配置节 → 回退整体重写
//             await updateCppPropertiesInternal();
//             kept.push(...confirmedDeletions);
//             return;
//         }
//         const includePath: string[] = Array.isArray(ros2Config.includePath) ? ros2Config.includePath : [];
//         let changed = false;
//         let insertedCount = 0;
//         // 插入(宽松查重,允许与用户绝对路径并存)
//         for (const entry of additions) {
//             if (!includePath.includes(entry)) {
//                 includePath.push(entry);
//                 changed = true;
//                 insertedCount++;
//             }
//         }
//         // 删除(绝对字符串匹配 + 删除前复核)
//         for (const cand of confirmedDeletions) {
//             if (!(await recheckPackageStillAbsent(cand.pkg, workspaceRoot))) {
//                 kept.push(cand);
//                 continue;
//             }
//             const idx = includePath.indexOf(cand.entry);
//             if (idx !== -1) {
//                 includePath.splice(idx, 1);
//                 deleted.push(cand);
//                 changed = true;
//             } else {
//                 // 条目已不存在(自然消失)→ 视为已删
//                 deleted.push(cand);
//             }
//         }
//         ros2Config.includePath = includePath;
//         if (changed) {
//             await fsPromises.writeFile(filePath, JSON.stringify(config, undefined, 2), "utf-8");
//             if (insertedCount > 0) {
//                 logCfg(`A 侧插入 ${insertedCount} 条 include 条目`);
//             }
//             if (deleted.length > 0) {
//                 logCfg(`A 侧删除 ${deleted.length} 条:${deleted.map(d => d.entry).join(", ")}`);
//             }
//         }
//     });
//     return { deleted, kept };
// }
//
// // ---- B 侧渲染器:.clangd 增量(文本级绝对匹配) ----
//
// function clangdAddValue(absInclude: string): string {
//     return `-I${absInclude}`;
// }
//
// /**
//  * 定位 .clangd 中 CompileFlags.Add 块:返回 { addIndex, itemIndent, end }(end 为 Add 块结束行索引,不含该行)。
//  * 找不到 Add 块返回 undefined。
//  */
// function findAddBlock(lines: string[]): { addIndex: number; itemIndent: string; end: number } | undefined {
//     const addIndex = lines.findIndex(l => /^\s*Add:\s*$/.test(l));
//     if (addIndex === -1) {
//         return undefined;
//     }
//     const addIndent = lines[addIndex].match(/^\s*/)![0].length;
//     let itemIndent = "    ";
//     let end = addIndex + 1;
//     while (end < lines.length) {
//         const l = lines[end];
//         if (l.trim() === "") {
//             end++;
//             continue;
//         }
//         const lineIndent = l.match(/^\s*/)![0].length;
//         if (lineIndent <= addIndent) {
//             break; // 已离开 Add 块(遇到同级或更高级 key)
//         }
//         if (/^\s*-\s/.test(l)) {
//             itemIndent = l.match(/^\s*/)![0];
//         }
//         end++;
//     }
//     return { addIndex, itemIndent, end };
// }
//
// /**
//  * B 侧收集:读取现有 .clangd,计算新增条目 + 消失候选(Add 下 - -I<abs> 行绝对匹配)。
//  */
// async function collectClangdSide(workspaceRoot: string, addedPkgs: colconUtils.Package[], removedPkgs: colconUtils.Package[]): Promise<SideResult> {
//     const filePath = path.join(workspaceRoot, ".clangd");
//     const additions: string[] = [];
//     for (const pkg of addedPkgs) {
//         if (await packageHasIncludeDir(pkg, workspaceRoot)) {
//             additions.push(clangdAddValue(absIncludeForPackage(pkg, workspaceRoot)));
//         }
//     }
//     const candidates: RemovalCandidate[] = [];
//     try {
//         const lines = (await fsPromises.readFile(filePath, "utf-8")).split(/\r?\n/);
//         for (const pkg of removedPkgs) {
//             if (await packageHasIncludeDir(pkg, workspaceRoot)) {
//                 continue;
//             }
//             const entry = clangdAddValue(absIncludeForPackage(pkg, workspaceRoot));
//             if (lines.some(l => l.trim() === `- ${entry}`)) {
//                 candidates.push({ side: "clangd", pkg, entry });
//             }
//         }
//     } catch {
//         // .clangd 不存在:增量无对象(生成由 ensureClangdFile 负责)
//     }
//     return { candidates, additions };
// }
//
// /**
//  * B 侧写入(锁内文本级读-改-写):插入新增 - -I 行 + 删除已确认行(含复核)。
//  */
// async function applyClangdChanges(
//     workspaceRoot: string,
//     additions: string[],
//     confirmedDeletions: RemovalCandidate[],
// ): Promise<{ deleted: RemovalCandidate[]; kept: RemovalCandidate[] }> {
//     const filePath = path.join(workspaceRoot, ".clangd");
//     const deleted: RemovalCandidate[] = [];
//     const kept: RemovalCandidate[] = [];
//     await enqueueWrite(async () => {
//         let content: string;
//         try {
//             content = await fsPromises.readFile(filePath, "utf-8");
//         } catch {
//             kept.push(...confirmedDeletions); // .clangd 不存在:本次无对象可写(生成另由 ensureClangdFile 负责)
//             return;
//         }
//         const lines = content.split(/\r?\n/);
//         let changed = false;
//         let insertedCount = 0;
//         const addBlock = findAddBlock(lines);
//         // 插入(宽松查重:行级精确匹配)
//         if (addBlock) {
//             const { itemIndent, end } = addBlock;
//             let insertAt = end;
//             for (const entry of additions) {
//                 if (!lines.some(l => l.trim() === `- ${entry}`)) {
//                     lines.splice(insertAt, 0, `${itemIndent}- ${entry}`);
//                     insertAt++;
//                     changed = true;
//                     insertedCount++;
//                 }
//             }
//         } else if (additions.length > 0) {
//             // 无 Add 块:把 Add 插入到已有 CompileFlags 块内(避免重复 CompileFlags key 导致 YAML 覆盖,R-4),无 CompileFlags 才新建
//             const cfIndex = lines.findIndex(l => /^\s*CompileFlags:\s*$/.test(l));
//             if (cfIndex !== -1) {
//                 const cfIndent = lines[cfIndex].match(/^\s*/)![0].length;
//                 let blockEnd = cfIndex + 1;
//                 while (blockEnd < lines.length) {
//                     const l = lines[blockEnd];
//                     if (l.trim() !== "" && l.match(/^\s*/)![0].length <= cfIndent) {
//                         break; // 离开 CompileFlags 块
//                     }
//                     blockEnd++;
//                 }
//                 lines.splice(blockEnd, 0, "  Add:");
//                 blockEnd++;
//                 for (const entry of additions) {
//                     lines.splice(blockEnd, 0, `    - ${entry}`);
//                     blockEnd++;
//                 }
//                 changed = true;
//                 insertedCount += additions.length;
//             } else {
//                 lines.push("CompileFlags:", "  Add:");
//                 for (const entry of additions) {
//                     lines.push(`    - ${entry}`);
//                 }
//                 changed = true;
//                 insertedCount += additions.length;
//             }
//         }
//         // 删除(绝对字符串匹配 + 删除前复核)
//         for (const cand of confirmedDeletions) {
//             if (!(await recheckPackageStillAbsent(cand.pkg, workspaceRoot))) {
//                 kept.push(cand);
//                 continue;
//             }
//             const target = `- ${cand.entry}`;
//             let removedLine = false;
//             for (let i = 0; i < lines.length; i++) {
//                 if (lines[i].trim() === target) {
//                     lines.splice(i, 1);
//                     i--;
//                     removedLine = true;
//                     changed = true;
//                 }
//             }
//             if (removedLine) {
//                 deleted.push(cand);
//             } else {
//                 // 行已不存在(自然消失)→ 视为已删
//                 deleted.push(cand);
//             }
//         }
//         if (changed) {
//             await fsPromises.writeFile(filePath, lines.join("\n"), "utf-8");
//             if (insertedCount > 0) {
//                 logCfg(`B 侧插入 ${insertedCount} 条 -I 条目`);
//             }
//             if (deleted.length > 0) {
//                 logCfg(`B 侧删除 ${deleted.length} 条:${deleted.map(d => d.entry).join(", ")}`);
//             }
//         }
//     });
//     return { deleted, kept };
// }
//
// /**
//  * B 侧 0→1 缺失才生成:.clangd 不存在时生成(CompilationDatabase: build + Add 兜底列表)。
//  */
// async function ensureClangdFile(workspaceRoot: string): Promise<void> {
//     if (!resolveActiveSides().clangd) {
//         return;
//     }
//     const filePath = path.join(workspaceRoot, ".clangd");
//     try {
//         await fsPromises.access(filePath);
//         return; // 已存在:不覆盖
//     } catch {
//         // 不存在 → 生成
//     }
//     // 用与 activateEnvironment 相同的 buildExcludeFolders 取包(命中缓存,避免重复 colcon list)
//     const excludedFolders = vscode_utils.getExtensionConfiguration().get<string[]>("search.excludeFolders", []);
//     const pkgs = await colconUtils.getPackages(workspaceRoot, excludedFolders);
//     const lines: string[] = ["CompileFlags:", "  Add:"];
//     for (const pkg of pkgs) {
//         if (await packageHasIncludeDir(pkg, workspaceRoot)) {
//             lines.push(`    - ${clangdAddValue(absIncludeForPackage(pkg, workspaceRoot))}`);
//         }
//     }
//     lines.push("CompilationDatabase: build");
//     const addCount = lines.length - 3; // 去掉 CompileFlags / Add / CompilationDatabase 三行
//     await enqueueWrite(async () => {
//         await fsPromises.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
//         logCfg(`已生成 .clangd:CompilationDatabase: build + ${addCount} 条 Add 兜底`);
//     });
// }
//
// // ---- 统一维护入口 ----
//
// /**
//  * 配置文件自动增删统一入口:消费包 diff,按引擎开关维护 A/B 两侧。
//  * 由 extension.activateEnvironment 在 createConfigFiles 之后调用(复用 10s 收口,天然节流 + 复用 processingWorkspace 锁)。
//  * 无包不维护(含 1→0 包全消失:不删除文件,只多不少)。
//  */
// export async function maintainIncludeConfigs(): Promise<void> {
//     const workspaceRoot = vscode.workspace.rootPath;
//     if (!workspaceRoot) {
//         return;
//     }
//     if (!colconUtils.hasCachedPackages()) {
//         return;
//     }
//     const diff = colconUtils.consumeLastPackageDiff();
//     if (!diff || (diff.added.length === 0 && diff.removed.length === 0)) {
//         // 无变化:仍确保 B 侧 0→1 生成(.clangd 缺失)
//         await ensureClangdFile(workspaceRoot);
//         return;
//     }
//     const sides = resolveActiveSides();
//     logCfg(`开始维护:新增 ${diff.added.map(p => p.name).join("、") || "(无)"},消失 ${diff.removed.map(p => p.name).join("、") || "(无)"}；引擎=${getIntellisenseEngine()}`);
//     const blacklist = await readBlacklist(workspaceRoot);
//
//     // 收集两侧候选与新增
//     const allCandidates: RemovalCandidate[] = [];
//     let cppResult: SideResult = { candidates: [], additions: [] };
//     let clangdResult: SideResult = { candidates: [], additions: [] };
//     if (sides.cpptools) {
//         cppResult = await collectCppSide(workspaceRoot, diff.added, diff.removed);
//         allCandidates.push(...cppResult.candidates);
//     }
//     if (sides.clangd) {
//         await ensureClangdFile(workspaceRoot);
//         clangdResult = await collectClangdSide(workspaceRoot, diff.added, diff.removed);
//         allCandidates.push(...clangdResult.candidates);
//     }
//     logCfg(`收集结果:A 侧新增 ${cppResult.additions.length} 条 / 消失候选 ${cppResult.candidates.length} 条；B 侧新增 ${clangdResult.additions.length} 条 / 消失候选 ${clangdResult.candidates.length} 条`);
//
//     // 黑名单过滤:黑名单内不通知、继续监视(防骚扰)
//     const candidatesToAsk = allCandidates.filter(c => {
//         const bl = c.side === "cpp" ? blacklist.cpp : blacklist.clangd;
//         return bl[c.entry] === undefined;
//     });
//     const blockedCount = allCandidates.length - candidatesToAsk.length;
//     if (blockedCount > 0) {
//         logCfg(`黑名单拦截 ${blockedCount} 条候选(防骚扰,不通知)`);
//     }
//
//     // 新增条目若曾在黑名单 → 条目再次出现,视为新一轮,解除黑名单(P4)
//     for (const entry of cppResult.additions) {
//         if (blacklist.cpp[entry] !== undefined) {
//             delete blacklist.cpp[entry];
//         }
//     }
//     for (const entry of clangdResult.additions) {
//         if (blacklist.clangd[entry] !== undefined) {
//             delete blacklist.clangd[entry];
//         }
//     }
//
//     const confirmed = candidatesToAsk.length > 0
//         ? await requestDeletionConfirmation(candidatesToAsk)
//         : false;
//     if (candidatesToAsk.length > 0) {
//         logCfg(`弹窗确认 ${candidatesToAsk.length} 条候选:${confirmed ? "用户同意删除" : "拒绝/超时 → 默认不删,记黑名单"}`);
//     }
//
//     if (confirmed) {
//         const cppConfirmed = candidatesToAsk.filter(c => c.side === "cpp");
//         const clangdConfirmed = candidatesToAsk.filter(c => c.side === "clangd");
//         if (sides.cpptools) {
//             const res = await applyCppChanges(workspaceRoot, cppResult.additions, cppConfirmed);
//             for (const d of res.deleted) {
//                 delete blacklist.cpp[d.entry]; // 删除成功 → 黑名单同步移除
//             }
//             for (const k of res.kept) {
//                 logRecheckSkip(k);
//             }
//         }
//         if (sides.clangd) {
//             const res = await applyClangdChanges(workspaceRoot, clangdResult.additions, clangdConfirmed);
//             for (const d of res.deleted) {
//                 delete blacklist.clangd[d.entry];
//             }
//             for (const k of res.kept) {
//                 logRecheckSkip(k);
//             }
//         }
//     } else {
//         // 拒绝/超时:默认不删；拒绝记忆走黑名单(防骚扰)；仍执行插入(易增难删)
//         if (candidatesToAsk.length > 0) {
//             const now = Date.now();
//             for (const c of candidatesToAsk) {
//                 const bl = c.side === "cpp" ? blacklist.cpp : blacklist.clangd;
//                 bl[c.entry] = now;
//             }
//         }
//         if (sides.cpptools) {
//             await applyCppChanges(workspaceRoot, cppResult.additions, []);
//         }
//         if (sides.clangd) {
//             await applyClangdChanges(workspaceRoot, clangdResult.additions, []);
//         }
//     }
//
//     // 持久化黑名单(读失败回退空名单,不崩溃)
//     await enqueueWrite(() => writeBlacklist(workspaceRoot, blacklist));
// }
//
// // ---- B 侧:compile_commands 合并(绑定编译) ----
//
// let mergeChain: Promise<void> = Promise.resolve();
//
// /**
//  * 合并各 build/<pkg>/compile_commands.json → build/compile_commands.json。
//  * 每次构建完成后调用(无论成败:失败包无 compile_commands,但成功包仍有,clangd 至少索引成功部分)。
//  * 未编译时数据源为空,合并结果写空数组(build 清则同失,补全本无数据可索引)。
//  */
// export function mergeCompileCommands(workspaceRoot: string): void {
//     mergeChain = mergeChain.then(async () => {
//         try {
//             const buildDir = path.join(workspaceRoot, "build");
//             let entries;
//             try {
//                 entries = await fsPromises.readdir(buildDir, { withFileTypes: true });
//             } catch {
//                 return; // build 目录不存在:无数据可合并
//             }
//             const merged: any[] = [];
//             for (const e of entries) {
//                 if (!e.isDirectory()) {
//                     continue;
//                 }
//                 const ccPath = path.join(buildDir, e.name, "compile_commands.json");
//                 try {
//                     const parsed = JSON.parse(await fsPromises.readFile(ccPath, "utf-8"));
//                     if (Array.isArray(parsed)) {
//                         merged.push(...parsed);
//                     }
//                 } catch {
//                     // 单个包无/坏 compile_commands:忽略
//                 }
//             }
//             await fsPromises.writeFile(path.join(buildDir, "compile_commands.json"), JSON.stringify(merged, null, 2), "utf-8");
//             logCfg(`已合并 ${merged.length} 条编译命令 → build/compile_commands.json`);
//         } catch {
//             // 合并失败忽略,不影响构建
//         }
//     });
// }
//
// /**
//  * Check if a file or directory exists.
//  */
// async function exists(filePath: string): Promise<boolean> {
//     try {
//         await fsPromises.access(filePath);
//         return true;
//     } catch {
//         return false;
//     }
// }
//
// const PYTHON_AUTOCOMPLETE_PATHS = "python.autoComplete.extraPaths";
// const PYTHON_ANALYSIS_PATHS = "python.analysis.extraPaths";
//
// /**
//  * Creates config files which don't exist.
//  */
// export async function createConfigFiles() {
//     const config = vscode.workspace.getConfiguration();
//
//     // Update the Python autocomplete paths if required.
//     if (config.get(PYTHON_AUTOCOMPLETE_PATHS, []).length === 0) {
//         updatePythonAutoCompletePathInternal();
//     }
//
//     // Update the Python analysis paths if required.
//     if (config.get(PYTHON_ANALYSIS_PATHS, []).length === 0) {
//         updatePythonAnalysisPathInternal();
//     }
//
//     const dir = path.join(vscode.workspace.rootPath, ".vscode");
//
//     // Update the C++ path(缺失才写,0→1 状态迁移)。
//     if (!(await exists(path.join(dir, "c_cpp_properties.json")))) {
//         await updateCppPropertiesInternal();
//     }
//
//     // B 侧 0→1:.clangd 缺失才生成(引擎启用 clangd 时)。
//     await ensureClangdFile(vscode.workspace.rootPath);
// }
//
// export async function updateCppProperties(context: vscode.ExtensionContext): Promise<void> {
//     const reporter = telemetry.getReporter();
//     reporter.sendTelemetryCommand(extension.Commands.UpdateCppProperties);
//
//     updateCppPropertiesInternal();
// }
//
// /**
//  * Updates the `c_cpp_properties.json` file with ROS include paths.
//  * 整体重写:与增量维护共用 toCppIncludeEntry(R-A1)保证条目形态一致。
//  */
// export async function updateCppPropertiesInternal(): Promise<void> {
//     let includes = await getRosIncludeDirs();
//     const workspaceIncludes = await getWorkspaceIncludeDirs(vscode.workspace.rootPath);
//     includes = includes.concat(workspaceIncludes);
//
//     if (process.platform === "linux") {
//         includes.push(path.join("/", "usr", "include"));
//     }
//
//     const workspaceRoot = vscode.workspace.rootPath;
//
//     // Convert paths to workspace-relative where possible(共用 A 侧唯一权威转换)
//     includes = includes.map((include: string) => toCppIncludeEntry(include, workspaceRoot));
//
//     // https://github.com/Microsoft/vscode-cpptools/blob/master/Documentation/LanguageServer/c_cpp_properties.json.md
//     const cppProperties: any = {
//         configurations: [
//             {
//                 browse: {
//                     databaseFilename: "${workspaceFolder}/.vscode/browse.vc.db",
//                     limitSymbolsToIncludedHeaders: false,
//                 },
//                 includePath: includes,
//                 name: "ros2",
//             },
//         ],
//         version: 4,
//     };
//
//     const filename = path.join(vscode.workspace.rootPath, ".vscode", "c_cpp_properties.json");
//
//     if (process.platform === "linux") {
//         // set the default configurations.
//         cppProperties.configurations[0].intelliSenseMode = "gcc-" + process.arch
//         cppProperties.configurations[0].compilerPath = "/usr/bin/gcc"
//         cppProperties.configurations[0].cStandard = "gnu11"
//         cppProperties.configurations[0].cppStandard = getCppStandard()
//
//         // read the existing file
//         try {
//             let existing: any = JSON.parse(await fsPromises.readFile(filename, 'utf8'));
//
//             // if the existing configurations are different from the defaults, use the existing values
//             if (existing.configurations && existing.configurations.length > 0) {
//                 const existingConfig = existing.configurations[0];
//
//                 cppProperties.configurations[0].intelliSenseMode = existingConfig.intelliSenseMode || cppProperties.configurations[0].intelliSenseMode;
//                 cppProperties.configurations[0].compilerPath = existingConfig.compilerPath || cppProperties.configurations[0].compilerPath;
//                 cppProperties.configurations[0].cStandard = existingConfig.cStandard || cppProperties.configurations[0].cStandard;
//                 cppProperties.configurations[0].cppStandard = existingConfig.cppStandard || cppProperties.configurations[0].cppStandard;
//             }
//         }
//         catch (error) {
//             // ignore
//         }
//     }
//
//     // Ensure the ".vscode" directory exists then update the C++ path.
//     const dir = path.join(vscode.workspace.rootPath, ".vscode");
//
//     if (!await exists(dir)) {
//         await fsPromises.mkdir(dir, { recursive: true });
//     }
//
//     await fsPromises.writeFile(filename, JSON.stringify(cppProperties, undefined, 2), 'utf8');
// }
//
// export function updatePythonPath(context: vscode.ExtensionContext) {
//     const reporter = telemetry.getReporter();
//     reporter.sendTelemetryCommand(extension.Commands.UpdatePythonPath);
//
//     updatePythonAutoCompletePathInternal();
//     updatePythonAnalysisPathInternal();
// }
//
// /**
//  * Updates the python autocomplete path to support ROS.
//  */
// function updatePythonAutoCompletePathInternal() {
//     const env = getEnv();
//     const pythonPaths = env?.PYTHONPATH ? env.PYTHONPATH.split(path.delimiter) : [];
//     const workspaceRoot = vscode.workspace.rootPath;
//
//     // Convert absolute paths to relative paths where possible
//     // Filter before conversion to remove empty strings from PYTHONPATH
//     const relativePaths = pythonPaths
//         .filter((p: string) => p.trim() !== "")
//         .map((p: string) => makeWorkspaceRelative(p, workspaceRoot));
//
//     vscode.workspace.getConfiguration().update(PYTHON_AUTOCOMPLETE_PATHS, relativePaths);
// }
//
// /**
//  * Updates the python analysis path to support ROS.
//  */
// function updatePythonAnalysisPathInternal() {
//     const env = getEnv();
//     const pythonPaths = env?.PYTHONPATH ? env.PYTHONPATH.split(path.delimiter) : [];
//     const workspaceRoot = vscode.workspace.rootPath;
//
//     // Convert absolute paths to relative paths where possible
//     // Filter before conversion to remove empty strings from PYTHONPATH
//     const relativePaths = pythonPaths
//         .filter((p: string) => p.trim() !== "")
//         .map((p: string) => makeWorkspaceRelative(p, workspaceRoot));
//
//     vscode.workspace.getConfiguration().update(PYTHON_ANALYSIS_PATHS, relativePaths);
// }
//
