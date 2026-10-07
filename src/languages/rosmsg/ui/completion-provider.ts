/**
 * rosmsg(.msg/.srv/.action)类型补全提供器
 *
 * 两段式补全:
 *  - 无 "/" 前缀:补全 内置类型 + 包名(pkg/) + 完整类型(pkg/Name)
 *  - 已输入 "pkg/":补全该包下的消息名(触发字符 "/")
 *
 * 数据源来自 MessageIndex(工作区增量 + 系统包排序数组二分 + 内置/常用包静态)
 * 上下文判断基于结构模型 rosmsg-document(getCompletionContext)
 */

import * as vscode from "vscode";
import * as path from "path";
import { getLogger } from "../../../logger";
import { BUILTIN_TYPES, COMMON_PACKAGES } from "../shared/interface-data";
import { MessageIndex } from "../data/message-index";
import { getCompletionContext } from "../parse/rosmsg-document";

/** 扩展日志薄封装(带 msg-completion 模块前缀) */
const log = getLogger("msg-completion");

export class RosMessageCompletionProvider implements vscode.CompletionItemProvider {
    private index: MessageIndex;

    constructor(index: MessageIndex) {
        this.index = index;
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | undefined> {
        const lineBefore = document.lineAt(position.line).text.slice(0, position.character);

        // 顶格输入破折号时补全 "---" 分隔线(仅 .srv / .action)
        const dashMatch = lineBefore.match(/^\s*(-+)$/);
        const fileExt = path.extname(document.fileName).toLowerCase();
        if (dashMatch && (fileExt === ".srv" || fileExt === ".action")) {
            return this.completeSeparator(dashMatch[1], position);
        }

        // 基于结构模型判断:仅在"类型位置"提供补全(名称位/默认值位不补全)
        if (getCompletionContext(lineBefore) !== "type") {
            return undefined;
        }

        const prefix = this.currentPrefix(lineBefore);
        const range = new vscode.Range(
            position.line,
            position.character - prefix.length,
            position.line,
            position.character
        );

        // 触发系统索引惰性刷新(不阻塞本次补全)
        void this.index.ensureSystemFresh();
        log.trace(`补全请求:前缀="${prefix}" 文件=${document.fileName}`);

        if (prefix.includes("/")) {
            // 已输入 pkg/:按包名前缀近似匹配(本包/工作区合法/内置/系统),列匹配包的消息;
            // 1(内置类型)与 6(非法,无包名)在此排除
            const slashIdx = prefix.lastIndexOf("/");
            const pkgPrefix = prefix.slice(0, slashIdx);
            const namePrefix = prefix.slice(slashIdx + 1);
            return this.completeMessagesByPackagePrefix(pkgPrefix, namePrefix, range);
        }

        return this.completeTypes(prefix, range, document);
    }

    /** 提取行首到光标处的当前输入词(可含 "/") */
    private currentPrefix(lineBefore: string): string {
        const m = lineBefore.match(/[a-zA-Z0-9_/]*$/);
        return m ? m[0] : "";
    }

    /**
     * 无 "/" 前缀:6 层候选(数量少在前)
     *  1 内置类型 | 2 本包消息名(仅合法位置有) | 3 工作区合法包名(有 .msg,消息驱动)
     *  | 4 内置包类型(与 3 重复则消失) | 5 系统包名 | 6 非法消息名(前缀就近)
     */
    private completeTypes(
        prefix: string,
        range: vscode.Range,
        document: vscode.TextDocument
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        // 本包(合法位置才有;非法位置无第 2 项)
        const selfPkg = this.index.getPackageForFile(document.fileName);
        // 工作区合法包名(有 .msg,消息驱动)
        const wsPkgs = this.index.getWorkspacePackagesWithMsg();
        const wsPkgSet = new Set(wsPkgs);

        // L1 内置类型
        for (const [type, desc] of Object.entries(BUILTIN_TYPES)) {
            if (!type.startsWith(prefix)) {
                continue;
            }
            const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.Keyword);
            item.range = range;
            item.detail = vscode.l10n.t("Built-in type");
            item.documentation = new vscode.MarkdownString(desc);
            item.sortText = "0" + type;
            items.push(item);
        }

        // L2 本包消息名(同包引用可省略包名;仅合法位置)
        if (selfPkg) {
            for (const entry of this.index.getMessagesInPackage(selfPkg)) {
                if (entry.source !== "workspace" || entry.loose) {
                    continue;
                }
                if (!entry.name.startsWith(prefix)) {
                    continue;
                }
                const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Class);
                item.range = range;
                item.detail = vscode.l10n.t("Messages of this package ({0})", selfPkg);
                item.documentation = new vscode.MarkdownString(entry.path ? vscode.l10n.t("Defined at: `{0}`", entry.path) : vscode.l10n.t("Message of this package"));
                item.sortText = "1" + entry.name;
                items.push(item);
            }
        }

        // L3 工作区合法包名(有 .msg,消息驱动;展示 "pkg/")
        for (const pkg of wsPkgs) {
            if (!pkg.startsWith(prefix)) {
                continue;
            }
            const item = new vscode.CompletionItem(`${pkg}/`, vscode.CompletionItemKind.Module);
            item.range = range;
            item.detail = vscode.l10n.t("Workspace package");
            item.documentation = new vscode.MarkdownString(vscode.l10n.t("Valid workspace package (with messages)"));
            item.sortText = "2" + pkg;
            items.push(item);
        }

        // L4 内置包类型(与工作区合法包名重复时消失,避免重复;工作区优先)
        for (const pkg of Object.keys(COMMON_PACKAGES)) {
            if (wsPkgSet.has(pkg) || !pkg.startsWith(prefix)) {
                continue;
            }
            const item = new vscode.CompletionItem(`${pkg}/`, vscode.CompletionItemKind.Module);
            item.range = range;
            item.detail = vscode.l10n.t("ROS package");
            item.documentation = new vscode.MarkdownString(COMMON_PACKAGES[pkg]);
            item.sortText = "3" + pkg;
            items.push(item);
        }

        // L5 系统包名(ros2 interface list)
        for (const pkg of this.index.getSystemPackages()) {
            if (!pkg.startsWith(prefix)) {
                continue;
            }
            const item = new vscode.CompletionItem(`${pkg}/`, vscode.CompletionItemKind.Module);
            item.range = range;
            item.detail = vscode.l10n.t("System package");
            item.documentation = new vscode.MarkdownString(vscode.l10n.t("ROS system package"));
            item.sortText = "4" + pkg;
            items.push(item);
        }

        // L6 非法消息名(前缀就近:dem -> demo*,不会配 dom)
        for (const entry of this.index.getLooseEntriesByPrefix(prefix)) {
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Class);
            item.range = range;
            item.detail = vscode.l10n.t("Message at an invalid location");
            item.documentation = new vscode.MarkdownString(entry.path ? vscode.l10n.t("Defined at: `{0}`", entry.path) : vscode.l10n.t("Message at an invalid location"));
            item.sortText = "5" + entry.name;
            items.push(item);
        }

        return items;
    }

    /** 有 "/" 前缀:按包名前缀近似匹配(本包/工作区/内置/系统),列匹配包的消息 */
    private completeMessagesByPackagePrefix(
        pkgPrefix: string,
        namePrefix: string,
        range: vscode.Range
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const seen = new Set<string>();
        for (const entry of this.index.getEntriesByPrefix(`${pkgPrefix}/`)) {
            if (entry.loose) {
                continue; // 非法无包名,排除
            }
            const label = `${entry.pkg}/${entry.name}`;
            if (!entry.name.startsWith(namePrefix) || seen.has(label)) {
                continue;
            }
            seen.add(label);
            const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Class);
            item.range = range;
            item.detail = entry.source === "workspace" ? vscode.l10n.t("Workspace message") : vscode.l10n.t("System message");
            item.documentation = new vscode.MarkdownString(entry.path ? vscode.l10n.t("Defined at: `{0}`", entry.path) : vscode.l10n.t("ROS message type"));
            item.sortText = (entry.source === "workspace" ? "0" : "1") + label;
            items.push(item);
        }
        return items;
    }

    /** 顶格补全 "---" 分隔线(当前输入不足 3 个破折号时) */
    private completeSeparator(input: string, position: vscode.Position): vscode.CompletionItem[] {
        if (input.length >= 3) {
            return [];
        }
        const item = new vscode.CompletionItem("---", vscode.CompletionItemKind.Snippet);
        item.detail = vscode.l10n.t("Separator (request/response boundary)");
        item.insertText = "---";
        item.range = new vscode.Range(
            position.line,
            position.character - input.length,
            position.line,
            position.character
        );
        return [item];
    }
}
