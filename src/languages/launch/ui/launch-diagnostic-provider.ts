/**
 * launch-diagnostic-provider — launch 语义诊断(LH 批次,2026-10-01;下波浪线 warning)
 *
 * 覆盖(用户裁定"全面:格式+可解析"):
 *  - 格式类(纯静态,零环境依赖):pkg/exec 值含前导或后导空白(引号内空格是值的一部分)、
 *    包名非法字符(ROS 包名仅字母/数字/_/-,含中间空格)、可执行名非法字符(另允许 .);
 *  - 可解析类(仅名单就绪后判定,就绪事件触发重算清除——rosmsg RE-1 同款):
 *    未知包(工作区+系统名单均未找到)、未知可执行或未构建(install-truth 无源)、
 *    include 目标不存在或无法解析(yaml/xml;py include 解析失败本就静默)。
 * 三格式(.launch.py / .launch|.xml / .launch.yaml|.yml);LA-1 域门控;非 file scheme 静默早退。
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getLogger } from "../../../logger";
import type { PackageMap } from "../../shared/package-map";
import { fileInWorkspaceDomain } from "../../shared/workspace-domain";
import { decodeXmlEntities } from "../../shared/xml-utils";
import * as core from "../core/launch-completion-core";
import { scanLaunchNodeRefs } from "../parse/launch-py-parser";
import { resolveLaunchIncludePath } from "./launch-link-provider";
import type { LaunchExecSource } from "./launch-completion";

const log = getLogger("launch-diagnostics");

/** 模块级取消令牌(诊断查询共用;分析非交互路径,无需细粒度取消) */
const sharedTokenSource = new vscode.CancellationTokenSource();
const sharedToken = sharedTokenSource.token;

const PKG_NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXEC_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** 值的格式类诊断(共通:首尾空白 / 字符集) */
function formatDiagnostics(
    value: string,
    range: vscode.Range,
    kind: "pkg" | "exec"
): vscode.Diagnostic[] {
    const out: vscode.Diagnostic[] = [];
    const label = kind === "pkg" ? "包名" : "可执行名";
    const charsetRe = kind === "pkg" ? PKG_NAME_RE : EXEC_NAME_RE;
    if (value !== value.trim()) {
        out.push(new vscode.Diagnostic(
            range,
            `${label}含前导或后导空白(引号内空格是值的一部分,ROS ${label}不允许)`,
            vscode.DiagnosticSeverity.Warning
        ));
    } else if (!charsetRe.test(value)) {
        const extra = kind === "exec" ? "或点" : "";
        out.push(new vscode.Diagnostic(
            range,
            `${label}含非法字符(ROS ${label}仅允许字母/数字/_/-${extra})`,
            vscode.DiagnosticSeverity.Warning
        ));
    }
    return out;
}

/** 行起始偏移表(按原文 `\n` 累计,CRLF 自然计入) */
function buildLineStarts(text: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            starts.push(i + 1);
        }
    }
    return starts;
}

/** 动作行正则(`- node:` / `- include:`) */
const NODE_DASH_RE = /^(\s*)-\s*node\s*:\s*(?:#.*)?$/;
const INCLUDE_DASH_RE = /^(\s*)-\s*include\s*:\s*(?:#.*)?$/;

interface YamlValueHit {
    key: "pkg" | "exec" | "file";
    line: number;
    span: core.YamlScalarSpan;
}

/** yaml:扫描全部 `- node:` / `- include:` 块内的 pkg/exec/file 值(区间=值内容,行内) */
function scanYamlValueHits(text: string): YamlValueHit[] {
    const out: YamlValueHit[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const isNode = NODE_DASH_RE.test(lines[i]);
        const isInclude = !isNode && INCLUDE_DASH_RE.test(lines[i]);
        if (!isNode && !isInclude) {
            continue;
        }
        const dashIndent = (lines[i].match(/^[ \t]*/) || [""])[0].length;
        for (let j = i + 1; j < lines.length; j++) {
            const ln = lines[j];
            if (ln.trim() === "") {
                continue;
            }
            const indent = (ln.match(/^[ \t]*/) || [""])[0].length;
            if (indent <= dashIndent) {
                break;
            }
            const km = /^(\s+)(file|pkg|exec)\s*:/.exec(ln);
            if (!km) {
                continue;
            }
            const key = km[2] as YamlValueHit["key"];
            if (isInclude && key !== "file") {
                continue;
            }
            const colon = ln.indexOf(":");
            const span = core.parseYamlScalarValue(ln, colon + 1);
            if (!span || !span.value) {
                continue;
            }
            out.push({ key, line: j, span });
        }
    }
    return out;
}

/** yaml 诊断:node 块 pkg/exec(格式+可解析)、include file(可解析) */
async function yamlDiagnostics(
    document: vscode.TextDocument,
    text: string,
    packages: PackageMap | undefined,
    exec: LaunchExecSource | undefined,
    token: vscode.CancellationToken
): Promise<vscode.Diagnostic[]> {
    const out: vscode.Diagnostic[] = [];
    const lineStarts = buildLineStarts(text);
    const names = packages ? new Set(packages.getPackageNames()) : undefined;
    const hits = scanYamlValueHits(text);
    for (const hit of hits) {
        if (token.isCancellationRequested) {
            return out;
        }
        const range = new vscode.Range(
            new vscode.Position(hit.line, hit.span.contentStart),
            new vscode.Position(hit.line, hit.span.contentEnd)
        );
        if (hit.key === "file") {
            // include file:可解析性(解析失败 = 目标不存在或表达式不可解)
            const resolved = await resolveLaunchIncludePath(
                hit.span.value,
                document.uri,
                packages,
                token
            );
            if (!resolved) {
                out.push(new vscode.Diagnostic(
                    range,
                    `include 目标不存在或无法解析:"${hit.span.value}"`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
            continue;
        }
        // 格式类(pkg/exec 共通)
        out.push(...formatDiagnostics(hit.span.value, range, hit.key === "pkg" ? "pkg" : "exec"));
        // 可解析类:pkg 未知(仅系统名单就绪后判定,杜绝环境未就绪误报)
        if (hit.key === "pkg" && packages?.systemAvailable && names && !names.has(hit.span.value)) {
            out.push(new vscode.Diagnostic(
                range,
                `未知包 "${hit.span.value}"(工作区与系统均未找到;若刚创建请构建/刷新)`,
                vscode.DiagnosticSeverity.Warning
            ));
        }
        // exec 存在性:仅 pkg 字面且已知时判定(未知包不重复提示)
        if (hit.key === "exec" && exec && packages?.systemAvailable) {
            const pkgLineStart = lineStarts[hit.line];
            const pkg = core.yamlSiblingKeyValue(text, pkgLineStart, "pkg");
            if (pkg && names?.has(pkg)) {
                const src = await exec.sourceOf(pkg, hit.span.value).catch(() => undefined);
                if (src === undefined) {
                    out.push(new vscode.Diagnostic(
                        range,
                        `未知可执行或未构建 "${hit.span.value}"(install-truth 无源文件记录)`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
            }
        }
    }
    return out;
}

/** 原文 offset → Position(逐字符统计,诊断调用频度低可接受) */
function positionOf(text: string, abs: number): vscode.Position {
    let line = 0;
    let last = 0;
    for (let i = 0; i < abs; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            last = i + 1;
        }
    }
    return new vscode.Position(line, abs - last);
}

/** xml 诊断:include file(可解析)+ node pkg/exec(格式+pkg 未知+exec 存在性) */
async function xmlDiagnostics(
    document: vscode.TextDocument,
    text: string,
    packages: PackageMap | undefined,
    exec: LaunchExecSource | undefined,
    token: vscode.CancellationToken
): Promise<vscode.Diagnostic[]> {
    const out: vscode.Diagnostic[] = [];
    const names = packages ? new Set(packages.getPackageNames()) : undefined;
    // include file:可解析性
    const includeRe = /<include\b[^>]*\bfile="([^"]+)"[^>]*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = includeRe.exec(text)) !== null) {
        if (token.isCancellationRequested) {
            return out;
        }
        const filePath = m[1];
        const fileAttrStart = m.index + m[0].indexOf('file="') + 'file="'.length;
        const range = new vscode.Range(positionOf(text, fileAttrStart), positionOf(text, fileAttrStart + filePath.length));
        const resolved = await resolveLaunchIncludePath(decodeXmlEntities(filePath), document.uri, packages, token);
        if (!resolved) {
            out.push(new vscode.Diagnostic(
                range,
                `include 目标不存在或无法解析:"${filePath}"`,
                vscode.DiagnosticSeverity.Warning
            ));
        }
    }
    // node pkg/exec:格式 + pkg 未知(exec 存在性经异步 exec 源检查,交由 exec 存在……)
    const nodeRe = /<node\b([^>]*)>/g;
    let nm: RegExpExecArray | null;
    while ((nm = nodeRe.exec(text)) !== null) {
        if (token.isCancellationRequested) {
            return out;
        }
        const attrs = nm[1];
        const attrRange = (attr: string): { range: vscode.Range; value: string } | undefined => {
            const am = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"|\\b${attr}\\s*=\\s*'([^']*)'`).exec(attrs);
            if (!am) {
                return undefined;
            }
            const value = decodeXmlEntities(am[1] ?? am[2] ?? "");
            const attrAbs = nm.index + nm[0].indexOf(am[0]);
            const vs = attrAbs + am[0].indexOf(am[1] ?? am[2] ?? "");
            return { range: new vscode.Range(positionOf(text, vs), positionOf(text, vs + (am[1] ?? am[2] ?? "").length)), value };
        };
        const pkgA = attrRange("pkg");
        const execA = attrRange("exec");
        if (pkgA) {
            out.push(...formatDiagnostics(pkgA.value, pkgA.range, "pkg"));
            if (packages?.systemAvailable && names && !names.has(pkgA.value)) {
                out.push(new vscode.Diagnostic(
                    pkgA.range,
                    `未知包 "${pkgA.value}"(工作区与系统均未找到;若刚创建请构建/刷新)`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
        }
        if (execA) {
            out.push(...formatDiagnostics(execA.value, execA.range, "exec"));
            // exec 存在性:仅 pkg 字面且已知时判定(未知包不重复提示)
            const pkgValue = pkgA ? pkgA.value : undefined;
            if (exec && pkgValue && names?.has(pkgValue)) {
                const src = await exec.sourceOf(pkgValue, execA.value).catch(() => undefined);
                if (src === undefined) {
                    out.push(new vscode.Diagnostic(
                        execA.range,
                        `未知可执行或未构建 "${execA.value}"(install-truth 无源文件记录)`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
            }
        }
    }
    return out;
}

/** py 诊断:Node 系 package/executable(格式+pkg 未知+exec 存在性) */
async function pyDiagnostics(
    document: vscode.TextDocument,
    text: string,
    packages: PackageMap | undefined,
    exec: LaunchExecSource | undefined,
    token: vscode.CancellationToken
): Promise<vscode.Diagnostic[]> {
    const out: vscode.Diagnostic[] = [];
    const names = packages ? new Set(packages.getPackageNames()) : undefined;
    for (const ref of scanLaunchNodeRefs(text)) {
        if (token.isCancellationRequested) {
            return out;
        }
        if (ref.package && ref.packageRange) {
            const range = new vscode.Range(document.positionAt(ref.packageRange[0]), document.positionAt(ref.packageRange[1]));
            out.push(...formatDiagnostics(ref.package, range, "pkg"));
            if (packages?.systemAvailable && names && !names.has(ref.package)) {
                out.push(new vscode.Diagnostic(
                    range,
                    `未知包 "${ref.package}"(工作区与系统均未找到;若刚创建请构建/刷新)`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
        }
        if (ref.executable && ref.executableRange) {
            const range = new vscode.Range(document.positionAt(ref.executableRange[0]), document.positionAt(ref.executableRange[1]));
            out.push(...formatDiagnostics(ref.executable, range, "exec"));
            // exec 存在性:仅 pkg 字面且已知时判定(未知包不重复提示)
            if (exec && ref.package && names?.has(ref.package)) {
                const src = await exec.sourceOf(ref.package, ref.executable).catch(() => undefined);
                if (src === undefined) {
                    out.push(new vscode.Diagnostic(
                        range,
                        `未知可执行或未构建 "${ref.executable}"(install-truth 无源文件记录)`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
            }
        }
    }
    return out;
}

/**
 * 分析单个文档,返回诊断列表(LH-1/2;异步:yaml/xml 的 include 可解析与 py exec 存在性
 * 经 PackageMap/install-truth 查询;导出供单元测试)。
 */
export async function analyzeLaunchDocument(
    document: vscode.TextDocument,
    packages: PackageMap | undefined,
    exec: LaunchExecSource | undefined,
    token: vscode.CancellationToken
): Promise<vscode.Diagnostic[]> {
    if (!fileInWorkspaceDomain(document.uri)) {
        return [];
    }
    const text = document.getText();
    const fileName = document.fileName;
    if (fileName.endsWith(".launch.py")) {
        return pyDiagnostics(document, text, packages, exec, token);
    }
    if (/\.launch\.ya?ml$/i.test(fileName)) {
        return yamlDiagnostics(document, text, packages, exec, token);
    }
    return xmlDiagnostics(document, text, packages, exec, token);
}

/**
 * 注册 launch 语义诊断( LH-1/2;不依赖 context,disposables 由调用方入订阅)。
 * 返回 reanalyzeAll:名单/构建就绪与刷新事件触发重算——"未知包/未构建"警告自动消除。
 */
export function registerLaunchDiagnostics(
    packages: PackageMap | undefined,
    exec: LaunchExecSource | undefined
): { disposables: vscode.Disposable[]; reanalyzeAll(): void } {
    const collection = vscode.languages.createDiagnosticCollection("launch");
    const timer: { t?: NodeJS.Timeout } = {};
    const skippedSchemes = new Set<string>();

    const analyzeOne = async (document: vscode.TextDocument): Promise<void> => {
        if (document.languageId === "rosmsg" || document.languageId === "xacro") {
            return; // 邻域语言早退
        }
        if (document.uri.scheme !== "file") {
            if (!skippedSchemes.has(document.uri.scheme)) {
                skippedSchemes.add(document.uri.scheme);
                log.debug(vscode.l10n.t("Diagnostics skipped (not a real file): {0} (further skips downgrade to trace)", document.uri.scheme));
            } else {
                log.trace(vscode.l10n.t("Diagnostics skipped (not a real file): {0}", document.uri.scheme));
            }
            return;
        }
        const fileName = document.fileName;
        if (!fileName.endsWith(".launch.py") && !/\.launch\.ya?ml$/i.test(fileName) && !/\.(launch|launch\.xml)$/i.test(fileName)) {
            return; // 非 launch 文件(逐字面早退,静默)
        }
        try {
            const result = await analyzeLaunchDocument(document, packages, exec, sharedToken);
            collection.set(document.uri, result.length > 0 ? result : undefined);
            log.trace(vscode.l10n.t("launch diagnostics: {0} {1} items", path.basename(fileName), result.length));
        } catch (err) {
            log.warn(vscode.l10n.t("launch diagnostics failed: {0}", (err as Error).message));
        }
    };
    const analyze = (document: vscode.TextDocument): void => {
        void analyzeOne(document);
    };
    const reanalyzeAll = (): void => {
        for (const doc of vscode.workspace.textDocuments) {
            analyze(doc);
        }
    };

    const changeListener = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.scheme !== "file" || !/\.(launch|launch\.xml|launch\.py|launch\.yaml|launch\.yml)$/i.test(event.document.fileName)) {
            return;
        }
        if (timer.t) {
            clearTimeout(timer.t);
        }
        timer.t = setTimeout(() => analyze(event.document), 500);
    });
    const openListener = vscode.workspace.onDidOpenTextDocument(analyze);
    const closeListener = vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri));

    // 初始扫描
    reanalyzeAll();

    log.info("launch semantic diagnostics registered (format + parseability, warning squiggles)");
    return {
        disposables: [
            collection,
            changeListener,
            openListener,
            closeListener,
            { dispose: () => { if (timer.t) { clearTimeout(timer.t); } } }
        ],
        reanalyzeAll
    };
}
