// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file colcon-list.ts
 * colcon list 执行器(2026-08-29 自组装根 index.ts 移入——实现细节归位 scan/,出口文件保持简洁)。
 * 语义:colcon list 快路径取数(unignore 权威,同步构建快表),取代原 colcon-scan.scanPackages(2026-08-28 收敛)。
 * 执行口经注入(组装根接 ros2/ CommandRunner),本模块零 ros2 依赖,可无头测试。
 */

// 路径排除工具归位 walk 层(由 walk 暴露,依赖方向 上层 → walk)
import * as path from "path";
import { resolveExcludeFolders, isPathExcluded } from "../../walk";
import { analyzePackageDir } from "./package-xml";

/** 命令执行口(注入;组装根接 ros2/ CommandRunner) */
export interface CommandExecutor {
    exec(command: string): Promise<{ stdout: string }>;
}

/** 创建 colcon list 执行器(执行口注入;返回 包名/路径/buildType 清单——类型随收录一并携带,2026-09-02) */
export function createColconListExecutor(exec: CommandExecutor) {
    return async (workspaceRoot: string, excludedFolders: string[]): Promise<{ name: string; path: string; buildType?: string }[]> => {
        const nullPath = process.platform === "win32" ? "nul" : "/dev/null";
        const command = `colcon --log-base ${nullPath} list --base-paths "${workspaceRoot}"`;
        // 2026-09-02(语义修正):命令失败不再吞成空名单返回——向上抛,由 syncUnignore 判定
        // 「colcon 未成功执行 → 不标记 colconReady」,域层保持 walk 兜底(失败 ≠ "跑了但空")。
        {
            const { stdout } = await exec.exec(command);
            const excluded = resolveExcludeFolders(workspaceRoot, excludedFolders);
            const packages: { name: string; path: string; buildType?: string }[] = [];
            for (const line of stdout.split(/\r?\n/)) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 2) {
                    continue;
                }
                const rawPath = parts[1];
                // 统一绝对化:colcon list 输出路径历史实测有相对 base-paths 的相对路径,也有绝对路径;
                // 旧实现(package-store.findPackageForPath)曾以 isAbsolute 分支兜底,2026-08-29 收编时丢失。
                // resolve 语义:相对 → 以 workspaceRoot 为基,绝对 → 自身;必须与 walk 画像 entries[].dir
                // (绝对路径)同形态——下游 executable-map.isBuildable / package-cache.attachBuildType
                // 以 === 全等匹配两侧(2026-09-08 数据源修复)。
                const pkgPath = path.resolve(workspaceRoot, rawPath);
                if (isPathExcluded(pkgPath, excluded)) {
                    continue;
                }
                // 权威校验:package.xml 合法才收录(与 scan 口径一致;绝对路径读文件,不依赖进程 cwd)
                // 2026-09-02(设计:package-core出口简化与buildType事件化 §4.2 补强):复用同一次解析携带 buildType——
                // colcon 收录即带类型(undefined 窗口归零),输出与 WorkspacePackage 同构 {name,path,buildType}
                const analysis = await analyzePackageDir(pkgPath);
                if (analysis.valid && analysis.name) {
                    packages.push({ name: parts[0], path: pkgPath, buildType: analysis.buildType });
                }
            }
            return packages;
        }
    };
}
