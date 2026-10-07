/**
 * @file src/sidebar/install-truth-tree.ts
 * 侧边栏树模型 —— **纯函数,零 vscode**(故可无头单测)。
 *
 * 层级:`包 → 区 → 行`。数据全部来自 install-truth 的 `SidebarPackageView`
 * (见 `中心/query.ts` 与主 README §7.1),本文件**只做展示裁剪**:
 *
 *   · **隐藏生成物**(`generated`)—— 对齐 `手工重设计/侧边栏提案.md` §2.7 的口径
 *     (hook / environment / cmake / package.* / local_setup.* / `__pycache__` / egg-info / rosidl 生成物);
 *   · **lib 区不列库**(`library`)—— 同上,中间内容本期不暴露;
 *   · **launch 区(2026-09-25 新增)** —— share 区中命中 launch 扩展名的行**提升**为独立展示区
 *     (排在"可执行"之后;去 `launch/` 前缀展示;share 区不再重复显示)。
 *     判定与运行数据源(`build-tool/package-service/run/launch-detect.ts`)共用同一函数,
 *     保证"树上看得见的"= "面板能选的" = "能运行的"。
 *
 * 2026-09-25 追加裁定(均在过滤链与 packageNodeOf 内):
 *   · include 区显示生成头、import 区纯 Python 面,rosidl 中间产物隐藏(`isRosidlIntermediate`);
 *   · 布局(isolated/merged)上移视图标题(`layoutOfViews`);包节点带属性前缀
 *     (安装类型以 install 观察为准 `installFormOf` + 构建类型 `buildType`);
 *   · 目录 label 不带尾部 `/`、单分支链合并(`a/b/c`)、**目录固定排在文件前**、计数统一 " N 项"。
 *
 * ⚠️ 裁剪是**消费方策略**:truth 层给的是全集 + 标记(主 README §2.1 第 3 条);
 * 这里只是"简易侧边栏"这一个消费方的选择,想改就改这一个文件。
 *
 * 纯 TS,零依赖(node 侧不 import vscode)。
 */

import { l10n } from "vscode";


import type { AreaName, SidebarPackageView, SidebarRow } from "../install-truth/api";
// 直连(不经 run/index.ts):index 会拉起命令注册/composeApi 的 vscode 依赖链,本文件要保持零 vscode 可无头单测
import { isLaunchFileName, trimLaunchDisplayPrefix } from "../build-tool/package-service/run/launch-detect";

/** 简易侧边栏的展示口径(只此一处;要"详细模式"就把它调开) */
export const SIMPLE_DISPLAY = {
    /** 隐藏约定/构建生成物(include/import 区有豁免,见 packageNodeOf) */
    hideGenerated: true,
    /** lib 区不列库文件(.so/.a) */
    hideLibraryInLibArea: true,
    /** 隐藏 rosidl 中间产物(2026-09-25 第二批,用户裁定"只显示最后的导出接口";见 isRosidlIntermediate) */
    hideRosidlIntermediates: true,
};

/**
 * rosidl **中间产物**判定(2026-09-25 第二批,展示层过滤;truth 层不动):
 *  · include 区:`detail` 路径段与 `*__visibility_control.h/hpp` 是生成器中间头
 *    (与 build 包内 `roslidl_generator_*` 目录对照;真实形状见 `discover/工作区定性图.md:88-92`,
 *    双下划线 `__visibility_control` 是 rosidl 约定);
 *  · import 区:`*_s.c` / `*_s.ep.*.c` 是 typesupport C 中间层,`.so` 是 CPython 二进制库 ——
 *    纯 Python 面(`__init__.py` / `_*.py`)才留(用户裁定 2026-09-25)。
 * ⚠️ 只对 **generated** 行生效:用户手写的 detail/ 头文件、自己的 .so 不受影响。
 */
export function isRosidlIntermediate(r: DisplayRow): boolean {
    if (!r.generated) {
        return false;
    }
    const segs = r.name.split("/");
    if (r.area === "include") {
        if (segs.indexOf("detail") >= 0) {
            return true;
        }
        return /__visibility_control\.h(pp)?$/.test(segs[segs.length - 1]);
    }
    if (r.area === "import") {
        const base = segs[segs.length - 1];
        return /_s\.c$/.test(base) || /_s\.ep\..*\.c$/.test(base) || /\.so$/.test(base);
    }
    return false;
}

/**
 * 侧边栏展示区(2026-09-25 起 5 个):`launch` 是从 share 区**提升出来的展示区**,
 * 不是 truth 层的 `AreaName`(truth 仍按 lib/import/share/include 四区给数据)。
 */
export type DisplayArea = AreaName | "launch";

/** 区的中文名(树节点标签) */
export const AREA_LABEL: Record<DisplayArea, string> = {
    lib: l10n.t("Executables"),
    launch: "launch",
    import: l10n.t("Python exports"),
    share: l10n.t("Resources"),
    include: l10n.t("Headers"),
};

/** 区的展示顺序(固定;launch 紧跟可执行 —— 都是"能 ▶ 跑"的行) */
export const AREA_ORDER: DisplayArea[] = ["lib", "launch", "import", "share", "include"];

/** 展示行 = truth 行,但 area 放宽为展示区(launch 区的行经提升改写;树模型各入口统一收这个形状) */
export type DisplayRow = Omit<SidebarRow, "area"> & { area: DisplayArea };

/** 树节点(给 VS Code 适配层用的最小结构) */
export interface TreeNode {
    kind: "message" | "package" | "area" | "dir" | "file";
    label: string;
    /** 行内右侧灰字 */
    description?: string;
    /** hover 全文 */
    tooltip?: string;
    /** 归属(排障用;file 行也带 —— ▶ 运行需要) */
    pkg?: string;
    area?: DisplayArea;
    /** 仅文件行:展示用的源串(可能带 `:main`) */
    source?: string;
    /** 仅文件行:**可打开的纯路径**(不含 `:attr`)—— 点击跳转用;launch 行同时是**记忆分槽键** */
    sourcePath?: string;
    /** 仅文件行:安装侧绝对路径(launch ▶ 的 ${launch_path} 与记忆退化键) */
    installPath?: string;
    status?: SidebarRow["status"];
    /** 内容来源引用(2026-09-25 第五批:悬浮栏可逆搜索 —— 如 `安装记录 symlink_install_manifest.txt`) */
    sourceRef?: string;
    /** 仅文件行:形态标记(悬空软链不给 ▶) */
    dangling?: boolean;
    /** 仅文件行:可执行位(lib 区判定 ▶ 用;undefined = 未知,按可对待) */
    executable?: boolean;
    /** 有则说明可展开 */
    children?: TreeNode[];
}

/** 工作区相对化(仅展示用;不在工作区内就原样给) */
export function relToWorkspace(workspaceRoot: string | undefined, p: string): string {
    if (workspaceRoot !== undefined && workspaceRoot !== "" && p.startsWith(workspaceRoot + "/")) {
        return p.slice(workspaceRoot.length + 1);
    }
    return p;
}

/** 一行的 hover 全文:把"为什么是这个状态"摊开(中性文案,不报错) */
export function rowTooltip(r: DisplayRow): string {
    const lines: string[] = [`${r.name}   ·   ${r.status}`];
    lines.push(l10n.t("Install target: {0}", r.installPath));
    lines.push(l10n.t("Source:   {0}", r.source ?? l10n.t("(no source - this domain has no install record)")));
    if (r.status === "missing") {
        lines.push(l10n.t("⚠️ In install records but not seen under install/ (deleted or layout mismatch)"));
    }
    if (r.dangling) {
        lines.push(l10n.t("⚠️ Dangling symlink: target missing - do not treat as a usable entry point"));
    }
    if (r.linkDomain === "src") {
        lines.push(l10n.t("Form: symlink -> src (edits take effect immediately, no reinstall)"));
    } else if (r.linkDomain === "build") {
        lines.push(l10n.t("Form: symlink -> build (may break after rebuild)"));
    } else if (r.linkDomain === "outside") {
        lines.push(l10n.t("Form: symlink -> outside workspace (not usable for source mapping)"));
    }
    if (r.viaLinkDomain === "build") {
        lines.push(l10n.t("Shape: linked in via build (= develop passthrough; source dir contents bleed in)"));
    } else if (r.viaLinkDomain === "src") {
        lines.push(l10n.t("Shape: linked in via src"));
    }
    if (r.executable) {
        lines.push(l10n.t("Executable: yes"));
    }
    if (r.sourceEvidence !== undefined) {
        lines.push(l10n.t("Source evidence: {0}", r.sourceEvidence) + (r.sourceRef !== undefined ? l10n.t(" ({0})", r.sourceRef) : ""));
    }
    if (r.sourceRef !== undefined && r.sourceEvidence === undefined) {
        lines.push(l10n.t("Origin: {0}", r.sourceRef));
    }
    return lines.join("\n");
}

/** 一行 → 叶节点(pkg 供 ▶ 运行;2026-09-25 加) */
export function fileNodeOf(r: DisplayRow, _workspaceRoot?: string, pkg?: string): TreeNode {
    // 2026-09-25(第二批,用户裁定"路径太长相当不美观"):文件行**不再显示**路径灰字 ——
    // 源/落点/形态全文都在 tooltip(rowTooltip);include 生成头在 hover 里说明"点击跳安装侧"。
    const clickInstallSide = r.area === "include" && r.generated;
    const tooltip = clickInstallSide
        ? `${rowTooltip(r)}\n${l10n.t("Generated header (source in build) - click opens the INSTALL-side file; no src/build jump")}`
        : rowTooltip(r);
    return {
        kind: "file",
        label: r.name,
        tooltip,
        area: r.area,
        pkg,
        source: r.source,
        sourcePath: r.sourcePath,
        installPath: r.installPath,
        status: r.status,
        dangling: r.dangling,
        executable: r.executable,
        sourceRef: r.sourceRef,
    };
}

/**
 * 把一组行按 `/` **折成目录树**(2026-09-21 修:此前是平铺,33 行糊成一片,提案里画的是真树)。
 *
 * 排序(2026-09-25 第三批,用户裁定"必须固定文件夹必须在最前面"):**目录组在前、文件组在后,
 * 各组内字母序** —— 推翻此前"纯字母混排"口径(实测 `_` 开头的 `__init__.py` 会插到目录前面)。
 *
 * 单分支合并(2026-09-25 第三批,用户裁定,VS Code 资源管理器 compact folders 同语义):
 * 目录"恰好 1 个子目录且自身无文件"时与子目录**合并显示**,label 连成 `a/b/c` 链(如 `.cmake/api/v1`),
 * 递归到底;合并节点的计数 = 合并后子树的递归子孙文件数。
 */
export function foldRowsToTree(rows: readonly DisplayRow[], workspaceRoot?: string, pkg?: string): TreeNode[] {
    interface DirNode {
        name: string;
        dirs: Map<string, DirNode>;
        files: DisplayRow[];
    }
    const root: DirNode = { name: "", dirs: new Map(), files: [] };
    for (const r of rows) {
        const segs = r.name.split("/").filter((s) => s !== "");
        if (segs.length === 0) {
            continue;
        }
        let cur = root;
        for (let i = 0; i < segs.length - 1; i++) {
            const seg = segs[i];
            let next = cur.dirs.get(seg);
            if (next === undefined) {
                next = { name: seg, dirs: new Map(), files: [] };
                cur.dirs.set(seg, next);
            }
            cur = next;
        }
        cur.files.push({ ...r, name: segs[segs.length - 1] });
    }
    /** 子树内文件总数(2026-09-25 第二批起:容器数字 = **递归子孙文件数**) */
    const countFiles = (d: DirNode): number => {
        let n = d.files.length;
        for (const sub of d.dirs.values()) {
            n += countFiles(sub);
        }
        return n;
    };
    /** 单分支合并:沿"唯一子目录且无文件"一路向下,label 连成路径链 */
    const compactPath = (d: DirNode): { label: string; node: DirNode } => {
        let label = d.name;
        let cur = d;
        while (cur.dirs.size === 1 && cur.files.length === 0) {
            const only = Array.from(cur.dirs.values())[0];
            label = `${label}/${only.name}`;
            cur = only;
        }
        return { label, node: cur };
    };
    const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const emit = (d: DirNode): TreeNode[] => {
        const dirs: TreeNode[] = [];
        for (const sub of Array.from(d.dirs.values()).sort(byName)) {
            const { label, node: target } = compactPath(sub);
            const total = countFiles(target);
            // 2026-09-25(第三批):目录 label **不带尾部 `/`**(图标已区分);计数统一 " N 项" 追加式
            dirs.push({
                kind: "dir",
                label,
                description: l10n.t("{0} items", total),
                tooltip: l10n.t("{0} ({1} items)", label, total),
                children: emit(target),
            });
        }
        const files = d.files
            .slice()
            .sort(byName)
            .map((f) => fileNodeOf(f, workspaceRoot, pkg));
        return [...dirs, ...files];
    };
    return emit(root);
}

/**
 * 文件行的 contextValue(2026-09-25 细化;`view/item/context` 菜单的 when 用):
 *  · `ros2.installTruth.file.executable` —— lib 区、有可执行位、非缺失/悬空 ⇒ 行尾出 ▶ 按钮;
 *  · `ros2.installTruth.file.launch` —— launch 区、非缺失/悬空 ⇒ 同上;
 *  · 其余文件行统一 `ros2.installTruth.file`(不给运行按钮,右键/点击行为不变)。
 * 纯函数(适配层直接引用),与树模型同文件保证口径一致。
 */
export function fileContextValue(node: TreeNode): string | undefined {
    if (node.kind !== "file") {
        return undefined;
    }
    const runnable =
        node.status !== "missing" && node.status !== "generated" && !node.dangling && node.sourcePath !== undefined;
    if (node.area === "lib") {
        return runnable && node.executable !== false ? "ros2.installTruth.file.executable" : "ros2.installTruth.file";
    }
    if (node.area === "launch") {
        return runnable ? "ros2.installTruth.file.launch" : "ros2.installTruth.file";
    }
    return "ros2.installTruth.file";
}

/**
 * 行的**图标决策**(2026-10-04,用户裁定"有源路径才换"):
 *  · 文件行有 `sourcePath` → 交给**文件图标主题**按文件名/扩展名解析(适配层设
 *    `resourceUri` + `ThemeIcon.File`,与资源管理器同源,随用户主题自动跟随;
 *    官方机制:vscode.d.ts TreeItem.resourceUri —— file/folder ThemeIcon 仅在设有
 *    resourceUri 时让位给文件图标主题,其余恒按 codicon 渲染);
 *  · 其余维持语义 codicon:missing 行 `warning` 警示优先;无源路径的文件行退回
 *    角色图标(lib→terminal / launch→rocket / import→symbol-module / share→file-media /
 *    其余→file-code —— 源 `:attr` 展示串不进路径);非文件行 package/folder/info 不变
 *    (dir/area/package 是虚拟折树节点,本就没有磁盘路径字段);
 *  · **目录行无图标**(2026-10-04 用户裁定"资源管理器口径"):文件行改主题类型图标后,
 *    codicon folder 夹在中间反而扎眼 —— dir 行 `{tag:"none"}`,适配层不设 iconPath
 *    (渲染器对 iconPath/resourceUri/themeIcon 三连空不画图标,只剩折叠箭头+文字);
 *    区头行(area)是分区标题非文件夹,保留 folder 同质化图标。
 * 纯函数(零 vscode):适配层只做 `{tag:"file"}` → API 的机械翻译。
 */
export type IconPlan =
    | { tag: "file"; path: string }
    | { tag: "codicon"; id: string }
    | { tag: "none" };

export function iconPlanOf(node: TreeNode): IconPlan {
    if (node.kind === "package") {
        return { tag: "codicon", id: "package" };
    }
    if (node.kind === "area") {
        return { tag: "codicon", id: "folder" };
    }
    if (node.kind === "dir") {
        return { tag: "none" };
    }
    if (node.kind !== "file") {
        return { tag: "codicon", id: "info" };
    }
    if (node.status === "missing") {
        return { tag: "codicon", id: "warning" };
    }
    if (node.sourcePath !== undefined && node.sourcePath !== "") {
        return { tag: "file", path: node.sourcePath };
    }
    switch (node.area) {
        case "lib":
            // 2026-09-25:行首 terminal(命令行可执行)—— 行尾悬停按钮已是 ▶($(play)),前后双 ▶ 太吵(用户裁定)
            return { tag: "codicon", id: "terminal" };
        case "launch":
            // 2026-09-25:launch 行首 rocket(上游 launch-tree 的 launch 文件行先例),同理避让行尾 ▶
            return { tag: "codicon", id: "rocket" };
        case "import":
            return { tag: "codicon", id: "symbol-module" };
        case "share":
            return { tag: "codicon", id: "file-media" };
        default:
            return { tag: "codicon", id: "file-code" };
    }
}

/**
 * 文件行的**点击跳转目标**(2026-09-25 裁定):
 *  · **生成物**（include 与 import 区，源在 build 内，如 rosidl 生成头与生成 .py）→ **`installPath`** ——
 *    自动生成物不跳 src，统一落在安装侧（软链安装下链目标虽指 build，结构上仍应打开 install 路径）；
 *  · 其余文件行 → `sourcePath`（用户头文件/源码仍跳源）。
 * 都没有 → undefined（适配层不给点击命令）。
 */
export function openTargetOf(node: TreeNode): string | undefined {
    if (node.kind !== "file") {
        return undefined;
    }
    if ((node.area === "include" || node.area === "import") && node.status === "generated") {
        return node.installPath !== undefined && node.installPath !== "" ? node.installPath : node.sourcePath;
    }
    return node.sourcePath;
}

/** ▶ 运行按钮的目标载荷(随 TreeNode element 走;见 runPayloadOf) */
export interface SidebarRunPayload {
    pkg: string;
    /** 展示名(lib 区 = 可执行名;launch 区 = 去 `launch/` 前缀的包内相对路径) */
    label: string;
    /** 安装侧绝对路径(launch 的 ${launch_path} 与记忆退化键) */
    installPath?: string;
    /** 源文件绝对路径(launch 记忆分槽键) */
    sourcePath?: string;
}

/**
 * 从**树节点 element** 取 ▶ 载荷(2026-09-25 修):
 * `view/item/context` 命令的 `args[0]` 是 `getChildren` 产出的 **TreeNode**(VS Code 宿主把
 * `$treeItemHandle` 换回 element),不是 `getTreeItem` 的 TreeItem —— 载荷必须从 element 取。
 * 不可运行行(判定与 `fileContextValue` 同源)或缺 pkg → undefined。
 */
export function runPayloadOf(node: TreeNode): SidebarRunPayload | undefined {
    const context = fileContextValue(node);
    if (context !== "ros2.installTruth.file.executable" && context !== "ros2.installTruth.file.launch") {
        return undefined;
    }
    if (node.pkg === undefined || node.pkg === "" || node.label === "") {
        return undefined;
    }
    return { pkg: node.pkg, label: node.label, installPath: node.installPath, sourcePath: node.sourcePath };
}

/** 一个包 → 包节点(含各区子节点;区内按路径折成目录树;share 区的 launch 行提升为独立 launch 区) */
export function packageNodeOf(view: SidebarPackageView, workspaceRoot?: string): TreeNode {
    const launchRows: SidebarRow[] = [];
    const otherRows: SidebarRow[] = [];
    for (const r of view.rows) {
        if (r.area === "share" && isLaunchFileName(r.name)) {
            launchRows.push(r);
        } else {
            otherRows.push(r);
        }
    }
    const byDisplayArea = new Map<DisplayArea, DisplayRow[]>();
    for (const area of AREA_ORDER) {
        if (area === "launch") {
            continue;
        }
        byDisplayArea.set(
            area,
            otherRows.filter((r) => {
                if (r.area !== area) {
                    return false;
                }
                // 防御:扫描层黑名单已排 __pycache__/*.egg-info,但 manifest-only 反向行仍可能带回 ——
                // 展示层同样不显示(2026-09-25 第二批)
                {
                    const segs = r.name.split("/");
                    if (segs.indexOf("__pycache__") >= 0 || segs.some((s) => s.endsWith(".egg-info"))) {
                        return false;
                    }
                }
                // 2026-09-25(用户裁定):include 区**显示生成头**(接口包头文件是开发日常要看的);
                // import 区改为**纯 Python 面**(显示生成物但剔除 rosidl C 中间层与 .so,见 isRosidlIntermediate);
                // share 区生成物照旧隐藏。
                if (SIMPLE_DISPLAY.hideGenerated && r.generated && area !== "include" && area !== "import") {
                    return false;
                }
                if (SIMPLE_DISPLAY.hideRosidlIntermediates && isRosidlIntermediate(r)) {
                    return false;
                }
                return !(SIMPLE_DISPLAY.hideLibraryInLibArea && area === "lib" && r.library);
            }),
        );
    }
    // launch 区:同样应用"隐藏生成物";行 area 改写为展示区名(适配层据此给 ▶ 图标与 contextValue);
    // 名字去 `launch/` 前缀(嵌套保留子路径,折叠照常)
    byDisplayArea.set(
        "launch",
        launchRows.filter((r) => !(SIMPLE_DISPLAY.hideGenerated && r.generated)).map((r) => ({
            ...r,
            area: "launch" as const,
            name: trimLaunchDisplayPrefix(r.name),
        })),
    );

    const areas: TreeNode[] = [];
    for (const area of AREA_ORDER) {
        const rows = byDisplayArea.get(area) ?? [];
        if (rows.length === 0) {
            continue;
        }
        areas.push({
            kind: "area",
            label: AREA_LABEL[area],
            // 2026-09-25(第三批):计数统一 " N 项" 追加式(目录/区/包同构)
            description: l10n.t("{0} items", rows.length),
            tooltip: l10n.t("{0} / {1} ({2}) - {3} items in total", view.pkg, AREA_LABEL[area], area === "launch" ? l10n.t("from share directory") : area, rows.length),
            pkg: view.pkg,
            area,
            children: foldRowsToTree(rows, workspaceRoot, view.pkg),
        });
    }
    const visibleCount = Array.from(byDisplayArea.values()).reduce((sum, rows) => sum + rows.length, 0);
    // 2026-09-25(第三批):包节点携带**属性前缀** —— 安装类型(以 install 侧观察为准)+ 构建类型;
    // unknown/缺失的属性省略不显示,计数仍是递归子孙文件数
    const attrs: string[] = [];
    if (view.installForm === "symlink") {
        attrs.push(l10n.t("symlink install"));
    } else if (view.installForm === "copy") {
        // 2026-09-25(第五批,用户裁定):"实体安装"改名l10n.t("copy install")(与 colcon 的 copy 语义直译一致)
        attrs.push(l10n.t("copy install"));
    }
    if (view.buildType !== undefined) {
        attrs.push(view.buildType);
    }
    return {
        kind: "package",
        label: view.pkg,
        description: `${[...attrs, l10n.t("{0} items", visibleCount)].join(" · ")}`,
        tooltip: [
            view.pkg,
            l10n.t("Install prefix: {0}", view.prefix),
            l10n.t("Layout: {0} (workspace-level, shown next to the view title)", view.layout),
            l10n.t("Install type: {0} (based on actual install/ contents, not build config declaration)", view.installForm === "symlink" ? l10n.t("symlink install") : view.installForm === "copy" ? l10n.t("copy install") : l10n.t("unknown")),
            l10n.t("Build type: {0} (inferred from build artifacts)", view.buildType ?? l10n.t("unknown")),
            l10n.t("Entries: {0} visible / {1} total (generated artifacts/libs and excluded dirs filtered; per-area counts on each area)", visibleCount, view.rows.length),
        ].join("\n"),
        pkg: view.pkg,
        children: areas.length > 0 ? areas : [{ kind: "message", label: l10n.t("(nothing to show)"), description: l10n.t("everything filtered out was generated artifacts or libs") }],
    };
}

/**
 * 工作空间布局(2026-09-25 第二批,用户裁定"这个属性应该只有工作空间才拥有"):
 * 全工作区一致 → `isolated` / `merged`;不一致 → `混合布局`;无包 → undefined(标题旁不显示)。
 * 适配层把结果写到 `view.description`(渲染在"包内容"标题旁)。
 */
export function layoutOfViews(views: SidebarPackageView[]): string | undefined {
    if (views.length === 0) {
        return undefined;
    }
    const first = views[0].layout;
    return views.every((v) => v.layout === first) ? first : l10n.t("mixed layout");
}

/** 整棵树(纯函数) */
export function buildTree(views: SidebarPackageView[], workspaceRoot?: string): TreeNode[] {
    if (views.length === 0) {
        return [{ kind: "message", label: l10n.t("No build artifacts found"), description: l10n.t("Run colcon build first") }];
    }
    return views.map((v) => packageNodeOf(v, workspaceRoot));
}
