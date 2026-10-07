/**
 * intellisense-config 渲染测试(无头 mocha,临时目录 fixture)
 *
 * 验证 config/gen 配置生成的核心逻辑(2026-09-07 语义):
 *  - utils 层:toCppIncludeEntry 路径映射 / 系统 include 命中与跳过 / PYTHONPATH 拆分 /
 *            clangdGroupDirs(工作空间=父根一行、环境=各包子根一行,【约定 B】不父子并列,
 *            跨组去重工作空间优先)/ 解析注释容错
 *  - render 层:syncCppProperties(缺失→生成含 gnu++20/compileCommands;已存在→includePath 管辖
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
const req = createRequire(__filename);
const utils = req("../../src/build-tool/package-service/config/gen/intellisense-utils") as any;
const render = req("../../src/build-tool/package-service/config/gen/intellisense-render") as any;
const dt = req("../../src/build-tool/package-service/config/gen/distro-templates") as any;
const vsc = req("vscode") as any;

const FLAGS_MARK = "# ---- 编译标志(与 include 无关) ----";
const WS_MARK = "# ---- 工作空间包 include(工作空间在前,-I) ----";
const SYS_MARK = "# ---- 环境前缀 include:发行版(在后,-isystem) ----";
const INSTALL_MARK_ISOLATED = "# ---- 工作空间安装产物 include:isolated install/<pkg>/include(在后,-isystem) ----";
const INSTALL_MARK_MERGED = "# ---- 工作空间安装产物 include:merged install/include(在后,-isystem) ----";

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
        void cfg.update("python.autoComplete.extraPaths", []);
        void cfg.update("python.analysis.extraPaths", []);
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
        before(function (this: Mocha.Context) {
            // render 真写 python.* 键;宿主 --disable-extensions 下键未注册,VS Code 拒写 → 仅无头跑
            const g = global as unknown as { __vscodeStubInstalled?: boolean };
            if (!g.__vscodeStubInstalled) {
                this.skip();
            }
        });

        it("syncCppProperties: 首次生成按传入顺序 + compileCommands + cppStandard gnu++20", async () => {
            const includes = [wsInc, incLll];
            await render.syncCppProperties(wsRoot, includes);
            const cpp = JSON.parse(fs.readFileSync(path.join(wsRoot, ".vscode", "c_cpp_properties.json"), "utf8"));
            const cfg0 = cpp.configurations[0];
            assert.strictEqual(cfg0.includePath.length, 2, JSON.stringify(cfg0.includePath));
            assert.strictEqual(cfg0.compileCommands, "${workspaceFolder}/build/compile_commands.json");
            assert.strictEqual(cfg0.cppStandard, "gnu++20");
            assert.strictEqual(cfg0.name, "ros2");
        });

        it("syncCppProperties: 已存在 → 管辖条目重排在前(工作空间 src → 环境前缀),额外条目保留在后;字段补齐/升级", async () => {
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
            // 字段补齐/升级
            assert.strictEqual(cfg0.compileCommands, "${workspaceFolder}/build/compile_commands.json");
            assert.strictEqual(cfg0.cppStandard, "gnu++20");
            if (process.platform === "linux") {
                assert.strictEqual(cfg0.cStandard, "gnu11");
            }
        });

        it("syncCppProperties: 用户自定义 cppStandard 保留(仅升级我方旧默认 gnu++17)", async () => {
            const cppPath = path.join(wsRoot, ".vscode", "c_cpp_properties.json");
            fs.writeFileSync(cppPath, JSON.stringify({
                configurations: [{ includePath: [], name: "ros2", cppStandard: "gnu++23" }],
                version: 4,
            }));
            await render.syncCppProperties(wsRoot, [wsInc]);
            const cpp = JSON.parse(fs.readFileSync(cppPath, "utf8"));
            assert.strictEqual(cpp.configurations[0].cppStandard, "gnu++23");
            assert.strictEqual(cpp.configurations[0].compileCommands, "${workspaceFolder}/build/compile_commands.json");
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

        it("syncPythonPaths: 包根 + install 侧(按布局/存在性)+ develop 目录 + 补充语义(2026-09-15 手稿口径)", async () => {
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

        it("removePythonPaths: 从 extraPaths 移除指定目录条目", async () => {
            const entries = [{ name: "iii", dir: path.join(wsRoot, "src", "iii"), buildType: "ament_python" }];
            await render.syncPythonPaths(wsRoot, entries, [path.join(wsRoot, "build", "iii")]);
            const removed = await render.removePythonPaths(wsRoot, [path.join(wsRoot, "build", "iii")]);
            const cfg = vsc.workspace.getConfiguration();
            const analysis = cfg.get("python.analysis.extraPaths", []);
            assert.strictEqual(removed, 2, "analysis 与 autoComplete 两键各删一条");
            assert.ok(!analysis.includes(path.join(wsRoot, "build", "iii")), JSON.stringify(analysis));
            assert.ok(analysis.includes(path.join(wsRoot, "src", "iii")), "源码条目应保留");
        });

        it("syncPythonPaths: 规范重排只作用于管辖条目,用户自加条目原序留尾、队尾变动不重写(2026-09-09;组序 2026-09-15 对齐手稿)", async () => {
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

        it("有感删除预检: cppIncludeEntryExists / clangdIncludeExists / pythonPathExists(与 remove* 同口径,2026-09-08)", async () => {
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
    });
});
// 修改时间:2026-09-08 22:53(+1 用例:有感删除预检三函数 24→25;渲染组删空/多事件循环等语义不变)
// 修改时间:2026-09-09 01:43(+2 用例 25→27:orderPythonExtraPaths 规范组序 / syncPythonPaths 已有列表整块规范重排)
// 修改时间:2026-09-09 01:52(重排仅管辖条目:用户自加条目原序留队尾、只改队尾不重写,断言并入 syncPythonPaths 用例)
// 修改时间:2026-09-28(VD-3:+1 用例 27→28:syncPythonPaths 发行版模板透传(jazzy)与切回缺省的旧形状清替;
// 集成宿主不注册 python.* 配置键 → 用例探针 update 失败即 this.skip()(同套件 4 条存量失败同根因,不入失败集);
// 新增 distro-templates.test.ts 承接纯函数组)
