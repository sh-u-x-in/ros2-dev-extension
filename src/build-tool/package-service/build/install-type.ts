// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file install-type.ts(名称与职责相符,2026-08-31 改名批次保留原名)
 * colcon 安装方式决策(2026-08-30 自 packages/colcon-exec.ts 收编,git mv 保留历史)。
 * 唯一职责:决策安装方案,返回 ColconInstallType —— 2026-09-16 起为**两个正交轴**的组合。
 *
 * ── 两个轴(与 colcon CLI 一一对应;".分包/.实体"都是"不加参数") ──────
 *  形态 method:符号安装(--symlink-install)/ 实体安装(copy,复制文件,默认);
 *  布局 layout:合并安装(--merge-install,单前缀 install/)/ 分包安装(isolated,
 *             每包独立前缀 install/<包名>/,colcon 默认;读 .colcon_install_layout 同词)。
 *
 * ── 政策(2026-09-29 形态三值化,与布局口径对齐) ─────────────────
 *  形态:ROS2.build.installMethod 三值 —— auto = 平台默认(Windows copy / 其余
 *        symlink);symlink / copy = 显式强制(两平台均可;Windows 强制符号需
 *        开发者模式/管理员权限,由用户自担前提)。
 *  布局:ROS2.build.installLayout —— auto(默认)= Windows 合并 / 其余分包;
 *        也可显式 merged/isolated(两平台均可;Windows 默认合并有官方理由:
 *        cmd 下包多时环境变量会超长,colcon 文档建议 --merge-install)。
 *  语义:installMethod 只管形态,与布局无关;要"实体 + 合并"请显式
 *        `installMethod=copy` + `installLayout=merged`。
 *
 * 翻译(组合→CLI flag 数组)归 ros2/ toInstallTypeFlags(见 build域结构整理调研 §8)。
 * ⚠️ 扩展**自己的**构建不走"设置 → toInstallTypeFlags → 命令"这条路:两轴由模板里的
 *   `${install_method}` / `${install_layout}` 承载(值仍来自本函数),见 share/README.md。
 * 历史(原 colcon-exec.ts):decodeChildOutput / execColconRaw 已随 ros2/environment/command-runner.ts
 *   收编(30s 超时 + UTF-8/GBK 解码语义);其 49 行注释残骸已于 2026-08-31 清理(git 历史可查)。
 */

import * as vscode from "vscode";

import type { ColconInstallLayout, ColconInstallMethod, ColconInstallType } from "../../../ros2/api";

/**
 * 决策 colcon 安装方案(两轴组合;CLI flag 由 ros2/ toInstallTypeFlags 翻译)。
 * 形态:ROS2.build.installMethod(auto=平台默认 Windows copy / 其余 symlink;
 *        symlink/copy 显式强制,优先于平台)。
 * 布局:ROS2.build.installLayout(auto=平台默认,或显式 merged/isolated)。
 */
export function resolveInstallType(): ColconInstallType {
    const config = vscode.workspace.getConfiguration("ROS2");

    const configuredMethod = config.get<string>("build.installMethod", "auto");
    const method: ColconInstallMethod = configuredMethod === "symlink" || configuredMethod === "copy"
        ? configuredMethod // 显式选择优先于平台(Windows 强制符号 = 用户自担开发者模式前提)
        : (process.platform === "win32" ? "copy" : "symlink"); // auto = 平台默认

    const configured = config.get<string>("build.installLayout", "auto");
    const layout: ColconInstallLayout = configured === "merged" || configured === "isolated"
        ? configured
        : (process.platform === "win32" ? "merged" : "isolated"); // auto = 平台默认

    return { method, layout };
}
