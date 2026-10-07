// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file classify.ts
 * 图数据分类纯函数(2026-10-06 重设计阶段 2 自助手 Python 迁入):
 * 助手交原始服务清单(动作三件套不剥离),分类/成组全在扩展侧做——
 * 数据整形归 TS,赚 npm test 可测性;Python 侧不再知道"动作"这个概念。
 * (2026-10-07 墓碑:生命周期发现 detectLifecycleNodes 已删——彻底推倒重来协议下
 * 名单由服务端随图推送并收敛为独一份,客户端不再需要同款判据。)
 */

/**
 * 动作三服务特征(名字后缀 → 类型后缀)。
 * 修正记录:cancel_goal 类型后缀原表作 "_CancelGoal"(旧 ops_graph/kernel 同误),而真实
 * 类型恒为 action_msgs/srv/CancelGoal(无下划线)——旧实现从未把 cancel_goal 聚合进动作
 * (动词缺 cancel + 服务清单漏出一条);2026-10-06 迁移单测抓获,顺势修正。
 */
const ACTION_SERVICE_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
    ["/_action/send_goal", "_SendGoal"],
    ["/_action/cancel_goal", "CancelGoal"],
    ["/_action/get_result", "_GetResult"],
];

/** 原始服务条目(线上形状:type 为逗号空格连接的多类型串) */
export interface RawService {
    name: string;
    type: string;
}

/** 分离结果:普通服务清单(动作三件套已摘出)+ 聚合后的动作清单 */
export interface SeparatedActions {
    services: RawService[];
    actions: { name: string; type: string; verbs: string[] }[];
}

/**
 * 从原始服务清单分离动作(2026-10-07 用户裁定:两段式判定)。
 *
 * 引子(逐个判定):每条服务独立过"名字后缀+类型后缀"双判据(防误伤名字带 _action 的
 * 普通服务),命中的按动作名归堆记动词;类型只从 send_goal/get_result 取(剥后缀结果
 * 恒相同;cancel_goal 的类型是通用 action_msgs/srv/CancelGoal,不带动作真名——
 * DDS 顺序随机时它排前会把类型污染成残串 action_msgs/srv/,F5 实测表单内省必败)。
 *
 * 总判定:**三件齐备(send_goal/cancel_goal/get_result 动词全在)才算动作**——
 * 残缺集(启动竞态/恰好撞名)不判为动作,其服务回归普通服务清单;防止残缺通过。
 */
export function separateActions(raw: readonly RawService[]): SeparatedActions {
    const REQUIRED_VERBS = ["send_goal", "cancel_goal", "get_result"];
    const services: RawService[] = [];
    const candidates = new Map<string, { type: string; verbs: Set<string>; services: RawService[] }>();

    // 引子:逐个判定,命中的按动作名归堆
    for (const svc of raw) {
        const types = svc.type.split(", ").filter(Boolean);
        let matched: { suffix: string; typeSuffix: string; fullType: string } | undefined;
        for (const t of types) {
            for (const [suffix, typeSuffix] of ACTION_SERVICE_SUFFIXES) {
                if (svc.name.endsWith(suffix) && t.endsWith(typeSuffix)) {
                    matched = { suffix, typeSuffix, fullType: t };
                    break;
                }
            }
            if (matched) {
                break;
            }
        }
        if (!matched) {
            services.push(svc);
            continue;
        }
        const actionName = svc.name.slice(0, svc.name.length - matched.suffix.length);
        let entry = candidates.get(actionName);
        if (!entry) {
            entry = { type: "", verbs: new Set(), services: [] };
            candidates.set(actionName, entry);
        }
        if (matched.suffix !== "/_action/cancel_goal" && !entry.type) {
            entry.type = matched.fullType.slice(0, matched.fullType.length - matched.typeSuffix.length);
        }
        entry.verbs.add(matched.suffix.split("/").pop() ?? "");
        entry.services.push(svc);
    }

    // 总判定:三件齐备才算动作;残缺集的服务原样回归普通服务清单
    const actions: { name: string; type: string; verbs: string[] }[] = [];
    for (const [name, entry] of candidates) {
        const complete = REQUIRED_VERBS.every((v) => entry.verbs.has(v));
        if (complete) {
            actions.push({ name, type: entry.type, verbs: [...entry.verbs].sort() });
        } else {
            services.push(...entry.services);
        }
    }
    actions.sort((a, b) => a.name.localeCompare(b.name));
    return {
        services,
        actions,
    };
}
