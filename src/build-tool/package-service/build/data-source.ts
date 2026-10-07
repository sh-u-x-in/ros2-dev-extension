// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file data-source.ts
 * build 域对包数据源的窄接口(2026-08-31 #4 方案 B 实施)。
 * 类型自 package-core/api 纯 type import(零运行时耦合,依赖方向:build → package-core,合法);
 * 实例由组合根(extension)创建并注入(参数传递,不 import extension 全局——消除循环依赖)。
 * 只声明 build 域真正需要的 3 个方法,不依赖 PackageFacadeApi 全量(接口隔离)。
 */

import type { PackageEntry, PackageDataState } from "../../package-core/api";

/** build 域对包数据源的唯一需求(实现 = extension 创建的 packageCore 实例) */
export interface BuildDataSource {
    /** 构建包列表(缓存优先,未命中 colcon list)——智能构建包多选用 */
    getBuildPackages(): Promise<ReadonlyArray<PackageEntry>>;
    /** 当前包状态快照(含 ignored 列表,右键单包 findPackageForPath 用) */
    getState(): Readonly<PackageDataState>;
    /** 翻转 COLCON_IGNORE(返回翻转后是否被忽略)——右键忽略切换用 */
    toggleIgnore(dir: string): Promise<boolean>;
}
