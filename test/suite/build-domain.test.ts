/**
 * build/ 域测试(2026-08-31 #7 补测试)。
 * 依赖 vscode(集成环境 npm test 运行于扩展宿主);测纯函数(resolveInstallType 两轴 / share-spec 展开),
 * 再测 resolver(ColconProvider.resolveTask——构造真 vscode.Task 喂入,验证执行体/定义保留/继承)。
 * 2026-09-22(接线):原 makeConfigItems(四条固定构建配置)已随模板机制下线,改为测 share-spec 的展开结果。
 */

import * as assert from "assert";
import * as vscode from "vscode";

import { ColconProvider, COLCON_TASK_TYPE } from "../../src/build-tool/package-service/build/colcon-task-provider";
import { resolveInstallType } from "../../src/build-tool/package-service/build/install-type";
import { expandColconBuild, readColconBuildSpec } from "../../src/build-tool/package-service/build/share-spec";

describe("build/ share-spec(设置模板 → 命令行)", () => {
    it("未配置时读到出厂默认模板(含命令名与四个变量)", () => {
        const spec = readColconBuildSpec();
        const tpl = spec.template;
        assert.ok(tpl.startsWith("colcon "), `模板应以 colcon 开头:${tpl}`);
        for (const name of ["base_path", "packages_select", "clean", "install_method", "install_layout"]) {
            assert.ok(tpl.includes(`\${${name}}`), `默认模板应含 \${${name}}`);
        }
        assert.strictEqual(spec.argv_list.length, 2, "默认预设 = 详细输出两半");
    });

    it("展开结果:argv[0] 为命令名,含 --base-paths 与选中包;未知占位符为空", () => {
        const r = expandColconBuild({ base_path: "/tmp/ws", packages: ["pkg_a", "pkg_b"], clean: true });
        assert.strictEqual(r.argv[0], "colcon");
        assert.ok(r.argv.includes("--base-paths") && r.argv.includes("/tmp/ws"));
        assert.ok(r.argv.includes("--packages-select") && r.argv.includes("pkg_a") && r.argv.includes("pkg_b"));
        assert.ok(r.argv.includes("--cmake-clean-cache"), "clean 应展开成 --cmake-clean-cache");
        assert.deepStrictEqual(r.unknown, []);
        assert.strictEqual(r.empty, false);
    });

    it("安装两轴来自设置(resolveInstallType),与前瞻检查同源", () => {
        const axes = resolveInstallType();
        const r = expandColconBuild({ base_path: "/tmp/ws" });
        assert.strictEqual(r.argv.includes("--symlink-install"), axes.method === "symlink");
        assert.strictEqual(r.argv.includes("--merge-install"), axes.layout === "merged");
    });
});

describe("build/ ColconProvider.resolveTask(响应式解析)", () => {
    const provider = new ColconProvider();

    it("非 colcon 类型任务 → undefined(不接管,VS Code 继续找其它 provider)", () => {
        const task = new vscode.Task({ type: "shell", command: "echo hi" }, vscode.TaskScope.Workspace, "t", "shell");
        assert.strictEqual(provider.resolveTask(task), undefined);
    });

    it("colcon 定义 → 解析为带 ShellExecution 的任务(定义 command/args 保留、type 保留)", () => {
        const definition = { type: COLCON_TASK_TYPE, command: "colcon", args: ["build", "--packages-select", "pkg_a"] };
        const task = new vscode.Task(definition, vscode.TaskScope.Workspace, "构建", "colcon");
        task.problemMatchers = ["$colcon-gcc"];
        task.isBackground = true;

        const resolved = provider.resolveTask(task) as vscode.Task;
        assert.ok(resolved, "应返回解析后任务");
        // 执行体:ShellExecution(命令/参数原样传入,带 ROS 环境)
        assert.ok(resolved.execution instanceof vscode.ShellExecution, "execution 应为 ShellExecution");
        // 定义保留(command/args 原样,type 保持 colcon)
        const def = resolved.definition as any;
        assert.strictEqual(def.command, "colcon");
        assert.deepStrictEqual(def.args, ["build", "--packages-select", "pkg_a"]);
        assert.strictEqual(def.type, COLCON_TASK_TYPE);
        // 继承 problemMatchers / isBackground
        assert.deepStrictEqual(resolved.problemMatchers, ["$colcon-gcc"]);
        assert.strictEqual(resolved.isBackground, true);
    });
});

describe("build/ resolveInstallType(安装方式决策)", () => {
    // 2026-09-22 修正:本条原断言 `resolveInstallType() === "merge"` 是 2026-09-16 拆轴前的形态
    // (既返回三选一字符串);拆轴后返回 { method, layout } 两轴对象,原断言在 win32 上必失败。
    // 现按两轴断言:形状恒定 + 平台硬覆盖(win32 恒 copy);布局不再硬断言(由
    // ROS2.build.installLayout 决定,auto = win32 合并 / 其余分包)。
    it("返回 { method, layout } 两轴组合(不再是三选一字符串)", () => {
        const install = resolveInstallType();
        assert.ok(["symlink", "copy"].includes(install.method), `method 非法:${install.method}`);
        assert.ok(["merged", "isolated"].includes(install.layout), `layout 非法:${install.layout}`);
    });

    it("win32:形态恒为 copy(符号链接需管理员权限/开发者模式,平台硬覆盖)", function () {
        if (process.platform !== "win32") {
            this.skip(); // 非 win 的形态依赖 ROS2.build.installMethod 配置,不作硬断言
        }
        assert.strictEqual(resolveInstallType().method, "copy");
    });
});
