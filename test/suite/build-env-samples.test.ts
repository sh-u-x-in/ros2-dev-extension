// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 本文件已废弃(DEPRECATED,2026-08-30)——整体注释,不参与编译。
// 原因:所测目标 build-env-utils.ts(toCppIncludeEntry / maintainIncludeConfigs)已废弃注释
// (2026-08-28),且依赖旧壳 colcon-utils.getPackages(已移除);功能去向:
// 配置生成按 package-core 重新设计迁入 package-service/config/gen/intellisense-config.ts。
// 参考:src/build-tool/package-service/config/gen/intellisense-config.ts 头注释。
// ═══════════════════════════════════════════════════════════════════════════
//
// 以下为原文件全部内容(整体注释,仅供历史参考,不参与编译)。
// /**
//  * 自动加载模块 · 配置生成用真实 include 目录（L2 VS Code 集成）
//  *
//  * 目标模块：src/ros/build-env-utils.ts（toCppIncludeEntry / maintainIncludeConfigs）
//  * 层级：L2（依赖 vscode 工作区）；⚠️ build-env-utils 依赖 vscode 运行时 → 集成环境（npm test）验证
//  * 关联测试项：A17–A19（方案 02 §4.5）
//  *
//  * 说明：
//  *  - A17/A18（toCppIncludeEntry）为纯函数逻辑，集成环境直接断言输出格式。
//  *  - A19（maintainIncludeConfigs）依赖包缓存（colcon list）与 PackageDiff：
//  *      · 远端（Linux + colcon/ROS）→ 包缓存非空 → 验证生成 c_cpp_properties 含 rde_cpp/include；
//  *      · 本地（Windows 无 colcon）→ hasCachedPackages() 为空 → 验证**安全早退**（不抛错、不改文件），
//  *        完整场景以远端验收为准。
//  */
// 
// import * as assert from "assert";
// import * as path from "path";
// import * as vscode from "vscode";
// import { toCppIncludeEntry, maintainIncludeConfigs } from "../../src/build-tool/package-service/build-env-utils";
// import { getPackages } from "../../src/build-tool/packages/colcon-utils";
// 
// /** samples 根目录（集成测试以 samples 为工作区） */
// const SAMPLES = path.resolve(__dirname, "../../../samples");
// 
// /** rde_cpp 真实 include 目录（A17 输入；标准工作空间 src/ 结构） */
// const RDE_CPP_INCLUDE = path.join(SAMPLES, "src/rde_cpp/include");
// 
// describe("build-env 配置生成测试(samples 真实目录)", function () {
//     this.timeout(30000);
// 
//     it("A17 toCppIncludeEntry(rde_cpp/include, samples) → ${workspaceFolder} 相对 includePath 项", () => {
//         const entry = toCppIncludeEntry(RDE_CPP_INCLUDE, SAMPLES);
//         assert.ok(entry.includes("${workspaceFolder}"), `应含 \${workspaceFolder} 变量，实际 ${entry}`);
//         assert.ok(entry.replace(/\\/g, "/").includes("src/rde_cpp/include"), `应含 rde_cpp/include 相对路径，实际 ${entry}`);
//     });
// 
//     it("A18 toCppIncludeEntry(系统路径 /opt/ros/...) → 保持绝对路径（不改写为 ${workspaceFolder}）", () => {
//         const sysPath = "/opt/ros/humble/include/rclcpp";
//         const entry = toCppIncludeEntry(sysPath, SAMPLES);
//         assert.ok(!entry.includes("${workspaceFolder}"), `系统路径不应被改写为工作区相对，实际 ${entry}`);
//         // 平台差异：Windows 下 path.join 用反斜杠（\opt\ros\...），Linux 用斜杠；归一化后应保留目标路径
//         const norm = entry.replace(/\\/g, "/");
//         assert.ok(
//             norm.includes("opt/ros/humble/include/rclcpp"),
//             `应保留系统路径，实际 ${entry}`
//         );
//     });
// 
//     it("A19 maintainIncludeConfigs → 有包缓存则生成配置；无缓存（本地无 colcon）安全早退", async () => {
//         // 先尝试填充包缓存（colcon list）；本地无 colcon → 缓存空
//         await getPackages(SAMPLES);
//         if (!(vscode.workspace.rootPath)) {
//             assert.ok(true, "无工作区根 → 早退（环境原因）");
//             return;
//         }
//         try {
//             await maintainIncludeConfigs();
//             // 不抛错即通过；是否真正写入 c_cpp_properties 取决于包缓存是否非空：
//             //   - 远端（有 colcon）→ 包缓存非空 + PackageDiff → 生成配置
//             //   - 本地（无 colcon）→ 缓存空 → 函数内安全早退
//             assert.ok(true, "maintainIncludeConfigs 执行完成（未抛错）");
//         } catch (err) {
//             assert.fail(`maintainIncludeConfigs 不应抛错：${(err as Error).message}`);
//         }
//     });
// });
// 