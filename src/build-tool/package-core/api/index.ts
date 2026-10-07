// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file index.ts
 * api/ 目录聚合出口(2026-08-30 按 ros2/ 范式定稿):
 *  1) 类型:api/api.ts 的接口与类型(PackageFacadeApi / PackageDataState 等);
 *  2) 运行时出口:re-export 组合根(index.ts)的工厂与静态能力(≈ros2/api re-export composeApi)。
 * 外部依赖一律 import 本文件(绝对意义,无第三方引用 api/ 以外内容);
 * 组合根 index.ts 只被装配方(extension)直接调用。
 * 本目录零 function/class 定义(仅类型定义与 re-export)。
 */

export * from "./api";
export { createPackageCore, getPackageCore } from "../compose";
export { probeValidWorkspacePackages } from "../compose";
export { isValidPackageXml, getPackageNameFromXml } from "../compose";
export type { PackageCore, PackageCoreOptions, PackageCoreConfig } from "../compose";
// 数据类型在 api/api.ts(类型层),经本聚合转发(运行时出口只转发函数与组装类型)
// 2026-09-02(设计 D3):PackageSnapshot / WorkspacePackage / PackageScanEntry 等物理层类型不再对外——
// 对外状态类型只有 PackageDataState / PackageEntry / PackageChangeEvent
// shared 值类型谓词(对外不可见,经 api 运行时出口转发;来源权威=PackageDataState 分域,isPythonPackage 仅判工作区包类型,2026-09-02)
export { isPythonPackage, PYTHON_BUILD_TYPE } from "../shared/types";