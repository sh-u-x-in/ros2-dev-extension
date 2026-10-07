// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file package-folder.ts
 * 包文件夹名冲突校验(纯逻辑, 可单测;唯一 vscode 依赖 = l10n 文案, 与 naming/names.ts 同例,
 * 无头单测经 _vscode-stub 装载)。
 *
 * 规则:目标目录下若已存在同名文件夹,则新建同名包为非法操作(名称冲突)。
 * exists 由调用方注入(如 fs.existsSync),便于测试。
 */

import { l10n } from "vscode";

import { getLogger } from "../../../../logger";

/** 扩展日志薄封装(带 package-folder 模块前缀) */
const log = getLogger("package-folder");

/**
 * 校验包文件夹名是否冲突:目标目录下已存在同名文件夹则返回错误信息,否则返回 null。
 *
 * @param pkg 包名(同时作为目标子文件夹名)
 * @param exists 注入的存在性检查(接收包名对应的文件夹路径)
 */
export function validatePackageFolder(
    pkg: string,
    exists: (folderPath: string) => boolean,
): string | null {
    const conflict = exists(pkg) ? l10n.t('Folder "{0}" already exists (name conflict)', pkg) : null;
    log.trace(`校验包文件夹名 ${pkg}:${conflict ? "冲突" : "无冲突"}`);
    return conflict;
}
