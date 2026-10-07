/**
 * @file scan/packages.ts
 * build 域包发现 + 特征(traits)判定 —— **构建类型不写死**。
 *
 * 收录判据(对齐 `discover/buildonly/scan.py::analyze_pkg`):
 *   build/<name>/<name>.egg-info 存在        → python 特征
 *   build/<name>/CMakeCache.txt 存在         → cmake 特征
 *   colcon_build.rc 或 colcon_command_prefix_* → colcon 特征
 *   三者任一即收录(其余目录如 COLCON_IGNORE、纯临时目录不计)。
 *
 * 类型推断(仅作展示/统计,**跳转逻辑不依赖类型** —— 这正是 build-only 的优雅处):
 *   egg 且无 cmake            → ament_python
 *   cmake 且有 ament_cmake*   → ament_cmake
 *   cmake                     → cmake
 *   其余(colcon-only)        → python-or-unknown
 *
 * 纯 TS,零依赖,可无头测试。
 */

import { FsLike, isDir, isFile } from "../shared/fs/primitives";
import { BuildPackage, BuildTraits, BuildTypeName } from "../shared/models";
import { pjoin } from "../shared/paths";
import { BuildContext } from "./build-root";

/** 包名合法字符(与 colcon 目录名口径一致;2026-09-30 导出 —— 数据中心增量门用同一套目录名过滤) */
export const PKG_NAME_RE = /^[A-Za-z0-9_]+$/;

/** 顶层子目录名快照(一次 readdir,供 ament/rosidl/colcon 前缀判定复用) */
async function childNames(fs: FsLike, dir: string): Promise<string[]> {
    const names = await fs.readdir(dir);
    return (names ?? []).slice();
}

/** 读取一个 build/<pkg> 的特征 */
export async function readTraits(fs: FsLike, buildDir: string, name: string): Promise<BuildTraits> {
    const children = await childNames(fs, buildDir);
    return {
        cmake: await isFile(fs, pjoin(buildDir, "CMakeCache.txt")),
        amentCmake: children.some((c) => c.startsWith("ament_cmake")),
        python: await isDir(fs, pjoin(buildDir, name + ".egg-info")),
        rosidl: children.some((c) => c.startsWith("rosidl")),
        colcon:
            (await isFile(fs, pjoin(buildDir, "colcon_build.rc"))) ||
            children.some((c) => c.startsWith("colcon_command_prefix_")),
    };
}

/** 由特征推断类型(展示用;不参与跳转判定) */
export function inferType(traits: BuildTraits): BuildTypeName {
    if (traits.python && !traits.cmake) {
        return "ament_python";
    }
    if (traits.cmake && traits.amentCmake) {
        return "ament_cmake";
    }
    if (traits.cmake) {
        return "cmake";
    }
    return "python-or-unknown";
}

/** 扫描 build/ 下全部包 */
export async function discoverBuildPackages(
    fs: FsLike,
    ctx: BuildContext
): Promise<Map<string, BuildPackage>> {
    const out = new Map<string, BuildPackage>();
    const names = await fs.readdir(ctx.buildRoot);
    if (names === undefined) {
        return out;
    }
    for (const name of names.slice().sort()) {
        if (name.startsWith(".") || name === "COLCON_IGNORE" || !PKG_NAME_RE.test(name)) {
            continue;
        }
        const buildDir = pjoin(ctx.buildRoot, name);
        if (!(await isDir(fs, buildDir))) {
            continue;
        }
        const traits = await readTraits(fs, buildDir, name);
        if (!traits.cmake && !traits.python && !traits.colcon) {
            continue; // 非包目录(或构建残留)
        }
        out.set(name, { name, buildDir, type: inferType(traits), traits });
    }
    return out;
}
