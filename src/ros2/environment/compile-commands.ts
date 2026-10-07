// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file compile-commands.ts
 * 编译产物合并:各 build/<pkg>/compile_commands.json → build/compile_commands.json(clangd 索引)。
 * 2026-08-31 自废弃的 package-service/build-env-utils.ts 恢复(原实现 2026-08-28 随整体废弃注释)。
 * 触发:环境域构建信号监听(install/setup.bash)→ refreshAfterBuild(install ↔ build 产物一一对应,
 * 论证与触发矩阵见本目录 README「构建后刷新与 compile_commands 合并」节)。
 */

import { l10n } from "vscode";

import * as fs from "fs";
import * as path from "path";

import { getLogger } from "../../logger";

/** 编译产物合并模块日志 */
const log = getLogger("compile-commands");

/** 合并串行链:任何时刻单写者;失败吞错不中断链 */
let mergeChain: Promise<void> = Promise.resolve();

/**
 * 合并各 build/<pkg>/compile_commands.json → build/compile_commands.json。
 * 经构建信号(install/setup.bash,1s 防抖)在构建完成后调用;无论成败:失败包不 install 也大概率无该文件,
 * 成功包必有 → clangd 至少索引成功部分。未编译时数据源为空,合并结果写空数组(build 清则同失)。
 * @param workspaceRoot 工作区根目录
 */
export function mergeCompileCommands(workspaceRoot: string): void {
    mergeChain = mergeChain.then(async () => {
        try {
            const buildDir = path.join(workspaceRoot, "build");
            let entries;
            try {
                entries = await fs.promises.readdir(buildDir, { withFileTypes: true });
            } catch {
                return; // build 目录不存在:无数据可合并
            }
            const merged: any[] = [];
            for (const e of entries) {
                if (!e.isDirectory()) {
                    continue;
                }
                const ccPath = path.join(buildDir, e.name, "compile_commands.json");
                try {
                    const parsed = JSON.parse(await fs.promises.readFile(ccPath, "utf-8"));
                    if (Array.isArray(parsed)) {
                        merged.push(...parsed);
                    }
                } catch {
                    // 单个包无/坏 compile_commands:忽略
                }
            }
            await fs.promises.writeFile(path.join(buildDir, "compile_commands.json"), JSON.stringify(merged, null, 2), "utf-8");
            log.info(l10n.t("Merged {0} compile commands -> build/compile_commands.json", merged.length));
        } catch {
            // 合并失败忽略,不影响构建/环境
        }
    });
}
