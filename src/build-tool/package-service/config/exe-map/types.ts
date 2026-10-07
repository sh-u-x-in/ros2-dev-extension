// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file types.ts
 * 包服务层(中性命名,容纳可执行映射 / 一键配置 / 一键启动)共享类型。
 * 三兄弟共同主题:围绕包的"构建配置与可执行"做 读(映射) / 写(一键配置) / 用(一键启动)。
 * 纯 TS,零 vscode 依赖,可无头测试。
 */

/** 可执行入口来源 */
export type ExecutableKind = "consoleScript" | "cmakeTarget" | "exportExecutable";

/** 一个可执行入口(统一 setup.py / CMakeLists 两种来源的归一形态) */
export interface ExecutableEntry {
    /** 可执行名(console_scripts 的 '=' 左侧 / add_executable 目标名) */
    name: string;
    /** 来源 */
    kind: ExecutableKind;
    /** 名字含未解析动态(cmake 变量无法展开时为 true,调用方应谨慎,勿当精确名) */
    dynamic?: boolean;
}

/** 单包可执行映射(根键 = package.xml <name>) */
export interface PackageExecutables {
    /** package.xml <name>(Map 根键) */
    name: string;
    /** build_type(ament_python / ament_cmake / cmake) */
    buildType: string;
    /** 包目录绝对路径 */
    dir: string;
    /** 归一后的可执行入口 */
    executables: ExecutableEntry[];
    /** 解析是否部分失败(有 issues / 存在动态未解析目标),供上层降级提示 */
    hasIssues: boolean;
}

/** 名称三方不一致事件(目录名 / package.xml / 配置内名)——重命名模块订阅 */
export interface NameMismatchEvent {
    /** 包目录绝对路径 */
    dir: string;
    /** package.xml <name> */
    packageName: string;
    /** 目录名(path.basename(dir)) */
    directoryName: string;
    /** 配置内名(setup.py name / CMake project 名),未声明时为 undefined */
    declaredName?: string;
    buildType: string;
}
