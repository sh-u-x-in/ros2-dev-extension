/**
 * @file scan/python-meta.ts
 * Python 元数据抽取:build/<pkg>/<pkg>.egg-info → console_scripts 与源清单。
 *
 * 为什么 build-only 够用(关键证据):
 *   四象限实测中该文件在**实体象限同样存在**(2026-09-13 只读探测:
 *   `build/ggg`、`build/hi`、`build/iii` 各有 `<pkg>.egg-info`,而当时 install 是实体态;
 *   symlink 象限按《符号链接手册》§2 亦在 build/<pkg>)→ **单一落点,不需要双版本分支**。
 *
 * 跳转路径:
 *   entry_points.txt → 命令名 = 模块:属性 → 模块路径
 *     → SOURCES.txt(包相对源清单,权威)→ join src/<pkg> → 源码文件
 *     (不再需要 realpath/egg-link:源由清单推导,与安装形态无关)
 *
 * 规格来源:`discover/buildonly/scan.py::python_info`。
 * 纯 TS,零依赖,可无头测试。
 */

import { FsLike, isDir } from "../shared/fs/primitives";
import { BuildPackage, PythonMeta } from "../shared/models";
import { pjoin, pnormalize } from "../shared/paths";

/** entry_points.txt 的 console_scripts 行:name = module:attr */
const ENTRY_RE = /^\s*([\w.\-]+)\s*=\s*([^:]+):(\w+)\s*$/;

/** 读一个包的 Python 元数据 */
export async function readPythonMeta(fs: FsLike, pkg: BuildPackage): Promise<PythonMeta> {
    const eggInfoDir = pjoin(pkg.buildDir, pkg.name + ".egg-info");
    const meta: PythonMeta = { entryPoints: {}, sources: [] };
    if (!(await isDir(fs, eggInfoDir))) {
        return meta;
    }
    meta.eggInfoDir = eggInfoDir;
    const epText = await fs.readText(pjoin(eggInfoDir, "entry_points.txt"));
    if (epText !== undefined) {
        for (const raw of epText.split(/\r?\n/)) {
            const m = ENTRY_RE.exec(raw);
            if (m) {
                meta.entryPoints[m[1]] = `${m[2]}:${m[3]}`;
            }
        }
    }
    const soText = await fs.readText(pjoin(eggInfoDir, "SOURCES.txt"));
    if (soText !== undefined) {
        meta.sources = soText
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== "");
    }
    return meta;
}

/**
 * 模块名 → 源码候选(按优先级;不读文件,只做路径推导)。
 * `mod.sub` → 先按 SOURCES.txt 里的 `mod/sub.py` / `mod/sub/__init__.py` 命中,
 * 再退回 ament_python 经典布局 `src/<pkg>/<pkg>/<last>.py` 与 `src/<pkg>/mod/sub.py`。
 */
export function moduleSourceCandidates(
    module: string,
    sources: string[],
    srcRoot: string | undefined,
    pkgName: string
): string[] {
    if (srcRoot === undefined || module === "") {
        return [];
    }
    const rel = module.replace(/\./g, "/");
    const wanted = [rel + ".py", rel + "/__init__.py"];
    const out: string[] = [];
    for (const line of sources) {
        const norm = pnormalize(line.replace(/\\/g, "/"));
        if (wanted.indexOf(norm) >= 0) {
            out.push(pjoin(srcRoot, pkgName, norm));
        }
    }
    const leaf = rel.slice(rel.lastIndexOf("/") + 1);
    out.push(pjoin(srcRoot, pkgName, pkgName, leaf + ".py"));
    out.push(pjoin(srcRoot, pkgName, rel + ".py"));
    out.push(pjoin(srcRoot, pkgName, rel, "__init__.py"));
    return Array.from(new Set(out));
}

/** 把 `module:attr` 拆成模块名与属性 */
export function splitEntry(target: string): { module: string; attr: string } {
    const i = target.indexOf(":");
    return i < 0 ? { module: target, attr: "" } : { module: target.slice(0, i), attr: target.slice(i + 1) };
}

/**
 * develop(colcon symlink-install)模式的模块落点候选(2026-09-14,P0-2)。
 *
 * 依据(VM 实测 /home/ros2/roa2_ws):
 *   `install/<pkg>/lib/python3.x/site-packages/<pkg>.egg-link` 内容 = `<ws>/build/<pkg>`,
 *   且 `build/<pkg>/<pkg>` 是指向 `src/<pkg>/<pkg>` 的软链 → **sys.path 根 = `build/<pkg>`**。
 * 因此模块路径用**完整点分名**:`ggg.jjj` → `build/ggg/ggg/jjj.py`。
 *
 * ⚠️ 与 site-packages 形态的区别:那里根是 `…/site-packages/<pkg>`(已含包目录),
 * 故需剥一层同名前缀(`findModuleInstalledPath`);此处**不剥**。
 */
export function devModuleCandidates(module: string, buildDir: string): string[] {
    if (module === "") {
        return [];
    }
    const rel = module.replace(/\./g, "/");
    return [`${buildDir}/${rel}.py`, `${buildDir}/${rel}/__init__.py`];
}
