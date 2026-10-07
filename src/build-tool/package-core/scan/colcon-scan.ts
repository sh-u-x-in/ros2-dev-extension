// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file colcon-scan.ts
 * COLCON_IGNORE 同目录判定(2026-08-29 清理:死代码注释保留,不参与编译)。
 *
 * 历史(2026-08-21):从 colcon-utils.ts 切分,曾负责 colcon list 全量扫描(scanPackages)、
 * 排除目录判定(isPackageDirExcluded)、忽略判定(hasColconIgnoreSameDir)。
 * 2026-08-28:colcon list 执行改经 package-core 组装根 ros2/ 执行口(colconListExecutor),
 *   scanPackages 失去调用方;isPackageDirExcluded 亦无活跃调用。
 * 2026-08-29:按"注释全文件"风格,原 scanPackages / isPackageDirExcluded / Package 接口及
 *   历史死注释块整体注释保留(见文件下方),仅 hasColconIgnoreSameDir 参与编译;
 *   原 getEnv / vscode_utils / execColconRaw / isValidPackageXml 依赖随注释不再生效。
 */

import * as path from "path";
import * as fs from "fs";

/**
 * 同目录 COLCON_IGNORE 判定:packageDir 下存在 COLCON_IGNORE 文件即视为被忽略。
 * 2026-09-06(四项修复 §12.2 定稿变更):原"用户定稿:只做同目录,不做祖先(有意为之)"已作废——
 * 祖先遮蔽语义由 package-scan 标记集 M + scan/ignore-classify(ancestor)承担;
 * 本函数仍保留,供 ingest 的**同目录 fs 实时探测**(与快照标记集互补:事件可能先于快照到)。
 */
export async function hasColconIgnoreSameDir(packageDir: string): Promise<boolean> {
    try {
        await fs.promises.access(path.join(packageDir, "COLCON_IGNORE"));
        return true;
    } catch {
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 以下为原文件遗留内容(2026-08-29 起整体注释,不参与编译,仅作历史参考)。
// 2026-09-03 复核(项目结尾):内含"待删除(用户自行处理)"历史标记(2026-08-21 标注)——
//   定稿维持墓碑注释保留,不删除;仅文件头 hasColconIgnoreSameDir 参与编译。
// 死代码说明:scanPackages(无活跃调用方,colcon list 已改经 package-core 执行口)、
//   isPackageDirExcluded(无活跃调用方)、Package 接口(随 scanPackages 失效)、
//   scanIgnoredPackages / findFilesWithTimeout / IGNORED_SCAN_TIMEOUT_MS(2026-08-21 已确认死代码)。
// ═══════════════════════════════════════════════════════════════════════════
// /**
//  * Represents a ROS 2 package
//  */
// export interface Package {
//     name: string;
//     path: string;
// }
// 
// /**
//  * 同目录 COLCON_IGNORE 判定:packageDir 下存在 COLCON_IGNORE 文件即视为被忽略。
//  * 用户定稿:只做同目录校验,不做祖先目录(与 colcon 的祖先目录语义不同,有意为之)。
//  */
// export async function hasColconIgnoreSameDir(packageDir: string): Promise<boolean> {
//     try {
//         await fs.promises.access(path.join(packageDir, "COLCON_IGNORE"));
//         return true;
//     } catch {
//         return false;
//     }
// }
// 
// /** 判断包目录是否位于 buildExcludeFolders 排除目录内(与全量扫描同一套解析) */
// export function isPackageDirExcluded(packageDir: string, excludedFolders: string[], workspaceRoot: string): boolean {
//     const excluded = vscode_utils.resolveExcludeFolders(workspaceRoot, excludedFolders);
//     return vscode_utils.isPathExcluded(packageDir, excluded);
// }
// 
// /**
//  * 【死代码】忽略包扫描超时(毫秒):findFiles 可能因跟随符号链接(如 ros2share 共享目录)遍历爆炸而长时间不返回,
//  *  超时后取消并降级为空,避免拖死后台刷新/构建主链路(远程实测 10 分钟无反应)。
//  *  ⚠️ 2026-08-21 确认:仅被死代码 scanIgnoredPackages/findFilesWithTimeout 使用,待删除(用户自行处理)。
//  *  当前 ignore 派生已改走共享缓存 package-cache(walk),不再需要本常量。 */
// // const IGNORED_SCAN_TIMEOUT_MS = 10000;
// // 【死代码】忽略包扫描排除的产物目录:统一用共享 EXCLUDE_GLOB(见 excluded-paths.ts,**/ 前缀任意层级,与 walk 对齐)
// 
// /**
//  * 【死代码】带超时保护的 findFiles:超时后尝试取消底层搜索并立即返回空。
//  * 即使底层 findFiles 因搜索服务卡死而不响应取消,Promise.race 也能保证按时返回,不阻塞调用方;
//  * 底层 promise 的 rejection 被 catch 吞掉,避免 unhandled rejection。
//  *  ⚠️ 2026-08-21 确认:仅被死代码 scanIgnoredPackages 调用,无生产调用方,待删除(用户自行处理)。
//  *  当前 ignore 派生已改走共享缓存 package-cache(walk),不再需要此 findFiles 封装。
//  */
// // async function findFilesWithTimeout(
// //     include: string,
// //     exclude: string,
// //     maxResults: number,
// //     timeoutMs: number,
// // ): Promise<vscode.Uri[]> {
// //     const source = new vscode.CancellationTokenSource();
// //     const timer = setTimeout(() => {
// //         log.warn(`findFiles 超时(${timeoutMs}ms),已取消:${include}`);
// //         source.cancel();
// //     }, timeoutMs);
// //     try {
// //         // findFiles 返回 Thenable(无 .catch),手动包装成真 Promise:取消/失败 → 空,防 unhandled rejection
// //         const searchPromise = new Promise<vscode.Uri[]>((resolve) => {
// //             vscode.workspace.findFiles(include, exclude, maxResults, source.token).then(
// //                 (uris) => resolve(uris),
// //                 () => resolve([]),
// //             );
// //         });
// //         return await Promise.race([
// //             searchPromise,
// //             new Promise<vscode.Uri[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
// //         ]);
// //     } finally {
// //         clearTimeout(timer);
// //     }
// // }
// 
// /**
//  * 【死代码】扫描 COLCON_IGNORE 同目录标记的包(全量填充 ignoredPackages)。
//  * colcon list 天然跳过 COLCON_IGNORE 目录,这里用 findFiles 遍历所有 package.xml 补充发现;
//  * 排除 buildExcludeFolders 路径,仅保留同目录有 COLCON_IGNORE 且带构建文件的真包。
//  * 排除项精确匹配工作区根下的 ./build ./install ./log(不误伤深层同名目录如 src/foo/build),并带超时保护。
//  *  ⚠️ 2026-08-21 确认:无任何生产调用方(package-store.refreshIgnoredPackages 已改读共享缓存 walk 派生
//  *  ignore),findFiles 全工作区扫描 + 跟随符号链接遍历爆炸风险——待删除(用户自行处理)。
//  *  删除时需一并清理:findFilesWithTimeout / IGNORED_SCAN_TIMEOUT_MS / import 的 EXCLUDE_GLOB、
//  *  getPackageNameFromXml(isValidPackageXml 仍被 scanPackages 使用,必须保留)。
//  */
// // export async function scanIgnoredPackages(workspaceRoot: string, excludedFolders: string[]): Promise<Package[]> {
// //     try {
// //         const excluded = vscode_utils.resolveExcludeFolders(workspaceRoot, excludedFolders);
// //         const ignored: Package[] = [];
// //         const pkgXmls = await findFilesWithTimeout(
// //             "**/package.xml",
// //             EXCLUDE_GLOB,
// //             10000,
// //             IGNORED_SCAN_TIMEOUT_MS,
// //         );
// //         for (const uri of pkgXmls) {
// //             const packageDir = path.normalize(path.dirname(uri.fsPath));
// //             if (vscode_utils.isPathExcluded(packageDir, excluded)) {
// //                 continue;
// //             }
// //             if (!(await hasColconIgnoreSameDir(packageDir))) {
// //                 continue;
// //             }
// //             // 与 isValidPackageXml 一致:同目录有构建文件才算真包
// //             if (!(await isValidPackageXml(packageDir))) {
// //                 continue;
// //             }
// //             const name = await getPackageNameFromXml(packageDir);
// //             if (name) {
// //                 ignored.push({ name, path: packageDir });
// //             }
// //         }
// //         log.debug(`扫描忽略包完成:${ignored.length} 个`);
// //         return ignored;
// //     } catch (e) {
// //         log.debug(`扫描忽略包失败:${e instanceof Error ? e.message : String(e)}`);
// //         return [];
// //     }
// // }
// 
// /**
//  * 扫描工作区包:colcon list + 过滤排除目录 + 读取 package.xml 头做合法性校验
//  */
// export async function scanPackages(workspaceRoot: string, excludedFolders: string[]): Promise<Package[]> {
//     try {
//         let colconCommand: string;
//         if (process.platform === "win32") {
//             colconCommand = `colcon --log-base nul list --base-paths "${workspaceRoot}"`;
//         } else {
//             colconCommand = `colcon --log-base /dev/null list --base-paths "${workspaceRoot}"`;
//         }
// 
//         const { stdout } = await execColconRaw(colconCommand, { env: getEnv() });
// 
//         const excluded = vscode_utils.resolveExcludeFolders(workspaceRoot, excludedFolders);
//         const packages: Package[] = [];
//         const lines = stdout.trim().split('\n');
// 
//         for (const line of lines) {
//             if (!line.trim()) {
//                 continue;
//             }
//             // colcon list output format: package_name    path
//             const parts = line.split(/\s+/);
//             if (parts.length < 2) {
//                 continue;
//             }
//             const pkgPath = parts[1];
//             // 跳过位于排除目录内的包
//             if (vscode_utils.isPathExcluded(pkgPath, excluded)) {
//                 continue;
//             }
//             // 合法性校验:读取 package.xml 头部,排除用户手动创建的残缺文件
//             if (await isValidPackageXml(pkgPath)) {
//                 packages.push({ name: parts[0], path: pkgPath });
//             }
//         }
// 
//         return packages;
//     } catch (error) {
//         // 优先使用正确解码后的 stderr(修复 Windows 中文 GBK 乱码)；无 stderr 时退回 error.message
//         const err = error as { stderrText?: string };
//         const errorMessage = err.stderrText && err.stderrText.trim().length > 0
//             ? err.stderrText.trim()
//             : (error instanceof Error ? error.message : String(error));
//         // logger 通道未注入时自动回退 console,无需再用 extension.outputChannel 是否存在作开关
//         log.error(`获取包时出错:${errorMessage}`);
//         return [];
//     }
// }
