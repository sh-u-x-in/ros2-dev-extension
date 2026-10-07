// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file graph-store.ts
 * 本地图仓库(2026-10-06 彻底推倒重来终态:**纯持有者**)。
 * 数据真相=服务端;图一变服务端推全量(graph push),resync 回应也带全量——
 * 本仓库只做"收下即整仓替换",无增量无版本号无对账机器(git 式 clone+fetch
 * 的整套贴补/失配/对账时效随增量协议退役)。节点=全名一列(_ros2cli 已滤)。
 */

/** 图全量快照(resync 回应 data / graph push 同形状) */
export interface GraphSnapshot {
    nodes: string[];
    topics: Record<string, string>;
    services: Record<string, string>;
    lifecycle: string[];
}

export class GraphStore {
    private snap: GraphSnapshot | undefined;

    /** 是否有可用快照 */
    get valid(): boolean {
        return this.snap !== undefined;
    }

    /** 当前视图(纯推送架构的投影读数) */
    view(): GraphSnapshot | undefined {
        return this.snap;
    }

    /** 全量建档/重同步(整仓替换) */
    applyFull(s: GraphSnapshot): void {
        this.snap = {
            nodes: s.nodes, topics: s.topics, services: s.services, lifecycle: s.lifecycle,
        };
    }

    /** 失效(断线)——下次 resync 重建 */
    invalidate(): void {
        this.snap = undefined;
    }
}
