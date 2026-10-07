// Licensed under the MIT License.

/**
 * @file run-data-source.ts(2026-09-25 新增)
 * run 域的**数据源窄接口**(仿 build 域 BuildDataSource:参数注入,零循环依赖)
 * + 默认实现(**install-truth 共享数据中心** —— 文件系统扫描,无需 ROS 环境)。
 *
 * 数据口径 = install 侧真相:
 *  · 包/可执行 ← 快照 jumps(构建目标;与侧边栏 lib 区、launch 语言域的可执行校验同源);
 *  · launch 文件 ← share 区中名字命中 launch 扩展名的行(与侧边栏 launch 区同一判定 `launch-detect.ts`)。
 * 未就绪/无工作区一律返回空数组(调用方给"未发现构建产物"的提示,不区分原因)。
 */

import * as path from "path";

import * as vscode from "vscode";

import { ExecutableResolver } from "../../../install-truth/api";
import { acquireSharedBuildCenter } from "../../../install-truth/center/shared-center";
import { getLogger } from "../../../logger";
import { isLaunchFileName, trimLaunchDisplayPrefix } from "./launch-detect";

/** run-data-source 模块日志 */
const log = getLogger("run-data-source");

/** 一条可运行目标(ros2 run) */
export interface RunTarget {
    pkg: string;
    executable: string;
}

/** 一条可启动目标(ros2 launch) */
export interface LaunchTarget {
    pkg: string;
    /** 包内相对安装路径(展示名;嵌套目录保留子路径)——`ros2 launch <pkg> <file>` 的 file 口径 */
    name: string;
    /** 安装侧绝对路径(${launch_path};记忆退化键) */
    installPath: string;
    /** 源文件绝对路径(记忆分槽键;源未解析 → undefined) */
    sourcePath?: string;
}

/** run 域数据源(面板流程注入;侧边栏树入口不需要它 —— 目标已知,直接展开执行) */
export interface RunDataSource {
    /** 已构建安装的包名(升序) */
    listPackages(): Promise<string[]>;
    /** 包 → 可执行名(升序;包未构建/无目标 → 空数组) */
    executablesOf(pkg: string): Promise<string[]>;
    /** 全部 launch 文件(按包序;仅 status=installed 的行) */
    launchFiles(): Promise<LaunchTarget[]>;
    /** 源文件 → 所属可执行(2026-09-29 一键运行;未构建/无跳转记录 → 空数组) */
    ownersOfSource(srcPath: string): Promise<RunTarget[]>;
    /** 源文件 → launch 目标(2026-09-29 一键运行;launchFiles 快照按 sourcePath 匹配;未命中 → undefined) */
    launchFileOfSource(srcPath: string): Promise<LaunchTarget | undefined>;
}

/**
 * 共享中心的轻量门面(2026-09-30 改**模块级缓存**):
 * resolver 门面对象虽轻,但索引缓存(ExecIndexCache/areaIndex)按实例持有 ——
 * 每次弹窗都 new 会让每次下拉都重建一遍索引;缓存后索引按快照引用自动失效,换根重建门面。
 */
let cachedResolver: { root: string; resolver: ExecutableResolver } | undefined;
function resolverOf(): ExecutableResolver | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root === undefined) {
        return undefined;
    }
    if (cachedResolver === undefined || cachedResolver.root !== root) {
        cachedResolver = { root, resolver: new ExecutableResolver(acquireSharedBuildCenter(root).center) };
    }
    return cachedResolver.resolver;
}

/** 默认实现:install-truth 共享数据中心(与侧边栏/测试 runner 同一实例,无重复扫描) */
export function createInstallTruthRunDataSource(): RunDataSource {
    return {
        async listPackages(): Promise<string[]> {
            const resolver = resolverOf();
            if (resolver === undefined) {
                return [];
            }
            await resolver.ensureFresh("run.listPackages");
            return resolver.installedPackages() ?? [];
        },
        async executablesOf(pkg: string): Promise<string[]> {
            const resolver = resolverOf();
            if (resolver === undefined) {
                return [];
            }
            return (await resolver.namesOf(pkg)) ?? [];
        },
        async launchFiles(): Promise<LaunchTarget[]> {
            const resolver = resolverOf();
            if (resolver === undefined) {
                return [];
            }
            await resolver.ensureFresh("run.launchFiles");
            const out: LaunchTarget[] = [];
            for (const view of resolver.sidebarSnapshot() ?? []) {
                for (const row of view.rows) {
                    if (row.area !== "share" || row.status !== "installed" || !isLaunchFileName(row.name)) {
                        continue;
                    }
                    out.push({
                        pkg: view.pkg,
                        name: trimLaunchDisplayPrefix(row.name),
                        installPath: row.installPath,
                        sourcePath: row.sourcePath,
                    });
                }
            }
            log.debug(vscode.l10n.t("Launch file inventory: {0} entries", out.length));
            return out;
        },
        async ownersOfSource(srcPath: string): Promise<RunTarget[]> {
            const resolver = resolverOf();
            if (resolver === undefined) {
                return [];
            }
            await resolver.ensureFresh("run.ownersOfSource");
            const owners = await resolver.ownersOfSource(srcPath);
            return (owners ?? []).map((o) => ({ pkg: o.pkg, executable: o.name }));
        },
        async launchFileOfSource(srcPath: string): Promise<LaunchTarget | undefined> {
            const key = normalizeSourceKey(srcPath);
            for (const t of await this.launchFiles()) {
                if (t.sourcePath !== undefined && normalizeSourceKey(t.sourcePath) === key) {
                    return t;
                }
            }
            return undefined;
        },
    };
}

/** 源路径匹配键:分隔符统一 + Windows 大小写不敏感(跳转记录按原样绝对串记录,编辑器 fsPath 形态可能略异) */
function normalizeSourceKey(p: string): string {
    return path.normalize(p).replace(/\\/g, "/").toLowerCase();
}
