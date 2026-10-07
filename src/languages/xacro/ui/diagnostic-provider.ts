/**
 * xacro 诊断提供器(设计 08:D1-D7)
 *
 * 原则:信息全部来自 IncludeGraph 已算出的数据 + 轻量图遍历,**不重复解析**。
 * severity 分级:Error(环,结构性) / Warning(目标确实不存在) / Hint(未找到·宽松) / Info(环境,仅日志)。
 * 触发:文档打开/变化(防抖 300ms)/关闭;包位置就绪(onDirLoaded)重刷;D6 走 graph.onPropertyCycle 事件。
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { Tree } from "@lezer/common";
import { getLogger } from "../../../logger";
import { IncludeGraph, PropertyCycleStep } from "../core/include-graph";
import { PackageMap } from "../../shared/package-map";
import { forEachElement } from "../../shared/xml-utils";
import { parseXacroDocument, staticBoolean } from "../parse/xacro-document";
import { SUBST_COMMANDS } from "../parse/xacro-tags";
import { EVAL_BARE_IDENTS } from "../parse/expression-tokens";
import { resolveNsQualified } from "./ns-resolve";
// XG5(2026-09-24):关键词表收敛到 parse/xacro-tags 单一来源(修 X-F3 双份漂移)
import { XACRO_KEYWORDS } from "../parse/xacro-tags";

const log = getLogger("xacro-diagnostics");

const XACRO_SELECTOR: vscode.DocumentSelector = [
    { scheme: "file", pattern: "**/*.xacro" },
    { scheme: "file", pattern: "**/*.urdf" }
];

const DEBOUNCE_MS = 300;
/** 超大文档阈值:跳过逐元素/逐 ${} 扫描(同 04 降级) */
const LARGE_DOC_LINE_LIMIT = 10000;

function isXacroDoc(doc: vscode.TextDocument): boolean {
    const ext = path.extname(doc.uri.fsPath).toLowerCase();
    return ext === ".xacro" || ext === ".urdf";
}

/** 是否包引用($(find...) / package://) */
export function isPackageRef(raw: string): boolean {
    return raw.indexOf("$(") >= 0 || raw.startsWith("package://");
}

/** 从包引用提取包名 */
export function extractPkg(raw: string): string {
    const fm = raw.match(/\$\(\s*find(?:\s*-\s*pkg-share)?\s+([a-zA-Z0-9_-]+)/);
    if (fm) {
        return fm[1];
    }
    const pm = raw.match(/^package:\/\/([^/]+)/);
    if (pm) {
        return pm[1];
    }
    return raw;
}

/** xacro:macro 的 params 属性 → 参数名数组(支持空白分隔与 "name:=默认值" 写法) */
export function parseMacroParams(paramsValue: string): string[] {
    return paramsValue
        .split(/\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => s.split(":=")[0].trim())
        .filter(s => /^[a-zA-Z0-9_]+$/.test(s));
}

/** 文档内每个 xacro:macro 元素的跨度 + 其形参名集合(供宏体内 ${} 判定) */
export interface MacroParamSpan {
    from: number;       // Element 起始 offset("<")
    to: number;         // Element 结束 offset(排他,含 </xacro:macro>)
    params: Set<string>;
    macroName?: string; // 宏名(name 属性;跳转形参时定位到宏定义用)
}

/** 收集全文宏参数跨度(一次 lezer 遍历,供 D5 宏体形参豁免) */
export function collectMacroParamSpans(tree: Tree, text: string): MacroParamSpan[] {
    const spans: MacroParamSpan[] = [];
    forEachElement(tree.topNode, text, (_elem, info) => {
        if (info.tag === "xacro:macro") {
            const p = info.attrs.find(a => a.name === "params");
            const names = p && typeof p.value === "string" ? parseMacroParams(p.value) : [];
            const n = info.attrs.find(a => a.name === "name");
            spans.push({
                from: info.spanFrom,
                to: info.spanTo,
                params: new Set(names),
                macroName: n && typeof n.value === "string" ? n.value : undefined
            });
        }
    });
    return spans;
}

/** offset 是否处于某宏体内、且 name 是该宏的形参(嵌套取最内层宏) */
export function isMacroParamRef(spans: MacroParamSpan[], offset: number, name: string): boolean {
    return enclosingMacroSpan(spans, offset)?.params.has(name) ?? false;
}

/** offset 所在的最内层宏跨度(用于把形参引用跳转/悬浮定位到宏定义);无则 undefined */
export function enclosingMacroSpan(spans: MacroParamSpan[], offset: number): MacroParamSpan | undefined {
    let best: MacroParamSpan | undefined;
    for (const s of spans) {
        if (s.from <= offset && offset < s.to && (!best || s.from > best.from)) {
            best = s;
        }
    }
    return best;
}

/**
 * D1/D2 分类(e 为 include 边):
 * - 目标已解析但文件不存在 → "D1"(悬垂 include, Warning)
 * - 包引用悬空 → "D2"(Hint,继续轮巡)
 * - 其它(相对/绝对路径目标存在 / ${} 变量悬空) → undefined(静默,${} 归 D5)
 * XG10:optional="true" 的 include 官方静默跳过缺失文件(13 §3.5)→ D1 豁免。
 */
export function classifyEdge(
    e: { target?: vscode.Uri; raw: string; optional?: boolean },
    exists: (p: string) => boolean
): "D1" | "D2" | undefined {
    if (e.target) {
        if (e.optional) {
            return undefined; // optional include:目标缺失官方跳过,不报悬垂
        }
        return exists(e.target.fsPath) ? undefined : "D1";
    }
    return isPackageRef(e.raw) ? "D2" : undefined;
}

/** 从 doc 出发 DFS,若 doc 处于 include 环中返回环链(basename);无环返回 undefined */
export function findIncludeCycleThrough(
    graph: Pick<IncludeGraph, "getFile">,
    doc: vscode.Uri
): string[] | undefined {
    const onStack = new Set<string>();
    const pathStack: vscode.Uri[] = [];
    const docName = path.basename(doc.fsPath);
    const walk = (f: vscode.Uri): string[] | undefined => {
        const key = f.toString();
        if (onStack.has(key)) {
            const idx = pathStack.findIndex(u => u.toString() === key);
            return pathStack.slice(idx).map(u => path.basename(u.fsPath));
        }
        onStack.add(key);
        pathStack.push(f);
        const node = graph.getFile(f);
        if (node) {
            for (const e of node.includes) {
                if (e.target) {
                    const cyc = walk(e.target);
                    if (cyc) {
                        return cyc;
                    }
                }
            }
        }
        pathStack.pop();
        onStack.delete(key);
        return undefined;
    };
    const cycle = walk(doc);
    if (cycle && cycle.some(name => name === docName)) {
        return cycle;
    }
    return undefined;
}

/** 在当前文档找"指向环"的 include 边行号;无则 0 */
export function closingEdgeLine(
    graph: Pick<IncludeGraph, "getFile">,
    doc: vscode.Uri,
    cycle: string[]
): number {
    const node = graph.getFile(doc);
    if (node) {
        const names = new Set(cycle);
        for (const e of node.includes) {
            if (e.target && names.has(path.basename(e.target.fsPath))) {
                return e.line;
            }
        }
    }
    return 0;
}

/**
 * 注册 xacro 诊断(D1-D14)。返回一次性 Disposable(集合 + 订阅)。
 */
export function registerXacroDiagnostics(graph: IncludeGraph, packages: PackageMap): vscode.Disposable {
    const collection = vscode.languages.createDiagnosticCollection("xacro");
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    // D7:环境不可用(日志通道 Info,非波浪线)
    const logEnvStatus = (): void => {
        if (!packages.systemAvailable) {
            log.info("ROS 环境不可用,系统包解析降级为仅工作区");
        } else {
            log.debug("ROS 环境可用,系统包解析正常");
        }
    };

    // ---- 合作式分片工具(2026-09-07 用户确认:重分析分片 + 轮询检查"仍是激活吗",非激活即中断) ----
    /** 当前激活 xacro 文档(不存在/非 xacro → undefined) */
    const activeDoc = (): vscode.TextDocument | undefined => {
        const active = vscode.window.activeTextEditor?.document;
        return active && isXacroDoc(active) ? active : undefined;
    };
    const activeKey = (): string | undefined => activeDoc()?.uri.toString();
    const yieldTick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
    /** 分片大小(条/片):每片后让出事件循环一次,并检查是否仍是激活文档 */
    const CHUNK_SIZE = 200;
    /** 同一文档的刷新并发守卫(防防抖窗口内前次未跑完又开新任务) */
    const refreshBusy = new Set<string>();

    /** 分片执行:fn 逐条处理;每片后让出一次并轮询中断(激活文档已切换 → 返回 false)。 */
    const runChunked = async <T>(docKey: string, items: T[], fn: (item: T) => void): Promise<boolean> => {
        for (let i = 0; i < items.length; i += CHUNK_SIZE) {
            const end = Math.min(items.length, i + CHUNK_SIZE);
            for (let j = i; j < end; j++) {
                fn(items[j]);
            }
            if (end < items.length) {
                await yieldTick();
                if (activeKey() !== docKey) {
                    log.trace(`诊断刷新中断(已切走,待激活重算):doc=${path.basename(docKey)}`);
                    return false;
                }
            }
        }
        return true;
    };

    /** 计算某文档诊断(异步分片;重分析可被"切到别的文件"合作中断,未跑完不发布) */
    const refresh = async (doc: vscode.TextDocument): Promise<void> => {
        const uriKey = doc.uri.toString();
        if (refreshBusy.has(uriKey)) {
            log.trace(`诊断刷新跳过(同文档进行中):${path.basename(doc.uri.fsPath)}`);
            return;
        }
        refreshBusy.add(uriKey);
        try {
            const info = graph.getFile(doc.uri);
            if (!info) {
                collection.delete(doc.uri);
                return;
            }
            const diags: vscode.Diagnostic[] = [];
            const text = info.text;
            log.debug(`诊断刷新(${path.basename(doc.uri.fsPath)}):${info.includes.length} 条 include 边`);

            // XG6:复用图内缓存解析(FileNode.doc 与 scanIncludes/collectSymbols 同源,修 X-F4);
            // XG9:提出大文档守门之外——词法级规则(D8)在超大文档同样适用(解析与 scanIncludes 共享一次)
            const docModel = info.doc ?? (info.doc = parseXacroDocument(text, doc.uri));

            // ---- D8:未闭合 ${ / $((Error,官方 "invalid expression";词法级) ----
            for (const issue of docModel.dollarIssues) {
                if (issue.kind === "unclosed-expr" || issue.kind === "unclosed-extension") {
                    diags.push(new vscode.Diagnostic(
                        new vscode.Range(doc.positionAt(issue.from), doc.positionAt(issue.to)),
                        issue.kind === "unclosed-expr" ? `未闭合的 \${…}(缺少 })` : `未闭合的 $(…)(缺少 ))`,
                        vscode.DiagnosticSeverity.Error
                    ));
                }
            }

            // ---- D1/D2:include 边(轻量,不分片) ----
            for (const e of info.includes) {
                const range = new vscode.Range(e.line, e.startColumn, e.line, e.endColumn);
                const cls = classifyEdge(e, fs.existsSync);
                if (cls === "D1") {
                    // 目标已解析但文件不存在 → D1(悬垂 include, Warning)
                    log.trace(`D1 悬垂 include:${e.target!.fsPath}`);
                    diags.push(new vscode.Diagnostic(
                        range,
                        `目标文件不存在:${e.target!.fsPath}`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                } else if (cls === "D2") {
                    // 包引用悬空 → D2(Hint,继续轮巡)
                    log.trace(`D2 包未找到:${extractPkg(e.raw)}(悬空)`);
                    diags.push(new vscode.Diagnostic(
                        range,
                        `未找到包 ${extractPkg(e.raw)}(悬空,继续轮巡;可能未构建或环境未 source)`,
                        vscode.DiagnosticSeverity.Hint
                    ));
                }
            }

            // ---- D3:include 环(Error,结构性) ----
            const cycle = findIncludeCycleThrough(graph, doc.uri);
            if (cycle) {
                const line = closingEdgeLine(graph, doc.uri, cycle);
                log.trace(`D3 include 环:${cycle.join(" ↔ ")}`);
                diags.push(new vscode.Diagnostic(
                    new vscode.Range(line, 0, line, 0),
                    `循环 include:${cycle.join(" ↔ ")}`,
                    vscode.DiagnosticSeverity.Error
                ));
            }

            if (doc.lineCount <= LARGE_DOC_LINE_LIMIT) {
                const tree = docModel.tree;
                const macroSpans = collectMacroParamSpans(tree, text);

                // ---- D9:$() 未知命令(Warning;官方集 find/env/optenv/dirname/arg + eval 特例 +
                //      xacro 原生 cwd;find-pkg-share 非官方但宽容不报,13 §4) ----
                for (const seg of docModel.dollarSegments) {
                    for (const tok of seg.res.tokens) {
                        if (tok.kind !== "extension") {
                            continue;
                        }
                        const cmd = /^\s*([A-Za-z_][A-Za-z0-9_-]*)/.exec(tok.content)?.[1];
                        if (cmd && !SUBST_COMMANDS.has(cmd)) {
                            diags.push(new vscode.Diagnostic(
                                new vscode.Range(doc.positionAt(tok.from), doc.positionAt(tok.to)),
                                `未知替换命令 "$(${cmd} …)"(官方:find/env/optenv/dirname/arg/eval/cwd)`,
                                vscode.DiagnosticSeverity.Warning
                            ));
                        }
                    }
                }

                // ---- D12:if/unless 条件静态非布尔(Hint;仅字面量/纯 ${ident} 可判,13 §3.4) ----
                for (const tag of ["if", "unless"] as const) {
                    for (const inst of docModel.tags.get(tag) ?? []) {
                        const raw = inst.attrs.get("value")?.value;
                        if (raw === undefined) {
                            continue;
                        }
                        const flag = (v: string | undefined): void => {
                            if (v !== undefined && staticBoolean(v) === undefined) {
                                diags.push(new vscode.Diagnostic(
                                    new vscode.Range(doc.positionAt(inst.info.spanFrom), doc.positionAt(inst.info.spanTo)),
                                    `条件 "${raw}" 静态判定非布尔字面量(官方仅接受 true/True/false/False 或整数字符串)`,
                                    vscode.DiagnosticSeverity.Hint
                                ));
                            }
                        };
                        if (!raw.includes("$")) {
                            flag(raw);
                        } else {
                            const em = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw.trim());
                            if (em) {
                                const def = graph.findSymbol(doc.uri, doc.positionAt(inst.info.spanFrom), em[1], "property");
                                flag(def?.value);
                            }
                        }
                    }
                }

                // ---- D13:属性重定义 / 覆盖内建(Hint,官方告警行为,13 §3.1;宏体内属性是宏作用域,不算) ----
                const seenProps = new Set<string>();
                for (const p of docModel.symbols.props) {
                    if (docModel.symbols.macros.some(mm => mm.info.spanFrom <= p.info.spanFrom && p.info.spanFrom < mm.info.spanTo)) {
                        continue; // 宏体内定义 → 宏作用域
                    }
                    const base = p.nameAttr.valueFrom >= 0 ? p.nameAttr.valueFrom : p.info.spanFrom;
                    const range = new vscode.Range(doc.positionAt(base), doc.positionAt(base + p.name.length));
                    if (EVAL_BARE_IDENTS.has(p.name)) {
                        diags.push(new vscode.Diagnostic(
                            range, vscode.l10n.t("Property \"{0}\" shadows an official built-in symbol (math functions/constants)", p.name), vscode.DiagnosticSeverity.Hint));
                    } else if (seenProps.has(p.name)) {
                        diags.push(new vscode.Diagnostic(
                            range, vscode.l10n.t("Property \"{0}\" redefined (official behavior: the latter overrides the former)", p.name), vscode.DiagnosticSeverity.Hint));
                    }
                    seenProps.add(p.name);
                }

                // ---- D4:可见性 blocker(Hint,分片)+ D14 未知宏 + D10/D11 调用点参数级(XG9) ----
                // 先轻量收集候选(标签名/位置/属性),重查(findSymbol/findSymbolAny)分片执行
                const d4Items: { name: string; pos: vscode.Position; tag: string; attrs: Map<string, { name: string }> }[] = [];
                forEachElement(tree.topNode, text, (_elem, elemInfo) => {
                    const tag = elemInfo.tag;
                    if (!tag || !tag.startsWith("xacro:")) {
                        return;
                    }
                    const name = tag.slice("xacro:".length);
                    if (XACRO_KEYWORDS.has(name)) {
                        return;
                    }
                    d4Items.push({ name, tag, pos: doc.positionAt(elemInfo.spanFrom), attrs: new Map(elemInfo.attrs.map(a => [a.name, a])) });
                });
                const ok4 = await runChunked(uriKey, d4Items, (it) => {
                    // XG12:点号名(kit.kit_plate)先走 N 级 ns 寻址——命中即合法(官方 resolve_macro
                    // 逐段切分走 NameSpace 链),不再按全名查表误报"未知宏"
                    if (it.name.indexOf(".") >= 0) {
                        const segs = it.name.split(".");
                        const hit = resolveNsQualified(graph, docModel, doc.uri, segs, "macro");
                        if (hit) {
                            log.trace(`D14 跳过(ns 命中):${it.name} → ${path.basename(hit.ref.uri.fsPath)}:${hit.ref.line + 1}`);
                            return;
                        }
                        const range = new vscode.Range(it.pos, it.pos.translate(0, it.tag.length + 1));
                        diags.push(new vscode.Diagnostic(
                            range,
                            `未知宏 ${it.name}(命名空间链解析失败:ns 未 include 或末段无定义)`,
                            vscode.DiagnosticSeverity.Hint
                        ));
                        return;
                    }
                    const def = graph.findSymbol(doc.uri, it.pos, it.name, "macro");
                    if (!def) {
                        const any = graph.findSymbolAny(doc.uri, it.name, "macro");
                        const range = new vscode.Range(it.pos, it.pos.translate(0, it.tag.length + 1));
                        if (any) {
                            log.trace(`D4 可见性 blocker:${it.name} 需先 include ${path.basename(any.uri.fsPath)}`);
                            diags.push(new vscode.Diagnostic(
                                range,
                                `${it.name} 需先 include ${path.basename(any.uri.fsPath)}(定义在展开序之后)`,
                                vscode.DiagnosticSeverity.Hint
                            ));
                        } else {
                            // D14(XG9):全图无定义(可能是未扫描到的文件——Hint 不误导)
                            diags.push(new vscode.Diagnostic(
                                range,
                                `未知宏 ${it.name}(可见域内无定义)`,
                                vscode.DiagnosticSeverity.Hint
                            ));
                        }
                        return; // 定义找不到,参数级检查无从谈起
                    }
                    // ---- D10/D11(XG9):调用点参数级(官方:多余属性/缺标量均为硬错误,此处 Warning) ----
                    if (def.params?.length) {
                        const paramNames = new Set(def.params.map(p => p.name));
                        const used = new Set<string>();
                        for (const a of it.attrs.keys()) {
                            if (!a.startsWith("xmlns:")) {
                                used.add(a);
                            }
                        }
                        for (const a of used) {
                            if (!paramNames.has(a)) {
                                diags.push(new vscode.Diagnostic(
                                    new vscode.Range(it.pos, it.pos.translate(0, it.tag.length + 1)),
                                    `宏 ${it.name} 无参数 "${a}"(官方:Invalid parameter)`,
                                    vscode.DiagnosticSeverity.Warning
                                ));
                            }
                        }
                        for (const p of def.params) {
                            if (p.kind === "scalar" && p.defaultKind === "none" && !used.has(p.name)) {
                                diags.push(new vscode.Diagnostic(
                                    new vscode.Range(it.pos, it.pos.translate(0, it.tag.length + 1)),
                                    `宏 ${it.name} 缺必填参数 "${p.name}"`,
                                    vscode.DiagnosticSeverity.Warning
                                ));
                            }
                        }
                    }
                });
                if (!ok4) {
                    return; // 中断:不发布,待激活重算
                }

                // ---- D5:${} 变量未找到(Hint,分片) ----
                // 范围 = 标识符本身;豁免:宏体形参(2026-09-06)
                const d5Items: { name: string; nameStart: number }[] = [];
                const dollarRe = /\$\{([a-zA-Z0-9_]+)\}/g;
                let dm: RegExpExecArray | null;
                while ((dm = dollarRe.exec(text)) !== null) {
                    d5Items.push({ name: dm[1], nameStart: dm.index + 2 });
                }
                const ok5 = await runChunked(uriKey, d5Items, (it) => {
                    if (isMacroParamRef(macroSpans, it.nameStart - 2, it.name)) {
                        log.trace(`D5 跳过(宏形参):${it.name}`);
                        return;
                    }
                    const startPos = doc.positionAt(it.nameStart);
                    const endPos = doc.positionAt(it.nameStart + it.name.length);
                    const def = graph.findSymbol(doc.uri, startPos, it.name, "property")
                        ?? graph.findSymbol(doc.uri, startPos, it.name, "arg");
                    if (!def) {
                        log.trace(`D5 变量未找到:${it.name}`);
                        diags.push(new vscode.Diagnostic(
                            new vscode.Range(startPos, endPos),
                            `变量 \${${it.name}} 未找到(未定义或为运行时参数)`,
                            vscode.DiagnosticSeverity.Hint
                        ));
                    }
                });
                if (!ok5) {
                    return; // 中断:不发布,待激活重算
                }
            }

            collection.set(doc.uri, diags);
            log.debug(`诊断刷新(${path.basename(doc.uri.fsPath)}):${diags.length} 条诊断`);
        } finally {
            refreshBusy.delete(uriKey);
        }
    };

    // 打开/激活驱动的"只算激活文件"防抖调度(2026-09-07 用户确认方案):
    //  - 只有当前激活(正在看)的 xacro 文档会被调度刷新;切走即跳过(相当于"暂停"),
    //    切回来再调度(相当于"恢复")——collectSymbols/expandOrder 缓存使其重复开销很小;
    //  - 非激活文档不主动整文计算,避免一口气打开多个文件时按打开顺序堆叠解析;
    //  - 已在跑的 refresh 是分片异步:每片让出并检查激活,切走即中断(见 refresh/runChunked)。
    const scheduleRefresh = (doc: vscode.TextDocument): void => {
        const key = doc.uri.toString();
        const old = timers.get(key);
        if (old) {
            clearTimeout(old);
        }
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            // 到期时若不是激活文档 → 跳过(用户已切走,视为暂停;切回会重新调度)
            const act = activeDoc();
            if (!act || act.uri.toString() !== key) {
                log.trace(`诊断刷新跳过(非激活):${path.basename(doc.uri.fsPath)}(切回激活时再算)`);
                return;
            }
            void refresh(doc);
        }, DEBOUNCE_MS));
    };

    // 打开:仅当是激活文档才调度(其余等激活)
    const openSub = vscode.workspace.onDidOpenTextDocument(doc => {
        if (!isXacroDoc(doc)) {
            return;
        }
        const act = activeDoc();
        if (act && act.uri.toString() === doc.uri.toString()) {
            log.trace(`xacro 打开(激活)调度诊断:${path.basename(doc.uri.fsPath)}`);
            scheduleRefresh(doc);
        } else {
            log.trace(`xacro 打开(非激活,不立即算):${path.basename(doc.uri.fsPath)}`);
        }
    });
    // 激活切换:新激活的 xacro 文档立刻排算(焦点优先,2026-09-07)
    const activeSub = vscode.window.onDidChangeActiveTextEditor(() => {
        const act = activeDoc();
        if (act) {
            log.trace(`激活切换 → 调度:${path.basename(act.uri.fsPath)}`);
            scheduleRefresh(act);
        }
    });
    // 变化(防抖,同样只算激活文档——后台文档变化等其激活后再算)
    const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
        if (!isXacroDoc(e.document)) {
            return;
        }
        const act = activeDoc();
        if (!act || act.uri.toString() !== e.document.uri.toString()) {
            return;
        }
        scheduleRefresh(e.document);
    });
    // 关闭
    const closeSub = vscode.workspace.onDidCloseTextDocument(doc => {
        collection.delete(doc.uri);
        const key = doc.uri.toString();
        const old = timers.get(key);
        if (old) {
            clearTimeout(old);
            timers.delete(key);
        }
    });
    // 包位置就绪 → 仅重刷当前激活文档(D1/D2 自愈;其它文档在激活时自然重算)
    const dirSub = packages.onDirLoaded(() => {
        const act = activeDoc();
        if (act) {
            log.trace(`包位置就绪,重刷激活文档(D1/D2 自愈):${path.basename(act.uri.fsPath)}`);
            scheduleRefresh(act);
        }
    });

    // ---- D6:property 依赖环(Error,传播时触发,符号级 12 §4.7) ----
    const cycleSub = graph.onPropertyCycle((steps: PropertyCycleStep[]) => {
        // 报错文本:符号链(无符号的用文件 basename 兜底)
        const msg = `property 依赖环:${steps.map(s => s.symbol ?? path.basename(s.file)).join(" → ")}`;
        log.trace(`D6 环链:${msg}`);
        log.error(msg);
        // 标注到定义处(有 line/column);定位失败兜底文件行 0
        for (const s of steps) {
            const uri = vscode.Uri.parse(s.file);
            for (const doc of vscode.workspace.textDocuments) {
                if (isXacroDoc(doc) && doc.uri.toString() === uri.toString()) {
                    const base = [...(collection.get(doc.uri) ?? [])];
                    const range = (s.line !== undefined)
                        ? new vscode.Range(s.line, s.column ?? 0, s.line, (s.column ?? 0) + (s.symbol?.length ?? 1))
                        : new vscode.Range(0, 0, 0, 0);   // 兜底:文件首行
                    base.push(new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error));
                    collection.set(doc.uri, base);
                }
            }
        }
    });

    // D7:启动检查;初始只算当前激活文档(其余在激活时自然排算,2026-09-07)
    logEnvStatus();
    const act0 = activeDoc();
    if (act0) {
        scheduleRefresh(act0);
    }

    log.info("xacro 诊断已注册:D1 悬垂 / D2 包未找到 / D3 环 / D4 可见性 / D5 变量 / D6 依赖环 / D7 环境 / D8-D14 语法级(XG9)");
    return vscode.Disposable.from(
        collection,
        openSub,
        activeSub,
        changeSub,
        closeSub,
        dirSub,
        cycleSub,
        { dispose: () => { for (const t of timers.values()) { clearTimeout(t); } } }
    );
}
