// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file types.ts
 * package-core 共享值类型（跨层传递用，防形状漂移）。
 *
 * 说明：TS 是结构类型，跨边界本不强制共享声明；但把跨层传递的值类型收在这里，
 * 一处定义、各处引用，编译期即可防"形状漂移"。
 *  - PackageEntry   : 包条目（工作区 + 系统统一形态）
 *  - ExecutableInfo : 可执行入口(2026-08-29 已注释保留,见文件内)
 */

/**
 * 一个包条目（工作区包与系统包统一形态）。
 *
 * **来源权威 = PackageDataState 分域**（2026-09-02 定稿）：system 域 = 系统包、workspace 域 = 工作区包，
 * 消费方按域拿数据即可区分来源，不要在条目字段上猜。dir：工作区包必为绝对路径，系统包懒取为空；
 * buildType 三态仅用于**字段类型统一**（可选字段 + 系统包填 `""`），**不是判别依据**：
 *  - 具体值 = 工作区包合法类型（cache 层从 walk 画像合并填充）；
 *  - `""` = 系统包（ros2 pkg list 不携带 build_type，为统一类型而填）；
 *  - `undefined` = 工作区包未取到（colcon list 快路径无 walk 画像 / 扫描异常）。
 */
export interface PackageEntry {
    /** package.xml <name> 或系统包名 */
    name: string;
    /** 包目录绝对路径（系统包懒取时为空） */
    dir: string;
    /** 构建类型（package.xml <export><build_type>；三态仅类型统一，见上注释） */
    buildType?: string;
}

/** python 构建类型常量（谓词与分派共用，防字符串漂移） */
export const PYTHON_BUILD_TYPE = "ament_python";

/**
 * python 包判定（工作区包合法类型判别——buildType 合法值即类型本身，此为正当判别；
 * 系统包判定不在此列，按域拿 system 域即可）。
 * 2026-09-02（设计 D4）：域层「类型就绪才发布」，发布域条目无 undefined；undefined 仅防御路径可能
 * （域未就绪的 ?? [] 之外的非常规取数）——谓词保持二值（undefined → false，不当作 python，宁缺勿误）。
 */
export function isPythonPackage(entry: Pick<PackageEntry, "buildType">): boolean {
    return entry.buildType === PYTHON_BUILD_TYPE;
}

// ⚠️ 2026-08-29:ExecutableInfo 已随 getExecutables 链摘除(data → executable-map 反向边清理),
// 注释保留,供未来可执行派生服务(一键启动重做)恢复时参考。
// 2026-09-03 复核:可执行派生已落地 package-service/config/exe-map(05 任务 6),本条仅供历史参考,维持注释保留。
// /** 一个可执行入口（可执行名 + 完整路径，可带来源标注） */
// export interface ExecutableInfo {
//     /** 可执行名 */
//     name: string;
//     /** 完整路径（未解析时为空） */
//     path: string;
//     /** 来源标注（如 "ros2" / "cmake-target" / "console-script"），可选 */
//     kind?: string;
// }