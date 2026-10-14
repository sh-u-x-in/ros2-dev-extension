/**
 * intellisense-config 渲染测试(无头 mocha,临时目录 fixture)
 *
 * 验证 config/gen 配置生成的核心逻辑(2026-09-07 语义):
 *  - utils 层:toCppIncludeEntry 路径映射 / 系统 include 命中与跳过 / PYTHONPATH 拆分 /
 *            clangdGroupDirs(工作空间=父根一行、环境=各包子根一行,【约定 B】不父子并列,
 *            跨组去重工作空间优先)/ 解析注释容错
 *  - render 层:syncCppProperties(缺失→生成三键形状;已存在→includePath 管辖
 *            重排 + 字段补齐/升级 + 残留 /usr/include 清除 + 管辖外条目保留)
 *            syncClangd(缺失→生成 嵌套 CompilationDatabase + -I/-isystem 分组;已存在→管辖内
 *            破坏性归正(旧形态/旧父子并列父行·子行/重复行/残留 /usr/include 清除)+ 组内补缺失;
 *            flow 保守)
 *            remove* 有感删除(组删空清理我方注释标记)+ 有感删除预检(2026-09-08:
 *            cppIncludeEntryExists / clangdIncludeExists / pythonPathExists,与 remove* 同口径)
 *
 * 运行:npm run test-compile && npx mocha out/test/suite/intellisense-config.test.js
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { installVscodeStub } from "./_vscode-stub";

// 必须在 require 被测模块之前安装 vscode stub(render 顶层 import vscode,无头环境不可解析)
installVscodeStub();

// 2026-10-15:render 组测试宿主可见性旗标——无头(桩已装)=true;集成宿主(真实 vscode,桩早退不装)=false
const HEADLESS = (global as unknown as { __vscodeStubInstalled?: boolean }).__vscodeStubInstalled === true;
const req = createRequire(__filename);
const utils = req("../../src/build-tool/package-service/config/gen/intellisense-utils") as any;
const render = req("../../src/build-tool/package-service/config/gen/intellisense-render") as any;
const dt = req("../../src/build-tool/package-service/config/gen/distro-templates") as any;
const vsc = req("vscode") as any;

// 分组标记:从 render 双语表取(2026-10-14 标记 L10N 化;测试宿主 --locale=en → en 文本)
const MARK_LANG = (render as { currentMarkerLang(): "en" | "zh-cn" }).currentMarkerLang();
const FLAGS_MARK = (render as { clangdMarkerOf(id: "flags", lang: "en" | "zh-cn"): string }).clangdMarkerOf("flags", MARK_LANG);
const WS_MARK = (render as { clangdMarkerOf(id: "ws", lang: "en" | "zh-cn"): string }).clangdMarkerOf("ws", MARK_LANG);
const SYS_MARK = (render as { clangdMarkerOf(id: "sys", lang: "en" | "zh-cn"): string }).clangdMarkerOf("sys", MARK_LANG);
const INSTALL_MARK_ISOLATED = (render as { clangdMarkerOf(id: "install", lang: "en" | "zh-cn", layout: "isolated" | "merged"): string }).clangdMarkerOf("install", MARK_LANG, "isolated");
const INSTALL_MARK_MERGED = (render as { clangdMarkerOf(id: "install", lang: "en" | "zh-cn", layout: "isolated" | "merged"): string }).clangdMarkerOf("install", MARK_LANG, "merged");

/** 剥 YAML 列表项前缀 → 裸 token */
function canon(l: string): string {
    const t = l.trim();
    return t.startsWith("- ") ? t.slice(2).trim() : t;
}

describe("intellisense-config 渲染", () => {
    let tmpRoot: string;
    let wsRoot: string;
    let env: Record<string, string>;
    let incLll: string; // <ws>/install/lll/include(环境前缀 include;消费根 = 其子根 include/lll)
    let wsInc: string; // <ws>/src/lll/include(工作空间 include 根;源码头 include/lll/… 经此父根解析)

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "intellisense-test-"));
        wsRoot = path.join(tmpRoot, "ws");
        fs.mkdirSync(path.join(wsRoot, ".vscode"), { recursive: true });
        // install/lll/include/lll/lll/ooo.hpp(约定 B 双层物理:include/<pkg>/<pkg>;env 消费根 = include/<pkg>)
        incLll = path.join(wsRoot, "install", "lll", "include");
        fs.mkdirSync(path.join(incLll, "lll", "lll"), { recursive: true });
        fs.writeFileSync(path.join(incLll, "lll", "lll", "ooo.hpp"), "#pragma once\n");
        // install/iii 无 include(验证跳过)
        fs.mkdirSync(path.join(wsRoot, "install", "iii"), { recursive: true });
        // src/lll(C++ 包:include + package.xml)
        wsInc = path.join(wsRoot, "src", "lll", "include");
        fs.mkdirSync(path.join(wsInc, "lll"), { recursive: true });
        fs.writeFileSync(path.join(wsInc, "lll", "ooo.hpp"), "#pragma once\n");
        fs.writeFileSync(path.join(wsRoot, "src", "lll", "package.xml"), "<package><name>lll</name></package>");
        // src/iii(python 包:setup.py + package.xml)
        fs.mkdirSync(path.join(wsRoot, "src", "iii"), { recursive: true });
        fs.writeFileSync(path.join(wsRoot, "src", "iii", "setup.py"), "from setuptools import setup\n");
        fs.writeFileSync(path.join(wsRoot, "src", "iii", "package.xml"), "<package><name>iii</name></package>");
        // build/iii + site-packages(PYTHONPATH 注入目录)
        fs.mkdirSync(path.join(wsRoot, "build", "iii"), { recursive: true });
        fs.mkdirSync(path.join(wsRoot, "install", "iii", "lib", "python3.10", "site-packages"), { recursive: true });
        env = {
            AMENT_PREFIX_PATH: path.join(wsRoot, "install", "lll") + path.delimiter + path.join(wsRoot, "install", "iii"),
            CMAKE_PREFIX_PATH: path.join(wsRoot, "install", "lll"),
            PYTHONPATH: path.join(wsRoot, "build", "iii") + path.delimiter + path.join(wsRoot, "install", "iii", "lib", "python3.10", "site-packages"),
        };
        // 重置 vscode stub 配置存储(python extraPaths 测试隔离)
        const cfg = vsc.workspace.getConfiguration();
        void cfg.update("python.autoComplete.extraPaths", []).catch(() => undefined);
        void cfg.update("python.analysis.extraPaths", []).catch(() => undefined);
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    describe("utils 纯函数", () => {
        it("toCppIncludeEntry: 工作区内 include → ${workspaceFolder} 相对映射", () => {
            const entry = utils.toCppIncludeEntry(incLll, wsRoot);
            assert.ok(entry.startsWith("${workspaceFolder}/"), entry);
        });

        it("toCppIncludeEntry: 工作区外 → 绝对路径 + /**", () => {
            const entry = utils.toCppIncludeEntry(incLll, path.join(tmpRoot, "other"));
            assert.strictEqual(entry, path.join(incLll, "**"));
        });

        it("collectSystemIncludes: 无条件收录前缀 include(lll 与 iii 都有,不做存在性检测)", () => {
            const sys = utils.collectSystemIncludes(env);
            assert.strictEqual(sys.length, 2, JSON.stringify(sys));
            assert.ok(sys.includes(incLll));
            assert.ok(sys.includes(path.join(wsRoot, "install", "iii", "include")));
        });

        it("collectPythonDirs: PYTHONPATH 拆分 2 条", () => {
            const pyd = utils.collectPythonDirs(env);
            assert.strictEqual(pyd.length, 2);
            assert.ok(pyd.includes(path.join(wsRoot, "build", "iii")));
            assert.ok(pyd.includes(path.join(wsRoot, "install", "iii", "lib", "python3.10", "site-packages")));
        });

        it("clangdGroupDirs: 工作空间/安装产物消费根原样分组;发行版组枚举子根并在末尾补前缀根", async () => {
            const otherRoot = path.join(wsRoot, "other_inc");
            fs.mkdirSync(path.join(otherRoot, "zzz"), { recursive: true });
            const installRoot = path.join(incLll, "lll"); // 安装侧消费根(静态传入,不检测存在性)
            const g = await utils.clangdGroupDirs([wsInc, wsInc], [installRoot], [otherRoot, wsInc]); // ws 重复 + 同根跨源
            // 工作空间组:只列 <pkg>/include 父根本身,不再展开 include/<pkg> 子行
            assert.ok(g.ws.includes(wsInc), g.ws.join("|"));
            assert.ok(!g.ws.includes(path.join(wsInc, "lll")), "ws 不应再列 include/<pkg> 子行:" + g.ws.join("|"));
            // 安装组:静态原样收录(不做 readdir/stat)
            assert.deepStrictEqual(g.install, [installRoot], "install 组应静态原样收录:" + g.install.join("|"));
            // 发行版组:子根(枚举)+ 末尾前缀根本身
            assert.deepStrictEqual(g.sys, [path.join(otherRoot, "zzz"), otherRoot], "sys = 子根 + 前缀根(末尾):" + g.sys.join("|"));
            // 同目录跨源:wsInc 已在工作空间组 → 该前缀整条跳过(不产子根、也不补父根)
            assert.ok(!g.sys.includes(wsInc), "与工作空间同根的前缀应整体跳过:" + g.sys.join("|"));
        });

        it("clangdGroupDirs: 发行版前缀无子目录则不产子根行,但末尾仍补前缀根本身(静态兜底)", async () => {
            const missingRoot = path.join(wsRoot, "install", "fff", "include"); // 目录不存在
            const emptyRoot = path.join(wsRoot, "install", "ggg", "include"); // 目录存在但为空
            fs.mkdirSync(emptyRoot, { recursive: true });
            const staticRoot = path.join(wsRoot, "install", "hhh", "include", "hhh"); // 不存在也照写
            const g = await utils.clangdGroupDirs([], [staticRoot], [missingRoot, emptyRoot, incLll]);
            assert.ok(g.sys.includes(path.join(incLll, "lll")), "有子目录前缀仍应列子根 include/<pkg>:" + g.sys.join("|"));
            // 缺失/空前缀不产子根行;但每个前缀的"根本身"作为兜底一律补在末尾
            for (const r of [missingRoot, emptyRoot, incLll]) {
                assert.strictEqual(g.sys.filter((d: string) => d === r).length, 1, `前缀根 ${r} 应恰好一条:` + g.sys.join("|"));
            }
            assert.deepStrictEqual(g.install, [staticRoot], "安装组静态原样收录(即使目录不存在):" + g.install.join("|"));
        });

        it("parseClangdAddEntries: flow 与 block 都能解析(注释行不中断/不冒充条目),规范 token 原样保留", () => {
            const flow = utils.parseClangdAddEntries(
                "CompileFlags:\n  Add: [\n    -Wall,\n    -std=c++20,\n    # 手写注释\n  -I" + wsInc + ",\n  ]\n");
            assert.ok(flow, "flow 应解析出块");
            assert.strictEqual(flow.style, "flow");
            assert.ok(flow.entries.has("-I" + wsInc), JSON.stringify([...flow.entries]));
            assert.ok(![...flow.entries].some((e: string) => e.startsWith("#")), "flow 注释行不应成为条目");
            const block = utils.parseClangdAddEntries(
                "CompileFlags:\n  CompilationDatabase: build\n  Add:\n    # 任意注释\n    - -Wall\n    - -std=c++20\n    - -isystem" + incLll + "\n    - -I" + wsInc + "\n");
            assert.ok(block, "block 应解析出块");
            assert.strictEqual(block.style, "block");
            assert.ok(block.entries.has("-I" + wsInc), JSON.stringify([...block.entries]));
            assert.ok(block.entries.has("-isystem" + incLll), JSON.stringify([...block.entries]));
            assert.ok(block.entries.has("-std=c++20"));
            assert.strictEqual(block.entries.size, 4, "注释行不应计入条目:" + JSON.stringify([...block.entries]));
        });

        it("recheckPackageAbsent: package.xml 存在 → 未缺席(false,不删)", async () => {
            assert.strictEqual(await utils.recheckPackageAbsent(path.join(wsRoot, "src", "lll")), false);
            assert.strictEqual(await utils.recheckPackageAbsent(path.join(wsRoot, "src", "gone")), true);
        });

        it("orderPythonExtraPaths: 规范组序(src → 其它 → install/site-packages → build → install/local/dist → /opt/ros),同组稳定", () => {
            const srcA = path.join(wsRoot, "src", "iii");
            const srcB = path.join(wsRoot, "src", "hi");
            const build = path.join(wsRoot, "build", "iii");
            const site = path.join(wsRoot, "install", "iii", "lib", "python3.10", "site-packages");
            const dist = path.join(wsRoot, "install", "p13_msgs", "local", "lib", "python3.10", "dist-packages");
            const opt = "/opt/ros/humble/lib/python3.10/site-packages";
            const custom = path.join(wsRoot, "custom", "user");
            const ordered = utils.orderPythonExtraPaths([opt, dist, build, srcA, custom, site, srcB], [srcA, srcB]);
            assert.strictEqual(ordered.length, 7, JSON.stringify(ordered));
            const idxOf = (d: string): number => ordered.indexOf(d);
            // 组序(2026-09-15 手稿):src(保持输入相对序 srcA→srcB)→ custom(其它)→ site-packages → build → local/dist → /opt/ros
            assert.ok(idxOf(srcA) < idxOf(srcB), JSON.stringify(ordered));
            assert.ok(idxOf(srcB) < idxOf(custom), JSON.stringify(ordered));
            assert.ok(idxOf(custom) < idxOf(site), JSON.stringify(ordered));
            assert.ok(idxOf(site) < idxOf(build), JSON.stringify(ordered));
            assert.ok(idxOf(build) < idxOf(dist), JSON.stringify(ordered));
            assert.ok(idxOf(dist) < idxOf(opt), JSON.stringify(ordered));
            // 同组稳定:同桶条目保持输入相对顺序(不 churn)
            const again = utils.orderPythonExtraPaths([srcB, srcA], [srcA, srcB]);
            assert.strictEqual(again[0], srcB, "组内应保持输入相对顺序:" + JSON.stringify(again));
        });
    });

    describe("render 渲染", function () {
        // 2026-10-15:整组跳过已拆除——它让 render 组在 npm test 里从未真正执行("tests=37 全过"是套件头空壳误读)。
        // python 依赖用例改为逐用例守卫(集成宿主 python.* 键不可写);cpp/clangd 用例两个宿主都真跑。

        it("syncCppProperties: 首次生成三键形状(name/includePath/compileCommands),标准字段不代写", async () => {
            const includes = [wsInc, incLll];
            await render.syncCppProperties(wsRoot, includes);
            const cpp = JSON.parse(fs.readFileSync(path.join(wsRoot, ".vscode", "c_cpp_properties.json"), "utf8"));
            const cfg0 = cpp.configurations[0];
            assert.deepStrictEqual(Object.keys(cfg0), ["name", "includePath", "compileCommands"], JSON.stringify(cfg0));
            assert.strictEqual(cfg0.includePath.length, 2, JSON.stringify(cfg0.includePath));
            assert.strictEqual(cfg0.compileCommands, "${workspaceFolder}/build/compile_commands.json");
            assert.strictEqual(cfg0.name, "ros2");
            assert.strictEqual(cfg0.cppStandard, undefined, "cppStandard 不代写");
            assert.strictEqual(cfg0.cStandard, undefined, "cStandard 不代写");
            assert.strictEqual(cfg0.browse, undefined, "browse 不代写");
        });

        it("syncCppProperties: 已存在 → 管辖条目重排在前(工作空间 src → 环境前缀),额外条目保留在后;标准字段不补不升", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            const eWs = utils.toCppIncludeEntry(wsInc, wsRoot);
            const eLll = utils.toCppIncludeEntry(incLll, wsRoot);
            const eIii = utils.toCppIncludeEntry(path.join(wsRoot, "install", "iii", "include"), wsRoot);
            // 旧文件:顺序颠倒 + 重复 + 残留 /usr/include + 用户自加条目 + 旧默认 gnu++17
            fs.writeFileSync(
                cppPath,
                JSON.stringify({
                    configurations: [{
                        includePath: [
                            eLll, // 环境条目(乱序在前)
                            "/opt/ros/humble/include/**", // 管辖外(旧版环境里也收录过,现视为额外)
                            "/usr/include/**", // 历史残留(编译器默认)→ 清除
                            eWs,
                            eWs, // 重复
                            "/custom/user/x/**",
                        ],
                        name: "ros2",
                        cppStandard: "gnu++17",
                    }],
                    version: 4,
                }));
            await render.syncCppProperties(wsRoot, [wsInc, incLll, path.join(wsRoot, "install", "iii", "include")]);
            const cpp = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            const cfg0 = cpp.configurations[0];
            const ip = cfg0.includePath;
            assert.strictEqual(new Set(ip).size, ip.length, JSON.stringify(ip));
            // 管辖条目规范序在前:src → install(环境前缀)
            assert.strictEqual(ip[0], eWs, JSON.stringify(ip));
            assert.strictEqual(ip[1], eLll, JSON.stringify(ip));
            assert.ok(ip.includes(eIii), JSON.stringify(ip));
            // 管辖外额外条目保留在尾(不参与顺序判断)
            assert.strictEqual(ip.filter((e: string) => e === "/custom/user/x/**").length, 1, JSON.stringify(ip));
            assert.strictEqual(ip.filter((e: string) => e === "/opt/ros/humble/include/**").length, 1, JSON.stringify(ip));
            // 残留 /usr/include 清除;重复折叠
            assert.ok(!ip.some((e: string) => e.includes("usr/include")), JSON.stringify(ip));
            // 标准字段不补不升(2026-10-14 所有权归用户):gnu++17 保留、cStandard/compileCommands 不出现
            assert.strictEqual(cfg0.cppStandard, "gnu++17", "用户/历史值保留,不再强翻 gnu++20");
            assert.strictEqual(cfg0.cStandard, undefined, "cStandard 不代写");
            assert.strictEqual(cfg0.compileCommands, undefined, "compileCommands 补写已废除");
        });

        it("syncCppProperties: 用户 cppStandard 永不触碰(gnu++23 保留,gnu++17 也不再强翻)", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            fs.writeFileSync(cppPath, JSON.stringify({
                configurations: [{ includePath: [], name: "ros2", cppStandard: "gnu++23" }],
                version: 4,
            }));
            await render.syncCppProperties(wsRoot, [wsInc]);
            let cpp = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            assert.strictEqual(cpp.configurations[0].cppStandard, "gnu++23");
            assert.strictEqual(cpp.configurations[0].compileCommands, undefined, "compileCommands 补写已废除");
            // 用户(或我方历史)手写的 gnu++17 同样不再被强翻 gnu++20
            fs.writeFileSync(cppPath, JSON.stringify({
                configurations: [{ includePath: [], name: "ros2", cppStandard: "gnu++17" }],
                version: 4,
            }));
            await render.syncCppProperties(wsRoot, [wsInc]);
            cpp = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            assert.strictEqual(cpp.configurations[0].cppStandard, "gnu++17", "标准字段所有权归用户");
        });

        it("syncCppProperties: 重复 includes 不产生重复条目(去重)", async () => {
            await render.syncCppProperties(wsRoot, [incLll, incLll, wsInc]);
            const cpp = JSON.parse(fs.readFileSync(path.join(wsRoot, ".vscode", "c_cpp_properties.json"), "utf8"));
            const ip = cpp.configurations[0].includePath;
            assert.strictEqual(new Set(ip).size, ip.length, JSON.stringify(ip));
            assert.strictEqual(ip.length, 2, JSON.stringify(ip));
        });

        it("removeCppIncludes: 删除指定条目,返回值正确", async () => {
            await render.syncCppProperties(wsRoot, [incLll, wsInc]);
            const target = utils.toCppIncludeEntry(incLll, wsRoot);
            const removed = await render.removeCppIncludes(wsRoot, [target]);
            const cpp = JSON.parse(fs.readFileSync(path.join(wsRoot, ".vscode", "c_cpp_properties.json"), "utf8"));
            assert.strictEqual(removed, 1);
            assert.ok(!cpp.configurations[0].includePath.includes(target));
        });

        it("syncClangd: 重复 includes 不产生重复 -I 行(去重)", async () => {
            await render.syncClangd(wsRoot, { ws: [wsInc, wsInc], sys: [] });
            const clangd = fs.readFileSync(path.join(wsRoot, ".clangd"), "utf8");
            const iLines = clangd.split("\n").map(canon).filter((l: string) => l.startsWith("-I"));
            assert.strictEqual(new Set(iLines).size, iLines.length, clangd);
            assert.strictEqual(iLines.length, 1, "ws 只列父根一行(不再展开 include/<pkg> 子行):" + clangd);
        });

        it("syncClangd: 首次生成嵌套 CompilationDatabase + 分组(-I 工作空间在前,-isystem 环境在后);再次 sync 幂等", async () => {
            const groups = { ws: [wsInc], sys: [incLll] };
            const clangdPath = path.join(wsRoot, ".clangd");
            await render.syncClangd(wsRoot, groups);
            const first = fs.readFileSync(clangdPath, "utf8");
            assert.ok(first.includes("-std=c++20"), first);
            assert.ok(first.includes("-Wall"), first);
            assert.ok(!/^CompilationDatabase:/m.test(first), "不应存在顶层 CompilationDatabase 无效键:\n" + first);
            assert.ok(/^\s{2}CompilationDatabase: build$/m.test(first), "CompilationDatabase 应为 CompileFlags 子键:\n" + first);
            // 分组顺序:标志 → 工作空间(-I 父根)→ 环境(-isystem 子根);只列一行消费根,不父子并列
            const toks = first.split("\n").map(canon);
            assert.ok(toks.includes("-I" + wsInc), first);
            assert.ok(!toks.includes("-I" + path.join(wsInc, "lll")), "ws 不应有 include/<pkg> 子行:" + first);
            assert.ok(toks.includes("-isystem" + path.join(incLll, "lll")), "env 应列子根 include/<pkg>:" + first);
            // sys 组末尾补一条"前缀 include 根"(单层包名 `include/<pkg>/x.hpp` 只有父根能解析;2026-09-16 裁定)
            assert.ok(toks.includes("-isystem" + incLll), "env 末尾应补 include 父根:" + first);
            assert.ok(first.lastIndexOf("-isystem" + incLll) > first.lastIndexOf("-isystem" + path.join(incLll, "lll")), "父根应排在子根之后:" + first);
            assert.ok(first.indexOf("-I" + wsInc) > first.indexOf(WS_MARK), first);
            assert.ok(first.indexOf(SYS_MARK) > first.indexOf("-I" + wsInc), first);
            assert.ok(first.indexOf("-isystem" + path.join(incLll, "lll")) > first.indexOf(SYS_MARK), first);
            await render.syncClangd(wsRoot, groups);
            const second = fs.readFileSync(clangdPath, "utf8");
            assert.strictEqual(first, second, "二次 sync 不应重复插入任何条目/注释");
        });

        it("syncClangd: 增量补新包 → 插入工作空间组内(环境组之前),不重复", async () => {
            const newInc = path.join(wsRoot, "src", "mmm", "include");
            fs.mkdirSync(path.join(newInc, "mmm"), { recursive: true });
            const clangdPath = path.join(wsRoot, ".clangd");
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
            await render.syncClangd(wsRoot, { ws: [wsInc, newInc], sys: [incLll] });
            const text = fs.readFileSync(clangdPath, "utf8");
            const toks = text.split("\n").map(canon);
            assert.strictEqual(toks.filter((l: string) => l === "-I" + newInc).length, 1, text);
            assert.ok(!toks.includes("-I" + path.join(newInc, "mmm")), "新包也不应展开 include/<pkg> 子行:" + text);
            assert.ok(text.indexOf("-I" + newInc) > text.indexOf(WS_MARK), "新条目应在工作空间组内:" + text);
            assert.ok(text.indexOf("-I" + newInc) < text.indexOf(SYS_MARK), "新工作区包条目不得越过环境组:" + text);
        });

        it("syncClangd: 历史顶层 CompilationDatabase 收编 + 旧 env 父根 -I 行归正为 -isystem 父根、子根补入", async () => {
            const clangdPath = path.join(wsRoot, ".clangd");
            fs.writeFileSync(clangdPath, "CompileFlags:\n  Add:\n    - -I" + incLll + "\nCompilationDatabase: build\n");
            await render.syncClangd(wsRoot, { ws: [], sys: [incLll] });
            const text = fs.readFileSync(clangdPath, "utf8");
            const toks = text.split("\n").map(canon);
            assert.ok(!/^CompilationDatabase:/m.test(text), "顶层无效键应移除:\n" + text);
            assert.ok(/^\s{2}CompilationDatabase: build$/m.test(text), "CompileFlags 子键应补齐:\n" + text);
            assert.ok(!toks.includes("-I" + incLll), "父根写成 -I 属错位形态,应移除:\n" + text);
            assert.strictEqual(toks.filter((l: string) => l === "-isystem" + incLll).length, 1, "父根应以 -isystem 规范形态存在一条:\n" + text);
            assert.strictEqual(toks.filter((l: string) => l === "-isystem" + path.join(incLll, "lll")).length, 1, "env 子根 include/<pkg> 应补入:" + text);
            assert.ok(toks.includes("-Wall"), "标志补入:" + text);
        });

        it("syncClangd: 布局切换后另一布局的安装组注释(孤儿)被清理,本布局注释保留(2026-09-16)", async () => {
            const clangdPath = path.join(wsRoot, ".clangd");
            const installRoot = path.join(wsRoot, "install", "lll", "include", "lll");
            const mergedRow = path.join(wsRoot, "install", "include", "lll");
            fs.writeFileSync(clangdPath,
                "CompileFlags:\n  CompilationDatabase: build\n  Add:\n" +
                "    " + INSTALL_MARK_MERGED + "\n" +
                "    - -isystem" + mergedRow + "\n" +
                "    " + INSTALL_MARK_ISOLATED + "\n" +
                "    - -isystem" + installRoot + "\n");
            await render.syncClangd(wsRoot, { ws: [], install: [installRoot], sys: [] }, "isolated");
            const text = fs.readFileSync(clangdPath, "utf8");
            assert.ok(!text.includes(INSTALL_MARK_MERGED), "另一布局的孤儿注释应清理:\n" + text);
            assert.ok(text.includes(INSTALL_MARK_ISOLATED), "本布局注释应保留:\n" + text);
            assert.ok(!text.includes("-isystem" + mergedRow), "merged 行应移除:\n" + text);
            assert.strictEqual(text.split("\n").filter((l: string) => canon(l) === "-isystem" + installRoot).length, 1, text);
        });

        it("syncClangd: 管辖内破坏性归正(重复行折叠、错位/旧形态清除),管辖外条目原地保留", async () => {
            const clangdPath = path.join(wsRoot, ".clangd");
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
            // 用户/旧版本改坏:env 子根写成 -I、工作空间条目重复、追加自定义 -I 与 -Wno 旗标
            let text = fs.readFileSync(clangdPath, "utf8");
            text = text.replace("-isystem" + incLll, "-I" + incLll) // 命中子根 token 前缀 → -I<incLll>/lll
                .replace("-I" + wsInc, "-I" + wsInc + "\n    - -I" + wsInc)
                + "    - -Wno-unused-parameter\n    - -I/custom/user/inc\n";
            fs.writeFileSync(clangdPath, text);
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
            const after = fs.readFileSync(clangdPath, "utf8");
            const toks = after.split("\n").map(canon);
            assert.ok(!toks.includes("-I" + path.join(incLll, "lll")), "env 子根写成 -I 应归正为 -isystem:" + after);
            assert.strictEqual(toks.filter((l: string) => l === "-isystem" + path.join(incLll, "lll")).length, 1, after);
            assert.strictEqual(toks.filter((l: string) => l === "-I" + wsInc).length, 1, "工作空间重复行应折叠:" + after);
            assert.ok(toks.includes("-Wno-unused-parameter"), "管辖外旗标保留:" + after);
            assert.strictEqual(toks.filter((l: string) => l === "-I/custom/user/inc").length, 1, "管辖外路径保留:" + after);
        });

        it("syncClangd: 残留 /usr/include 清除(编译器默认路径)", async () => {
            const clangdPath = path.join(wsRoot, ".clangd");
            fs.writeFileSync(clangdPath,
                "CompileFlags:\n  CompilationDatabase: build\n  Add:\n    - -I" + wsInc + "\n    - -I/usr/include\n    - -I/usr/include/x86_64-linux-gnu\n");
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [] });
            const after = fs.readFileSync(clangdPath, "utf8");
            assert.ok(!after.includes("/usr/include"), "残留 /usr/include 应清除:\n" + after);
            assert.ok(after.includes("-I" + wsInc), after);
        });

        it("syncClangd: flow 风格保守——缺失条目在 ] 前插入,不做归正", async () => {
            const clangdPath = path.join(wsRoot, ".clangd");
            fs.writeFileSync(clangdPath, "CompileFlags:\n  Add: [\n    -I" + incLll + ",\n  ]\n");
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
            const text = fs.readFileSync(clangdPath, "utf8");
            assert.ok(text.includes("-I" + incLll), "flow 内既有 -I 条目不动(不做 -isystem 归正):" + text);
            assert.ok(text.includes("    -I" + wsInc + ","), "缺失工作空间条目在 ] 前插入:" + text);
            assert.ok(text.includes("    -isystem" + path.join(incLll, "lll") + ","), "缺失环境条目以 -isystem 子根(include/<pkg>)规范插入:" + text);
            assert.strictEqual((text.match(/]/g) || []).length, 1, "flow 列表不应被破坏:" + text);
        });

        it("多事件循环: .clangd 与 c_cpp 反复增删/环境变化,不产生重复配置/整块重复;显式删除后不再复现", async () => {
            const clangdPath = path.join(wsRoot, ".clangd");
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            const pkgB = path.join(wsRoot, "src", "mmm", "include");
            fs.mkdirSync(path.join(pkgB, "mmm"), { recursive: true });
            const envB = path.join(wsRoot, "install", "iii", "include");
            const envC = path.join(wsRoot, "install", "p15", "include");
            fs.mkdirSync(path.join(envC, "p15"), { recursive: true });
            for (let round = 0; round < 3; round++) {
                await render.syncClangd(wsRoot, { ws: [wsInc], sys: [envB] });
                await render.syncCppProperties(wsRoot, [wsInc, envB]);
                await render.syncClangd(wsRoot, { ws: [wsInc, pkgB], sys: [envB, envC] });
                await render.syncCppProperties(wsRoot, [wsInc, pkgB, envB, envC]);
            }
            // 有感删除(确认后)→ 显式移除 pkgB;再次同步不应复现
            await render.removeClangdIncludes(wsRoot, [pkgB]);
            await render.removeCppIncludes(wsRoot, [utils.toCppIncludeEntry(pkgB, wsRoot)]);
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [envB] });
            await render.syncCppProperties(wsRoot, [wsInc, envB]);
            const cd = fs.readFileSync(clangdPath, "utf8");
            const cpp = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            // .clangd:单块、DB 一行、条目唯一
            assert.strictEqual((cd.match(/^CompileFlags:/gm) || []).length, 1, cd);
            assert.strictEqual((cd.match(/^\s*CompilationDatabase:/gm) || []).length, 1, cd);
            const toks = cd.split("\n").map(canon).filter(Boolean);
            assert.strictEqual(toks.filter((l: string) => l === "-Wall").length, 1, cd);
            assert.strictEqual(new Set(toks).size, toks.length, "条目不得重复:\n" + cd);
            assert.ok(!toks.some((l: string) => l.startsWith("-I" + pkgB)), "显式删除的包条目不应残留:" + cd);
            // c_cpp:单 configuration、includePath 唯一、显式删除条目不复现
            assert.strictEqual(cpp.configurations.length, 1, JSON.stringify(cpp));
            const ip = cpp.configurations[0].includePath;
            assert.strictEqual(new Set(ip).size, ip.length, JSON.stringify(ip));
            assert.ok(!ip.includes(utils.toCppIncludeEntry(pkgB, wsRoot)), JSON.stringify(ip));
        });

        it("removeClangdIncludes: 删除工作空间 -I 父根行(含历史遗留子行前缀匹配);组被删空时注释标记一并移除", async () => {
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [] });
            const removed = await render.removeClangdIncludes(wsRoot, [wsInc]);
            const clangd = fs.readFileSync(path.join(wsRoot, ".clangd"), "utf8");
            assert.ok(removed >= 1, "工作空间父根行应删除:" + removed);
            assert.ok(!clangd.includes("-I" + wsInc));
            assert.ok(!clangd.includes("-I" + path.join(wsInc, "lll")));
            assert.ok(!clangd.includes(WS_MARK), "被删空的组注释标记应移除:" + clangd);
            assert.ok(clangd.includes("-Wall"), "通用标志不应被删:" + clangd);
        });

        it("syncPythonPaths: 包根 + install 侧(按布局/存在性)+ develop 目录 + 补充语义(2026-09-15 手稿口径)", async function () {
            if (!HEADLESS) { this.skip(); return; } // 集成宿主 python.* 键不可写
            const entries = [
                { name: "iii", dir: path.join(wsRoot, "src", "iii"), buildType: "ament_python" },
                { name: "lll", dir: path.join(wsRoot, "src", "lll"), buildType: "ament_cmake" }, // C++ 包根不进 extraPaths(只进 C++ 侧)
            ];
            // 造出 install 侧落点(存在性过滤:只有真装了 python 的包才留下)
            const siteIii = path.join(wsRoot, "install", "iii", "lib", "python3.10", "site-packages");
            const distLll = path.join(wsRoot, "install", "lll", "local", "lib", "python3.10", "dist-packages");
            fs.mkdirSync(siteIii, { recursive: true });
            fs.mkdirSync(distLll, { recursive: true });
            await render.syncPythonPaths(wsRoot, entries, [path.join(wsRoot, "build", "iii")], "isolated");
            const cfg = vsc.workspace.getConfiguration();
            const analysis = cfg.get("python.analysis.extraPaths", []);
            // 管辖 = ①python 包根 src/iii ②install 侧(分包 site-packages / dist-packages)
            //        ③develop build/iii ④env 里重复的 build/iii(去重)
            assert.strictEqual(analysis.length, 4, JSON.stringify(analysis));
            assert.ok(!analysis.includes(path.join(wsRoot, "src", "lll")), "C++ 包根不应进 extraPaths");
            assert.deepStrictEqual(analysis, [
                path.join(wsRoot, "src", "iii"),
                siteIii,
                path.join(wsRoot, "build", "iii"),
                distLll,
            ], JSON.stringify(analysis));
            await cfg.update("python.analysis.extraPaths", ["/user/path", ...analysis]);
            await render.syncPythonPaths(wsRoot, entries, [path.join(wsRoot, "build", "iii"), "/new/env/path"], "isolated");
            const analysis2 = cfg.get("python.analysis.extraPaths", []);
            assert.ok(analysis2.includes("/user/path"), JSON.stringify(analysis2));
            assert.ok(analysis2.includes("/new/env/path"), JSON.stringify(analysis2));
            assert.strictEqual(analysis2.filter((e: string) => e === "/user/path").length, 1);
        });

        it("removePythonPaths: 从 extraPaths 移除指定目录条目", async function () {
            if (!HEADLESS) { this.skip(); return; } // 集成宿主 python.* 键不可写
            const entries = [{ name: "iii", dir: path.join(wsRoot, "src", "iii"), buildType: "ament_python" }];
            await render.syncPythonPaths(wsRoot, entries, [path.join(wsRoot, "build", "iii")]);
            const removed = await render.removePythonPaths(wsRoot, [path.join(wsRoot, "build", "iii")]);
            const cfg = vsc.workspace.getConfiguration();
            const analysis = cfg.get("python.analysis.extraPaths", []);
            assert.strictEqual(removed, 2, "analysis 与 autoComplete 两键各删一条");
            assert.ok(!analysis.includes(path.join(wsRoot, "build", "iii")), JSON.stringify(analysis));
            assert.ok(analysis.includes(path.join(wsRoot, "src", "iii")), "源码条目应保留");
        });

        it("syncPythonPaths: 规范重排只作用于管辖条目,用户自加条目原序留尾、队尾变动不重写(2026-09-09;组序 2026-09-15 对齐手稿)", async function () {
            if (!HEADLESS) { this.skip(); return; } // 集成宿主 python.* 键不可写
            const srcHi = path.join(wsRoot, "src", "hi");
            const srcIii = path.join(wsRoot, "src", "iii");
            const entries = [
                { name: "hi", dir: srcHi, buildType: "ament_python" },
                { name: "iii", dir: srcIii, buildType: "ament_python" },
                { name: "p13_msgs", dir: path.join(wsRoot, "src", "p13_msgs"), buildType: "ament_cmake" },
            ];
            const buildIii = path.join(wsRoot, "build", "iii");
            const buildHi = path.join(wsRoot, "build", "hi");
            const siteIii = path.join(wsRoot, "install", "iii", "lib", "python3.10", "site-packages");
            const distP13 = path.join(wsRoot, "install", "p13_msgs", "local", "lib", "python3.10", "dist-packages");
            fs.mkdirSync(siteIii, { recursive: true });
            fs.mkdirSync(distP13, { recursive: true });
            const optSite = "/opt/ros/humble/lib/python3.10/site-packages";
            const optDist = "/opt/ros/humble/local/lib/python3.10/dist-packages";
            const userB = path.join(wsRoot, "custom", "userB");
            const userA = path.join(wsRoot, "custom", "userA");
            const cfg = vsc.workspace.getConfiguration();
            // 预置:用户自加条目出现在最前(B)与最后(A),管辖条目乱序(官方在前 = 陈旧累积态)
            await cfg.update("python.analysis.extraPaths",
                [userB, optSite, optDist, distP13, srcIii, siteIii, buildIii, srcHi, userA]);
            const envArgs = [buildIii, siteIii, distP13, optSite, optDist];
            await render.syncPythonPaths(wsRoot, entries, envArgs, "isolated");
            const analysis = cfg.get("python.analysis.extraPaths", []);
            const idxOf = (d: string): number => analysis.indexOf(d);
            // 管辖段组序(手稿):src → install/site-packages → build(develop) → install/local/dist → /opt/ros
            assert.ok(Math.max(idxOf(srcHi), idxOf(srcIii)) < idxOf(siteIii), JSON.stringify(analysis));
            assert.ok(idxOf(siteIii) < idxOf(buildIii), JSON.stringify(analysis));
            assert.ok(idxOf(buildIii) < idxOf(distP13), JSON.stringify(analysis));
            assert.ok(idxOf(distP13) < idxOf(optSite), JSON.stringify(analysis));
            assert.ok(idxOf(optSite) < idxOf(optDist), JSON.stringify(analysis));
            assert.ok(analysis.includes(buildHi), "python 包的 develop 目录也应一并收录:" + JSON.stringify(analysis));
            // 用户条目不被按桶排序:原相对顺序(userB 原在 userA 前)整体留在队尾
            assert.ok(idxOf(optDist) < idxOf(userB) && idxOf(userB) < idxOf(userA), JSON.stringify(analysis));
            // 只改用户队尾顺序 → 不应触发重写(比较只看管辖段)
            const swapped = [...analysis.filter((d: string) => d !== userB && d !== userA), userA, userB];
            await cfg.update("python.analysis.extraPaths", swapped);
            await render.syncPythonPaths(wsRoot, entries, envArgs, "isolated");
            assert.deepStrictEqual(cfg.get("python.analysis.extraPaths", []), swapped, "队尾用户条目顺序变化不应被重写");
            // 幂等:原样再同步一次同样零变化
            await render.syncPythonPaths(wsRoot, entries, envArgs, "isolated");
            assert.deepStrictEqual(cfg.get("python.analysis.extraPaths", []), swapped);
        });

        it("syncPythonPaths: 发行版模板透传(jazzy)→ install 侧按 python3.12/site-packages 出条目;切回缺省 humble 由旧形状删除机制清替(2026-09-28 VD)", async function () {
            // 集成宿主(npm test)未注册 python.* 配置键 → cfg.update 抛 CodeExpectedError(与同套件 4 条存量失败同根因);
            // 本用例的价值在"透传 + 旧形状清替"语义(无头 mocha 全量断言),环境不支持时跳过、不入失败集
            try {
                await vsc.workspace.getConfiguration().update("python.analysis.exclude", []);
            } catch {
                this.skip();
                return;
            }
            const entries = [
                { name: "iii", dir: path.join(wsRoot, "src", "iii"), buildType: "ament_python" },
                { name: "lll", dir: path.join(wsRoot, "src", "lll"), buildType: "ament_cmake" },
            ];
            const cfg = vsc.workspace.getConfiguration();
            // jazzy 模板:ament_python → lib/python3.12/site-packages;ament_cmake(接口/混合包)→ lib/python3.12/site-packages(Iron+ 形态)
            await render.syncPythonPaths(wsRoot, entries, [], "isolated", dt.DISTRO_PATH_TEMPLATES.jazzy);
            let analysis = cfg.get("python.analysis.extraPaths", []);
            assert.ok(analysis.includes(path.join(wsRoot, "install", "iii", "lib", "python3.12", "site-packages")), JSON.stringify(analysis));
            assert.ok(analysis.includes(path.join(wsRoot, "install", "lll", "lib", "python3.12", "site-packages")), JSON.stringify(analysis));
            assert.ok(!analysis.some((e: string) => e.includes("python3.10") || e.includes("dist-packages")), JSON.stringify(analysis));
            // 缺省参 = DEFAULT humble → 历史形状不变;且上一轮的 python3.12 旧形状条目被"旧形状残留直接删除"清替
            await render.syncPythonPaths(wsRoot, entries, [], "isolated");
            analysis = cfg.get("python.analysis.extraPaths", []);
            assert.ok(analysis.includes(path.join(wsRoot, "install", "iii", "lib", "python3.10", "site-packages")), JSON.stringify(analysis));
            assert.ok(analysis.includes(path.join(wsRoot, "install", "lll", "local", "lib", "python3.10", "dist-packages")), JSON.stringify(analysis));
            assert.ok(!analysis.some((e: string) => e.includes("python3.12")), "发行版切换后旧模板形状条目应被清替:" + JSON.stringify(analysis));
        });

        it("有感删除预检: cppIncludeEntryExists / clangdIncludeExists / pythonPathExists(与 remove* 同口径,2026-09-08)", async function () {
            if (!HEADLESS) { this.skip(); return; } // 集成宿主 python.* 键不可写
            const pyEntry = { name: "iii", dir: path.join(wsRoot, "src", "iii"), buildType: "ament_python" };
            // ① 先同步出真实配置状态(cpp includePath / .clangd -I / python extraPaths)
            await render.syncCppProperties(wsRoot, [wsInc, incLll]);
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
            await render.syncPythonPaths(wsRoot, [pyEntry], []);
            const cppEntry = utils.toCppIncludeEntry(wsInc, wsRoot);
            // ② cpp 侧:存在的条目 true;不存在的 false
            assert.strictEqual(await render.cppIncludeEntryExists(wsRoot, cppEntry), true);
            assert.strictEqual(await render.cppIncludeEntryExists(wsRoot, utils.toCppIncludeEntry(path.join(wsRoot, "src", "gone"), wsRoot)), false);
            // ③ clangd 侧:工作空间父根 -I 行 true;未收录目录 false(历史子行形态由 remove* 口径覆盖,预检同款前缀匹配)
            assert.strictEqual(await render.clangdIncludeExists(wsRoot, wsInc), true);
            assert.strictEqual(await render.clangdIncludeExists(wsRoot, path.join(wsRoot, "src", "gone", "include")), false);
            // ④ python 侧:包根入 extraPaths → true;未收录目录 false
            assert.strictEqual(await render.pythonPathExists(path.join(wsRoot, "src", "iii")), true);
            assert.strictEqual(await render.pythonPathExists(path.join(wsRoot, "src", "gone")), false);
            // ⑤ 与 remove* 行为一致:预检 false 的条目,remove 返回 0(无命中类不弹窗的前提)
            assert.strictEqual(await render.removeCppIncludes(wsRoot, [utils.toCppIncludeEntry(path.join(wsRoot, "src", "gone"), wsRoot)]), 0);
        });

        // ---- 生成条目替换表(ROS2.ide.entryOverrides,2026-10-14):链式至不动点 + 两遍法落位 ----

        it("键名锁: 三张替换表键名(与 package.json/nls/docs 三方一致,三文件分辖撞 key 结构性不可能)", () => {
            assert.strictEqual(render.ENTRY_OVERRIDES_CLANGD_SETTING, "ide.entryOverrides.clangd");
            assert.strictEqual(render.ENTRY_OVERRIDES_CPPTOOLS_SETTING, "ide.entryOverrides.cpptools");
            assert.strictEqual(render.ENTRY_OVERRIDES_PYTHON_SETTING, "ide.entryOverrides.python");
        });

        it("applyEntryOverrides: 链式一步到位(A→B,B→C 单次得 C)/ 空值删除 / 环剔除 / 无表恒等", () => {
            // 链式:A→B、B→C → 单次解析直达 C(不链式 = 时间上链式,几十条规则波动几十轮)
            const chain = render.applyEntryOverrides(["A", "B", "C"], { A: "B", B: "C" });
            assert.deepStrictEqual(chain.list, ["C"]);
            assert.strictEqual(chain.cycles, 0);
            // 空值:A→"" → A 删除,dropped 收原条目
            const drop = render.applyEntryOverrides(["A", "N"], { A: "" });
            assert.deepStrictEqual(drop.list, ["N"]);
            assert.ok(drop.dropped.has("A"), JSON.stringify([...drop.dropped]));
            // 环:A→B→A → 剔除该条目(防无限循环与来回翻转)
            const cyc = render.applyEntryOverrides(["A", "N"], { A: "B", B: "A" });
            assert.deepStrictEqual(cyc.list, ["N"]);
            assert.strictEqual(cyc.cycles, 1);
            // 无表恒等(顺序保持)
            assert.deepStrictEqual(render.applyEntryOverrides(["X", "Y"], {}).list, ["X", "Y"]);
            // 自映射 A→A = 环(一次自跳即见已见)
            const self = render.applyEntryOverrides(["A"], { A: "A" });
            assert.deepStrictEqual(self.list, []);
            assert.strictEqual(self.cycles, 1);
        });

        it("applyEntryOverrides: 原生优先占位、撞车丢映射副本;映射值未撞车正常落位", () => {
            // 原生 B 在集 → A→B 的映射副本丢弃,留原生 B(「去用户副本留原生」)
            const collide = render.applyEntryOverrides(["B", "A"], { A: "B" });
            assert.deepStrictEqual(collide.list, ["B"]);
            // 未撞车:替换值正常落位,key 被顶替
            const move = render.applyEntryOverrides(["A"], { A: "Q" });
            assert.deepStrictEqual(move.list, ["Q"]);
        });

        it("syncClangd 集成: -std=c++20 → -std=c++17 原位收敛(旧生成物一次同步替换),二次同步幂等", async () => {
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] }); // 先生成旧形态(-std=c++20)
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] }, "isolated", { "-std=c++20": "-std=c++17" });
            let text = fs.readFileSync(path.join(wsRoot, ".clangd"), "utf8");
            let toks = text.split("\n").map(canon);
            assert.ok(toks.includes("-std=c++17"), text);
            assert.ok(!toks.includes("-std=c++20"), "旧 token 行应被原位替换:" + text);
            // 幂等:同表再同步,不翻回、不产生重复 -std 行
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] }, "isolated", { "-std=c++20": "-std=c++17" });
            text = fs.readFileSync(path.join(wsRoot, ".clangd"), "utf8");
            toks = text.split("\n").map(canon);
            assert.strictEqual(toks.filter((t: string) => t.startsWith("-std=")).length, 1, text);
            assert.ok(toks.includes("-std=c++17"), text);
        });

        it("syncClangd 集成: -I 空值覆盖 → 行删除且组注释随之清理,缺失补入不复现", async () => {
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
            const key = "-I" + wsInc;
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] }, "isolated", { [key]: "" });
            const text = fs.readFileSync(path.join(wsRoot, ".clangd"), "utf8");
            assert.ok(!text.split("\n").map(canon).includes(key), "空值链命中的行应删除:" + text);
            assert.ok(!text.includes("工作空间包 include"), "被删空的组注释应一并清理:" + text);
            assert.ok(text.includes("-isystem" + incLll), "未覆盖条目保留:" + text);
        });

        it("syncCppProperties 集成: includePath 空值覆盖 → 条目从文件移除,未覆盖条目保留", async () => {
            await render.syncCppProperties(wsRoot, [wsInc, incLll]);
            const eWs = utils.toCppIncludeEntry(wsInc, wsRoot);
            await render.syncCppProperties(wsRoot, [wsInc, incLll], { [eWs]: "" });
            const cpp = JSON.parse(fs.readFileSync(path.join(wsRoot, ".vscode", "c_cpp_properties.json"), "utf8"));
            const ip = cpp.configurations[0].includePath;
            assert.ok(!ip.includes(eWs), JSON.stringify(ip));
            assert.ok(ip.includes(utils.toCppIncludeEntry(incLll, wsRoot)), "未覆盖条目保留:" + JSON.stringify(ip));
        });

        it("syncCppProperties 集成: 替换值落位 + 文件旧形态清除(不经「管辖外」通道回流队尾)", async () => {
            await render.syncCppProperties(wsRoot, [wsInc]);
            const eWs = utils.toCppIncludeEntry(wsInc, wsRoot);
            const replacement = "${workspaceFolder}/custom/inc";
            await render.syncCppProperties(wsRoot, [wsInc], { [eWs]: replacement });
            const ip = JSON.parse(fs.readFileSync(path.join(wsRoot, ".vscode", "c_cpp_properties.json"), "utf8")).configurations[0].includePath;
            assert.ok(ip.includes(replacement), JSON.stringify(ip));
            assert.strictEqual(ip.filter((e: string) => e === eWs).length, 0, "旧形态不得回流队尾:" + JSON.stringify(ip));
        });

        it("syncPythonPaths 集成: extraPaths 替换生效(替换值入表,原包根清除且不回流)", async function () {
            if (!HEADLESS) { this.skip(); return; } // 集成宿主 python.* 键不可写
            const entries = [{ name: "iii", dir: path.join(wsRoot, "src", "iii"), buildType: "ament_python" }];
            await render.syncPythonPaths(wsRoot, entries, []);
            const cfg = vsc.workspace.getConfiguration();
            const pkgRoot = path.join(wsRoot, "src", "iii");
            const replacement = path.join(wsRoot, "custom", "pyinc");
            await render.syncPythonPaths(wsRoot, entries, [], "isolated", undefined, { [pkgRoot]: replacement });
            const analysis = cfg.get("python.analysis.extraPaths", []);
            assert.ok(analysis.includes(replacement), JSON.stringify(analysis));
            assert.ok(!analysis.includes(pkgRoot), "原包根应被清除且不经「用户条目」通道回流:" + JSON.stringify(analysis));
        });

        // ---- 接管排序(ROS2.ide.clangdTidy 默认关)+ 分组注释 L10N(2026-10-14) ----

        it("clangdMarkerOf 双语表: zh 逐字节同历史(存量匹配依赖),en 成套,install 随布局", () => {
            assert.strictEqual(render.clangdMarkerOf("flags", "zh-cn"), "# ---- 编译标志(与 include 无关) ----");
            assert.strictEqual(render.clangdMarkerOf("ws", "zh-cn"), "# ---- 工作空间包 include(工作空间在前,-I) ----");
            assert.strictEqual(render.clangdMarkerOf("sys", "zh-cn"), "# ---- 环境前缀 include:发行版(在后,-isystem) ----");
            assert.strictEqual(render.clangdMarkerOf("install", "zh-cn", "isolated"), "# ---- 工作空间安装产物 include:isolated install/<pkg>/include(在后,-isystem) ----");
            assert.strictEqual(render.clangdMarkerOf("install", "zh-cn", "merged"), "# ---- 工作空间安装产物 include:merged install/include(在后,-isystem) ----");
            for (const id of ["flags", "ws", "sys"] as const) {
                assert.ok(render.clangdMarkerOf(id, "en").startsWith("# ---- "), id);
                assert.notStrictEqual(render.clangdMarkerOf(id, "en"), render.clangdMarkerOf(id, "zh-cn"), id);
            }
            assert.ok(render.clangdMarkerOf("install", "en", "merged").includes("merged install/include"));
        });

        it("tidyClangdAddLines 纯函数: 乱序→规范组序+重钉注释+用户行原序移尾;已规范→null;跨语言旧标记识别", () => {
            const mk = (rows: string[]): string[] => ["CompileFlags:", "  CompilationDatabase: build", "  Add:", ...rows];
            const managed = { flags: ["-Wall", "-std=c++20"], ws: ["-I/ws/a/include"], install: [], sys: ["-isystem/opt/ros/humble/include/common"] };
            // 乱序 + 旧(zh)标记 + 用户注释/用户条目
            const messy = mk([
                "    " + render.clangdMarkerOf("sys", "zh-cn"),
                "    - -isystem/opt/ros/humble/include/common",
                "    - -I/ws/a/include",
                "    - -Wall",
                "    # my own note",
                "    - -std=c++20",
                "    - -I/user/custom/inc",
                "",
            ]);
            const out = render.tidyClangdAddLines(messy, 2, messy.length - 1, managed, "en", "isolated");
            assert.ok(out, "乱序必须产出新形态");
            // token 视图:剥 "- " 前缀(否则 indexOf 全部撞在 2,断言失真——2026-10-15 教训)
            const body = out.slice(3, out.length - 1).map((l: string) => { const t = l.trim(); return t.startsWith("- ") ? t.slice(2).trim() : t; });
            const ti = (s: string): number => body.indexOf(s);
            assert.ok(ti("# ---- Compile flags (unrelated to includes) ----") >= 0, "重钉当前语言(en)注释:" + body.join("|"));
            assert.ok(ti("-Wall") < ti("-std=c++20") && ti("-std=c++20") < ti("-I/ws/a/include"), body.join("|"));
            assert.ok(ti("-I/ws/a/include") < ti("-isystem/opt/ros/humble/include/common"), body.join("|"));
            assert.ok(!body.some((l: string) => l.includes("工作空间") || l.includes("编译标志")), "旧语言标记行不得带入:" + body.join("|"));
            assert.ok(ti("# my own note") > ti("-isystem/opt/ros/humble/include/common"), "用户注释原序移尾:" + body.join("|"));
            assert.ok(ti("-I/user/custom/inc") > ti("# my own note"), "用户条目在注释之后:" + body.join("|"));
            // 已规范 → null(零写盘)
            const tidyFile = mk([
                "    " + render.clangdMarkerOf("flags", "en"),
                "    - -Wall",
                "    - -std=c++20",
                "    " + render.clangdMarkerOf("ws", "en"),
                "    - -I/ws/a/include",
                "    " + render.clangdMarkerOf("sys", "en"),
                "    - -isystem/opt/ros/humble/include/common",
                "    - -I/user/custom/inc",
                "",
            ]);
            assert.strictEqual(render.tidyClangdAddLines(tidyFile, 2, tidyFile.length - 1, managed, "en", "isolated"), null);
            // 按旧语言(zh)重排 → 重钉 zh 注释,不带 en 注释
            const zhTidy = render.tidyClangdAddLines(messy, 2, messy.length - 1, managed, "zh-cn", "isolated");
            assert.ok(zhTidy && zhTidy.some((l: string) => l.includes("编译标志")), "zh 重钉应出 zh 注释");
            assert.ok(!zhTidy.some((l: string) => l.includes("Compile flags")), "zh 形态不应带 en 注释");
        });

        it("tidyClangdAddLines 缺失注入(2026-10-15,用户实测 -std=c++20 永久丢失): 缺席管辖 token 按组补回;外行承载不双写;全缺失全补", () => {
            const mk = (rows: string[]): string[] => ["CompileFlags:", "  CompilationDatabase: build", "  Add:", ...rows];
            const managed = { flags: ["-Wall", "-std=c++20"], ws: ["-I/ws/a/include"], install: [], sys: ["-isystem/opt/ros/humble/include/common"] };
            const tokens = (out: string[]): string[] =>
                out.filter((l: string) => l.trim().startsWith("- ")).map((l: string) => l.trim().slice(2).trim());
            // ① 缺席的管辖 token(用户删过行)必须按组补回:flags 缺 -std=c++20、ws 缺 -I(另有一行非管辖 -I)
            const missing = mk([
                "    " + render.clangdMarkerOf("flags", "en"),
                "    - -Wall",
                "    " + render.clangdMarkerOf("ws", "en"),
                "    - -I/ws/other/include",
                "    " + render.clangdMarkerOf("sys", "en"),
                "    - -isystem/opt/ros/humble/include/common",
            ]);
            const out1 = render.tidyClangdAddLines(missing, 2, missing.length, managed, "en", "isolated");
            assert.ok(out1, "缺 token 必须产出新形态");
            const t1 = tokens(out1);
            for (const t of ["-Wall", "-std=c++20", "-I/ws/a/include", "-isystem/opt/ros/humble/include/common"]) {
                assert.ok(t1.includes(t), `缺失 token ${t} 必须被注入:${JSON.stringify(t1)}`);
            }
            // 注入行落在本组:-std=c++20 在 ws 标记之前(规范组序 flags→ws)
            const iStd = out1.findIndex((l: string) => l.includes("-std=c++20"));
            const iWsMark = out1.findIndex((l: string) => l === "    " + render.clangdMarkerOf("ws", "en"));
            assert.ok(iStd > 2 && iStd < iWsMark, `注入应落 flags 组内:${JSON.stringify(out1)}`);
            assert.ok(t1.includes("-I/ws/other/include"), "非管辖 -I 行照旧保留(原序移尾)");
            // ② 外行承载不双写:行内注释行 "- -Wall # keep" 以原样保留为准,不再裸注入 -Wall
            const carried = mk([
                "    - -Wall # keep",
                "    " + render.clangdMarkerOf("ws", "en"),
                "    - -I/ws/a/include",
            ]);
            const out2 = render.tidyClangdAddLines(carried, 2, carried.length, managed, "en", "isolated");
            assert.ok(out2);
            const t2 = tokens(out2);
            assert.ok(!t2.includes("-Wall"), "裸 -Wall 不得重复注入(用户行已承载):" + JSON.stringify(t2));
            assert.ok(t2.some((t) => t.startsWith("-Wall #")), "用户行原样保留:" + JSON.stringify(t2));
            assert.ok(t2.includes("-std=c++20"), "缺失的 -std=c++20 照常注入:" + JSON.stringify(t2));
            // ③ 性质钉(防再犯):全缺失场景(Add 块无任何行)→ 全部管辖 token 必须出现在输出
            const empty = mk([]);
            const out3 = render.tidyClangdAddLines(empty, 2, empty.length, managed, "en", "isolated");
            assert.ok(out3);
            const t3 = tokens(out3);
            for (const g of [managed.flags, managed.ws, managed.install, managed.sys]) {
                for (const t of g) {
                    assert.ok(t3.includes(t), `全缺失场景 ${t} 必须补入:${JSON.stringify(t3)}`);
                }
            }
        });

        it("syncClangd 集成: clangdTidy 开 → 乱序一轮愈合(规范序+注释重钉+幂等零写盘),关 → 原行为(乱序保留)", async () => {
            const cfg = vsc.workspace.getConfiguration("ROS2");
            const messy = [
                "CompileFlags:",
                "  CompilationDatabase: build",
                "  Add:",
                `    - -isystem${incLll}`,
                `    - -I${wsInc}`,
                "    - -Wall",
                "    - -std=c++20",
                "",
            ].join("\n");
            // 关(默认):既有行为——乱序保留,缺失补入,不挪既有行
            fs.writeFileSync(path.join(wsRoot, ".clangd"), messy);
            await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
            const off = fs.readFileSync(path.join(wsRoot, ".clangd"), "utf8");
            assert.ok(off.indexOf(`-isystem${incLll}`) < off.indexOf(`-I${wsInc}`), "关:乱序不得被挪动:" + off);
            // 开:一轮愈合
            await cfg.update("ide.clangdTidy", true);
            try {
                await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
                const on = fs.readFileSync(path.join(wsRoot, ".clangd"), "utf8");
                const toks = on.split("\n").map(canon);
                const iFlags = toks.indexOf(FLAGS_MARK), iWs = toks.indexOf(WS_MARK), iSys = toks.indexOf(SYS_MARK);
                assert.ok(iFlags >= 0 && iWs > iFlags && iSys > iWs, "开:规范组序+注释重钉:" + on);
                assert.ok(toks.indexOf("-Wall") > iFlags && toks.indexOf("-std=c++20") > iFlags && toks.indexOf("-std=c++20") < iWs, on);
                assert.ok(toks.indexOf("-I" + wsInc) > iWs && toks.indexOf("-I" + wsInc) < iSys, on);
                assert.ok(toks.indexOf("-isystem" + incLll) > iSys, on);
                // 幂等:再同步零写盘
                const m1 = fs.statSync(path.join(wsRoot, ".clangd")).mtimeMs;
                await render.syncClangd(wsRoot, { ws: [wsInc], sys: [incLll] });
                assert.strictEqual(fs.statSync(path.join(wsRoot, ".clangd")).mtimeMs, m1, "已规范 → 零写盘");
            } finally {
                await cfg.update("ide.clangdTidy", false);
            }
        });

        // ---- c_cpp_properties 鲁棒化(2026-10-14):ros2 白名单接管 + 外科手术 + JSONC 宽容解析 ----

        it("鲁棒化: 找到 name=ros2 成员接管——前后用户成员与顶层自定义键零接触", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            const userA = { name: "user-a", compilerPath: "/usr/bin/clang", cStandard: "c17" };
            const ros2 = { name: "ros2", includePath: ["${workspaceFolder}/src/lll/include/**"], cppStandard: "gnu++17" };
            const userB = { name: "user-b", customField: { x: 1 } };
            fs.writeFileSync(cppPath, JSON.stringify({ configurations: [userA, ros2, userB], version: 4, myTopLevel: "keep" }));
            await render.syncCppProperties(wsRoot, [wsInc]);
            const after = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            assert.strictEqual(after.configurations.length, 3);
            assert.deepStrictEqual(after.configurations[0], userA, "用户成员 A 零接触");
            assert.deepStrictEqual(after.configurations[2], userB, "用户成员 B 零接触");
            assert.strictEqual(after.configurations[1].name, "ros2");
            assert.ok(after.configurations[1].includePath.includes(utils.toCppIncludeEntry(wsInc, wsRoot)), JSON.stringify(after.configurations[1]));
            assert.strictEqual(after.configurations[1].cppStandard, "gnu++17", "标准字段所有权归用户,保留不升");
            assert.strictEqual(after.myTopLevel, "keep", "顶层自定义键保留");
        });

        it("鲁棒化: 未找到 ros2 → 追加末尾([0] 用户配置零位移零接触),version 缺失补 4", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            fs.writeFileSync(cppPath, JSON.stringify({ configurations: [{ name: "user-a", includePath: ["/custom/**"] }] }));
            await render.syncCppProperties(wsRoot, [wsInc]);
            const after = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            assert.strictEqual(after.configurations.length, 2);
            assert.deepStrictEqual(after.configurations[0], { name: "user-a", includePath: ["/custom/**"] }, "[0] 零位移零接触");
            assert.strictEqual(after.configurations[1].name, "ros2");
            assert.strictEqual(after.version, 4);
        });

        it("鲁棒化: 重复 ros2 成员清理(保留最前一个接管,其余删除,用户成员保留)", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            const first = { name: "ros2", includePath: ["${workspaceFolder}/src/lll/include/**"] };
            const dup = { name: "ros2", includePath: ["/stale/**"] };
            const user = { name: "user-a" };
            fs.writeFileSync(cppPath, JSON.stringify({ configurations: [first, user, dup] }));
            await render.syncCppProperties(wsRoot, [wsInc]);
            const after = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            assert.strictEqual(after.configurations.length, 2, JSON.stringify(after));
            assert.strictEqual(after.configurations[0].name, "ros2");
            assert.ok(after.configurations[0].includePath.includes(utils.toCppIncludeEntry(wsInc, wsRoot)), JSON.stringify(after.configurations[0]));
            assert.deepStrictEqual(after.configurations[1], user);
        });

        it("鲁棒化: 成员内删 includePath 键 → 外科补字段(browse/其余字段/键序保留,includePath 尾插)", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            const member = {
                name: "ros2",
                browse: { databaseFilename: "${workspaceFolder}/.vscode/browse.vc.db", limitSymbolsToIncludedHeaders: false },
                compileCommands: "${workspaceFolder}/build/compile_commands.json",
                cppStandard: "gnu++23", // 用户自定义:不升级(仅升我方旧默认 gnu++17)
                cStandard: "gnu11",
            };
            fs.writeFileSync(cppPath, JSON.stringify({ configurations: [member], version: 4 }));
            await render.syncCppProperties(wsRoot, [wsInc]);
            const after = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            const cfg = after.configurations[0];
            assert.deepStrictEqual(cfg.browse, member.browse, "browse 保留(今天案:旧实现此处陪葬)");
            assert.strictEqual(cfg.cppStandard, "gnu++23", "用户自定义值保留");
            assert.strictEqual(cfg.compileCommands, member.compileCommands);
            const keys = Object.keys(cfg);
            assert.strictEqual(keys[0], "name", "键序保留(name 仍在首)");
            assert.strictEqual(keys[keys.length - 1], "includePath", "补入的 includePath 尾插");
            assert.ok(cfg.includePath.includes(utils.toCppIncludeEntry(wsInc, wsRoot)));
        });

        it("鲁棒化: JSONC 宽容解析(注释+尾逗号)→ 合并重写后数据字段全保留(注释丢失)", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            const text = [
                "{",
                "  // my custom note",
                "  /* block note */",
                '  "configurations": [',
                "    {",
                '      "name": "ros2",',
                '      "browse": { "databaseFilename": "db", "limitSymbolsToIncludedHeaders": false },',
                '      "includePath": [',
                '        "/stale/**",',
                "      ],",
                '      "cppStandard": "gnu++20",',
                "    },",
                "  ],",
                '  "version": 4,',
                "}",
            ].join("\n");
            // includePath 故意给 stale 值 → 合并必然产生变更 → 触发重写(无变更时零写盘,注释反而保留)
            fs.writeFileSync(cppPath, text);
            await render.syncCppProperties(wsRoot, [wsInc]);
            const after = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            const cfg = after.configurations[0];
            assert.deepStrictEqual(cfg.browse, { databaseFilename: "db", limitSymbolsToIncludedHeaders: false }, "browse 字段保留");
            assert.strictEqual(cfg.includePath[0], utils.toCppIncludeEntry(wsInc, wsRoot), "规范条目在前");
            assert.ok(cfg.includePath.includes("/stale/**"), "stale 条目按管辖外保留队尾:" + JSON.stringify(cfg.includePath));
            assert.ok(!fs.readFileSync(cppPath, "utf8").includes("// my custom note"), "宽容模式写盘丢注释(日志已声明)");
        });

        it("鲁棒化: 彻底报废(完全无法解析)→ 迫不得已从零生成(唯一弃稿场景)", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            fs.writeFileSync(cppPath, "@@@not json at all@@@");
            await render.syncCppProperties(wsRoot, [wsInc]);
            const after = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            assert.strictEqual(after.configurations.length, 1);
            assert.strictEqual(after.configurations[0].name, "ros2");
            assert.strictEqual(after.version, 4);
            assert.deepStrictEqual(Object.keys(after.configurations[0]), ["name", "includePath", "compileCommands"], "三键形状");
        });
    });
});
// 修改时间:2026-09-08 22:53(+1 用例:有感删除预检三函数 24→25;渲染组删空/多事件循环等语义不变)
// 修改时间:2026-09-09 01:43(+2 用例 25→27:orderPythonExtraPaths 规范组序 / syncPythonPaths 已有列表整块规范重排)
// 修改时间:2026-09-09 01:52(重排仅管辖条目:用户自加条目原序留队尾、只改队尾不重写,断言并入 syncPythonPaths 用例)
// 修改时间:2026-09-28(VD-3:+1 用例 27→28:syncPythonPaths 发行版模板透传(jazzy)与切回缺省的旧形状清替;
// 集成宿主不注册 python.* 配置键 → 用例探针 update 失败即 this.skip()(同套件 4 条存量失败同根因,不入失败集);
// 新增 distro-templates.test.ts 承接纯函数组)
// 修改时间:2026-10-14(+8 用例:生成条目替换表 ROS2.ide.entryOverrides——键名锁 / applyEntryOverrides 纯函数
// 链式一步到位·空值删除·环剔除·无表恒等·自映射即环·原生优先撞车丢映射副本 / clangd -std 原位收敛幂等 +
// -I 空值删行清注释 / cpp includePath 空值移除 + 替换值落位旧形态不回流 / python extraPaths 替换生效)
// 修改时间:2026-10-14(替换表同日拆分为三键 ide.entryOverrides.clangd/cpptools/python:键名锁 1→3 断言,
// 纯函数与集成 7 例零改动(sync 直收本文件专属表,例数保持))
// 修改时间:2026-10-14(接管排序 ROS2.ide.clangdTidy(默认关)+ 分组注释 L10N:+3 用例(双语表 zh 逐字节同
// 历史/tidy 纯函数 规范序·重钉·用户行移尾·已规范 null·跨语言标记识别/集成 开关对照+幂等零写盘);
// 文件头 5 个标记常量改从 render 双语表按 currentMarkerLang 取(测试宿主 --locale=en → en 文本))
// 修改时间:2026-10-14(c_cpp_properties 鲁棒化 +6 用例:ros2 白名单接管用户成员零接触/未找到追加末尾 version 补 4/
// 重复 ros2 清理保留最前/成员内删 includePath 键外科补字段 browse·键序保留/JSONC 宽容解析注释丢失/彻底报废从零生成)
// 修改时间:2026-10-14(标准字段收缩:5 处断言改写——首次生成三键形状/已存在 gnu++17 保留+compileCommands 不补/用户 cppStandard 永不触碰含 gnu++17/鲁棒化接管保留 gnu++17/报废重建三键形状;例数不变)
// 修改时间:2026-10-15(测试假绿根治:render 组整组 before-skip 拆除——stub 旗标集成宿主不置致套件空壳(tests=37/零 testcase/time=0.000)被误读为全过,本会话 render 层四批用例实际未跑;cpp/clangd 用例双宿主真跑,python 依赖 5 用例逐例守卫(HEADLESS 旗标);tidy 用例 body 改 token 视图修 indexOf 撞位;JSONC 用例改 stale includePath 制造真实变更;npm test render 31 实跑 0 失败)
