// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros-task-runner.ts
 * RosTaskRunner 接口定义(A9 任务终端:主动执行,非纯消费者)。
 * 接口定义占位(接口集中 api/,2026-08-25);实现后续接入:
 *   - 实现:src/ros2/commands/ros_task_runner.ts(纯函数得命令 → 构造 vscode.Task → executeTask)
 * 与 Ros2ServiceApi 分工:执行类只在 RosTaskRunner 一处,Ros2ServiceApi 只保留查询/状态。
 * 参数类型(ColconBuildOptions / Ros2RunOptions / Ros2LaunchOptions 等)与接口同文件集中,实现不得本地重定义。
 */

/** colcon 安装形态(轴 1):符号安装(--symlink-install)/ 实体安装(copy,复制文件,默认) */
export type ColconInstallMethod = "symlink" | "copy";

/** colcon 安装布局(轴 2):合并安装(--merge-install,单前缀 install/)/ 分包安装(isolated,每包 install/<包名>/,colcon 默认) */
export type ColconInstallLayout = "merged" | "isolated";

/**
 * colcon 安装方案 = 两个正交轴的组合(2026-09-16 拆轴;与 colcon CLI 一一对应,可同时给 flag):
 *  - 形态 method:`--symlink-install` ↔ 不加(实体,复制);
 *  - 布局 layout:`--merge-install` ↔ 不加(分包,即 .colcon_install_layout 的 isolated)。
 */
export interface ColconInstallType {
    readonly method: ColconInstallMethod;
    readonly layout: ColconInstallLayout;
}

/** colcon_build 参数 */
export interface ColconBuildOptions {
    /** 工作区根(任务 cwd) */
    base_path: string;
    /**
     * **预展开的整条命令行(含命令名)**:扩展发起的构建一律由 `build/share-spec.ts` 按设置里的模板
     * (`ROS2.build.shareSpec`)展开后传入;`colcon_build` 只执行 —— `argv[0]` 即命令名,其余为参数
     * ⇒ 命令内容 100% 由模板决定(本层不认识模板、预设、记忆,也不做任何命令拼装)。
     */
    argv: string[];
    /** 选中的包:**仅用于任务名与日志**;命令里选不选包由模板的 `${packages_select}` 决定 */
    packages?: string[];
}

/**
 * ros2_run 参数(2026-09-25 重设计:对齐 `ColconBuildOptions.argv` 模式 ——
 * 调用方(`run/share-spec.ts`)按设置模板展开整条 argv,本层只执行,不拼装、不兜底)。
 */
export interface Ros2RunOptions {
    /** **预展开的整条命令行(含命令名)**:`argv[0]` 即命令名(通常是 `ros2`),其余为参数 */
    argv: string[];
    /** 任务 cwd(缺省由调用方给工作区根;不传则交给 VS Code 任务默认) */
    cwd?: string;
    /** 包名(**仅用于任务名与日志**;命令内容只由 argv 决定) */
    pkg?: string;
    /** 可执行名(**仅用于任务名与日志**) */
    executable?: string;
}

/**
 * ros2_launch 参数(2026-09-25 重设计:同 `Ros2RunOptions` 的 argv 模式)。
 */
export interface Ros2LaunchOptions {
    /** **预展开的整条命令行(含命令名)** */
    argv: string[];
    /** 任务 cwd(缺省由调用方给工作区根) */
    cwd?: string;
    /** 包名(**仅用于任务名与日志**) */
    pkg?: string;
    /** launch 文件名(**仅用于任务名与日志**) */
    launch_file?: string;
}

/** A9 任务终端执行接口(构造 VS Code Task + ShellExecution + executeTask,与用户交互终端完全分隔) */
export interface RosTaskRunner {
    /** colcon build 任务(动态注入包名/路径) */
    colcon_build(opts: ColconBuildOptions): Promise<void>;
    /** ros2 doctor(任务终端执行;2026-09-29 argv = 设置命令串切词,缺省走内置 toDoctorCommand) */
    doctor(opts?: { argv?: string[] }): Promise<void>;
    /** rosdep install(任务终端执行;argv 同上;workspace 仅内置串用) */
    rosdep(opts?: { workspace?: string; argv?: string[] }): Promise<void>;
    /** ros2 run 任务终端(2026-09-25 重设计:调用方按模板展开整条 argv,本层只执行;含环境门槛) */
    run(opts: Ros2RunOptions): Promise<void>;
    /** ros2 launch 任务终端(2026-09-25 重设计:同 run 的 argv 模式) */
    launch(opts: Ros2LaunchOptions): Promise<void>;
}
