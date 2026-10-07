// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file api.ts
 * 类型层(2026-08-30 按 ros2/ 范式定稿):package-core/api/ = 纯接口/类型,零函数零类零实现 re-export。
 *  - PackageFacadeApi:实例门面接口(实现 = compose.ts 内嵌 PackageFacade;facade.ts 已于 2026-08-30 合并入 compose.ts);
 *  - 对外类型:PackageDataState / PackageChangeEvent / PackageEntry(2026-09-02 起 PackageScanEntry /
 *    PackageSnapshot 等物理层类型不再对外——设计 D3,消费方只读门面域);
 *  - 事件 10 域(2026-09-08):PackageChangeEvent = 变化域的新值 + 对称旧值(old*),差值消费方自算
 *    (身份键:工作区三域按 dir、system 按 name);all 域弃用(混合域无单一身份键,弃用标签见字段注释)。
 * 使用入口(工厂 + 静态能力函数)归 package-core/index.ts(≈ros2/compose.ts)。
 * 内部模块(data/scan/event/shared)对外部不可见。
 *
 * 2026-08-28:删 getSystemDir(系统包路径查询归 ros2/ Ros2ServiceApi,消费方直接调用)。
 * 设计见 设计/重构/package-core重新设计/DESIGN.md。
 */

import { PackageChangeEvent, PackageDataState } from "../data/state";
import { PackageEntry } from "../shared/types";
import { PackageDataApi } from "../data";

/** API 层对外接口(外部组件依赖的唯一形态) */
export interface PackageFacadeApi {
    /** 同步读全量便宜数据(快照) */
    getState(): Readonly<PackageDataState>;
    /** 分域变更事件:仅"发生变化的域"携带 新值 + 对称旧值(old*,2026-09-08;差值消费方自算),返回取消订阅函数 */
    onDidChange(cb: (ev: PackageChangeEvent) => void): () => void;
    /** 手动强制刷新(外部命令入口;工作区语义,不刷系统) */
    forceRefresh(): Promise<void>;
    /**
     * 系统包列表刷新(独立入口,2026-09-04 与 60s 定时解耦):只刷 system 域(+派生 all),
     * 不碰工作区缓存/工作区域。由装配方在底层 ros2/ env 变化(onEnvChanged)时调用——
     * 60s 定时器已不再负责系统刷新(不再调用 pkg list)。
     * 2026-09-13(手稿 §10 对齐):**env 驱动 = system 事件必发**——即使列表未变化,ev.system
     * 也携带(新值 = 旧值,差值为 0),供下游在环境变化后重推;从未成功(null)除外。
     */
    refreshSystem(): Promise<void>;
    /** 包创建接入口:新建 package.xml 后直接接入(不走 watcher/循环),增量并入缓存 */
    ingestPackageCreated(packageXmlPath: string): Promise<void>;
    /** 翻转接入口:创建/删除 COLCON_IGNORE,返回翻转后是否被忽略 */
    toggleIgnore(dir: string): Promise<boolean>;
    /** 构建包列表(快速、不阻塞):命中缓存立即返回;未命中只跑 colcon list 填 unignore,不走 walk;始终返回数据 */
    getBuildPackages(): Promise<ReadonlyArray<PackageEntry>>;
    /** 释放资源 */
    dispose(): void;
}

// ⚠️ 2026-08-30:PackageFacade 类(实现)已由 facade.ts 合并入 package-core/compose.ts
//   (2026-09-03 复核更正:原指路的 facade.ts 已不存在)。
// 静态能力(共享单例/校验/工具/常量等函数)为"使用入口",归 package-core/index.ts(≈ros2/compose.ts),
// 本类型层不再 re-export 任何实现(ros2/ 范式:api/ 纯接口)。
// 注:PackageFacadeApi 依赖的 PackageDataState / PackageChangeEvent / PackageEntry 类型
// 经下方类型 re-export 对外可见。
// 2026-09-02(设计 D3):PackageSnapshot / WorkspacePackage / PackageScanEntry(物理快照/画像)不再对外——
// 消费方(语言服务/derive)只读门面 PackageDataState 域,内部结构不再泄漏。
export type { PackageChangeEvent, PackageDataState } from "../data/state";
export type { PackageEntry } from "../shared/types";
// 修改时间:2026-09-08 22:45(事件 10 域化说明:onDidChange 携带新值 + 对称旧值 old*,差量消费方自算;all 弃用)