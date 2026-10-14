/**
 * @file src/sidebar/install-truth-sidebar.ts
 * 侧边栏的 VS Code 适配层(**薄**):把 install-truth 的侧边栏视图画成一棵原生树。
 *
 * 分工:
 *   · 数据与裁剪逻辑全在 `install-truth-tree.ts`(纯函数,可无头单测);
 *   · 本文件只干三件事:建中心 → 当 `TreeDataProvider` → 注册命令与视图。
 *
 * 简易口径(用户 2026-09-21:"确实就是简易,只需要简易就行";
 * 2026-09-25 增补:lib 区可执行行与 launch 区文件行出**行内 ▶ 运行按钮**,
 *   参数弹窗/记忆/执行全部委托 run 域 —— smart-run/smart-launch;
 *   行首图标改 terminal(lib)/rocket(launch),避让行尾 ▶;
 *   include 区生成头不再隐藏,点击统一跳**安装侧**文件(openTargetOf);
 *   ▶ 目标一律从 **element(TreeNode)** 取(runPayloadOf)—— view/item/context 收的是 element 非 TreeItem;
 *   2026-09-25 第二批:布局(isolated/merged)上移视图标题 —— 第六批改为直接写 **title 本体**
 *   (「包内容 isolated · 13 包」;单视图容器的紧凑标题渲染的是 title,description 不显示)。
 *   2026-10-04:文件行图标改接**文件图标主题**(决策在纯函数 iconPlanOf:有 sourcePath →
 *   resourceUri + ThemeIcon.File,与资源管理器同源随用户主题;无源路径/missing/非文件行维持语义 codicon)。
 *   · 展开时**惰性刷新**(`ensureFresh`),不挂 `build/**` watcher、不轮询;
 *   · 刷新命令保留;点击行 = 跳源/安装侧文件(按 openTargetOf 分流),运行走行内 ▶(不与跳转冲突)。
 *
 * ⚠️ **工作区是惰性绑定的**(2026-09-21 修):`launch.json` 的 `Extension` 配置只传
 * `--extensionDevelopmentPath`,**不带文件夹参数**,所以开发宿主起来时 `workspaceFolders` 是空的。
 * 若那时就不注册提供器,视图会显示"没有数据提供器";故改为**首次展开时**才解析工作区,
 * 并在工作区文件夹变化时重建 —— 起宿主之后再打开 ROS 工作区也能直接接上,不需要重载窗口。
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { BuildMapCenter, ExecutableResolver } from "../install-truth/api";
import type { SidebarRow } from "../install-truth/api";
// 2026-09-24:共享的 build-map 数据中心(按工作区根单例;首次获取时顺带接电构建 watcher → trigger)
import { acquireSharedBuildCenter } from "../install-truth/center/shared-center";
import { getLogger } from "../logger";
// 2026-09-25:▶ 运行委托 run 域(参数弹窗 + 按目标分槽记忆 + 任务终端执行);
// 点击目标(openTargetOf)与 ▶ 载荷(runPayloadOf)的推导都在纯函数层,可无头单测
import { launchFileFromTree, runExecutableFromTree } from "../build-tool/package-service/run";
// 2026-09-25(第五批):包节点右键"构建此包"复用 build 域的单包构建公共执行体
import { buildSinglePackageByName } from "../build-tool/package-service/build";
import type { BuildDataSource } from "../build-tool/package-service/build/data-source";
import { buildTree, countLeftovers, fileContextValue, iconPlanOf, layoutOfViews, openTargetOf, rowStateStale, runPayloadOf, TreeNode } from "./install-truth-tree";

/** 视图与命令 ID(单一事实源) */
export const SIDEBAR_VIEW_ID = "ros2.installTruth";
/** 视图标题(与 package.json views[].name 一致;attachView 经 API 回写,保证 description 渲染) */
export const SIDEBAR_VIEW_TITLE = vscode.l10n.t("Package Contents");
export const SIDEBAR_REFRESH_COMMAND = "ROS2.sidebar.refresh";
/** 残留条目显示开关(2026-10-14,用户裁定方案 B:默认隐藏;ROS2.ui.showLeftovers,Global 持久化) */
export const UI_SHOW_LEFTOVERS_SETTING = "ui.showLeftovers";
/**
 * 眼睛按钮双命令(2026-10-14 换源,用户实测"图标转换有问题"):view/title 菜单条目**没有 icon 属性**
 * (只认 command/alt/when/group/order,条目级 icon 被宿主丢弃)——图标随状态切换必须走
 * "两条命令各自声明图标 + when 互补、宿主按态挑命令"的标准模式,单命令读反写做不到。
 */
export const SIDEBAR_SHOW_LEFTOVERS_COMMAND = "ROS2.sidebar.showLeftovers";
export const SIDEBAR_HIDE_LEFTOVERS_COMMAND = "ROS2.sidebar.hideLeftovers";
/** 行点击跳转(只作 `TreeItem.command`,不进命令面板 —— 它需要参数) */
export const SIDEBAR_OPEN_COMMAND = "ROS2.sidebar.openSource";
/** 行内 ▶ 运行按钮(2026-09-25;只进 view/item/context inline,不进命令面板) */
export const SIDEBAR_RUN_EXECUTABLE_COMMAND = "ROS2.sidebar.runExecutable";
export const SIDEBAR_LAUNCH_FILE_COMMAND = "ROS2.sidebar.launchFile";
/** 包节点右键"构建此包"(2026-09-25 第五批;套用选择记忆,不弹参数窗) */
export const SIDEBAR_BUILD_PACKAGE_COMMAND = "ROS2.sidebar.buildPackage";

/**
 * 打开一个源文件 —— 走 VS Code 的**预览标签**。
 *
 * `{ preview: true, preserveFocus: true }`:预览标签会被下一个**复用**(点 N 个只留 1 个),
 * 且**焦点留在树上**,可以连着往下点 —— 这才是"快速浏览"。
 * (`preview: false` 是钉住新标签,点 5 个就攒 5 个。)
 *
 * **不提供"固定打开"**:钉住是 VS Code 的既有机制 —— 双击标签即固定,
 * 或改动文件内容时自动把预览转为固定(2026-09-21 用户裁定:加一个选项反而更多余)。
 *
 * ⚠️ 已知边界:用户若关掉 `workbench.editor.enablePreview`,VS Code **会忽略** `preview: true`
 * ([vscode#149088](https://github.com/microsoft/vscode/issues/149088),设计如此),那时标签仍会累积。
 */
async function openPath(filePath: string): Promise<void> {
    // 二级动作按钮(2026-10-04 i18n 期0):显示与返回值判定必须同源常量——l10n 化后 showXXXMessage
    // 的返回值就是(翻译后的)按钮文案本身,比较键绝不能是第二份独立字面量
    const BTN_COPY_PATH = vscode.l10n.t("Copy Path");
    const BTN_OPEN_DIR = vscode.l10n.t("Open Containing Folder");
    if (!fs.existsSync(filePath)) {
        log.warn(vscode.l10n.t("Source file not found: {0}", filePath));
        const action = await vscode.window.showWarningMessage(
            vscode.l10n.t("Source file not found (moved or renamed?): {0}", filePath),
            BTN_COPY_PATH,
            BTN_OPEN_DIR
        );
        if (action === BTN_COPY_PATH) {
            await vscode.env.clipboard.writeText(filePath);
        } else if (action === BTN_OPEN_DIR) {
            const dir = path.dirname(filePath);
            if (fs.existsSync(dir)) {
                await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
            }
        }
        return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
}

const log = getLogger("sidebar");

// 2026-09-25 修:▶ 按钮的目标载荷不再挂在 TreeItem 上 —— `view/item/context` 命令的 args[0]
// 是 **getChildren 产出的 element(TreeNode)**(VS Code 宿主把 $treeItemHandle 换回扩展侧数据节点),
// 目标一律经纯函数 `runPayloadOf(node)` 从 element 取(可无头单测,见 install-truth-tree.ts)。

/** 树数据提供器(只做 TreeNode → TreeItem 的翻译;中心按当前工作区**惰性**持有) */
export class InstallTruthSidebarProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this.emitter.event;

    private center: BuildMapCenter | undefined;
    private resolver: ExecutableResolver | undefined;
    /** 当前绑定到哪个工作区根(工作区换了就整体重建) */
    private boundRoot: string | undefined;
    /** 视图句柄(2026-09-25 第二批:标题旁 description 显示工作空间布局,见 setViewDescription) */
    private view: vscode.TreeView<TreeNode> | undefined;

    /** 注册时回接视图句柄(createTreeView 在 registerInstallTruthSidebar 里创建) */
    attachView(view: vscode.TreeView<TreeNode>): void {
        // 2026-09-25(第三批修):显式回写 title —— 实测只靠 package.json 的 name 时,
        // 宿主对 description 的渲染不稳定;title+description 都经 API 设置后才可靠显示
        view.title = SIDEBAR_VIEW_TITLE;
        this.view = view;
    }

    /** 视图标题旁显示工作空间布局(isolated/merged/混合布局;空值 = 清空,不占位) */
    private setViewDescription(layout: string | undefined): void {
        if (this.view !== undefined) {
            this.view.description = layout ?? "";
        }
    }

    /**
     * **视图标题本体携带工作空间布局**(2026-09-25 第六批,用户裁定"把'包内容'三个字替换掉"):
     * 单视图容器的紧凑标题(「ROS 2 包: 包内容」)**渲染的就是 title**(description 在紧凑头部不显示),
     * 故把布局/包数动态写进 title → 「ROS 2 包: 包内容 isolated · 13 包」。
     * description 仍然写(无害;将来容器变多视图时会开始渲染)。
     */
    private setViewTitle(layout: string | undefined, packageCount: number, leftoverSuffix?: string): void {
        if (this.view === undefined) {
            return;
        }
        // 2026-10-14:残留计数必须进 **title**(紧凑单视图容器只渲染 title,description 不显示——第六批事实);
        // 用户裁定"残留总数常显":隐藏态「已隐藏」/显示态「已显示」
        const base =
            layout === undefined
                ? vscode.l10n.t("{0}{1}", SIDEBAR_VIEW_TITLE, packageCount > 0 ? vscode.l10n.t(" · {0} packages", packageCount) : "")
                : vscode.l10n.t("{0} {1} · {2} packages", SIDEBAR_VIEW_TITLE, layout, packageCount);
        this.view.title = leftoverSuffix !== undefined ? `${base} ${leftoverSuffix}` : base;
    }

    /** 空态/失败态:标题恢复原样(不带布局) */
    private resetViewTitle(): void {
        if (this.view !== undefined) {
            this.view.title = SIDEBAR_VIEW_TITLE;
        }
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        const collapsible =
            node.children !== undefined
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(node.label, collapsible);
        item.description = node.description;
        item.tooltip = node.tooltip ?? node.description;
        // 图标决策在纯函数层(iconPlanOf):有源路径的文件行交给**文件图标主题**
        // (resourceUri + ThemeIcon.File,与资源管理器同源随主题);目录行不设图标
        // (三连空渲染器不画,只剩折叠箭头+文字);其余维持语义 codicon
        const icon = iconPlanOf(node);
        if (icon.tag === "file") {
            item.resourceUri = vscode.Uri.file(icon.path);
            item.iconPath = vscode.ThemeIcon.File;
        } else if (icon.tag === "codicon") {
            // 2026-10-13:codicon 可携带主题色(错误行分型:红=list.errorForeground / 琥珀=editorWarning.foreground)
            item.iconPath = new vscode.ThemeIcon(icon.id, icon.color !== undefined ? new vscode.ThemeColor(icon.color) : undefined);
        }
        // contextValue(2026-09-25 细化):文件行按"可执行 / launch / 普通"区分(view/item/context 的 when);
        // 其余节点维持 `ros2.installTruth.<kind>`。
        const context = fileContextValue(node);
        if (context !== undefined) {
            item.contextValue = context;
        } else if (node.kind !== "message") {
            item.contextValue = `ros2.installTruth.${node.kind}`;
        }
        // 可运行行的 ▶ 目标从 element 取(runPayloadOf),不再挂 TreeItem 自定义属性(见文件头 2026-09-25 修)
        // 点击跳转(2026-09-25 起):include 区生成头跳**安装侧**文件,其余行跳源 —— 统一经 openTargetOf 分流
        const openTarget = openTargetOf(node);
        if (openTarget !== undefined && openTarget !== "") {
            item.command = {
                command: SIDEBAR_OPEN_COMMAND,
                title: vscode.l10n.t("Open File"),
                // 2026-10-14 增传 element(照 ▶ 的"菜单收 element 非 TreeItem"先例):点击复核要知道点的是哪行
                arguments: [openTarget, node],
            };
        }
        return item;
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        if (node !== undefined) {
            return node.children ?? [];
        }
        const resolver = this.ensure();
        if (resolver === undefined) {
            this.setViewDescription(undefined);
            this.resetViewTitle();
            return [{ kind: "message", label: vscode.l10n.t("No workspace open"), description: vscode.l10n.t("Open a ROS workspace folder first") }];
        }
        // 展开根时才刷新(惰性):未就绪 → 首次构建;置脏 → 重扫
        await resolver.ensureFresh("sidebar");
        const error = this.center?.getLastError();
        if (error !== undefined) {
            this.setViewDescription(undefined);
            this.resetViewTitle();
            return [{ kind: "message", label: vscode.l10n.t("Resolution failed"), description: error }];
        }
        const views = resolver.sidebarSnapshot() ?? [];
        // 2026-09-25(第六批,用户裁定"把'包内容'三个字替换掉"):布局/包数写进**视图标题本体** ——
        // 单视图容器的紧凑标题(「ROS 2 包: 包内容」)渲染的就是 title(description 紧凑头部不显示),
        // 于是标题变成「ROS 2 包: 包内容 isolated · 13 包」;第五批的树根信息行由它取代,撤除。
        // description 仍写(无害;将来容器变多视图时会开始渲染)。
        this.setViewTitle(layoutOfViews(views), views.length);
        // 残留条目(2026-10-14,方案 B):默认隐藏(ROS2.ui.showLeftovers);总数**常显**进 title
        // (首版误写 description——紧凑标题不渲染 description,用户实测"总个数没显示")
        const showLeftovers = vscode.workspace.getConfiguration("ROS2").get<boolean>(UI_SHOW_LEFTOVERS_SETTING, false);
        const leftoverTotal = countLeftovers(views);
        log.debug(vscode.l10n.t("[diag] leftover stats: total={0} show={1}", String(leftoverTotal), String(showLeftovers)));
        const leftoverSuffix =
            leftoverTotal > 0
                ? showLeftovers
                    ? vscode.l10n.t("· {0} leftover(s) shown", leftoverTotal)
                    : vscode.l10n.t("· {0} leftover(s) hidden", leftoverTotal)
                : undefined;
        this.setViewTitle(layoutOfViews(views), views.length, leftoverSuffix);
        // C 类源失效标记 + 双 mtime 考古(2026-10-13,用户裁定):fs 收在装配层,树/图标决策保持纯函数;
        // 浅拷贝行注入,**不改 resolver 共享视图**。成本 = 展开时每行 1~2 次 stat(源行 2 次/其余 1 次)。
        const marked = views.map((v) => ({
            ...v,
            rows: v.rows.map((r) => {
                const out: SidebarRow & {
                    sourceMissing?: boolean;
                    sourceMtimeMs?: number;
                    installMtimeMs?: number;
                } = { ...r };
                // 悬空:install 侧本身是断链,mtime 无意义(B 类图标/徽标已承载)
                if (r.dangling !== true) {
                    try {
                        out.installMtimeMs = fs.statSync(r.installPath).mtimeMs;
                    } catch {
                        // 观察行 stat 失败(罕见):留空,tooltip 不显示该行
                    }
                }
                if (r.sourcePath !== undefined && r.sourcePath !== "") {
                    try {
                        out.sourceMtimeMs = fs.statSync(r.sourcePath).mtimeMs;
                    } catch {
                        out.sourceMissing = true; // 源不存在 = C 类源失效(与图标判定同源)
                    }
                }
                return out;
            }),
        }));
        return buildTree(marked, this.boundRoot, { showLeftovers });
    }

    /** 取(必要时建)当前工作区对应的解算器;无工作区 → undefined */
    ensure(): ExecutableResolver | undefined {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root === undefined) {
            return undefined;
        }
        if (this.resolver === undefined || this.boundRoot !== root) {
            // 2026-09-24:改用**共享**数据中心(与测试 runner 同一实例 ⇒ 消双份全量扫描);
            // 首次获取会顺带接电构建 watcher(只置脏,不扫描)。**这里不再 dispose** ——
            // 实例由 shared-center 拥有,扩展停用时统一释放。
            const shared = acquireSharedBuildCenter(root);
            this.center = shared.center;
            this.center.onDidChange(() => this.refresh());
            this.resolver = new ExecutableResolver(this.center);
            this.boundRoot = root;
            log.info(vscode.l10n.t("Sidebar bound to workspace: {0} (shared build-map center)", root));
        }
        return this.resolver;
    }

    /**
     * 手动刷新(2026-09-30 改**主动**):中心权威全量重扫(构建事件化后数据常驻,
     * 手动 = 用户要一个确定的"现在就重算"),完成后 `onDidChange` 自动重绘;
     * 此处先 fire 一次树重绘去等待感(旧快照立即上屏,新快照到了再换)。
     */
    refreshManually(): void {
        if (this.center !== undefined) {
            void this.center.refresh(vscode.l10n.t("Manual sidebar refresh"));
        }
        this.refresh();
    }

    /**
     * 点击行复核(2026-10-14,用户裁定"点击行即复核,不一致触发整树更新"):点击 = 用户的注意力所在,
     * 也是状态最可疑之处 —— 现探该行三态(install 侧 lstat/stat 判 installed/missing/悬空,源侧
     * existsSync 判源失效),与显示不一致 → `refreshManually()`(中心权威全量重扫 + 重绘;
     * 一行陈旧 ≈ 世界动过,同包兄弟行大概率同样陈旧)。一致 → 零动作(数据不变页面必须静止)。
     * 复核只此一行,不做全行探测;mtime 差异不构成不一致(纯信息)。
     */
    probeRowOnClicked(node: TreeNode): void {
        if (node.kind !== "file") {
            return;
        }
        if (node.status !== "installed" && node.status !== "missing") {
            return; // generated/source-unresolved 非 fs 可证语义,跳过(防每次点击误触发重扫循环)
        }
        if (node.installPath === undefined || node.installPath === "") {
            return;
        }
        const fresh = probeRowState(node.installPath, node.sourcePath);
        if (!rowStateStale(node, fresh)) {
            return;
        }
        log.info(vscode.l10n.t("Row state changed since snapshot (click re-check) - full resync: {0}", node.label));
        this.refreshManually();
    }

    /** 重绘整棵树 */
    refresh(): void {
        this.emitter.fire();
    }

    dispose(): void {
        // 数据中心是**共享**的(与测试侧同一实例),不在此释放 —— 见 shared-center 的 disposeSharedBuildCenter
        this.emitter.dispose();
    }
}

/**
 * 单行状态现探(2026-10-14,点击行复核用):与 truth 层判定同源 —— install 侧 lstat:
 * 不存在 = missing;是软链且跟链 stat 失败 = installed + 悬空;其余 = installed。
 * 源侧 existsSync 取反 = sourceMissing(无源路径 = undefined)。fs 异常一律按"探不到"处理,
 * 点击路径绝不抛错。
 */
function probeRowState(installPath: string, sourcePath: string | undefined): { status: "installed" | "missing"; dangling: boolean; sourceMissing?: boolean } {
    let status: "installed" | "missing" = "missing";
    let dangling = false;
    try {
        if (fs.lstatSync(installPath).isSymbolicLink()) {
            try {
                fs.statSync(installPath); // 跟链探目标可达性
                status = "installed";
            } catch {
                status = "installed"; // 链本体还在(install 侧看得到)但目标没了 = 悬空
                dangling = true;
            }
        } else {
            status = "installed";
        }
    } catch {
        status = "missing";
        dangling = false;
    }
    let sourceMissing: boolean | undefined;
    if (sourcePath !== undefined && sourcePath !== "") {
        try {
            sourceMissing = !fs.existsSync(sourcePath);
        } catch {
            sourceMissing = true;
        }
    }
    return { status, dangling, sourceMissing };
}

/**
 * 注册侧边栏(在 `activate` 里调用一次)。
 * 视图**无条件注册**(贡献已在 `package.json` 里);工作区在首次展开时才解析。
 * `data`(2026-09-25 第五批)= 包数据源(packageCore),供包节点右键"构建此包"。
 */
export function registerInstallTruthSidebar(context: vscode.ExtensionContext, data: BuildDataSource | null): vscode.Disposable[] {
    const provider = new InstallTruthSidebarProvider();

    const view = vscode.window.createTreeView(SIDEBAR_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    provider.attachView(view);

    const refresh = vscode.commands.registerCommand(SIDEBAR_REFRESH_COMMAND, () => {
        provider.refreshManually();
        log.info(vscode.l10n.t("Manual sidebar refresh"));
    });

    // 残留条目显示切换(2026-10-14,方案 B + 同日换源):眼睛按钮双命令——各自写目标值
    // (Global 持久化,设置页同键,天然幂等),图标随命令声明走、由 view/title 的 when 互补条目择一显示。
    const setLeftoversVisible = (value: boolean): void => {
        void vscode.workspace
            .getConfiguration("ROS2")
            .update(UI_SHOW_LEFTOVERS_SETTING, value, vscode.ConfigurationTarget.Global)
            .then(() => {
                log.info(value ? vscode.l10n.t("Leftover entries are now shown") : vscode.l10n.t("Leftover entries are now hidden"));
                provider.refresh();
            });
    };
    const showLeftovers = vscode.commands.registerCommand(SIDEBAR_SHOW_LEFTOVERS_COMMAND, () => setLeftoversVisible(true));
    const hideLeftovers = vscode.commands.registerCommand(SIDEBAR_HIDE_LEFTOVERS_COMMAND, () => setLeftoversVisible(false));

    // 行点击跳转。存在性是**编辑器侧**的事(本域不判域外存在性,README §2.2);
    // 这里只负责"打不开时给一句看得懂的话",而不是甩一个通用错误。
    // 2026-10-14:点击同时复核该行状态(args[1] = TreeNode element,见 getTreeItem)——
    // 与显示不一致 → 整树权威重扫(用户裁定"点了都不失效了,侧边栏不能没反应")。
    const openSource = vscode.commands.registerCommand(SIDEBAR_OPEN_COMMAND, async (filePath: unknown, node?: unknown) => {
        if (node !== undefined && node !== null && typeof node === "object" && typeof (node as TreeNode).status === "string") {
            provider.probeRowOnClicked(node as TreeNode);
        }
        if (typeof filePath === "string" && filePath !== "") {
            await openPath(filePath);
        }
    });

    // 行内 ▶ 运行(2026-09-25):委托 run 域 —— 参数弹窗(预填按目标分槽的记忆)→ 模板展开 → 任务终端。
    // args[0] = **树节点 element(TreeNode)**(非 TreeItem,见文件头说明);目标经 runPayloadOf 取。
    const runExecutable = vscode.commands.registerCommand(SIDEBAR_RUN_EXECUTABLE_COMMAND, async (...args: unknown[]) => {
        const payload = runPayloadOf(args[0] as TreeNode);
        if (payload === undefined) {
            log.warn(vscode.l10n.t("Run button got no target (node not runnable or missing pkg); ignored"));
            return;
        }
        await runExecutableFromTree({ pkg: payload.pkg, executable: payload.label });
    });
    const launchFile = vscode.commands.registerCommand(SIDEBAR_LAUNCH_FILE_COMMAND, async (...args: unknown[]) => {
        const payload = runPayloadOf(args[0] as TreeNode);
        if (payload === undefined) {
            log.warn(vscode.l10n.t("Launch button got no target (node not runnable or missing pkg); ignored"));
            return;
        }
        await launchFileFromTree({
            pkg: payload.pkg,
            name: payload.label,
            installPath: payload.installPath ?? "",
            sourcePath: payload.sourcePath,
        });
    });

    // 包节点右键"构建此包"(2026-09-25 第五批):委托 build 域单包构建公共执行体
    // (套用选择记忆不弹窗;被 COLCON_IGNORE 的包提示不放行)
    const buildPackage = vscode.commands.registerCommand(SIDEBAR_BUILD_PACKAGE_COMMAND, async (...args: unknown[]) => {
        const node = args[0] as TreeNode | undefined;
        if (node === undefined || node.kind !== "package" || node.pkg === undefined || node.pkg === "") {
            log.warn(vscode.l10n.t("Build-this-package got no package name (not a package node); ignored"));
            return;
        }
        await buildSinglePackageByName(data, node.pkg, "release");
    });

    // 工作区文件夹变化 → 重绑并重绘(起宿主后再打开工作区也能接上)
    const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        provider.ensure();
        provider.refresh();
    });

    return [view, refresh, showLeftovers, hideLeftovers, openSource, runExecutable, launchFile, buildPackage, folders, provider];
}
