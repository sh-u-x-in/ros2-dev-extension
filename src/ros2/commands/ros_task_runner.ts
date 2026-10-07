// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

/**
 * @file ros_task_runner.ts
 * 实现 RosTaskRunner 接口(api/ros-task-runner.ts,需求 A9 任务终端:主动执行)。
 * 设计(API-SURFACE §3.1):
 *   - 纯函数(toRos2RunCommand 等):「参数 → 命令行」零 vscode 依赖,可纯单测;
 *   - 薄执行壳:纯函数得命令 → 经 host/tasks.runShellTask 构造 vscode.Task + ShellExecution + executeTask
 *     (VS Code 集成任务终端,与用户交互终端完全分隔;取代旧 A7 sendText 注入)。
 * env 由 ShellExecution 经 environment.getEnv() 实时注入(非快照)。
 * 与 Ros2ServiceApi 分工:执行类只在 RosTaskRunner 一处,查询/状态归 Ros2ServiceApi。
 * ROS1 遗留(roscore/roslaunch 模板任务)不在此接口内(2026-08-24 定稿)。
 * 2026-08-31(#12):colcon_build 加环境门槛(getEnvIssue() 唯一判定,不满足 → UI 提示不启动终端);
 *   doctor 豁免(诊断工具)。
 * 2026-09-22(模板接线):**colcon_build 不再拼装任何命令** —— 调用方(`build/share-spec.ts`)按设置里的
 *   模板展开成整条 argv 传进来,本层 `argv[0]` 作命令名、其余作参数(命令名本身也可被用户改成别的命令)。
 * 2026-09-25(run 域接线):**run/launch 同样收成"只执行 argv"**(`Ros2RunOptions` / `Ros2LaunchOptions`,
 *   对齐 colcon_build 模式)—— 旧 `toRos2RunCommand`/`toRos2LaunchCommand` 已删除,命令拼装迁往
 *   `build-tool/package-service/run/`;本层补齐 #12 环境门槛(运行场景 env 仍用含 overlay 的 `getEnv()`)。
 */

import { l10n } from "vscode";

import { getLogger } from "../../logger";
import { getBuildEnv, getEnv, environmentState } from "../environment";
import { runShellTask } from "../host/tasks";
import { showErrorMessage } from "../host/window";

import type { ColconBuildOptions, ColconInstallType, Ros2LaunchOptions, Ros2RunOptions, RosTaskRunner } from "../api/ros-task-runner";

/** ros-task-runner 模块日志 */
const log = getLogger("ros-task-runner");

/* ================================================================== */
/* 纯函数:「参数 → 命令行」(零 vscode 依赖,可纯单测)                    */
/* ================================================================== */

/**
 * install_type(两轴组合)→ colcon 安装参数:
 *  - 形态 symlink → --symlink-install(copy → 不加);
 *  - 布局 merged → --merge-install(isolated → 不加;分包是 colcon 默认,无参数)。
 *  两轴可叠加(symlink+merged → 两个 flag);返回值可能为空数组(实体+分包)。
 *  ⚠️ 扩展**自己的**构建不走这里:命令由设置模板展开(build/share-spec.ts)。本函数是给
 *  ros-test-runner 之类的调用方做"两轴 → flag"翻译用的。
 */
export function toInstallTypeFlags(installType: ColconInstallType): string[] {
    const flags: string[] = [];
    if (installType.method === "symlink") {
        flags.push("--symlink-install");
    }
    if (installType.layout === "merged") {
        flags.push("--merge-install");
    }
    return flags;
}

/** rosdep install 命令行:rosdep install --from-paths <src|workspace> --ignore-src -r -y */
export function toRosdepCommand(opts?: { workspace?: string }): string[] {
    const fromPath = opts?.workspace ?? "src";
    return ["install", "--from-paths", fromPath, "--ignore-src", "-r", "-y"];
}

/** ros2 doctor 命令行 */
export function toDoctorCommand(): string[] {
    return ["doctor"];
}

/* ================================================================== */
/* 薄执行壳:构造 vscode.Task + ShellExecution + executeTask             */
/* ================================================================== */

/** colcon build 任务终端(动态注入包名/路径;失败 reject 上抛) */
async function colcon_build(opts: ColconBuildOptions): Promise<void> {
    // #12 环境门槛(2026-08-31):getEnvIssue() 返回不可用原因(可用 → null),已涵盖全部"无可用环境"情形——
    // ① 未成功 source(getEnv() undefined)/ ② source 失败 / ③ 环境非 ROS 2(ROS_DISTRO 未知或 ROS_VERSION 空);
    // 不满足 → UI 明确提示(附具体原因),不启动注定失败的构建终端。doctor 豁免(诊断工具,无环境也要能跑)。
    const envIssue = environmentState.getEnvIssue();
    if (envIssue !== null) {
        showErrorMessage(l10n.t("No usable ROS 2 environment detected; cannot build. Reason: {0}. Configure and activate a ROS environment (ROS2.rosSetupScript / ROS2.pixiRoot) first, then retry.", envIssue));
        return;
    }
    // 命令来源(2026-09-22 接线):调用方(build/ 的模板引擎)按设置展开成整条 argv 传进来 ——
    // 命令名与参数都在里面,本层只执行。空 argv = 模板展开为空(配置问题)⇒ 明确报错,不启动终端。
    if (opts.argv.length === 0) {
        showErrorMessage(l10n.t("Build command expanded to empty; cancelled. Check the template in setting ROS2.build.shareSpec."));
        return;
    }
    // 命令内容完全由调用方(模板引擎)给:本层只做"执行",不拼装、不兜底、不认识模板/预设/记忆。
    const argv = opts.argv;
    const [command, ...args] = argv;
    const packageCount = opts.packages?.length ?? 0;
    const name = l10n.t("Build{0}", packageCount > 0 ? l10n.t(" ×{0}", packageCount) : "");
    log.debug(`${name}:${argv.join(" ")}`);
    // 2026-09-22:**构建用 getBuildEnv()**(= 快照剔除本工作区自身条目),不再用 getEnv():
    //  · 本工作区自己的 install 不是构建的输入;带进来只会触发 colcon-override-check 的"自我覆盖"警告;
    //  · 更实际:旧 install 可能参与 include/依赖解析,或让"实体↔符号"切换静默无效(知识文档 §2.2/§6.3);
    //  · 运行/调试(ros2 run/launch/doctor/rosdep)仍用 getEnv()——那些场景需要 overlay。
    await runShellTask(name, command, args, {
        cwd: opts.base_path,
        env: getBuildEnv(),
        problemMatchers: ["$colcon-gcc"],
    });
}

/** ros2 doctor 任务终端(诊断工具:#12 环境门槛【豁免】——无环境时恰恰需要它诊断问题所在)。
 *  2026-09-29:argv(设置命令串切词,注册层传入)优先;argv[0] 为命令名(通常 ros2,可整条替换) */
async function doctor(opts?: { argv?: string[] }): Promise<void> {
    const argv = opts?.argv && opts.argv.length > 0 ? opts.argv : ["ros2", ...toDoctorCommand()];
    const [command, ...args] = argv;
    await runShellTask("ROS2 Doctor", command, args, { env: getEnv() });
}

/** rosdep install 任务终端(#12 环境门槛:rosdep 依赖 env 的 ROS_DISTRO——toRosdepCommand 未传 --rosdistro) */
async function rosdep(opts?: { workspace?: string; argv?: string[] }): Promise<void> {
    const envIssue = environmentState.getEnvIssue();
    if (envIssue !== null) {
        showErrorMessage(l10n.t("No usable ROS 2 environment detected; cannot install dependencies (rosdep needs ROS_DISTRO). Reason: {0}. Configure and activate a ROS environment first, then retry.", envIssue));
        return;
    }
    // 2026-09-29:argv(设置命令串切词,注册层传入)优先;缺省走内置 toRosdepCommand
    const argv = opts?.argv && opts.argv.length > 0 ? opts.argv : ["rosdep", ...toRosdepCommand(opts)];
    const [command, ...args] = argv;
    await runShellTask("rosdep install", command, args, { env: getEnv() });
}

/**
 * ros2 run 任务终端(2026-09-25 重设计:对齐 colcon_build —— 调用方(`run/share-spec.ts`)按设置里的
 * 模板(`ROS2.run.shareSpec`)展开成整条 argv 传进来,本层只执行:环境门槛 → 空 argv 拒绝 → 任务壳。
 * 运行场景用 `getEnv()`(含本工作区 overlay —— 运行就是要跑自己刚构建的产物)。
 */
async function run(opts: Ros2RunOptions): Promise<void> {
    const target = [opts.pkg, opts.executable].filter((s) => s !== undefined && s !== "").join(".");
    const name = target !== "" ? l10n.t("Run {0}", target) : l10n.t("Run");
    await executeRunArgv(opts.argv, opts.cwd, name, "ROS2.run.shareSpec");
}

/**
 * ros2 launch 任务终端(2026-09-25 重设计:同 run 的 argv 模式)。
 */
async function launch(opts: Ros2LaunchOptions): Promise<void> {
    const target = [opts.pkg, opts.launch_file].filter((s) => s !== undefined && s !== "").join("/");
    // 只取文件名尾段(包名/嵌套路径不上终端名——命令内容就在终端里,不丢信息)
    const fileName = target !== "" ? target.split("/").pop()! : "";
    const name = fileName !== "" ? l10n.t("Launch {0}", fileName) : l10n.t("Launch");
    await executeRunArgv(opts.argv, opts.cwd, name, "ROS2.launch.shareSpec");
}

/** run/launch 共用执行底座:环境门槛(#12 唯一判定)→ 空 argv 拒绝 → runShellTask(getEnv) */
async function executeRunArgv(argv: string[], cwd: string | undefined, name: string, settingKey: string): Promise<void> {
    // #12 环境门槛(与 colcon_build 同一判定;运行没有环境同样注定失败,且 ros2 不在 PATH)
    const envIssue = environmentState.getEnvIssue();
    if (envIssue !== null) {
        showErrorMessage(l10n.t("No usable ROS 2 environment detected; cannot execute. Reason: {0}. Configure and activate a ROS environment (ROS2.rosSetupScript / ROS2.pixiRoot) first, then retry.", envIssue));
        return;
    }
    // 命令来源(模板接线):调用方按设置展开成整条 argv —— 本层只执行,不拼装、不兜底。
    if (argv.length === 0) {
        showErrorMessage(l10n.t("Command expanded to empty; cancelled. Check the template in setting {0}.", settingKey));
        return;
    }
    const [command, ...args] = argv;
    log.debug(`${name}:${argv.join(" ")}`);
    await runShellTask(name, command, args, { cwd, env: getEnv() });
}

/** RosTaskRunner 实现对象(组合根注入用;接口定义在 api/ros-task-runner.ts) */
export const rosTaskRunner: RosTaskRunner = {
    colcon_build,
    doctor,
    rosdep,
    run,
    launch,
};
