// Licensed under the MIT License.

import { getLogger } from "../../../logger";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
// 2026-09-04 事件链(C):不再直连 ros2 环境域——系统刷新触发经 PackageMap.onSystemListChanged / core.onDidChange(ev.system)
import { getPackageCore } from "../../../build-tool/package-core/api";
import { BUILTIN_TYPES, COMMON_PACKAGES, isBuiltinType } from "../shared/interface-data";
import { MessageIndex } from "../data/message-index";
import { parseRosMessageDocument } from "../parse/rosmsg-document";
import { RosMessageCompletionProvider } from "./completion-provider";
import { registerRosMessageDiagnostics } from "./diagnostic-provider";
import { formatRosMessageContent } from "../parse/formatter";
import type { PackageMap } from "../../shared/package-map";

/** 扩展日志薄封装(带 msg-providers 模块前缀) */
const log = getLogger("msg-providers");

/**
 * 共享包路径解析实例(2026-09-03 完善:组合根注册时注入共享 PackageMap)。
 * 系统包目录经 PackageMap.resolvePackageDir 懒取(单飞 + 缓存),语言域不再各自调 pkg_list/pkg_prefix。
 */
let sharedPackageMap: PackageMap | undefined;

export interface MessageField {
    type: string;
    /** 含数组括号的完整类型(如 "int32[3]"),用于类型区间计算 */
    typeRaw?: string;
    name: string;
    arraySize?: string;
    defaultValue?: string;
    isConstant: boolean;
    comment?: string;
    line: number;
    column: number;
}

export interface ParsedMessage {
    fields: MessageField[];
    comments: Map<number, string>;
}

/**
 * 消息文件解析结果的缓存条目
 */
interface ParsedMessageCacheEntry {
    version: number;
    parsed: ParsedMessage;
}

/**
 * 消息文件解析结果缓存,避免重复解析
 * 上限 100 条,防止内存无限增长
 */
const parsedMessageCache = new Map<string, ParsedMessageCacheEntry>();
const MAX_CACHE_SIZE = 100;

/**
 * 解析 ROS 消息/服务文件(带缓存)
 * 基于结构模型 parseRosMessageDocument,拍平为旧接口字段列表
 */
export function parseMessageFile(document: vscode.TextDocument): ParsedMessage {
    const cacheKey = document.uri.toString();
    const cachedEntry = parsedMessageCache.get(cacheKey);

    // 文档版本未变化时直接返回缓存结果
    if (cachedEntry && cachedEntry.version === document.version) {
        log.trace(vscode.l10n.t("Message parse cache hit: {0}", cacheKey));
        return cachedEntry.parsed;
    }

    log.trace(vscode.l10n.t("Parsing message file: {0}", cacheKey));
    // 结构解析 → 拍平字段
    const doc = parseRosMessageDocument(document);
    const fields: MessageField[] = doc.sections.flatMap(s => s.fields).map(f => ({
        type: f.type.base,
        typeRaw: f.type.raw,
        name: f.name,
        arraySize: f.type.arraySize,
        defaultValue: f.defaultValue?.trim(),
        isConstant: f.kind === "constant",
        comment: f.comment,
        line: f.line,
        column: f.typeColumn
    }));
    const parsed = { fields, comments: doc.comments };

    // 缓存满时按 FIFO 淘汰最旧条目
    if (parsedMessageCache.size >= MAX_CACHE_SIZE) {
        const firstKey = parsedMessageCache.keys().next().value;
        if (firstKey) {
            log.debug(vscode.l10n.t("Message parse cache full; evicting oldest entry: {0}", firstKey));
            parsedMessageCache.delete(firstKey);
        }
    }

    log.debug(vscode.l10n.t("Message parse result cached: {0}, {1} fields", cacheKey, fields.length));
    parsedMessageCache.set(cacheKey, { version: document.version, parsed });
    return parsed;
}

/**
 * 从限定类型中提取包名与消息名(例如 "geometry_msgs/Point")
 */
function parseQualifiedType(type: string): { package?: string; message: string } {
    const parts = type.split('/');
    if (parts.length === 2) {
        return { package: parts[0], message: parts[1] };
    }
    return { message: type };
}

/**
 * 查找消息定义文件(rosmsg-v3.md §5;2026-09-13 三张表重构:删除 walk 兜底——索引即权威)。
 *
 * 带包名:① 正表精确命中(内层二分,零扫描);② 未命中 → 经 PackageMap 解析包目录,
 *         按标准布局 <pkgDir>/msg/<Name>.msg 点查(系统包懒取目录,不再 walk)。
 * 裸名(无包名):① 反表点查当前文件 → 本包 → 正表按名查(命中「非法包」桶照常查,出得去);
 *         ② miss 补登(把当前 .msg 登记进索引)后重查;③ 未命中 → 本包目录标准布局点查。
 */
async function findMessageDefinitions(
    packages: PackageMap | undefined,
    index: MessageIndex | undefined,
    packageName?: string,
    messageName?: string,
    fromFilePath?: string
): Promise<vscode.Uri[]> {
    log.debug(vscode.l10n.t("Looking up message definition: pkg={0}, message={1}, current file={2}", packageName || vscode.l10n.t("(any)"), messageName || vscode.l10n.t("(any)"), fromFilePath || vscode.l10n.t("(none)")));

    // ① 带包名:正表精确命中(工作区;零扫描)→ miss 触发系统带路径懒登记(RM-1:触碰即登记整包)
    if (index && packageName && messageName) {
        const hit = index.findMessage(packageName, messageName);
        if (hit?.path) {
            log.debug(vscode.l10n.t("Message definition index hit: {0}/{1} -> {2} (zero scan)", packageName, messageName, hit.path));
            return [vscode.Uri.file(hit.path)];
        }
        try {
            const sysHit = await index.findMessageWithSystemPath(packageName, messageName);
            if (sysHit?.path) {
                log.debug(vscode.l10n.t("Message definition system registry hit: {0}/{1} -> {2} (RM-1)", packageName, messageName, sysHit.path));
                return [vscode.Uri.file(sysHit.path)];
            }
        } catch {
            // 登记失败(目录未解析等)→ 静默,走 ③ 点查兜底
        }
    }
    // 带包名但未给消息名:返回该包全部工作区消息(兼容分支)
    if (index && packageName && !messageName) {
        const all = index.getMessagesInPackage(packageName).filter((e) => !!e.path);
        if (all.length > 0) {
            return all.map((e) => vscode.Uri.file(e.path!));
        }
    }

    // ② 裸名:反表点查(本包/非法包桶)→ 正表按名查;miss 补登后重查(v3 §5.3)
    let barePkg: string | undefined;
    if (!packageName && messageName && fromFilePath) {
        const defPath = index ? await index.findBareNameDefinition(fromFilePath, messageName) : undefined;
        if (defPath) {
            log.debug(vscode.l10n.t("Bare-name resolution hit: {0} -> {1} (reverse table point query + forward table inner binary search)", messageName, defPath));
            return [vscode.Uri.file(defPath)];
        }
        barePkg = index?.getPackageForFile(fromFilePath); // 补登后的本包(非法包/未能归属 → undefined)
    }

    // ③ 标准布局点查兜底(工作区源码包 / 系统安装包 share/<pkg>/msg;不再是 walk)
    const targetPkg = packageName ?? barePkg;
    if (targetPkg && messageName && packages) {
        const pkgDir = await packages.resolvePackageDir(targetPkg);
        if (pkgDir) {
            const msgFilePath = path.join(pkgDir.fsPath, "msg", `${messageName}.msg`);
            if (fs.existsSync(msgFilePath)) {
                log.debug(vscode.l10n.t("Message definition standard-layout hit: {0}/{1} -> {2}", targetPkg, messageName, msgFilePath));
                return [vscode.Uri.file(msgFilePath)];
            }
        } else if (packageName) {
            log.debug(vscode.l10n.t("Package directory miss (in neither workspace nor system registry, or environment not ready): {0}", packageName));
        }
    }

    log.debug(vscode.l10n.t("Message definition miss: pkg={0}, message={1}", packageName || vscode.l10n.t("(bare)"), messageName || vscode.l10n.t("(any)")));
    return [];
}

/**
 * ROS 消息文件的跳转定义提供器
 */
export class RosMessageDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private index: MessageIndex) { }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        const parsed = parseMessageFile(document);

        // 查找光标所在行的字段
        const field = parsed.fields.find(f => f.line === position.line);
        if (!field) {
            return undefined;
        }

        // 判断光标是否位于字段的类型部分(含数组括号,如 "int32[3]";
        // 不依赖 wordRange,因为右括号 ] 不是 word 字符)
        const typeRaw = field.typeRaw ?? field.type;
        const typeStartCol = field.column;
        const typeEndCol = typeStartCol + typeRaw.length;

        if (position.character < typeStartCol || position.character > typeEndCol) {
            return undefined;
        }

        // 内置类型不提供跳转定义
        if (isBuiltinType(field.type)) {
            return undefined;
        }

        // 解析限定类型
        const { package: pkgName, message: msgName } = parseQualifiedType(field.type);

        // 查找消息定义(索引权威,不再 walk;系统包目录经 PackageMap 懒取)
        const definitions = await findMessageDefinitions(sharedPackageMap, this.index, pkgName, msgName, document.fileName);

        if (definitions.length > 0) {
            // 返回所有匹配(或首个匹配)
            log.debug(vscode.l10n.t("Go-to-definition hit: {0} -> {1} files", field.type, definitions.length));
            return definitions.map(uri => new vscode.Location(uri, new vscode.Position(0, 0)));
        }

        return undefined;
    }
}

/**
 * 生成带属性的类型文档(辅助函数)
 */
async function generateTypeDocumentation(
    index: MessageIndex | undefined,
    typeName: string,
    arraySize?: string,
    fromFilePath?: string
): Promise<vscode.MarkdownString> {
    const markdown = new vscode.MarkdownString();
    log.trace(vscode.l10n.t("Generating type documentation: {0}", typeName));

    // 判断是否为内置类型
    if (isBuiltinType(typeName)) {
        const description = BUILTIN_TYPES[typeName];
        markdown.appendCodeblock(typeName, 'rosmsg');
        markdown.appendMarkdown(`\n${description}`);

        if (arraySize !== undefined) {
            const arrayKind = arraySize === "" ? "变长" : arraySize.startsWith("<=") ? "有界" : "定长";
            markdown.appendMarkdown(`\n\n**数组**: ${arrayKind} [${arraySize}]`);
        }

        return markdown;
    }

    // 解析限定类型以处理自定义消息
    const { package: pkgName, message: msgName } = parseQualifiedType(typeName);

    if (pkgName) {
        markdown.appendCodeblock(`${pkgName}/${msgName}`, 'rosmsg');

        // 若为已知包,附加包描述
        if (pkgName in COMMON_PACKAGES) {
            markdown.appendMarkdown(`\n**包**: ${COMMON_PACKAGES[pkgName]}`);
        } else {
            markdown.appendMarkdown(`\n**包**: ${pkgName}`);
        }
        markdown.appendMarkdown(`\n\n**消息类型**: ${msgName}`);
    } else {
        markdown.appendCodeblock(msgName, 'rosmsg');
        markdown.appendMarkdown(`\n**自定义消息类型**`);
    }

    if (arraySize !== undefined) {
        const arrayKind = arraySize === "" ? "变长" : arraySize.startsWith("<=") ? "有界" : "定长";
        markdown.appendMarkdown(`\n\n**数组**: ${arrayKind} [${arraySize}]`);
    }

    // 尝试查找并展示定义中的属性(索引权威,不再 walk;裸名走本包反表解析)
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (workspaceFolders) {
        try {
            const definitions = await findMessageDefinitions(sharedPackageMap, index, pkgName, msgName, fromFilePath);

            if (definitions.length > 0) {
                const defUri = definitions[0];
                try {
                    const defDoc = await vscode.workspace.openTextDocument(defUri);
                    const defParsed = parseMessageFile(defDoc);

                    if (defParsed.fields.length > 0) {
                        markdown.appendMarkdown('\n\n**属性**:');

                        // 生成格式化的属性列表
                        const propertyLines: string[] = [];
                        for (const defField of defParsed.fields) {
                            let fieldStr: string;

                            // 若为数组,使用数组记号格式化类型
                            if (defField.arraySize !== undefined) {
                                fieldStr = `${defField.type}[${defField.arraySize}] ${defField.name}`;
                            } else {
                                fieldStr = `${defField.type} ${defField.name}`;
                            }

                            // 附加默认值或常量值
                            if (defField.isConstant && defField.defaultValue) {
                                fieldStr += ` = ${defField.defaultValue}`;
                            } else if (defField.defaultValue) {
                                fieldStr += ` = ${defField.defaultValue}`;
                            }

                            // 若有行内注释,一并附加
                            const fieldComment = defParsed.comments.get(defField.line);
                            if (fieldComment) {
                                fieldStr += `  # ${fieldComment}`;
                            }

                            propertyLines.push(fieldStr);
                        }

                        markdown.appendCodeblock(propertyLines.join('\n'), 'rosmsg');
                    }
                } catch (err) {
                    // 忽略读取定义时的错误
                }
            }
        } catch (err) {
            // 忽略查找定义时的错误
        }
    }

    return markdown;
}

/**
 * ROS 消息文件的悬停提示提供器
 */
export class RosMessageHoverProvider implements vscode.HoverProvider {
    constructor(private index: MessageIndex) { }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        // wordRange 仅用于字段名分支;类型区间判断不依赖它(右括号 ] 非 word 字符)
        const wordRange = document.getWordRangeAtPosition(position);
        const word = wordRange ? document.getText(wordRange) : "";
        const line = document.lineAt(position.line).text;

        const parsed = parseMessageFile(document);

        // 判断是否悬停在类型上
        const field = parsed.fields.find(f => f.line === position.line);
        if (!field) {
            log.debug(vscode.l10n.t("Hover: no field on line {0} ({1} fields parsed) line text=\"{2}\"", position.line, parsed.fields.length, line));
            return undefined;
        }

        // 判断光标是否位于字段的类型部分(含数组括号,如 "int32[3]")
        const typeRaw = field.typeRaw ?? field.type;
        const typeStartCol = field.column;
        const typeEndCol = typeStartCol + typeRaw.length;

        if (position.character >= typeStartCol && position.character <= typeEndCol) {
            // 悬停在类型上
            log.trace(vscode.l10n.t("Hover: type hit {0} @{1}:{2} [{3},{4}]", field.type, position.line, position.character, typeStartCol, typeEndCol));
            const markdown = await generateTypeDocumentation(this.index, field.type, field.arraySize, document.fileName);
            return new vscode.Hover(markdown, new vscode.Range(
                position.line,
                typeStartCol,
                position.line,
                typeEndCol
            ));
        }

        // 判断是否悬停在字段名上
        const fieldNameMatch = line.match(/\s+([a-zA-Z0-9_]+)(\s*=|\s*#|\s*$)/);
        if (fieldNameMatch && word === fieldNameMatch[1]) {
            // 先展示字段声明
            log.trace(vscode.l10n.t("Hover: field name hit {0} {1}", field.type, field.name));
            const markdown = new vscode.MarkdownString();
            markdown.appendCodeblock(`${field.type} ${field.name}`, 'rosmsg');

            if (field.isConstant && field.defaultValue) {
                markdown.appendMarkdown(`\n**常量**,值为: \`${field.defaultValue}\``);
            } else if (field.defaultValue) {
                markdown.appendMarkdown(`\n**默认值**: \`${field.defaultValue}\``);
            }

            // 若有注释,展示注释(行内注释优先 field.comment,回退整行注释 parsed.comments)
            const comment = field.comment ?? parsed.comments.get(field.line);
            if (comment) {
                markdown.appendMarkdown(`\n\n${comment}`);
            }

            // 附加类型文档与属性
            markdown.appendMarkdown('\n\n---\n\n');
            const typeDoc = await generateTypeDocumentation(this.index, field.type, field.arraySize, document.fileName);
            markdown.appendMarkdown(typeDoc.value);

            return new vscode.Hover(markdown, wordRange);
        }

        log.debug(vscode.l10n.t("Hover: no type/field-name branch matched field={0} {1} cursor={2} type range=[{3},{4}]", field.type, field.name, position.character, typeStartCol, typeEndCol));
        return undefined;
    }
}

/**
 * ROS 消息文件的可点击链接提供器:点击消息类型打开定义文件
 * 基于结构模型解析,同文档内按类型去重查找定义
 */
export class RosMessageDocumentLinkProvider implements vscode.DocumentLinkProvider {
    constructor(private index: MessageIndex) { }

    async provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentLink[]> {
        const links: vscode.DocumentLink[] = [];

        // 结构模型解析
        const doc = parseRosMessageDocument(document);
        const fields = doc.sections.flatMap(s => s.fields);

        // 同文档内按类型去重查找定义,避免重复扫描
        const defCache = new Map<string, vscode.Uri | undefined>();

        for (const field of fields) {
            if (token.isCancellationRequested) {
                break;
            }
            const type = field.type.base;
            if (isBuiltinType(type)) {
                continue;
            }
            if (!defCache.has(type)) {
                defCache.set(type, await this.resolveDefinition(type, document.fileName));
            }
            const defUri = defCache.get(type);
            if (defUri) {
                const range = new vscode.Range(
                    field.line,
                    field.typeColumn,
                    field.line,
                    field.typeColumn + field.type.raw.length
                );
                links.push(new vscode.DocumentLink(range, defUri));
            }
        }
        return links;
    }

    /** 解析消息类型对应的定义文件(索引权威;裸名走本包反表解析) */
    private async resolveDefinition(
        type: string,
        fromFilePath: string
    ): Promise<vscode.Uri | undefined> {
        try {
            const { package: pkgName, message: msgName } = parseQualifiedType(type);
            const definitions = await findMessageDefinitions(sharedPackageMap, this.index, pkgName, msgName, fromFilePath);
            return definitions.length > 0 ? definitions[0] : undefined;
        } catch (err) {
            log.debug(vscode.l10n.t("Failed to parse document link: {0}", type));
            return undefined;
        }
    }
}

/**
 * ROS 消息文档格式化提供器
 */
export class RosMessageFormatter implements vscode.DocumentFormattingEditProvider {
    public provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        _options: vscode.FormattingOptions,
        _token: vscode.CancellationToken
    ): vscode.TextEdit[] {
        // 读取梯度分档步长与 @optional 单/双行切换阈值(可配置,默认 11 / 60)
        const gradientStep = vscode.workspace
            .getConfiguration("ROS2")
            .get<number>("msg.formatGradientStep", 11);
        const lineThreshold = vscode.workspace
            .getConfiguration("ROS2")
            .get<number>("msg.formatLineThreshold", 60);
        const newText = formatRosMessageContent(
            document.getText(),
            Math.max(2, gradientStep),
            Math.max(10, lineThreshold)
        );
        if (newText === document.getText()) {
            return [];
        }
        log.trace(vscode.l10n.t("Formatting rosmsg document: {0}", document.uri.toString()));
        const lastLine = document.lineCount - 1;
        const lastChar = document.lineAt(lastLine).text.length;
        const range = new vscode.Range(0, 0, lastLine, lastChar);
        return [new vscode.TextEdit(range, newText)];
    }
}

/**
 * 注册 ROS 消息语言提供器
 * @param packages 可选共享 PackageMap(2026-09-03:组合根传 xacroPackages 共享实例——定义/悬停/链接
 *   兜底的系统包目录经 resolvePackageDir 懒取(单飞 + 缓存),语言域不再各自调 pkg_list/pkg_prefix)
 */
export function registerRosMessageProviders(context: vscode.ExtensionContext, packages?: PackageMap): vscode.Disposable[] {
    sharedPackageMap = packages;
    const selector: vscode.DocumentSelector = { language: 'rosmsg', scheme: 'file' };

    // 读取系统消息索引刷新间隔(分钟,配置项)
    const refreshMinutes = vscode.workspace
        .getConfiguration("ROS2")
        .get<number>("msg.systemRefreshMinutes", 10);
    const refreshMs = Math.max(1, refreshMinutes) * 60 * 1000;

    // 消息类型索引(工作区三张表 + op 流;系统包排序数组二分)与类型补全;
    // envAvailable = 共享 PackageMap 的系统名单就绪判定(core.system 域已刷新),替代直连 ros2 getEnvIssue(2026-09-04);
    // packages 注入 = 包表来源(PackageSource:R1 快照 / R2 就绪 / R3 原子事件,rosmsg-v3.md §7.4)
    const index = new MessageIndex(context, refreshMs, packages ? () => packages.systemAvailable : undefined, packages);
    void index.initialize();
    // 节流(rosmsg-v3.md §7.2):启动取一次基线不开定时器;首次打开 .msg 才开启兜底重扫;关窗冻结(计时不归零)
    const updateRescanActive = (): void => {
        const active = vscode.workspace.textDocuments.some(
            (d) => d.languageId === "rosmsg" && d.uri.scheme === "file"
        );
        index.setRescanActive(active);
    };
    const openDocListener = vscode.workspace.onDidOpenTextDocument(updateRescanActive);
    const closeDocListener = vscode.workspace.onDidCloseTextDocument(updateRescanActive);
    updateRescanActive(); // 初始:激活时可能已有 rosmsg 文档打开

    // 语义诊断(RE-1 接电):packages 注入供三级判定的 FS 点查;reanalyzeAll 挂两处——
    // ① index.initialize() 就绪后(清除"打开瞬间索引未就绪"的过期未知类型警告);
    // ② 系统刷新事件链(下方 systemRefreshListener,防抖 1s)
    const diagnostics = registerRosMessageDiagnostics(context, index, packages);
    void index.initialize().then(() => diagnostics.reanalyzeAll());
    let reanalyzeTimer: NodeJS.Timeout | undefined;
    const scheduleReanalyze = (): void => {
        if (reanalyzeTimer) {
            clearTimeout(reanalyzeTimer);
        }
        reanalyzeTimer = setTimeout(() => diagnostics.reanalyzeAll(), 1000);
    };
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        selector,
        new RosMessageCompletionProvider(index),
        "/"
    );

    const definitionProvider = vscode.languages.registerDefinitionProvider(
        selector,
        new RosMessageDefinitionProvider(index)
    );

    const hoverProvider = vscode.languages.registerHoverProvider(
        selector,
        new RosMessageHoverProvider(index)
    );

    const documentLinkProvider = vscode.languages.registerDocumentLinkProvider(
        selector,
        new RosMessageDocumentLinkProvider(index)
    );

    const formatProvider = vscode.languages.registerDocumentFormattingEditProvider(
        selector,
        new RosMessageFormatter()
    );

    // 2026-09-04 事件链(C):系统消息刷新触发不再直连 ros2 环境——
    // 优先订阅共享 PackageMap.onSystemListChanged(core.system 域更新 → acceptSystem → 通知);
    // 无共享实例(独立/测试)时退回订阅 core.onDidChange(ev.system),仍不碰 ros2/api。
    const systemRefreshListener: vscode.Disposable = packages
        ? packages.onSystemListChanged(() => {
            void index.refreshSystemFull();
            scheduleReanalyze(); // RE-1:系统名单/位置刷新后重算诊断(系统包类型警告随之消长)
        })
        : (() => {
            const core = getPackageCore();
            if (!core) {
                return { dispose: () => undefined };
            }
            const unsub = core.onDidChange(ev => {
                if (ev.system !== undefined) {
                    void index.refreshSystemFull();
                    scheduleReanalyze();
                }
            });
            return { dispose: unsub };
        })();
    // 运行中修改刷新间隔配置 → 动态生效(不再只在激活时读一次,R5)
    const configChangeListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("ROS2.msg.systemRefreshMinutes")) {
            const minutes = Math.max(1, vscode.workspace
                .getConfiguration("ROS2")
                .get<number>("msg.systemRefreshMinutes", 10));
            index.setRefreshIntervalMs(minutes * 60 * 1000);
        }
    });

    // 建立缓存失效机制
    const documentCloseListener = vscode.workspace.onDidCloseTextDocument(document => {
        const cacheKey = document.uri.toString();
        parsedMessageCache.delete(cacheKey);
    });

    const documentChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
        // 文档变化时清除缓存条目(下次访问时重新解析)
        const cacheKey = event.document.uri.toString();
        parsedMessageCache.delete(cacheKey);
    });

    log.info(vscode.l10n.t("ROS message language providers registered: definition + hover + links + type completion + formatting + diagnostics (refresh interval {0} min)", refreshMinutes));
    return [
        definitionProvider,
        hoverProvider,
        documentLinkProvider,
        formatProvider,
        completionProvider,
        ...diagnostics.disposables,
        { dispose: () => {
            index.dispose();
            if (reanalyzeTimer) {
                clearTimeout(reanalyzeTimer);
            }
        } },
        documentCloseListener,
        documentChangeListener,
        systemRefreshListener,
        configChangeListener,
        openDocListener,
        closeDocListener
    ];
}
