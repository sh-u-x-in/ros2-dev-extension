// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 本文件已废弃(DEPRECATED,2026-08-30)——整体注释,不参与编译。
// 原因:所测目标 build-env-utils.ts(makeWorkspaceRelative)已废弃注释(2026-08-28),
// 测试import 指向死模块导致 tsc 失败;功能去向:路径转换类能力散落或已无消费方。
// 参考:src/build-tool/package-service/build-env-utils.ts 头注释。
// ═══════════════════════════════════════════════════════════════════════════
//
// 以下为原文件全部内容(整体注释,仅供历史参考,不参与编译)。
// /**
//  * Build Environment Utils Test
//  * 
//  * Test path conversion from absolute to relative paths for VS Code configuration.
//  */
// 
// import * as assert from 'assert';
// import * as path from 'path';
// import { makeWorkspaceRelative } from '../../src/build-tool/package-service/build-env-utils';
// 
// describe('Build Environment Utils - Path Conversion', () => {
//     describe('makeWorkspaceRelative', () => {
//         it('should convert workspace paths to relative', () => {
//             const workspaceRoot = '/home/user/ros2_ws';
//             const absolutePath = '/home/user/ros2_ws/build/my_package';
//             
//             const relativePath = makeWorkspaceRelative(absolutePath, workspaceRoot);
//             
//             // 跨平台:path.join 生成平台分隔符(makeWorkspaceRelative 返回平台分隔符)
//             assert.strictEqual(relativePath, path.join('build', 'my_package'));
//         });
// 
//         it('should handle install directory paths', () => {
//             const workspaceRoot = '/home/user/ros2_ws';
//             const absolutePath = '/home/user/ros2_ws/install/my_package/lib/python3.12/site-packages';
//             
//             const relativePath = makeWorkspaceRelative(absolutePath, workspaceRoot);
//             
//             // 跨平台:path.join 生成平台分隔符
//             assert.strictEqual(relativePath, path.join('install', 'my_package', 'lib', 'python3.12', 'site-packages'));
//         });
// 
//         it('should keep external paths as absolute', () => {
//             const workspaceRoot = '/home/user/ros2_ws';
//             const absolutePath = '/opt/ros/humble/lib/python3.12/site-packages';
//             
//             const relativePath = makeWorkspaceRelative(absolutePath, workspaceRoot);
//             
//             // External paths should remain unchanged
//             assert.strictEqual(relativePath, absolutePath);
//         });
// 
//         it('should handle workspace root itself', () => {
//             const workspaceRoot = '/home/user/ros2_ws';
//             const absolutePath = '/home/user/ros2_ws';
//             
//             const relativePath = makeWorkspaceRelative(absolutePath, workspaceRoot);
//             
//             // Workspace root should return empty string
//             assert.strictEqual(relativePath, '');
//         });
// 
//         it('should handle null/undefined inputs', () => {
//             const workspaceRoot = '/home/user/ros2_ws';
//             
//             assert.strictEqual(makeWorkspaceRelative(null, workspaceRoot), "");
//             assert.strictEqual(makeWorkspaceRelative(undefined, workspaceRoot), "");
//             assert.strictEqual(makeWorkspaceRelative('/some/path', null), '/some/path');
//             assert.strictEqual(makeWorkspaceRelative('/some/path', undefined), '/some/path');
//         });
// 
//         it('should handle paths with same prefix but different root', () => {
//             const workspaceRoot = '/home/user/ros2_ws';
//             const absolutePath = '/home/user/ros2_workspace/build/my_package';
//             
//             const relativePath = makeWorkspaceRelative(absolutePath, workspaceRoot);
//             
//             // These should not be considered the same workspace
//             assert.strictEqual(relativePath, absolutePath);
//         });
// 
//         it('should handle Windows paths', () => {
//             if (process.platform === 'win32') {
//                 const workspaceRoot = 'C:\\Users\\user\\ros2_ws';
//                 const absolutePath = 'C:\\Users\\user\\ros2_ws\\build\\my_package';
//                 
//                 const relativePath = makeWorkspaceRelative(absolutePath, workspaceRoot);
//                 
//                 assert.strictEqual(relativePath, 'build\\my_package');
//             } else {
//                 // Skip on non-Windows
//                 assert.ok(true);
//             }
//         });
// 
//         it('should normalize paths before comparison', () => {
//             const workspaceRoot = '/home/user/ros2_ws';
//             const absolutePath = '/home/user/ros2_ws//build/../build/my_package';
//             
//             const relativePath = makeWorkspaceRelative(absolutePath, workspaceRoot);
//             
//             // Should normalize and convert correctly
//             // 跨平台:path.join 生成平台分隔符
//             assert.strictEqual(relativePath, path.join('build', 'my_package'));
//         });
//     });
// });
// 