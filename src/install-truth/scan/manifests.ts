/**
 * @file scan/manifests.ts
 * 安装清单读取:`install_manifest.txt`(实体安装)与 `symlink_install_manifest.txt`(symlink 安装)。
 *
 * 为什么需要它们(真跑反例驱动,2026-09-14):
 *   build 域只给"编译出的目标",不等于"真正装出去的可执行":
 *     · 测试目标(test_adder/test_entries)会编译但**不安装** → 不该进跳转表;
 *     · ament_cmake_python 的脚本(rrr.py/py_listener.py)由 `install(PROGRAMS)`/
 *       `ament_cmake_symlink_install_programs` 安装 → 需要安装规则 + 清单双重确认。
 *   两个清单都在 build/<pkg>/ 下(仍是 build-only),且**两者互补**:
 *     实体态写 install_manifest.txt;symlink 态写 symlink_install_manifest.txt
 *     (实测 fff:install_manifest.txt 0 行、symlink_install_manifest.txt 25 行)→ 取并集。
 *   ⚠️ **并集的代价(2026-09-26 实测)**:切换安装形态后,被弃用形态的 manifest 残留不清,
 *     会把上一形态的记录混进并集 → 必须配合新鲜度守卫(见 FRESHNESS_GRACE_MS),不能只信记录。
 *
 * 纯 TS,零依赖,可无头测试。
 */

import { FsLike } from "../shared/fs/primitives";
import { BuildPackage } from "../shared/models";
import { pjoin } from "../shared/paths";

/**
 * 可能存在的安装记录文件名(并集读取)。
 *
 * 2026-09-21 加入 `install.log`:它是 `setuptools` 的**安装目标记录**(逐行一个绝对落点),
 * 也是 `ament_python` 的**唯一**清单替代品 —— 那类包不产 `install_manifest.txt`。
 * ⚠️ 但它**模式相关**:只有实体安装(`setup.py install --record`)才写,
 * develop/symlink 构建**不写** → 会**残留**自上一次实体构建。故读取时必须过 §4 的陈旧守卫。
 */
export const MANIFEST_FILES = ["install_manifest.txt", "symlink_install_manifest.txt", "install.log"];

/**
 * 陈旧守卫的**宽限差**(毫秒;2026-09-25 第五批,用户裁定"build 可以是数据来源但不能是唯一,必须加 install 查询筛选"):
 *
 * **三份记录统一过守卫**(原口径只守 `install.log`,豁免理由是"两份 manifest 由 CMake 每次安装重写"——
 * 该理由只对**当前安装形态**的那份成立):**切换安装形态(符号 ↔ 实体)时,被弃用形态的 manifest
 * 既不会被清也不会被重写**(2026-09-26 实测 p10_mix_deps_std:`symlink_install_manifest.txt:46`
 * 比本次构建基线早 10 分钟,残留上一形态的记录 → 并集混入 → 误报 manifest-only)。
 *
 * 为什么不能直接用严格 `<` 基线:正常同形态构建里,清单写在 install 阶段、`colcon_build.rc`
 * 在收尾时写 —— 清单 mtime 比基线**早亚秒级**(实测 0.1s),严格 `<` 会误杀当前记录。
 * 故取 **5s 宽限差**:早于基线超过宽限才判陈旧(形态切换的残留是分钟级,稳定区分)。
 */
export const FRESHNESS_GRACE_MS = 5000;

/** 一个包的安装清单读取结果 */
export interface ManifestInfo {
    /** 清单里的全部安装落点(绝对路径;并集去重) */
    paths: string[];
    /** 实际读到的清单文件名 */
    sources: string[];
    /** 是否读到至少一个清单(未读到 = 无法核对,调用方应"不据此排除") */
    hasAny: boolean;
    /** 因**陈旧**(早于本次构建基线超过宽限差)而被丢弃的记录文件名 */
    skipped: string[];
    /** 绝对路径 → 来源记录文件名(2026-09-25 第五批:供悬浮栏"内容来源"可逆搜索;多来源取最后写入者) */
    origin: Map<string, string>;
}

/**
 * 本次构建的**新鲜度基线**(epoch 毫秒;取不到 → undefined)。
 *
 * 取 `colcon_build.rc` 与 `<pkg>.egg-info/SOURCES.txt` 这两个**每次构建都会写**的记录里
 * **较早的那个**(README §4.1):安装记录写在两者之间,所以"不早于基线"即"属于本次构建"。
 * 两处都取不到(纯手搓夹具)→ undefined,调用方退化为"不做守卫"。
 */
export async function freshnessBaselineMs(fs: FsLike, pkg: BuildPackage): Promise<number | undefined> {
    const marks: number[] = [];
    for (const rel of ["colcon_build.rc", `${pkg.name}.egg-info/SOURCES.txt`]) {
        const st = await fs.stat(pjoin(pkg.buildDir, rel));
        if (st !== undefined && st.mtimeMs > 0) {
            marks.push(st.mtimeMs);
        }
    }
    return marks.length === 0 ? undefined : Math.min.apply(null, marks);
}

/** 读取一个包的安装清单(并集;**三份记录统一过陈旧守卫**,见 FRESHNESS_GRACE_MS) */
export async function readManifests(fs: FsLike, pkg: BuildPackage): Promise<ManifestInfo> {
    const paths = new Set<string>();
    const sources: string[] = [];
    const skipped: string[] = [];
    const origin = new Map<string, string>();
    const baseline = await freshnessBaselineMs(fs, pkg);
    for (const fn of MANIFEST_FILES) {
        const p = pjoin(pkg.buildDir, fn);
        const text = await fs.readText(p);
        if (text === undefined) {
            continue;
        }
        if (baseline !== undefined) {
            const st = await fs.stat(p);
            if (st !== undefined && st.mtimeMs > 0 && st.mtimeMs < baseline - FRESHNESS_GRACE_MS) {
                skipped.push(fn); // 陈旧残留:早于基线超过宽限差(多半是切换安装形态后的遗留)→ 不采信(README §4)
                continue;
            }
        }
        sources.push(fn);
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (line !== "") {
                paths.add(line);
                origin.set(line, fn);
            }
        }
    }
    return { paths: Array.from(paths).sort(), sources, hasAny: sources.length > 0, skipped, origin };
}

/**
 * 在清单里找某个可执行的安装落点。
 * 覆盖三种落点形态(与布局无关,只比后缀):
 *   isolated/merged 常规: <prefix>/lib/<pkg>/<name>
 *   纯 cmake 装到 lib 根:  <prefix>/lib/<name>
 *   装到 bin:              <prefix>/bin/<name>
 */
export function findInstalledPath(paths: string[], pkg: string, name: string): string | undefined {
    const suffixes = [`/lib/${pkg}/${name}`, `/lib/${name}`, `/bin/${name}`];
    for (const s of suffixes) {
        for (const p of paths) {
            if (p.endsWith(s)) {
                return p;
            }
        }
    }
    return undefined;
}

/** 是否已安装(清单为空 → false,调用方需先看 hasAny) */
export function isInstalled(paths: string[], pkg: string, name: string): boolean {
    return findInstalledPath(paths, pkg, name) !== undefined;
}

/**
 * 清单里所有以给定后缀结尾的落点(去重排序;P0-1 的路径索引与 P0-2 的 Python 落点用)。
 */
export function findInstalledPathsBySuffix(paths: string[], suffixes: string[]): string[] {
    const out = new Set<string>();
    for (const s of suffixes) {
        for (const p of paths) {
            if (p.endsWith(s)) {
                out.add(p);
            }
        }
    }
    return Array.from(out).sort();
}

/**
 * 无清单时的安装落点**候选推导**(2026-09-14,P0-1/P0-2 兜底)。
 *
 * 动机(VM 实测):**ament_python 包没有安装清单**(setuptools 不产 install_manifest.txt),
 * 但其安装落点是**布局固定**的 —— 与 `findInstalledPath` 的后缀口径一致,两种布局各三种:
 *   isolated: `<base>/<pkg>/lib/<pkg>/<name>`、`<base>/<pkg>/lib/<name>`、`<base>/<pkg>/bin/<name>`
 *   merged:   `<base>/lib/<pkg>/<name>`、`<base>/lib/<name>`、`<base>/bin/<name>`
 * 全部登记为**别名键**是安全的:只有该路径真的被运行时才会命中(命中即说明布局正是这种),
 * 而漏登记会让 Python 节点彻底无法按路径反查。
 * ⚠️ 候选**未经清单核对** —— 调用方必须在 chain 里如实标注(不得当成"已核对")。
 */
export function derivedInstallCandidates(installBase: string, pkg: string, name: string): string[] {
    const base = installBase.endsWith("/") ? installBase.slice(0, -1) : installBase;
    return [
        `${base}/${pkg}/lib/${pkg}/${name}`,
        `${base}/${pkg}/lib/${name}`,
        `${base}/${pkg}/bin/${name}`,
        `${base}/lib/${pkg}/${name}`,
        `${base}/lib/${name}`,
        `${base}/bin/${name}`,
    ];
}

/**
 * Python 站点目录下的包目录(P0-2;2026-09-21 扩到两种落点):
 *   ament_python        → `<prefix>/lib/python3.x/site-packages/<pkg>/`
 *   ament_cmake_python  → `<prefix>/local/lib/python3.x/dist-packages/<pkg>/`(实测 p10/p12/p13)
 * 找不到 → undefined(纯 C++ 包,或 Python 模块未安装)。
 */
export function findSitePackagesDir(paths: string[], pkg: string): string | undefined {
    const markers = [`/site-packages/${pkg}/`, `/dist-packages/${pkg}/`];
    let best: string | undefined;
    for (const p of paths) {
        for (const marker of markers) {
            const i = p.indexOf(marker);
            if (i < 0) {
                continue;
            }
            const dir = p.slice(0, i + marker.length - 1);
            if (best === undefined || dir.length < best.length) {
                best = dir;
            }
        }
    }
    return best;
}

/**
 * Python 模块文件的安装落点(P0-2):`module`(`pkg.mod` 或 `mod`)→ 清单里的
 * `<sitePackagesDir>/<rel>.py` 或 `<sitePackagesDir>/<rel>/__init__.py`。
 * 说明:console_scripts 的模块名常带包前缀(`py.sss`),而 sitePackagesDir 已含 `<pkg>`,
 * 故先剥掉一层同名前缀,避免拼成 `.../site-packages/py/py/sss.py`。
 */
export function findModuleInstalledPath(paths: string[], pkg: string, module: string): string | undefined {
    const dir = findSitePackagesDir(paths, pkg);
    if (dir === undefined || module === "") {
        return undefined;
    }
    const rel0 = module.replace(/\./g, "/");
    const prefix = pkg + "/";
    const rel = rel0.startsWith(prefix) ? rel0.slice(prefix.length) : rel0;
    for (const wanted of [`${dir}/${rel}.py`, `${dir}/${rel}/__init__.py`]) {
        for (const p of paths) {
            if (p === wanted) {
                return p;
            }
        }
    }
    return undefined;
}
