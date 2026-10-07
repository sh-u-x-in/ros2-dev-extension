// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file state.ts
 * 数据层:统一状态快照(5 类分域,2026-08-29 恢复 system/all 域)。
 *
 *  - workspace 工作区工作包(= unignored + ignored,派生)
 *  - unignored 未忽略工作区工作包(colcon list 权威)
 *  - ignored 已忽略工作区工作包(COLCON_IGNORE 标记)
 *  - system 系统工作包(ros2 pkg list;dir 懒取,未取时为空)——2026-08-28 曾随环境源移除,
 *    2026-08-29 按"权威包数据中心"定位恢复(06 设计:系统包也是包数据)
 *  - all 所有工作包(= workspace + system,派生)——2026-09-08 起弃用(混合域
 *    无单一身份键、历次事件噪音源;新代码勿用,保留发射/字段兼容旧订阅方;弃用标签见字段注释)
 * 2026-09-08(事件 10 域化):PackageChangeEvent 增对称旧值 old*(oldWorkspace/oldUnignored/
 * oldIgnored/oldSystem/oldAll)——仅"变化域"携带"新值 + 旧值"成对,差量由消费方自算(身份键:
 * workspace/unignored/ignored 按 dir、system 按 name;all 混合域不做逐条 diff,需全量变化时对
 * workspace + system 两源域差量并集)。
 * 集合型便宜数据一次带全;单包细节(系统包路径/可执行)不落快照,由消费方直接调 ros2/。
 * 纯 TS,无 vscode 依赖,可无头测试。
 * 设计见 设计/重构/package-core三层解耦-2026-08-23/06-状态快照结构设计.md。
 */

import { PackageEntry } from "../shared/types";

/**
 * 数据层统一状态快照(对外只读;按字段分域读取)。
 *
 * ⚠️ null 语义(2026-09-01 定稿,与 Ros2ServiceApi null 契约对齐):
 *   五个域一律 `PackageEntry[] | null`:
 *     - `null` = **未刷新/未知**(冷启动未加载、或加载失败从未成功过)——调用方据此区分"没数据"与"没取过";
 *     - `[]`   = **已刷新且确实没有**(成功但空);
 *     - `[e...]` = 已刷新且有数据。
 *   派生域(workspace / all)在任一上游源为 null 时即为 null(未知传播,不冒充"空")。
 */
export interface PackageDataState {
    /** 工作区工作包(全量)= unignored + ignored,派生;null = 未刷新 */
    workspace: PackageEntry[] | null;
    /** 未忽略工作区工作包(colcon list 权威 / walk 兜底);null = 未刷新 */
    unignored: PackageEntry[] | null;
    /** 已忽略工作区工作包(COLCON_IGNORE 标记);null = 未刷新 */
    ignored: PackageEntry[] | null;
    /** 系统工作包(ros2 pkg list;dir 懒取);null = 未刷新/获取失败 */
    system: PackageEntry[] | null;
    /**
     * 所有工作包(全域)= workspace + system,派生;任一上游为 null 时为 null。
     * @deprecated 2026-09-08 起弃用:混合域(工作区 + 系统两宇宙)无单一身份键、历次事件噪音源;
     * 新代码请改用 workspace / system 两源域。保留字段以兼容旧订阅方。
     */
    all: PackageEntry[] | null;
    /** 快照生成时间戳 */
    generatedAt: number;
    // ⚠️ 2026-08-29 逻辑吸收:原 fingerprint 字段删除——整快照判重已由 package-cache(contentFingerprint)承担,
    //    data 只做域级比对(domainSig),不再二次判重(消除"双重检查")。
}

/**
 * 分域变更事件(2026-09-08:10 域 = 新值 + 对称旧值,差值由消费方自算)。
 * 仅"发生变化的域"携带:该域新值(原 5 字段)+ 对称旧值(old* 5 字段)成对出现;未变化域均为 undefined。
 * 例外(2026-09-13,手稿 §10 对齐):system 域经环境驱动刷新(refreshSystem)时**必携带**——即使列表
 * 未变(新值 = 旧值,差值为 0);环境是包内容/解析的前提,消费方需一次重推信号。无内容可推(从未成功,null)除外。
 * 差量自算身份键:workspace/unignored/ignored 按 dir、system 按 name;all(弃用)混合域不做逐条
 * diff,需要全量变化时对 workspace + system 两源域差量做并集。
 * 注:all / oldAll 为弃用字段(混合域无单一身份键、历次事件噪音源),弃用标注见各自字段注释;
 * 本接口本身未标弃用——保留发射兼容旧订阅方,新代码勿消费该两字段。
 */
export interface PackageChangeEvent {
    /** 工作区工作包变了(新值) */
    workspace?: PackageEntry[] | null;
    /** 未忽略工作区工作包变了(新值) */
    unignored?: PackageEntry[] | null;
    /** 已忽略工作区工作包变了(新值) */
    ignored?: PackageEntry[] | null;
    /** 系统工作包变了(新值) */
    system?: PackageEntry[] | null;
    /**
     * 所有工作包变了(全域,派生;新值)。
     * @deprecated 2026-09-08 起弃用:混合域无单一身份键、历次事件噪音源;保留发射兼容旧订阅方,
     * 新代码勿消费(请改用 workspace / system 两源域)。
     */
    all?: PackageEntry[] | null;
    /** 工作区工作包【旧值】(与 workspace 成对;null = 未刷新/无基线,勿据此推导删除) */
    oldWorkspace?: PackageEntry[] | null;
    /** 未忽略工作区工作包【旧值】 */
    oldUnignored?: PackageEntry[] | null;
    /** 已忽略工作区工作包【旧值】 */
    oldIgnored?: PackageEntry[] | null;
    /** 系统工作包【旧值】 */
    oldSystem?: PackageEntry[] | null;
    /**
     * 所有工作包(全域,派生)【旧值】。
     * @deprecated 2026-09-08 起弃用:同 ev.all(混合域),保留发射兼容旧订阅方,新代码勿消费。
     */
    oldAll?: PackageEntry[] | null;
}

/** 空快照(未加载前的初值:全部 null = 未知,区别于"已刷新但空"的 []) */
export function emptyState(): PackageDataState {
    return {
        workspace: null,
        unignored: null,
        ignored: null,
        system: null,
        all: null,
        generatedAt: 0,
    };
}

/**
 * 单域签名(name@dir@buildType 排序拼接;顺序变化不视为内容变化,供逐域比对)。
 * 2026-09-02(设计 D1):纳入 buildType——包类型就绪(undefined→值)/翻转(a↔c)也触发域事件,
 * 与 cache contentFingerprint(已含 buildType)口径对齐;域条目按 D4 规则发布时不含 undefined。
 * null → "!null"(与 [] 的 "" 区分,保证 null→[] 变化会发事件)
 */
export function domainSig(entries: PackageEntry[] | null): string {
    if (entries === null) {
        return "!null";
    }
    return entries.map((e) => `${e.name}@${e.dir}@${e.buildType ?? "∅"}`).sort().join("|");
}

// ⚠️ 2026-08-29 逻辑吸收:computeFingerprint(整快照指纹)已废弃注释保留——
//    整快照判重由 package-cache.contentFingerprint 承担,data 不再二次判重。
// 2026-09-03 复核:维持注释保留(墓碑),无活跃引用。
// export function computeFingerprint(
//     s: Omit<PackageDataState, "generatedAt">
// ): string {
//     return [domainSig(s.unignored), domainSig(s.ignored), domainSig(s.system)].join("##");
// }

// 修改时间:2026-09-08 22:45(事件 10 域化:PackageChangeEvent 增对称 old5;all/oldAll 弃用标注)