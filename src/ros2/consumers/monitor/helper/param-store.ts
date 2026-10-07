// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file param-store.ts
 * 参数仓库(2026-10-06 彻底推倒重来,订阅制):结构缓存(param_structure push 填充)+
 * 值缓存(订阅基线 + param push 就地合并保鲜)+ 值取值失败标记(UI 可见,不静默 "—")。
 * 订阅账本在服务端(按连接记);本仓库的 expandedNodes=订阅镜像(客户端侧"展开中"集合),
 * 节点消失又回归时由镜像驱动重订阅。
 */

/** 结构条目(param_structure push 交付形状) */
export interface ParamStructureEntry {
    name: string;
    type: string;
}

export class ParamStore {
    private structures = new Map<string, ParamStructureEntry[]>();
    private values = new Map<string, Record<string, unknown>>();
    private valueErrorNodes = new Set<string>();
    /** 订阅镜像:用户展开(要值)的节点集合(收起 2 秒后由 monitor-api 退订;
     *  **节点消失即清**(用户裁定 2026-10-07:节点回归后 UI 展开态已被清理,不自动保留订阅) */
    private expandedNodes = new Set<string>();

    /** 结构缓存命中 */
    getStructure(node: string): ParamStructureEntry[] | undefined {
        return this.structures.get(node);
    }

    setStructure(node: string, entries: ParamStructureEntry[]): void {
        this.structures.set(node, entries);
        this.valueErrorNodes.delete(node);   // 结构重推=该节点数据面恢复
    }

    /** 值缓存命中(订阅过才有) */
    getValues(node: string): Record<string, unknown> | undefined {
        return this.values.get(node);
    }

    /** 订阅基线入库(整份替换) */
    setValues(node: string, flat: Record<string, unknown>): void {
        this.values.set(node, flat);
    }

    /** param push 入库:值就地合并(在册参数保鲜),deleted 就地摘除 */
    applyParamPush(values: Record<string, Record<string, unknown>>, deleted: Record<string, string[]>): void {
        for (const [node, changed] of Object.entries(values)) {
            const flat = this.values.get(node);
            if (flat) {
                Object.assign(flat, changed);
            }
        }
        for (const [node, names] of Object.entries(deleted)) {
            const flat = this.values.get(node);
            if (flat) {
                for (const name of names) {
                    delete flat[name];
                }
            }
        }
    }

    /** 订阅镜像(展开中节点) */
    isExpanded(node: string): boolean {
        return this.expandedNodes.has(node);
    }

    markExpanded(node: string): void {
        this.expandedNodes.add(node);
    }

    markCollapsed(node: string): void {
        this.expandedNodes.delete(node);
    }

    /** 展开中的节点(图 push 回归时重订阅的遍历口) */
    expandedList(): string[] {
        return [...this.expandedNodes];
    }

    /** 值取值失败标记(F2 沿袭:取值失败必须对 UI 可见,不得静默 "—") */
    markValueError(node: string): void {
        this.valueErrorNodes.add(node);
    }

    clearValueError(node: string): void {
        this.valueErrorNodes.delete(node);
    }

    valueErrors(): string[] {
        return [...this.valueErrorNodes];
    }

    /** 节点消失剪枝(与图同步;展开镜像一并清——节点回归不自动重订阅,用户裁定 2026-10-07) */
    prune(presentFullnames: ReadonlySet<string>): void {
        for (const node of [...this.structures.keys()]) {
            if (!presentFullnames.has(node)) {
                this.structures.delete(node);
            }
        }
        for (const node of [...this.values.keys()]) {
            if (!presentFullnames.has(node)) {
                this.values.delete(node);
            }
        }
        for (const node of [...this.expandedNodes]) {
            if (!presentFullnames.has(node)) {
                this.expandedNodes.delete(node);
            }
        }
    }

    /** 全失效(断线;测试用) */
    invalidateAll(): void {
        this.structures.clear();
        this.values.clear();
        this.expandedNodes.clear();
        this.valueErrorNodes.clear();
    }
}
