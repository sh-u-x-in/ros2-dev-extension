/**
 * launch 补全提供器(.launch.py / .launch / .launch.xml / .launch.yaml)
 *
 * 2026-09-05 建档:三种 launch 格式的结构补全 + 包名值补全。
 *  - 逻辑/目录全部在 launch-completion-core(纯 TS,可无头单测),本文件只做 vscode 适配:
 *    Candidate → CompletionItem、上下文 → 替换范围、PackageMap 名单注入;
 *  - LA-2(2026-09-25):可执行名值补全接线(executable=/exec=/exec:,名单经 install-truth
 *    ExecutableResolver;pkg 上下文取同调用/标签/动作块内字面量);
 *  - LA-1(2026-09-25):域门控——文档不在 VS Code 工作区根内一律早退;
 *  - LC 批次(2026-09-27,对标 xacro 补全):参数引用补全(LaunchConfiguration/'$(var ')、
 *    $() 替换命令目录、include 文件路径单层补全、include 传参名补全(跨文件)、py kwarg 名、
 *    枚举扩展、触发字符窄门控(详见 02-补全升级.md)。
 */

import * as vscode from "vscode";
import * as path from "path";
import { promises as fsp } from "fs";
import { getLogger } from "../../../logger";
import { readFollowSymlinksSetting } from "../../../vscode-utils";
import { PackageMap } from "../../shared/package-map";
import { fileInWorkspaceDomain } from "../../shared/workspace-domain";
import { ExecutableResolver } from "../../../install-truth/api";
import { acquireSharedBuildCenter } from "../../../install-truth/center/shared-center";
import * as core from "../core/launch-completion-core";
import { declaredArgs, declaredArgsPy, declaredArgsForFile, LaunchArgDecl } from "../core/launch-args";
import { scanLaunchIncludes } from "../parse/launch-py-parser";
import { resolveLaunchIncludePath } from "./launch-link-provider";

const log = getLogger("launch-completion");

// ---------- 可执行名数据源(LA-2) ----------

/** 可执行名/跳转源的窄接口(测试可注入;默认实现 = install-truth ExecutableResolver) */
export interface LaunchExecSource {
    /** 包 → 可执行名;pkg 未给出 → 全部;未就绪/无工作区 → undefined */
    execNames(pkg?: string): Promise<string[] | undefined>;
    /** pkg/executable → 源文件绝对路径(未命中 → undefined) */
    sourceOf(pkg: string, name: string): Promise<string | undefined>;
    /** 名字 → 所属包(重名可多包,排序;无 pkg 上下文的行内标包用;未就绪 → undefined) */
    ownersOf?(name: string): Promise<string[] | undefined>;
}

/** 默认实现:共享 BuildMapCenter 上的 ExecutableResolver(与 run 域/侧边栏同源)。
 *  LJ-5(2026-10-01 用户新裁定):工作区 install-truth 未命中时经 PackageMap.executablesOf
 *  兜底 CLI 名单(`ros2 pkg executables --full-path`,环境同源,系统包/未构建包通吃)——
 *  名单兜底补全;sourceOf 兜底 = 安装路径(系统域跳安装产物,工作区跳源定稿不变)。 */
export class InstallTruthExecSource implements LaunchExecSource {
    private resolver: ExecutableResolver | undefined;

    constructor(private readonly packages?: PackageMap) { }

    private ensure(): ExecutableResolver | undefined {
        if (!this.resolver) {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root === undefined) {
                return undefined;
            }
            this.resolver = new ExecutableResolver(acquireSharedBuildCenter(root).center);
        }
        return this.resolver;
    }

    async execNames(pkg?: string): Promise<string[] | undefined> {
        const r = this.ensure();
        const names = r ? (pkg !== undefined ? await r.namesOf(pkg) : await r.allNames()) : undefined;
        if (pkg !== undefined && (!names || names.length === 0) && this.packages) {
            // LJ-5:工作区名单未命中(null=未就绪/[]=空)→ CLI 兜底(系统包/未构建包)
            const entries = await this.packages.executablesOf(pkg);
            if (entries) {
                return entries.map((e) => e.name);
            }
        }
        return names ?? undefined;
    }

    async sourceOf(pkg: string, name: string): Promise<string | undefined> {
        const r = this.ensure();
        if (r) {
            const src = await r.sourcesOf(pkg, name);
            if (src && src.length > 0) {
                return src[0];
            }
        }
        // LJ-5:工作区无源 → CLI 安装路径(系统包跳安装产物;相对路径呈现由消费方兜底链承担)
        const entries = this.packages ? await this.packages.executablesOf(pkg) : undefined;
        return entries?.find((e) => e.name === name)?.path;
    }

    async ownersOf(name: string): Promise<string[] | undefined> {
        const r = this.ensure();
        if (!r) {
            return undefined;
        }
        const owners = await r.ownersOfName(name);
        return owners ?? undefined;
    }
}

// ---------- Candidate → CompletionItem ----------

function toItem(c: core.Candidate, replace?: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem(c.label, kindOf(c.kind));
    item.insertText = new vscode.SnippetString(c.insert);
    if (c.detail) {
        item.detail = c.detail;
    }
    if (c.filter) {
        item.filterText = c.filter; // 纯 ASCII(中文只在 label,不进过滤)
    }
    if (c.kind === "snippet") {
        const md = new vscode.MarkdownString();
        md.appendMarkdown("```\n" + c.insert + "\n```");
        item.documentation = md;
    } else if (c.doc) {
        item.documentation = new vscode.MarkdownString("```\n" + c.doc + "\n```");
    }
    item.sortText = c.sort;
    if (replace) {
        item.range = replace;
    }
    return item;
}

function kindOf(k: core.CandidateKind): vscode.CompletionItemKind {
    switch (k) {
        case "snippet": return vscode.CompletionItemKind.Snippet;
        case "property": return vscode.CompletionItemKind.Property;
        case "enum": return vscode.CompletionItemKind.EnumMember;
        default: return vscode.CompletionItemKind.Value;
    }
}

/** 系统包候选的 detail 标记(LJ-7:resolveCompletionItem 的跨克隆判定标记) */
const SYSPKG_DETAIL = vscode.l10n.t("System package"); // 双角色(detail 标识+比较键),同源常量

/** LJ-9 驻留门时长(用户裁定 0.5s):resolve 触发后驻留超时才取数——快速浏览时宿主会取消
 *  前一个 resolve 的 token,醒来即弃,零 CLI;停留 ≥0.5s 才发一次查询(单飞+缓存)。 */
const RESOLVE_DWELL_MS = 500;

/**
 * 包名值候选(LD-6;LJ-7 用户裁定:补全不需要每包精确路径——系统包候选 provide 阶段
 * **零目录查询**(不再触发 ros2 pkg prefix 懒取风暴,275 包 × 0.2s 实测);工作区包目录
 * 纯内存免费保留。LJ-8 命令链接实验已回滚(太绕:面板收起不可见/点击不能回显)。
 * LJ-9:路径获取 = resolve 聚焦 + 0.5s 驻留门——停留才取,快速浏览零取数。
 * 行内 description=工作区包/系统包;工作区 sortText 置顶。 */
function packageItems(packages: PackageMap): vscode.CompletionItem[] {
    const names = packages.getPackageNames();
    if (names.length === 0) {
        return [];
    }
    const wsDirs = new Map(packages.getWorkspaceEntries().map(e => [e.name, e.dir]));
    return core.pkgValueCandidates(names).map(c => {
        const it = toItem(c);
        const name = String(it.label);
        const wsDir = wsDirs.get(name);
        const isWs = wsDir !== undefined;
        it.label = { label: name, description: isWs ? vscode.l10n.t("Workspace package") : SYSPKG_DETAIL };
        it.detail = isWs ? vscode.l10n.t("Workspace package") : SYSPKG_DETAIL;
        it.sortText = isWs ? "2_a" : "2_z";
        if (wsDir) {
            const md = new vscode.MarkdownString();
            md.appendCodeblock(wsDir);
            it.documentation = md;
        }
        return it;
    });
}

/**
 * resolveCompletionItem 共用助手(LJ-7a A 路径 + LJ-9 驻留门):系统包候选被聚焦且
 * **驻留 ≥0.5s** 才单次懒取目录填文档。宿主在焦点移动时取消前一个 resolve 的 token——
 * 醒来见取消即返回,零取数;PackageMap.resolvePackageDir 自带单飞 + 缓存,重复聚焦零开销。
 */
async function resolvePkgDocItem(
    item: vscode.CompletionItem,
    packages: PackageMap,
    token: vscode.CancellationToken
): Promise<vscode.CompletionItem> {
    if (item.detail !== SYSPKG_DETAIL || token.isCancellationRequested) {
        return item;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, RESOLVE_DWELL_MS));
    if (token.isCancellationRequested) {
        return item; // 驻留门:用户已离开(宿主取消),零取数
    }
    const name = typeof item.label === "string" ? item.label : item.label.label;
    const dir = await packages.resolvePackageDir(name);
    if (dir && !token.isCancellationRequested) {
        const md = new vscode.MarkdownString();
        md.appendCodeblock(dir.fsPath);
        item.documentation = md;
    }
    return item;
}

/** 可执行名值候选(LA-2;2026-10-01 用户裁定终稿:行内 description=包内相对源路径
 *  (无源兜底所属包名)、悬浮文档=完整绝对路径;无 pkg 上下文经 ownersOf 反查标包)。
 *  行内信息走 label.description(紧跟名字的淡字,确定渲染)——item.detail 的行内
 *  右对齐淡显区在建议列表不渲染(用户两轮实测),只在顶部折叠栏出现。 */
async function execItems(
    packages: PackageMap,
    exec: LaunchExecSource,
    pkg: string | undefined
): Promise<vscode.CompletionItem[]> {
    const names = await exec.execNames(pkg);
    if (!names || names.length === 0) {
        return [];
    }
    return Promise.all(names.map(async n => {
        const it = toItem(core.execValueCandidates([n])[0]);
        const owner = pkg ?? (await exec.ownersOf?.(n))?.[0];
        const src = owner ? await exec.sourceOf(owner, n) : undefined;
        let rel: string | undefined;
        if (src && owner) {
            const dir = packages.get(owner)?.fsPath;
            const r = dir ? path.relative(dir, src) : undefined;
            // 展示口径统一正斜杠(launch/ROS 惯例;Windows 本地开发亦一致)
            rel = r && !r.startsWith("..") && !path.isAbsolute(r) ? r.replace(/\\/g, "/") : undefined;
        }
        it.detail = owner ?? vscode.l10n.t("Executable name");
        if (owner) {
            it.label = { label: n, description: rel ?? owner };
        }
        if (src) {
            // 悬浮文案(用户裁定格式):`包名包的包内相对路径`(相对化失败兜底 basename)
            const md = new vscode.MarkdownString();
            md.appendText(owner ? `${owner}包的${rel ?? path.basename(src)}` : src);
            it.documentation = md;
        }
        return it;
    }));
}

/** offset → Position(同一文档快捷方式) */
function pos(document: vscode.TextDocument, offset: number): vscode.Position {
    return document.positionAt(offset);
}

// =====================================================================
// Python(.launch.py)
// =====================================================================

export class LaunchPyCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private packages: PackageMap,
        private exec: LaunchExecSource = new InstallTruthExecSource()
    ) { }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context?: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        // LA-1:域外文档(系统包等)不解析
        if (!fileInWorkspaceDomain(document.uri)) {
            return [];
        }
        const text = document.getText();
        const offset = document.offsetAt(position);

        // LJ-4 触发门控:"/" 仅 join 路径与 filename 参数文件路径(LJ-6);"/" 之外同前;"=" 仅属性值
        const trig = context && context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
            ? context.triggerCharacter
            : undefined;
        const joinCtx = core.pyJoinPathContextAt(text, offset);
        if (trig === "/" && !joinCtx && core.pyValueSource(core.pyAttrContextAt(text, offset)?.attr ?? "") !== "params-path") {
            return undefined;
        }
        if (trig === "(" && !joinCtx && !core.pyAttrContextAt(text, offset) && !core.pyKwargNameContextAt(text, offset)) {
            return undefined;
        }
        if (trig === "=" && !core.pyAttrContextAt(text, offset)) {
            return undefined;
        }

        // ⓪ LJ-4:os.path.join(get_package_share_directory('pkg'), …) 末段路径补全(P2 移交)
        if (joinCtx) {
            const items = await joinPathCandidates(this.packages, joinCtx);
            if (items.length > 0 || trig === "/") {
                return items; // LD-2 口径:不设 range(词边界替换,前缀与已输段不抹)
            }
            return [];
        }

        // ① kwarg 值补全(引号触发):package= → 包名;executable= → 可执行名;
        //    LaunchConfiguration(' → 参数名(LC-2);output=/respawn= → 枚举(LC-7)
        const attrCtx = core.pyAttrContextAt(text, offset);
        if (attrCtx) {
            const range = new vscode.Range(pos(document, attrCtx.valueStart), position);
            if (attrCtx.attr === "arg-ref") {
                const decls = declaredArgsPy(text);
                return core.argRefCandidates(decls).map(c => toItem(c, range));
            }
            const src = core.pyValueSource(attrCtx.attr);
            if (src === "pkg") {
                return packageItems(this.packages).map(it => {
                    it.range = range;
                    return it;
                });
            }
            if (src === "exec") {
                const ctx = core.enclosingPyCall(text, offset);
                const pkg = ctx ? core.pyStringKwargInCall(text, ctx.open, offset, "package") : undefined;
                return (await execItems(this.packages, this.exec, pkg)).map(it => {
                    it.range = range;
                    return it;
                });
            }
            if (src === "output") {
                return core.outputEnumCandidates().map(c => toItem(c, range));
            }
            if (src === "bool") {
                return core.enumValueCandidates(["True", "False"], "布尔取值").map(c => toItem(c, range));
            }
            if (src === "params-path") {
                // LJ-6:SetParametersFromFile(filename= → 参数文件路径补全
                const prefix = text.slice(attrCtx.valueStart, offset);
                const pathOk = prefix.indexOf("${") < 0 && prefix.lastIndexOf("$(") <= prefix.lastIndexOf(")");
                if (pathOk) {
                    return includeFileCandidates(this.packages, document, prefix, paramsFileFilter);
                }
                return [];
            }
            // LD-2:name= 等无值目标不再 return [] 拦截,放行后续链路(值在串内,结构补全由 inPyString 拦)
        }

        // ①.5 LC-5:launch_arguments={' 键位 → 目标文件声明的参数名(跨文件)
        if (this.packages) {
            const ctx = core.enclosingPyCall(text, offset);
            if (ctx && ctx.call === "IncludeLaunchDescription") {
                const seg = text.slice(ctx.open + 1, offset);
                const km = /launch_arguments\s*=\s*\{\s*(['"])([^'"]*)$/.exec(seg);
                if (km) {
                    const includes = scanLaunchIncludes(text, document.uri, this.packages);
                    const inc = includes.find(i => i.start > ctx.open && i.target);
                    if (inc?.target) {
                        const decls = await argsOfTarget(inc.target);
                        if (decls) {
                            const range = new vscode.Range(pos(document, offset - km[2].length), position);
                            return core.argRefCandidates(decls).map(c => toItem(c, range));
                        }
                    }
                    return [];
                }
            }
        }

        // ①.55 LJ-4:remappings=[ / parameters=[ 列表项 snippet
        const listCtx = core.pyKwargListContextAt(text, offset);
        if (listCtx) {
            return core.pyListSnippetCandidates(listCtx).map(c => toItem(c, new vscode.Range(position, position)));
        }

        // ①.6 kwarg 名补全(LC-6):领域调用内、名位(排除值位与已键入 kwarg)
        const kw = core.pyKwargNameContextAt(text, offset);
        if (kw) {
            const items = core.pyKwargCandidates(kw.call, kw.prefix, kw.exclude).map(c => toItem(c));
            if (items.length > 0) {
                const word = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
                return items.map(it => {
                    it.range = word ?? new vscode.Range(position, position);
                    return it;
                });
            }
            return [];
        }

        // ② 结构补全:打字中(词前缀命中目录);跳过字符串字面量内
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!wordRange) {
            return [];
        }
        if (inPyString(text, document.offsetAt(wordRange.start))) {
            return [];
        }
        const prefix = document.getText(wordRange);
        return core.pyStructureCandidates(prefix).map(c => toItem(c, wordRange));
    }

    async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
        return resolvePkgDocItem(item, this.packages, token);
    }
}

/** 粗略字符串字面量判定(单双引号奇偶互斥,忽略转义与三引号;LD-2 起双引号同样拦结构补全) */
function inPyString(text: string, offset: number): boolean {
    let single = false;
    let double = false;
    let last = "";
    for (let i = 0; i < offset && i < text.length; i++) {
        const c = text[i];
        if (c === "'" && !double && last !== "\\") {
            single = !single;
        } else if (c === '"' && !single && last !== "\\") {
            double = !double;
        }
        last = c;
    }
    return single || double;
}

// =====================================================================
// XML(.launch / .launch.xml)
// =====================================================================

export class LaunchXmlCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private packages: PackageMap,
        private exec: LaunchExecSource = new InstallTruthExecSource()
    ) { }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context?: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | undefined> {
        // LA-1:域外文档(系统包等)不解析
        if (!fileInWorkspaceDomain(document.uri)) {
            return undefined;
        }
        const text = document.getText();
        const offset = document.offsetAt(position);
        const cursor = core.xmlCursorAt(text, offset);
        if (!cursor) {
            return undefined;
        }

        // LC-9 触发窄门控:"(" 仅未闭合 $() 内;"/" 仅 include file 与 param from 值(LJ-2 起)
        const trig = context && context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
            ? context.triggerCharacter
            : undefined;
        const slashOk = cursor.kind === "attrValue"
            && ((cursor.tag === "include" && cursor.attr === "file") || (cursor.tag === "param" && cursor.attr === "from")
            || (cursor.tag === "set_parameters_from_file" && cursor.attr === "filename"));
        if (trig === "(" && !(cursor.kind === "attrValue" && core.substCommandPrefixAt(cursor.value) !== undefined)) {
            return undefined;
        }
        if (trig === "/" && !slashOk) {
            return undefined;
        }

        switch (cursor.kind) {
            case "tagName": {
                // 正在输入 <标签名:补当前父下的子元素 + 附加片段(模板/变体)
                const parent = cursor.parents.length > 0 ? cursor.parents[cursor.parents.length - 1] : undefined;
                const candidates = core.xmlChildCandidates(parent, cursor.tagPrefix);
                const extras = core.xmlExtraCandidates(cursor.tagPrefix);
                const merged = dedupeByLabel(candidates, extras);
                if (merged.length === 0) { return []; }
                const start = pos(document, Math.max(text.lastIndexOf("<", offset - 1) + 1, 0));
                return merged.map(c => toItem(c, new vscode.Range(start, position)));
            }
            case "attrValue": {
                // LC-5(先于值源):<arg name=" ∈ <include> → 目标文件声明的参数名
                if (cursor.tag === "arg" && cursor.attr === "name") {
                    const decls = await this.includeTargetArgs(document, text, offset, token);
                    if (decls) {
                        return core.argRefCandidates(decls).map(c => toItem(c, new vscode.Range(pos(document, cursor.valueStart), position)));
                    }
                }
                // LC-4:<include file=" 值 → 单层路径补全("/" 触发必达;Invoke 时有候选才出)
                if (cursor.tag === "include" && cursor.attr === "file") {
                    const pathOk = cursor.value.indexOf("${") < 0
                        && cursor.value.lastIndexOf("$(") <= cursor.value.lastIndexOf(")");
                    if (pathOk) {
                        const fileItems = await includeFileCandidates(this.packages, document, cursor.value);
                        if (fileItems.length > 0 || trig === "/") {
                            // LD-2:不设 range(xacro 母本口径)——VS Code 默认词边界只替换当前词,
                            // `$(find-pkg-share pkg)/` 前缀与已输目录段永不被抹
                            return fileItems;
                        }
                    }
                }
                // LJ-6:<set_parameters_from_file filename=" 值 → 参数文件路径(与 param from 同过滤)
                if (cursor.tag === "set_parameters_from_file" && cursor.attr === "filename") {
                    const pathOk = cursor.value.indexOf("${") < 0
                        && cursor.value.lastIndexOf("$(") <= cursor.value.lastIndexOf(")");
                    if (pathOk) {
                        const fileItems = await includeFileCandidates(this.packages, document, cursor.value, paramsFileFilter);
                        if (fileItems.length > 0 || trig === "/") {
                            return fileItems;
                        }
                    }
                }
                // LJ-2:<param from=" 值 → 参数文件单层路径补全(yaml 文件过滤)
                if (cursor.tag === "param" && cursor.attr === "from") {
                    const pathOk = cursor.value.indexOf("${") < 0
                        && cursor.value.lastIndexOf("$(") <= cursor.value.lastIndexOf(")");
                    if (pathOk) {
                        const fileItems = await includeFileCandidates(this.packages, document, cursor.value, paramsFileFilter);
                        if (fileItems.length > 0 || trig === "/") {
                            return fileItems;
                        }
                    }
                }
                const v = core.xmlValueSource(cursor.attr, cursor.value);
                if (!v) {
                    return [];
                }
                const replaceRange = new vscode.Range(pos(document, cursor.valueStart + ("keep" in v ? v.keep : 0)), position);
                if (v.source === "subst-cmd") {
                    // LC-3:$() 命令位(8 命令;插入带尾空格)——LD-2:range 只锚已敲前缀,$( 保留
                    const start = pos(document, offset - v.prefix.length);
                    return core.substCommandCandidates(v.prefix).map(c => toItem(c, new vscode.Range(start, position)));
                }
                if (v.source === "arg-ref") {
                    // LC-2:$(var 参数位 → 同文件声明的参数名——LD-2:range 只锚已敲词,$(var 前缀保留
                    const start = pos(document, offset - v.typed.length);
                    return core.argRefCandidates(declaredArgs(text, "xml")).map(c => toItem(c, new vscode.Range(start, position)));
                }
                if (v.source === "output") {
                    return core.outputEnumCandidates().map(c => toItem(c, replaceRange));
                }
                if (v.source === "bool") {
                    return core.enumValueCandidates(["true", "false"], "布尔取值").map(c => toItem(c, replaceRange));
                }
                if (v.source === "exec") {
                    // LA-2:node/node_container 的 exec= → 可执行名(pkg 上下文 = 同标签 pkg="…" 字面量,LJ-6 序无关)
                    if (cursor.tag !== "node" && cursor.tag !== "node_container") {
                        return [];
                    }
                    const pkg = core.xmlTagAttrBefore(text, offset, "pkg");
                    return (await execItems(this.packages, this.exec, pkg)).map(it => {
                        it.range = replaceRange;
                        return it;
                    });
                }
                // pkg:替换 = 值起点(保留 find-pkg-share 前缀后)到光标
                const items = packageItems(this.packages);
                for (const it of items) {
                    it.range = replaceRange;
                }
                return items;
            }
            case "attrName": {
                const candidates = core.xmlAttrCandidates(cursor.tag, cursor.attrPrefix);
                if (candidates.length === 0) { return []; }
                // 替换已键入的属性名前缀(有词);空前缀插于光标
                const word = document.getWordRangeAtPosition(position, /[A-Za-z][\w-]*/);
                return candidates.map(c => toItem(c, word ?? new vscode.Range(position, position)));
            }
            case "text": {
                // 标签体(如 <launch> 内):补父的子元素 + 附加片段(前缀命中才给,避免刷屏)
                const parent = cursor.parents.length > 0 ? cursor.parents[cursor.parents.length - 1] : undefined;
                const word = document.getWordRangeAtPosition(position, /[A-Za-z][\w-]*/);
                const prefix = word ? document.getText(word) : "";
                const candidates = core.xmlChildCandidates(parent, prefix);
                const extras = core.xmlExtraCandidates(prefix);
                const merged = dedupeByLabel(candidates, extras);
                if (merged.length === 0) { return []; }
                return merged.map(c => toItem(c, word ?? new vscode.Range(position, position)));
            }
            default:
                return [];
        }
    }

    async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
        return resolvePkgDocItem(item, this.packages, token);
    }

    /**
     * LC-5:光标位于 <include> 的子 <arg name="…"> 时,取目标文件声明的参数名。
     * 目标经 resolveLaunchIncludePath(与链接同口径);不可解析 → undefined(静默)。
     */
    private async includeTargetArgs(
        document: vscode.TextDocument,
        text: string,
        offset: number,
        token: vscode.CancellationToken
    ): Promise<LaunchArgDecl[] | undefined> {
        void token;
        if (!this.packages) {
            return undefined;
        }
        const lastLt = text.lastIndexOf("<", offset - 1);
        if (lastLt < 0) {
            return undefined;
        }
        const incOpen = text.lastIndexOf("<include", lastLt);
        if (incOpen < 0) {
            return undefined;
        }
        // arg 必须在该 include 开标签结束之后、</include> 之前(直接子元素)
        const incTagEnd = text.indexOf(">", incOpen);
        if (incTagEnd < 0 || incTagEnd > lastLt) {
            return undefined;
        }
        if (text.slice(incTagEnd + 1, lastLt).indexOf("</include") >= 0) {
            return undefined;
        }
        const incTag = text.slice(incOpen, incTagEnd + 1);
        const fm = /\bfile="([^"]+)"/.exec(incTag);
        if (!fm) {
            return undefined;
        }
        const target = await resolveLaunchIncludePath(fm[1], document.uri, this.packages, token);
        if (!target) {
            return undefined;
        }
        return argsOfTarget(target);
    }
}

/** 按 label 去重合并两组候选(children 优先,extras 补漏) */
function dedupeByLabel<T extends { label: string }>(a: T[], b: T[]): T[] {
    const seen = new Set(a.map(x => x.label));
    return a.concat(b.filter(x => !seen.has(x.label)));
}

// =====================================================================
// LC-4 include 文件路径单层补全(移植 xacro includeFileCandidates)
// =====================================================================

/** 被包含目标扩展名(launch 全格式);param from 等参数文件场景另给谓词(排除 launch 命名) */
const LAUNCH_FILE_RE = /\.(launch|launch\.xml|launch\.yaml|launch\.yml|launch\.py)$/i;
const PARAMS_FILE_RE = /\.(yaml|yml)$/i;
const paramsFileFilter = (n: string): boolean => PARAMS_FILE_RE.test(n) && !LAUNCH_FILE_RE.test(n);

/** 包名 → 根目录(fsPath;工作区/已缓存系统包同步,未缓存系统包 await 懒取) */
async function pkgDirOf(packages: PackageMap | undefined, name: string): Promise<string | undefined> {
    if (!packages) {
        return undefined;
    }
    const dir = packages.get(name) ?? (await packages.resolvePackageDir(name));
    return dir?.fsPath;
}

/**
 * include file 值的单层候选(LC-4):
 * 1) 基准目录:$(find-pkg-share pkg) / $(find pkg) / package://pkg → 包目录;相对 → 当前文件目录;绝对 → 根;
 * 2) 前缀拆 目录段 + 当前词;
 * 3) 目录在前(尾 "/" + 自动再触发续层),文件按过滤器;symlink 沿统一设置。
 * 返回 [] = 不提供(目录不存在/无权限等),绝不报错。
 */
async function includeFileCandidates(
    packages: PackageMap | undefined,
    document: vscode.TextDocument,
    prefix: string,
    fileFilter: (name: string) => boolean = n => LAUNCH_FILE_RE.test(n)
): Promise<vscode.CompletionItem[]> {
    const raw = prefix.trim();
    let base: string | undefined;
    let rest = raw;
    const findRe = /^\$\(\s*find(?:\s*-\s*pkg-share)?\s+([A-Za-z0-9_-]+)\s*\)\s*\/?(.*)$/;
    const fm = raw.match(findRe);
    const pm = raw.match(/^package:\/\/([^/]+)\/?(.*)$/);
    if (fm) {
        base = await pkgDirOf(packages, fm[1]);
        rest = fm[2];
    } else if (pm) {
        base = await pkgDirOf(packages, pm[1]);
        rest = pm[2];
    } else {
        base = path.dirname(document.uri.fsPath);
        rest = raw;
    }
    if (!base) {
        return [];
    }
    const lastSep = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\"));
    const word = lastSep >= 0 ? rest.slice(lastSep + 1) : rest;
    const dirPart = lastSep >= 0 ? rest.slice(0, lastSep) : "";
    let eff: string;
    if (/^(?:[A-Za-z]:)?[\\/]/.test(rest)) {
        eff = path.resolve(dirPart || path.parse(rest).root || "/");
    } else {
        eff = dirPart ? path.join(base, dirPart) : base;
    }
    return listDirLayer(eff, word, fileFilter);
}

/** 单层目录列举候选(LC-4/LJ-4 共用):目录在前(尾 "/" + 自动再触发续层),文件按 filter(undefined = 全部) */
async function listDirLayer(eff: string, word: string, filter: ((name: string) => boolean) | undefined): Promise<vscode.CompletionItem[]> {
    const follow = readFollowSymlinksSetting(); // 统一 walk 口径(默认 false)
    const dirNames: string[] = [];
    const fileNames: string[] = [];
    let entries;
    try {
        entries = await fsp.readdir(eff, { withFileTypes: true });
    } catch {
        return []; // 目录不存在/无权限 → 不提供
    }
    for (const en of entries) {
        if (en.name.startsWith(".")) {
            continue;
        }
        let isDir: boolean;
        if (en.isSymbolicLink()) {
            if (!follow) {
                continue;
            }
            try {
                isDir = (await fsp.stat(path.join(eff, en.name))).isDirectory();
            } catch {
                continue;
            }
        } else {
            isDir = en.isDirectory();
        }
        if (isDir) {
            dirNames.push(en.name);
        } else if (!filter || filter(en.name)) {
            fileNames.push(en.name);
        }
    }
    dirNames.sort((a, b) => a.localeCompare(b));
    fileNames.sort((a, b) => a.localeCompare(b));
    const lw = word.toLowerCase();
    const out: vscode.CompletionItem[] = [];
    for (const n of dirNames) {
        if (lw && !n.toLowerCase().startsWith(lw)) {
            continue;
        }
        const it = new vscode.CompletionItem(`${n}/`, vscode.CompletionItemKind.Folder);
        it.insertText = `${n}/`;
        it.sortText = "7_file";
        it.command = { command: "editor.action.triggerSuggest", title: "继续补全该目录" };
        out.push(it);
    }
    for (const n of fileNames) {
        if (lw && !n.toLowerCase().startsWith(lw)) {
            continue;
        }
        const it = new vscode.CompletionItem(n, vscode.CompletionItemKind.File);
        it.insertText = n;
        it.sortText = "7_file";
        out.push(it);
    }
    return out;
}

/** LJ-4:os.path.join 末段路径候选(基准 = 包 share 目录 + 已闭合段;文件不过滤——join 也用于参数/模型/配置)
 *  当前词可含目录分隔符(launch/su)→ 拆 目录段(并入基准)+ 已敲词(过滤;VS Code 词边界替换保住前缀) */
async function joinPathCandidates(
    packages: PackageMap,
    ctx: core.PyJoinPathContext
): Promise<vscode.CompletionItem[]> {
    const dir = (packages.get(ctx.pkg) ?? (await packages.resolvePackageDir(ctx.pkg)))?.fsPath;
    if (!dir) {
        return [];
    }
    const lastSep = Math.max(ctx.word.lastIndexOf("/"), ctx.word.lastIndexOf("\\"));
    const word = lastSep >= 0 ? ctx.word.slice(lastSep + 1) : ctx.word;
    const dirPart = lastSep >= 0 ? ctx.word.slice(0, lastSep) : "";
    const eff = dirPart ? path.join(dir, ...ctx.segments, dirPart) : path.join(dir, ...ctx.segments);
    return listDirLayer(eff, word, undefined);
}

// =====================================================================
// LC-5 跨文件参数声明缓存(uri+mtime)
// =====================================================================

const targetArgsCache = new Map<string, { mtime: number; decls: ReturnType<typeof declaredArgsForFile> }>();

/** 读目标 launch 文件并提取参数声明(uri+mtime 轻缓存;读取/解析失败 → undefined) */
async function argsOfTarget(target: vscode.Uri): Promise<ReturnType<typeof declaredArgsForFile> | undefined> {
    try {
        const st = await fsp.stat(target.fsPath);
        const hit = targetArgsCache.get(target.fsPath);
        if (hit && hit.mtime === st.mtimeMs) {
            return hit.decls ?? undefined;
        }
        const text = await fsp.readFile(target.fsPath, "utf8");
        const decls = declaredArgsForFile(target.fsPath, text) ?? [];
        targetArgsCache.set(target.fsPath, { mtime: st.mtimeMs, decls });
        return decls.length > 0 ? decls : undefined;
    } catch {
        return undefined;
    }
}

// =====================================================================
// YAML(.launch.yaml)
// =====================================================================

export class LaunchYamlCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private packages: PackageMap,
        private exec: LaunchExecSource = new InstallTruthExecSource()
    ) { }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context?: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | undefined> {
        // LA-1:域外文档(系统包等)不解析
        if (!fileInWorkspaceDomain(document.uri)) {
            return undefined;
        }
        const text = document.getText();
        const offset = document.offsetAt(position);
        const cursor = core.yamlCursorAt(text, offset);
        if (!cursor) {
            return undefined;
        }
        const lineStart = offset > 0 ? text.lastIndexOf("\n", offset - 1) + 1 : 0;

        // LC-9:"(" 仅未闭合 $() 内;"/" 仅 file 路径与 param 子项 from 路径(LJ-2)
        const trig = context && context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
            ? context.triggerCharacter
            : undefined;
        const slashOk = (cursor.kind === "value" && (cursor.key === "file" || cursor.key === "filename"))
            || (cursor.kind === "listValue" && cursor.parentKey === "param" && cursor.key === "from");
        if (trig === "(" && !(cursor.kind === "value" && core.substCommandPrefixAt(cursor.valuePrefix) !== undefined)) {
            return undefined;
        }
        if (trig === "/" && !slashOk) {
            return undefined;
        }

        switch (cursor.kind) {
            case "action": {
                const innerIndent = " ".repeat(cursor.indentCol + 4);
                const candidates = core.yamlActionCandidates(cursor.prefix, innerIndent, cursor.dashTyped);
                if (candidates.length === 0) { return []; }
                // LJ-7 词锚:range 只锚已敲词(空前缀 = 空区间),已敲 "- " 保留原文——
                // 覆盖 "- " 会让 VS Code 以 range 文本作过滤输入而滤空全部候选
                const startOffset = offset - cursor.prefix.length;
                const replace = new vscode.Range(pos(document, startOffset), position);
                // 分隔符兜底:敲 "-" 未打空格直接触发 → insert 前补空格避免 "-node:" 黏连
                if (cursor.dashTyped && startOffset > lineStart && !/\s/.test(text[startOffset - 1])) {
                    return candidates.map(c => {
                        const it = toItem(c, replace);
                        it.insertText = new vscode.SnippetString(" " + (it.insertText as vscode.SnippetString).value);
                        return it;
                    });
                }
                return candidates.map(c => toItem(c, replace));
            }
            case "key": {
                const out: vscode.CompletionItem[] = [];
                if (cursor.action) {
                    const keys = core.yamlKeyCandidates(cursor.action, cursor.keyPrefix);
                    const word = document.getWordRangeAtPosition(position, /[A-Za-z_][\w-]*/);
                    out.push(...keys.map(c => toItem(c, word ?? new vscode.Range(position, position))));
                } else if (!core.hasYamlRootLaunch(text)) {
                    // 顶层且尚无 launch: 根
                    const root = core.yamlRootCandidate(cursor.keyPrefix, true);
                    const word = document.getWordRangeAtPosition(position, /[A-Za-z_][\w-]*/);
                    out.push(...root.map(c => toItem(c, word ?? new vscode.Range(position, position))));
                }
                return out;
            }
            case "value": {
                const v = core.yamlValueSource(cursor.key, cursor.valuePrefix);
                if (!v) { return []; }
                const replaceRange = new vscode.Range(pos(document, cursor.valueStart + ("keep" in v ? v.keep : 0)), position);
                if (v.source === "subst-cmd") {
                    // LC-3:yaml 值内 $() 命令位——LD-2:range 只锚已敲前缀,$( 保留
                    const start = pos(document, offset - v.prefix.length);
                    return core.substCommandCandidates(v.prefix).map(c => toItem(c, new vscode.Range(start, position)));
                }
                if (v.source === "arg-ref") {
                    // LC-2:$(var 参数位 → 同文件声明的参数名——LD-2:range 只锚已敲词,$(var 前缀保留
                    const start = pos(document, offset - v.typed.length);
                    return core.argRefCandidates(declaredArgs(text, "yaml")).map(c => toItem(c, new vscode.Range(start, position)));
                }
                if (v.source === "path") {
                    // LJ-2:include file 路径单层补全(LC-4 yaml 版;LD-2 口径不设 range,词边界替换)
                    return includeFileCandidates(this.packages, document, v.prefix);
                }
                if (v.source === "params-path") {
                    // LJ-6:set_parameters_from_file filename → 参数文件路径(排除 launch 命名)
                    return includeFileCandidates(this.packages, document, v.prefix, paramsFileFilter);
                }
                if (v.source === "output") {
                    return core.outputEnumCandidates().map(c => toItem(c, replaceRange));
                }
                if (v.source === "bool") {
                    return core.enumValueCandidates(["true", "false"], "布尔取值").map(c => toItem(c, replaceRange));
                }
                if (v.source === "exec") {
                    // LA-2:node/node_container 块 exec: → 可执行名(pkg 上下文 = 同块 pkg: 字面量,LJ-6 序无关)
                    if (cursor.action !== "node" && cursor.action !== "node_container") {
                        return [];
                    }
                    const pkg = core.yamlSiblingKeyValue(text, lineStart, "pkg");
                    return (await execItems(this.packages, this.exec, pkg)).map(it => {
                        it.range = replaceRange;
                        return it;
                    });
                }
                const items = packageItems(this.packages);
                for (const it of items) {
                    it.range = replaceRange;
                }
                return items;
            }
            case "listKey": {
                // LJ-2:子列表新项("- " 已敲或空行待 "- "):整项片段 / 子键
                const innerIndent = " ".repeat(cursor.indentCol + 2);
                const candidates = core.yamlListItemCandidates(cursor.parentKey, cursor.prefix, innerIndent, cursor.dashTyped);
                if (candidates.length === 0) { return []; }
                // LJ-7 词锚:range 只锚已敲词(空前缀 = 空区间),已敲 "- " 保留原文(同 action 口径)
                const startOffset = offset - cursor.prefix.length;
                const replace = new vscode.Range(pos(document, startOffset), position);
                if (cursor.dashTyped && startOffset > lineStart && !/\s/.test(text[startOffset - 1])) {
                    return candidates.map(c => {
                        const it = toItem(c, replace);
                        it.insertText = new vscode.SnippetString(" " + (it.insertText as vscode.SnippetString).value);
                        return it;
                    });
                }
                return candidates.map(c => toItem(c, replace));
            }
            case "listValue": {
                // LJ-2:子项值位。① param 子项 from = 参数文件路径(单层;"/" 触发续层)
                if (cursor.parentKey === "param" && cursor.key === "from") {
                    const value = cursor.valuePrefix;
                    const pathOk = value.indexOf("${") < 0
                        && value.lastIndexOf("$(") <= value.lastIndexOf(")");
                    if (pathOk) {
                        const fileItems = await includeFileCandidates(this.packages, document, value, paramsFileFilter);
                        if (fileItems.length > 0 || trig === "/") {
                            return fileItems; // LD-2 口径:不设 range
                        }
                    }
                    return [];
                }
                // ② include 子 arg 的 name = 目标文件声明的参数名(LC-5 yaml 版)
                if (cursor.parentKey === "arg" && cursor.key === "name" && cursor.action === "include") {
                    const fileValue = core.yamlIncludeFileValue(text, lineStart);
                    if (fileValue) {
                        const target = await resolveLaunchIncludePath(fileValue, document.uri, this.packages, _token);
                        if (target) {
                            const decls = await argsOfTarget(target);
                            if (decls) {
                                return core.argRefCandidates(decls).map(c =>
                                    toItem(c, new vscode.Range(pos(document, cursor.valueStart), position)));
                            }
                        }
                    }
                    return [];
                }
                return [];
            }
            default:
                return [];
        }
    }

    async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
        return resolvePkgDocItem(item, this.packages, token);
    }
}

// =====================================================================
// 注册
// =====================================================================

/** 注册 launch 三格式补全提供器(LC-9:触发字符含 "(" 与 "/";窄门控在各 provider 内) */
export function registerLaunchCompletionProviders(packages: PackageMap): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    const exec = new InstallTruthExecSource(packages); // LJ-5:注入 packages 供系统包 CLI 兜底
    const pyPattern: vscode.DocumentFilter = { scheme: "file", pattern: "**/*.launch.py" };
    const xmlPatterns: vscode.DocumentFilter[] = [
        { scheme: "file", pattern: "**/*.launch" },
        { scheme: "file", pattern: "**/*.launch.xml" },
    ];
    const yamlPatterns: vscode.DocumentFilter[] = [
        { scheme: "file", pattern: "**/*.launch.yaml" },
        { scheme: "file", pattern: "**/*.launch.yml" },
    ];

    // 引号触发 kwarg/属性值补全;'<','-' 触发标签/动作;冒号触发 yaml 键后值;
    // "(" 触发 $() 命令位;"/" 触发 include 路径(窄门控在各 provider 内,未命中 → undefined)
    // LJ-4:py 增 "("(调用/值位直弹)、"="(属性值)、"/"(join 路径);yaml 增 "/"(file 路径)
    disposables.push(vscode.languages.registerCompletionItemProvider(
        pyPattern,
        new LaunchPyCompletionProvider(packages, exec),
        "'", '"', "(", "=", "/"
    ));
    disposables.push(vscode.languages.registerCompletionItemProvider(
        xmlPatterns,
        new LaunchXmlCompletionProvider(packages, exec),
        "<", "'", '"', "(", "/"
    ));
    disposables.push(vscode.languages.registerCompletionItemProvider(
        yamlPatterns,
        new LaunchYamlCompletionProvider(packages, exec),
        "'", '"', ":", "-", "(", "/"
    ));
    log.info("launch completion provider registered: py/XML/yaml (structure + package/executable/argument/substitution/path values)");
    return disposables;
}
