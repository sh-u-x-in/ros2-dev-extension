// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file path-exclude.ts
 * 纯文件系统路径排除工具(walk 层配套,零 vscode 依赖,可无头测试;2026-08-21 收敛)。
 *
 * 统一原散落的多份重复实现(消除"老破旧"各自维护、口径易分叉的问题):
 *  - resolveExcludeFolders / isPathExcluded:vscode-utils(导出版)与 package-scan(内联版)各一份 → 收敛于此;
 *  - 构建文件检查(hasBuildFileInDir / PACKAGE_BUILD_FILE_NAMES)已随 2026-08-22 全量收紧淘汰,
 *    统一由 package-core/scan/package-xml.ts 的 matchesBuildTypeFile(build_type 同类型校验)承担。
 *
 * 注意(2026-09-24 更新):测试发现**已改为共用 `ROS2.buildExcludeFolders`**(测试专用的
 * `testExcludeFolders` 已删除),解析与比对都走本模块(`resolveExcludeFolders` / `isPathExcluded`),
 * 不再有"两套排除语义"——原先那句"【不并入】本模块"的注释已作废。
 *
 * 归位(walk 层暴露):通用路径排除工具属最底层叶子,由 walk 导出,
 * 避免上层(package-core/vscode-utils/languages)反向依赖——依赖方向一律 上层 → walk。
 * 依赖方向:本模块仅依赖 path/fs(叶子),无循环。
 */

import * as path from "path";

/**
 * 将配置的排除文件夹列表解析为绝对路径数组。
 * 支持 ${workspaceFolder} 变量替换;相对路径按工作区文件夹解析;绝对路径原样使用。
 */
export function resolveExcludeFolders(workspaceFolder: string, configured: string[]): string[] {
    const result: string[] = [];
    for (const p of configured) {
        if (!p) {
            continue;
        }
        let resolved: string;
        if (p.includes("${workspaceFolder}")) {
            resolved = p.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
        } else if (path.isAbsolute(p)) {
            resolved = p;
        } else {
            resolved = path.join(workspaceFolder, p);
        }
        result.push(path.normalize(resolved));
    }
    return result;
}

/** 判断某个路径是否位于任一排除目录之内(含等于) */
export function isPathExcluded(target: string, excludedFolders: string[]): boolean {
    const normalized = path.normalize(target);
    for (const folder of excludedFolders) {
        const rel = path.relative(folder, normalized);
        if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
            return true;
        }
    }
    return false;
}
