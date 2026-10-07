/**
 * IncludeGraph — xacro 展开图核心(设计 00/01)
 *
 * 语义基准:xacro 顺序展开——include 按出现顺序原地展开,符号仅在"展开到定义之后"可见。
 *
 * 核心能力:
 *  - 保序展开序列 expandOrder(DFS 先序 + 环检测 + 按 root 缓存)
 *  - 入口无关根发现 findRoots(反向父链)
 *  - 宽松可见集 visibleSymbols(同文件定义在前 + 展开序之前的文件,多根并集)
 *  - 精确判定 isVisible(供 hover 标注来源链)
 *  - 宽松查找 findSymbol(同文件优先 → 跨文件 → 兜底 fire-and-forget)
 *  - 兜底反向搜索 fallback(写回父边,下次查询命中)
 *  - 系统包文件按需拉取 pullPackageFile(同步 readFileSync,限深防爆)
 *  - use-def 标定 + 单向传播 recordUseDef / propagate(property 变化 → 依赖者重解 ${} 边)
 *
 * S1-A(2026-08-18):查询链(expandOrder/visibleSymbols/isVisible/findSymbol)全同步(纯内存);
 *   IO 外置——pullPackageFile 同步 readFileSync;fallback 由调用方 fire-and-forget(不 await)。
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { forEachElement } from "../../shared/xml-utils";
import { getLogger } from "../../../logger";
import { PackageMap } from "../../shared/package-map";
// walk 统一入口:读设置/默认排除/叠加额外排除由 walkOptions 一处装配(walk/index barrel)
import { walkOptions, walkWithTimeout } from "../../../build-tool/walk";
// XG5(2026-09-24):解析统一走 parse/xacro-document 单遍模型 + uri+version 缓存(修 X-F4/X-F3)
import { parseXacroDocument, XacroDocumentStore, staticBoolean } from "../parse/xacro-document";
import type { XacroDocument } from "../parse/xacro-document";
import type { MacroParam } from "../parse/macro-params";
import { lexDollar } from "../parse/xacro-lexer";
import { scanExpression } from "../parse/expression-tokens";
import { fileInWorkspaceDomain } from "../../shared/workspace-domain";

const log = getLogger("xacro-include-graph");

// 排除产物目录:统一用共享 DEFAULT_EXCLUDED_DIR_NAMES(见 excluded-paths.ts,目录名级任意层级,与 EXCLUDE_GLOB 同口径)
const FALLBACK_DEBOUNCE_MS = 2000;
const PULL_MAX_DEPTH = 5;

/**
 * 构建行起始偏移索引:lineStarts[i] = 第 i 行(0 基)起始字符偏移。
 * 一次 O(n) 扫描全文;供 offsetToPos(二分)/offsetOf(查表)加速,避免逐字符/逐行反复扫描大文件。
 */
function buildLineStarts(text: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) { // \n
            starts.push(i + 1);
        }
    }
    return starts;
}

/**
 * include filename 的本地 glob 枚举(XG10,2026-09-24;官方语义见 13 §3.5):
 * 相对**当前文件目录**转绝对 → 单层段模式匹配(* 不跨 `/`,? 匹配单字符)→ sorted。
 * `**` 深层模式不枚举(返回空 → 悬空);模式含 `[...]` 字符类按字面处理(官方罕见,简化)。
 * 纯函数,供 scanIncludes 与测试;零匹配返回 [](官方仅告警)。
 */
export function globLocalIncludes(pattern: string, fromUri: vscode.Uri): string[] {
    const rel = pattern.trim().replace(/\\/g, "/");
    if (rel.includes("**")) {
        return []; // 深层 glob 不枚举,悬空(两态模型不放弃)
    }
    const abs = path.resolve(path.dirname(fromUri.fsPath), rel);
    const dir = path.dirname(abs);
    const base = path.basename(abs);
    const re = new RegExp("^" + base.split("").map(ch =>
        ch === "*" ? "[^/]*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    ).join("") + "$");
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names.filter(n => re.test(n)).sort().map(n => path.join(dir, n));
}

/**
 * XG10:代换后的表达式 content 是否为"字面串"(不求值前提下可用的路径段):
 * 引号串(去引号)或裸词(字母数字/路径分隔符)。否则 undefined(悬空)。
 */
function literalOfString(s: string): string | undefined {
    const t = s.trim();
    const q = t[0];
    if ((q === "'" || q === '"') && t.length >= 2 && t[t.length - 1] === q && t.slice(1, -1).indexOf(q) < 0) {
        return t.slice(1, -1);
    }
    return /^[A-Za-z0-9_./\\-]+$/.test(t) ? t : undefined;
}

/** 符号种类(01 §2.2) */
export type SymbolKind = "macro" | "property" | "arg" | "link" | "joint";

/**
 * 文件是否在兜底搜索域(VS Code 工作区根)内(XG13;LA-1 起实现上移
 * languages/shared/workspace-domain,此处保留导出供既有测试/消费方)。
 */
export function fileInFallbackDomain(file: vscode.Uri): boolean {
    return fileInWorkspaceDomain(file);
}

/** 单个符号定义点(00 §1) */
export interface SymbolRef {
    name: string;
    kind: SymbolKind;
    uri: vscode.Uri;            // 定义所在文件
    line: number;                // 0 基
    column: number;              // 0 基(标签起始)
    value?: string;              // property 的静态 value(@_value),供 ${} 求值;其他 kind 无
    params?: MacroParam[];       // macro 专属(XG5):params 全语法解析结果(宏形参入符号表,关闭审计登记缺口)
}

/** include 边(00 §1) */
export interface IncludeEdge {
    raw: string;                 // filename 原样
    target?: vscode.Uri;         // 解析成功的目标文件;失败为 undefined
    status: "ok" | "pending";    // 两态——ok=找到落地;pending=悬空未找到(包未命中/列表未加载/${} 静态不可解析)
    index: number;               // 该文件内第几个 include(0 起,文档顺序;glob 多边共享同一 index)
    line: number;
    startColumn: number;
    endColumn: number;           // filename 值范围
    ns?: string;                 // XG10:ns= 命名空间(13 §3.5)
    optional?: boolean;          // XG10:optional="true"(文件缺失不报错 → D1 豁免)
    isGlob?: boolean;            // XG10:glob 模式(零匹配 = pending,官方仅告警)
}

/** 单个 xacro 文件的节点(00 §1) */
export interface FileNode {
    uri: vscode.Uri;
    text: string;                // 原始文本(供 hover 取定义行 / offset 判定)
    lineStarts: number[];        // 行起始偏移索引(第 i 项=第 i 行起始 offset;offsetToPos/offsetOf 加速用)
    includes: IncludeEdge[];
    symbols: Map<SymbolKind, Map<string, SymbolRef>>; // 懒加载
    symbolsLoaded: boolean;
    version: number;             // 内容版本(upsert/scan 递增,供"上次兜底后是否有变化"判定)
    doc?: XacroDocument;         // XG5:单遍解析文档模型(可选,向后兼容;scanIncludes 时填充)
}

/** 可见性判定结果(00 §1) */
export interface Visibility {
    visible: boolean;
    contexts: string[];          // 每根一条:["经 C.xacro 展开: def 在 file 之前/之后"]
    blocker?: string;
}

// ===================== use-def 符号级(12 §0) =====================

/** 符号 key:`${defFileUri.toString()}::${name}`(全局唯一 property 符号 id) */
type UseDefKey = string;

// useDefMap: Map<UseDefKey, Set<string /* 依赖者文件 uri.toString() */>>
// fileSymbolIndex: Map<string /* def 文件 uri.toString() */, Set<UseDefKey>>

/** 传播步骤(propagate 用):via = 进入本文件所经过的 def 符号 key;起点 via=undefined */
interface PropStep {
    file: string;        // 本文件 uri.toString()
    via?: UseDefKey;     // def 符号 key(进入本文件的边);起点 undefined
}

/** D6 环链元素(事件载荷):符号名 + 定义位置(可定位时,12 §0) */
export interface PropertyCycleStep {
    file: string;        // 符号定义文件 uri(定位失败时 = 文件 uri)
    symbol?: string;     // property 名(起点可能无符号)
    line?: number;       // 定义行(0 基,locate 失败时 undefined)
    column?: number;     // 定义列(0 基)
}

/** 符号定位结果 */
interface SymbolPos { line: number; column: number }

export class IncludeGraph {
    private nodes = new Map<string, FileNode>();                        // key = uri.toString()
    private includerMap = new Map<string, { source: vscode.Uri; index: number }[]>(); // 反向
    private expandOrderCache = new Map<string, vscode.Uri[]>();         // key = root uri
    private useDefMap = new Map<string, Set<string>>();                 // 符号级 use-def:key = `${defFileUri}::${name}` → 依赖者文件(12 §3.1)
    private fileSymbolIndex = new Map<string, Set<string>>();           // 辅助索引:def 文件 → 该文件定义且被依赖的符号 key(12 §3.1)
    private versionCounter = 0;
    private lastFallbackAt = new Map<string, number>();                 // 兜底防抖(时间戳)
    private lastFallbackVersion = new Map<string, number>();            // 兜底时该文件内容版本
    private fallbackInFlight = false;                                   // 兜底全仓扫描单飞标志(2026-09-07)
    private fallbackPending = new Set<string>();                        // 单飞期间的排队文件(2026-09-07)
    private propertyCycleEmitter = new vscode.EventEmitter<PropertyCycleStep[]>(); // D6:property 依赖环(符号级,12 §0)
    private docStore = new XacroDocumentStore();                        // XG5:文档解析缓存(uri+version 键控)

    /** property 依赖环检测到后触发(12 D6,链 = 符号 + 定义位置数组,传播时) */
    readonly onPropertyCycle: vscode.Event<PropertyCycleStep[]> = this.propertyCycleEmitter.event;

    /** 查找符号(不限定可见性;供诊断 D4 判断"存在但当前不可见") */
    findSymbolAny(file: vscode.Uri, name: string, kind: SymbolKind): SymbolRef | undefined {
        const fileNode = this.nodes.get(file.toString());
        if (fileNode) {
            this.collectSymbols(fileNode);
            const s = fileNode.symbols.get(kind)?.get(name);
            if (s) {
                log.trace(vscode.l10n.t("findSymbolAny({0},{1}): hit in same file", name, kind));
                return s;
            }
        }
        for (const node of this.nodes.values()) {
            if (node.uri.toString() === file.toString()) {
                continue;
            }
            this.collectSymbols(node);
            const s = node.symbols.get(kind)?.get(name);
            if (s) {
                log.trace(vscode.l10n.t("findSymbolAny({0},{1}): hit across files {2}", name, kind, path.basename(node.uri.fsPath)));
                return s;
            }
        }
        return undefined;
    }

    constructor(private packages: PackageMap) { }

    // ===================== 构建 =====================

    /**
     * ① 启动预热:全量构建(三阶段,见 01 §0.5)
     *   阶段A 静态骨架(不含 ${} 的边先落)
     *   阶段B ${} 迭代收敛(不动点,O(n²) 有限步)+ recordUseDef 标定
     *   阶段C 图外兜底(低频,查询时 fallback 兜底,此处不主动全量扫)
     */
    async build(uris: vscode.Uri[]): Promise<void> {
        let list = uris;
        if (!list || list.length === 0) {
            try {
                // 统一走自定义 walk(替代 findFiles:不跟随符号链接 + 排除产物目录 + 双超时,8-21 搜索体系)
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!wsRoot) {
                    list = [];
                } else {
                    const result = await walkWithTimeout(wsRoot, /\.(xacro|urdf)$/, walkOptions("xacro"));
                    list = result.matches.map((p) => vscode.Uri.file(p));
                }
            } catch (err) {
                log.warn(vscode.l10n.t("xacro file scan failed: {0}", (err as Error).message));
                list = [];
            }
        }

        log.trace(vscode.l10n.t("build started: {0} files", list.length));

        // 阶段A:静态骨架
        for (const uri of list) {
            const node = this.scanIncludes(uri);
            if (node) {
                this.nodes.set(uri.toString(), node);
                for (const e of node.includes) {
                    if (e.target && e.status === "ok") {
                        this.addIncluderEdge(e.target, uri, e.index);
                    }
                }
            }
        }

        log.trace(vscode.l10n.t("Phase A static skeleton done: {0} nodes", this.nodes.size));

        // 阶段B:${} 迭代收敛(不动点)
        let round = 0;
        let changed = true;
        while (changed) {
            round++;
            let landed = 0;
            changed = false;
            for (const node of this.nodes.values()) {
                for (const e of node.includes) {
                    if (e.status === "pending" && e.raw.indexOf("${") >= 0) {
                        const r = this.resolveDollarBraces(e.raw, node.uri, e.line, e.startColumn);
                        if (r) {
                            e.target = r.target;
                            e.status = "ok";
                            this.addIncluderEdge(e.target, node.uri, e.index);
                            this.recordUseDef(r.defUri, r.defName, node.uri);
                            landed++;
                            changed = true;
                        }
                    }
                }
            }
            log.trace(vscode.l10n.t("Phase B round {0}: landed {1} ${} edges", round, landed));
        }

        let edgeCount = 0;
        for (const n of this.nodes.values()) {
            edgeCount += n.includes.length;
        }
        log.debug(vscode.l10n.t("xacro expansion graph warmup done: {0} files", this.nodes.size));
        log.trace(vscode.l10n.t("build finished: {0} nodes, {1} include edges", this.nodes.size, edgeCount));
    }

    // ===================== 查询(同步,S1-A) =====================

    /** 保序展开序列(DFS 先序 + 环检测 + 缓存),见 00 §3.1 */
    expandOrder(root: vscode.Uri): vscode.Uri[] {
        const key = root.toString();
        const cached = this.expandOrderCache.get(key);
        if (cached) {
            log.trace(vscode.l10n.t("expandOrder cache hit: {0} (sequence {1})", path.basename(root.fsPath), cached.length));
            return cached;
        }
        const result: vscode.Uri[] = [];
        const stack: vscode.Uri[] = [];
        const visit = (f: vscode.Uri): void => {
            if (stack.some(u => u.toString() === f.toString())) {
                log.warn(vscode.l10n.t("circular include: {0}", path.basename(f.fsPath)));
                return;
            }
            stack.push(f);
            const node = this.nodes.get(f.toString());
            if (node) {
                for (const e of node.includes) { // index 升序(数组按文档序)
                    if (e.target) {
                        if (!this.nodes.has(e.target.toString())) {
                            this.pullPackageFile(e.target); // S1-A:同步
                        }
                        if (this.nodes.has(e.target.toString())) {
                            visit(e.target); // 被包含文件先展开
                        }
                    }
                }
            }
            result.push(f); // F 自身
            stack.pop();
        };
        visit(root);
        this.expandOrderCache.set(key, result);
        log.trace(vscode.l10n.t("expandOrder computed: {0} -> [{1}]", path.basename(root.fsPath), result.map(u => path.basename(u.fsPath)).join(",")));
        return result;
    }

    /** 从文件向上反查父链直至根,返回所有可达根(去重),见 00 §3.2 */
    findRoots(from: vscode.Uri): vscode.Uri[] {
        const seen = new Set<string>();
        const roots: vscode.Uri[] = [];
        const walk = (f: vscode.Uri): void => {
            const k = f.toString();
            if (seen.has(k)) {
                return;
            }
            seen.add(k);
            const parents = this.includerMap.get(k);
            if (!parents || parents.length === 0) {
                roots.push(f);
            } else {
                for (const p of parents) {
                    walk(p.source);
                }
            }
        };
        walk(from);
        return roots;
    }

    /** 某文件某位置可见的全部符号(同文件定义在前 + 展开序之前的文件,宽松=多根并集),见 00 §3.3 */
    visibleSymbols(file: vscode.Uri, pos: vscode.Position): SymbolRef[] {
        const fileNode = this.nodes.get(file.toString());
        if (!fileNode) {
            return [];
        }
        this.collectSymbols(fileNode);
        const resultMap = new Map<string, SymbolRef>();
        const pushSymbol = (s: SymbolRef): void => {
            resultMap.set(`${s.kind}:${s.name}:${s.uri.toString()}:${s.line}:${s.column}`, s);
        };

        // ① 同文件:定义 offset < 引用 offset
        const posOffset = this.offsetOf(fileNode.text, pos.line, pos.character, fileNode.lineStarts);
        for (const kindMap of fileNode.symbols.values()) {
            for (const s of kindMap.values()) {
                if (this.offsetOf(fileNode.text, s.line, s.column, fileNode.lineStarts) < posOffset) {
                    pushSymbol(s);
                }
            }
        }

        // ② 跨文件:对每个根求展开序,取"file 之前"的文件,宽松=并集
        for (const root of this.findRoots(file)) {
            const order = this.expandOrder(root);
            const idx = order.findIndex(u => u.toString() === file.toString());
            if (idx < 0) {
                continue;
            }
            for (let i = 0; i < idx; i++) {
                const fNode = this.nodes.get(order[i].toString());
                if (!fNode) {
                    continue;
                }
                this.collectSymbols(fNode);
                for (const kindMap of fNode.symbols.values()) {
                    for (const s of kindMap.values()) {
                        pushSymbol(s);
                    }
                }
            }
        }
        log.trace(vscode.l10n.t("visibleSymbols({0}): {1} visible symbols", path.basename(file.fsPath), resultMap.size));
        return Array.from(resultMap.values());
    }

    /** 单点判定:符号 def 对 (file, pos) 是否可见,见 00 §3.4 */
    isVisible(file: vscode.Uri, pos: vscode.Position, def: SymbolRef): Visibility {
        if (def.uri.toString() === file.toString()) {
            const fNode = this.nodes.get(file.toString());
            const visible = fNode
                ? this.offsetOf(fNode.text, def.line, def.column, fNode.lineStarts) < this.offsetOf(fNode.text, pos.line, pos.character, fNode.lineStarts)
                : false;
            return { visible, contexts: [] };
        }
        const contexts: string[] = [];
        let anyBefore = false;
        for (const root of this.findRoots(file)) {
            const order = this.expandOrder(root);
            const iFile = order.findIndex(u => u.toString() === file.toString());
            const iDef = order.findIndex(u => u.toString() === def.uri.toString());
            if (iFile < 0 || iDef < 0) {
                continue;
            }
            const before = iDef < iFile;
            if (before) {
                anyBefore = true;
            }
            contexts.push(`经 ${path.basename(root.fsPath)} 展开: def 在 file ${before ? "之前" : "之后"}`);
        }
        log.trace(`isVisible(${def.name}):visible=${anyBefore} contexts=${contexts.length}`);
        return { visible: anyBefore, contexts };
    }

    /** 宽松查找:同文件优先 → 跨文件可见集 → 兜底触发(fire-and-forget),见 00 §3.5 */
    findSymbol(file: vscode.Uri, pos: vscode.Position, name: string, kind: SymbolKind): SymbolRef | undefined {
        const fileNode = this.nodes.get(file.toString());
        if (fileNode) {
            this.collectSymbols(fileNode);
        }
        // 同文件优先
        const same = fileNode?.symbols.get(kind)?.get(name);
        if (same && this.isVisible(file, pos, same).visible) {
            log.trace(vscode.l10n.t("findSymbol same-file hit: {0}:{1} @ {2} ({3}:{4})", kind, name, path.basename(file.fsPath), same.line + 1, same.column));
            return same;
        }
        // 跨文件:可见集里找
        for (const s of this.visibleSymbols(file, pos)) {
            if (s.kind === kind && s.name === name) {
                log.trace(vscode.l10n.t("findSymbol cross-file hit: {0}:{1} -> {2} ({3})", kind, name, path.basename(s.uri.fsPath), s.line + 1));
                return s;
            }
        }
        // ③ 兜底:无父 或 上次兜底后内容有变化 → 触发反向搜索(不 await,写回后下次命中)
        if (this.needFallback(file)) {
            log.trace(vscode.l10n.t("findSymbol miss: {0}:{1}; triggering fallback", kind, name));
            void this.fallback(file);
        }
        return undefined;
    }

    /** 获取某文件节点(供 Providers 取 includes / text) */
    getFile(uri: vscode.Uri): FileNode | undefined {
        return this.nodes.get(uri.toString());
    }

    /** 取活文档的解析模型(XG6,2026-09-24):编辑器活文本按 uri+version 走缓存;
     *  图内已有同文本节点且带 doc 时直接复用(与 scanIncludes/collectSymbols 共享同一次解析)。
     *  五类 provider(hover/definition/completion/diagnostics/links)统一由此取数,消灭每查询重解析(X-F4)。 */
    getDocument(doc: vscode.TextDocument): XacroDocument {
        const text = doc.getText();
        const node = this.nodes.get(doc.uri.toString());
        if (node && node.text === text && node.doc) {
            return node.doc;
        }
        return this.docStore.get(doc.uri, text, doc.version);
    }

    // ===================== 兜底 / 拉取(异步外置) =====================

    /**
     * 文件是否在兜底搜索域(VS Code 工作区根)内(XG13,2026-09-25)。
     * fallback 的候选域 = workspaceFolders 根的 walk;域外文件(系统包 /opt/ros/… 等
     * 经 $(find) 跳入的目标)不在域内 → 反向检索注定空手,且每次到访都会白烧一次全仓扫描。
     * 注意区分:文件可在域外但**父边已在图**(工作区文件 include 了它)——那只说明正向边
     * 已解析,不影响本判定。无根/多根:任一根覆盖即在内;无根 → 域空,恒 false。
     */
    private inFallbackDomain(file: vscode.Uri): boolean {
        return fileInFallbackDomain(file);
    }

    /**
     * ③ 兜底反向搜索 + 写回(00 §3.6 / 07 §3)
     *  S1-A:由 findSymbol 触发后 fire-and-forget(不 await);2s 防抖防重复。
     *  2026-09-07:全局单飞 + 排队——同一时刻至多一次整仓扫描,快速切换/多文件未命中
     *  不再多波叠加(用户确认方案);排队文件在当次扫描完成后按各自防抖续跑。
     *  XG13(2026-09-25):域外文件(工作区根之外,如系统包)直接跳过——walk 域内
     *  不可能找到"域外文件的新父"(工作区文件对它的 include 边在 build/reparsePending
     *  已解析),白烧一次全仓扫描。
     */
    async fallback(file: vscode.Uri): Promise<void> {
        if (!this.inFallbackDomain(file)) {
            log.trace(vscode.l10n.t("fallback skipped (outside search scope): {0} (not under workspace root; reverse search has no candidate domain)", path.basename(file.fsPath)));
            return;
        }
        const key = file.toString();
        const now = Date.now();
        const last = this.lastFallbackAt.get(key) ?? 0;
        if (now - last < FALLBACK_DEBOUNCE_MS) {
            return;
        }
        if (this.fallbackInFlight) {
            this.fallbackPending.add(key);
            log.trace(vscode.l10n.t("fallback queued: {0} (a scan is already in flight)", path.basename(file.fsPath)));
            return;
        }
        this.fallbackInFlight = true;
        this.lastFallbackAt.set(key, now);
        log.trace(vscode.l10n.t("fallback triggered: {0} (reverse-searching files that include it)", path.basename(file.fsPath)));
        try {
            let candidates: vscode.Uri[] = [];
            try {
                // 统一走自定义 walk(替代 findFiles,与 build 阶段同一口径,8-21 搜索体系)
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (wsRoot) {
                    const result = await walkWithTimeout(wsRoot, /\.(xacro|urdf)$/, walkOptions("xacro"));
                    candidates = result.matches.map((p) => vscode.Uri.file(p));
                }
            } catch (err) {
                log.warn(vscode.l10n.t("Fallback reverse-search scan failed: {0}", (err as Error).message));
                return;
            }
            const node = this.nodes.get(key);
            this.lastFallbackVersion.set(key, node?.version ?? 0);

            let added = 0;
            // 候选逐文件 read+scan 分片让出(2026-09-07:重分析合作式可中断——事件循环间隙
            // 允许交互/其它任务插队;配合全局单飞避免多波叠加)
            const CANDIDATE_CHUNK = 40;
            for (let i = 0; i < candidates.length; i += CANDIDATE_CHUNK) {
                const end = Math.min(candidates.length, i + CANDIDATE_CHUNK);
                for (let ci = i; ci < end; ci++) {
                    const c = candidates[ci];
                    const cNode = this.scanIncludes(c);
                    if (!cNode) {
                        continue;
                    }
                    if (!this.nodes.has(c.toString())) {
                        this.nodes.set(c.toString(), cNode);
                    }
                    for (const e of cNode.includes) {
                        if (e.target && e.target.toString() === key) {
                            this.addIncluderEdge(file, c, e.index);
                            added++;
                        }
                    }
                }
                if (end < candidates.length) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            if (added > 0) {
                this.expandOrderCache.clear();
                log.debug(vscode.l10n.t("Fallback reverse-search finished: {0}, {1} new parents", path.basename(file.fsPath), added));
            }
        } finally {
            this.fallbackInFlight = false;
            // 队列排空:再走各自防抖(此时可能仍在窗口内被跳过——符合预期)
            const drain = Array.from(this.fallbackPending);
            this.fallbackPending.clear();
            if (drain.length > 0) {
                log.trace(vscode.l10n.t("fallback queue drained: {0} files to continue scanning", drain.length));
                for (const k of drain) {
                    void this.fallback(vscode.Uri.parse(k));
                }
            }
        }
    }

    /** 系统包文件按需拉取入图(S1-A:同步 readFileSync);递归拉自身 include 链,限深防爆 */
    pullPackageFile(uri: vscode.Uri): void {
        this.pullPackageFileDepth(uri, 0);
    }

    private pullPackageFileDepth(uri: vscode.Uri, depth: number): void {
        if (depth > PULL_MAX_DEPTH) {
            log.trace(vscode.l10n.t("pullPackageFile depth-limited skip: {0} (depth {1})", path.basename(uri.fsPath), depth));
            return;
        }
        const key = uri.toString();
        if (this.nodes.has(key)) {
            return;
        }
        const node = this.scanIncludes(uri);
        if (!node) {
            return;
        }
        this.nodes.set(key, node);
        for (const e of node.includes) {
            if (e.target && !this.nodes.has(e.target.toString())) {
                this.pullPackageFileDepth(e.target, depth + 1);
            }
        }
    }

    // ===================== use-def 标定 + 传播(00 §3.7 / 12) =====================

    /** 符号 key 生成:`${defFileUri}::${name}`。全局唯一入口,避免散落拼接(12 §3.2) */
    private useDefKey(defUri: vscode.Uri, name: string): string {
        return `${defUri.toString()}::${name}`;
    }

    /** 从 key 解析 def 文件 uri(12 §3.2) */
    private defFileOf(key: UseDefKey): string {
        return key.slice(0, key.indexOf("::"));
    }

    /** 从 key 解析符号名(12 §3.2) */
    private defNameOf(key: UseDefKey): string {
        return key.slice(key.indexOf("::") + 2);
    }

    /** ${} 求值成功时登记(defUri::defName → 依赖者文件),双结构同步(12 §4.1) */
    recordUseDef(defUri: vscode.Uri, defName: string, depUri: vscode.Uri): void {
        const key = this.useDefKey(defUri, defName);
        let set = this.useDefMap.get(key);
        if (!set) {
            set = new Set();
            this.useDefMap.set(key, set);
        }
        set.add(depUri.toString());
        // fileSymbolIndex 同步(索引 → 符号 key)
        let fset = this.fileSymbolIndex.get(defUri.toString());
        if (!fset) {
            fset = new Set();
            this.fileSymbolIndex.set(defUri.toString(), fset);
        }
        fset.add(key);
    }

    /** 移除"depUri 作为依赖者"的全部旧边(reparse 前调用,修复 L3 stale 残留,12 §4.3) */
    private removeDepFromAll(depUri: vscode.Uri): void {
        const depKey = depUri.toString();
        for (const [key, deps] of this.useDefMap) {
            if (deps.delete(depKey)) {
                if (deps.size === 0) {
                    this.useDefMap.delete(key);
                    // 同步 fileSymbolIndex:删空符号 → 删索引项
                    const fileKey = this.defFileOf(key);
                    const fset = this.fileSymbolIndex.get(fileKey);
                    if (fset) {
                        fset.delete(key);
                        if (fset.size === 0) {
                            this.fileSymbolIndex.delete(fileKey);
                        }
                    }
                }
            }
        }
    }

    /** 文件变化/移动/改 property 后,沿 useDefMap 单向传播(判重=文件,展示=符号,12 §4.5) */
    propagate(changedUri: vscode.Uri): void {
        log.debug(vscode.l10n.t("propagate({0}): started (symbol-level)", path.basename(changedUri.fsPath)));
        const dirty: { step: PropStep; chain: PropStep[] }[] = [
            { step: { file: changedUri.toString() }, chain: [] }
        ];
        const visited = new Set<string>();   // 判重粒度 = 文件(防环 + 收敛)

        while (dirty.length > 0) {
            const { step, chain } = dirty.pop()!;
            const x = step.file;
            if (visited.has(x)) {
                // ── D6:property 依赖环(符号级,12 §4.5) ──
                const idx = chain.findIndex(s => s.file === x);
                const cycleSteps = idx >= 0 ? chain.slice(idx) : [];
                const steps = [...cycleSteps, step];
                // 符号环 = 各步 via(进入各文件的符号)→ 定义位置;起点无 via 的文件兜底不参与符号环
                const cycle: PropertyCycleStep[] = steps
                    .filter(s => s.via)
                    .map(s => {
                        const defFile = this.defFileOf(s.via!);
                        const name = this.defNameOf(s.via!);
                        return { file: defFile, symbol: name, ...this.locateSymbol(defFile, name) };
                    });
                if (cycle.length === 0) {
                    // 兜底:无符号信息(极端情况),退化为文件 basename 链
                    cycle.push(...steps.map(s => ({ file: s.file })));
                } else if (cycle[0].symbol !== cycle[cycle.length - 1].symbol) {
                    cycle.push({ ...cycle[0] });   // 闭合:首符号补到末尾(如 p → q → p)
                }
                this.propertyCycleEmitter.fire(cycle);
                log.warn(vscode.l10n.t("property dependency cycle (symbol-level): {0}", cycle.map(c => c.symbol ?? path.basename(c.file)).join(" -> ")));
                continue;
            }
            visited.add(x);

            // 收集 x 作为 def 文件的依赖者:fileSymbolIndex[x] 各符号 → useDefMap[key] 依赖者,聚合去重到文件
            const deps = new Set<string>();
            for (const symKey of this.fileSymbolIndex.get(x) ?? []) {
                for (const d of this.useDefMap.get(symKey) ?? []) {
                    deps.add(d);
                }
            }
            if (deps.size === 0) {
                continue;
            }
            log.trace(vscode.l10n.t("propagate({0}): {1} has {2} dependent files", path.basename(changedUri.fsPath), x, deps.size));
            for (const d of deps) {
                // via 必须在此处取(reparse 前):reparseDollarEdges(d) 会 removeDepFromAll(d)
                // 清掉"d 作为依赖者"的边,若 reparse 后再查 fileSymbolIndex 会查不到 → via 丢失
                const via = this.firstSymKey(x, d);
                this.reparseDollarEdges(vscode.Uri.parse(d));
                dirty.push({ step: { file: d, via }, chain: [...chain, step] });
            }
        }
        log.debug(`propagate(${path.basename(changedUri.fsPath)}):完成,visited ${visited.size} 个文件`);
    }

    /** 取 def 文件 x → 依赖者文件 d 的第一个符号 key;无则 undefined(12 §4.5) */
    private firstSymKey(defFileKey: string, depKey: string): UseDefKey | undefined {
        for (const symKey of this.fileSymbolIndex.get(defFileKey) ?? []) {
            if (this.useDefMap.get(symKey)?.has(depKey)) {
                return symKey;
            }
        }
        return undefined;
    }

    /** 定位 property 定义行/列(collectSymbols + 符号表);失败返回空(调用方兜底,12 §4.5) */
    private locateSymbol(fileKey: string, name: string): Partial<SymbolPos> {
        const node = this.nodes.get(fileKey);
        if (!node) {
            return {};
        }
        this.collectSymbols(node);
        const ref = node.symbols.get("property")?.get(name);
        return ref ? { line: ref.line, column: ref.column } : {};
    }

    // ===================== 增量维护(07) =====================

    /** 单文件(重新)解析并入图;内容未变(幽灵事件)跳过(07 §1.3)。
     *  text 可传**活文本(未保存编辑)**(2026-09-09:watcher 订阅 onDidChangeTextDocument,
     *  消除"警告须保存/切文件才更新"——图不再只认磁盘);缺省读磁盘。 */
    upsert(uri: vscode.Uri, text?: string): void {
        const key = uri.toString();
        let newText: string;
        if (text !== undefined) {
            newText = text;
        } else {
            try {
                newText = fs.readFileSync(uri.fsPath, "utf8");
            } catch {
                this.remove(uri);
                return;
            }
        }
        const old = this.nodes.get(key);
        if (old && old.text === newText) {
            log.trace(`upsert 幽灵事件跳过:${path.basename(uri.fsPath)}(内容未变)`);
            return;
        }
        log.trace(`upsert 更新:${path.basename(uri.fsPath)}${text !== undefined ? "(活文本)" : ""}`);
        const node = this.scanIncludes(uri, newText);
        if (node) {
            // 更新正向边:旧 includes 与新的 diff → 维护 includerMap
            if (old) {
                for (const oe of old.includes) {
                    if (oe.target &&
                        !node.includes.some(ne => ne.target !== undefined && ne.target.toString() === oe.target!.toString() && ne.index === oe.index)) {
                        this.removeIncluderEdge(oe.target, uri, oe.index);
                    }
                }
            }
            this.nodes.set(key, node);
            for (const e of node.includes) {
                if (e.target && e.status === "ok") {
                    this.addIncluderEdge(e.target, uri, e.index);
                }
            }
        } else {
            this.nodes.delete(key);
        }
        this.invalidate(uri);
    }

    /** 删除节点 + 清理反向边 */
    remove(uri: vscode.Uri): void {
        const key = uri.toString();
        const node = this.nodes.get(key);
        if (node) {
            for (const e of node.includes) {
                if (e.target) {
                    this.removeIncluderEdge(e.target, uri, e.index);
                }
            }
        }
        this.nodes.delete(key);
        this.invalidate(uri);
    }

    /** 文件移动(rename,07 §2.1):更新节点 key/符号 uri/反向边/自身与父 include/useDefMap 重定向 + 传播 */
    rename(old: vscode.Uri, newUri: vscode.Uri): void {
        const oldKey = old.toString();
        const newKey = newUri.toString();
        const node = this.nodes.get(oldKey);
        if (!node) {
            return;
        }
        log.trace(`rename:${path.basename(old.fsPath)} → ${path.basename(newUri.fsPath)}`);
        // ① 更新节点 key 与所有符号 uri
        this.nodes.delete(oldKey);
        node.uri = newUri;
        this.nodes.set(newKey, node);
        for (const kindMap of node.symbols.values()) {
            for (const s of kindMap.values()) {
                s.uri = newUri;
            }
        }
        // ② 重定向反向边:includerMap 中所有 source == old → new
        for (const list of this.includerMap.values()) {
            for (const it of list) {
                if (it.source.toString() === oldKey) {
                    it.source = newUri;
                }
            }
        }
        // ③ 重解析被移动文件自身 include(相对路径基准变了)
        for (const e of node.includes) {
            const { target, status } = this.resolveInclude(e.raw, newUri);
            e.target = target;
            e.status = status;
        }
        // ④ 重解析所有父的 include 边(父引用旧路径 → 悬垂)
        const parents = this.includerMap.get(newKey);
        if (parents) {
            for (const p of parents) {
                this.upsert(p.source);
            }
        }
        // ⑤ useDefMap 重定向 + 传播
        this.redirectUseDefKey(oldKey, newKey);
        this.propagate(newUri);
        this.invalidate();
    }

    /** 遍历全部节点(供 watcher 轮巡/事件扫描) */
    allNodes(): FileNode[] {
        return Array.from(this.nodes.values());
    }

    /** rename:useDefMap + fileSymbolIndex 的 key 里文件 uri 部分 old → new;value 里依赖者文件 old → new(12 §4.6) */
    private redirectUseDefKey(oldKey: string, newKey: string): void {
        // ① useDefMap:key 前缀(uri 部分)替换 + value 里依赖者文件替换
        const next = new Map<string, Set<string>>();
        for (const [k, deps] of this.useDefMap) {
            const nk = this.rewriteFilePart(k, oldKey, newKey);
            const ndeps = new Set<string>();
            for (const d of deps) {
                ndeps.add(d.startsWith(oldKey) ? newKey + d.slice(oldKey.length) : d);
            }
            next.set(nk, ndeps);
        }
        this.useDefMap = next;
        // ② fileSymbolIndex:key 前缀替换 + value 符号 key 前缀替换
        const nextIdx = new Map<string, Set<string>>();
        for (const [fk, syms] of this.fileSymbolIndex) {
            const nfk = fk.startsWith(oldKey) ? newKey + fk.slice(oldKey.length) : fk;
            const nsyms = new Set<string>();
            for (const s of syms) {
                nsyms.add(this.rewriteFilePart(s, oldKey, newKey));
            }
            nextIdx.set(nfk, nsyms);
        }
        this.fileSymbolIndex = nextIdx;
    }

    /** 符号 key 只替换 uri 前缀部分(`fileUri::name` 的 fileUri 段),name 保留(12 §4.6) */
    private rewriteFilePart(key: string, oldKey: string, newKey: string): string {
        const sep = key.indexOf("::");
        if (sep < 0) {
            return key;
        }
        const filePart = key.slice(0, sep);
        const namePart = key.slice(sep);
        const nf = filePart.startsWith(oldKey) ? newKey + filePart.slice(oldKey.length) : filePart;
        return nf + namePart;
    }

    /** 缓存失效:传 uri 与否 expandOrderCache 均全清(依赖全局图,见 07 §3.2) */
    invalidate(_uri?: vscode.Uri): void {
        this.expandOrderCache.clear();
    }

    // ===================== 解析(01) =====================

    /** 预热:只扫 include 行,不收集任何符号(01 §2.1)。text 缺省读磁盘;watcher 可传活文本。
     *  XG5:一次 parseXacroDocument 同时产出 doc(标签/符号/$词法段),include 边改读 doc.tags——
     *  本函数不再单独 parseXml(doc 随 FileNode 驻留,collectSymbols 复用,X-F4)。 */
    scanIncludes(uri: vscode.Uri, text?: string): FileNode | undefined {
        if (text === undefined) {
            try {
                text = fs.readFileSync(uri.fsPath, "utf8");
            } catch (err) {
                log.warn(`读取 xacro 失败:${(err as Error).message}`);
                return undefined;
            }
        }
        const doc = parseXacroDocument(text, uri);
        const includes: IncludeEdge[] = [];
        const lineStarts = buildLineStarts(text);
        let i = 0;
        for (const inst of doc.tags.get("include") ?? []) {
            const f = inst.attrs.get("filename");
            if (f && typeof f.value === "string" && f.value.length > 0) {
                const start = this.offsetToPos(text, f.valueFrom, lineStarts);
                const end = this.offsetToPos(text, f.valueTo, lineStarts);
                // XG10:ns/optional/glob 计入边模型(13 §3.5)
                const ns = inst.attrs.get("ns")?.value;
                const optional = staticBoolean(inst.attrs.get("optional")?.value) === true;
                const isGlob = /[*?]/.test(f.value) && f.value.indexOf("$(") < 0 && f.value.indexOf("${") < 0;
                const base: Omit<IncludeEdge, "target" | "status"> = {
                    raw: f.value, index: i,
                    line: start.line, startColumn: start.column, endColumn: end.column,
                    ...(ns !== undefined ? { ns } : {}),
                    ...(optional ? { optional } : {}),
                    ...(isGlob ? { isGlob } : {})
                };
                if (isGlob) {
                    // 官方语义(13 §3.5):先按当前文件目录转绝对,sorted(glob),零匹配仅告警 → pending
                    const matches = globLocalIncludes(f.value, uri);
                    if (matches.length > 0) {
                        for (const m of matches) {
                            includes.push({ ...base, target: vscode.Uri.file(m), status: "ok" });
                        }
                    } else {
                        includes.push({ ...base, target: undefined, status: "pending" });
                    }
                    i++; // glob 实例计一次序
                    continue;
                }
                const { target, status } = this.resolveInclude(f.value, uri);
                includes.push({ ...base, target, status });
                i++;
            }
        }
        const okCount = includes.filter(e => e.status === "ok").length;
        const pendCount = includes.filter(e => e.status === "pending").length;
        log.trace(`scanIncludes(${path.basename(uri.fsPath)}):${includes.length} 条 include(ok ${okCount} / pending ${pendCount})`);
        return {
            uri,
            text,
            lineStarts,
            includes,
            symbols: new Map(),
            symbolsLoaded: false,
            version: ++this.versionCounter,
            doc
        };
    }

    /** 动态:查询命中某文件时才收集符号,缓存(01 §2.2)。
     *  XG5:macro/property/arg 改读 FileNode.doc 的符号数组(文档序,首个定义优先语义不变),
     *  link/joint 仍走 lezer 树遍历但复用 doc.tree(不再重新 parseXml,X-F4);
     *  宏形参经 SymbolRef.params 入符号表(关闭审计登记缺口"宏形参不建符号表")。 */
    collectSymbols(node: FileNode): void {
        if (node.symbolsLoaded) {
            return;
        }
        const symbols = new Map<SymbolKind, Map<string, SymbolRef>>();
        for (const kind of ["macro", "property", "arg", "link", "joint"] as SymbolKind[]) {
            symbols.set(kind, new Map());
        }
        const doc = node.doc ?? this.docStore.get(node.uri, node.text, node.version);
        node.doc = doc;

        // macro/property/arg:doc.symbols 已按文档序收集(名称/位置同源)
        for (const m of doc.symbols.macros) {
            if (symbols.get("macro")!.has(m.name)) {
                continue; // 只记首个定义(语义不变)
            }
            const pos = this.offsetToPos(node.text, m.info.spanFrom, node.lineStarts);
            symbols.get("macro")!.set(m.name, {
                name: m.name, kind: "macro", uri: node.uri,
                line: pos.line, column: pos.column,
                params: m.params
            });
        }
        for (const p of doc.symbols.props) {
            if (symbols.get("property")!.has(p.name)) {
                continue;
            }
            const pos = this.offsetToPos(node.text, p.info.spanFrom, node.lineStarts);
            symbols.get("property")!.set(p.name, {
                name: p.name, kind: "property", uri: node.uri,
                line: pos.line, column: pos.column,
                value: typeof p.value === "string" ? p.value : ""
            });
        }
        for (const a of doc.symbols.args) {
            if (symbols.get("arg")!.has(a.name)) {
                continue;
            }
            const pos = this.offsetToPos(node.text, a.info.spanFrom, node.lineStarts);
            symbols.get("arg")!.set(a.name, {
                name: a.name, kind: "arg", uri: node.uri,
                line: pos.line, column: pos.column
            });
        }

        // link/joint:URDF 结构元素,非 xacro 标签——doc.tree 一次遍历(无重复 parse)
        forEachElement(doc.tree.topNode, node.text, (_elem, info) => {
            const kind = info.tag === "link" ? "link" : info.tag === "joint" ? "joint" : null;
            if (!kind) {
                return;
            }
            const nameAttr = info.attrs.find(a => a.name === "name");
            if (nameAttr && typeof nameAttr.value === "string") {
                // column = 标签起始列(与旧 linkDefs 语义一致;勿改 name 值列——"定义在前"顺序判定依赖标签起始)
                const pos = this.offsetToPos(node.text, info.spanFrom, node.lineStarts);
                const ref: SymbolRef = { name: nameAttr.value, kind, uri: node.uri, line: pos.line, column: pos.column };
                const m = symbols.get(kind)!;
                if (!m.has(ref.name)) {
                    m.set(ref.name, ref); // 只记首个定义(语义不变)
                }
            }
        });

        node.symbols = symbols;
        node.symbolsLoaded = true;
        log.trace(`collectSymbols(${path.basename(node.uri.fsPath)}):` +
            `macro ${symbols.get("macro")!.size} property ${symbols.get("property")!.size} ` +
            `arg ${symbols.get("arg")!.size} link ${symbols.get("link")!.size} joint ${symbols.get("joint")!.size}`);
    }

    /** include 三方法 + 两态(01 §2.5) */
    resolveInclude(raw: string, fromUri: vscode.Uri): { target: vscode.Uri | undefined; status: "ok" | "pending" } {
        // 分隔符归一(2026-09-08):属性值标准是 "/";用户误敲/Windows 习惯的 "\\" 若不归一,
        // posix 上会解析成带反斜杠的字面名 → 目标恒"不存在"(D1 噪音、跳转与悬停前后冲突)。
        const rel = raw.trim().replace(/\\/g, "/");
        if (!rel) {
            return { target: undefined, status: "pending" };
        }
        // ① 相对/绝对路径:立即落地(恒 ok,存在性靠 08 诊断)
        if (rel.indexOf("$(") < 0 && rel.indexOf("${") < 0 && !rel.startsWith("package://")) {
            const target = vscode.Uri.file(path.resolve(path.dirname(fromUri.fsPath), rel));
            log.trace(`resolveInclude(相对):${rel} → ok ${target.fsPath}`);
            return { target, status: "ok" };
        }
        // ② 包路径:$(find) / package://
        if (rel.indexOf("$(") >= 0 || rel.startsWith("package://")) {
            const resolved = this.packages.resolveFileRef(rel, fromUri);
            if (resolved) {
                log.trace(`resolveInclude(包路径):${rel} → ok ${resolved.fsPath}`);
                return { target: resolved, status: "ok" };
            }
            // 未找到一律悬空(五轮):包未命中 / list 失败 / 列表未加载,不区分
            log.trace(`resolveInclude(包路径):${rel} → pending(未找到)`);
            return { target: undefined, status: "pending" };
        }
        // ③ ${...} 变量表达式 → 静态无法解析 → 悬空(不参与包轮巡)
        log.trace(`resolveInclude(变量):${rel} → pending(静态不可解析)`);
        return { target: undefined, status: "pending" };
    }

    /** ${} 求值(01 §0.5.4):baseLine/baseColumn 为 include 值所在位置。
     *  XG5:标识符扫描改走 lexDollar 词法器(修 X-F3 重复正则)。
     *  XG10 扩展(仍不执行表达式,用户裁定):① 表达式 content 非纯标识符时,经 scanExpression
     *  提取引用,全部具静态字面值 → 逐词代换,代换结果须为"字面串"(引号串/裸词)才落地;
     *  ② $() 内的 ${ident} 先展开(官方 handle_extension 语义)后代入。
     *  不可解仍 pending(两态模型)。 */
    resolveDollarBraces(
        raw: string,
        file: vscode.Uri,
        baseLine: number,
        baseColumn: number
    ): { target: vscode.Uri; defUri: vscode.Uri; defName: string } | undefined {
        let substituted = raw;
        let firstDefUri: vscode.Uri | undefined;
        let firstDefName: string | undefined;
        const recordDef = (def: { uri: vscode.Uri }, name: string): void => {
            if (!firstDefUri) {
                firstDefUri = def.uri;
                firstDefName = name;                       // ★ 记录第一个 def 的符号名(12 §4.2)
            }
        };
        /** 静态属性查找(不可见/无值/值本身是表达式 → undefined) */
        const staticProp = (name: string, atOffset: number): { value: string; def: { uri: vscode.Uri } } | undefined => {
            const def = this.findSymbol(file, new vscode.Position(baseLine, baseColumn + atOffset), name, "property");
            if (!def || typeof def.value !== "string" || def.value === ""
                || def.value.indexOf("${") >= 0 || def.value.indexOf("$(") >= 0) {
                return undefined;
            }
            return { value: def.value, def };
        };
        const lex = lexDollar(raw);
        for (const tok of lex.tokens) {
            if (tok.kind === "expr") {
                if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.content)) {
                    const name = tok.content;
                    const hit = staticProp(name, tok.from);
                    if (!hit) {
                        log.trace(`resolveDollarBraces 失败:${raw}(${name} 未找到/无静态 value)`);
                        return undefined;
                    }
                    recordDef(hit.def, name);
                    substituted = substituted.replace("${" + name + "}", hit.value);
                    continue;
                }
                // XG10:非纯标识符 → 依赖提取 + 全静态代换 + 字面串判定
                const scan = scanExpression(tok.content);
                if (scan.hasSyntaxIssue || scan.hasControlFlow || scan.refIdents.length === 0) {
                    log.trace(`resolveDollarBraces 失败:${raw}(\${${tok.content}} 静态不可代换)`);
                    return undefined;
                }
                let s = tok.content;
                for (const r of scan.refIdents) {
                    const at = tok.content.indexOf(r);
                    const hit = staticProp(r, tok.from + (at >= 0 ? at : 0));
                    if (!hit) {
                        log.trace(`resolveDollarBraces 失败:${raw}(${r} 无静态 value)`);
                        return undefined;
                    }
                    recordDef(hit.def, r);
                    s = s.replace(new RegExp("\\b" + r + "\\b", "g"), hit.value);
                }
                const lit = literalOfString(s);
                if (lit === undefined) {
                    log.trace(`resolveDollarBraces 失败:${raw}(\${${tok.content}} 代换后非字面串)`);
                    return undefined;
                }
                substituted = substituted.replace("${" + tok.content + "}", lit);
            } else if (tok.kind === "extension" && tok.content.indexOf("${") >= 0) {
                // XG10:$() 内 ${} 先展开(官方):内部纯标识符全部具静态值才落地
                const inner = lexDollar(tok.content);
                let newContent = tok.content;
                for (const itok of inner.tokens) {
                    if (itok.kind !== "expr") {
                        continue;
                    }
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(itok.content)) {
                        log.trace(`resolveDollarBraces 失败:${raw}($() 内 \${${itok.content}} 非纯标识符)`);
                        return undefined;
                    }
                    const rel = itok.from; // inner 以 base 0 词法,from 即 content 内相对位置
                    const hit = staticProp(itok.content, tok.from + 2 + rel);
                    if (!hit) {
                        log.trace(`resolveDollarBraces 失败:${raw}($() 内 ${itok.content} 无静态 value)`);
                        return undefined;
                    }
                    recordDef(hit.def, itok.content);
                    newContent = newContent.replace("${" + itok.content + "}", hit.value);
                }
                substituted = substituted.replace("$(" + tok.content + ")", "$(" + newContent + ")");
            }
        }
        if (!firstDefUri) {
            log.trace(`resolveDollarBraces 失败:${raw}(无 \${} 片段)`);
            return undefined;
        }
        const target = this.packages.resolveFileRef(substituted, file);
        if (!target) {
            log.trace(`resolveDollarBraces 失败:${raw} → 代入后 ${substituted} 解析不出 target`);
            return undefined;
        }
        log.trace(`resolveDollarBraces 成功:${raw} → ${substituted} → ${target.fsPath}(def @ ${path.basename(firstDefUri.fsPath)})`);
        return { target, defUri: firstDefUri, defName: firstDefName! };  // ★ 返回 defName(12 §4.2)
    }

    /** 含 ${} 的边无论 ok/pending 都重求值;先清旧边再重标定(修复 L3,12 §4.4) */
    reparseDollarEdges(uri: vscode.Uri): void {
        const node = this.nodes.get(uri.toString());
        if (!node) {
            return;
        }
        // ① 先清:本文件作为依赖者的所有旧边(不管定义是否仍存在)
        this.removeDepFromAll(uri);
        // ② 再标:求值成功的边重新登记(带 defName)
        let okCount = 0;
        let pendCount = 0;
        for (const e of node.includes) {
            if (e.raw.indexOf("${") < 0) {
                continue;
            }
            const r = this.resolveDollarBraces(e.raw, uri, e.line, e.startColumn);
            if (r) {
                e.target = r.target;
                e.status = "ok";
                this.recordUseDef(r.defUri, r.defName, uri);   // ★ 加 defName(12 §4.4)
                okCount++;
            } else {
                e.target = undefined;
                e.status = "pending";
                pendCount++;
            }
        }
        log.trace(`reparseDollarEdges(${path.basename(uri.fsPath)}):${okCount} ok / ${pendCount} pending`);
        this.invalidate(uri);
    }

    /** 包路径 pending 边重解(非 ${}),见 01 §2.1 */
    reparsePending(uri: vscode.Uri): void {
        const node = this.nodes.get(uri.toString());
        if (!node) {
            return;
        }
        let hitCount = 0;
        for (const e of node.includes) {
            if (e.status !== "pending" || e.raw.indexOf("${") >= 0) {
                continue;
            }
            const { target, status } = this.resolveInclude(e.raw, uri);
            e.target = target;
            e.status = status;
            if (target && status === "ok") {
                this.addIncluderEdge(target, uri, e.index);
                hitCount++;
            }
        }
        log.trace(`reparsePending(${path.basename(uri.fsPath)}):${hitCount} 条落地`);
        this.invalidate(uri);
    }

    // ===================== 工具(01 §2.6) =====================

    /** 文本偏移 → { line, column }(0 基,VSCode Position 兼容)。
     *  lineStarts 存在时二分查行索引(O(log n));缺失时兜底逐字符(兼容,理论不会走)。 */
    private offsetToPos(text: string, offset: number, lineStarts?: number[]): { line: number; column: number } {
        const limit = Math.min(offset, text.length);
        if (lineStarts && lineStarts.length > 0) {
            // 二分:最后一个 lineStarts[i] <= limit 的行
            let lo = 0;
            let hi = lineStarts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (lineStarts[mid] <= limit) {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            return { line: lo, column: limit - lineStarts[lo] };
        }
        let line = 0;
        let lastNewline = -1;
        for (let i = 0; i < limit; i++) {
            if (text.charCodeAt(i) === 10) {
                line++;
                lastNewline = i;
            }
        }
        return { line, column: limit - (lastNewline + 1) };
    }

    /** { line, column } → 文本偏移。lineStarts 存在时直接查表(O(1));缺失时兜底逐行扫描。 */
    private offsetOf(text: string, line: number, column: number, lineStarts?: number[]): number {
        if (lineStarts && lineStarts.length > 0) {
            if (line < 0) {
                return column;                       // 与旧逐行实现 line<0 时循环不执行返回 column 等价
            }
            if (line >= lineStarts.length) {
                return text.length;
            }
            return lineStarts[line] + column;
        }
        let offset = 0;
        for (let i = 0; i < line; i++) {
            const nl = text.indexOf("\n", offset);
            if (nl < 0) {
                return text.length;
            }
            offset = nl + 1;
        }
        return offset + column;
    }

    // ===================== 反向边维护 =====================

    private addIncluderEdge(target: vscode.Uri, source: vscode.Uri, index: number): void {
        const key = target.toString();
        let list = this.includerMap.get(key);
        if (!list) {
            list = [];
            this.includerMap.set(key, list);
        }
        if (!list.some(it => it.source.toString() === source.toString() && it.index === index)) {
            list.push({ source, index });
        }
    }

    private removeIncluderEdge(target: vscode.Uri, source: vscode.Uri, index: number): void {
        const key = target.toString();
        const list = this.includerMap.get(key);
        if (!list) {
            return;
        }
        this.includerMap.set(key, list.filter(it => !(it.source.toString() === source.toString() && it.index === index)));
    }

    /** 是否需要兜底:无父 或 上次兜底后该文件内容有变化(M1)。
     *  XG13:搜索域外文件(工作区根之外)恒不需要——fallback 内部同样拦截,此处提前
     *  短路,避免防抖簿记与"未命中原因线索"之外的无效触发。 */
    private needFallback(file: vscode.Uri): boolean {
        if (!this.inFallbackDomain(file)) {
            return false;
        }
        const key = file.toString();
        const node = this.nodes.get(key);
        const hasParent = (this.includerMap.get(key)?.length ?? 0) > 0;
        if (!hasParent) {
            return true;
        }
        if (node) {
            const lastVer = this.lastFallbackVersion.get(key) ?? 0;
            return node.version > lastVer;
        }
        return true;
    }
}
