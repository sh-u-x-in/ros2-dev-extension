/**
 * launch-definition-provider — launch 解析跳转(LA-3,2026-09-25;LD-3 起三格式统一)
 *
 * XML(.launch / .launch.xml):
 *  - <node pkg="…"> → 包目录(优先 package.xml);
 *  - <node exec="…"> → install-truth 可执行源文件(sourcesOf 首选源;系统包/未构建不跳,与终裁一致);
 *  - <include file="…"> → 目标 launch 文件(复用 resolveLaunchIncludePath,与链接同口径)。
 * Python(.launch.py):
 *  - Node 系调用 package='…'/executable='…' 值内 → 包目录 / 可执行源(pyNodeCallAt 定位);
 *  - include 表达式内 → 目标文件(scanLaunchIncludes,与 py 链接同口径)。
 * YAML(.launch.yaml / .launch.yml;LD-3 补齐,此前仅 DocumentLink):
 *  - pkg:/exec:/file: 三值位 → 包目录 / 可执行源 / 目标文件(与 XML 同一套落点函数)。
 *
 * 文件级语义(LD-3 成文):launch 全部跳转落点 = 文件 + line 0,不掺 xacro 式符号解算;
 * 下划线(DocumentLink)与 F12(本 provider)是同一解析链路的两个入口。
 *
 * LA-1 域门控:文档不在 VS Code 工作区根内 → undefined(解析域理念)。
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getLogger } from "../../../logger";
import type { PackageMap } from "../../shared/package-map";
import { fileInWorkspaceDomain } from "../../shared/workspace-domain";
import { decodeXmlEntities } from "../../shared/xml-utils";
import * as core from "../core/launch-completion-core";
import { pyNodeCallAt, scanLaunchIncludes } from "../parse/launch-py-parser";
import { resolveLaunchIncludePath } from "./launch-link-provider";
import type { LaunchExecSource } from "./launch-completion";

const log = getLogger("launch-definition");

/**
 * LG-2(2026-10-01 用户裁定):yaml 定义注册开关读取口——`ROS2.launch.yamlDefinitionEnabled`
 * (默认 true,**重启生效**;仅影响 yaml)。关闭时 providers.ts 跳过 yaml DefinitionProvider 注册,
 * 从源头规避字符串引号下方的定义指示线;py/xml 定义不受影响。
 * 旧 `yamlNodeMatch`(响应范围双模式,即时生效)已由本注册开关取代。
 */
export function readYamlDefinitionEnabled(): boolean {
    return vscode.workspace.getConfiguration("ROS2.launch").get<boolean>("yamlDefinitionEnabled", true);
}

/**
 * 包跳转落点(LE-1 提升为共享解析:Definition/Hover/DocumentLink 三入口同源):
 * 工作区/系统包目录,package.xml 存在时优先。
 */
export async function resolvePackageTargetUri(
    packages: PackageMap | undefined,
    pkg: string
): Promise<vscode.Uri | undefined> {
    if (!packages || !/^[A-Za-z0-9_-]+$/.test(pkg)) {
        return undefined;
    }
    const dir = await packages.resolvePackageDir(pkg);
    if (!dir) {
        return undefined;
    }
    const pkgXml = path.join(dir.fsPath, "package.xml");
    return fs.existsSync(pkgXml) ? vscode.Uri.file(pkgXml) : dir;
}

/** 可执行跳转落点(LE-1 共享):工作区 = install-truth 源码;系统包/未构建 = CLI 安装路径(LJ-5 用户新裁定);非法名 → undefined */
export async function resolveExecTargetUri(
    exec: LaunchExecSource,
    pkg: string,
    name: string
): Promise<vscode.Uri | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(pkg) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        return undefined;
    }
    const src = await exec.sourceOf(pkg, name);
    return src !== undefined && fs.existsSync(src) ? vscode.Uri.file(src) : undefined;
}

export class LaunchDefinitionProvider implements vscode.DefinitionProvider {
    constructor(
        private packages: PackageMap | undefined,
        private exec: LaunchExecSource
    ) { }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        if (!fileInWorkspaceDomain(document.uri)) {
            return undefined; // LA-1:域外文档不解析
        }
        const text = document.getText();
        const offset = document.offsetAt(position);
        if (document.fileName.endsWith(".launch.py")) {
            return this.pyDefinition(document, text, offset);
        }
        if (/\.launch\.ya?ml$/i.test(document.fileName)) {
            return this.yamlDefinition(document, text, offset, token);
        }
        return this.xmlDefinition(document, text, offset, token);
    }

    // ---------------- XML ----------------

    private async xmlDefinition(
        document: vscode.TextDocument,
        text: string,
        offset: number,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        const cursor = core.xmlCursorAt(text, offset);
        if (!cursor || cursor.kind !== "attrValue") {
            return undefined;
        }
        // 完整属性值(xmlCursorAt.value 只是光标前缀;跳转要整个值)
        const lastLt = text.lastIndexOf("<", offset - 1);
        const tagEnd = text.indexOf(">", lastLt);
        const tagText = text.slice(lastLt, tagEnd < 0 ? undefined : tagEnd + 1);
        const fullValue = decodeXmlEntities(new RegExp(`\\b${cursor.attr}\\s*=\\s*["']([^"']*)["']`).exec(tagText)?.[1] ?? cursor.value);
        if (cursor.tag === "node" && cursor.attr === "pkg") {
            const loc = await this.packageLocation(fullValue);
            if (loc) {
                log.trace(vscode.l10n.t("launch pkg definition: {0} -> {1}", fullValue, loc.uri.fsPath));
            }
            return loc;
        }
        if (cursor.tag === "node" && cursor.attr === "exec") {
            const pkg = core.xmlTagAttrBefore(text, offset, "pkg");
            if (!pkg) {
                return undefined;
            }
            const loc = await this.executableLocation(pkg, fullValue);
            if (loc) {
                log.trace(vscode.l10n.t("launch exec definition: {0}/{1} -> {2}", pkg, fullValue, loc.uri.fsPath));
            } else {
                log.debug(vscode.l10n.t("launch exec miss: {0}/{1} (not built, or a system package)", pkg, fullValue));
            }
            return loc;
        }
        if (cursor.tag === "include" && cursor.attr === "file") {
            const target = await resolveLaunchIncludePath(fullValue, document.uri, this.packages, token);
            if (target) {
                return new vscode.Location(target, new vscode.Position(0, 0));
            }
        }
        return undefined;
    }

    // ---------------- Python ----------------

    private async pyDefinition(
        document: vscode.TextDocument,
        text: string,
        offset: number
    ): Promise<vscode.Definition | undefined> {
        // ① Node 系调用:package / executable 值内
        const call = pyNodeCallAt(text, offset);
        if (call) {
            if (call.packageRange && offset >= call.packageRange[0] && offset <= call.packageRange[1] && call.package) {
                const loc = await this.packageLocation(call.package);
                if (loc) {
                    log.trace(vscode.l10n.t("launch py package definition: {0} -> {1}", call.package, loc.uri.fsPath));
                }
                return loc;
            }
            if (call.executableRange && offset >= call.executableRange[0] && offset <= call.executableRange[1] && call.executable) {
                if (!call.package) {
                    return undefined; // package 非字面量(变量/LaunchConfiguration)→ 静态不可解析
                }
                const loc = await this.executableLocation(call.package, call.executable);
                if (loc) {
                    log.trace(vscode.l10n.t("launch py executable definition: {0}/{1} -> {2}", call.package, call.executable, loc.uri.fsPath));
                } else {
                    log.debug(vscode.l10n.t("launch py executable miss: {0}/{1}", call.package, call.executable));
                }
                return loc;
            }
            return undefined;
        }
        // ② include 表达式:与 py 链接同口径(scanLaunchIncludes 静默过滤未解析项;内部自掩码)
        if (this.packages) {
            const includes = scanLaunchIncludes(text, document.uri, this.packages);
            for (const inc of includes) {
                if (inc.target && offset >= inc.start && offset <= inc.end) {
                    log.trace(vscode.l10n.t("launch py include definition: {0} -> {1}", inc.expr, inc.target.fsPath));
                    return new vscode.Location(inc.target, new vscode.Position(0, 0));
                }
            }
        }
        return undefined;
    }

    // ---------------- YAML(LD-3:pkg:/exec:/file: 三值位) ----------------

    private async yamlDefinition(
        document: vscode.TextDocument,
        text: string,
        offset: number,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        // 值位判定复用补全同一光标上下文(yamlCursorAt);整值从行文本提取(光标前缀不足)
        const cursor = core.yamlCursorAt(text, offset);
        if (!cursor || cursor.kind !== "value") {
            return undefined;
        }
        const lineStart = offset > 0 ? text.lastIndexOf("\n", offset - 1) + 1 : 0;
        let lineEnd = text.indexOf("\n", lineStart);
        if (lineEnd < 0) {
            lineEnd = text.length;
        }
        const line = text.slice(lineStart, lineEnd);
        // LG-1 正确语义:值提取改 parseYamlScalarValue 扫描器(引号单/双+转义+裸三路完备),
        // 值原样——引号内前导/后导空格真正参与(`" p10…"` 解析失败无响应 = 正确对齐)
        const keyMatch = /^\s*([A-Za-z_][\w-]*)\s*:/.exec(line);
        if (!keyMatch) {
            return undefined;
        }
        const key = keyMatch[1];
        const colon = line.indexOf(":");
        const span = core.parseYamlScalarValue(line, colon + 1);
        if (!span || !span.value.trim()) {
            return undefined;
        }
        const value = span.value;
        // LF-1 口径(2026-10-01 用户裁定):响应范围 = 整个字符串节点(含引号,引号位 F12 可用);
        // 注册级开关见 readYamlDefinitionEnabled(关闭时本 provider 整体不注册)。
        if (offset < lineStart + span.nodeStart || offset >= lineStart + span.nodeEnd) {
            return undefined;
        }
        if (key === "pkg") {
            const loc = await this.packageLocation(value);
            if (loc) {
                log.trace(vscode.l10n.t("launch yaml pkg definition: {0} -> {1}", value, loc.uri.fsPath));
            }
            return loc;
        }
        if (key === "exec") {
            const pkg = core.yamlSiblingKeyValue(text, lineStart, "pkg");
            if (!pkg) {
                return undefined; // pkg 非字面量/缺失 → 静态不可解析
            }
            const loc = await this.executableLocation(pkg, value);
            if (loc) {
                log.trace(vscode.l10n.t("launch yaml exec definition: {0}/{1} -> {2}", pkg, value, loc.uri.fsPath));
            }
            return loc;
        }
        if (key === "file") {
            const target = await resolveLaunchIncludePath(value, document.uri, this.packages, token);
            if (target) {
                log.trace(vscode.l10n.t("launch yaml file definition: {0} -> {1}", value, target.fsPath));
                return new vscode.Location(target, new vscode.Position(0, 0));
            }
        }
        return undefined;
    }

    // ---------------- 落点 ----------------

    /** 包目录跳转落点:优先 package.xml(存在时),否则目录(LE-1:共享解析薄包装) */
    private async packageLocation(pkg: string): Promise<vscode.Location | undefined> {
        const uri = await resolvePackageTargetUri(this.packages, pkg);
        return uri ? new vscode.Location(uri, new vscode.Position(0, 0)) : undefined;
    }

    /** 可执行跳转落点:install-truth 源解析首选;系统包/未构建 → undefined(LE-1:共享解析薄包装) */
    private async executableLocation(pkg: string, name: string): Promise<vscode.Location | undefined> {
        const uri = await resolveExecTargetUri(this.exec, pkg, name);
        return uri ? new vscode.Location(uri, new vscode.Position(0, 0)) : undefined;
    }
}
