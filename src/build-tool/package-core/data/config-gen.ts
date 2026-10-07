// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 本文件已废弃(DEPRECATED,2026-08-29)——不再参与编译,内容注释保留,仅作历史参考。
// 2026-09-03 复核(项目结尾):维持墓碑注释保留,不删除。
// 去向:实现已迁往 package-service/config-gen.ts(数据消费者定位,§4 问题 6)。
// 参考:设计/重构/package与package-core语义收编-2026-08-28/package-core内部分类问题-2026-08-29.md §3.3。
// ═══════════════════════════════════════════════════════════════════════════
// ───────────────────────────────────────────────────────────────────────────
// 以下为原文件全部内容(整体注释,仅供历史参考,不参与编译)。
// ───────────────────────────────────────────────────────────────────────────
// // Copyright (c) Microsoft Corporation. All rights reserved.
// // Licensed under the MIT License.
// 
// /**
//  * @file config-gen.ts
//  * 配置生成(2026-08-28 迁入 package-core 重新设计;2026-08-29 迁出至 package-service)。
//  * 定位:数据消费者(读 package-core 快照写编辑器配置),与 executable-map 等同属"包服务";
//  * 数据源经注入(getState + onDidChange),只 import type 状态形状,零运行时耦合 package-core。
//  *
//  * 背景:原 build-env-utils.ts(createConfigFiles / maintainIncludeConfigs)已废弃注释,
//  * 依赖旧壳 colcon-utils 包数据状态机;本模块按"门控中心"定位重新实现:
//  *  - 数据源:package-core 自身快照(workspace 包) + 注入的系统 include 目录(ros2/ 环境侧提供,不碰 env);
//  *  - 输出:c_cpp_properties.json(ROS include)/ Python extraPaths / .clangd;
//  *  - 增量维护:订阅 onDidChange,按包 diff 增删 include 条目。
//  *
//  * 依赖方向:package-core 内部模块 + 注入(vscode / fs 为基础设施)。
//  */
// 
// import * as path from "path";
// import { promises as fsPromises } from "fs";
// import * as vscode from "vscode";
// 
// // 2026-08-29 迁入 package-service:纯注入解环,只 import type 状态形状(§4 问题 6)
// import type { PackageChangeEvent, PackageDataState } from "../package-core/data/state";
// import type { PackageEntry } from "../package-core/shared/types";
// 
// /** 配置生成选项(依赖注入) */
// export interface ConfigGenOptions {
//     /** 工作区根 */
//     workspaceRoot: string;
//     /** 读包数据快照(本中心) */
//     getState(): Readonly<PackageDataState>;
//     /** 系统 include 目录(注入:ros2/ 环境 AMENT/CMAKE_PREFIX_PATH 下 include;无环境时返回空) */
//     getSystemIncludeDirs(): Promise<string[]>;
// }
// 
// /** 配置生成器(对外接口) */
// export interface ConfigGen {
//     /** 全量同步:生成缺失的 c_cpp_properties.json / Python extraPaths / .clangd(0→1 语义,缺失才写) */
//     sync(): Promise<void>;
//     /** 订阅包变化,按 diff 增量维护 include 配置;返回取消订阅函数 */
//     subscribe(onDidChange: (cb: (ev: PackageChangeEvent) => void) => () => void): () => void;
//     /** 释放(取消订阅) */
//     dispose(): void;
// }
// 
// /** 绝对 include 路径 → c_cpp_properties.json includePath 条目(与旧实现口径一致,R-A1) */
// function toCppIncludeEntry(absInclude: string, workspaceRoot: string): string {
//     const relative = path.relative(workspaceRoot, absInclude);
//     if (relative && !relative.startsWith("..")) {
//         const posix = relative.split(path.sep).join(path.posix.sep);
//         return path.posix.join("${workspaceFolder}", posix, "**");
//     }
//     return path.join(absInclude, "**");
// }
// 
// /** 收集工作区包 include 目录(包 dir/include,存在才收) */
// async function collectWorkspaceIncludes(entries: PackageEntry[]): Promise<string[]> {
//     const includes: string[] = [];
//     for (const pkg of entries) {
//         const include = path.join(pkg.dir, "include");
//         try {
//             await fsPromises.access(include);
//             includes.push(include);
//         } catch {
//             // include 不存在,跳过
//         }
//     }
//     return includes;
// }
// 
// /** 生成 c_cpp_properties.json(保留用户已有 intelliSenseMode/compilerPath/cStandard/cppStandard,缺失才写文件) */
// async function syncCppProperties(workspaceRoot: string, includes: string[]): Promise<void> {
//     const dir = path.join(workspaceRoot, ".vscode");
//     const filename = path.join(dir, "c_cpp_properties.json");
//     // 0→1 语义:已存在不重写(与旧 createConfigFiles 一致);增量维护走 maintainIncludes
//     try {
//         await fsPromises.access(filename);
//         return;
//     } catch {
//         // 不存在 → 生成
//     }
//     const cppProperties: any = {
//         configurations: [
//             {
//                 browse: {
//                     databaseFilename: "${workspaceFolder}/.vscode/browse.vc.db",
//                     limitSymbolsToIncludedHeaders: false,
//                 },
//                 includePath: includes.map((i) => toCppIncludeEntry(i, workspaceRoot)),
//                 name: "ros2",
//             },
//         ],
//         version: 4,
//     };
//     if (process.platform === "linux") {
//         cppProperties.configurations[0].intelliSenseMode = "gcc-" + process.arch;
//         cppProperties.configurations[0].compilerPath = "/usr/bin/gcc";
//         cppProperties.configurations[0].cStandard = "gnu11";
//         cppProperties.configurations[0].cppStandard = "gnu++17"; // TODO:读设置 cppStandard
//     }
//     await fsPromises.mkdir(dir, { recursive: true });
//     await fsPromises.writeFile(filename, JSON.stringify(cppProperties, undefined, 2), "utf8");
// }
// 
// /** Python extraPaths:收集含 setup.py 的包目录(src/ 或包根),缺失才更新 vscode 配置 */
// async function syncPythonPaths(workspaceRoot: string, entries: PackageEntry[]): Promise<void> {
//     const pythonDirs: string[] = [];
//     for (const pkg of entries) {
//         const candidates = [path.join(pkg.dir, "src"), pkg.dir];
//         for (const c of candidates) {
//             try {
//                 await fsPromises.access(path.join(c, "setup.py"));
//                 pythonDirs.push(c);
//                 break;
//             } catch {
//                 // 不是 python 包
//             }
//         }
//     }
//     if (pythonDirs.length === 0) {
//         return;
//     }
//     const cfg = vscode.workspace.getConfiguration();
//     const auto = cfg.get<string[]>("python.autoComplete.extraPaths", []);
//     const analysis = cfg.get<string[]>("python.analysis.extraPaths", []);
//     const merged = Array.from(new Set([...auto, ...analysis, ...pythonDirs]));
//     if (auto.length === 0) {
//         await cfg.update("python.autoComplete.extraPaths", pythonDirs, vscode.ConfigurationTarget.Workspace);
//     }
//     if (analysis.length === 0) {
//         await cfg.update("python.analysis.extraPaths", pythonDirs, vscode.ConfigurationTarget.Workspace);
//     }
//     void merged; // 保留合并语义供增量维护 TODO
// }
// 
// /** 生成 .clangd(缺失才写):CompileFlags.Add(-I 各 include) */
// async function syncClangd(workspaceRoot: string, includes: string[]): Promise<void> {
//     const filename = path.join(workspaceRoot, ".clangd");
//     try {
//         await fsPromises.access(filename);
//         return;
//     } catch {
//         // 不存在 → 生成
//     }
//     const lines = ["CompileFlags:", "  Add: [", "    -Wall,"];
//     for (const inc of includes) {
//         lines.push(`  -I${inc}`);
//     }
//     lines.push("  ]");
//     await fsPromises.writeFile(filename, lines.join("\n"), "utf8");
// }
// 
// /** 创建配置生成器(依赖注入;消费 package-core 快照 + onDidChange 包 diff) */
// export function createConfigGen(opts: ConfigGenOptions): ConfigGen {
//     let unsub: (() => void) | undefined;
// 
//     async function collectAllIncludes(): Promise<string[]> {
//         const state = opts.getState();
//         const entries = [...state.unignored, ...state.ignored]; // workspace 口径(ignored 也是源码)
//         const sys = await opts.getSystemIncludeDirs();
//         const wsInc = await collectWorkspaceIncludes(entries);
//         const all = [...sys, ...wsInc];
//         if (process.platform === "linux") {
//             all.push(path.join("/", "usr", "include"));
//         }
//         return all;
//     }
// 
//     return {
//         async sync(): Promise<void> {
//             const includes = await collectAllIncludes();
//             await syncCppProperties(opts.workspaceRoot, includes);
//             await syncPythonPaths(opts.workspaceRoot, opts.getState().workspace);
//             await syncClangd(opts.workspaceRoot, includes);
//         },
//         subscribe(onDidChange) {
//             // 包变化 → 增量维护:按 diff 重算 include(全量重写 c_cpp_properties,保留用户字段由写路径保证)
//             unsub = onDidChange((ev) => {
//                 if (ev.workspace || ev.unignored || ev.ignored) {
//                     void this.sync(); // TODO(增量):对比旧快照算 added/removed,写队列 + 黑名单语义后续补
//                 }
//             });
//             return unsub!;
//         },
//         dispose() {
//             unsub?.();
//             unsub = undefined;
//         },
//     };
// }
