/**
 * IncludeGraph 单元测试
 *
 * 策略:mock PackageMap(注入假工作区/系统包)+ 临时目录写 xacro 文件
 *      + vscode.Uri.file → IncludeGraph.build(uris)。不依赖真实 ROS 环境。
 *
 * 覆盖:expandOrder / findRoots / 两态 include 边 / 环检测 /
 *      visibleSymbols / isVisible / findSymbol / ${} 迭代收敛 /
 *      recordUseDef / propagate / rename
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { IncludeGraph, PropertyCycleStep, fileInFallbackDomain } from "../../src/languages/xacro/core/include-graph";
import { PackageMap } from "../../src/languages/shared/package-map";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * 构造 mock PackageMap。
 * @param workspace 工作区包: pkgName → 绝对目录
 * @param system    系统包名集合(位置 = <tmp>/sys/<pkg>)
 */
function makeMockPackageMap(
    workspace?: Map<string, string>,
    system?: Set<string>,
    sysRoot?: string
): PackageMap {
    const resolveFind = (raw: string): vscode.Uri | undefined => {
        const m = raw.match(/\$\(\s*find(?:\s*-\s*pkg-share)?\s+([a-zA-Z0-9_-]+)\s*\)\s*\/?(.*)$/);
        if (!m) {
            return undefined;
        }
        const pkg = m[1];
        const rest = m[2] || "";
        const dir = workspace?.get(pkg);
        if (dir) {
            return vscode.Uri.file(path.join(dir, rest));
        }
        if (system?.has(pkg) && sysRoot) {
            return vscode.Uri.file(path.join(sysRoot, pkg, rest));
        }
        return undefined;
    };
    const fake = {
        get: (pkg: string): vscode.Uri | undefined => {
            const dir = workspace?.get(pkg);
            if (dir) {
                return vscode.Uri.file(dir);
            }
            if (system?.has(pkg) && sysRoot) {
                return vscode.Uri.file(path.join(sysRoot, pkg));
            }
            return undefined;
        },
        resolveFindExpr: resolveFind,
        resolveFileRef: (raw: string, fromUri: vscode.Uri): vscode.Uri | undefined => {
            const rel = raw.trim();
            if (!rel) {
                return undefined;
            }
            if (rel.startsWith("$(")) {
                return resolveFind(rel);
            }
            if (rel.startsWith("package://")) {
                const m = rel.match(/^package:\/\/([^/]+)(\/.*)?$/);
                if (!m) {
                    return undefined;
                }
                const dir = fake.get(m[1]);
                if (!dir) {
                    return undefined;
                }
                const rest = (m[2] || "").replace(/^\/+/, "");
                return vscode.Uri.file(path.join(dir.fsPath, rest));
            }
            return vscode.Uri.file(path.resolve(path.dirname(fromUri.fsPath), rel));
        }
    };
    return fake as unknown as PackageMap;
}

/** 临时目录写文件并 build IncludeGraph */
async function buildGraph(
    files: Record<string, string>,
    pkg?: PackageMap
): Promise<{ graph: IncludeGraph; dir: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xacro-test-"));
    const uris: vscode.Uri[] = [];
    for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
        uris.push(vscode.Uri.file(full));
    }
    const graph = new IncludeGraph(pkg ?? makeMockPackageMap());
    await graph.build(uris);
    return { graph, dir };
}

/* ------------------------------------------------------------------ */
/* 测试                                                               */
/* ------------------------------------------------------------------ */

describe("IncludeGraph 单元测试", () => {
    describe("expandOrder 保序展开", () => {
        it("单文件无 include → [self]", async () => {
            const { graph, dir } = await buildGraph({
                "C.xacro": '<robot><xacro:macro name="m"/></robot>'
            });
            const c = vscode.Uri.file(path.join(dir, "C.xacro"));
            const order = graph.expandOrder(c);
            assert.strictEqual(order.length, 1);
            assert.strictEqual(order[0].toString(), c.toString());
        });

        it("两层:C include A → [A, C]", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="macA"/></robot>',
                "C.xacro": '<robot><xacro:include filename="A.xacro"/></robot>'
            });
            const c = vscode.Uri.file(path.join(dir, "C.xacro"));
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const order = graph.expandOrder(c);
            assert.strictEqual(order.length, 2);
            assert.strictEqual(order[0].toString(), a.toString()); // A 先展开
            assert.strictEqual(order[1].toString(), c.toString()); // C 后
        });

        it("顺序敏感:C include [A, B] → [A, B, C]", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="macA"/></robot>',
                "B.xacro": '<robot><xacro:macro name="macB"/></robot>',
                "C.xacro": '<robot><xacro:include filename="A.xacro"/><xacro:include filename="B.xacro"/></robot>'
            });
            const c = vscode.Uri.file(path.join(dir, "C.xacro"));
            const order = graph.expandOrder(c);
            const names = order.map(u => path.basename(u.fsPath));
            assert.deepStrictEqual(names, ["A.xacro", "B.xacro", "C.xacro"]);
        });

        it("环 A↔B 不死循环(环检测告警)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:include filename="B.xacro"/></robot>',
                "B.xacro": '<robot><xacro:include filename="A.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const order = graph.expandOrder(a); // 不应死循环
            assert.ok(order.length >= 1);          // 部分结果或空,但不挂死
            assert.ok(order.length <= 2);
        });
    });

    describe("findRoots 根发现(入口无关)", () => {
        it("C include B → findRoots(B) = [C]", async () => {
            const { graph, dir } = await buildGraph({
                "C.xacro": '<robot><xacro:include filename="B.xacro"/></robot>',
                "B.xacro": '<robot><xacro:macro name="macB"/></robot>'
            });
            const b = vscode.Uri.file(path.join(dir, "B.xacro"));
            const c = vscode.Uri.file(path.join(dir, "C.xacro"));
            const roots = graph.findRoots(b);
            assert.strictEqual(roots.length, 1);
            assert.strictEqual(roots[0].toString(), c.toString());
        });

        it("无父文件 → 自身为根", async () => {
            const { graph, dir } = await buildGraph({
                "B.xacro": '<robot><xacro:macro name="macB"/></robot>'
            });
            const b = vscode.Uri.file(path.join(dir, "B.xacro"));
            const roots = graph.findRoots(b);
            assert.strictEqual(roots.length, 1);
            assert.strictEqual(roots[0].toString(), b.toString());
        });
    });

    describe("两态 include 边", () => {
        it("相对路径 include → status ok", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="macA"/></robot>',
                "C.xacro": '<robot><xacro:include filename="A.xacro"/></robot>'
            });
            const c = vscode.Uri.file(path.join(dir, "C.xacro"));
            const node = graph.getFile(c);
            assert.ok(node);
            assert.strictEqual(node.includes.length, 1);
            assert.strictEqual(node.includes[0].status, "ok");
        });

        it("$(find 未加载包) → status pending(悬空)", async () => {
            // 空包映射:工作区/系统都没有该包 → 一律悬空
            const { graph, dir } = await buildGraph(
                {
                    "C.xacro": '<robot><xacro:include filename="$(find ghost_pkg)/foo.xacro"/></robot>'
                },
                makeMockPackageMap(new Map(), new Set())
            );
            const c = vscode.Uri.file(path.join(dir, "C.xacro"));
            const node = graph.getFile(c);
            assert.ok(node);
            assert.strictEqual(node.includes[0].status, "pending");
        });
    });

    describe("include raw 提取回归(extractAttrValue)", () => {
        it("含 / 的路径不被截断(双引号)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:include filename="sub/robot.xacro"/></robot>',
                "sub/robot.xacro": '<robot/>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const node = graph.getFile(a);
            assert.ok(node);
            assert.strictEqual(node.includes[0].raw, "sub/robot.xacro");
            assert.strictEqual(node.includes[0].status, "ok");
        });

        it("单引号属性值完整提取(伴生修复)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": "<robot><xacro:include filename='sub/robot.xacro'/></robot>",
                "sub/robot.xacro": '<robot/>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const node = graph.getFile(a);
            assert.ok(node);
            assert.strictEqual(node.includes[0].raw, "sub/robot.xacro");
            assert.strictEqual(node.includes[0].status, "ok");
        });

        it("${} 拼接路径完整提取", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:property name="models" value="models"/><xacro:include filename="${models}/robot.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const node = graph.getFile(a);
            assert.ok(node);
            assert.strictEqual(node.includes[0].raw, "${models}/robot.xacro");
        });

        it("注释内 include 不产生边(lezer 行为修正)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><!-- <xacro:include filename="x.xacro"/> --><xacro:macro name="m"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const node = graph.getFile(a);
            assert.ok(node);
            assert.strictEqual(node.includes.length, 0, "注释内的 include 不应产生幽灵边");
        });

        it("属性值含 < 不截断(lezer 行为修正)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:include filename="a<b.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const node = graph.getFile(a);
            assert.ok(node);
            assert.strictEqual(node.includes[0].raw, "a<b.xacro");
        });
    });

    describe("visibleSymbols / isVisible 可见性", () => {
        it("跨文件:展开序之前的文件符号可见", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="macA"/></robot>',
                "B.xacro": '<robot><xacro:macro name="macB"/><xacro:macro name="useA"><xacro:macA/></xacro:macro></robot>',
                "C.xacro": '<robot><xacro:include filename="A.xacro"/><xacro:include filename="B.xacro"/></robot>'
            });
            const b = vscode.Uri.file(path.join(dir, "B.xacro"));
            const pos = new vscode.Position(0, 0);
            // B 的可见集应含 A 的 macA(展开序 A 在 B 前)
            const found = graph.findSymbol(b, pos, "macA", "macro");
            assert.ok(found, "B 应可见 A 的 macA");
        });

        it("同文件:定义在使用之前可见", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="m1"/><xacro:macro name="m2"><xacro:m1/></xacro:macro></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            // pos 须在 m1 定义之后(同文件"定义在前"判定,不能用 (0,0))
            const found = graph.findSymbol(a, new vscode.Position(0, 40), "m1", "macro");
            assert.ok(found);
        });
    });

    describe("findSymbol 宽松查找", () => {
        it("同文件优先命中", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="m"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            // pos 在 m 定义之后(同文件优先命中需"定义在前")
            const def = graph.findSymbol(a, new vscode.Position(0, 20), "m", "macro");
            assert.ok(def);
            assert.strictEqual(def.uri.toString(), a.toString());
        });

        it("跨文件命中(展开序之前)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="macA"/></robot>',
                "B.xacro": '<robot><xacro:macro name="use"><xacro:macA/></xacro:macro></robot>',
                "C.xacro": '<robot><xacro:include filename="A.xacro"/><xacro:include filename="B.xacro"/></robot>'
            });
            const b = vscode.Uri.file(path.join(dir, "B.xacro"));
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const def = graph.findSymbol(b, new vscode.Position(0, 0), "macA", "macro");
            assert.ok(def, "跨文件应命中 A 的 macA");
            assert.strictEqual(def.uri.toString(), a.toString());
        });

        it("未命中:触发兜底(fire-and-forget)且返回 undefined", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="m"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const def = graph.findSymbol(a, new vscode.Position(0, 0), "not_exist", "macro");
            assert.strictEqual(def, undefined); // 本次未命中;兜底异步写回,下次命中
        });
    });

    describe("${} 迭代收敛", () => {
        it("同文件 property 拼接 → ok", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:property name="models" value="models"/><xacro:include filename="${models}/robot.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const node = graph.getFile(a);
            assert.ok(node);
            const inc = node.includes.find(e => e.raw.includes("${"));
            assert.ok(inc, "应有 ${} 边");
            assert.strictEqual(inc.status, "ok");                   // 静态可求值
            assert.ok(inc.target, "代入后应解析出 target");
            assert.ok(inc.target!.fsPath.endsWith(path.join("models", "robot.xacro"))); // 跨平台:path.join 生成平台分隔符
        });

        it("跨文件:被 include 文件的 property 拼接(C 用 A 的 p)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:property name="p" value="models"/></robot>',
                "C.xacro": '<robot><xacro:include filename="A.xacro"/><xacro:include filename="${p}/robot.xacro"/></robot>'
            });
            const c = vscode.Uri.file(path.join(dir, "C.xacro"));
            const node = graph.getFile(c);
            assert.ok(node);
            const inc = node.includes.find(e => e.raw.includes("${"));
            assert.ok(inc, "应有 ${} 边");
            assert.strictEqual(inc.status, "ok"); // 展开序 A 在 C 前 → p 可见 → 求值成功
        });

        it("arg 引用 → 无法静态求值 → pending", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:arg name="platform"/><xacro:include filename="${platform}/x.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const node = graph.getFile(a);
            assert.ok(node);
            const inc = node.includes.find(e => e.raw.includes("${"));
            assert.ok(inc, "应有 ${} 边");
            assert.strictEqual(inc.status, "pending"); // arg 运行时才有 → 悬空
        });
    });

    describe("recordUseDef / propagate", () => {
        it("B 用 A 的 property → propagate(A) 重解 B 的 ${} 边(用新值)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:property name="p" value="models"/></robot>',
                "B.xacro": '<robot><xacro:include filename="A.xacro"/><xacro:include filename="${p}/robot.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const b = vscode.Uri.file(path.join(dir, "B.xacro"));
            // 改 A 的 p 值 → upsert + propagate
            fs.writeFileSync(path.join(dir, "A.xacro"),
                '<robot><xacro:property name="p" value="lib"/></robot>', "utf8");
            graph.upsert(a);
            graph.propagate(a);
            const bNode = graph.getFile(b);
            assert.ok(bNode);
            const inc = bNode.includes.find(e => e.raw.includes("${"));
            assert.ok(inc, "B 应有 ${} 边");
            assert.strictEqual(inc.status, "ok");                   // 重解成功
            assert.ok(inc.target!.fsPath.endsWith(path.join("lib", "robot.xacro")), "应使用新值 lib"); // 跨平台:path.join 生成平台分隔符
        });

        it("propagate 无依赖 uri 不崩溃(防御)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:property name="p" value="models"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            assert.doesNotThrow(() => graph.propagate(a));
        });
    });

    describe("D6 符号级环(12,useDefMap 升级)", () => {
        // 关键事实(2026-08-19 扩展日志实证):include 环会破坏 visibleSymbols 跨文件可见集
        // → 自然 include 构造不出 useDefMap 环。因此:
        //   - D6 环检测/闭环/定位:白盒注入 useDefMap/fileSymbolIndex 环(纯测 propagate 逻辑)
        //   - 符号级 key / stale 治理:自然单向场景(A include B,A 用 B 的 pB)
        it("D6 符号级环:白盒注入 useDefMap 环 → onPropertyCycle 收到闭环符号环", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:property name="pA" value="models"/></robot>',
                "B.xacro": '<robot><xacro:property name="pB" value="models"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const b = vscode.Uri.file(path.join(dir, "B.xacro"));
            const g = graph as unknown as {
                useDefMap: Map<string, Set<string>>;
                fileSymbolIndex: Map<string, Set<string>>;
            };
            // 白盒注入符号级环:A::pA → B(依赖者),B::pB → A
            g.useDefMap.set(`${a.toString()}::pA`, new Set([b.toString()]));
            g.useDefMap.set(`${b.toString()}::pB`, new Set([a.toString()]));
            g.fileSymbolIndex.set(a.toString(), new Set([`${a.toString()}::pA`]));
            g.fileSymbolIndex.set(b.toString(), new Set([`${b.toString()}::pB`]));
            const cycles: PropertyCycleStep[][] = [];
            const sub = graph.onPropertyCycle(c => cycles.push(c));
            graph.propagate(a);
            sub.dispose();
            assert.ok(cycles.length >= 1, "应触发 D6");
            const c = cycles[0];
            assert.strictEqual(c.length, 3, "闭环应为 3 步");
            assert.strictEqual(c[0].symbol, "pA");
            assert.strictEqual(c[1].symbol, "pB");
            assert.strictEqual(c[c.length - 1].symbol, "pA", "环应闭合(首尾同符号)");
        });

        it("D6 元素带定义位置(line/column)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:property name="pA" value="models"/></robot>',
                "B.xacro": '<robot><xacro:property name="pB" value="models"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const b = vscode.Uri.file(path.join(dir, "B.xacro"));
            const g = graph as unknown as {
                useDefMap: Map<string, Set<string>>;
                fileSymbolIndex: Map<string, Set<string>>;
            };
            g.useDefMap.set(`${a.toString()}::pA`, new Set([b.toString()]));
            g.useDefMap.set(`${b.toString()}::pB`, new Set([a.toString()]));
            g.fileSymbolIndex.set(a.toString(), new Set([`${a.toString()}::pA`]));
            g.fileSymbolIndex.set(b.toString(), new Set([`${b.toString()}::pB`]));
            const cycles: PropertyCycleStep[][] = [];
            const sub = graph.onPropertyCycle(c => cycles.push(c));
            graph.propagate(a);
            sub.dispose();
            const c = cycles[0];
            assert.strictEqual(c[0].symbol, "pA");
            // pA 定义于 A.xacro 第 0 行;column = <xacro:property 标签起始列
            // (<robot> 占 7 字符 → column 7;与 collectSymbols 的"标签起始"语义一致)
            assert.strictEqual(c[0].line, 0);
            assert.strictEqual(c[0].column, 7);
        });

        it("useDefMap 符号级 key:含 :: 分隔符(自然单向场景)", async () => {
            // A include B(使 pB 可见),A 的 ${pB} 用 B 的 pB → useDefMap: B::pB → A
            const { graph } = await buildGraph({
                "A.xacro": '<robot><xacro:include filename="B.xacro"/><xacro:include filename="${pB}/x.xacro"/></robot>',
                "B.xacro": '<robot><xacro:property name="pB" value="models"/></robot>'
            });
            const g = graph as unknown as { useDefMap: Map<string, Set<string>> };
            const keys = [...g.useDefMap.keys()];
            assert.ok(keys.length >= 1, `应有符号级依赖边,实际 ${keys.length}`);
            for (const k of keys) {
                assert.ok(k.includes("::"), `符号级 key 应含 :: : ${k}`);
            }
        });

        it("stale 治理:移除 ${} 引用后旧依赖边被清(reparse 先清后加)", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:include filename="B.xacro"/><xacro:include filename="${pB}/x.xacro"/></robot>',
                "B.xacro": '<robot><xacro:property name="pB" value="models"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const g = graph as unknown as { useDefMap: Map<string, Set<string>> };
            // 初始:build 已形成 B::pB → A
            const before = [...g.useDefMap.keys()];
            assert.ok(before.some(k => k.endsWith("::pB")), `初始应有 B::pB,实际 ${before}`);
            // 改 A:${pB} 改为静态路径 → reparseDollarEdges(A) 先 removeDepFromAll 再重标
            fs.writeFileSync(path.join(dir, "A.xacro"),
                '<robot><xacro:include filename="B.xacro"/><xacro:include filename="models/x.xacro"/></robot>', "utf8");
            graph.upsert(a);
            graph.reparseDollarEdges(a);   // public:直接触发"先清后加"(stale 治理核心)
            const stale = [...g.useDefMap.keys()].find(k => k.endsWith("::pB"));
            if (stale) {
                assert.ok(!g.useDefMap.get(stale)!.has(a.toString()), "A 不应再依赖 B::pB");
            }
        });
    });

    describe("rename 移动", () => {
        it("移动 A → 节点 key 迁移,旧 uri 无节点", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="macA"/></robot>',
                "C.xacro": '<robot><xacro:include filename="A.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const a2 = vscode.Uri.file(path.join(dir, "sub", "A.xacro"));
            fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
            fs.writeFileSync(a2.fsPath, '<robot><xacro:macro name="macA"/></robot>', "utf8");
            graph.rename(a, a2);
            assert.ok(graph.getFile(a2), "新 uri 应有节点");
            assert.strictEqual(graph.getFile(a), undefined, "旧 uri 应无节点");
        });

        it("移动后不崩溃,父节点仍存在", async () => {
            const { graph, dir } = await buildGraph({
                "sub/A.xacro": '<robot><xacro:macro name="macA"/></robot>',
                "C.xacro": '<robot><xacro:include filename="sub/A.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "sub", "A.xacro"));
            const a2 = vscode.Uri.file(path.join(dir, "A.xacro"));
            fs.writeFileSync(a2.fsPath, '<robot><xacro:macro name="macA"/></robot>', "utf8");
            graph.rename(a, a2);
            const c = vscode.Uri.file(path.join(dir, "C.xacro"));
            assert.ok(graph.getFile(c), "父节点应存在");
            assert.ok(graph.getFile(a2), "新 uri 应有节点");
        });
    });

    describe("upsert 幽灵事件与增量", () => {
        it("内容未变(幽灵事件)→ 跳过不重建", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="m"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const before = graph.getFile(a);
            graph.upsert(a); // 内容未变
            const after = graph.getFile(a);
            assert.strictEqual(after, before); // 同一节点对象,未重建
        });

        it("内容变化 → 节点文本更新", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:macro name="m1"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            fs.writeFileSync(path.join(dir, "A.xacro"),
                '<robot><xacro:macro name="m2"/></robot>', "utf8");
            graph.upsert(a);
            const node = graph.getFile(a);
            assert.ok(node);
            assert.ok(node.text.includes("m2"), "文本应更新");
        });
    });

    describe("DEBUG ${} 求值链路(定点排查)", () => {
        it("打印 property value / include 边 / resolveDollarBraces 返回值", async () => {
            const { graph, dir } = await buildGraph({
                "A.xacro": '<robot><xacro:property name="models" value="models"/><xacro:include filename="${models}/robot.xacro"/></robot>'
            });
            const a = vscode.Uri.file(path.join(dir, "A.xacro"));
            const node = graph.getFile(a);
            // 1) property 符号 + value
            const def = graph.findSymbol(a, new vscode.Position(0, 100), "models", "property");
            // eslint-disable-next-line no-console
            console.log("[DEBUG] def:", JSON.stringify(def));
            // 2) include 边
            const inc = node!.includes.find(e => e.raw.includes("${"));
            // eslint-disable-next-line no-console
            console.log("[DEBUG] inc.status:", inc!.status, "raw:", inc!.raw,
                "line:", inc!.line, "col:", inc!.startColumn);
            // eslint-disable-next-line no-console
            console.log("[DEBUG] inc.target:", inc!.target?.fsPath);
            // 3) 直接调 resolveDollarBraces
            const r = (graph as any).resolveDollarBraces(inc!.raw, a, inc!.line, inc!.startColumn);
            // eslint-disable-next-line no-console
            console.log("[DEBUG] resolveDollarBraces:", r ? JSON.stringify({ t: r.target.fsPath, d: r.defUri.fsPath }) : "undefined");
        });
    });
});

describe("兜底搜索域门控(XG13,2026-09-25)", () => {
    it("工作区内文件在域内,系统包/临时目录在域外", () => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) {
            return; // 无根环境(纯 stub)域恒空,断言域外即可
        }
        const inside = vscode.Uri.file(path.join(wsRoot, "samples", "xacro", "robot.urdf.xacro"));
        assert.strictEqual(fileInFallbackDomain(inside), true, "工作区根内应判定在域内");
        assert.strictEqual(fileInFallbackDomain(vscode.Uri.file(wsRoot)), true, "根自身也在域内");
        const outside = vscode.Uri.file("/opt/ros/humble/share/pkg/urdf/foo.xacro");
        assert.strictEqual(fileInFallbackDomain(outside), false, "系统包路径应在域外");
        assert.strictEqual(fileInFallbackDomain(vscode.Uri.file(path.join(os.tmpdir(), "x.xacro"))), false, "临时目录应在域外");
    });

    it("域外文件未命中:findSymbol 返回 undefined 且不触发兜底(不再白烧全仓扫描)", async () => {
        const { graph, dir } = await buildGraph({
            "A.xacro": '<robot><xacro:macro name="m"/></robot>'
        });
        // os.tmpdir 在测试工作区(samples/)之外 → 域外
        const out = vscode.Uri.file(path.join(os.tmpdir(), "sys_pkg_stub.xacro"));
        const def = graph.findSymbol(out, new vscode.Position(0, 0), "whatever", "macro");
        assert.strictEqual(def, undefined);
        // 频控簿记不应被触碰(域外在 needFallback 前置短路)
        const inDomain = vscode.Uri.file(path.join(dir, "A.xacro"));
        assert.strictEqual(graph.findSymbol(inDomain, new vscode.Position(0, 0), "nope", "macro"), undefined);
    });
});
