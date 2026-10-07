// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file distro-templates.ts
 * 发行版路径模板注册表 + 版本发现(观测优先,表兜底)。
 * 差异事实源:`手工重设计/gen-静态路径核实-2026-09-15.md`(源码级 + VM 实测)与
 * `手工重设计/12-发行版发现与gen模板分派-设计方案.md`(VD,2026-09-28 用户裁定)。
 * 管辖面:**只管 gen 静态安装路径模板**(ament_python 落点 ABI 段 / ament_cmake purelib 形态);
 * 系统 include 组(sys)与系统 PYTHONPATH 走 env 前缀天然自适应,不在本表管辖内。
 * 纯函数零 vscode 依赖,可无头测试(test/suite/distro-templates.test.ts)。
 */

import * as path from "path";

import { DEFAULT_PATH_TEMPLATE, DistroPathTemplate, HUMBLE_PATH_TEMPLATE } from "./intellisense-utils";

/**
 * 跨发行版模板表(2026-09-28,VD-1)。
 * · humble = VM 实测**专有形态**(local/lib/<abi>/dist-packages);Iron 起 ament_cmake(python)
 *   并入 lib/<abi>/site-packages(手稿 §4 C2,源码级);
 * · iron 的 pythonAbi 表值按 REP 2000 主平台 jammy = python3.10;装在 noble 时由
 *   observePythonAbi 观测覆盖(手稿 §2.3:scheme 覆盖逻辑与发行版无关,ABI 跟操作系统走);
 * · dashing/eloquent 均按 bionic 系统 python3.6 构建(2026-09-28 网络核实);foxy/galactic = focal 3.8;
 *   EOL 行仅备查(观测优先机制会让真实环境覆盖表值);
 * · **rolling 按 2026-09-28 用户裁定维持排除**(不进白名单/模板表,走 DEFAULT 回落)。
 */
export const DISTRO_PATH_TEMPLATES: Readonly<Record<string, DistroPathTemplate>> = {
    dashing: { distro: "dashing", pythonAbi: "python3.6", cmakePythonPurelib: "local/lib/python3.6/dist-packages" },
    eloquent: { distro: "eloquent", pythonAbi: "python3.6", cmakePythonPurelib: "local/lib/python3.6/dist-packages" },
    foxy: { distro: "foxy", pythonAbi: "python3.8", cmakePythonPurelib: "local/lib/python3.8/dist-packages" },
    galactic: { distro: "galactic", pythonAbi: "python3.8", cmakePythonPurelib: "local/lib/python3.8/dist-packages" },
    humble: HUMBLE_PATH_TEMPLATE,
    iron: { distro: "iron", pythonAbi: "python3.10", cmakePythonPurelib: "lib/python3.10/site-packages" },
    jazzy: { distro: "jazzy", pythonAbi: "python3.12", cmakePythonPurelib: "lib/python3.12/site-packages" },
    kilted: { distro: "kilted", pythonAbi: "python3.12", cmakePythonPurelib: "lib/python3.12/site-packages" },
    lyrical: { distro: "lyrical", pythonAbi: "python3.12", cmakePythonPurelib: "lib/python3.12/site-packages" },
};

/** 查表:未知名(含 rolling/undefined)回落 DEFAULT(humble,与 2026-09-15 裁定一致) */
export function resolveDistroTemplate(distro: string | undefined): DistroPathTemplate {
    if (distro) {
        const row = DISTRO_PATH_TEMPLATES[distro];
        if (row) {
            return row;
        }
    }
    return DEFAULT_PATH_TEMPLATE;
}

/** ABI 目录段规范形(python3.<n> 整段);防止把路径碎片/带后缀串当 ABI */
function isPythonAbiSegment(seg: string): boolean {
    return /^python3\.\d+$/.test(seg);
}

/**
 * 观测 pythonAbi(2026-09-28 用户裁定 R2:**观测优先,表兜底**)。
 * 从 env.PYTHONPATH 条目里提取 python3.\d+ **完整目录段**:优先含 /opt/ros 的系统段
 * (发行版 source 后 lib/<abi>/site-packages 与 local/<abi>/dist-packages 都在 PATH 里),
 * 无系统段再取任意段(venv 等),各取第一个命中。提取失败 → undefined(调用方查表)。
 * Windows 落点无版本段(手稿 §5),自然观测不到 → 查表,不受影响。
 */
export function observePythonAbi(env: any | undefined): string | undefined {
    const raw = env?.PYTHONPATH;
    if (typeof raw !== "string" || raw.length === 0) {
        return undefined;
    }
    let fallback: string | undefined;
    for (const entry of raw.split(path.delimiter)) {
        if (entry.length === 0) {
            continue;
        }
        const norm = entry.replace(/\\/g, "/");
        const abi = norm.split("/").find(isPythonAbiSegment);
        if (!abi) {
            continue;
        }
        if (norm.includes("/opt/ros/")) {
            return abi; // 系统段优先,取第一个命中
        }
        if (fallback === undefined) {
            fallback = abi;
        }
    }
    return fallback;
}

/** pythonAbi 的最终来源(观测/日志标注用) */
export type AbiSource = "observed" | "table" | "default";

export interface ResolvedDistroConfig {
    /** 最终生效模板(已知发行版被观测覆盖时是行内 pythonAbi/purelib ABI 段同步替换后的副本) */
    tpl: DistroPathTemplate;
    /** 来源:observed=PYTHONPATH 观测;table=表值;default=未知发行版/无环境整体回落 DEFAULT */
    abiSource: AbiSource;
    /** env.ROS_DISTRO 原值(日志标注;无 env 时 undefined) */
    distro?: string;
}

/** 表行 ABI 覆盖:pythonAbi 与 cmakePythonPurelib 内嵌的 ABI 段同步替换(purelib 形态沿用表行) */
function withAbi(row: DistroPathTemplate, abi: string): DistroPathTemplate {
    return {
        ...row,
        pythonAbi: abi,
        cmakePythonPurelib: row.cmakePythonPurelib.replace(row.pythonAbi, abi),
    };
}

/**
 * 组合(VD-2 消费入口):distro 查行 + ABI 观测覆盖。
 * · 已知发行版:观测值覆盖行内 pythonAbi(iron+noble 场景),cmakePythonPurelib 的 ABI 段连带替换、
 *   **形态(路径形状)沿用表行**(形态由发行版的 ament_cmake/colcon 版本决定,与 OS 的 ABI 独立);
 * · 无观测 → 表值(abiSource=table);未知发行版/rolling → 整体 DEFAULT,**观测不参与组合**
 *   (2026-09-28 裁定 R2:避免拼出"noble ABI + humble 形态"这种不存在的形状)。
 */
export function resolveDistroConfig(env: any | undefined): ResolvedDistroConfig {
    const distro = typeof env?.ROS_DISTRO === "string" && env.ROS_DISTRO.length > 0 ? env.ROS_DISTRO : undefined;
    const row = distro !== undefined ? DISTRO_PATH_TEMPLATES[distro] : undefined;
    if (!row) {
        // 未知发行版(含 rolling)/ 无 env:整体回落 DEFAULT,观测不参与组合(R2)
        return { tpl: DEFAULT_PATH_TEMPLATE, abiSource: "default", distro };
    }
    const observed = observePythonAbi(env);
    if (observed) {
        return { tpl: withAbi(row, observed), abiSource: "observed", distro };
    }
    return { tpl: row, abiSource: "table", distro };
}

/* ================================================================== */
/* 头文件安装布局分派(2026-09-29,create 域消费):按机器发行版选文本变体 */
/* ================================================================== */

/** 头文件安装布局:double = 双层 include/<pkg>/<pkg>(humble~lyrical);single = 单层 include/<pkg>(dashing~galactic) */
export type IncludeLayout = "double" | "single";

/**
 * 发行版 → 头文件布局(形态断层在 galactic→humble,手稿 C7;两个变体的**文本自身**不携带
 * 任何发行版名/"约定"概念——2026-09-29 用户裁定:只提其一必引人追问其二,简因规劝即可)。
 */
export const DISTRO_INCLUDE_LAYOUT: Readonly<Record<string, IncludeLayout>> = {
    dashing: "single",
    eloquent: "single",
    foxy: "single",
    galactic: "single",
    humble: "double",
    iron: "double",
    jazzy: "double",
    kilted: "double",
    lyrical: "double",
};

/** 查表分派:未知发行版(rolling)/undefined → double 兜底(与 DEFAULT humble 同向) */
export function resolveIncludeLayout(distro: string | undefined): IncludeLayout {
    if (distro && DISTRO_INCLUDE_LAYOUT[distro]) {
        return DISTRO_INCLUDE_LAYOUT[distro];
    }
    return "double";
}
// 修改时间:2026-09-29 22:30(VD 后续:增设头文件布局分派 resolveIncludeLayout——文本中立与内容对齐分立,create 命令链消费)
// 修改时间:2026-09-28(VD-1 建档:跨发行版模板表 + 观测优先发现链,差异事实源=gen-静态路径核实-2026-09-15.md)
