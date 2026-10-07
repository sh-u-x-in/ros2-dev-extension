/**
 * xacro 真实样例集成测试(samples/xacro)
 *
 * 策略:用真实样例文件(samples/xacro/robot.urdf.xacro + 完整 include 链)
 *      构建 IncludeGraph,验证扩展 xacro 能力在真实世界文件上可用:
 *      - 5 条 include 全部落地(相对路径,不依赖系统包)
 *      - 宏符号跨文件跳转(主文件 → 子文件宏定义)
 *      - property / arg 符号可解析
 *      - expandOrder 保序(被 include 文件先展开)
 *
 * 意义:单元测试用构造字符串,此测试用真实样例文件做集成验证(补 samples 缺真实文件之短板)。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { IncludeGraph } from "../../src/languages/xacro/core/include-graph";
import { PackageMap } from "../../src/languages/shared/package-map";

/** 最小 mock PackageMap(样例 include 均为相对路径,无需系统包;mesh 引用不影响 include 图) */
function makeMinPkg(): PackageMap {
    const fake = {
        get: (): vscode.Uri | undefined => undefined,
        resolveFileRef: (raw: string, fromUri: vscode.Uri): vscode.Uri | undefined => {
            const rel = raw.trim();
            if (!rel || rel.startsWith("$(") || rel.startsWith("package://")) {
                return undefined;
            }
            return vscode.Uri.file(path.resolve(path.dirname(fromUri.fsPath), rel));
        },
        onDirLoaded: (): { dispose: () => void } => ({ dispose: () => undefined })
    };
    return fake as unknown as PackageMap;
}

const SAMPLES_ROOT = path.resolve(__dirname, "../../../samples/xacro");
const ROBOT_PATH = path.join(SAMPLES_ROOT, "robot.urdf.xacro");
const INCLUDE_RELS = [
    "description/materials.urdf.xacro",
    "description/base.urdf.xacro",
    "description/sensors.urdf.xacro",
    "urdf/base_plate.urdf",
    "config/gazebo.urdf.xacro"
];

/** 收集 samples/xacro 下全部 .xacro/.urdf(作为构建根,模拟工作区全量构建;build 阶段A 只建传入 uris 的节点) */
function collectSampleFiles(): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                walk(p);
            } else if (/\.(xacro|urdf)$/i.test(e.name)) {
                out.push(p);
            }
        }
    };
    walk(SAMPLES_ROOT);
    return out;
}

/** 用全部样例文件构建真实图(所有文件作为根入图,include 边由此解析) */
async function buildSampleGraph(): Promise<IncludeGraph> {
    const graph = new IncludeGraph(makeMinPkg());
    await graph.build(collectSampleFiles().map(f => vscode.Uri.file(f)));
    return graph;
}

describe("xacro 真实样例集成(samples/xacro)", () => {
    it("构建真实 include 链:主文件 5 条 include 全部落地,被包含文件入图", async () => {
        const graph = await buildSampleGraph();
        const robot = graph.getFile(vscode.Uri.file(ROBOT_PATH));
        assert.ok(robot, "主文件应入图");
        assert.strictEqual(robot.includes.length, 5, "应有 5 条 include");
        const okCount = robot.includes.filter(e => e.status === "ok").length;
        assert.strictEqual(okCount, 5, "相对路径 include 应全部落地(ok)");
        for (const rel of INCLUDE_RELS) {
            const u = vscode.Uri.file(path.join(SAMPLES_ROOT, rel));
            assert.ok(graph.getFile(u), `应包含被 include 文件 ${rel}`);
        }
    });

    it("宏符号跨文件跳转:主文件引用子文件宏定义", async () => {
        const graph = await buildSampleGraph();
        const robotUri = vscode.Uri.file(ROBOT_PATH);
        const pos = new vscode.Position(0, 0);
        const macros = [
            "base_macro", "wheel_macro", "laser_macro", "camera_macro",
            "material_rde_blue", "material_rde_dark", "gazebo_diff_drive_macro"
        ];
        for (const name of macros) {
            const def = graph.findSymbol(robotUri, pos, name, "macro");
            assert.ok(def, `宏 ${name} 应可跨文件找到`);
            // Windows 下 fsPath 为反斜杠,用 path.join 生成平台分隔符做包含判断
            assert.ok(def.uri.fsPath.includes(path.join("samples", "xacro")),
                `${name} 应定义在样例子文件:${def.uri.fsPath}`);
        }
    });

    it("property / arg 符号可解析(主文件定义)", async () => {
        const graph = await buildSampleGraph();
        const robotUri = vscode.Uri.file(ROBOT_PATH);
        const robot = graph.getFile(robotUri)!;
        // property/arg 定义在文件前半;用靠后位置(定义之后)查,满足同文件"定义在前"可见性
        const pos = new vscode.Position(Math.max(0, robot.text.split("\n").length - 1), 0);
        for (const name of ["base_length", "base_width", "base_height", "wheel_radius", "wheel_width", "total_mass"]) {
            assert.ok(graph.findSymbol(robotUri, pos, name, "property"), `property ${name} 应可找到`);
        }
        for (const name of ["use_gazebo", "robot_namespace"]) {
            assert.ok(graph.findSymbol(robotUri, pos, name, "arg"), `arg ${name} 应可找到`);
        }
    });

    it("expandOrder 保序:被 include 文件在主文件之前展开", async () => {
        const graph = await buildSampleGraph();
        const robotUri = vscode.Uri.file(ROBOT_PATH);
        const order = graph.expandOrder(robotUri);
        const idxRobot = order.findIndex(u => u.toString() === robotUri.toString());
        assert.ok(idxRobot >= 0, "主文件应在展开序中");
        for (const rel of INCLUDE_RELS) {
            const u = vscode.Uri.file(path.join(SAMPLES_ROOT, rel));
            const idx = order.findIndex(x => x.toString() === u.toString());
            assert.ok(idx >= 0 && idx < idxRobot, `${rel} 应在主文件前展开`);
        }
    });

    // ---------------- XG11 · 语法夹具集成(grammar/,设计/xacro/13 §7 Tier1+Tier2) ----------------

    it("XG11 夹具构建:glob 边枚举(排序)+ ns 边落地(边模型字段)", async () => {
        const graph = await buildSampleGraph();
        const showUri = vscode.Uri.file(path.join(SAMPLES_ROOT, "grammar", "grammar_showcase.urdf.xacro"));
        const node = graph.getFile(showUri);
        assert.ok(node, "XG11 夹具应入图");
        // glob include:parts/*.xacro → 2 条 ok 边(isGlob,sorted)
        const globEdges = node.includes.filter(e => e.isGlob);
        assert.strictEqual(globEdges.length, 2, "glob include 应枚举 2 条边");
        assert.ok(globEdges.every(e => e.status === "ok"));
        assert.deepStrictEqual(
            globEdges.map(e => path.basename(e.target!.fsPath)), ["p_left.xacro", "p_right.xacro"], "sorted 语义");
        // ns include:边携带 ns 字段且落地
        const nsEdge = node.includes.find(e => e.ns !== undefined);
        assert.ok(nsEdge, "应存在 ns= include 边");
        assert.strictEqual(nsEdge.ns, "drv");
        assert.strictEqual(nsEdge.status, "ok");
        assert.ok(graph.getFile(nsEdge.target!), "ns 目标文件应入图");
    });

    it("XG11 夹具符号:宏参数全语法入符号表(params 五形态)", async () => {
        const graph = await buildSampleGraph();
        const showUri = vscode.Uri.file(path.join(SAMPLES_ROOT, "grammar", "grammar_showcase.urdf.xacro"));
        const text = (await import("fs")).readFileSync(showUri.fsPath, "utf8");
        const node = graph.getFile(showUri)!;
        node.symbolsLoaded = false; // 重新收集(夹具可能为新增)
        graph.collectSymbols(node);
        const macro = node.symbols.get("macro")!.get("show_macro");
        assert.ok(macro?.params, "show_macro 应带 params 全语法结果");
        assert.deepStrictEqual(macro.params.map(p => [p.name, p.kind, p.defaultKind]), [
            ["prefix", "scalar", "none"],
            ["name", "scalar", "value"],
            ["scale", "scalar", "forward-or-default"],
            ["*origin", "block", "none"],
            ["**extra", "dict", "none"]
        ]);
        assert.strictEqual(macro.params.find(p => p.name === "scale")?.defaultValue, "1.0", "^| 回退值应保留");
        assert.ok(text.includes("xacro:call macro=\"show_macro\""), "夹具应含动态调用(xacro:call)");
    });
});
