// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-xml.ts
 * package.xml 解析与合法性校验(从 colcon-utils.ts 切分,2026-08-21)。
 * 纯逻辑、零 vscode 运行时依赖;后续 package.xml 校验口径拟统一(共享层)时,以此为单一入口。
 */

import { l10n } from "vscode";


import * as path from "path";
import * as fs from "fs";
import { parseXml, forEachElement } from "../../../languages/shared/xml-utils";
import type { SyntaxNode } from "@lezer/common";
import { getLogger } from "../../../logger";

/** 模块日志(纯逻辑模块,logger 注入式,无头可用) */
const log = getLogger("package-xml");

/** 同目录存在指定名称任一文件 */
async function hasFileAny(dir: string, names: readonly string[]): Promise<boolean> {
    for (const f of names) {
        try {
            await fs.promises.access(path.join(dir, f));
            return true;
        } catch {
            // 继续
        }
    }
    return false;
}

/**
 * build_type 与构建文件**同类型校验**(2026-08-22 全量收紧,用户定规则):
 *  - ament_python → 需 setup.py 或 pyproject.toml;
 *  - ament_cmake / cmake(等价) → 需 CMakeLists.txt;
 *  - 未声明或其它 build_type → **不合法**。
 * 返回 { ok, reason }:ok=false 时 reason 说明原因(供调用方记录日志;本模块为叶子、无 logger)。
 * (2026-08-30 内联归位:包语义校验留 package-core;通用排除工具已归 walk/path-exclude)
 */
async function matchesBuildTypeFile(
    dir: string,
    buildType?: string,
): Promise<{ ok: boolean; reason?: string }> {
    switch (buildType) {
        case "ament_python":
            return (await hasFileAny(dir, ["setup.py", "pyproject.toml"]))
                ? { ok: true }
                : { ok: false, reason: l10n.t("ament_python is missing setup.py/pyproject.toml") };
        case "ament_cmake":
        case "cmake":
            return (await hasFileAny(dir, ["CMakeLists.txt"]))
                ? { ok: true }
                : { ok: false, reason: l10n.t("{0} is missing CMakeLists.txt", buildType) };
        default:
            return {
                ok: false,
                reason: buildType ? l10n.t("Unknown build_type={0}", buildType) : l10n.t("build_type not declared"),
            };
    }
}

/** lezer 严格 well-formed 校验结果 + 根/name/buildType 提取 */
type PkgAnalysis = { wellFormed: boolean; rootTag: string | null; name: string | null; buildType: string | null };

/**
 * lezer 严格 well-formed 校验 + 根/name 提取(等价 XMLValidator.validate + XMLParser 根/name 语义)。
 * 自建 4 条规则(见 转换/00 §6.2):R1 无 isError、R2 无 MissingCloseTag、R3 恰 1 根+根外仅声明/注释/空白、R4 开闭 TagName 一致。
 */
function analyzePackageXml(content: string): PkgAnalysis {
    const tree = parseXml(content);
    const top = tree.topNode;

    // 全树遍历(含非 Element 节点),命中即终止
    const hasNode = (pred: (n: SyntaxNode) => boolean): boolean => {
        let found = false;
        const walk = (n: SyntaxNode): void => {
            if (found) {
                return;
            }
            if (pred(n)) {
                found = true;
                return;
            }
            for (let c = n.firstChild; c && !found; c = c.nextSibling) {
                walk(c);
            }
        };
        walk(top);
        return found;
    };

    // R1:无错误节点(破损注释/属性引号未闭合/裸 &/文本 <)
    if (hasNode(n => n.type.isError)) {
        return { wellFormed: false, rootTag: null, name: null, buildType: null };
    }
    // R2:无 MissingCloseTag(未闭合标签)
    if (hasNode(n => n.name === "MissingCloseTag")) {
        return { wellFormed: false, rootTag: null, name: null, buildType: null };
    }
    // R3:恰好 1 个根 Element,根外仅声明/注释/空白
    const roots: SyntaxNode[] = [];
    for (let c = top.firstChild; c; c = c.nextSibling) {
        if (c.name === "Element") {
            roots.push(c);
        } else if (c.name === "Text" && !/^\s*$/.test(content.slice(c.from, c.to))) {
            return { wellFormed: false, rootTag: null, name: null, buildType: null };
        }
    }
    if (roots.length !== 1) {
        return { wellFormed: false, rootTag: null, name: null, buildType: null };
    }
    // R4:每 Element 的 CloseTag.TagName == OpenTag.TagName(不匹配闭合)
    let mismatch = false;
    forEachElement(top, content, (elem) => {
        if (mismatch) {
            return;
        }
        const open = elem.getChild("OpenTag");
        const close = elem.getChild("CloseTag");
        if (!open || !close) {
            return; // 自闭合或无闭合标签由 R1/R2 覆盖
        }
        const ot = open.getChild("TagName");
        const ct = close.getChild("TagName");
        if (!ot || !ct || content.slice(ot.from, ot.to) !== content.slice(ct.from, ct.to)) {
            mismatch = true;
        }
    });
    if (mismatch) {
        return { wellFormed: false, rootTag: null, name: null, buildType: null };
    }

    // 取根标签 + 首个 name 元素文本(常见实体解码,对齐 fast-xml-parser 默认 processEntities)
    const root = roots[0];
    const rootOpen = root.getChild("OpenTag");
    const rootTag = rootOpen
        ? content.slice(rootOpen.getChild("TagName")!.from, rootOpen.getChild("TagName")!.to)
        : null;
    const decode = (s: string): string =>
        s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
    let name: string | null = null;
    forEachElement(top, content, (elem, info) => {
        if (name !== null) {
            return;
        }
        if (info.tag === "name") {
            let txt = "";
            for (let c = elem.firstChild; c; c = c.nextSibling) {
                if (c.name === "Text" || c.name === "EntityReference") {
                    txt += content.slice(c.from, c.to);
                }
            }
            name = decode(txt).trim(); // 对齐 fast-xml-parser 默认 trimValues
        }
    });
    // build_type:取 <export><build_type> 文本(未声明 → null)
    let buildType: string | null = null;
    forEachElement(top, content, (elem, info) => {
        if (buildType !== null) {
            return;
        }
        if (info.tag === "build_type") {
            let txt = "";
            for (let c = elem.firstChild; c; c = c.nextSibling) {
                if (c.name === "Text" || c.name === "EntityReference") {
                    txt += content.slice(c.from, c.to);
                }
            }
            buildType = decode(txt).trim() || null;
        }
    });
    return { wellFormed: true, rootTag, name, buildType };
}

/** 目录级包分析结果(单一真包判定核心,2026-08-22 收敛 buildEntry/isValidPackageXml 重复判定) */
export interface PackageDirAnalysis {
    /** <name>(读取/解析失败为 undefined) */
    name?: string;
    /** <build_type>(未声明/读取失败为 undefined) */
    buildType?: string;
    /** 是否合法:wellFormed + <package> 根 + 非空 name + build_type 同类型校验 */
    valid: boolean;
    /** 不合法原因(供调用方记录日志) */
    reason?: string;
}

/**
 * 分析单个包目录:读 package.xml → lezer 严格解析(name/buildType) → build_type 同类型校验。
 * 作为**唯一真包判定核心**,isValidPackageXml 与 package-scan.buildEntry 均基于它,消除重复。
 */
export async function analyzePackageDir(packageDir: string): Promise<PackageDirAnalysis> {
    try {
        const content = await fs.promises.readFile(path.join(packageDir, "package.xml"), "utf-8");
        const { wellFormed, rootTag, name, buildType } = analyzePackageXml(content);
        if (!wellFormed || rootTag !== "package" || typeof name !== "string" || name.trim().length === 0) {
            return {
                name: name ?? undefined,
                buildType: buildType ?? undefined,
                valid: false,
                reason: l10n.t("Not well-formed / not a <package> root / missing non-empty <name>"),
            };
        }
        const { ok, reason } = await matchesBuildTypeFile(packageDir, buildType ?? undefined);
        return { name, buildType: buildType ?? undefined, valid: ok, reason: ok ? undefined : reason };
    } catch (e) {
        return { valid: false, reason: l10n.t("Read failed: {0}", e instanceof Error ? e.message : String(e)) };
    }
}

/**
 * 校验 package.xml 是否合法(与 package-scan.isValid 同一收紧口径)。
 * 基于 analyzePackageDir 单一判定核心。
 */
export async function isValidPackageXml(packageDir: string): Promise<boolean> {
    const analysis = await analyzePackageDir(packageDir);
    if (!analysis.valid && analysis.reason) {
        log.warn(l10n.t("Invalid package: {0}: {1}", analysis.reason, packageDir));
    }
    return analysis.valid;
}

/**
 * 从 package.xml 内容解析包名 <name>(lezer 严格口径:wellFormed + 根 <package> + 非空 name)。
 * 动作3 收敛:统一 package-scan.buildEntry 与 getPackageNameFromXml 的 name 口径(替代原裸正则),
 * 损坏 / 非 <package> 根的 package.xml 不再产出 name(提升"真实性")。
 */
export function parsePackageNameFromContent(content: string): string | undefined {
    const { wellFormed, rootTag, name } = analyzePackageXml(content);
    if (!wellFormed || rootTag !== "package" || typeof name !== "string" || name.trim().length === 0) {
        return undefined;
    }
    return name;
}

/**
 * 从 package.xml 内容解析 build_type <export><build_type>(lezer 严格口径:wellFormed + 根 <package>)。
 * 2026-08-22 收紧:供 build_type 与构建文件**同类型校验**(ament_python/ament_cmake)。
 */
export function parsePackageBuildTypeFromContent(content: string): string | undefined {
    const { wellFormed, rootTag, buildType } = analyzePackageXml(content);
    if (!wellFormed || rootTag !== "package" || typeof buildType !== "string" || buildType.trim().length === 0) {
        return undefined;
    }
    return buildType;
}

/**
 * 从 package.xml 读取包名 <name>(统一走 lezer 严格口径 parsePackageNameFromContent)
 */
export async function getPackageNameFromXml(packageDir: string): Promise<string | undefined> {
    try {
        const content = await fs.promises.readFile(path.join(packageDir, "package.xml"), "utf-8");
        return parsePackageNameFromContent(content);
    } catch (e) {
        log.trace(`getPackageNameFromXml:读取 package.xml 失败:${packageDir}(${e instanceof Error ? e.message : String(e)})`);
        return undefined;
    }
}