// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file excluded-paths.ts
 * 内置产物/依赖目录的统一排除列表(walk 层配套工具,2026-08-21 提升为单一来源)。
 *
 * 背景:原散落 5 处重复定义,口径各自漂移:
 *  - package-scan.ts       : DEFAULT_EXCLUDED_DIR_NAMES(walk 目录名级,含 logs/devel/.git)
 *  - colcon-scan.ts        : IGNORED_SCAN_EXCLUDE(findFiles glob,不含 logs/devel)
 *  - package-map.ts        : EXCLUDE_GLOB(findFiles glob,不含 logs/devel)
 *  - xacro/include-graph.ts: EXCLUDE_GLOB(findFiles glob,不含 logs/devel)
 *  - rosmsg/message-index.ts: MSG_EXCLUDE(findFiles glob,含 logs/devel,不含 .git)
 *
 * 本文件提升为单一来源,统一为【目录名全量 + 任意层级】口径:
 *  - DEFAULT_EXCLUDED_DIR_NAMES:walk 目录名级排除(遍历期跳过,任意层级)——**当前唯一活跃使用**;
 *  - EXCLUDE_GLOB:findFiles glob 排除(任意层级产物目录,与 walk 对齐)。
 *    2026-08-22 复核:全工作区换 walk 后 src/ 下已无活跃调用方(仅注释/死代码引用),保留兼容备用。
 * 纯常量、零依赖,可被任意模块(含 languages/*)导入,不构成循环依赖。
 * 归位(walk 层暴露):统一入口 walk-options.ts 以此为基础排除,外部模块经 walk/index 导入。
 */

/** 内置产物/依赖目录名(walk 目录名级排除;buildExcludeFolders 默认值的超集,含 logs/devel/.hg/.svn/dist/out) */
export const DEFAULT_EXCLUDED_DIR_NAMES: readonly string[] = [
    "build", "install", "log", "logs", "devel", "node_modules", ".git", ".hg", ".svn", "dist", "out",
] as const;

/**
 * 内置产物/依赖目录的 findFiles glob 排除模式(与 DEFAULT_EXCLUDED_DIR_NAMES 同口径,含 logs/devel/.git/.hg/.svn/dist/out)。
 * 【全层级】任意层级前缀排除任意深度的产物目录,与 walk 端(目录名级,天然任意层级)对齐。
 * ⚠️ 2026-08-22 复核:全工作区换 walk 后已无活跃调用方,保留仅供兼容/历史引用,勿再新增调用。
 * 代价:若用户源码目录恰好叫 build/install/log/logs/devel/dist/out 会被一并排除(工作区通常无此同名源码目录)。
 */
export const EXCLUDE_GLOB = "{**/build/**,**/install/**,**/log/**,**/logs/**,**/devel/**,**/node_modules/**,**/.git/**,**/.hg/**,**/.svn/**,**/dist/**,**/out/**}";
