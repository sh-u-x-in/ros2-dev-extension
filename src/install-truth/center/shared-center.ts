// Licensed under the MIT License.

/**
 * @file shared-center.ts
 * **按工作区根共享**的 build-map 数据中心(2026-09-24 起;2026-09-30 去 watcher 化)。
 *
 * ① **共享**(2026-09-24):侧边栏与测试 runner 过去各自 `new` 一份 `BuildMapCenter`
 *    ⇒ 双份全量扫描 + 双份缓存,两份新鲜度互不相干;现按根单例,一份中心供全部消费方。
 *
 * ② **失效源演变**:
 *    - 2026-09-24~2026-09-29:`BUILD_WATCH_PATTERNS` 9 组 build 产物 watcher(27 订阅)
 *      只置脏 + `onBuildTouch` 反解包名广播 —— 2026-09-30 **整体退役**
 *      (`BuildMapTrigger` 的结束信号自 2026-09-13 建档起零调用,已按零引用清理);
 *    - 2026-09-30 起(手工重设计/13):失效源 = 环境域构建信号
 *      (`environmentFacade.onBuildSignal` → extension.ts → `center.refreshAfterBuildSignal()`,
 *      rc-mtime 增量门主动刷新),包级感知走 `center.onPackagesChanged`(逐包指纹差分)。
 *    本模块因此**不再依赖 vscode watcher**;保留 vscode 间接依赖的仅剩日志与生命周期约定,
 *    但为维持"按路径直连、不进 api 桶"的既有消费纪律,文件位置不动。
 *
 * 消费方照旧:查询即读快照(懒首扫兜底),推送只负责"变新鲜"。
 */

import { l10n } from "vscode";

import { BuildMapCenter } from "./build-map-center";
// 直接注入真实 fs 构造中心(不绕 `../api` 桶:那是给外部消费方的出口,这里同在 install-truth 内部)
import { nodeFsLike } from "../shared/fs/primitives";
import { getLogger } from "../../logger";

const log = getLogger("install-truth-watch");

/** 共享实例的对外形态 */
export interface SharedBuildCenter {
    readonly center: BuildMapCenter;
}

interface Entry {
    root: string;
    center: BuildMapCenter;
}

/** 当前共享实例(按工作区根;换根时先释放旧的) */
let current: Entry | undefined;

/** 取(必要时建)该工作区根共享的数据中心 */
export function acquireSharedBuildCenter(workspaceRoot: string): SharedBuildCenter {
    if (current !== undefined && current.root !== workspaceRoot) {
        disposeSharedBuildCenter();
    }
    if (current === undefined) {
        current = createEntry(workspaceRoot);
    }
    return { center: current.center };
}

/** 释放共享实例(扩展停用 / 换根) */
export function disposeSharedBuildCenter(): void {
    if (current === undefined) {
        return;
    }
    current.center.dispose();
    log.debug(l10n.t("Shared build-map center released: {0}", current.root));
    current = undefined;
}

function createEntry(workspaceRoot: string): Entry {
    const center = new BuildMapCenter({ workspaceRoot: workspaceRoot, fs: nodeFsLike });
    log.info(l10n.t("Shared build-map center ready: {0} (event-driven: build signals trigger incremental refresh; queries as fallback)", workspaceRoot));
    return { root: workspaceRoot, center: center };
}
