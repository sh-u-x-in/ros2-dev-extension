// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file colcon-task-provider.ts(2026-08-31 git mv 自 colcon.ts:旧名过泛,全域皆 colcon,不携带信息)。
 * colcon 任务提供器【实现 + 注册动作】:VS Code 任务系统“响应式解析”机制的实现——仅服务 tasks.json
 * 自定义的 'colcon' 类型任务;扩展自身构建(智能/右键单包)不走本文件。
 * 2026-08-31 23:30 合并:原 register-task-provider.ts(再往前叫 build-tool.ts)整体并入本文件——
 *   该文件仅 3 行有效代码(new ColconProvider() 递交 VS Code),与本文件 1:1 独占,
 *   "provider 实现 + 它的注册动作"本属同一内聚单元(对齐 ros2/host/commands.ts:常量与薄壳同居)。
 *
 * ⚠️ 两种任务机制(勿混淆;2026-08-31 链路收敛 A 后现状):
 *   ① 主动执行(接口):RosTaskRunner.colcon_build —— 扩展自己发起构建,构造 type=“shell” 的
 *      VS Code 任务(shell 是内置类型,无需 provider 解析)后 executeTask;调用方经 composeApi 接口;
 *   ② 响应解析(本文件):VS Code 在执行任意 'colcon' 类型任务【前】,会查找注册在该类型下的
 *      TaskProvider 并调用 resolveTask,把“任务定义”补全成“可执行任务”(契约:返回 vscode.Task)。
 *      典型场景:用户在 .vscode/tasks.json 里手写 {"type": "colcon", ...} 任务——没有本 provider,
 *      该任务无法解析执行(报“任务不存在/无法解析”)。
 *      本 provider 无法被 RosTaskRunner 接口替代:接口是我们【主动调用】的方向,本文件是 VS Code
 *      【回调我们】的方向,二者时机、方向、契约都不同。
 *
 * 2026-08-31(链路收敛 A):makeColconPackageTask 已删;ros-shell.ts 退役(2026-08-31 删除,git 历史可查),resolve 逻辑内联于此;
 * 原 isApplicable(激活时探测 colcon 的重操作)已删除,注册时机由 package-core 门控决定;
 * 全量 colcon test 任务已彻底报废并被 test-provider/RosTestProvider 取代(见 provideTasks 注释)。
 */

import { getLogger } from "../../../logger";
import * as vscode from "vscode";

import { composeApi } from "../../../ros2/api";

/** colcon 任务类型 ID(任务定义 definition.type,与 package.json taskDefinitions.colcon 对应) */
export const COLCON_TASK_TYPE = "colcon";

/**
 * ROS 任务定义(与 package.json taskDefinitions.ROS2 对应):
 * type=任务类型(如 colcon/ROS2),command=执行命令,args=命令行参数。
 */
export interface RosTaskDefinition extends vscode.TaskDefinition {
    name?: string;
    type: string;
    command: string;
    args?: string[];
    /** 自由度扩展(2026-08-31):tasks.json 标准 options 字段——cwd / env(叠加覆盖)/ shell(自定义 shell);原被丢弃,现全放开 */
    options?: {
        /** 执行工作目录(缺省 = 工作区根,与 VS Code 语义一致) */
        cwd?: string;
        /** 附加环境变量,叠加在 ROS 环境之上(同名覆盖) */
        env?: { [key: string]: string };
        /** 自定义 shell 可执行文件(如 bash / pwsh / cmd) */
        shell?: string;
    };
}

/** 扩展日志薄封装(带 colcon-task-provider 模块前缀) */
const log = getLogger("colcon-task-provider");

/**
 * 判定任务定义类型是否为期望类型(definition.type === expectedType)。
 * 供 resolveTask 做解析前的类型过滤(TaskProvider 契约要求:非本类型任务返回 undefined,表示不接管)。
 */
function hasTaskType(task: vscode.Task, expectedType: string): boolean {
    const definition = task.definition as vscode.TaskDefinition | undefined;
    return definition?.type === expectedType;
}

/**
 * colcon 任务提供器:机制②(响应解析)的实现。
 * 服务对象:tasks.json 自定义的 'colcon' 类型任务;扩展自身构建经机制①(RosTaskRunner)不经过本类。
 */
export class ColconProvider implements vscode.TaskProvider {
    /**
     * 枚举本类型全部任务(任务面板自动发现)。返回空数组 = 任务面板不显示任何 colcon 任务;
     * tasks.json 里【显式定义】的 colcon 任务不经过本方法,执行时直接走 resolveTask。
     *
     * ⚠️ TODO 已过期(2026-08-31 核实):旧“全量 colcon test 任务”已【完全报废】,且已被
     *   test-provider/RosTestProvider(VS Code Test Explorer)取代——测试发现/运行走 walk 扫描 +
     *   pytest / 直接运行 gtest 可执行文件(ros-test-runner 不跑 colcon test),
     *   “待重新设计后恢复”的计划作废,本方法维持返回空数组即可。
     */
    public async provideTasks(token?: vscode.CancellationToken): Promise<vscode.Task[]> {
        return [];
    }

    /**
     * 解析 'colcon' 类型任务定义 → 可执行任务(VS Code TaskProvider 契约,返回类型固定为
     * vscode.Task,不可用 RosTaskRunner 接口替代——那是机制①主动执行方向,这里是机制②响应解析方向)。
     *
     * 步骤:① 类型过滤——非 colcon 任务返回 undefined(VS Code 契约:表示本 provider 不接管,
     *   VS Code 继续找其它 provider 或报错)。⚠️ 注意:这与已删除的 isROSBuildTask 无关——
     *   那是【任务结束后】的归属判定(onDidEndTask 过滤,已随 overlay 刷新链改 install/** watcher 移除),
     *   本检查发生在任务【执行前】的解析阶段,是 TaskProvider 的标准防御写法;
     *   ② 补全 command(type 缺省时回退)、保留类型、构造 ShellExecution
     *   (经 composeApi.environment.getEnv() 注入 ROS 环境【默认,用户免手写】;options.cwd → 工作目录;
     *   options.env → 叠加覆盖可改单变量;options.shell → 自定义 shell)、继承 isBackground/problemMatchers。
     */
    public resolveTask(task: vscode.Task, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.Task> {
        if (!hasTaskType(task, COLCON_TASK_TYPE)) {
            log.trace(vscode.l10n.t("Not a colcon task; skipping resolution: {0}", task.name));
            return undefined;
        }

        const definition = task.definition as RosTaskDefinition;
        definition.command = definition.command || definition.type;
        // 解析时保留任务类型(type 缺失时回退为 "ROS2")
        const type = definition.type || "ROS2";
        const args = definition.args || [];
        const resolvedTask = new vscode.Task(
            { ...definition, type },
            vscode.TaskScope.Workspace,
            definition.command,
            definition.command
        );
        // 【自由度升级 2026-08-31】ROS 环境默认注入(用户免手写 AMENT_PREFIX_PATH/PATH 等一整套),
        // 其余 ShellExecutionOptions 全放开:options.cwd → 工作目录;options.env → 叠加覆盖
        // (用户可覆盖单个变量);options.shell → 自定义 shell 可执行文件。
        const userOptions = definition.options;
        resolvedTask.execution = new vscode.ShellExecution(definition.command, args, {
            env: { ...composeApi.environment.getEnv(), ...userOptions?.env },
            cwd: userOptions?.cwd,
            executable: userOptions?.shell,
        });
        resolvedTask.isBackground = task.isBackground;
        resolvedTask.problemMatchers = task.problemMatchers;
        return resolvedTask;
    }
}

/**
 * 注册 colcon 构建任务提供器(注册动作本身,2026-08-31 自 register-task-provider.ts 并入)。
 * 是否注册由 package-core 门控(buildTaskProviderGate.sync)按
 * "环境可用 && (有包 || 允许空构建)"决定,本函数只执行注册并返回可释放的 Disposable。
 * 历史:原"构建工具检测"(determineBuildTool 逐级探测)与 isROSBuildTask(onDidEndTask 归属判定)
 *   均已删除——构建后 overlay 刷新与 compile_commands 合并改由 install/** watcher 驱动
 *   (见 src/ros2/environment/README.md「构建后刷新与 compile_commands 合并」节)。
 */
export function registerBuildTaskProvider(): vscode.Disposable[] {
    log.trace("Registering colcon build task provider");
    return [vscode.tasks.registerTaskProvider(COLCON_TASK_TYPE, new ColconProvider())];
}
