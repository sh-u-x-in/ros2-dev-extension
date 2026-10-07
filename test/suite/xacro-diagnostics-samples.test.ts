/**
 * xacro 语法模块 · 补强（零误报护栏 + 包引用/环/光标上下文/图健壮性）
 *
 * 目标模块：src/languages/xacro/（diagnostic-provider、include-graph、context-locator、xml-utils）
 * 层级：L1/L2（依赖 vscode.Uri / TextDocument → 集成环境 npm test 验证）
 * 关联测试项：X1–X6（方案 04 §3）
 *
 * 策略：
 *  - X1 零误报护栏：samples/xacro 全真文件无 include 环（诊断 error 仅由环产生）→ 等价 0 error
 *  - X2 包引用判定/提取（纯函数）
 *  - X3 环检测：构造 A→B→A 环应检出；samples 无环不误报
 *  - X4 光标上下文 / 属性定位（真文件）
 *  - X5 图构建对 package:// mesh 引用不崩
 *  - X6 property 符号解析（真文件覆盖链）
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { IncludeGraph } from "../../src/languages/xacro/core/include-graph";
import { PackageMap } from "../../src/languages/shared/package-map";
import { isPackageRef, extractPkg, findIncludeCycleThrough } from "../../src/languages/xacro/ui/diagnostic-provider";
import { parseXacroDocument } from "../../src/languages/xacro/parse/xacro-document";
import { SUBST_COMMANDS } from "../../src/languages/xacro/parse/xacro-tags";
import { getCursorContext } from "../../src/languages/xacro/parse/context-locator";
import { parseXml, attrAtCursor } from "../../src/languages/shared/xml-utils";

/** 最小 mock PackageMap（样例 include 均为相对路径，无需系统包；mesh 引用不影响 include 图） */
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

/** 收集 samples/xacro 下全部 .xacro/.urdf */
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

/** 用全部样例文件构建真实图 */
async function buildSampleGraph(): Promise<IncludeGraph> {
    const graph = new IncludeGraph(makeMinPkg());
    await graph.build(collectSampleFiles().map((f) => vscode.Uri.file(f)));
    return graph;
}

describe("xacro 补强(samples/xacro)", function () {
    this.timeout(30000);

    // ---------------- X1 · 零误报护栏 ----------------
    it("X1 全部真文件 → 无 include 环（诊断 error 来源）", async () => {
        const graph = await buildSampleGraph();
        for (const f of collectSampleFiles()) {
            const uri = vscode.Uri.file(f);
            assert.strictEqual(
                findIncludeCycleThrough(graph, uri), undefined,
                `${path.basename(f)} 不应处于 include 环中`
            );
        }
    });

    // ---------------- X7(XG9)· 词法级 0-error 护栏 ----------------
    it("X7 全部真文件 → 无未闭合 ${/$((D8,Error 级)与未知 $() 命令(D9)", async () => {
        for (const f of collectSampleFiles()) {
            const text = fs.readFileSync(f, "utf8");
            const doc = parseXacroDocument(text, vscode.Uri.file(f));
            const unclosed = doc.dollarIssues.filter(i => i.kind === "unclosed-expr" || i.kind === "unclosed-extension");
            assert.deepStrictEqual(unclosed, [], `${path.basename(f)} 不应有未闭合 $ 构造`);
            for (const seg of doc.dollarSegments) {
                for (const tok of seg.res.tokens) {
                    if (tok.kind === "extension") {
                        const cmd = /^\s*([A-Za-z_][A-Za-z0-9_-]*)/.exec(tok.content)?.[1];
                        if (cmd) {
                            assert.ok(SUBST_COMMANDS.has(cmd), `${path.basename(f)}:$(${cmd} …) 应为已知命令`);
                        }
                    }
                }
            }
        }
    });

    // ---------------- X2 · 包引用判定/提取 ----------------
    it("X2 isPackageRef / extractPkg 判定与包名提取正确", () => {
        assert.strictEqual(isPackageRef("$(find rde_ros_2)/samples/xacro/meshes/..."), true);
        assert.strictEqual(isPackageRef("package://pkg/foo.urdf"), true);
        assert.strictEqual(isPackageRef("$(find-pkg-share rclcpp)/..."), true);
        assert.strictEqual(isPackageRef("relative/file.urdf"), false);
        assert.strictEqual(extractPkg("$(find rde_ros_2)/samples/xacro/meshes/..."), "rde_ros_2");
        assert.strictEqual(extractPkg("package://pkg/foo.urdf"), "pkg");
        assert.strictEqual(extractPkg("$(find-pkg-share rclcpp)/share/..."), "rclcpp");
    });

    // ---------------- X3 · 环检测 ----------------
    it("X3 构造 A→B→A 环应检出；samples 无环不误报", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rde-xacro-cycle-"));
        try {
            const a = path.join(tmp, "a.urdf.xacro");
            const b = path.join(tmp, "b.urdf.xacro");
            fs.writeFileSync(a, '<robot><xacro:include filename="b.urdf.xacro"/></robot>', "utf-8");
            fs.writeFileSync(b, '<robot><xacro:include filename="a.urdf.xacro"/></robot>', "utf-8");
            const graph = new IncludeGraph(makeMinPkg());
            await graph.build([vscode.Uri.file(a), vscode.Uri.file(b)]);
            const cycle = findIncludeCycleThrough(graph, vscode.Uri.file(a));
            assert.ok(cycle && cycle.length >= 2, `应检出环，实际 ${JSON.stringify(cycle)}`);
        } finally {
            try {
                fs.rmSync(tmp, { recursive: true, force: true });
            } catch { /* 忽略清理失败 */ }
        }
        // samples 无环（X1 已断言，此处复验主文件）
        const graph = await buildSampleGraph();
        assert.strictEqual(findIncludeCycleThrough(graph, vscode.Uri.file(ROBOT_PATH)), undefined);
    });

    // ---------------- X4 · 光标上下文 / 属性定位 ----------------
    it("X4 getCursorContext / attrAtCursor 在 robot.urdf.xacro 上分类正确", async () => {
        const doc = await vscode.workspace.openTextDocument(ROBOT_PATH);
        const text = doc.getText();
        // 定位 <xacro:include filename="..."> 行
        let includeLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.includes("xacro:include")) {
                includeLine = i;
                break;
            }
        }
        assert.ok(includeLine >= 0, "应找到 xacro:include 行");
        const lineText = doc.lineAt(includeLine).text;
        const filenameIdx = lineText.indexOf('filename="');
        assert.ok(filenameIdx >= 0, "include 应有 filename 属性");
        // 光标在 filename 属性值上 → role=attrValue, attrName=filename
        const inValue = getCursorContext(doc, new vscode.Position(includeLine, filenameIdx + 'filename="'.length + 1));
        assert.strictEqual(inValue.role, "attrValue");
        assert.strictEqual(inValue.attrName, "filename");
        // attrAtCursor：offset 在属性名内部（filenameIdx+1 避开 lezer 节点起始边界歧义）应定位到 filename 属性
        const offset = doc.offsetAt(new vscode.Position(includeLine, filenameIdx + 1));
        const attr = attrAtCursor(parseXml(text), text, offset);
        assert.ok(attr, "attrAtCursor 应定位到属性");
        assert.strictEqual(attr!.attrName, "filename");
        // 补充:offset 在属性值引号内 → 应定位到 filename 且带出值
        const valueIdx = lineText.indexOf('"', filenameIdx + 1);
        assert.ok(valueIdx >= 0, "filename 应有值引号");
        const attrInValue = attrAtCursor(parseXml(text), text, doc.offsetAt(new vscode.Position(includeLine, valueIdx + 1)));
        assert.ok(attrInValue, "attrAtCursor 在属性值内应定位到属性");
        assert.strictEqual(attrInValue!.attrName, "filename");
        assert.strictEqual(attrInValue!.value, lineText.slice(valueIdx + 1, lineText.indexOf('"', valueIdx + 1)));
    });

    // ---------------- X5 · mesh 引用不崩 ----------------
    it("X5 IncludeGraph 构建对 samples/xacro 全文件（含 package:// mesh）不崩", async () => {
        const graph = await buildSampleGraph();
        const robot = graph.getFile(vscode.Uri.file(ROBOT_PATH));
        assert.ok(robot, "主文件应入图");
        // mesh 引用（package://rde_ros_2/samples/xacro/meshes/...）不会让图构建崩溃
        assert.ok(robot!.includes.length > 0, "主文件应有 include 边");
    });

    // ---------------- X6 · property 解析 ----------------
    it("X6 真文件 property 定义可解析（findSymbol）", async () => {
        const graph = await buildSampleGraph();
        const robotUri = vscode.Uri.file(ROBOT_PATH);
        const robot = graph.getFile(robotUri)!;
        const pos = new vscode.Position(Math.max(0, robot.text.split("\n").length - 1), 0);
        for (const name of ["base_length", "base_width", "base_height", "wheel_radius", "wheel_width", "total_mass"]) {
            const def = graph.findSymbol(robotUri, pos, name, "property");
            assert.ok(def, `property ${name} 应可解析`);
        }
    });
});
