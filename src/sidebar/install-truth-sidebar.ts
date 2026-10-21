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
// 2026-10-18(P1):▶/构建三命令入统一命令围栏(门关一句拒绝,与执行层同键)
import { GATE_REFUSALS, registerGatedCommand } from "../commands/gated-command";
import { composeApi } from "../ros2/api";
import { buildTree, countLeftovers, fileContextValue, iconPlanOf, layoutOfViews, openTargetOf, rowStateStale, rowTooltip, runPayloadOf, TreeNode } from "./install-truth-tree";
import type { DisplayRow } from "./install-truth-tree";

/** 视图与命令 ID(单一事实源) */
export const SIDEBAR_VIEW_ID = "ros2.installTruth";
/** 视图标题(与 package.json views[].name 一致;attachView 经 API 回写,保证 description 渲染) */
export const SIDEBAR_VIEW_TITLE = vscode.l10n.t("Package Contents");
export const SIDEBAR_REFRESH_COMMAND = "ROS2.sidebar.refresh";
/** 残留条目显示开关(2026-10-14,用户裁定方案 B:默认隐藏;ROS2.ui.showLeftovers,Global 持久化) */
export const UI_SHOW_LEFTOVERS_SETTING = "ui.showLeftovers";
/**
 * 眼睛按钮可见性的**自设上下文键**(2026-10-16):view/title 标题按钮对 `config.*` when 的
 * 重渲染不可靠(用户实测图标变动不复现修复;部署 manifest 核对在位),可见性换由扩展
 * `setContext` 推送的此键驱动,设置只作持久层。与 UI_SHOW_LEFTOVERS_SETTING 保持同步
 * (眼睛命令/激活回填/设置页变更监听三处)。
 */
export const LEFTOVERS_SHOWN_CONTEXT = "ros2.sidebar.leftoversShown";
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
/** 右键「打开安装侧文件」(2026-10-16;软链行打开链路径=链跳链,实体行打开实体;严格限定 install/) */
export const SIDEBAR_OPEN_INSTALL_COMMAND = "ROS2.sidebar.openInstallSide";

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
    // 2026-10-17:改走工作台 `vscode.open` 路由(原 openTextDocument+showTextDocument 强制按文本打开,
    // 二进制落点如 ELF 可执行直接被拒"文件似乎是二进制文件"→ 命令报错)。vscode.open 尊重用户编辑器
    // 关联:文本 → 文本编辑器;二进制 → 二进制占位/用户安装的十六进制编辑器。预览标签/焦点保持语义不变。
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath), {
        preview: true,
        preserveFocus: true,
    } as vscode.TextDocumentShowOptions);
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
        // 时间戳显示瞬间现查(2026-10-16 时间戳自愈体系):文件行在被渲染的当下 stat 源侧 + lstat 指针侧,
        // tooltip 以当下值经 rowTooltip 同源重建——任何重绘即愈合;现查值写回节点,供点击探针比对"显示值"。
        // 2026-10-16 终版(指针/数据模型,用户定义):**恒双行**,落点修改时间 = 指针本体时间——
        // 叶子链行(link=true)指针 = 链自身;经目录链行(link=false+viaLinkPath)指针 = 上游目录链
        // (lstat 它 = 目录链建立时刻 ≈ 安装时刻;lstat 叶子会穿透目录链拿回数据时间,那不是指针的);
        // 实体行指针 = 文件自身。源侧仍 statSync(数据时间)。悬空行照常(链本体存在,其时刻是事实)。
        // 运行语义另口:陈旧警告(notifyStaleIfNeeded)保持 statSync 跟随不动。
        if (node.kind === "file") {
            const pointerPath = node.link === true ? node.installPath : node.viaLinkPath ?? node.installPath;
            if (pointerPath !== undefined && pointerPath !== "") {
                try {
                    node.installMtimeMs = fs.lstatSync(pointerPath).mtimeMs;
                } catch {
                    node.installMtimeMs = undefined;
                }
            }
            if (node.sourcePath !== undefined && node.sourcePath !== "") {
                try {
                    node.sourceMtimeMs = fs.statSync(node.sourcePath).mtimeMs;
                    // 现查成功必须清除旧标记(2026-10-16 误报根治):装配层冻结的 sourceMissing
                    // 否则跨渲染永久存活(⚠ 误报根因,见 README 同日条)
                    node.sourceMissing = false;
                } catch {
                    node.sourceMtimeMs = undefined;
                    node.sourceMissing = true;
                }
            }
            const clickInstallSide = node.area === "include" && node.generated === true;
            item.tooltip =
                rowTooltip(node as unknown as DisplayRow) +
                (clickInstallSide
                    ? `\n${vscode.l10n.t("Generated header (source in build) - click opens the INSTALL-side file; no src/build jump")}`
                    : "");
        }
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
        // P2/P3 环境门(**回退层**——views.when 的隐藏不可信,视图无论为何仍可见时):
        // 门关显示消息行、不扫描;门翻转由 onEnvChanged 订阅触发整树重绘(告知层)。
        const envIssue = composeApi.environment.getEnvIssue();
        if (envIssue !== null) {
            this.setViewDescription(undefined);
            this.resetViewTitle();
            return [{ kind: "message", label: vscode.l10n.t("ROS 2 environment unavailable"), description: envIssue }];
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
        // C 类源失效标记(2026-10-13):fs 收在装配层,树/图标决策保持纯函数;浅拷贝行注入,不改 resolver 共享视图。
        // 2026-10-16(时间戳自愈体系):双 mtime 的 stat 迁往 getTreeItem 显示瞬间现查(任何重绘即愈合),
        // 装配层只保留 sourceMissing 的存在性检查(每行 2 stat → 1 existsSync)。
        const marked = views.map((v) => ({
            ...v,
            rows: v.rows.map((r) => {
                const out: SidebarRow & { sourceMissing?: boolean } = { ...r };
                if (r.sourcePath !== undefined && r.sourcePath !== "" && !fs.existsSync(r.sourcePath)) {
                    out.sourceMissing = true; // 源不存在 = C 类源失效(与图标判定同源)
                }
                return out;
            }),
        }));
        const roots = buildTree(marked, this.boundRoot, { showLeftovers });
        this.reindexFileNodes(roots);
        return roots;
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
     * 点击行探针分诊(2026-10-14「点击行即复核」;2026-10-16 扩为探针分诊):
     * **扫描的唯一前件 = 探针实测到差异**,分诊如下——
     *  · install 状态(丢失/悬空)/ src 丢失 → 该包 `refreshIncremental`(替代原全量;手工变化不写 rc,
     *    强制包 = 跳过门的否决,证据由探针实测提供);
     *  · 安装时间 ≠ 显示值 → 重画该行 + 该包增量(install/ 被动过 = 世界移动的实测证据);
     *  · 源时间 ≠ 显示值 → 仅重画该行(源文件不是中心数据,扫描服务不到);
     *  · 无差异 → 零动作(数据不变页面必须静止)。防重扫圈定维持(仅 installed/missing 行)。
     *  mtime 差异自 2026-10-16 起算差异(推翻 10-14「mtime 差异不构成不一致」)。
     */
    probeRowOnClicked(node: TreeNode): void {
        if (node.kind === "package") {
            this.probePackageOnClicked(node);
            return;
        }
        if (node.kind !== "file") {
            return;
        }
        if (node.status !== "installed" && node.status !== "missing") {
            return; // generated/source-unresolved 非 fs 可证语义,跳过(防每次点击误触发重扫循环)
        }
        let diverged = false; // 探针实测到差异(前件纪律);尾部统一定向重绘,显示层冻结当场愈合
        if (node.installPath !== undefined && node.installPath !== "") {
            const fresh = probeRowState(node.installPath, node.sourcePath);
            if (rowStateStale(node, fresh)) {
                log.info(vscode.l10n.t("Row state changed since snapshot (click re-check) - incremental rescan: {0}", node.label));
                this.refreshIncrementalForPkg(node.pkg);
                diverged = true;
            }
        }
        // 源时间探针:第一类(generated)不探——其"源"是 build 中间物,不展示也不构成报警
        if (node.generated !== true && node.sourcePath !== undefined && node.sourcePath !== "") {
            try {
                if (node.sourceMtimeMs !== fs.statSync(node.sourcePath).mtimeMs) {
                    diverged = true; // 源时间变:尾部定向重画,现读即时愈合
                }
            } catch {
                // 探不到 = 不下结论(sourceMissing 已由状态核对管)
            }
        }
        if (node.dangling !== true && node.installPath !== undefined && node.installPath !== "") {
            try {
                // 与显示同口径:指针本体时间(叶子链=链自身,目录链行=上游链,实体=文件自身);
                // 悬空行 mtime 探针维持跳过(B 类徽标已承载)
                const pointerPath = node.link === true ? node.installPath : node.viaLinkPath ?? node.installPath;
                if (pointerPath !== undefined && node.installMtimeMs !== fs.lstatSync(pointerPath).mtimeMs) {
                    log.info(vscode.l10n.t("Install side moved since render (click probe) - incremental rescan: {0}", node.label));
                    this.refreshIncrementalForPkg(node.pkg);
                    diverged = true;
                }
            } catch {
                // 探不到:missing 语义已由状态核对管
            }
        }
        if (diverged) {
            this.emitter.fire(node); // 定向重绘:getTreeItem 现查即时愈合(不依赖指纹事件)
        }
    }

    /** 包节点点击核对(2026-10-16):构建时间显示值 vs rc 瞬时值,不一致 → 该包增量重扫 */
    private probePackageOnClicked(node: TreeNode): void {
        if (node.pkg === undefined || node.pkg === "" || node.buildTimeMs === undefined || this.center === undefined) {
            return;
        }
        const buildRoot = this.center.getState()?.buildRoot;
        if (buildRoot === undefined) {
            return;
        }
        try {
            const st = fs.statSync(`${buildRoot}/${node.pkg}/colcon_build.rc`);
            if (st.isFile() && st.mtimeMs !== node.buildTimeMs) {
                log.info(vscode.l10n.t("Package build time changed since render (click probe) - incremental rescan: {0}", node.pkg));
                this.refreshIncrementalForPkg(node.pkg);
            }
        } catch {
            // 无 rc/探不到 = 不下结论
        }
    }

    /** 探针确认差异所在包 → 增量重扫(前件纪律:仅探针实测到差异后调用;措辞遵「非无条件重扫」铁律) */
    private refreshIncrementalForPkg(pkg: string | undefined): void {
        if (this.center !== undefined && pkg !== undefined && pkg !== "") {
            void this.center.refreshIncremental([pkg]);
            return;
        }
        this.refreshManually(); // 无包语境(理论不可达:file/包节点必带 pkg)→ 退回全量权威
    }

    /** sourcePath → 文件节点索引(2026-10-16;Ctrl+S 定向 fire 用,每轮根装配重建) */
    private readonly fileNodeIndex = new Map<string, TreeNode>();

    /** 探针路径键:统一正斜杠(编辑器 fsPath 在 Windows 形态下可能带反斜杠;Linux 恒一致) */
    private static normalizePathKey(p: string): string {
        return p.replace(/\\/g, "/");
    }

    private reindexFileNodes(roots: TreeNode[]): void {
        this.fileNodeIndex.clear();
        const walk = (nodes: TreeNode[]): void => {
            for (const n of nodes) {
                if (n.sourcePath !== undefined && n.sourcePath !== "") {
                    this.fileNodeIndex.set(InstallTruthSidebarProvider.normalizePathKey(n.sourcePath), n);
                }
                if (n.children !== undefined) {
                    walk(n.children);
                }
            }
        };
        walk(roots);
    }

    /**
     * Ctrl+S 定向重渲染(2026-10-16 时间戳自愈体系):保存的文件在树上 → fire 该行,
     * VS Code 只重渲染该行 → getTreeItem 现查 → tooltip 即新(编辑器事件,零 watcher 零轮询);
     * 不在树上(视图外的文件)→ 忽略。绕过编辑器的修改不触发本事件,等下一次任意渲染懒自愈。
     */
    fireNodeForSavedFile(fsPath: string): void {
        const node = this.fileNodeIndex.get(InstallTruthSidebarProvider.normalizePathKey(fsPath));
        if (node !== undefined) {
            this.emitter.fire(node);
        }
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
export function registerInstallTruthSidebar(
    context: vscode.ExtensionContext,
    // P2:getter 注入(壳先于 package-core 构造注册;构造后闭包活读)
    getData: () => BuildDataSource | null
): vscode.Disposable[] {
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
    // 2026-10-16 换挂**自设 context key**(用户实测"图标变动仍未修复"):view/title 标题按钮对
    // `config.*` when 的重渲染不可靠(部署 manifest 已核对在位仍复现)——可见性改由扩展推送的
    // `ros2.sidebar.leftoversShown` 上下文键驱动(setContext 触发的上下文刷新是同一服务里的可靠路径),
    // `ROS2.ui.showLeftovers` 设置只作持久层(设置页同键不变);激活时按设置回填一次上下文。
    const syncLeftoversContext = (value: boolean): void => {
        void vscode.commands.executeCommand("setContext", LEFTOVERS_SHOWN_CONTEXT, value);
    };
    syncLeftoversContext(vscode.workspace.getConfiguration("ROS2").get<boolean>(UI_SHOW_LEFTOVERS_SETTING, false));
    const setLeftoversVisible = (value: boolean): void => {
        syncLeftoversContext(value); // 先切上下文(图标立即换),持久化随后
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
    // 设置页直接改键也要跟上(上下文回填;眼睛命令路径已含)
    const leftoversConfigSync = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`ROS2.${UI_SHOW_LEFTOVERS_SETTING}`)) {
            const value = vscode.workspace.getConfiguration("ROS2").get<boolean>(UI_SHOW_LEFTOVERS_SETTING, false);
            syncLeftoversContext(value);
            provider.refresh();
        }
    });

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
    // 2026-10-18(P1):入统一命令围栏——门关一句拒绝(与执行层同键),不再陪跑参数弹窗+写记忆。
    const runGate = { getIssue: () => composeApi.environment.getEnvIssue(), refuse: GATE_REFUSALS.execute };
    const runExecutable = registerGatedCommand(SIDEBAR_RUN_EXECUTABLE_COMMAND, runGate, async (...args: unknown[]) => {
        const payload = runPayloadOf(args[0] as TreeNode);
        if (payload === undefined) {
            log.warn(vscode.l10n.t("Run button got no target (node not runnable or missing pkg); ignored"));
            return;
        }
        await runExecutableFromTree({ pkg: payload.pkg, executable: payload.label });
    });
    const launchFile = registerGatedCommand(SIDEBAR_LAUNCH_FILE_COMMAND, runGate, async (...args: unknown[]) => {
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
    // (套用选择记忆不弹窗;被 COLCON_IGNORE 的包提示不放行)。2026-10-18(P1):入统一命令围栏。
    const buildPackage = registerGatedCommand(SIDEBAR_BUILD_PACKAGE_COMMAND, { getIssue: () => composeApi.environment.getEnvIssue(), refuse: GATE_REFUSALS.build }, async (...args: unknown[]) => {
        const node = args[0] as TreeNode | undefined;
        if (node === undefined || node.kind !== "package" || node.pkg === undefined || node.pkg === "") {
            log.warn(vscode.l10n.t("Build-this-package got no package name (not a package node); ignored"));
            return;
        }
        await buildSinglePackageByName(getData(), node.pkg, "release");
    });

    // 右键「打开安装侧文件」(2026-10-16):软链行打开链路径(链跳链),实体行打开实体——严格限定 install/,
    // 与左键"跳源"(openTargetOf)互补。入口先走点击探针(与左键同款"点击即复核"),复核不妨碍打开。
    const openInstallSide = vscode.commands.registerCommand(SIDEBAR_OPEN_INSTALL_COMMAND, async (...args: unknown[]) => {
        const node = args[0] as TreeNode | undefined;
        if (node === undefined || node.installPath === undefined || node.installPath === "") {
            log.warn(vscode.l10n.t("Open-install-side got no landing path (row has no install target); ignored"));
            return;
        }
        provider.probeRowOnClicked(node);
        await openPath(node.installPath);
    });

    // 工作区文件夹变化 → 重绑并重绘(起宿主后再打开工作区也能接上)
    const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        provider.ensure();
        provider.refresh();
    });

    // Ctrl+S 定向重渲染(2026-10-16 时间戳自愈体系):编辑器事件零 watcher——保存即 fire 对应树行
    // (getTreeItem 现查即时愈合);保存视图外文件 = 索引未命中,忽略。
    const saves = vscode.workspace.onDidSaveTextDocument((doc) => provider.fireNodeForSavedFile(doc.uri.fsPath));

    // P2/P3 告知层:环境门翻转即整树重绘——已显示的视图在门关瞬间翻成"环境不可用"消息行、
    // 恢复瞬间翻回数据(不依赖用户手动刷新;views.when 的隐藏不可信,本订阅是兜底告知)。
    const envFlipListener = composeApi.environment.onEnvChanged(() => provider.refresh());

    return [view, refresh, showLeftovers, hideLeftovers, openSource, runExecutable, launchFile, buildPackage, openInstallSide, leftoversConfigSync, folders, saves, envFlipListener, provider];
}
