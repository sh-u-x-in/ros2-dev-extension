// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros2-service-api.ts
 * Ros2ServiceApi 接口定义(命令域:查询/状态类,返回结构化数据)。
 * 接口定义占位(接口集中 api/,2026-08-25);实现后续接入:
 *   - 实现:src/ros2/commands/ros2_service_api.ts(吸收旧 ros2.ts/lifecycle/params/daemon)
 * 执行类(colcon_build/run/launch/doctor/rosdep)归 RosTaskRunner(api/ros-task-runner.ts),此处不重复。
 */

/** colcon list 返回的包条目 */
export interface PackageEntry {
    name: string;
    path: string;
}
/** 生命周期状态 */
export interface LifecycleState {
    id: number;
    label: string;
}

/**
 * 命令查询/状态接口(需求 B;依赖 CommandRunner + EnvironmentState)。
 *
 * ⚠️ 错误契约(2026-09-01 定稿,取代"失败折叠为空值"):
 *   - 查询类(9 个):失败 → resolve **null**(绝不抛、绝不 undefined);成功 → 真实值(数组/串/状态,可为空)。
 *     null = 失败(无结果);[]/"" = 成功但空(真实空数据)——二者不再相撞。
 *   - 操作类(lifecycle_set):失败 → reject 上抛(调用方必须知情)。
 */
export interface Ros2ServiceApi {
    // ── 包/接口查询(失败 → null)──
    pkg_list(opts?: {}): Promise<string[] | null>;
    pkg_prefix(opts: { name: string; shared?: boolean }): Promise<string | null>;
    pkg_executables(opts: { name: string }): Promise<string[] | null>;
    pkg_executables_full(opts: { name: string }): Promise<string[] | null>;
    interface_list(opts?: {}): Promise<string[] | null>;
    // ── 参数(失败 → null)──
    param_list(opts: { node: string }): Promise<string[] | null>;
    param_get(opts: { node: string; param: string }): Promise<string | null>;
    // ── 生命周期(查询失败/未知状态 → null;lifecycle_set 失败 → reject)──
    lifecycle_nodes(opts?: {}): Promise<string[] | null>;
    lifecycle_get(opts: { node: string }): Promise<LifecycleState | null>;
    /** transition=转换标签(configure/activate/cleanup/shutdown;重设计阶段 2 自数字 id 改标签:
     *  `ros2 lifecycle set <node> <label>`,拒绝=非零退出码,2026-10-06 VM 实机验证) */
    lifecycle_set(opts: { node: string; transition: string }): Promise<void>;
    // ── colcon 查询(失败 → null)──
    colcon_list(opts?: { base_path?: string; packages_only?: boolean }): Promise<PackageEntry[] | null>;
}
