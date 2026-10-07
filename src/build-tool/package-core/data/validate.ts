// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 本文件已废弃(DEPRECATED,2026-08-29)——不再参与编译,内容注释保留,仅作历史参考。
// 2026-09-03 复核(项目结尾):维持墓碑注释保留,不删除。
// 去向:原"权威校验"职能由 package-core/scan/package-xml(收编后)与 package-cache 内建校验承担;
//   本文件 validatePackageEntries / isValidPackage 零引用(2026-08-29 复核确认)。
// 参考:设计/重构/package与package-core语义收编-2026-08-28/DESIGN.md §9(复核补充)。
// ═══════════════════════════════════════════════════════════════════════════
// ───────────────────────────────────────────────────────────────────────────
// 以下为原文件全部内容(整体注释,仅供历史参考,不参与编译)。
// ───────────────────────────────────────────────────────────────────────────
// // Copyright (c) Microsoft Corporation. All rights reserved.
// // Licensed under the MIT License.
// 
// /**
//  * @file validate.ts
//  * 数据层：权威校验（合法验证）。
//  *
//  * 驱动层只做"廉价预过滤"（该不该反应）；这里是"取来后是否合法"的权威判定：
//  * isValidPackageXml / build_type 校验 / 目录名 vs <name> 一致性等。
//  * 已接线：复用 src/build-tool/packages/package-xml(isValidPackageXml / getPackageNameFromXml)。
//  * 工作区快照(package-cache)内的包已由缓存校验，此处供"原始 package.xml 路径 → 合法包"场景使用。
//  */
// 
// import { PackageEntry } from "../shared/types";
// import { isValidPackageXml, getPackageNameFromXml } from "../../packages/package-xml";
// 
// /** 校验结果（逐条通过/拒绝 + 原因） */
// export interface ValidationResult {
//     valid: PackageEntry[];
//     rejected: { entry: PackageEntry; reason: string }[];
// }
// 
// /** 权威校验：输入候选包条目，返回合法/非法两组 */
// export async function validatePackageEntries(
//     candidates: PackageEntry[]
// ): Promise<ValidationResult> {
//     const valid: PackageEntry[] = [];
//     const rejected: ValidationResult["rejected"] = [];
//     for (const entry of candidates) {
//         if (await isValidPackage(entry)) {
//             valid.push(entry);
//         } else {
//             rejected.push({ entry, reason: "invalid package" });
//         }
//     }
//     return { valid, rejected };
// }
// 
// /** 单包合法性判定：isValidPackageXml(well-formed + 构建文件) + <name> 与条目名一致 */
// async function isValidPackage(entry: PackageEntry): Promise<boolean> {
//     try {
//         if (!(await isValidPackageXml(entry.dir))) {
//             return false;
//         }
//         const name = await getPackageNameFromXml(entry.dir);
//         return name === entry.name;
//     } catch {
//         return false;
//     }
// }
