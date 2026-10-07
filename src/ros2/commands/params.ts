// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 本文件已整体废弃(DEPRECATED,2026-08-26)——不再参与编译,全部内容注释保留,
//    仅作历史参考。
// // 旧参数实现:getNodeParams / getParamValues。
// → monitorApi:param_list / param_get。
// 功能去向:monitorApi(consumers/monitor/monitor-api.ts)已承接全部查询/操作;
// 消费方(状态页 / 命令面板)已改走 composeApi.monitorApi,本文件零引用。
// 参考依据:设计/重构/monitor消费者接口-2026-08-26/DESIGN.md
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// 以下为原文件全部内容(整体注释,仅供历史参考,不参与编译)。
// ───────────────────────────────────────────────────────────────────────────
// // Copyright (c) Microsoft Corporation. All rights reserved.
// // Licensed under the MIT License.
//
// /**
//  * @file params.ts
//  * ROS 2 参数接口:ros2 param list(参数名)/ ros2 param get(参数值)。
//  * 参数值逐参数子进程获取,供状态页"点击展开取值"的按需加载。
//  */
//
// import * as child_process from "child_process";
// import * as os from "os";
// import * as util from "util";
//
// import * as environment from "../environment";
//
// import { getLogger } from "../../logger";
//
// /** 参数模块日志 */
// const log = getLogger("params");
//
// const promisifiedExec = util.promisify(child_process.exec);
//
// /**
//  * Represents a ROS 2 parameter name and its current value
//  */
// export interface ParamValue {
//     name: string;
//     value: string;
// }
//
// /**
//  * 获取指定 ROS 2 节点的参数名列表。
//  * 对应 `ros2 param list <node>`,只取参数名(不含值),供延迟加载(展开时才取值)使用。
//  */
// export async function getNodeParams(nodeName: string): Promise<string[]> {
//     log.trace(`获取节点 ${nodeName} 的参数名列表`);
//     try {
//         const { stdout } = await promisifiedExec(`ros2 param list ${nodeName}`, { env: environment.getEnv() });
//         const lines = stdout.trim().split(os.EOL);
//         const params = lines
//             .map(line => line.trim())
//             .filter(line => line.length > 0 && !line.startsWith("/") && !line.endsWith(":"));
//         log.debug(`节点 ${nodeName} 共 ${params.length} 个参数`);
//         return params;
//     } catch (error) {
//         log.error(`获取节点 ${nodeName} 参数列表时出错:${error instanceof Error ? error.message : String(error)}`);
//         return [];
//     }
// }
//
// /**
//  * 获取指定 ROS 2 节点若干参数的值。
//  * 对应逐参数 `ros2 param get <node> <param>`,返回参数名 + 值。
//  */
// export async function getParamValues(nodeName: string, paramNames: string[]): Promise<ParamValue[]> {
//     log.trace(`获取节点 ${nodeName} 的 ${paramNames.length} 个参数值`);
//     const results: ParamValue[] = [];
//     // 循环:逐参数调用 ros2 param get 取值
//     for (const paramName of paramNames) {
//         try {
//             const { stdout } = await promisifiedExec(`ros2 param get ${nodeName} ${paramName}`, { env: environment.getEnv() });
//             // 输出形如 "Integer value is: 10"、"String value is: 'abc'"
//             results.push({ name: paramName, value: stdout.trim() });
//         } catch (error) {
//             results.push({ name: paramName, value: `<错误:${error instanceof Error ? error.message : String(error)}>` });
//         }
//     }
//     return results;
// }
