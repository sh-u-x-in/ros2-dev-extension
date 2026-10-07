/**
 * @file shared/models.ts
 * build-only 真值域数据模型(**裁切版**:只服务"可执行 → 源码"跳转)。
 *
 * 裁切依据(用户裁定 2026-09-13):当前需求 = **可执行文件跳转**。
 * 四象限报告(`discover/buildonly-四象限报告.md`)证明:目标/构成源这块信息在
 * {isolated, merged} × {entity, symlink} 四象限**完全固有**
 * (1222 个叶子字段中 1080 固有,而 targets/sources 全部落在固有侧)
 * → **只读 `build/` 即得**,不需要 install/,也不关心构建类型与安装形态。
 *
 * 规格来源:`discover/buildonly/scan.py`(唯一输入 build/ 的抽取器)。
 * 本模型只保留跳转所需；env_hooks / cache / commands / tests / ament_index /
 * manifests 等区块留在 Python 原型当路线图,按需再移植。
 *
 * 纯 TS,零依赖,可无头测试。
 */

/** build 侧推断的包类型(构建类型不写死,由 traits 判定) */

import { l10n } from 'vscode'; // 2026-10-04 i18n 期2:TIER 标签用户可见(tooltip 层注)
export type BuildTypeName = "ament_python" | "ament_cmake" | "cmake" | "python-or-unknown";

/** 包特征(可叠加;未知类型也照样输出通用记录) */
export interface BuildTraits {
    /** 有 CMakeCache.txt(CMake 系) */
    cmake: boolean;
    /** 顶层有 ament_cmake* 目录 */
    amentCmake: boolean;
    /** 有 <pkg>.egg-info(setuptools 系) */
    python: boolean;
    /** 顶层有 rosidl* 目录(接口包生成) */
    rosidl: boolean;
    /** colcon 落痕(colcon_build.rc / colcon_command_prefix_*) */
    colcon: boolean;
}

/** build 域包(根键 = build/<name> 目录名) */
export interface BuildPackage {
    /** 包名(= build/<name>,亦为 install/<name> / ros2 run 第一参数) */
    name: string;
    /** build/<name> 绝对路径 */
    buildDir: string;
    /** 由 traits 推断的类型 */
    type: BuildTypeName;
    /** 特征 */
    traits: BuildTraits;
}

/** 目标类型:库 / 可执行(由 link.txt 的 `-o` 输出名是否 .so 判定) */
export type TargetKind = "exe" | "lib";

/** 一个编译目标(来自 CMakeFiles/<target>.dir/link.txt + *.o.d) */
export interface BuildTarget {
    /** 目标目录名(如 `talker.dir`) */
    targetDir: string;
    /** 链接输出名(basename;`-o` 后参数) */
    output: string;
    /** 链接输出**完整路径**(link.txt 的 `-o` 原值;相对值按 build 内存在性判定;缺失为 undefined) */
    outputPath?: string;
    /** 库 / 可执行 */
    kind: TargetKind;
    /** 编译单元(.o)个数 */
    objects: number;
    /** 工作区源(绝对路径;不在 build 内者) */
    sources: string[];
    /**
     * 编译期源路径集合(2026-09-14,P0-3):`.o.d` 里**全部**源扩展名依赖的**原样字符串**
     * (含 build 内生成源)。语义 = "编译器当时看到的路径",正是 DWARF 行表里会出现的那些字符串
     * → 供调试侧推导 `sourceFileMap`。
     *
     * 2026-09-21(域包含性):**只给记录,不判域外存在性** —— 这些路径所指文件在不在、
     * 有没有被移动/改名,不归本域管(README §2.2)。原先的 `compilePathsExistLocally`
     * 字段已删除;"本机可访问性"由消费方在本机自查。
     */
    compilePaths: string[];
    /** 生成源个数(build 内生成的 .cpp/.c) */
    generatedSources: number;
    /** 头文件计数(.o.d 内) */
    headers: number;
    /** 链接库(.so basename 或 -l 项) */
    linkedLibs: string[];
}

/** Python 元数据(build/<pkg>/<pkg>.egg-info) */
export interface PythonMeta {
    /** egg-info 目录(不存在为 undefined) */
    eggInfoDir?: string;
    /** console_scripts:命令名 → 模块:属性 */
    entryPoints: Record<string, string>;
    /** SOURCES.txt 的包相对文件清单(源分布权威名单) */
    sources: string[];
}

/** 安装规则(cmakes 生成:源 → 目标) */
export interface InstallRule {
    kind: "FILES" | "DIRECTORY";
    sources: string[];
    dest: string;
    /** 规则来源文件名(cmake_install.cmake / ament_cmake_symlink_install.cmake) */
    from: string;
}

/** 跳转条目类型 */
export type JumpKind = "cpp" | "console_script" | "script";

/**
 * Python 安装侧落点(2026-09-14,P0-2):
 * 节点运行期加载的是 **site-packages / develop 目录下的模块文件**,不是入口壳脚本 ——
 * debugpy 的 `pathMappings` 需要成对的 `{本地 src 包目录, 远端运行期目录}`,
 * 故把各处分别给出。
 *
 * 两种真实形态(VM 实测 /home/ros2/roa2_ws):
 *   · **ament_python(colcon symlink-install)**:`install/<pkg>/lib/<pkg>/<name>` 是**真实生成的壳脚本**
 *     (EASY-INSTALL-ENTRY-SCRIPT);`install/<pkg>/lib/python3.x/site-packages/<pkg>.egg-link`
 *     → `build/<pkg>`,而 `build/<pkg>/<pkg>` 是指向 `src/<pkg>/<pkg>` 的软链
 *     → 模块实际从 **build/<pkg>** 加载(devDir/devModuleFile);
 *     ⚠️ 这类包**没有安装清单**(setuptools 不产 install_manifest.txt),故落点按布局推导,`verified=false`。
 *   · **ament_cmake_python / install(PROGRAMS)**:由 CMake 安装 → 有清单 → 落点可核对,`verified=true`。
 */
export interface PythonInstall {
    /** 入口壳脚本落点(如 <prefix>/lib/<pkg>/<name>) */
    scriptPath?: string;
    /** site-packages 下的包目录(如 <prefix>/lib/python3.x/site-packages/<pkg>;仅清单可给) */
    sitePackagesDir?: string;
    /** 清单核对到的模块文件(如 …/site-packages/<pkg>/<mod>.py) */
    moduleFile?: string;
    /** develop(symlink-install)模式的 sys.path 根:`build/<pkg>`(egg-link 指向处) */
    devDir?: string;
    /** develop 模式下节点实际加载的模块文件:`build/<pkg>/<mod>.py`(通常是指向 src 的软链) */
    devModuleFile?: string;
    /** 上述落点是否经**安装清单核对**(false = 按布局/develop 语义推导,链上已如实标注) */
    verified: boolean;
}

/**
 * 结论分级(沿用全库口径):
 *   L = 交集保证(四象限同解,仅需 build/) ; C = 条件结论(条件入 tierNote)
 *   U = 并集上限 ; X = 不计(需执行)
 */
export type Tier = "L" | "C" | "U" | "X";

/** 分级中文标签(UI/日志复用) */
export const TIER_LABEL: Record<Tier, string> = {
    L: l10n.t("Inherent (same answer in all quadrants; only build/ needed)"),
    C: l10n.t("Conditional conclusion (see conditions)"),
    U: l10n.t("Union upper bound"),
    X: l10n.t("Not counted (requires execution)"),
};

/** 一条"可执行 → 源码"跳转记录 */
export interface JumpEntry {
    /** 归属包 */
    pkg: string;
    /** 命令名(ros2 run 第二参数;C++ = 目标输出名,Python = entry_points 名 / 脚本名) */
    name: string;
    /** 跳转类型 */
    kind: JumpKind;
    /** 主源码候选(按优先级;sources 推导,已尽量确认存在) */
    srcPaths: string[];
    /** 头文件计数(C++ 才有) */
    headers: number;
    /** 链接库(C++ 才有) */
    linkedLibs: string[];
    /** 判定链(人类可读,按序) */
    chain: string[];
    /** 分级 */
    tier: Tier;
    /** 分级条件说明 */
    tierNote: string;
    /** 是否未解析 */
    unresolved: boolean;
    /** 未解析原因(中性文案) */
    unresolvedReason: string;
    /**
     * 是否已安装(build 里编译出的目标 ≠ 真正装出去的可执行):
     * 由 `install_manifest.txt` ∪ `symlink_install_manifest.txt` 核对;
     * 无清单可核对时记 true(不据此排除)并在 chain 里标注"未核对"。
     */
    installed: boolean;
    /** 安装落点(清单命中时给出绝对路径;否则空串) */
    installPath: string;
    /**
     * 安装侧全部落点(2026-09-14,P0-1/P0-2):入口 + Python 模块文件等,**供按路径反查**。
     * 与 `installPath` 的关系:`installPath` 仍表示"入口那一个"(兼容既有消费方),
     * `installPaths` 是并集(含 Python 侧),索引 `byInstallPath` 用后者。
     */
    installPaths?: string[];
    /** C++:链接输出在 build 内的落点(link.txt 的 `-o` 原值) */
    buildPath?: string;
    /** Python 安装侧三处落点(P0-2) */
    pythonInstall?: PythonInstall;
    /**
     * console_script 的入口目标(`module:attr`,如 `iii.sub.helper:main`)。
     *
     * 2026-09-21 加入:侧边栏 lib 区的源箭头要显示成 `…/helper.py:main`
     * (见 `手工重设计/侧边栏提案.md` 的新骨架),故入口目标必须是**结构化字段**,
     * 不能只留在 `chain` 的中文文案里。
     */
    entryTarget?: string;
    /** C++:编译期源路径集合(= DWARF 里的路径字符串;P0-3)。**只给记录,不判存在性** */
    compilePaths?: string[];
}

/**
 * 显示区(侧边栏口径,2026-09-21):`lib` / `import` / `share` 三区 + `include`。
 *
 * 分区只看**落点形状**(不含任何"应该有什么"的判断):
 *   lib     = `<prefix>/lib/<pkg>/` 与 `<prefix>/bin/` 下的入口(库文件也在内,用 `library` 标记)
 *   import  = `<prefix>/lib/python3.x/site-packages/<pkg>/` 或 `<prefix>/local/lib/python3.x/dist-packages/<pkg>/`
 *   share   = `<prefix>/share/<pkg>/`
 *   include = `<prefix>/include/<pkg>/`
 */
export type AreaName = "lib" | "import" | "share" | "include";

/**
 * 一条"装出来的东西":**install 侧观察** + **build 侧记录对账**(README §2)。
 *
 * 注意 truth 层的纪律:这里给的是**全集 + 标记**,不做过滤 ——
 * 库文件、生成物、扩大出来的文件都照实列出,是否隐藏由消费方决定(README §2.1 第 3 条)。
 */
export interface AreaFile {
    /** 归属包 */
    pkg: string;
    /** 显示区 */
    area: AreaName;
    /** 区内相对路径(展示用;lib 区 = 入口名,其余 = 包目录内的相对路径) */
    relPath: string;
    /** 绝对落点(install 侧观察到的访问路径) */
    installPath: string;
    /** 由记录判定:库文件(`.so` / `.a`);不依赖 +x —— 标记而非过滤 */
    library: boolean;
    /**
     * 形态(2026-09-21 甲-1):`lstat` 判定该落点本身是软链。
     * 软链就是**安装机制本身**(`--symlink-install`),不是偶然的文件属性。
     */
    link?: boolean;
    /** 软链目标(**原样字符串**,可能相对) */
    linkTarget?: string;
    /**
     * 软链目标归属(由目标前缀判定)—— 这是"扩大"与"要不要重装"的机器可读版本:
     *   `src`     → 源码直通(改源码立即生效,无需重装)
     *   `build`   → 构建产物(重新构建后可能失效 = 悬空链的来源)
     *   `outside` → 工作区外(如 `/opt/ros/...`),**不可**用于源码映射
     */
    linkDomain?: "src" | "build" | "outside";
    /** 软链目标不可访问(悬空:目标被删/重建换位)—— 这类**不得**当成可用入口 */
    dangling?: boolean;
    /**
     * 该落点是**经哪条软链进来的**(最近的上游**目录**软链)。
     *
     * 为什么需要它:软链目录里的**子文件自身不是软链** —— "扩大"是**上游目录**的事实。
     * `install/…/site-packages/<pkg> -> build/<pkg>/<pkg>` 一旦成立,整棵子树都来自 build,
     * 而每个文件的 `link` 都是 false。这条就是"扩大成因"的机器可读版本。
     */
    viaLinkPath?: string;
    /** 上游软链的目标归属(与 `linkDomain` 同口径,但指的是"从哪进来的") */
    viaLinkDomain?: "src" | "build" | "outside";
    /** 能不能直接执行:实体看自身模式位,软链**看目标**(链自身 `lrwxrwxrwx` 无意义) */
    executable?: boolean;
    /** 打包/构建生成的中间物(hook / environment / cmake / package.* / __pycache__ / egg-info / build 内生成源)—— 标记而非过滤 */
    generated: boolean;
    /** 源落点(由记录推出;**只拼字符串,不判存在性** —— README §2.2) */
    sourcePath?: string;
    /** `sourcePath` 从哪条记录得来 */
    sourceEvidence?: "jump-record" | "install-rule" | "python-rootmap";
    /**
     * **内容来源引用**(2026-09-25 第五批,用户裁定"悬浮消息栏显示内容来源,让用户可逆搜索"):
     *  · `安装规则 cmake_install.cmake` / `安装规则 ament_cmake_symlink_install.cmake` —— 可到 build/<pkg>/ 下查证;
     *  · `安装记录 <清单文件名>` —— manifest-only 反向行的来源(哪份记录还留着它);
     *  · `<pkg>.egg-info 根映射` / `构建记录(link.txt/.o.d)`。
     */
    sourceRef?: string;
    /**
     * 对账状态(**观察** vs **记录**):
     *   `confirmed`     = install 侧看到,且 build 侧清单/规则也记录了它
     *   `observed`      = 只在 install 侧看到 —— **直通模式"扩大"出来的文件正是这一档**(如实保留)
     *   `manifest-only` = 只在记录里有、install 侧没看到(被删 / 布局不符)
     */
    agreement: "confirmed" | "observed" | "manifest-only";
}

/** 一个包的安装内容解算结果(四区合一数组;空数组 = 该包确实什么都没装出来) */
export interface PackageAreas {
    pkg: string;
    /** 该包的安装前缀(isolated = `install/<pkg>`;merged = `install`) */
    prefix: string;
    /** 布局判定结果(读 `install/.colcon_install_layout`;缺失时按目录观察判定) */
    layout: "isolated" | "merged" | "unknown";
    /** 全部条目(消费方按 `area` / `generated` / `library` 自行过滤) */
    files: AreaFile[];
}

/** 一次性快照(数据中心原子替换的只读视图) */
export interface BuildMapSnapshot {
    /** 工作区根(由 build 根上溯;仅用于展示/相对化) */
    workspaceRoot: string;
    /** 构建根(build/)—— 本域两源之一 */
    buildRoot: string;
    /** 源码根 = `<工作区根>/src`(**按约定拼,不探测、不读内容**;README §2.2) */
    srcRoot: string;
    /** 包表(根键 = 包名) */
    packages: Map<string, BuildPackage>;
    /** 包 → 跳转清单(键与 packages 一致,可能为空数组) */
    jumps: Map<string, JumpEntry[]>;
    /** 包 → 安装内容解算(lib / import / share / include;键与 packages 一致) */
    areas: Map<string, PackageAreas>;
    /** 构建期警告(包级异常、同名冲突等;不阻断整体) */
    warnings: string[];
    /** 本次构建耗时(毫秒) */
    durationMs: number;
    /** 构建完成时刻(epoch 毫秒) */
    builtAt: number;
    /** 原因(全量/失效来源),供排障与事件消费方记录 */
    reason: string;
}

/** 新建一条跳转记录(字段默认值收敛) */
export function createJumpEntry(pkg: string, name: string, kind: JumpKind): JumpEntry {
    return {
        pkg,
        name,
        kind,
        srcPaths: [],
        headers: 0,
        linkedLibs: [],
        chain: [],
        tier: "U",
        tierNote: "",
        unresolved: false,
        unresolvedReason: "",
        installed: true,
        installPath: "",
    };
}
