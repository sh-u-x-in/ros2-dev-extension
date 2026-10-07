/**
 * @file scan/build-root.ts
 * build 根定位:**本域的 build 源根**(两源之一;另一源是 install/)。
 *
 * 两个入口形态都支持:
 *   ① 传工作区根(含 build/)—— 常态;
 *   ② 直接传 build 根(目录名 build,或自身含 CMakeCache.txt/colcon_build.rc)。
 *
 * src 根只作为"把跳转落点拼成源码绝对路径"的**前缀约定**(build 里记录的源就是绝对路径,
 * 通常无需 src 根;仅 SOURCES.txt 相对清单需要),**本域不访问 src/**
 * (不 stat、不 read、不 readdir;见 README §2.2「域包含性」)。
 *
 * 纯 TS,零依赖,可无头测试。
 */

import { FsLike, isDir, isFile } from "../shared/fs/primitives";
import { pbasename, pdirname, pjoin } from "../shared/paths";

/** build-only 上下文(工作区根 / 构建根 / 源码根) */
export interface BuildContext {
    /** 工作区根(由 build 根上溯;仅展示与相对化用) */
    workspaceRoot: string;
    /** 构建根(build/)—— 本域两源之一 */
    buildRoot: string;
    /**
     * 源码根 = `<工作区根>/src`,**按约定直接拼,不做存在性探测**。
     *
     * 2026-09-21(域包含性):本域**不访问 `src/`**,它只作为"跳转落点的前缀字符串"存在。
     * 原先的 `isDir(<ws>/src)` 属**越域探测**(README §2.2),已移除 ——
     * 该目录存不存在、有没有被改名,都不归本域管;本域只如实拼出这个前缀。
     */
    srcRoot: string;
}

/**
 * 定位 build 根。
 * @returns 定位失败(既无 build/ 也非 build 根)→ undefined
 */
export async function locateBuildRoot(fs: FsLike, root: string): Promise<BuildContext | undefined> {
    const nested = pjoin(root, "build");
    if (await isDir(fs, nested)) {
        return {
            workspaceRoot: root,
            buildRoot: nested,
            srcRoot: pjoin(root, "src"),
        };
    }
    const looksLikeBuildRoot =
        pbasename(root) === "build" ||
        (await isFile(fs, pjoin(root, "CMakeCache.txt"))) ||
        (await isFile(fs, pjoin(root, "colcon_build.rc"))) ||
        (await isDir(fs, pjoin(root, "CMakeFiles")));
    if (looksLikeBuildRoot) {
        const parent = pdirname(root);
        return {
            workspaceRoot: parent,
            buildRoot: root,
            srcRoot: pjoin(parent, "src"),
        };
    }
    return undefined;
}
