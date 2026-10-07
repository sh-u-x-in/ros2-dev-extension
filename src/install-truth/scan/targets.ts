/**
 * @file scan/targets.ts
 * 编译目标抽取:build/<pkg>/CMakeFiles/<target>.dir/link.txt + *.o.d → 目标/构成源。
 *
 * 这是 build-only 的**主跳转源**(裁切后只做这一件事):
 *   link.txt       → 输出名(`-o` 后 basename)、objects、链接库
 *   <obj>.d        → 每个编译单元的真实源(绝对路径 .cpp)与头
 *   生成源判定     → 源路径落在 build/ 内 = 生成(build 内生成);否则 = 工作区源
 *
 * 为什么它四象限同解:link.txt / .o.d 都是 CMake 在 build/<pkg> 里写的记录,
 * 与 install 布局(isolated/merged)、安装形态(entity/symlink)无关
 * (证据:`discover/buildonly-四象限报告.md` §2 —— targets 全在"固有"侧)。
 *
 * 规格来源:`discover/buildonly/scan.py::targets`。
 * 纯 TS,零依赖,可无头测试。
 */

import { FsLike, exists, walkFiles } from "../shared/fs/primitives";
import { BuildPackage, BuildTarget, TargetKind } from "../shared/models";
import { pbasename, pextname, pjoin, pnormalize } from "../shared/paths";

/** 源文件扩展名(含汇编;比较前统一小写,故 `.S` 亦命中 `.s`) */
export const SRC_EXTS = [".c", ".cc", ".cpp", ".cxx", ".c++", ".s", ".asm"];

/** 头文件扩展名 */
export const HDR_EXTS = [".h", ".hh", ".hpp", ".hxx", ".inc", ".ipp"];

/** 取 link.txt 里 `-o <输出>` 的**原值**(绝对或相对路径;2026-09-14 供 buildPath 用) */
export function parseLinkOutputPath(text: string): string | undefined {
    const toks = text.split(/\s+/).filter((t) => t !== "");
    for (let i = 0; i < toks.length; i++) {
        if (toks[i] === "-o" && i + 1 < toks.length) {
            return toks[i + 1];
        }
    }
    return undefined;
}

/** 取 link.txt 里 `-o <输出>` 的输出名(basename) */
export function parseLinkOutput(text: string): string | undefined {
    const raw = parseLinkOutputPath(text);
    return raw === undefined ? undefined : pbasename(raw);
}

/** link.txt 里的编译单元(.o)列表(原样,通常相对 build 根) */
export function parseLinkObjects(text: string): string[] {
    return text.split(/\s+/).filter((t) => t.endsWith(".o"));
}

/** link.txt 里的链接库(.so basename 与 -l 项) */
export function parseLinkLibs(text: string): string[] {
    const out = new Set<string>();
    for (const t of text.split(/\s+/)) {
        if (t.indexOf(".so") >= 0) {
            out.add(pbasename(t));
        } else if (t.startsWith("-l")) {
            out.add(t);
        }
    }
    return Array.from(out).sort();
}

/** 解析 make 风格 .d 文本 → 依赖列表(处理行续接符) */
export function parseDText(text: string): string[] {
    const flat = text.replace(/\\\r?\n/g, " ");
    const toks = flat.split(/\s+/).filter((t) => t !== "");
    return toks.length <= 1 ? [] : toks.slice(1);
}

/** 单个目标目录 → 目标记录(无 objects 返回 undefined) */
async function readTarget(fs: FsLike, pkg: BuildPackage, linkFile: string): Promise<BuildTarget | undefined> {
    const text = await fs.readText(linkFile);
    if (text === undefined) {
        return undefined;
    }
    const output = parseLinkOutput(text);
    if (output === undefined) {
        // 无 `-o` 的目标(对象库/工具目标):没有可跳转的命令名,不进跳转表
        return undefined;
    }
    const objects = parseLinkObjects(text);
    if (objects.length === 0) {
        return undefined; // 空目标/辅助目标不计
    }
    const sources = new Set<string>();
    const compilePaths = new Set<string>();
    let generated = 0;
    let headers = 0;
    for (const obj of objects) {
        const dPath = (obj.startsWith("/") ? obj : pjoin(pkg.buildDir, obj)) + ".d";
        const dText = await fs.readText(dPath);
        if (dText === undefined) {
            continue;
        }
        for (const dep of parseDText(dText)) {
            const ext = pextname(dep).toLowerCase();
            if (SRC_EXTS.indexOf(ext) >= 0) {
                // 2026-09-14(P0-3):原样收进 compilePaths(= DWARF 里会出现的字符串),不做改写
                compilePaths.add(dep);
                if (dep.startsWith(pkg.buildDir + "/")) {
                    generated++; // build 内生成的源(rosidl/生成器等)
                } else {
                    sources.add(dep);
                }
            } else if (HDR_EXTS.indexOf(ext) >= 0) {
                headers++;
            }
        }
    }
    // 编译期路径集合(P0-3):**只收记录,不判域外存在性**(2026-09-21 域包含性)。
    // compilePaths 指向 src/ 或 build/ 内的生成源;它们"在不在、有没有被移动/改名"不归本域管
    // (逐个 exists 就是**越域取证** —— README §2.2)。原先的本机可访问性循环已移除:
    // 那是调试侧要的判据,应由消费方在本机自查。
    const compilePathsSorted = Array.from(compilePaths).sort();
    // build 内的链接输出落点(P0-1 的别名键:symlink 安装时 install 侧软链解析后即此路径)
    const rawOutputPath = parseLinkOutputPath(text);
    let outputPath: string | undefined;
    if (rawOutputPath !== undefined) {
        if (rawOutputPath.startsWith("/")) {
            outputPath = pnormalize(rawOutputPath);
        } else {
            const targetDirPath = pnormalize(pjoin(linkFile, ".."));
            const inBuild = pjoin(pkg.buildDir, rawOutputPath);
            const inTarget = pjoin(targetDirPath, rawOutputPath);
            outputPath = (await exists(fs, inBuild)) ? inBuild : ((await exists(fs, inTarget)) ? inTarget : inBuild);
        }
    }
    const kind: TargetKind = output.endsWith(".so") || output.endsWith(".a") ? "lib" : "exe";
    return {
        targetDir: pbasename(pjoin(linkFile, "..")) || pbasename(linkFile),
        output,
        outputPath,
        kind,
        objects: objects.length,
        sources: Array.from(sources).sort(),
        compilePaths: compilePathsSorted,
        generatedSources: generated,
        headers,
        linkedLibs: parseLinkLibs(text),
    };
}

/** 抽取一个包的全部目标(排除 *_uninstall.dir 这类卸载目标) */
export async function collectTargets(fs: FsLike, pkg: BuildPackage): Promise<BuildTarget[]> {
    const out: BuildTarget[] = [];
    const files = await walkFiles(fs, pkg.buildDir);
    for (const f of files) {
        if (pbasename(f) !== "link.txt") {
            continue;
        }
        const dirName = pbasename(pjoin(f, ".."));
        if (dirName.endsWith("_uninstall.dir")) {
            continue;
        }
        const target = await readTarget(fs, pkg, f);
        if (target !== undefined) {
            out.push(target);
        }
    }
    out.sort((a, b) => (a.targetDir < b.targetDir ? -1 : a.targetDir > b.targetDir ? 1 : 0));
    return out;
}
