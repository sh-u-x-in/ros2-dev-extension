// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file rename-actions.ts
 * config 写侧·02 工作包重命名【纯动作层】(2026-09-03,设计:设计/新功能/02)。
 * 以文件夹名称为准:把 package.xml <name> / CMakeLists project() / setup.py name=
 * **结构定位**改写为文件夹名(不依赖"旧名"参数——兼容「仅 project() 与目录不一致」等部分不一致场景);
 * 值已一致的文件自动跳过(改写结果与原文相同)。目录重命名/跨包引用/代码字符串替换 v1 不做。
 * 零 vscode 依赖,可无头单测;触发/交互/写回在 package-rename.ts(订阅 executable-map.onNameMismatch)。
 * ⚠️ 定位说明(2026-09-03):<name>/project() 的定位可用 anchors/(nameTagSpan、findCommandParens)替换
 *    当前正则;rename 为整文 replace 无括号配对风险,接入 anchors 属一致性收尾(规格 §4 之后)。
 */

export interface RenameTargets {
    packageXml: string;
    cmakeText: string;
    setupPyText: string;
}

export interface RenamePlanFile {
    file: "package.xml" | "CMakeLists.txt" | "setup.py";
    /** 改写后整文(无变化则 undefined) */
    content?: string;
    summary: string;
}

export interface RenamePlan {
    changed: boolean;
    files: RenamePlanFile[];
    note?: string;
}

/** ROS 包名合法性(以文件夹名为准的目标名) */
export function validatePackageName(name: string): string | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return "包名只能含字母/数字/下划线且不能以数字开头:" + name;
    }
    if (/[A-Z]/.test(name)) {
        return "建议使用小写(ROS 包名惯例),当前含大写:" + name;
    }
    return undefined;
}

/** package.xml 首个 <name>…</name> 文本改为 new(结构定位) */
function rewritePackageXmlTo(text: string, newName: string): string | undefined {
    const re = /<name>\s*([^<\n]+?)\s*<\/name>/;
    const m = re.exec(text);
    if (!m) { return undefined; }
    if (m[1].trim() === newName) { return undefined; } // 已一致
    return text.replace(re, "<name>" + newName + "</name>");
}

/** CMakeLists 首个 project( 后第一个词改为 new(保留其余参数) */
function rewriteProjectTo(text: string, newName: string): string | undefined {
    const re = /\bproject\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/;
    const m = re.exec(text);
    if (!m) { return undefined; }
    if (m[1] === newName) { return undefined; }
    return text.replace(re, "project(" + newName);
}

/** setup.py 首个 name= 字符串值改为 new(结构定位,保留引号风格为单引号) */
function rewriteSetupNameTo(text: string, newName: string): string | undefined {
    const re = /\bname\s*=\s*(['"])[^'"\n]*\1/;
    const m = re.exec(text);
    if (!m) { return undefined; }
    const quote = m[1];
    const value = m[0].slice(m[0].indexOf(quote) + 1, m[0].lastIndexOf(quote));
    if (value === newName) { return undefined; } // 已一致
    return text.replace(re, "name='" + newName + "'");
}

/**
 * 以文件夹名为准的结构化改写计划(逐文件独立:能定位且值不同才改写)。
 */
export function planRenameByFolder(dirName: string, targets: RenameTargets): RenamePlan {
    const invalid = validatePackageName(dirName);
    if (invalid) { return { changed: false, files: [], note: invalid }; }
    const files: RenamePlanFile[] = [];
    const px = targets.packageXml ? rewritePackageXmlTo(targets.packageXml, dirName) : undefined;
    if (px !== undefined) { files.push({ file: "package.xml", content: px, summary: "package.xml <name> → " + dirName }); }
    const cm = targets.cmakeText ? rewriteProjectTo(targets.cmakeText, dirName) : undefined;
    if (cm !== undefined) { files.push({ file: "CMakeLists.txt", content: cm, summary: "CMakeLists project() → " + dirName }); }
    const sp = targets.setupPyText ? rewriteSetupNameTo(targets.setupPyText, dirName) : undefined;
    if (sp !== undefined) { files.push({ file: "setup.py", content: sp, summary: "setup.py name → " + dirName }); }
    if (files.length === 0) {
        return { changed: false, files: [], note: "构建文件中无可定位的声明名可改写(代码内引用请手动,程序不全局替换)" };
    }
    return { changed: true, files };
}
