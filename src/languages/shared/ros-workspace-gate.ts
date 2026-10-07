/**
 * ROS 工作区门槛(2026-09-07,补全域共用)
 *
 * 语义:ROS 域代码片段补全(rclpy / rclcpp)只在"当前工作区是 ROS 工作区"时提供——
 * 非 ROS 项目(.py/.cpp 纯普通代码)不弹 ROS 片段(防污染)。
 * 信号 = package-core workspace 域(经 api 门面 getPackageCore):
 *  - null(域未就绪/首扫未完成)→ 乐观放行(true,避免 source 前窗口误哑);
 *  - 非空数组 → 放行(有真包);
 *  - 空数组 → 已扫描但无包 → 非 ROS 工作区,不放行。
 * 不做 env 门槛(工作区源码编辑刻意不依赖 env,见 languages/README 依赖约定)。
 */

import { getPackageCore } from "../../build-tool/package-core/api";

/** 当前工作区是否为 ROS 工作区(含真包或域未就绪) */
export function isRosWorkspace(): boolean {
    const core = getPackageCore();
    if (!core) {
        return false; // 未装配(理论上不会发生:组合根先建 core 再注册语言提供器)
    }
    const ws = core.getState().workspace;
    return ws === null || ws.length > 0;
}
