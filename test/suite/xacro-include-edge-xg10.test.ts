/**
 * include 边增强单测(XG10,设计:设计/xacro/14 §3)
 *
 * 覆盖:globLocalIncludes 纯函数、scanIncludes 的 ns/optional/isGlob 边模型与 glob 枚举、
 *       resolveDollarBraces XG10 扩展($() 内 ${} 先展开、表达式依赖代换+字面串判定)、
 *       classifyEdge optional 豁免 D1。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { IncludeGraph, globLocalIncludes, IncludeEdge } from "../../src/languages/xacro/core/include-graph";
import { classifyEdge } from "../../src/languages/xacro/ui/diagnostic-provider";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "rde-xacro-edge-"));
}

/** 最小 PackageMap mock:解析 $(find <name>) 前缀到 /pkgs/<name>;相对路径对齐真实 PackageMap(相对 fromUri) */
function makeFindPkg(): never {
    return {
        resolveFileRef: (raw: string, fromUri: vscode.Uri): vscode.Uri | undefined => {
            const m = /^\$\(find\s+([A-Za-z0-9_-]+)\)\s*\/?(.*)$/.exec(raw.trim());
            if (m) {
                return vscode.Uri.file(path.join("/pkgs", m[1], m[2]));
            }
            const rel = raw.trim();
            if (rel.indexOf("$(") < 0 && rel.indexOf("${") < 0 && rel.indexOf("package://") < 0) {
                return vscode.Uri.file(path.resolve(path.dirname(fromUri.fsPath), rel));
            }
            return undefined;
        },
        onDirLoaded: (): { dispose: () => void } => ({ dispose: () => undefined })
    } as never;
}

describe("xacro include 边增强(XG10)", () => {
    it("globLocalIncludes:单层 * / ? 匹配 + 排序;** 拒绝;目录不存在返回空", () => {
        const dir = tmpDir();
        try {
            for (const n of ["arm_a.xacro", "arm_b.xacro", "arm_c.urdf", "leg.xacro"]) {
                fs.writeFileSync(path.join(dir, n), "<robot/>");
            }
            const uri = vscode.Uri.file(path.join(dir, "main.xacro"));
            assert.deepStrictEqual(
                globLocalIncludes("arm_*.xacro", uri).map(p => path.basename(p)),
                ["arm_a.xacro", "arm_b.xacro"], "* 不跨扩展名,排序输出");
            assert.deepStrictEqual(
                globLocalIncludes("arm_?.xacro", uri).map(p => path.basename(p)),
                ["arm_a.xacro", "arm_b.xacro"], "? 匹配单字符");
            assert.deepStrictEqual(globLocalIncludes("**/*.xacro", uri), [], "深层 glob 不枚举");
            assert.deepStrictEqual(
                globLocalIncludes("*.xacro", vscode.Uri.file(path.join(dir, "nope", "m.xacro"))),
                [], "目录不存在 → 空");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("scanIncludes:glob include 枚举为多条 ok 边(共享 index、isGlob 标注)", () => {
        const dir = tmpDir();
        try {
            for (const n of ["g1.xacro", "g2.xacro"]) {
                fs.writeFileSync(path.join(dir, n), "<robot/>");
            }
            const main = path.join(dir, "main.xacro");
            fs.writeFileSync(main, '<robot><xacro:include filename="g*.xacro"/></robot>');
            const graph = new IncludeGraph(makeFindPkg());
            const node = graph.scanIncludes(vscode.Uri.file(main))!;
            const globEdges = node.includes.filter(e => e.isGlob);
            assert.strictEqual(globEdges.length, 2);
            assert.ok(globEdges.every(e => e.status === "ok"));
            assert.ok(globEdges.every(e => e.index === globEdges[0].index), "glob 多边共享 include 序号");
            const basenames = globEdges.map(e => path.basename(e.target!.fsPath));
            assert.deepStrictEqual(basenames, ["g1.xacro", "g2.xacro"], "sorted 语义");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("scanIncludes:ns/optional 计入边模型;glob 零匹配 → pending", () => {
        const dir = tmpDir();
        try {
            const main = path.join(dir, "main.xacro");
            fs.writeFileSync(main, [
                "<robot>",
                '  <xacro:include filename="missing_*.xacro"/>',
                '  <xacro:include filename="sub.xacro" ns="drv" optional="true"/>',
                "</robot>"
            ].join("\n"));
            const graph = new IncludeGraph(makeFindPkg());
            const node = graph.scanIncludes(vscode.Uri.file(main))!;
            const globEdge = node.includes.find(e => e.isGlob)!;
            assert.strictEqual(globEdge.status, "pending", "glob 零匹配 = pending(官方仅告警)");
            const sub = node.includes.find(e => e.raw === "sub.xacro")!;
            assert.strictEqual(sub.ns, "drv");
            assert.strictEqual(sub.optional, true);
            assert.strictEqual(sub.status, "ok", "相对路径照常落地");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("resolveDollarBraces XG10:$() 内 ${ident} 先展开(pkg 静态值)", async () => {
        const dir = tmpDir();
        try {
            const main = path.join(dir, "main.xacro");
            fs.writeFileSync(main, [
                "<robot>",
                '  <xacro:property name="pkg" value="testpkg"/>',
                '  <xacro:include filename="$(find ${pkg})/cfg/f.xacro"/>',
                "</robot>"
            ].join("\n"));
            const graph = new IncludeGraph(makeFindPkg());
            await graph.build([vscode.Uri.file(main)]); // ${} 收敛在 build 阶段B(upsert 不做)
            const node = graph.allNodes()[0];
            const edge = node.includes.find(e => e.raw.indexOf("${pkg}") >= 0)!;
            assert.strictEqual(edge.status, "ok", `应经 $() 内先展开落地(实际 ${edge.status})`);
            assert.ok(edge.target!.fsPath.replace(/\\/g, "/").includes("/pkgs/testpkg/"),
                `目标应含 testpkg(实际 ${edge.target!.fsPath})`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("resolveDollarBraces XG10:非纯标识符表达式全静态代换+字面串判定;控制流悬空", async () => {
        const dir = tmpDir();
        try {
            const main = path.join(dir, "main.xacro");
            fs.writeFileSync(main, [
                "<robot>",
                '  <xacro:property name="dir_name" value="models"/>',
                '  <xacro:include filename="${dir_name}"/>',
                '  <xacro:include filename="${[x for x in dir_name]}"/>',
                "</robot>"
            ].join("\n"));
            const graph = new IncludeGraph(makeFindPkg());
            await graph.build([vscode.Uri.file(main)]); // ${} 收敛在 build 阶段B(upsert 不做)
            const node = graph.allNodes()[0];
            // 裸词字面串:dir_name → "models"(与纯标识符同路径,回归护栏)
            assert.ok(node.includes.some(e => e.status === "ok" && e.raw === "${dir_name}"));
            // 控制流 → 静态不可代换 → pending
            assert.ok(node.includes.some(e => e.raw.indexOf("[x for x in") >= 0 && e.status === "pending"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("classifyEdge:optional include 目标缺失不报 D1;普通缺失照报", () => {
        const uri = vscode.Uri.file("/no/such/file.xacro");
        const edge: IncludeEdge = { raw: "f.xacro", target: uri, status: "ok", index: 0, line: 0, startColumn: 0, endColumn: 1 };
        assert.strictEqual(classifyEdge({ ...edge, optional: true }, () => false), undefined, "optional → D1 豁免");
        assert.strictEqual(classifyEdge(edge, () => false), "D1", "普通 include 缺失照报");
        assert.strictEqual(classifyEdge(edge, () => true), undefined);
    });
});
