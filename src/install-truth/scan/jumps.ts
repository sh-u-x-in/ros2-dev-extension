/**
 * @file scan/jumps.ts
 * 跳转表合成:把 build/ 里的三类记录拼成"命令名 → 源码"。
 *
 * 三类来源(全部取自 build/,四象限固有):
 *   ① CMake 目标(link.txt + .o.d)         → kind=cpp(输出名即命令名)
 *   ② <pkg>.egg-info/entry_points.txt     → kind=console_script(命令名 = 模块:属性)
 *   ③ 安装规则(cmakes 生成的 install 调用) → kind=script(PROGRAMS/脚本入口)
 *
 * 同名冲突按 ①→②→③ 取先(并记 warning);未解析不隐藏,带中性原因与条件分级。
 *
 * 裁切说明:旧版的 install 侧候选扫描(walk lib/<pkg> + X_OK + 软链 readlink + 双版本
 * egg-info 落点)整体删除 —— build-only 后这些"形态/布局适配"不再需要。
 *
 * 纯 TS,零依赖,可无头测试。
 */

import { l10n } from "vscode";

import { FsLike, isFile } from "../shared/fs/primitives";
import { BuildPackage, BuildTarget, JumpEntry, createJumpEntry } from "../shared/models";
import { pbasename, pdirname, pjoin } from "../shared/paths";
import { BuildContext } from "./build-root";
import { collectInstallRules, scriptExecutablesFromRules } from "./install-rules";
import {
    ManifestInfo,
    derivedInstallCandidates,
    findInstalledPath,
    findModuleInstalledPath,
    findSitePackagesDir,
    readManifests,
} from "./manifests";
import { devModuleCandidates, moduleSourceCandidates, readPythonMeta, splitEntry } from "./python-meta";
import { collectTargets } from "./targets";

/** 批量结果(跳转表 + 警告) */
export interface JumpCollection {
    jumps: Map<string, JumpEntry[]>;
    warnings: string[];
}

/** 同名冲突优先级:cpp > console_script > script */
const KIND_PRIORITY: Record<string, number> = { cpp: 0, console_script: 1, script: 2 };

/** 单包跳转条数上限(防止异常包撑爆快照) */
const MAX_PER_PKG = 200;

/** 一条 C++ 目标跳转(2026-09-14 起携带 P0-1/P0-3 的路径信息) */
function cppJump(pkg: string, target: BuildTarget): JumpEntry {
    const entry = createJumpEntry(pkg, target.output, "cpp");
    entry.chain.push(l10n.t("link.txt -> target {0} ({1} compile units)", target.targetDir, target.objects));
    entry.chain.push(
        l10n.t(".o.d chain -> {0} workspace sources / {1} generated sources / {2} headers", target.sources.length, target.generatedSources, target.headers)
    );
    entry.srcPaths = target.sources.slice();
    entry.headers = target.headers;
    entry.linkedLibs = target.linkedLibs;
    // P0-3:编译期源路径(= DWARF 里的字符串)→ 调试侧据此推 sourceFileMap。
    // 2026-09-21(域包含性):**只给记录,不判这些路径在本机是否存在** —— 域外存在性不归本域管。
    entry.compilePaths = target.compilePaths.slice();
    if (target.outputPath !== undefined) {
        // P0-1 别名键:symlink 安装下 install 侧软链解析后即 build 内此路径(/proc/<pid>/exe 读到的形态)
        entry.buildPath = target.outputPath;
    }
    if (target.compilePaths.length > 0) {
        entry.chain.push(l10n.t("{0} compile-time source paths (reported as recorded; consumer checks local accessibility)", target.compilePaths.length));
    }
    if (target.sources.length === 0) {
        entry.unresolved = true;
        entry.unresolvedReason = l10n.t("No workspace sources for target (.o.d missing, or all sources generated inside build/)");
        entry.tier = "C";
        entry.tierNote = l10n.t("Conditional: requires build/<pkg>/CMakeFiles/<target>.dir/*.o.d to exist");
        return entry;
    }
    entry.tier = "L";
    entry.tierNote = l10n.t("Inherent: link.txt + .o.d both under build/ (same answer in all quadrants)");
    return entry;
}

/** 一条 console_scripts 跳转(egg-info → 模块 → 源) */
async function consoleJump(
    fs: FsLike,
    ctx: BuildContext,
    pkg: BuildPackage,
    name: string,
    target: string,
    sources: string[],
    manifests: ManifestInfo
): Promise<JumpEntry> {
    const entry = createJumpEntry(pkg.name, name, "console_script");
    const { module, attr } = splitEntry(target);
    entry.entryTarget = target; // 结构化入口目标(`module:attr`),供侧边栏 lib 区显示 `:main`
    entry.chain.push(`egg-info/entry_points.txt → ${name} = ${module}${attr ? ":" + attr : ""}`);
    // P0-2:Python 侧落点。清单能核对的先取清单(ament_cmake_python / install(PROGRAMS));
    // ament_python **没有清单** → 走 develop 语义(build/<pkg> 为 sys.path 根,VM 实测 egg-link 指向此处)
    // 与布局候选(install 落点在 step ④ 汇总,并如实标注"未核对")。
    const scriptPath = findInstalledPath(manifests.paths, pkg.name, name);
    const sitePackagesDir = findSitePackagesDir(manifests.paths, pkg.name);
    const moduleFile = findModuleInstalledPath(manifests.paths, pkg.name, module);
    let devModuleFile: string | undefined;
    for (const c of devModuleCandidates(module, pkg.buildDir)) {
        if (await isFile(fs, c)) {
            devModuleFile = c;
            break;
        }
    }
    const verified = scriptPath !== undefined || moduleFile !== undefined;
    entry.pythonInstall = {
        scriptPath,
        sitePackagesDir,
        moduleFile,
        devDir: pkg.buildDir,
        devModuleFile,
        verified,
    };
    entry.chain.push(
        l10n.t("Python landing ({0}): ", verified ? l10n.t("manifest-verified") : l10n.t("derived: ament_python has no manifest")) +
            l10n.t("shell={0} / site-packages={1} / ", scriptPath ?? l10n.t("(to derive)"), sitePackagesDir ?? l10n.t("(no hit)")) +
            l10n.t("manifest modules={0} / develop modules={1}", moduleFile ?? l10n.t("(no hit)"), devModuleFile ?? l10n.t("(no hit)"))
    );
    const candidates = moduleSourceCandidates(module, sources, ctx.srcRoot, pkg.name);
    if (candidates.length === 0) {
        entry.unresolved = true;
        entry.unresolvedReason = l10n.t("Cannot derive source (module name empty)");
        entry.tier = "C";
        entry.tierNote = l10n.t("Conditional: entry_points gave no derivable module name");
        return entry;
    }
    // 2026-09-21(域包含性):**不再去 src 里确认候选是否存在**。
    // 那是越域取证(README §2.2),而且"以确认换置信度"会让本域结论随 src 域漂移。
    // 现在一律给推导首选并如实标 derived(条件分级 C)—— 宁可置信度低,不可越域取证。
    entry.srcPaths = [candidates[0]];
    entry.chain.push(l10n.t("module -> {0} (derived from SOURCES.txt; existence of the target file is not this domain's concern)", candidates[0]));
    entry.tier = "C";
    entry.tierNote = l10n.t("Conditional: landing derived from records (SOURCES.txt); this domain does not verify out-of-domain existence");
    return entry;
}

/** 一条安装规则脚本跳转 */
function scriptJump(
    pkg: string,
    name: string,
    source: string,
    dest: string,
    from: string,
    manifests: ManifestInfo
): JumpEntry {
    const entry = createJumpEntry(pkg, name, "script");
    entry.srcPaths = [source];
    entry.chain.push(l10n.t("install rule ({0}) -> {1}/{2}", from, dest, name));
    entry.chain.push(l10n.t("source -> {0} (absolute path within rule)", source));
    // P0-2:脚本入口的安装落点。`.py` 源按 Python 语义给(未核对时由 step ④ 走布局候选);
    // 非 .py 脚本只记 chain(它们不是调试注入目标,且清单/安装规则已能覆盖)。
    const sourceIsPython = source.endsWith(".py");
    const scriptPath = findInstalledPath(manifests.paths, pkg, name);
    if (sourceIsPython) {
        entry.pythonInstall = { scriptPath, verified: scriptPath !== undefined };
        entry.chain.push(
            scriptPath === undefined ? l10n.t("Python shell script not manifest-verified (to be derived from layout candidates)") : l10n.t("install landing -> {0}", scriptPath)
        );
    } else if (scriptPath !== undefined) {
        entry.chain.push(l10n.t("install landing -> {0}", scriptPath));
    }
    entry.tier = "L";
    entry.tierNote = l10n.t("Inherent: install rules written by CMake under build/ (both real file(INSTALL) and symlink forms recognized)");
    return entry;
}

/** 扫描全部包 → 跳转表 */
export async function collectJumps(
    fs: FsLike,
    ctx: BuildContext,
    packages: Map<string, BuildPackage>,
    opts?: { includeUninstalled?: boolean }
): Promise<JumpCollection> {
    const jumps = new Map<string, JumpEntry[]>();
    const warnings: string[] = [];
    // P0-2:清单需在合成条目之前读到(console/script 条目要据此填 pythonInstall)
    const manifestsByPkg = new Map<string, ManifestInfo>();
    for (const pkg of Array.from(packages.values())) {
        manifestsByPkg.set(pkg.name, await readManifests(fs, pkg));
    }

    for (const pkg of Array.from(packages.values())) {
        const byName = new Map<string, JumpEntry>();
        const priority = new Map<string, number>();
        const manifests = manifestsByPkg.get(pkg.name) as ManifestInfo;
        const add = (entry: JumpEntry): void => {
            const prio = KIND_PRIORITY[entry.kind] ?? 9;
            const existing = byName.get(entry.name);
            if (existing !== undefined) {
                const prev = priority.get(entry.name) ?? 9;
                if (prev <= prio) {
                    warnings.push(
                        l10n.t("{0}: command name {1} conflict; keeping {2} (dropping {3})", pkg.name, entry.name, existing.kind, entry.kind)
                    );
                    return;
                }
                warnings.push(l10n.t("{0}: command name {1} conflict; overriding {2} with {3}", pkg.name, entry.name, entry.kind, existing.kind));
            }
            byName.set(entry.name, entry);
            priority.set(entry.name, prio);
        };

        try {
            // ① CMake 目标(只取可执行;库不是"可执行跳转"的目标)
            for (const target of await collectTargets(fs, pkg)) {
                if (target.kind === "exe") {
                    add(cppJump(pkg.name, target));
                }
            }
            // ② console_scripts
            const meta = await readPythonMeta(fs, pkg);
            for (const name of Object.keys(meta.entryPoints).sort()) {
                add(await consoleJump(fs, ctx, pkg, name, meta.entryPoints[name], meta.sources, manifests));
            }
            // ③ 安装规则里的脚本入口
            const rules = await collectInstallRules(fs, pkg);
            for (const s of scriptExecutablesFromRules(pkg.name, rules)) {
                add(scriptJump(pkg.name, s.name, s.source, s.dest, s.from, manifests));
            }
        } catch (err) {
            warnings.push(l10n.t("{0}: parse error skipped ({1})", pkg.name, err instanceof Error ? err.message : String(err)));
        }

        // ④ 安装清单核对:build 里编译出的目标 ≠ 真正装出去的可执行
        //    (实测反例:test_adder/test_entries 会编译但不安装;rrr.py/py_listener.py 只由安装规则装出)
        //    2026-09-14:同时汇总 installPaths(P0-1 的按路径反查键)。install 基座 = build 的兄弟目录。
        const installBase = pjoin(pdirname(ctx.buildRoot), "install");
        let list = Array.from(byName.values());
        for (const e of list) {
            const extras: string[] = [];
            if (e.pythonInstall !== undefined) {
                const pi = e.pythonInstall;
                if (pi.scriptPath !== undefined) {
                    extras.push(pi.scriptPath);
                }
                if (pi.moduleFile !== undefined) {
                    extras.push(pi.moduleFile);
                }
                if (pi.sitePackagesDir !== undefined) {
                    extras.push(pi.sitePackagesDir);
                }
                if (pi.devDir !== undefined) {
                    extras.push(pi.devDir);
                }
                if (pi.devModuleFile !== undefined) {
                    extras.push(pi.devModuleFile);
                }
                // 未经清单核对(ament_python 无清单)→ 按布局候选兜底,并如实标注
                if (pi.scriptPath === undefined && !pi.verified) {
                    const derived = derivedInstallCandidates(installBase, pkg.name, e.name);
                    for (const d of derived) {
                        extras.push(d);
                    }
                    pi.scriptPath = derived[0];
                    e.chain.push(l10n.t("Python shell script landing derived from layout candidates (unverified): {0}", derived.join(" / ")));
                }
            }
            if (!manifests.hasAny) {
                e.installed = true; // 无清单可核对:不据此排除,但如实标注
                e.chain.push(l10n.t("No install manifest (unverified)"));
                e.installPaths = Array.from(new Set(extras)).sort();
                continue;
            }
            const hit = findInstalledPath(manifests.paths, pkg.name, e.name);
            e.installed = hit !== undefined;
            e.installPath = hit === undefined ? "" : hit;
            e.installPaths = Array.from(new Set(hit === undefined ? extras : [hit, ...extras])).sort();
            e.chain.push(
                hit === undefined
                    ? l10n.t("Install manifest miss ({0})", manifests.sources.join("+"))
                    : l10n.t("Install manifest hit -> {0}", hit)
            );
        }
        const dropped = list.filter((e) => !e.installed).map((e) => e.name);
        if (dropped.length > 0 && !(opts?.includeUninstalled ?? false)) {
            warnings.push(l10n.t("{0}: built but not installed; excluded per manifest: {1}", pkg.name, dropped.join(", ")));
            list = list.filter((e) => e.installed);
        }
        list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        jumps.set(pkg.name, list.slice(0, MAX_PER_PKG));
        if (list.length > MAX_PER_PKG) {
            warnings.push(l10n.t("{0}: more than {1} jump entries; truncated", pkg.name, MAX_PER_PKG));
        }
    }
    return { jumps, warnings };
}

/** 便捷:单包跳转名 → 源(供临时查询/测试) */
export async function jumpSourceOf(
    fs: FsLike,
    ctx: BuildContext,
    pkg: BuildPackage,
    name: string
): Promise<string[] | undefined> {
    const pkgMap = new Map<string, BuildPackage>([[pkg.name, pkg]]);
    const { jumps } = await collectJumps(fs, ctx, pkgMap);
    const list = jumps.get(pkg.name) ?? [];
    const hit = list.filter((e) => e.name === name)[0];
    return hit === undefined ? undefined : hit.srcPaths;
}

/** 便于日志:命令名 → (包, 类型) */
export function summarizeJump(entry: JumpEntry): string {
    const src = entry.srcPaths.length > 0 ? entry.srcPaths[0] : l10n.t("(unresolved)");
    return `${entry.pkg}/${entry.name} [${entry.kind}] → ${src}`;
}

/** 便捷:源文件 basename(展示用) */
export function sourceBasename(p: string): string {
    return pbasename(p);
}
