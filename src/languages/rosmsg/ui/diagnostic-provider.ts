/**
 * rosmsg(.msg/.srv/.action)语义级诊断
 *
 * 对齐"正常情况能否编译",全部基于结构模型 parseRosMessageDocument:
 *  - 结构错误(分隔线数量、数组语法、非法行、疑似 --- 等)由解析器统一产出
 *  - 字段名重复(段内)→ error
 *  - 未知消息类型(非内置且三级判定都未命中)→ warning(RE-1 接电:①索引点查 →
 *    ②findMessageWithSystemPath 系统懒登记 → ③标准布局 FS 点查——消除"索引冷时误报"与
 *    "就绪后不重算"两类时序误报,见 03-诊断接电.md)
 *  - 废弃类型(byte/char)→ warning(建议 uint8/int8)
 *  - 自包含(字段类型无包名且等于当前消息名)→ error(递归依赖)
 *  - 接口名不合规(文件基名)→ error(rosidl 构建期同判,判定见 parse/interface-name.ts)
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getLogger } from "../../../logger";
import { isBuiltinType } from "../shared/interface-data";
import { MessageIndex } from "../data/message-index";
import { parseRosMessageDocument } from "../parse/rosmsg-document";
import {
    interfaceKindOf,
    isRosidlCompliantInterfaceName,
    ROSIDL_MESSAGE_NAME_PATTERN
} from "../parse/interface-name";
import type { PackageMap } from "../../shared/package-map";

/** 扩展日志薄封装(带 msg-diagnostics 模块前缀) */
const log = getLogger("msg-diagnostics");

/**
 * 接口名合规诊断(文件级):非接口文件或合规 → undefined;Error 级,范围钉首行(文件级问题无正文落点)。
 * 判定与 rosidl 构建期逐位对齐(parse/interface-name.ts);导出供单元测试与 onDidCreateFiles
 * (新建路径,文件未打开、无 TextDocument 可分析)复用
 */
export function interfaceNameViolation(fileName: string): vscode.Diagnostic | undefined {
    const kind = interfaceKindOf(fileName);
    if (kind === undefined) {
        return undefined;
    }
    const basename = path.basename(fileName, path.extname(fileName));
    if (isRosidlCompliantInterfaceName(kind, basename)) {
        return undefined;
    }
    return new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        vscode.l10n.t(
            '"{0}" is not a valid ROS 2 interface name (rosidl pattern {1}: must start with an uppercase letter, letters and digits only)',
            basename,
            ROSIDL_MESSAGE_NAME_PATTERN
        ),
        vscode.DiagnosticSeverity.Error
    );
}

/** 标准布局 FS 点查(RE-1 三级判定第③级):<包目录>/<kind>/<Name>.<ext> 存在 */
async function standardLayoutHas(
    packages: PackageMap | undefined,
    pkg: string,
    name: string,
    kind: "msg" | "srv" | "action"
): Promise<boolean> {
    if (!packages?.resolvePackageDir) {
        return false;
    }
    const dir = await packages.resolvePackageDir(pkg);
    if (!dir) {
        return false;
    }
    return fs.existsSync(path.join(dir.fsPath, kind, `${name}.${kind}`));
}

/** 分析单个文档,返回诊断列表(全部基于结构模型;RE-1 起异步);导出供单元测试 */
export async function analyzeDocument(
    document: vscode.TextDocument,
    index: MessageIndex,
    packages?: PackageMap
): Promise<vscode.Diagnostic[]> {
    const diagnostics: vscode.Diagnostic[] = [];
    // 0. 接口名合规(文件级):基名不合规包必编译失败(rosidl_adapter 在 CMake configure 期即抛),
    //    打开/编辑瞬间就报 Error,不必等构建
    const nameViolation = interfaceNameViolation(document.fileName);
    if (nameViolation) {
        diagnostics.push(nameViolation);
    }
    const doc = parseRosMessageDocument(document);

    // 1. 结构错误:分隔线数量、数组语法、非法行、常量缺值、疑似 --- 等,
    //    全部由解析器统一产出为 invalidLines,这里只做转换
    //    波浪线收窄:不覆盖行内注释(# 之后),也不含行尾空白
    for (const inv of doc.invalidLines) {
        let endCol = inv.text.length;
        const hashIdx = inv.text.indexOf("#");
        if (hashIdx >= 0) {
            endCol = hashIdx;
        }
        while (endCol > 0 && /\s/.test(inv.text[endCol - 1])) {
            endCol--;
        }
        const range = new vscode.Range(inv.line, 0, inv.line, endCol);
        diagnostics.push(new vscode.Diagnostic(
            range,
            inv.reason,
            inv.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
        ));
    }

    // 2. 字段名重复:段内查重(srv/action 各段是独立命名空间)
    for (const section of doc.sections) {
        const seen = new Map<string, number>();
        for (const field of section.fields) {
            const firstLine = seen.get(field.name);
            if (firstLine !== undefined) {
                const lineLen = document.lineAt(field.line).text.length;
                const range = new vscode.Range(field.line, 0, field.line, lineLen);
                diagnostics.push(new vscode.Diagnostic(
                    range,
                    `字段名 "${field.name}" 重复(首次出现于第 ${firstLine + 1} 行)`,
                    vscode.DiagnosticSeverity.Error
                ));
            } else {
                seen.set(field.name, field.line);
            }
        }
    }

    // 3. 废弃类型/自包含/未知消息类型:byte/char 已废弃;类型等于当前消息名或 当前包/当前消息=自包含(递归);其余未知 → warning
    const selfName = path.basename(document.fileName, path.extname(document.fileName));
    // 当前包名(2026-09-03 R11):优先取索引真实包名(index.getPackageForFile = package.xml <name>,监听维护),
    // 消除"诊断自推口径(两级目录取名) vs 索引真名口径"分裂导致的散乱/非标准布局误报;非法位置(loose)退回父目录近似。
    const selfPkg = index.getPackageForFile(document.fileName)
        ?? (path.basename(path.dirname(path.dirname(document.fileName))) || path.basename(path.dirname(document.fileName)));
    const fullSelf = `${selfPkg}/${selfName}`;
    const allFields = doc.sections.flatMap(s => s.fields);
    // RE-1:当前文档接口种类(FS 点查第③级用;非三类接口文件 → 无③级)
    const kind = interfaceKindOf(document.fileName);
    // 2026-09-03 R12:包内消息名一次性缓存(同包多字段只查一次索引),避免逐字段重复查询
    const namesByPkg = new Map<string, Set<string>>();
    const namesOf = (pkg: string): Set<string> => {
        let names = namesByPkg.get(pkg);
        if (!names) {
            names = new Set(index.getMessagesInPackage(pkg).map(e => e.name));
            namesByPkg.set(pkg, names);
        }
        return names;
    };
    for (const field of allFields) {
        if (field.type.base === "byte" || field.type.base === "char") {
            const range = new vscode.Range(
                field.line,
                field.typeColumn,
                field.line,
                field.typeColumn + field.type.raw.length
            );
            diagnostics.push(new vscode.Diagnostic(
                range,
                `废弃类型 "${field.type.base}",建议使用 ${field.type.base === "byte" ? "uint8" : "int8"}`,
                vscode.DiagnosticSeverity.Warning
            ));
        }
        // 自包含:类型等于当前消息名(无包名)或 当前包/当前消息(带包名)→ 递归依赖
        if (field.type.base === selfName || field.type.base === fullSelf) {
            const range = new vscode.Range(
                field.line,
                field.typeColumn,
                field.line,
                field.typeColumn + field.type.raw.length
            );
            diagnostics.push(new vscode.Diagnostic(
                range,
                `自包含:类型 "${field.type.base}" 引用自身消息,会造成递归依赖`,
                vscode.DiagnosticSeverity.Error
            ));
        }
        if (isBuiltinType(field.type.base)) {
            continue;
        }
        const slash = field.type.base.indexOf("/");
        let known = false;
        // RE-1 三级判定(与 hover/跳转同源口径):①索引点查 → ②系统懒登记 → ③标准布局 FS 点查;
        // ②③仅在索引未命中时触发(点查先行的缓存语义不变);③扩展名按当前文档种类,
        // findMessageWithSystemPath 探测式调用(测试 stub 可能未实现)
        if (slash > 0) {
            const pkg = field.type.base.slice(0, slash);
            const name = field.type.base.slice(slash + 1);
            known = namesOf(pkg).has(name);
            if (!known) {
                const viaSystem = typeof index.findMessageWithSystemPath === "function"
                    ? await index.findMessageWithSystemPath(pkg, name).catch(() => undefined)
                    : undefined;
                known = viaSystem !== undefined
                    || (kind !== undefined && await standardLayoutHas(packages, pkg, name, kind));
            }
        } else {
            // 无包名:按 ROS 语义视为同包引用,只查当前包(selfPkg);不查系统(系统消息必须带包名)
            known = namesOf(selfPkg).has(field.type.base)
                || (kind !== undefined && await standardLayoutHas(packages, selfPkg, field.type.base, kind));
        }
        if (!known) {
            const range = new vscode.Range(
                field.line,
                field.typeColumn,
                field.line,
                field.typeColumn + field.type.raw.length
            );
            diagnostics.push(new vscode.Diagnostic(
                range,
                `未知消息类型 "${field.type.base}"`,
                vscode.DiagnosticSeverity.Warning
            ));
        }
    }

    return diagnostics;
}

/**
 * 注册 rosmsg 诊断:监听文档打开/变化/新建,防抖分析并写入诊断集合
 *
 * 日志走统一接口 getLogger("msg-diagnostics"),级别与扩展习惯一致:
 *  - trace:编辑事件、执行分析等详细流程
 *  - debug:被过滤跳过的场景(RE-1 聚合:同 scheme 首次照常 debug,同会话内后续降为 trace——
 *    设计可见性保留,Chat 快照等批量虚拟文档不再刷屏)
 *  - info:注册等关键事件
 *  - warn:分析异常
 * 过滤为两层正选:languageId=rosmsg 且 scheme=file 才处理;
 * 其余语言(cpp/json/log 等)与虚拟文档(chat-editing-text-model/output 等)一律忽略。
 *
 * 返回 reanalyzeAll(RE-1 接电):索引就绪/刷新后对打开的 rosmsg 文档重跑分析,
 * 清除"打开瞬间索引未就绪"产生的过期"未知消息类型"警告(调用方挂防抖)。
 */
export function registerRosMessageDiagnostics(
    context: vscode.ExtensionContext,
    index: MessageIndex,
    packages?: PackageMap,
    /** P2 start 化:索引是否已启动(未启动时分析/初始全算一律跳过——门关零后台) */
    isStarted?: () => boolean
): { disposables: vscode.Disposable[]; reanalyzeAll(): void } {
    void context;
    const collection = vscode.languages.createDiagnosticCollection("rosmsg");
    // 简单防抖 500ms:两层正选已过滤无关文档,剩余只有真实 rosmsg 文件的编辑,单 timer 足够
    let timer: NodeJS.Timeout | undefined;
    const DEBOUNCE_MS = 500;
    // RE-1 聚合:同 scheme 只在首条 debug,后续同类降 trace(设计日志保留,重复噪音消失)
    const skippedSchemes = new Set<string>();

    const analyzeOne = async (document: vscode.TextDocument): Promise<void> => {
        if (isStarted && !isStarted()) {
            return; // P2:索引未启动(门关)不做任何分析
        }
        if (document.languageId !== "rosmsg") {
            return;
        }
        if (document.uri.scheme !== "file") {
            if (!skippedSchemes.has(document.uri.scheme)) {
                skippedSchemes.add(document.uri.scheme);
                log.debug(vscode.l10n.t("Analysis skipped (not a real file): {0} (further skips of this kind downgrade to trace)", document.uri.scheme));
            } else {
                log.trace(vscode.l10n.t("Analysis skipped (not a real file): {0}", document.uri.scheme));
            }
            return;
        }
        log.trace(vscode.l10n.t("Running analysis: {0}", document.uri.toString()));
        try {
            const result = await analyzeDocument(document, index, packages);
            log.trace(vscode.l10n.t("{0} analysis results", result.length));
            collection.set(document.uri, result.length > 0 ? result : undefined);
        } catch (err) {
            log.warn(vscode.l10n.t("Diagnostic analysis failed: {0}", (err as Error).message));
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
        if (event.document.languageId !== "rosmsg") {
            return;
        }
        if (event.document.uri.scheme !== "file") {
            return;
        }
        log.trace(vscode.l10n.t("Edit event fired: {0} changes={1}", event.document.uri.toString(), event.contentChanges.length));
        // 简单防抖 500ms,避免每个按键都全量分析
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => analyze(event.document), DEBOUNCE_MS);
    });
    const openListener = vscode.workspace.onDidOpenTextDocument(analyze);
    const closeListener = vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri));
    // 新建路径兜底:Explorer 新建通常随后自动打开(走 analyzeOne),这里兜"创建了但没打开"的文件——
    // 名字判定只需要文件名,无需打开文档;目录名误配用 statSync isFile 挡掉
    const createListener = vscode.workspace.onDidCreateFiles(event => {
        if (isStarted && !isStarted()) {
            return; // P2:门关零后台,与 analyzeOne 同门
        }
        for (const uri of event.files) {
            if (uri.scheme !== "file") {
                continue;
            }
            let isFile = true;
            try {
                isFile = fs.statSync(uri.fsPath).isFile();
            } catch {
                // 探测不到(如瞬时被删)按文件放行,后续打开路径会复判
            }
            if (!isFile) {
                continue;
            }
            const violation = interfaceNameViolation(uri.fsPath);
            if (violation) {
                collection.set(uri, [violation]);
            }
        }
    });

    // 初始分析当前已打开文档(P2:仅索引已启动时;未启动由启动链的 reanalyzeAll 兜底)
    if (!isStarted || isStarted()) {
        reanalyzeAll();
    }

    log.info("ROS message diagnostics registered (missing --- / duplicate fields / unknown types / deprecated types / invalid interface names; three-level unknown-type verdict + ready recompute)");
    return {
        disposables: [
            collection,
            changeListener,
            openListener,
            closeListener,
            createListener,
            { dispose: () => { if (timer) { clearTimeout(timer); } } }
        ],
        reanalyzeAll
    };
}
