/**
 * @file build-map.test.ts
 * build-only 真值域(可执行跳转数据中心)无头单测。
 *
 * 特点:
 *   · 全程 MemoryFs 注入 → 不需要真实 ROS 工作区,任意平台可跑;
 *   · 规格对齐 `discover/buildonly/scan.py`(Python 原型)与
 *     `discover/buildonly-四象限报告.md`(四象限固有性证据);
 *   · 不变式一:**结果与 install/ 无关** —— 同一 build 夹具配不同 install 布局,
 *     跳转表必须逐字节相同(这是"固有结论"部分的立论基础);
 *   · 不变式三:**域包含性** —— 只解算 build/ 与 install/,不越域取证(见文末 describe)。
 */

import * as assert from "assert";
import {
    BuildMapCenter,
    MemoryFs,
    buildBuildMapSnapshot,
    collectAreas,
    collectInstallRules,
    fingerprintOfSnapshot,
    collectJumps,
    collectTargets,
    discoverBuildPackages,
    locateBuildRoot,
    moduleSourceCandidates,
    parseDText,
    parseInstallLine,
    parseLinkLibs,
    parseLinkObjects,
    parseLinkOutput,
    parseLinkOutputPath,
    readPythonMeta,
    scriptExecutablesFromRules,
    diffPackageFingerprints,
    packageFingerprints,
    ExecutableResolver,
    buildExecIndex,
    findModuleInstalledPath,
    findSitePackagesDir,
    guardDomain,
    installFormOf,
    lookupByPath,
    lookupExecutable,
    normalizeInstallKey,
    pickDirSource,
    readManifests,
    rowsOf,
    sourceFromRules,
    sourceFromRulesRef,
    suggestNames,
} from "../../src/install-truth/api";
import type { BuildContext, BuildMapBuilder, BuildPackage, FsLike, JumpEntry, PackageAreas } from "../../src/install-truth/api";
import { buildTree, fileContextValue, iconPlanOf, layoutOfViews, openTargetOf, runPayloadOf } from "../../src/sidebar/install-truth-tree";
import type { TreeNode } from "../../src/sidebar/install-truth-tree";
import type { SidebarPackageView } from "../../src/install-truth/api";

const WS = "/ws";
const BUILD = `${WS}/build`;
const SRC = `${WS}/src`;

/** 空工作区骨架 */
function base(): MemoryFs {
    const fs = new MemoryFs();
    fs.addDir(BUILD);
    fs.addDir(SRC);
    return fs;
}

/** 造一个 CMake 目标(link.txt + 每个 object 的 .d) */
function addTarget(
    fs: MemoryFs,
    pkg: string,
    target: string,
    output: string,
    opts?: { srcs?: string[]; generated?: string[]; headers?: number; libs?: string[] }
): void {
    const dir = `${BUILD}/${pkg}/CMakeFiles/${target}.dir`;
    const objs = [`CMakeFiles/${target}.dir/src/${target}.cpp.o`];
    const libs = (opts?.libs ?? []).join(" ");
    fs.addFile(`${dir}/link.txt`, `/usr/bin/c++ -o ${BUILD}/${pkg}/${output} ${objs.join(" ")} ${libs}`.trim());
    const deps: string[] = [];
    for (const s of opts?.srcs ?? []) {
        deps.push(s);
    }
    for (const g of opts?.generated ?? []) {
        deps.push(g);
    }
    for (let i = 0; i < (opts?.headers ?? 0); i++) {
        deps.push(`/usr/include/header_${i}.hpp`);
    }
    fs.addFile(`${dir}/src/${target}.cpp.o.d`, `${objs[0]}: ${deps.join(" ")}\n`);
}

/** 造一个 ament_cmake 包(CMakeCache + ament_cmake 目录) */
function addCmakePkg(fs: MemoryFs, pkg: string, opts?: { ament?: boolean }): void {
    fs.addDir(`${BUILD}/${pkg}`);
    fs.addFile(`${BUILD}/${pkg}/CMakeCache.txt`, "// cache\nCMAKE_INSTALL_PREFIX:PATH=/ws/install\n");
    fs.addDir(`${BUILD}/${pkg}/ament_cmake_core`);
    fs.addFile(`${BUILD}/${pkg}/colcon_build.rc`, "0\n");
}

/** 造一个 ament_python 包(egg-info) */
function addPythonPkg(fs: MemoryFs, pkg: string, entryPoints: string, sources: string[]): void {
    fs.addDir(`${BUILD}/${pkg}/${pkg}.egg-info`);
    fs.addFile(`${BUILD}/${pkg}/${pkg}.egg-info/entry_points.txt`, entryPoints);
    fs.addFile(`${BUILD}/${pkg}/${pkg}.egg-info/SOURCES.txt`, sources.join("\n") + "\n");
}

describe("build-only / 根定位", () => {
    it("工作区根 → build 根 + src 根", async () => {
        const fs = base();
        const ctx = await locateBuildRoot(fs, WS);
        assert.ok(ctx);
        assert.strictEqual(ctx!.buildRoot, BUILD);
        assert.strictEqual(ctx!.srcRoot, SRC);
        assert.strictEqual(ctx!.workspaceRoot, WS);
    });

    it("直接传 build 根亦可(工作区根上溯)", async () => {
        const fs = base();
        const ctx = await locateBuildRoot(fs, BUILD);
        assert.ok(ctx);
        assert.strictEqual(ctx!.buildRoot, BUILD);
        assert.strictEqual(ctx!.workspaceRoot, WS);
    });

    it("既无 build/ 也非 build 根 → undefined", async () => {
        const fs = new MemoryFs();
        fs.addDir("/tmp/x");
        assert.strictEqual(await locateBuildRoot(fs, "/tmp/x"), undefined);
    });
});

describe("build-only / 包发现与 traits", () => {
    it("三类特征任一即收录;类型由 traits 推断;非包目录不计", async () => {
        const fs = base();
        addCmakePkg(fs, "cm_pkg", { ament: true }); // ament_cmake
        addPythonPkg(fs, "py_pkg", "[console_scripts]\n", []); // ament_python
        fs.addFile(`${BUILD}/raw_pkg/CMakeCache.txt`, "x"); // cmake
        fs.addDir(`${BUILD}/col_only`);
        fs.addFile(`${BUILD}/col_only/colcon_build.rc`, "0\n"); // python-or-unknown
        fs.addDir(`${BUILD}/COLCON_IGNORE`);
        fs.addDir(`${BUILD}/.hidden`);
        fs.addDir(`${BUILD}/not_a_pkg_dir`);

        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        assert.deepStrictEqual(Array.from(pkgs.keys()).sort(), ["cm_pkg", "col_only", "py_pkg", "raw_pkg"]);
        assert.strictEqual(pkgs.get("cm_pkg")!.type, "ament_cmake");
        assert.strictEqual(pkgs.get("py_pkg")!.type, "ament_python");
        assert.strictEqual(pkgs.get("raw_pkg")!.type, "cmake");
        assert.strictEqual(pkgs.get("col_only")!.type, "python-or-unknown");
        assert.strictEqual(pkgs.get("py_pkg")!.traits.python, true);
        assert.strictEqual(pkgs.get("cm_pkg")!.traits.amentCmake, true);
    });
});

describe("build-only / 目标抽取(link.txt + .o.d)", () => {
    it("解析 link.txt:`-o` 输出名 / objects / 链接库", () => {
        const txt = "/usr/bin/c++ -o /ws/build/p/talker CMakeFiles/talker.dir/src/talker.cpp.o -lfoo /opt/x/lib/libx.so";
        assert.strictEqual(parseLinkOutput(txt), "talker");
        assert.deepStrictEqual(parseLinkObjects(txt), ["CMakeFiles/talker.dir/src/talker.cpp.o"]);
        assert.deepStrictEqual(parseLinkLibs(txt), ["-lfoo", "libx.so"]);
    });

    it(".d 行续接符解析", () => {
        assert.deepStrictEqual(parseDText("a.o: /x/a.cpp \\\n /x/b.hpp\n"), ["/x/a.cpp", "/x/b.hpp"]);
    });

    it("exe 目标:工作区源与生成源分离、头计数、库;lib 目标 kind=lib;_uninstall 与空目标排除", async () => {
        const fs = base();
        addCmakePkg(fs, "p", { ament: true });
        addTarget(fs, "p", "talker", "talker", {
            srcs: [`${SRC}/p/src/talker.cpp`, `${SRC}/p/src/util.cpp`],
            generated: [`${BUILD}/p/rosidl_gen/x.cpp`],
            headers: 3,
            libs: [`${WS}/install/p/lib/libp.so`],
        });
        addTarget(fs, "p", "libp", "libp.so", { srcs: [`${SRC}/p/src/lib.cpp`] });
        addTarget(fs, "p", "p_uninstall", "uninstall", { srcs: [`${SRC}/p/src/x.cpp`] });
        fs.addDir(`${BUILD}/p/CMakeFiles/empty.dir`);
        fs.addFile(`${BUILD}/p/CMakeFiles/empty.dir/link.txt`, "c++ -o out"); // 无 objects
        fs.addDir(`${BUILD}/p/CMakeFiles/noout.dir`);
        fs.addFile(`${BUILD}/p/CMakeFiles/noout.dir/link.txt`, "c++ objs/only.cpp.o"); // 无 -o(对象库)

        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const targets = await collectTargets(fs, pkgs.get("p") as BuildPackage);

        assert.deepStrictEqual(
            targets.map((t) => t.output).sort(),
            ["libp.so", "talker"],
            "卸载目标、空目标与无 -o 目标均不得计入"
        );
        const exe = targets.filter((t) => t.output === "talker")[0];
        assert.strictEqual(exe.kind, "exe");
        assert.strictEqual(exe.objects, 1);
        assert.deepStrictEqual(exe.sources, [`${SRC}/p/src/talker.cpp`, `${SRC}/p/src/util.cpp`]);
        assert.strictEqual(exe.generatedSources, 1);
        assert.strictEqual(exe.headers, 3);
        assert.deepStrictEqual(exe.linkedLibs, ["libp.so"]);
        assert.strictEqual(targets.filter((t) => t.output === "libp.so")[0].kind, "lib");
    });
});

describe("build-only / Python 元数据(egg-info 单落点)", () => {
    it("entry_points 与 SOURCES 解析;模块 → 源优先命中 SOURCES", async () => {
        const fs = base();
        addPythonPkg(
            fs,
            "pydev",
            "[console_scripts]\nsss = pydev.sss:main\ntalk = pydev.talk:run\n",
            ["setup.py", "pydev/__init__.py", "pydev/sss.py", "pydev/talk.py"]
        );
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const pkg = pkgs.get("pydev") as BuildPackage;
        const meta = await readPythonMeta(fs, pkg);
        assert.deepStrictEqual(Object.keys(meta.entryPoints).sort(), ["sss", "talk"]);
        assert.strictEqual(meta.entryPoints["sss"], "pydev.sss:main");
        assert.strictEqual(meta.sources.length, 4);

        const cands = moduleSourceCandidates("pydev.sss", meta.sources, SRC, "pydev");
        assert.strictEqual(cands[0], `${SRC}/pydev/pydev/sss.py`, "SOURCES 命中的候选必须排第一");
    });
});

describe("build-only / 安装规则(脚本入口)", () => {
    it("symlink 与实体两种写法都解析;lib/<pkg> 落点才算可执行", async () => {
        const fs = base();
        addCmakePkg(fs, "prg", { ament: true });
        fs.addFile(
            `${BUILD}/prg/ament_cmake_symlink_install/ament_cmake_symlink_install.cmake`,
            [
                'ament_cmake_symlink_install_files("/ws/src/prg" FILES "/ws/src/prg/scripts/run.py" DESTINATION "lib/prg")',
                'ament_cmake_symlink_install_files("/ws/src/prg" FILES "/ws/src/prg/config/a.yaml" DESTINATION "share/prg/config")',
            ].join("\n")
        );
        fs.addFile(
            `${BUILD}/prg/cmake_install.cmake`,
            'file(INSTALL DESTINATION "share/prg" TYPE FILE FILES "/ws/src/prg/package.xml")\n'
        );
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const rules = await collectInstallRules(fs, pkgs.get("prg") as BuildPackage);
        assert.strictEqual(rules.length, 3);
        const scripts = scriptExecutablesFromRules("prg", rules);
        assert.deepStrictEqual(
            scripts.map((s) => s.name),
            ["run.py"],
            "只有 lib/prg 落点算可执行"
        );
        assert.strictEqual(scripts[0].source, "/ws/src/prg/scripts/run.py");

        const single = parseInstallLine(
            'ament_cmake_symlink_install_files("/root" FILES "/s/a.py" DESTINATION "bin")',
            "ament_cmake_symlink_install.cmake"
        );
        assert.strictEqual(single!.kind, "FILES");
        assert.deepStrictEqual(single!.sources, ["/s/a.py"]);
        assert.strictEqual(single!.dest, "bin");
    });
});

describe("build-only / 跳转表合成", () => {
    async function fixture(): Promise<{ fs: MemoryFs; ctx: BuildContext; pkgs: Map<string, BuildPackage> }> {
        const fs = base();
        addCmakePkg(fs, "cm_pkg", { ament: true });
        addTarget(fs, "cm_pkg", "talker", "talker", { srcs: [`${SRC}/cm_pkg/src/talker.cpp`], headers: 1 });
        addTarget(fs, "cm_pkg", "libcm", "libcm.so", { srcs: [`${SRC}/cm_pkg/src/lib.cpp`] });
        fs.addFile(
            `${BUILD}/cm_pkg/ament_cmake_symlink_install/ament_cmake_symlink_install.cmake`,
            'ament_cmake_symlink_install_files("/ws/src/cm_pkg" FILES "/ws/src/cm_pkg/scripts/tool.py" DESTINATION "lib/cm_pkg")'
        );
        addPythonPkg(fs, "py_pkg", "[console_scripts]\nsss = py_pkg.sss:main\n", ["py_pkg/sss.py"]);
        fs.addFile(`${SRC}/py_pkg/py_pkg/sss.py`, "def main():\n    pass\n");
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        return { fs, ctx, pkgs: await discoverBuildPackages(fs, ctx) };
    }

    it("三类来源合成:cpp 目标 / console_scripts / 安装规则脚本;库不入表", async () => {
        const { fs, ctx, pkgs } = await fixture();
        const { jumps } = await collectJumps(fs, ctx, pkgs);
        const cm = jumps.get("cm_pkg") as Array<{ name: string; kind: string; srcPaths: string[]; tier: string }>;
        assert.deepStrictEqual(cm.map((e) => `${e.name}:${e.kind}`).sort(), [
            "talker:cpp",
            "tool.py:script",
        ]);
        const talker = cm.filter((e) => e.name === "talker")[0];
        assert.deepStrictEqual(talker.srcPaths, [`${SRC}/cm_pkg/src/talker.cpp`]);
        assert.strictEqual(talker.tier, "L");

        const py = jumps.get("py_pkg") as Array<{ name: string; kind: string; srcPaths: string[] }>;
        assert.deepStrictEqual(py.map((e) => `${e.name}:${e.kind}`), ["sss:console_script"]);
        assert.strictEqual(py[0].srcPaths[0], `${SRC}/py_pkg/py_pkg/sss.py`, "按 SOURCES 推导的首选(本域不核对存在性)");
    });

    it("同名冲突按 cpp > console_script > script 取先并记 warning", async () => {
        const fs = base();
        addCmakePkg(fs, "dup", { ament: true });
        addTarget(fs, "dup", "tool", "tool", { srcs: [`${SRC}/dup/src/tool.cpp`] });
        fs.addFile(
            `${BUILD}/dup/ament_cmake_symlink_install/ament_cmake_symlink_install.cmake`,
            'ament_cmake_symlink_install_files("/ws/src/dup" FILES "/ws/src/dup/scripts/tool" DESTINATION "lib/dup")'
        );
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const { jumps, warnings } = await collectJumps(fs, ctx, pkgs);
        const list = jumps.get("dup") as Array<{ name: string; kind: string }>;
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].kind, "cpp", "cpp 优先");
        assert.ok(warnings.some((w) => w.indexOf("conflict") >= 0));
    });

    it("未解析不隐藏:目标无源 → unresolved + 条件分级", async () => {
        const fs = base();
        addCmakePkg(fs, "nosrc", { ament: true });
        addTarget(fs, "nosrc", "ghost", "ghost", { srcs: [], generated: [`${BUILD}/nosrc/gen/x.cpp`] });
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const { jumps } = await collectJumps(fs, ctx, pkgs);
        const ghost = (jumps.get("nosrc") as Array<{ name: string; unresolved: boolean; tier: string }>)[0];
        assert.strictEqual(ghost.unresolved, true);
        assert.strictEqual(ghost.tier, "C");
    });
});

describe("build-only / install 无关性(四象限不变式)", () => {
    /** 序列化跳转表(只取与消费方决策相关的字段),用于逐字节比较 */
    function serialize(jumps: Map<string, Array<{ name: string; kind: string; srcPaths: string[]; tier: string }>>): string {
        const out: string[] = [];
        for (const name of Array.from(jumps.keys()).sort()) {
            for (const e of jumps.get(name) as Array<{ name: string; kind: string; srcPaths: string[]; tier: string }>) {
                out.push(`${name}|${e.name}|${e.kind}|${e.tier}|${e.srcPaths.join(";")}`);
            }
        }
        return out.join("\n");
    }

    it("同一 build × 四种 install 布局 → 跳转表逐字节相同,且结果不出现 install 路径", async () => {
        const fs = base();
        addCmakePkg(fs, "mix", { ament: true });
        addTarget(fs, "mix", "talker", "talker", { srcs: [`${SRC}/mix/src/talker.cpp`], headers: 2 });
        addPythonPkg(fs, "pymix", "[console_scripts]\nsss = pymix.sss:main\n", ["pymix/sss.py"]);
        fs.addFile(`${SRC}/pymix/pymix/sss.py`, "def main():\n    pass\n");
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);

        const run = async (): Promise<string> => {
            const { jumps } = await collectJumps(fs, ctx, pkgs);
            return serialize(jumps);
        };

        const noInstall = await run();

        // 象限 1:isolated + entity(实体安装,每包前缀)
        fs.addDir(`${WS}/install/mix/lib/mix`);
        fs.addFile(`${WS}/install/mix/lib/mix/talker`, "ELF");
        fs.addFile(`${WS}/install/mix/share/mix/package.xml`, "<package/>");
        const isolatedEntity = await run();

        // 象限 2:isolated + symlink(软链不改变 build 侧结果)
        fs.addDir(`${WS}/install/pymix/lib/pymix`);
        fs.addFile(`${WS}/install/pymix/lib/python3.10/site-packages/pymix.egg-link`, `${BUILD}/pymix\n.`);
        const isolatedSymlink = await run();

        // 象限 3:merged(全工作区单前缀)
        fs.addFile(`${WS}/install/lib/pymix/sss`, "#!python3");
        fs.addFile(`${WS}/install/share/pymix/package.xml`, "<package/>");
        const merged = await run();

        assert.strictEqual(isolatedEntity, noInstall, "install 存在与否不得影响跳转表");
        assert.strictEqual(isolatedSymlink, noInstall);
        assert.strictEqual(merged, noInstall);
        assert.ok(noInstall.indexOf("/install/") < 0, "跳转结果不得包含 install 路径(证明只读 build)");
    });
});

describe("build-only / 数据中心(独立生命周期)", () => {
    function onePkgWorkspace(): MemoryFs {
        const fs = base();
        addCmakePkg(fs, "p", { ament: true });
        addTarget(fs, "p", "talker", "talker", { srcs: [`${SRC}/p/src/talker.cpp`] });
        return fs;
    }

    it("就绪契约:未刷新 → null;刷新后可用", async () => {
        const fs = onePkgWorkspace();
        const center = new BuildMapCenter({ workspaceRoot: WS, fs });
        assert.strictEqual(center.getState(), null);
        await center.refresh("首次");
        assert.ok(center.getState());
        assert.deepStrictEqual(center.packageNames(), ["p"]);
        assert.strictEqual(center.find("p", "talker")!.kind, "cpp");
        assert.strictEqual(center.package("p")!.type, "ament_cmake");
        center.dispose();
    });

    it("内容指纹抑制 + 失效后补刷", async () => {
        const fs = onePkgWorkspace();
        const center = new BuildMapCenter({ workspaceRoot: WS, fs });
        const events: number[] = [];
        center.onDidChange((ev) => events.push((ev.map.jumps.get("p") ?? []).length));
        await center.refresh("1");
        assert.deepStrictEqual(events, [1]);
        await center.refresh("2");
        assert.deepStrictEqual(events, [1], "内容未变不得重复通知");

        addTarget(fs, "p", "listener", "listener", { srcs: [`${SRC}/p/src/listener.cpp`] });
        center.invalidate("build 变化");
        assert.strictEqual(center.isDirty(), true);
        await center.refresh("3");
        assert.deepStrictEqual(events, [1, 2]);
        assert.strictEqual(center.isDirty(), false);
        center.dispose();
    });

    it("单飞合并:进行中再来请求 → 链尾补刷一次", async () => {
        const fs = onePkgWorkspace();
        let gate: (() => void) | undefined;
        let calls = 0;
        const builder: BuildMapBuilder = async (f, root, reason, now) => {
            calls++;
            if (calls === 1) {
                await new Promise<void>((resolve) => {
                    gate = resolve;
                });
            }
            return buildBuildMapSnapshot(f, root, reason, now);
        };
        const center = new BuildMapCenter({ workspaceRoot: WS, fs, builder });
        const p1 = center.refresh("first");
        await new Promise((r) => setTimeout(r, 0));
        const p2 = center.refresh("second");
        assert.strictEqual(calls, 1, "第二次请求必须并入在飞构建链");
        if (gate) {
            gate();
        }
        await Promise.all([p1, p2]);
        assert.strictEqual(calls, 2);
        center.dispose();
    });

    it("无 build/ → 失败可见、状态保持 null,不炸订阅方", async () => {
        const fs = new MemoryFs();
        fs.addDir("/tmp/nope");
        const center = new BuildMapCenter({ workspaceRoot: "/tmp/nope", fs });
        let fired = 0;
        center.onDidChange(() => fired++);
        await center.refresh("bad");
        assert.strictEqual(center.getState(), null);
        assert.ok((center.getLastError() ?? "").indexOf("build") >= 0);
        assert.strictEqual(fired, 0);
        center.dispose();
    });
});

describe("build-only / 安装清单核对(真跑反例驱动)", () => {
    it("PROGRAMS 规则必须识别:ament_cmake_symlink_install_programs + 根相对源绝对化", () => {
        const line =
            'ament_cmake_symlink_install_programs("/ws/src/prg" PROGRAMS "scripts/run2.py" "DESTINATION" "lib/prg")';
        const rule = parseInstallLine(line, "ament_cmake_symlink_install.cmake");
        assert.ok(rule, "PROGRAMS 形态必须解析出来(真跑实测:rrr.py / py_listener.py 全靠它)");
        assert.strictEqual(rule!.kind, "FILES");
        assert.deepStrictEqual(rule!.sources, ["/ws/src/prg/scripts/run2.py"], "相对源需按首参根绝对化");
        assert.strictEqual(rule!.dest, "lib/prg");
        const scripts = scriptExecutablesFromRules("prg", [rule!]);
        assert.deepStrictEqual(scripts.map((s) => s.name), ["run2.py"]);
    });

    it("实体态写法必须识别:file(INSTALL ... TYPE PROGRAM ...) 且落点含 ${CMAKE_INSTALL_PREFIX}", () => {
        // 真跑实测(build/fff/cmake_install.cmake:90):
        const line =
            '  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib/fff" TYPE PROGRAM FILES "/ws/src/fff/fff/rrr.py")';
        const rule = parseInstallLine(line, "cmake_install.cmake");
        assert.ok(rule, "实体态 PROGRAMS 记录必须解析");
        assert.strictEqual(rule!.kind, "FILES");
        assert.strictEqual(rule!.dest, "lib/fff", "${CMAKE_INSTALL_PREFIX} 必须剥离,否则落点判定失配");
        assert.deepStrictEqual(rule!.sources, ["/ws/src/fff/fff/rrr.py"]);
        const scripts = scriptExecutablesFromRules("fff", [rule!]);
        assert.deepStrictEqual(scripts.map((s) => s.name), ["rrr.py"]);
    });

    it("注释行必须跳过:CMake 的原语义注释不得覆盖真实调用(四象限不变式抓出的反例)", async () => {
        const fs = base();
        addCmakePkg(fs, "prg2", { ament: true });
        fs.addFile(
            `${BUILD}/prg2/ament_cmake_symlink_install/ament_cmake_symlink_install.cmake`,
            [
                '# install(PROGRAMS "prg2/scripts/tool.py" "DESTINATION" "lib/prg2")',
                'ament_cmake_symlink_install_programs("/ws/src/prg2" PROGRAMS "prg2/scripts/tool.py" "DESTINATION" "lib/prg2")',
            ].join("\n")
        );
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const rules = await collectInstallRules(fs, pkgs.get("prg2") as BuildPackage);
        assert.strictEqual(rules.length, 1, "只剩真实调用那一条");
        assert.deepStrictEqual(rules[0].sources, ["/ws/src/prg2/prg2/scripts/tool.py"], "源必须按首参根绝对化");
        const { jumps } = await collectJumps(fs, ctx, pkgs);
        const e = (jumps.get("prg2") as Array<{ name: string; srcPaths: string[] }>)[0];
        assert.strictEqual(e.name, "tool.py");
        assert.deepStrictEqual(e.srcPaths, ["/ws/src/prg2/prg2/scripts/tool.py"]);
    });

    it("已构建但未安装的目标按清单排除;includeUninstalled 可保留", async () => {
        const fs = base();
        addCmakePkg(fs, "p", { ament: true });
        addTarget(fs, "p", "talker", "talker", { srcs: [`${SRC}/p/src/talker.cpp`] });
        addTarget(fs, "p", "test_x", "test_x", { srcs: [`${SRC}/p/test/test_x.cpp`] });
        // 真跑实测形态:symlink 态写 symlink_install_manifest.txt(install_manifest.txt 可能为空)
        fs.addFile(`${BUILD}/p/install_manifest.txt`, "");
        fs.addFile(`${BUILD}/p/symlink_install_manifest.txt`, `${WS}/install/lib/p/talker\n${WS}/install/share/p/package.xml\n`);

        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);

        const strict = await collectJumps(fs, ctx, pkgs);
        const names = (strict.jumps.get("p") as Array<{ name: string; installed: boolean; installPath: string }>).map(
            (e) => e.name
        );
        assert.deepStrictEqual(names, ["talker"], "未安装的 test_x 必须被排除");
        assert.ok(strict.warnings.some((w) => w.indexOf("test_x") >= 0), "排除需留 warning 痕迹");
        const talker = (strict.jumps.get("p") as Array<{ name: string; installed: boolean; installPath: string }>)[0];
        assert.strictEqual(talker.installed, true);
        assert.strictEqual(talker.installPath, `${WS}/install/lib/p/talker`);

        const loose = await collectJumps(fs, ctx, pkgs, { includeUninstalled: true });
        const all = loose.jumps.get("p") as Array<{ name: string; installed: boolean }>;
        assert.deepStrictEqual(all.map((e) => e.name), ["talker", "test_x"]);
        assert.strictEqual(all.filter((e) => e.name === "test_x")[0].installed, false, "未安装需如实标注");
    });

    it("无清单时不据此排除,但要标注未核对", async () => {
        const fs = base();
        addCmakePkg(fs, "q", { ament: true });
        addTarget(fs, "q", "only", "only", { srcs: [`${SRC}/q/src/only.cpp`] });
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const { jumps } = await collectJumps(fs, ctx, pkgs);
        const e = (jumps.get("q") as Array<{ installed: boolean; chain: string[] }>)[0];
        assert.strictEqual(e.installed, true, "无清单 → 不排除");
        assert.ok(e.chain.some((c) => c.indexOf("No install manifest") >= 0), "需标注未核对");
    });
});

describe("build-only / 消费方数据结构(launch 视角)", () => {
    function makeCenter(fs: MemoryFs): { center: BuildMapCenter; calls: () => number } {
        let calls = 0;
        const builder: BuildMapBuilder = async (f, root, reason, now) => {
            calls++;
            return buildBuildMapSnapshot(f, root, reason, now);
        };
        return { center: new BuildMapCenter({ workspaceRoot: WS, fs, builder }), calls: () => calls };
    }

    /** 造一个"两包已装 + 一个未解析目标"的夹具 */
    function fixtureFs(): MemoryFs {
        const fs = base();
        addCmakePkg(fs, "p", { ament: true });
        addTarget(fs, "p", "talker", "talker", { srcs: [`${SRC}/p/src/talker.cpp`] });
        addTarget(fs, "p", "ghost", "ghost", { srcs: [], generated: [`${BUILD}/p/gen/x.cpp`] });
        addPythonPkg(fs, "py", "[console_scripts]\nsss = py.sss:main\n", ["py/sss.py"]);
        fs.addFile(`${SRC}/py/py/sss.py`, "def main():\n    pass\n");
        fs.addFile(`${BUILD}/p/install_manifest.txt`, `${WS}/install/lib/p/talker\n${WS}/install/lib/p/ghost\n`);
        fs.addFile(`${BUILD}/py/install_manifest.txt`, `${WS}/install/lib/py/sss\n`);
        return fs;
    }

    async function readyCenter(): Promise<{ center: BuildMapCenter; calls: () => number }> {
        const c = makeCenter(fixtureFs());
        await c.center.refresh("init");
        return c;
    }

    it("lookup 四态:ok / 包不在工作区 / 名字不存在(带建议)/ 源未解析", async () => {
        const { center } = await readyCenter();
        const r = new ExecutableResolver(center);

        const ok = (await r.lookup("p", "talker"))!;
        assert.strictEqual(ok.status, "ok");
        assert.deepStrictEqual(ok.entry!.srcPaths, [`${SRC}/p/src/talker.cpp`]);
        assert.ok(ok.message.indexOf("talker.cpp") >= 0);

        const notBuilt = (await r.lookup("nav2_amcl", "amcl"))!;
        assert.strictEqual(notBuilt.status, "pkg-not-built", "系统/underlay 包必须与名字拼错区分开");

        const miss = (await r.lookup("p", "talkr"))!;
        assert.strictEqual(miss.status, "exe-not-found");
        assert.ok(miss.suggestions.indexOf("talker") >= 0, "拼错(少字符)时给同包建议");

        const unres = (await r.lookup("p", "ghost"))!;
        assert.strictEqual(unres.status, "source-unresolved");
        assert.ok(unres.message.indexOf("source unresolved") >= 0);
        center.dispose();
    });

    it("未就绪 → 首次查询自动构建(惰性);构建失败才返回 null", async () => {
        const { center, calls } = makeCenter(fixtureFs());
        const r = new ExecutableResolver(center);
        assert.strictEqual(center.isReady(), false, "尚未构建");

        const first = await r.lookup("p", "talker");
        assert.strictEqual(first!.status, "ok", "首次查询应自动完成初始构建,消费方无需手动 refresh");
        assert.strictEqual(calls(), 1);
        assert.strictEqual(center.isReady(), true);

        assert.deepStrictEqual(await r.namesOf("p"), ["ghost", "talker"]);
        assert.deepStrictEqual(await r.namesOf("nope"), []);
        assert.deepStrictEqual(await r.allNames(), ["ghost", "sss", "talker"]);
        assert.deepStrictEqual(await r.sourcesOf("p", "talker"), [`${SRC}/p/src/talker.cpp`]);
        assert.strictEqual(await r.sourcesOf("p", "nope"), null);
        assert.deepStrictEqual(await r.ownersOfSource(`${SRC}/p/src/talker.cpp`), [{ pkg: "p", name: "talker" }]);
        center.dispose();

        // 构建失败(无 build/)→ 状态保持未就绪 → 查询返回 null(而不是空结果)
        const bad = new BuildMapCenter({ workspaceRoot: "/nope", fs: new MemoryFs() });
        const rb = new ExecutableResolver(bad);
        assert.strictEqual(await rb.lookup("p", "talker"), null);
        assert.strictEqual(await rb.allNames(), null);
        assert.ok((bad.getLastError() ?? "").indexOf("build") >= 0, "失败原因需可见");
        bad.dispose();
    });

    it("惰性刷新:置脏后查询自动补刷;未置脏时查询不重扫", async () => {
        const { center, calls } = await readyCenter();
        const before = calls();
        const r = new ExecutableResolver(center);
        assert.strictEqual((await r.lookup("p", "talker"))!.status, "ok");
        assert.strictEqual(calls(), before, "未置脏:查询不得触发重扫");

        center.invalidate("模拟 build 产物变化");
        assert.strictEqual(center.isDirty(), true);
        const again = (await r.lookup("p", "talker"))!;
        assert.strictEqual(again.status, "ok");
        assert.strictEqual(calls(), before + 1, "置脏后首次查询立即补刷");
        assert.strictEqual(center.isDirty(), false);
        center.dispose();
    });

    it("扁平索引与建议函数可直接使用(不依赖门面)", async () => {
        const { center } = await readyCenter();
        const snap = center.getState()!;
        const index = buildExecIndex(snap);
        assert.strictEqual(index.byKey.get("p/talker")!.kind, "cpp");
        assert.deepStrictEqual(index.namesByPkg.get("py"), ["sss"]);
        assert.deepStrictEqual(suggestNames(index, "p", "tal"), ["talker"]);
        assert.strictEqual(lookupExecutable(index, snap, "p", "talker").status, "ok");
        center.dispose();
    });
});

describe("build-only / P0:按路径反查 + Python 落点 + 编译期源路径", () => {
    /** 夹具:p(CMake → talker)+ py(console script sss),两包都"已安装"(清单齐) */
    function p0Fs(opts?: { foreignBuild?: boolean }): MemoryFs {
        const fs = base();
        addCmakePkg(fs, "p", { ament: true });
        addTarget(fs, "p", "talker", "talker", {
            srcs: [`${SRC}/p/src/talker.cpp`],
            generated: [`${BUILD}/p/gen/msg.cpp`],
        });
        fs.addFile(`${BUILD}/p/gen/msg.cpp`, "// generated\n");
        if (!opts?.foreignBuild) {
            fs.addFile(`${SRC}/p/src/talker.cpp`, "int main(){return 0;}\n");
        }
        addPythonPkg(fs, "py", "[console_scripts]\nsss = py.sss:main\n", ["py/sss.py"]);
        fs.addFile(`${SRC}/py/py/sss.py`, "def main():\n    pass\n");
        fs.addFile(`${BUILD}/p/install_manifest.txt`, `${WS}/install/lib/p/talker\n`);
        fs.addFile(
            `${BUILD}/py/install_manifest.txt`,
            [
                `${WS}/install/lib/py/sss`,
                `${WS}/install/lib/python3.10/site-packages/py/sss.py`,
            ].join("\n") + "\n"
        );
        return fs;
    }

    function centerOf(fs: MemoryFs): BuildMapCenter {
        return new BuildMapCenter({ workspaceRoot: WS, fs });
    }

    function entryOf(center: BuildMapCenter, pkg: string, name: string): Record<string, any> {
        const list = (center.getState() as any).jumps.get(pkg) as Array<Record<string, any>>;
        return list.filter((e) => e.name === name)[0];
    }

    it("normalizeInstallKey:反斜杠/重复斜杠/相对段/尾斜杠归一;Linux 大小写保留;Windows 盘符小写", () => {
        assert.strictEqual(normalizeInstallKey("/ws//install/lib/p/talker/"), "/ws/install/lib/p/talker");
        assert.strictEqual(normalizeInstallKey("/ws/install/./lib/../lib/p/talker"), "/ws/install/lib/p/talker");
        assert.strictEqual(normalizeInstallKey("\\ws\\install\\lib\\p\\talker"), "/ws/install/lib/p/talker");
        assert.strictEqual(normalizeInstallKey("/ws/A"), "/ws/A", "Linux 大小写敏感,不得整体小写");
        assert.strictEqual(normalizeInstallKey("C:\\WS\\Install\\Talker"), "c:/ws/install/talker");
    });

    it("resolveByPath:安装清单落点 → pkg/name 反查成功(P0-1 的核心诉求)", async () => {
        const center = centerOf(p0Fs());
        await center.refresh("init");
        const r = new ExecutableResolver(center);

        const hit = (await r.resolveByPath(`${WS}/install/lib/p/talker`))!;
        assert.strictEqual(hit.status, "ok");
        assert.strictEqual(hit.pkg, "p", "从路径反查到包名");
        assert.strictEqual(hit.name, "talker", "从路径反查到可执行名");
        assert.deepStrictEqual(hit.entry!.srcPaths, [`${SRC}/p/src/talker.cpp`]);
        center.dispose();
    });

    it("resolveByPath:build 内链接输出别名命中(symlink 安装下 /proc/<pid>/exe 读到的形态)", async () => {
        const center = centerOf(p0Fs());
        await center.refresh("init");
        const r = new ExecutableResolver(center);

        const byAlias = (await r.resolveByPath(`${BUILD}/p/talker`))!;
        assert.strictEqual(byAlias.status, "ok");
        assert.strictEqual(byAlias.pkg, "p");
        assert.strictEqual(byAlias.name, "talker");
        assert.strictEqual(entryOf(center, "p", "talker").buildPath, `${BUILD}/p/talker`);
        center.dispose();
    });

    it("resolveByPath:写法变体(尾斜杠/反斜杠/重复斜杠)命中同一条目", async () => {
        const center = centerOf(p0Fs());
        await center.refresh("init");
        const r = new ExecutableResolver(center);

        for (const variant of [
            `${WS}/install/lib/p/talker/`,
            `${WS}//install/lib/p/talker`,
            `${WS}\\install\\lib\\p\\talker`,
        ]) {
            const hit = (await r.resolveByPath(variant))!;
            assert.strictEqual(hit.status, "ok", `写法变体应命中:${variant}`);
            assert.strictEqual(hit.name, "talker");
        }
        center.dispose();
    });

    it("resolveByPath:未命中 → path-unknown(正常结论;不是 null,也不是 exe-not-found)", async () => {
        const center = centerOf(p0Fs());
        await center.refresh("init");
        const r = new ExecutableResolver(center);

        const miss = (await r.resolveByPath("/opt/ros/humble/lib/rviz2/rviz2"))!;
        assert.notStrictEqual(miss, null, "未命中不是'未就绪':必须是可区分的结论");
        assert.strictEqual(miss.status, "path-unknown");
        assert.ok(miss.message.indexOf("does not belong to any installed target") >= 0);
        assert.strictEqual(miss.name, "rviz2", "未命中时至少给 basename 供展示");
        center.dispose();
    });

    it("resolveByPath:未就绪 → null(与 path-unknown 严格区分)", async () => {
        const bad = new BuildMapCenter({ workspaceRoot: "/nope", fs: new MemoryFs() });
        const rb = new ExecutableResolver(bad);
        assert.strictEqual(await rb.resolveByPath(`${WS}/install/lib/p/talker`), null);
        assert.ok((bad.getLastError() ?? "").indexOf("build") >= 0);
        bad.dispose();
    });

    it("扁平索引可直接用:byInstallPath 以归一化路径为键", async () => {
        const center = centerOf(p0Fs());
        await center.refresh("init");
        const index = buildExecIndex(center.getState()!);
        const key = normalizeInstallKey(`${WS}/install/lib/p/talker`);
        assert.ok(index.byInstallPath.has(key));
        assert.strictEqual(lookupByPath(index, `${WS}/install/lib/p/talker`).status, "ok");
        assert.strictEqual(lookupByPath(index, "/nowhere/x").status, "path-unknown");
        center.dispose();
    });

    it("P0-2:console script 三处落点齐(壳 / site-packages 目录 / 模块文件),且都能反查回同一条目", async () => {
        const center = centerOf(p0Fs());
        await center.refresh("init");
        const r = new ExecutableResolver(center);
        const entry = entryOf(center, "py", "sss");

        assert.deepStrictEqual(entry.pythonInstall, {
            scriptPath: `${WS}/install/lib/py/sss`,
            sitePackagesDir: `${WS}/install/lib/python3.10/site-packages/py`,
            moduleFile: `${WS}/install/lib/python3.10/site-packages/py/sss.py`,
            devDir: `${BUILD}/py`,
            devModuleFile: undefined,
            verified: true,
        });
        assert.deepStrictEqual(entry.installPaths, [
            `${WS}/install/lib/py/sss`,
            `${WS}/install/lib/python3.10/site-packages/py`,
            `${WS}/install/lib/python3.10/site-packages/py/sss.py`,
            `${BUILD}/py`,
        ].sort());

        for (const p of [
            `${WS}/install/lib/py/sss`,
            `${WS}/install/lib/python3.10/site-packages/py`,
            `${WS}/install/lib/python3.10/site-packages/py/sss.py`,
        ]) {
            const hit = (await r.resolveByPath(p))!;
            assert.strictEqual(hit.status, "ok", `Python 落点应能反查:${p}`);
            assert.strictEqual(hit.pkg, "py");
            assert.strictEqual(hit.name, "sss");
        }
        center.dispose();
    });

    it("P0-2:ament_python 无清单 → 走 develop 语义 + 布局候选(verified=false,链上如实标注)", async () => {
        const fs = base();
        // 纯 ament_python:只有 egg-info,**没有安装清单**(VM 实测如此)
        addPythonPkg(fs, "pv", "[console_scripts]\nsv = pv.sv:main\n", ["pv/sv.py"]);
        fs.addFile(`${SRC}/pv/pv/sv.py`, "def main():\n    pass\n");
        // develop 模式:sys.path 根 = build/<pkg>,模块文件在 build/<pkg>/<pkg>/<mod>.py
        // (真实机上是 -> src 的软链;MemoryFs 不支持软链,直接放文件以验证路径推导)
        fs.addFile(`${BUILD}/pv/pv/sv.py`, "def main():\n    pass\n");

        const center = centerOf(fs);
        await center.refresh("init");
        const r = new ExecutableResolver(center);
        const entry = entryOf(center, "pv", "sv");

        assert.strictEqual(entry.pythonInstall.verified, false, "无清单 = 未核对,不得谎报");
        assert.strictEqual(entry.pythonInstall.devDir, `${BUILD}/pv`, "develop sys.path 根 = build/<pkg>");
        assert.strictEqual(entry.pythonInstall.devModuleFile, `${BUILD}/pv/pv/sv.py`);
        assert.strictEqual(entry.pythonInstall.scriptPath, `${WS}/install/pv/lib/pv/sv`, "isolated 布局首候选");
        assert.ok(
            (entry.installPaths as string[]).indexOf(`${WS}/install/lib/pv/sv`) >= 0,
            "merged 布局候选也要登记(别名键,只有真被运行时才命中)"
        );
        assert.ok((entry.chain as string[]).some((c) => c.indexOf("unverified") >= 0), "推导必须入 chain");

        for (const p of [
            `${WS}/install/pv/lib/pv/sv`,
            `${WS}/install/lib/pv/sv`,
            `${BUILD}/pv/pv/sv.py`,
        ]) {
            const hit = (await r.resolveByPath(p))!;
            assert.strictEqual(hit.status, "ok", `应能反查:${p}`);
            assert.strictEqual(hit.pkg, "pv");
            assert.strictEqual(hit.name, "sv");
        }
        center.dispose();
    });

    it("P0-2:模块名不带包前缀(sss = sss:main)同样命中 site-packages 里的模块文件", () => {
        const paths = [
            `${WS}/install/lib/py/sss`,
            `${WS}/install/lib/python3.10/site-packages/py/sss.py`,
            `${WS}/install/lib/python3.10/site-packages/py/sub/mod.py`,
            `${WS}/install/lib/python3.10/site-packages/other/keep.py`,
        ];
        assert.strictEqual(findSitePackagesDir(paths, "py"), `${WS}/install/lib/python3.10/site-packages/py`);
        assert.strictEqual(
            findModuleInstalledPath(paths, "py", "sss"),
            `${WS}/install/lib/python3.10/site-packages/py/sss.py`
        );
        assert.strictEqual(
            findModuleInstalledPath(paths, "py", "py.sub.mod"),
            `${WS}/install/lib/python3.10/site-packages/py/sub/mod.py`
        );
        assert.strictEqual(findModuleInstalledPath(paths, "py", "py.nope"), undefined);
        assert.strictEqual(findSitePackagesDir(paths, "nope"), undefined);
        assert.strictEqual(findModuleInstalledPath(paths, "py", ""), undefined);
    });

    it("P0-3:compilePaths = .o.d 里全部源(含 build 内生成源),原样保留", async () => {
        const center = centerOf(p0Fs());
        await center.refresh("init");
        const entry = entryOf(center, "p", "talker");

        assert.deepStrictEqual(
            entry.compilePaths,
            [`${BUILD}/p/gen/msg.cpp`, `${SRC}/p/src/talker.cpp`].sort(),
            "编译期路径 = 编译器当时看到的字符串(含生成源),不做改写"
        );
        assert.ok(
            (entry.chain as string[]).some((c) => c.indexOf("consumer checks local accessibility") >= 0),
            "chain 如实说明该判据不在本域(域包含性)"
        );
        center.dispose();
    });

    it("P0-3:域外存在性不再判定 —— 异机构建(源不在本机)与同机构建结论一致", async () => {
        const center = centerOf(p0Fs({ foreignBuild: true }));
        await center.refresh("init");
        const entry = entryOf(center, "p", "talker");
        assert.deepStrictEqual(entry.compilePaths, [`${BUILD}/p/gen/msg.cpp`, `${SRC}/p/src/talker.cpp`].sort());
        assert.strictEqual(
            entry.compilePathsExistLocally,
            undefined,
            "该字段已删除:源在不在、有没有被改名,不归本域管(README §2.2)"
        );
        center.dispose();
    });

    it("parseLinkOutputPath + 相对 -o 的落点判定(按 build 内存在性)", async () => {
        assert.strictEqual(parseLinkOutputPath("/usr/bin/c++ -o /out/x CMakeFiles/t.dir/a.o"), "/out/x");

        const fs = base();
        addCmakePkg(fs, "q", { ament: true });
        const dir = `${BUILD}/q/CMakeFiles/t.dir`;
        fs.addFile(`${dir}/link.txt`, "/usr/bin/c++ -o t CMakeFiles/t.dir/a.o\n");
        fs.addFile(`${dir}/a.o.d`, `${BUILD}/q/CMakeFiles/t.dir/a.o: ${SRC}/q/a.cpp\n`);
        fs.addFile(`${SRC}/q/a.cpp`, "int main(){return 0;}\n");
        fs.addFile(`${BUILD}/q/t`, "binary\n");
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const targets = await collectTargets(fs, pkgs.get("q") as BuildPackage);
        assert.strictEqual(targets.length, 1);
        assert.strictEqual(targets[0].outputPath, `${BUILD}/q/t`, "相对 -o 需按 build 内存在性解析");
        assert.deepStrictEqual(targets[0].compilePaths, [`${SRC}/q/a.cpp`]);
        assert.strictEqual(
            (targets[0] as any).compilePathsExistLocally,
            undefined,
            "域外存在性字段已删除(README §2.2)"
        );
    });
});

describe("域包含性:只解算 build/ 与 install/,不越域取证(README §2.2 / 不变式三)", () => {
    /** 夹具:CMake 包 p(talker)+ Python 包 py(console script sss) */
    function domainFs(): MemoryFs {
        const fs = base();
        addCmakePkg(fs, "p", { ament: true });
        addTarget(fs, "p", "talker", "talker", { srcs: [`${SRC}/p/src/talker.cpp`] });
        fs.addFile(`${SRC}/p/src/talker.cpp`, "int main(){return 0;}\n");
        addPythonPkg(fs, "py", "[console_scripts]\nsss = py.sss:main\n", ["py/sss.py"]);
        fs.addFile(`${BUILD}/p/install_manifest.txt`, `${WS}/install/lib/p/talker\n`);
        return fs;
    }

    it("注入「只放行 build/」的 FsLike 后,快照构建照常成功(本域从不访问 src/)", async () => {
        const guarded = guardDomain(domainFs(), [BUILD]);
        const snapshot = await buildBuildMapSnapshot(guarded, WS, "domain-guard");
        assert.strictEqual(snapshot.buildRoot, BUILD);
        assert.strictEqual(snapshot.srcRoot, SRC, "srcRoot 按约定拼出,无需访问 src/ 即可得到");
        const list = snapshot.jumps.get("p") as JumpEntry[];
        assert.strictEqual(list.length, 1);
        assert.deepStrictEqual(list[0].compilePaths, [`${SRC}/p/src/talker.cpp`], "记录原样给出");
    });

    it("console_script 不再越域确认:源文件不存在也照常给出推导落点(derived / tier C)", async () => {
        const inner = domainFs(); // 故意不创建 src/py/py/sss.py
        const guarded = guardDomain(inner, [BUILD]);
        const snapshot = await buildBuildMapSnapshot(guarded, WS, "domain-guard");
        const entry = (snapshot.jumps.get("py") as JumpEntry[]).filter((e) => e.name === "sss")[0];
        assert.strictEqual(entry.tier, "C", "不再靠越域确认升级为 L");
        assert.deepStrictEqual(entry.srcPaths, [`${SRC}/py/py/sss.py`], "仍给出推导首选");
    });

    it("守卫确实拦得住:直接访问 src/ 一律失败(证明夹具有效)", async () => {
        const guarded = guardDomain(domainFs(), [BUILD]);
        await assert.rejects(() => guarded.readText(`${SRC}/p/src/talker.cpp`));
        await assert.rejects(() => guarded.stat(SRC));
        await assert.rejects(() => guarded.readdir(SRC));
    });

    it("判定看「访问路径」而非真实位置:同一内容经 build/ 到达放行,直接 src 路径拒绝", async () => {
        const inner = domainFs();
        const viaBuild = `${BUILD}/p/py/sss.py`;
        const payload = "def main():\n    pass\n";
        inner.addFile(viaBuild, payload);
        inner.addFile(`${SRC}/p/py/sss.py`, payload);
        const guarded = guardDomain(inner, [BUILD]);
        assert.strictEqual(await guarded.readText(viaBuild), payload, "build/ 下的路径放行(真实环境里这是软链穿越)");
        await assert.rejects(() => guarded.readText(`${SRC}/p/py/sss.py`), "直接 src 路径拒绝");
    });
});

describe("安装内容解算:三区 lib / import / share(+ include)—— 观察为主、记录对账(README §2)", () => {
    const INSTALL = `${WS}/install`;
    /** 本次构建时刻(基线);比它更早的记录 = 上一次构建的残留 */
    const T0 = 1700000000000;
    const T_OLD = T0 - 60000;

    /**
     * 夹具:`py` = ament_python(壳 + site-packages + share + include),
     *       `cm` = ament_cmake_python(自己 lib/.so + local/lib **dist-packages**)。
     * 时间戳显式给出,便于构造"陈旧 install.log"。
     */
    function areasFs(opts?: { staleInstallLog?: boolean; expanded?: boolean }): MemoryFs {
        const fs = base();
        // ---- build 侧:py(egg-info + colcon_build.rc + install.log)----
        addPythonPkg(fs, "py", "[console_scripts]\nsss = py.sss:main\n", ["py/sss.py"]);
        fs.addFile(`${BUILD}/py/colcon_build.rc`, "0\n", T0);
        fs.addFile(`${BUILD}/py/py.egg-info/SOURCES.txt`, "py/sss.py\n", T0);
        fs.addFile(
            `${BUILD}/py/install.log`,
            [
                `${INSTALL}/py/lib/py/sss`,
                `${INSTALL}/py/lib/python3.10/site-packages/py/sss.py`,
                `${INSTALL}/py/share/py/launch/x.launch.py`,
                `${INSTALL}/py/share/py/urdf/gone.urdf`, // 只记录、install 侧没有 → manifest-only
            ].join("\n") + "\n",
            opts?.staleInstallLog ? T_OLD : T0
        );
        // ---- install 侧:py ----
        fs.addFile(`${INSTALL}/.colcon_install_layout`, "isolated", T0);
        fs.addFile(`${INSTALL}/py/lib/py/sss`, "#!/usr/bin/python3\n", T0);
        fs.addFile(`${INSTALL}/py/lib/python3.10/site-packages/py/sss.py`, "def main():\n    pass\n", T0);
        fs.addFile(`${INSTALL}/py/lib/python3.10/site-packages/py/__pycache__/sss.cpython-310.pyc`, "x", T0);
        if (opts?.expanded) {
            // 直通模式"扩大"出来的:记录里没有,但实际存在(必须如实保留)
            fs.addFile(`${INSTALL}/py/lib/python3.10/site-packages/py/data/secret.txt`, "s", T0);
        }
        fs.addFile(`${INSTALL}/py/share/py/launch/x.launch.py`, "x", T0);
        fs.addFile(`${INSTALL}/py/share/py/package.sh`, "x", T0);
        fs.addFile(`${INSTALL}/py/include/py/only.hpp`, "x", T0);
        // ---- build + install 侧:cm ----
        addCmakePkg(fs, "cm", { ament: true });
        fs.addFile(`${BUILD}/cm/colcon_build.rc`, "0\n", T0);
        fs.addFile(
            `${BUILD}/cm/symlink_install_manifest.txt`,
            [
                `${INSTALL}/cm/lib/cm/libcm_lib.so`,
                `${INSTALL}/cm/local/lib/python3.10/dist-packages/cm/py_listener.py`,
            ].join("\n") + "\n",
            T0
        );
        fs.addFile(`${INSTALL}/cm/lib/cm/libcm_lib.so`, "ELF", T0);
        fs.addFile(`${INSTALL}/cm/local/lib/python3.10/dist-packages/cm/py_listener.py`, "x", T0);
        return fs;
    }

    async function areasAll(fs: MemoryFs) {
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const { jumps } = await collectJumps(fs, ctx, pkgs);
        return collectAreas(fs, ctx, pkgs, jumps);
    }

    async function areasOf(fs: MemoryFs): Promise<PackageAreas> {
        return (await areasAll(fs)).areas.get("py") as PackageAreas;
    }

    it("四区按 install 落点形状归档;`__pycache__`/egg-info 走黑名单硬排除(2026-09-25 裁定)", async () => {
        const a = await areasOf(areasFs());
        assert.strictEqual(a.layout, "isolated");
        assert.strictEqual(a.prefix, `${INSTALL}/py`);
        assert.deepStrictEqual(
            a.files.filter((f) => f.area === "lib").map((f) => f.relPath),
            ["sss"]
        );
        const imp = a.files.filter((f) => f.area === "import").map((f) => f.relPath);
        assert.ok(imp.indexOf("sss.py") >= 0, "site-packages 下的模块归 import 区");
        assert.ok(imp.every((r) => r.indexOf("__pycache__") < 0), "pyc 不再进入行集(扫描层黑名单,不再'照实列出')");
        assert.deepStrictEqual(
            a.files.filter((f) => f.area === "share").map((f) => f.relPath).sort(),
            // 注意:share 区**包含** manifest-only 那条(urdf/gone.urdf)——
            // truth 层给全集,只记录→观察不到的东西也照实列出并标 agreement(README §2.1 第 3 条)
            ["launch/x.launch.py", "package.sh", "urdf/gone.urdf"]
        );
        assert.deepStrictEqual(
            a.files.filter((f) => f.area === "include").map((f) => f.relPath),
            ["only.hpp"]
        );
    });

    it("黑名单排除 `*.egg-info` 目录段(同批裁定)", async () => {
        const fs = areasFs();
        fs.addFile(`${INSTALL}/py/lib/python3.10/site-packages/py/py-0.0.0-py3.10.egg-info/PKG-INFO`, "x", T0);
        const a = await areasOf(fs);
        const imp = a.files.filter((f) => f.area === "import").map((f) => f.relPath);
        assert.ok(imp.every((r) => r.indexOf(".egg-info") < 0), "egg-info 段不进入行集");
    });

    it("记录对账:清单命中的是 confirmed;只观察到的正是「扩大」那一档(如实保留)", async () => {
        const a = await areasOf(areasFs({ expanded: true }));
        const pick = (rel: string) => a.files.filter((x) => x.relPath === rel)[0];
        assert.strictEqual(pick("sss").agreement, "confirmed", "install.log 记录了它");
        const leak = pick("data/secret.txt");
        assert.ok(leak !== undefined, "扩大出来的文件必须出现在全集里");
        assert.strictEqual(leak.area, "import");
        assert.strictEqual(leak.agreement, "observed", "记录里没有 → 这一档就是「扩大」");
    });

    it("清单里有、install 侧没有 → manifest-only(如实报,不隐藏);来源指向记录文件(可逆搜索)", async () => {
        const a = await areasOf(areasFs());
        const gone = a.files.filter((x) => x.agreement === "manifest-only");
        assert.deepStrictEqual(gone.map((x) => x.relPath), ["urdf/gone.urdf"]);
        assert.strictEqual(gone[0].area, "share");
        assert.strictEqual(gone[0].installPath, `${INSTALL}/py/share/py/urdf/gone.urdf`);
        assert.strictEqual(gone[0].sourceRef, "install record install.log", "可逆:去 build/py/install.log 查证");
    });

    it("generated / library 是**标记**而不是过滤:package.sh、.so 都仍在全集里(pyc 已改黑名单排除)", async () => {
        const a = await areasOf(areasFs());
        assert.strictEqual(a.files.filter((x) => x.relPath === "package.sh")[0].generated, true);
        assert.strictEqual(a.files.filter((x) => x.relPath === "launch/x.launch.py")[0].generated, false);
        assert.ok(a.files.every((x) => x.relPath.indexOf(".pyc") < 0), "pyc 已被扫描层黑名单排除(2026-09-25)");
        const cm = (await areasAll(areasFs())).areas.get("cm") as PackageAreas;
        const so = cm.files.filter((x) => x.relPath === "libcm_lib.so")[0];
        assert.strictEqual(so.library, true, ".so 不隐藏,只标记");
        assert.strictEqual(so.area, "lib");
    });

    it("dist-packages(ament_cmake_python)同样归 import 区", async () => {
        const cm = (await areasAll(areasFs())).areas.get("cm") as PackageAreas;
        const listener = cm.files.filter((x) => x.relPath === "py_listener.py")[0];
        assert.strictEqual(listener.area, "import");
        assert.strictEqual(listener.agreement, "confirmed", "symlink_install_manifest.txt 记录了它");
        assert.strictEqual(listener.installPath, `${INSTALL}/cm/local/lib/python3.10/dist-packages/cm/py_listener.py`);
    });

    it("源落点由记录推出(**只拼字符串,不访问 src/**)", async () => {
        const a = await areasOf(areasFs());
        // import 区:模块文件 ↔ src/<pkg>/<pkg>/<rel>(根映射)
        assert.strictEqual(a.files.filter((x) => x.relPath === "sss.py")[0].sourcePath, `${SRC}/py/py/sss.py`);
        // share 区:资源 ↔ src/<pkg>/<rel>(同一相对形状)
        const lch = a.files.filter((x) => x.relPath === "launch/x.launch.py")[0];
        assert.strictEqual(lch.sourcePath, `${SRC}/py/launch/x.launch.py`);
        assert.strictEqual(lch.sourceEvidence, "python-rootmap");
        assert.strictEqual(lch.sourceRef, "py.egg-info root mapping", "来源引用随行下发(悬浮栏可逆搜索)");
    });

    it("陈旧 install.log 被守卫丢弃 → 落点降级为 observed,并记 warning(README §4)", async () => {
        const { areas, warnings } = await areasAll(areasFs({ staleInstallLog: true }));
        const a = areas.get("py") as PackageAreas;
        assert.strictEqual(a.files.filter((x) => x.relPath === "sss")[0].agreement, "observed");
        assert.ok(
            warnings.some((w) => w.indexOf("stale install records ignored") >= 0),
            `应记 warning,实际:${JSON.stringify(warnings)}`
        );
    });

    it("新鲜度守卫宽限差(2026-09-25 第五批):当前清单早基线 0.1s 不误杀;形态切换残留早 60s 被丢弃", async () => {
        const pkg: BuildPackage = {
            name: "m",
            buildDir: `${BUILD}/m`,
            type: "cmake",
            traits: { cmake: true, amentCmake: false, python: false, rosidl: false, colcon: true },
        };
        const fs = base();
        fs.addDir(`${BUILD}/m`);
        fs.addFile(`${BUILD}/m/colcon_build.rc`, "0\n", T0);
        // 当前形态的清单:写在 install 阶段,比基线(rc 收尾)早 **0.1s** —— 正常形态,不得误杀
        fs.addFile(`${BUILD}/m/install_manifest.txt`, `${INSTALL}/m/lib/m/x\n`, T0 - 100);
        // 被切换掉的形态遗留:比基线早 60s(远超 5s 宽限)→ 丢弃(实测场景:symlink 清单残留 10 分钟)
        fs.addFile(`${BUILD}/m/symlink_install_manifest.txt`, `${INSTALL}/m/share/m/old.yaml\n`, T_OLD);
        const info = await readManifests(fs, pkg);
        assert.deepStrictEqual(info.sources, ["install_manifest.txt"], "只采信当前形态的清单");
        assert.deepStrictEqual(info.skipped, ["symlink_install_manifest.txt"]);
        assert.deepStrictEqual(info.paths, [`${INSTALL}/m/lib/m/x`]);
        assert.strictEqual(info.origin.get(`${INSTALL}/m/lib/m/x`), "install_manifest.txt", "记录来源可逆");
    });

    it("`lib/` 根下的库(纯 cmake 常见)也归 lib 区;`lib/cmake/**` 目录不进四区", async () => {
        const fs = areasFs();
        fs.addFile(`${INSTALL}/py/lib/libpy_helper.so`, "ELF", T0);
        fs.addDir(`${INSTALL}/py/lib/cmake/py`);
        fs.addFile(`${INSTALL}/py/lib/cmake/py/pyConfig.cmake`, "x", T0);
        const a = await areasOf(fs);
        assert.deepStrictEqual(
            a.files.filter((f) => f.area === "lib").map((f) => f.relPath),
            ["libpy_helper.so", "sss"],
            "lib 根下的 .so 与 lib/<pkg>/ 下的入口同属 lib 区"
        );
        assert.strictEqual(a.files.filter((f) => f.relPath === "libpy_helper.so")[0].library, true);
        assert.ok(a.files.every((f) => f.relPath.indexOf("cmake/") < 0), "lib/cmake/** 不属于四区(口径边界)");
    });

    it("merged 布局:扁平落点只认被记录提到的(不把别人的算到自己头上)", async () => {
        const fs = base();
        for (const n of ["m1", "m2"]) {
            addCmakePkg(fs, n, { ament: true });
            fs.addFile(`${BUILD}/${n}/colcon_build.rc`, "0\n", T0);
            fs.addFile(`${BUILD}/${n}/symlink_install_manifest.txt`, `${INSTALL}/lib/lib${n}.so\n`, T0);
            fs.addFile(`${INSTALL}/lib/lib${n}.so`, "ELF", T0);
        }
        fs.addFile(`${INSTALL}/.colcon_install_layout`, "merged", T0);
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const { jumps } = await collectJumps(fs, ctx, pkgs);
        const { areas } = await collectAreas(fs, ctx, pkgs, jumps);
        const m1 = areas.get("m1") as PackageAreas;
        assert.strictEqual(m1.layout, "merged");
        assert.strictEqual(m1.prefix, INSTALL);
        assert.deepStrictEqual(
            m1.files.filter((f) => f.area === "lib").map((f) => f.relPath),
            ["libm1.so"],
            "merged 下只认自己被记录提到的扁平落点"
        );
    });

    it("甲-1 软链:经 install 下的目录软链穿越被放行,并给出 link / linkDomain(扩大成因)", async () => {
        const fs = base();
        addPythonPkg(fs, "py", "[console_scripts]\nsss = py.sss:main\n", ["py/sss.py"]);
        fs.addFile(`${BUILD}/py/colcon_build.rc`, "0\n", T0);
        fs.addFile(`${BUILD}/py/py.egg-info/SOURCES.txt`, "py/sss.py\n", T0);
        fs.addFile(`${INSTALL}/.colcon_install_layout`, "isolated", T0);
        // 直通:install 里的 site-packages/py 是指向 build 的**目录软链**
        fs.addFile(`${BUILD}/py/py/sss.py`, "def main():\n    pass\n", T0);
        fs.addFile(`${BUILD}/py/py/data/secret.txt`, "s", T0);
        fs.addLink(`${INSTALL}/py/lib/python3.10/site-packages/py`, `${BUILD}/py/py`, T0);
        const a = await areasOf(fs);
        assert.deepStrictEqual(
            a.files.filter((f) => f.area === "import").map((f) => f.relPath).sort(),
            ["data/secret.txt", "sss.py"],
            "经软链穿越带出 build 目录的全部内容(这就是「扩大」)"
        );
        const secret = a.files.filter((f) => f.relPath === "data/secret.txt")[0];
        assert.strictEqual(
            secret.viaLinkPath,
            `${INSTALL}/py/lib/python3.10/site-packages/py`,
            "子文件自身不是软链 → 「扩大成因」记在**上游目录软链**上"
        );
        assert.strictEqual(secret.viaLinkDomain, "build");
        assert.strictEqual(
            secret.generated,
            false,
            "扩大出来的**用户数据**不得标成生成物 —— 否则会被消费方隐藏,反而毁掉「如实反映扩大」"
        );
        const pkgDir = a.files.filter((f) => f.relPath === "sss.py")[0];
        assert.strictEqual(pkgDir.link, false, "sss.py 自己是普通文件");
        assert.strictEqual(pkgDir.viaLinkDomain, "build");
    });

    it("甲-1 悬空软链必须可见(不得被静默跳过),且 executable=false", async () => {
        const fs = areasFs();
        fs.addLink(`${INSTALL}/py/lib/py/gone`, `${BUILD}/py/gone`, T0); // 目标不存在
        const a = await areasOf(fs);
        const gone = a.files.filter((f) => f.relPath === "gone")[0];
        assert.ok(gone !== undefined, "悬空链是真实落点,必须在全集里(不能像 walkFiles 那样静默跳过)");
        assert.strictEqual(gone.link, true);
        assert.strictEqual(gone.dangling, true);
        assert.strictEqual(gone.executable, false);
    });

    it("甲-1 权限:实体看自身模式,软链看**目标**(链自身 lrwxrwxrwx 拿它判会全 true)", async () => {
        const fs = areasFs();
        fs.addFile(`${INSTALL}/py/lib/py/entry`, "#!/usr/bin/python3\n", T0);
        fs.chmod(`${INSTALL}/py/lib/py/entry`, 0o755);
        fs.addFile(`${INSTALL}/py/lib/py/plain`, "x", T0); // 0o644
        fs.addFile(`${BUILD}/py/exec-target`, "x", T0);
        fs.chmod(`${BUILD}/py/exec-target`, 0o755);
        fs.addFile(`${BUILD}/py/nonexec-target`, "x", T0); // 0o644
        fs.addLink(`${INSTALL}/py/lib/py/link-exec`, `${BUILD}/py/exec-target`, T0);
        fs.addLink(`${INSTALL}/py/lib/py/link-plain`, `${BUILD}/py/nonexec-target`, T0);
        const a = await areasOf(fs);
        const by = (n: string) => a.files.filter((f) => f.relPath === n)[0];
        assert.strictEqual(by("entry").executable, true, "实体:看自身模式");
        assert.strictEqual(by("plain").executable, false);
        assert.strictEqual(by("link-exec").executable, true, "软链:看**目标**模式");
        assert.strictEqual(by("link-plain").executable, false);
    });

    it("甲-1 linkDomain 三档:src / build / outside", async () => {
        const fs = areasFs();
        fs.addFile(`${SRC}/py/x.py`, "x", T0);
        fs.addFile(`${BUILD}/py/y.bin`, "x", T0);
        fs.addLink(`${INSTALL}/py/share/py/a.py`, `${SRC}/py/x.py`, T0);
        fs.addLink(`${INSTALL}/py/share/py/b.bin`, `${BUILD}/py/y.bin`, T0);
        fs.addLink(`${INSTALL}/py/share/py/c.sh`, "/opt/ros/humble/share/x/c.sh", T0);
        const a = await areasOf(fs);
        const d = (n: string) => a.files.filter((f) => f.relPath === n)[0].linkDomain;
        assert.strictEqual(d("a.py"), "src", "源码直通 → 改源码立即生效");
        assert.strictEqual(d("b.bin"), "build", "构建产物 → 重建后可能失效");
        assert.strictEqual(d("c.sh"), "outside", "工作区外 → 不可用于源码映射");
    });

    it("最小门面:同步视图未就绪 → null;构建失败 → null;就绪后四区可查;空区 → [](≠ null)", async () => {
        const fs = areasFs();
        const resolver = new ExecutableResolver(new BuildMapCenter({ workspaceRoot: WS, fs }));
        // 同步视图不自动构建 → 未就绪给 null(侧边栏据此显示 loading)
        assert.strictEqual(resolver.areasSnapshot(), null);

        // 异步方法与既有 lookup/namesOf 同契约:惰性自动构建;**构建失败**才 null
        const failing = new ExecutableResolver(
            new BuildMapCenter({
                workspaceRoot: WS,
                fs,
                builder: async () => {
                    throw new Error("boom");
                },
            })
        );
        assert.strictEqual(await failing.areasOf("py"), null, "构建失败 → null");
        assert.strictEqual(await failing.filesOf("py", "lib"), null);
        assert.strictEqual(await failing.installedPackages(), null);
        assert.strictEqual(await failing.findInstalledFile(`${INSTALL}/py/lib/py/sss`), null);

        await resolver.ensureFresh("test");
        assert.strictEqual((await resolver.areasOf("py"))!.prefix, `${INSTALL}/py`);
        assert.deepStrictEqual((await resolver.filesOf("py", "lib"))!.map((f) => f.relPath), ["sss"]);
        assert.deepStrictEqual(await resolver.filesOf("cm", "share"), [], "该区确实为空 → [](不是 null)");
        assert.strictEqual(await resolver.areasOf("nope"), null, "没有这个包 → null");
        assert.deepStrictEqual(await resolver.installedPackages(), ["cm", "py"]);
        assert.strictEqual(resolver.areasSnapshot()!.size, 2, "同步视图给侧边栏用");
        // 落点反查:写法变体(重复斜杠 / . 段)走归一化键
        const hit = await resolver.findInstalledFile(`${INSTALL}/py//lib/py/./sss`);
        assert.strictEqual(hit === undefined || hit === null ? undefined : hit.relPath, "sss");
    });

    it("侧边栏行视图:状态四档 + lib 区带 `:main`(提案那三张图要能画出来)", async () => {
        const fs = areasFs();
        const ctx = (await locateBuildRoot(fs, WS)) as BuildContext;
        const pkgs = await discoverBuildPackages(fs, ctx);
        const { jumps } = await collectJumps(fs, ctx, pkgs);
        const { areas } = await collectAreas(fs, ctx, pkgs, jumps);
        const rows = rowsOf(areas.get("py") as PackageAreas, jumps.get("py"));
        const by = (n: string) => rows.filter((r) => r.name === n)[0];
        assert.strictEqual(by("sss").status, "installed");
        assert.strictEqual(by("package.sh").status, "generated");
        assert.strictEqual(by("urdf/gone.urdf").status, "missing");
        assert.strictEqual(by("sss").area, "lib");
        assert.strictEqual(by("sss").entryAttr, "main", "lib 区要显示 `:main`");
        assert.strictEqual(by("sss").source, `${SRC}/py/py/sss.py:main`);
        assert.deepStrictEqual(
            Array.from(new Set(rows.map((r) => r.area))),
            ["lib", "import", "share", "include"],
            "行顺序 = 区序(可直接照渲染)"
        );
    });

    it("侧边栏整棵树:同步视图未就绪 → null;就绪后每包都有 rows", async () => {
        const fs = areasFs();
        const resolver = new ExecutableResolver(new BuildMapCenter({ workspaceRoot: WS, fs }));
        assert.strictEqual(resolver.sidebarSnapshot(), null);
        const all = await resolver.sidebarView();
        assert.ok(all !== null);
        assert.deepStrictEqual(all!.map((v) => v.pkg), ["cm", "py"]);
        const py = await resolver.packageView("py");
        assert.ok(py !== null && py.rows.length > 0);
        assert.strictEqual(await resolver.packageView("nope"), null);
        assert.strictEqual(resolver.sidebarSnapshot()!.length, 2, "同步视图给侧边栏用");
    });

    it("DIRECTORY 规则多源:按 rest 首段挑对应源(真机反例:p10 的 config/urdf 全挂到 launch 上)", () => {
        const rules = [
            {
                kind: "DIRECTORY" as const,
                sources: ["/ws/src/p/config", "/ws/src/p/launch", "/ws/src/p/urdf"],
                dest: "share/p",
                from: "cmake_install.cmake",
            },
            {
                kind: "DIRECTORY" as const,
                sources: ["/ws/src/q/include/q"],
                dest: "include/q",
                from: "cmake_install.cmake",
            },
        ];
        assert.strictEqual(sourceFromRules(rules, "share/p/config/extra/deep.yaml"), "/ws/src/p/config/extra/deep.yaml");
        assert.strictEqual(sourceFromRules(rules, "share/p/launch/p.launch.py"), "/ws/src/p/launch/p.launch.py");
        assert.strictEqual(sourceFromRules(rules, "share/p/urdf/d.urdf"), "/ws/src/p/urdf/d.urdf");
        assert.strictEqual(
            sourceFromRules(rules, "include/q/adder.hpp"),
            "/ws/src/q/include/q/adder.hpp",
            "源就是目标目录本身 → 兜底拼法仍成立"
        );
        assert.strictEqual(pickDirSource(["/ws/src/p/urdf"], "urdf/d.urdf"), "/ws/src/p/urdf/d.urdf");
        // 真机形态:多条规则**共用同一个 dest** → 首段精确匹配必须赢过前一条的兜底
        const shared = [
            { kind: "DIRECTORY" as const, sources: ["/ws/src/p/launch"], dest: "share/p", from: "x" },
            { kind: "DIRECTORY" as const, sources: ["/ws/src/p/config"], dest: "share/p", from: "x" },
            { kind: "DIRECTORY" as const, sources: ["/ws/src/p/urdf"], dest: "share/p", from: "x" },
        ];
        assert.strictEqual(
            sourceFromRules(shared, "share/p/config/extra/deep.yaml"),
            "/ws/src/p/config/extra/deep.yaml",
            "不得被前一条规则(launch)的兜底抢走"
        );
        assert.strictEqual(sourceFromRules(shared, "share/p/launch/p.launch.py"), "/ws/src/p/launch/p.launch.py");
        assert.strictEqual(sourceFromRules(shared, "share/p/urdf/stress/a.xacro"), "/ws/src/p/urdf/stress/a.xacro");
    });

    it("sourceFromRulesRef(2026-09-25 第五批):带规则文件名,供悬浮栏可逆搜索", () => {
        const rules = [
            { kind: "FILES" as const, sources: ["/ws/src/p/scripts/run.py"], dest: "lib/p", from: "cmake_install.cmake" },
            { kind: "DIRECTORY" as const, sources: ["/ws/src/p/urdf"], dest: "share/p", from: "ament_cmake_symlink_install.cmake" },
        ];
        assert.deepStrictEqual(
            sourceFromRulesRef(rules, "lib/p/run.py"),
            { path: "/ws/src/p/scripts/run.py", from: "cmake_install.cmake" }
        );
        assert.deepStrictEqual(
            sourceFromRulesRef(rules, "share/p/urdf/d.urdf"),
            { path: "/ws/src/p/urdf/d.urdf", from: "ament_cmake_symlink_install.cmake" }
        );
        assert.strictEqual(sourceFromRulesRef(rules, "include/z/x.h"), undefined, "不命中任何 dest → undefined");
    });

    it("快照带上 areas,且指纹随安装内容变化(含扩大文件)", async () => {
        const s1 = await buildBuildMapSnapshot(areasFs(), WS, "t");
        const s2 = await buildBuildMapSnapshot(areasFs({ expanded: true }), WS, "t");
        assert.ok(s1.areas.get("py") !== undefined, "快照必须带 areas");
        assert.notStrictEqual(
            fingerprintOfSnapshot(s1),
            fingerprintOfSnapshot(s2),
            "多了扩大文件 → 指纹必须变(否则消费方收不到通知)"
        );
    });
});

describe("简易侧边栏:树模型(纯函数,零 vscode)", () => {
    const view = {
        pkg: "iii",
        prefix: "/ws/install/iii",
        layout: "isolated" as const,
        rows: [
            {
                area: "lib" as const, name: "sss", status: "installed" as const,
                source: "/ws/src/iii/iii/sss.py:main", sourcePath: "/ws/src/iii/iii/sss.py", entryAttr: "main",
                library: false, generated: false, executable: true, linkDomain: "src" as const,
                installPath: "/ws/install/iii/lib/iii/sss",
            },
            {
                area: "import" as const, name: "sss.py", status: "installed" as const,
                source: "/ws/src/iii/iii/sss.py", sourcePath: "/ws/src/iii/iii/sss.py",
                library: false, generated: false,
                installPath: "/ws/install/iii/lib/python3.10/site-packages/iii/sss.py",
            },
            {
                area: "import" as const, name: "__pycache__/sss.cpython-310.pyc", status: "generated" as const,
                library: false, generated: true,
                installPath: "/ws/install/iii/lib/python3.10/site-packages/iii/__pycache__/sss.cpython-310.pyc",
            },
            {
                area: "lib" as const, name: "libiii.so", status: "installed" as const,
                library: true, generated: false, installPath: "/ws/install/iii/lib/libiii.so",
            },
            {
                area: "share" as const, name: "urdf/iii.urdf", status: "missing" as const,
                library: false, generated: false, installPath: "/ws/install/iii/share/iii/urdf/iii.urdf",
            },
        ],
    };

    it("层级 = 包 → 区 → 行;隐藏生成物;lib 不列库;源为工作区相对路径(带 :main)", () => {
        const tree = buildTree([view], "/ws");
        assert.strictEqual(tree.length, 1);
        const pkgNode = tree[0];
        assert.strictEqual(pkgNode.label, "iii");
        assert.deepStrictEqual(pkgNode.children!.map((c) => c.label), ["Executables", "Python exports", "Resources"]);
        const libRows = pkgNode.children![0].children!;
        assert.deepStrictEqual(libRows.map((r) => r.label), ["sss"], "lib 区的 .so 被过滤");
        assert.strictEqual(libRows[0].description, undefined, "文件行不再显示路径灰字(改悬浮属性,2026-09-25 第二批)");
        assert.strictEqual(
            libRows[0].sourcePath,
            "/ws/src/iii/iii/sss.py",
            "**纯路径**(不含 `:main`)—— 点击跳转必须用它,否则会去找名叫 `sss.py:main` 的文件"
        );
        assert.strictEqual(pkgNode.children![1].children!.length, 1, "import 区的 .pyc 被过滤");
        const shareArea = pkgNode.children![2];
        assert.deepStrictEqual(shareArea.children!.map((c) => c.label), ["urdf"], "share 区按路径折成目录树(目录 label 不带 /)");
        const missing = shareArea.children![0].children![0];
        assert.strictEqual(missing.label, "iii.urdf");
        assert.strictEqual(missing.status, "missing");
        assert.strictEqual(missing.sourcePath, undefined, "无源行不给跳转路径(点它什么也不做)");
        assert.ok(missing.tooltip!.indexOf("In install records but not seen") >= 0, "missing 必须在 hover 里说明原因");
    });

    it("图标决策 iconPlanOf(2026-10-04):有 sourcePath 的文件行交给文件图标主题,missing/虚拟节点维持 codicon", () => {
        const tree = buildTree([view], "/ws");
        const libRow = tree[0].children![0].children![0]; // lib/sss,有 sourcePath
        assert.deepStrictEqual(iconPlanOf(libRow), { tag: "file", path: "/ws/src/iii/iii/sss.py" });
        const missing = tree[0].children![2].children![0].children![0]; // share/urdf/iii.urdf,missing
        assert.deepStrictEqual(
            iconPlanOf(missing),
            { tag: "codicon", id: "warning" },
            "missing 警示优先于类型图标(非 file/folder ThemeIcon 恒按 codicon 渲染,天然优先)"
        );
        // 虚拟节点(无磁盘路径字段)与消息行
        assert.deepStrictEqual(iconPlanOf(tree[0]), { tag: "codicon", id: "package" });
        assert.deepStrictEqual(iconPlanOf(tree[0].children![0]), { tag: "codicon", id: "folder" }, "区头(area)是分区标题非文件夹,保留 folder");
        const dir = tree[0].children![2].children![0]; // 资源区下的 urdf 目录节点
        assert.deepStrictEqual(
            iconPlanOf(dir),
            { tag: "none" },
            "目录行无图标(2026-10-04 用户裁定:文件行已是主题类型图标,codicon folder 夹在中间扎眼)"
        );
        assert.deepStrictEqual(iconPlanOf({ kind: "message", label: "x" }), { tag: "codicon", id: "info" });
    });

    it("图标决策:无 sourcePath 的文件行退回角色图标(用户裁定「有源路径才换」)", () => {
        const mk = (over: Partial<TreeNode>): TreeNode => ({ kind: "file", label: "n", ...over });
        assert.deepStrictEqual(iconPlanOf(mk({ label: "exe", area: "lib" })), { tag: "codicon", id: "terminal" });
        assert.deepStrictEqual(iconPlanOf(mk({ label: "l.launch.py", area: "launch" })), { tag: "codicon", id: "rocket" });
        assert.deepStrictEqual(iconPlanOf(mk({ label: "m.py", area: "import" })), { tag: "codicon", id: "symbol-module" });
        assert.deepStrictEqual(iconPlanOf(mk({ label: "r.yaml", area: "share" })), { tag: "codicon", id: "file-media" });
        assert.deepStrictEqual(iconPlanOf(mk({ label: "h.hpp", area: "include" })), { tag: "codicon", id: "file-code" });
        // 有源路径统一走文件主题图标(launch 行也一样 —— 角色标识交给行尾 ▶)
        assert.deepStrictEqual(
            iconPlanOf(mk({ label: "l.launch.py", area: "launch", sourcePath: "/ws/src/p/l.launch.py" })),
            { tag: "file", path: "/ws/src/p/l.launch.py" }
        );
        // source 展示串带 `:attr` 不进路径 —— 路径只取 sourcePath
        assert.deepStrictEqual(
            iconPlanOf(mk({ label: "exe", area: "lib", source: "/ws/src/p/main.cpp:main", sourcePath: "/ws/src/p/main.cpp" })),
            { tag: "file", path: "/ws/src/p/main.cpp" }
        );
    });

    it("路径折成目录树(不再是平铺):目录在前文件在后,label 不带尾斜杠(2026-09-25 第三批排序裁定)", () => {
        const mk = (name: string) => ({
            area: "share" as const,
            name,
            status: "installed" as const,
            source: "/ws/src/p/" + name,
            sourcePath: "/ws/src/p/" + name,
            library: false,
            generated: false,
            installPath: "/i/p/share/p/" + name,
        });
        const rows = [
            mk("config/extra/deep.yaml"),
            mk("config/p10.yaml"),
            mk("launch/p10.launch.py"),
            mk("urdf/demo9.xacro"),
            mk("urdf/ns_lab/lib.xacro"),
            mk("urdf/p10.urdf"),
        ];
        // 2026-09-25:launch 文件不再留在 share 区 —— 提升为独立 launch 区(排在第 0 位,AREA_ORDER)
        const areas = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows }], "/ws")[0].children!;
        assert.deepStrictEqual(areas.map((c) => c.label), ["launch", "Resources"], "launch 区提升,share 区不再重复显示");
        const launch = areas[0];
        assert.deepStrictEqual(
            launch.children!.map((c) => c.label),
            ["p10.launch.py"],
            "去 `launch/` 前缀展示"
        );
        const share = areas[1];
        assert.deepStrictEqual(share.children!.map((c) => c.label), ["config", "urdf"]);
        assert.deepStrictEqual(
            share.children![0].children!.map((c) => c.label),
            ["extra", "p10.yaml"],
            "目录在前、文件在后(组内字母序)"
        );
        assert.deepStrictEqual(share.children![0].children![0].children!.map((c) => c.label), ["deep.yaml"]);
        assert.deepStrictEqual(
            share.children![1].children!.map((c) => c.label),
            ["ns_lab", "demo9.xacro", "p10.urdf"],
            "目录固定在最前面(推翻混排口径,2026-09-25 第三批)"
        );
        assert.strictEqual(
            share.children![1].children!.find((c) => c.label === "demo9.xacro")!.children,
            undefined,
            "文件是叶子(不展开)"
        );
    });

    it("launch 区(2026-09-25):识别三种官方扩展名、去前缀、嵌套保留子路径、非 launch 行不受影响", () => {
        const mk = (name: string, over: Record<string, unknown> = {}) => ({
            area: "share" as const,
            name,
            status: "installed" as const,
            source: "/ws/src/p/" + name,
            sourcePath: "/ws/src/p/" + name,
            library: false,
            generated: false,
            installPath: "/i/p/share/p/" + name,
            ...over,
        });
        const rows = [
            mk("launch/bringup.launch.xml"),
            mk("launch/nested/foo.launch.py"),
            mk("launch/old.launch.yaml"),
            mk("launch/readme.txt"),
            mk("launch.yaml"),
            mk("launch/missing.launch.py", { status: "missing" as const, source: undefined, sourcePath: undefined }),
            mk("urdf/demo9.xacro"),
        ];
        const areas = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows }], "/ws")[0].children!;
        assert.deepStrictEqual(areas.map((c) => c.label), ["launch", "Resources"]);
        const launch = areas[0].children!;
        assert.deepStrictEqual(
            launch.map((c) => c.label),
            ["nested", "bringup.launch.xml", "missing.launch.py", "old.launch.yaml"],
            "missing 保留展示(不给 ▶);.txt/.xacro 不算 launch;目录在前、文件在后"
        );
        const share = areas[1].children!;
        assert.deepStrictEqual(
            share.map((c) => c.label),
            ["launch", "urdf", "launch.yaml"],
            "非 launch 行留在 share(目录在前);顶层 launch.yaml(名字是 `launch`+`.yaml`)不符合 *.launch.* 命名同样留下"
        );
        const nested = launch.find((c) => c.label === "nested")!;
        assert.deepStrictEqual(nested.children!.map((c) => c.label), ["foo.launch.py"], "嵌套目录保留子路径");
        const bringup = launch.find((c) => c.label === "bringup.launch.xml")!;
        assert.strictEqual(bringup.area, "launch", "行标 launch 区(适配层据此给 ▶ 图标与 contextValue)");
        assert.strictEqual(bringup.pkg, "p", "file 行带 pkg(▶ 运行需要)");
        assert.strictEqual(bringup.installPath, "/i/p/share/p/launch/bringup.launch.xml", "file 行带安装路径(${launch_path})");
    });

    it("fileContextValue(2026-09-25):可执行/launch 给 ▶ 上下文;missing/悬空/普通文件不给", () => {
        const exe = fileContextValue({ kind: "file", label: "talker", pkg: "p", area: "lib", status: "installed", executable: true, sourcePath: "/ws/src/p/t.py" });
        const exeNoBit = fileContextValue({ kind: "file", label: "data.bin", pkg: "p", area: "lib", status: "installed", executable: false, sourcePath: "/ws/src/p/d.bin" });
        const missing = fileContextValue({ kind: "file", label: "ghost", pkg: "p", area: "lib", status: "missing", sourcePath: undefined });
        const danglingRow = fileContextValue({ kind: "file", label: "bad", pkg: "p", area: "lib", status: "installed", dangling: true, sourcePath: "/ws/src/p/b" });
        const launchRow = fileContextValue({ kind: "file", label: "demo.launch.py", pkg: "p", area: "launch", status: "installed", sourcePath: "/ws/src/p/launch/demo.launch.py" });
        const plain = fileContextValue({ kind: "file", label: "iii.urdf", pkg: "p", area: "share", status: "installed", sourcePath: "/ws/src/p/iii.urdf" });
        const area = fileContextValue({ kind: "area", label: "可执行", pkg: "p" });
        assert.strictEqual(exe, "ros2.installTruth.file.executable");
        assert.strictEqual(exeNoBit, "ros2.installTruth.file", "lib 区无可执行位的文件不给 ▶");
        assert.strictEqual(missing, "ros2.installTruth.file", "missing 不给 ▶");
        assert.strictEqual(danglingRow, "ros2.installTruth.file", "悬空软链不给 ▶");
        assert.strictEqual(launchRow, "ros2.installTruth.file.launch");
        assert.strictEqual(plain, "ros2.installTruth.file");
        assert.strictEqual(area, undefined, "非文件行无 contextValue(适配层走 kind 兜底)");
    });

    it("include 区生成头(2026-09-25 裁定):不再整区隐藏,点击指向安装侧;路径只进悬浮", () => {
        const mk = (name: string, over: Record<string, unknown> = {}) => ({
            area: "include" as const,
            name,
            status: "installed" as const,
            library: false,
            generated: false,
            installPath: `/i/p/include/p/${name}`,
            ...over,
        });
        const rows = [
            // rosidl 生成头:源在 build 内 → generated(此前被 hideGenerated 整区吃掉)
            mk("box.hpp", {
                status: "generated" as const,
                generated: true,
                source: "/ws/build/p/rosidl_generator_cpp/p/msg/box.hpp",
                sourcePath: "/ws/build/p/rosidl_generator_cpp/p/msg/box.hpp",
                installPath: "/ws/install/p/include/p/p/msg/box.hpp",
            }),
            // 用户自己的头文件:源在 src → 照旧跳源
            mk("my_api.hpp", { source: "/ws/src/p/include/my_api.hpp", sourcePath: "/ws/src/p/include/my_api.hpp" }),
        ];
        const pkg = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows }], "/ws")[0];
        assert.deepStrictEqual(
            pkg.children!.map((c) => c.label),
            ["Headers"],
            "生成头不再被整区隐藏"
        );
        const files = pkg.children![0].children!;
        assert.deepStrictEqual(files.map((c) => c.label), ["box.hpp", "my_api.hpp"]);
        const gen = files[0];
        assert.strictEqual(gen.description, undefined, "灰字已取消(路径只进悬浮,2026-09-25 第二批)");
        assert.strictEqual(
            openTargetOf(gen),
            "/ws/install/p/include/p/p/msg/box.hpp",
            "生成头点击 = 安装侧文件(不跳 src/build)"
        );
        const user = files[1];
        assert.strictEqual(openTargetOf(user), "/ws/src/p/include/my_api.hpp", "用户头文件照旧跳源");
        assert.ok(gen.tooltip!.indexOf("INSTALL-side") >= 0, "hover 说明点击行为");
    });

    it("openTargetOf:非生成 include / 其它区 / 无落点 / 非文件行的分流", () => {
        const base = { kind: "file" as const, pkg: "p", children: undefined as TreeNode["children"] };
        assert.strictEqual(
            openTargetOf({ ...base, label: "x.py", area: "import", status: "generated", sourcePath: "/ws/build/p/x.py", installPath: "/i/p/x.py" }),
            "/i/p/x.py",
            "import 生成物(rosidl 生成 .py)也统一跳安装侧(2026-09-25 第三批,不再落 build)"
        );
        assert.strictEqual(
            openTargetOf({ ...base, label: "g.h", area: "include", status: "installed", sourcePath: "/ws/src/p/g.h", installPath: "/i/p/g.h" }),
            "/ws/src/p/g.h",
            "include 区非生成头(用户头文件)跳源"
        );
        assert.strictEqual(openTargetOf({ ...base, label: "lost.h", area: "include", status: "missing", sourcePath: undefined, installPath: "/i/p/lost.h" }), undefined);
        assert.strictEqual(openTargetOf({ ...base, label: "s.txt", area: "share", status: "installed", sourcePath: "/ws/src/p/s.txt" }), "/ws/src/p/s.txt");
        assert.strictEqual(openTargetOf({ ...base, kind: "area", label: "头文件" }), undefined);
    });

    it("runPayloadOf(2026-09-25 载荷 bug 护栏):element 直取;不可运行行 → undefined", () => {
        const exe = runPayloadOf({ kind: "file", label: "talker", pkg: "p", area: "lib", status: "installed", executable: true, sourcePath: "/ws/src/p/t.py", installPath: "/i/p/lib/p/talker" });
        assert.deepStrictEqual(exe, { pkg: "p", label: "talker", installPath: "/i/p/lib/p/talker", sourcePath: "/ws/src/p/t.py" });
        const launch = runPayloadOf({ kind: "file", label: "demo.launch.py", pkg: "p", area: "launch", status: "installed", sourcePath: "/ws/src/p/launch/demo.launch.py", installPath: "/i/p/share/p/launch/demo.launch.py" });
        assert.strictEqual(launch!.label, "demo.launch.py");
        assert.strictEqual(runPayloadOf({ kind: "file", label: "box.hpp", pkg: "p", area: "include", status: "generated", sourcePath: "/ws/build/p/box.hpp", installPath: "/i/p/box.hpp" }), undefined, "生成头不是可运行目标");
        assert.strictEqual(runPayloadOf({ kind: "file", label: "ghost", pkg: undefined, area: "lib", status: "missing" }), undefined, "缺 pkg 不给载荷");
    });

    it("包节点计数 = 过滤后可见行数(2026-09-25:消灭'122 项 vs 可见几行'的错账)", () => {
        const mk = (area: "lib" | "share" | "include", name: string, over: Record<string, unknown> = {}) => ({
            area,
            name,
            status: "installed" as const,
            library: false,
            generated: false,
            installPath: `/i/p/${name}`,
            ...over,
        });
        const rows = [
            mk("lib", "talker", { executable: true, sourcePath: "/ws/src/p/t.py" }),
            mk("lib", "libp.so", { library: true }), // lib 区的库 → 隐藏
            mk("share", "hook/x.sh", { generated: true }), // share 区生成物 → 隐藏
            mk("share", "cfg.yaml", { sourcePath: "/ws/src/p/cfg.yaml" }),
            mk("include", "gen.hpp", { generated: true, status: "generated" as const, sourcePath: "/ws/build/p/gen.hpp", installPath: "/i/p/gen.hpp" }), // include 生成头 → **显示**
        ];
        const pkg = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows }], "/ws")[0];
        assert.strictEqual(pkg.description, "3 items", "计数 = talker + cfg.yaml + gen.hpp(布局标注已上移视图标题,隐藏项不算)");
    });

    it("layoutOfViews(2026-09-25 第二批):布局是工作空间级属性 —— 一致给值,混合标出,空给 undefined", () => {
        const v = (layout: "isolated" | "merged", pkg: string): SidebarPackageView => ({ pkg, prefix: "/i", layout, rows: [] });
        assert.strictEqual(layoutOfViews([v("isolated", "a"), v("isolated", "b")]), "isolated");
        assert.strictEqual(layoutOfViews([v("merged", "a"), v("merged", "b")]), "merged");
        assert.strictEqual(layoutOfViews([v("isolated", "a"), v("merged", "b")]), "mixed layout");
        assert.strictEqual(layoutOfViews([]), undefined);
    });

    it("目录节点标递归子孙文件数(2026-09-25 第二批:容器数字 = 子孙内容数)", () => {
        const mk = (name: string) => ({
            area: "share" as const,
            name,
            status: "installed" as const,
            source: "/ws/src/p/" + name,
            sourcePath: "/ws/src/p/" + name,
            library: false,
            generated: false,
            installPath: "/i/p/share/p/" + name,
        });
        const rows = [mk("config/p10.yaml"), mk("config/extra/deep.yaml"), mk("config/extra/more/deeper.yaml"), mk("urdf/a.xacro")];
        const share = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows }], "/ws")[0].children![0];
        assert.strictEqual(share.description, "4 items", "区计数 = 递归子孙文件数,统一 ' N 项' 格式");
        const config = share.children!.find((c) => c.label === "config")!;
        assert.strictEqual(config.description, "3 items", "config = p10.yaml + extra 子树 2 个");
        const extra = config.children!.find((c) => c.label === "extra")!;
        assert.strictEqual(extra.description, "2 items", "extra = deep.yaml + more 子树 1 个");
        const more = extra.children!.find((c) => c.label === "more")!;
        assert.strictEqual(more.description, "1 items");
        assert.ok(config.tooltip!.indexOf("3 items") >= 0, "tooltip 同步 ' N 项' 口径");
    });

    it("rosidl 中间产物过滤(2026-09-25 第二批):include 只留最终导出接口头,且只对 generated 行生效", () => {
        const mk = (name: string, over: Record<string, unknown> = {}) => ({
            area: "include" as const,
            name,
            status: "installed" as const,
            library: false,
            generated: false,
            installPath: `/i/p/include/p/${name}`,
            ...over,
        });
        const gen = { status: "generated" as const, generated: true, source: "/ws/build/p/rosidl_generator_cpp/p/msg/x", sourcePath: "/ws/build/p/rosidl_generator_cpp/p/msg/x" };
        const rows = [
            mk("box.hpp", { ...gen, sourcePath: "/ws/build/p/rosidl_generator_cpp/p/msg/box.hpp" }),
            mk("detail/box__struct.hpp", { ...gen, sourcePath: "/ws/build/p/rosidl_generator_cpp/p/msg/detail/box__struct.hpp" }),
            mk("rosidl_generator_cpp__visibility_control.hpp", { ...gen, sourcePath: "/ws/build/p/rosidl_generator_cpp/p/rosidl_generator_cpp__visibility_control.hpp" }),
            mk("detail/manual.hpp", { source: "/ws/src/p/include/detail/manual.hpp", sourcePath: "/ws/src/p/include/detail/manual.hpp" }),
        ];
        const include = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows }], "/ws")[0].children![0];
        const labels = include.children!.map((c) => c.label);
        assert.deepStrictEqual(labels, ["detail", "box.hpp"], "目录在前;中间头隐藏;用户手写 detail/manual.hpp 保留");
        const detail = include.children!.find((c) => c.label === "detail")!;
        assert.deepStrictEqual(detail.children!.map((c) => c.label), ["manual.hpp"], "detail 里只剩用户的非生成头");
        assert.strictEqual(detail.description, "1 items");
    });

    it("import 区纯 Python 面(2026-09-25 第二批):剔 rosidl C 中间层与 .so,留 Python 绑定", () => {
        const mk = (name: string, over: Record<string, unknown> = {}) => ({
            area: "import" as const,
            name,
            status: "installed" as const,
            library: false,
            generated: false,
            installPath: `/i/p/local/lib/python3.10/dist-packages/p/${name}`,
            ...over,
        });
        const gen = { status: "generated" as const, generated: true, source: "/ws/build/p/rosidl_generator_py/p/x", sourcePath: "/ws/build/p/rosidl_generator_py/p/x" };
        const rows = [
            mk("__init__.py", { ...gen, sourcePath: "/ws/build/p/rosidl_generator_py/p/__init__.py" }),
            mk("msg/_box.py", { ...gen, sourcePath: "/ws/build/p/rosidl_generator_py/p/msg/_box.py" }),
            mk("msg/_box_s.c", { ...gen, sourcePath: "/ws/build/p/rosidl_generator_py/p/msg/_box_s.c" }),
            mk("_p_s.ep.rosidl_typesupport_c.c", { ...gen, sourcePath: "/ws/build/p/rosidl_generator_py/p/_p_s.ep.rosidl_typesupport_c.c" }),
            mk("libp__rosidl_generator_py.so", { ...gen, sourcePath: "/ws/build/p/rosidl_generator_py/p/libp__rosidl_generator_py.so" }),
            mk("hand_written.so", { source: "/ws/src/p/hand_written.so", sourcePath: "/ws/src/p/hand_written.so" }),
        ];
        const imp = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows }], "/ws")[0]
            .children!.find((c) => c.label === "Python exports")!;
        const labels = imp.children!.map((c) => c.label);
        assert.deepStrictEqual(labels, ["msg", "__init__.py", "hand_written.so"], "C 中间层/_s.ep/.so(生成)隐藏;非生成 .so 与 Python 绑定保留;目录在前");
        const msg = imp.children!.find((c) => c.label === "msg")!;
        assert.deepStrictEqual(msg.children!.map((c) => c.label), ["_box.py"], "msg 只剩 _box.py(_box_s.c 已剔)");
    });

    it("单分支文件夹合并(2026-09-25 第三批,VS Code compact folders 语义)", () => {
        const mk = (name: string) => ({
            area: "share" as const,
            name,
            status: "installed" as const,
            source: "/ws/src/p/" + name,
            sourcePath: "/ws/src/p/" + name,
            library: false,
            generated: false,
            installPath: "/i/p/share/p/" + name,
        });
        // ① 纯目录链 .cmake/api/v1 → 合并成一个节点,label 连路径
        const a = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows: [mk("lib/cmake/api/v1/pyConfig.cmake")] }], "/ws")[0].children![0];
        const merged = a.children!.find((c) => c.label === "lib/cmake/api/v1")!;
        assert.ok(merged !== undefined, "单分支链合并为一个节点");
        assert.strictEqual(merged.kind, "dir");
        assert.strictEqual(merged.description, "1 items", "合并节点计数 = 子树文件数");
        assert.deepStrictEqual(merged.children!.map((c) => c.label), ["pyConfig.cmake"], "合并节点下直接展示文件");
        // ② 目录自身有文件 → 不合并
        const b = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows: [mk("cfg/x.yaml"), mk("cfg/sub/y.yaml")] }], "/ws")[0].children![0];
        const cfg = b.children!.find((c) => c.label === "cfg")!;
        assert.ok(cfg !== undefined, "cfg 有自己的文件,不与 sub 合并");
        assert.deepStrictEqual(cfg.children!.map((c) => c.label), ["sub", "x.yaml"], "子目录在前、文件在后");
        // ③ 多个子目录 → 不合并
        const c = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows: [mk("top/a.txt"), mk("top/b/c.txt")] }], "/ws")[0].children![0];
        const top = c.children!.find((c2) => c2.label === "top")!;
        assert.deepStrictEqual(
            top!.children!.map((x) => x.label),
            ["b", "a.txt"],
            "top 有文件 + 子目录,不合并;目录在前"
        );
    });

    it("installFormOf(2026-09-25 第三批,包安装类型以 install 观察为准)", () => {
        const r = (over: Partial<Parameters<typeof installFormOf>[0][number]>): Parameters<typeof installFormOf>[0][number] =>
            ({ area: "lib", name: "x", status: "installed", library: false, generated: false, installPath: "/i/p/x", ...over });
        // 文件本身是软链 → symlink
        assert.strictEqual(installFormOf([r({ link: true, linkDomain: "build" })]), "symlink");
        // develop 直通:文件不是链,但经上游目录软链进来 → symlink
        assert.strictEqual(installFormOf([r({ link: false, viaLinkDomain: "build" })]), "symlink");
        // 悬空链也是符号安装的痕迹
        assert.strictEqual(installFormOf([r({ link: true, dangling: true })]), "symlink");
        // 全真实文件 → copy
        assert.strictEqual(installFormOf([r({ link: false })]), "copy");
        // 混合(实体 + 一条链)→ symlink(有链痕迹即符号安装)
        assert.strictEqual(installFormOf([r({ link: false }), r({ link: true, linkDomain: "src" })]), "symlink");
        // 空 → unknown(不猜)
        assert.strictEqual(installFormOf([]), "unknown");
        // 纯 manifest-only(status=missing,link 恒 undefined)→ unknown
        assert.strictEqual(installFormOf([r({ status: "missing" })]), "unknown");
        // missing 行不构成证据
        assert.strictEqual(installFormOf([r({ status: "missing", link: true })]), "unknown");
    });

    it("包节点属性前缀(2026-09-25 第三批):安装类型 + 构建类型,unknown 省略", () => {
        const rows = [
            { area: "lib" as const, name: "talker", status: "installed" as const, library: false, generated: false, installPath: "/i/p/talker", executable: true, sourcePath: "/ws/src/p/t.py", link: true, linkDomain: "build" as const },
        ];
        const build = (over: Partial<SidebarPackageView>): TreeNode =>
            buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows, ...over }], "/ws")[0];
        assert.strictEqual(build({ installForm: "symlink", buildType: "ament_cmake" }).description, "symlink install · ament_cmake · 1 items");
        assert.strictEqual(build({ installForm: "copy", buildType: "ament_python" }).description, "copy install · ament_python · 1 items");
        assert.strictEqual(build({ installForm: "unknown", buildType: undefined }).description, "1 items", "unknown/缺失属性省略");
        const full = build({ installForm: "symlink", buildType: "ament_cmake" });
        assert.ok(full.tooltip!.indexOf("based on actual install/ contents") >= 0, "tooltip 说明安装类型依据");
        assert.ok(full.tooltip!.indexOf("Build type") >= 0, "tooltip 含构建类型");
    });

    it("空态与占位:无包 → 提示;包内全被过滤 → 占位行", () => {
        assert.deepStrictEqual(buildTree([], "/ws"), [
            { kind: "message", label: "No build artifacts found", description: "Run colcon build first" },
        ]);
        const empty = buildTree([{ pkg: "p", prefix: "/i/p", layout: "isolated", rows: [] }], "/ws");
        assert.deepStrictEqual(empty[0].children!.map((c) => c.label), ["(nothing to show)"]);
    });
});

describe("构建事件化:逐包指纹与差分(packageFingerprints,2026-09-30)", () => {
    function twoPkgFs(): MemoryFs {
        const fs = base();
        addCmakePkg(fs, "a");
        addTarget(fs, "a", "ta", "ta", { srcs: [`${SRC}/a/src/ta.cpp`] });
        addCmakePkg(fs, "b");
        addTarget(fs, "b", "tb", "tb", { srcs: [`${SRC}/b/src/tb.cpp`] });
        return fs;
    }

    it("逐包指纹覆盖全部包;差分检出 变更 与 无变化(静默)", async () => {
        const fs = twoPkgFs();
        const snap = await buildBuildMapSnapshot(fs, WS);
        const fp = packageFingerprints(snap);
        assert.deepStrictEqual(Array.from(fp.keys()).sort(), ["a", "b"]);
        // 无变化:差分为空(消费方不被打扰)
        assert.deepStrictEqual(diffPackageFingerprints(fp, packageFingerprints(snap)), []);
        // b 变(新增目标)→ 只有 b 入差分
        addTarget(fs, "b", "tb2", "tb2", { srcs: [`${SRC}/b/src/tb2.cpp`] });
        const snap2 = await buildBuildMapSnapshot(fs, WS);
        assert.deepStrictEqual(diffPackageFingerprints(fp, packageFingerprints(snap2)), ["b"]);
    });

    it("差分检出 删除 与 新增(同列)", async () => {
        const fs = twoPkgFs();
        const snap = await buildBuildMapSnapshot(fs, WS);
        const fp = packageFingerprints(snap);
        // 新工作区少了 a → [a];多了 c → c 同列
        const fs2 = base();
        addCmakePkg(fs2, "b");
        addTarget(fs2, "b", "tb", "tb", { srcs: [`${SRC}/b/src/tb.cpp`] });
        addCmakePkg(fs2, "c");
        const snap2 = await buildBuildMapSnapshot(fs2, WS);
        assert.deepStrictEqual(diffPackageFingerprints(fp, packageFingerprints(snap2)), ["a", "c"]);
    });

    it("全局指纹回归:同快照稳定、内容变化仍驱动全局指纹(行抽取后逐字节口径未动)", async () => {
        const fs = twoPkgFs();
        const snap = await buildBuildMapSnapshot(fs, WS);
        assert.strictEqual(fingerprintOfSnapshot(snap), fingerprintOfSnapshot(await buildBuildMapSnapshot(fs, WS)));
        addTarget(fs, "a", "ta2", "ta2", { srcs: [`${SRC}/a/src/ta2.cpp`] });
        const snap2 = await buildBuildMapSnapshot(fs, WS);
        assert.notStrictEqual(fingerprintOfSnapshot(snap), fingerprintOfSnapshot(snap2));
        assert.deepStrictEqual(diffPackageFingerprints(packageFingerprints(snap), packageFingerprints(snap2)), ["a"]);
    });
});

describe("构建事件化:rc-mtime 增量门(refreshAfterBuildSignal,2026-09-30)", () => {
    /** 计数代理:记录 readdir 触达的目录(断言"门只走进变更包") */
    function counting(mem: MemoryFs): { fs: FsLike; readDirs: () => string[]; reset: () => void } {
        const dirs: string[] = [];
        const wrapped: FsLike = {
            stat: (p) => mem.stat(p),
            lstat: (p) => mem.lstat(p),
            readlink: (p) => mem.readlink(p),
            readdir: (p) => {
                dirs.push(p);
                return mem.readdir(p);
            },
            readText: (p, m) => mem.readText(p, m),
        };
        return {
            fs: wrapped,
            readDirs: () => dirs.slice(),
            reset: (): void => {
                dirs.length = 0;
            },
        };
    }

    function gateFixture() {
        const mem = base();
        addCmakePkg(mem, "a");
        addTarget(mem, "a", "ta", "ta", { srcs: [`${SRC}/a/src/ta.cpp`] });
        addCmakePkg(mem, "b");
        addTarget(mem, "b", "tb", "tb", { srcs: [`${SRC}/b/src/tb.cpp`] });
        const { fs, readDirs, reset } = counting(mem);
        const pkgEvents: string[][] = [];
        const center = new BuildMapCenter({ workspaceRoot: WS, fs });
        center.onPackagesChanged((names) => pkgEvents.push(names));
        return { mem, fs, readDirs, reset, center, pkgEvents };
    }

    it("单包 rc 重写:门只重扫该包,他包零读取;数据未变则不发差分(colcon no-op 语义)", async () => {
        const t = gateFixture();
        await t.center.refreshAfterBuildSignal(); // 未就绪 → 全量首扫
        t.reset(); // 清零,只看下一轮
        // a 的 rc 被重写(mtime 变),包数据本身没变
        t.mem.addFile(`${BUILD}/a/colcon_build.rc`, "0\n", 1000);
        await t.center.refreshAfterBuildSignal();
        const dirs = t.readDirs();
        assert.ok(dirs.indexOf(`${BUILD}`) >= 0, "门要列 build/ 根");
        assert.ok(dirs.indexOf(`${BUILD}/a`) >= 0, "变更包要进重扫");
        assert.strictEqual(dirs.indexOf(`${BUILD}/b`), -1, "未变包零读取");
        assert.deepStrictEqual(t.pkgEvents, [], "数据未变 → 不发包差分(包真的变了才发)");
        t.center.dispose();
    });

    it("包数据随 rc 一起变:门重扫该包并广播单包差分", async () => {
        const t = gateFixture();
        await t.center.refreshAfterBuildSignal();
        t.reset();
        t.mem.addFile(`${BUILD}/b/colcon_build.rc`, "0\n", 2000);
        addTarget(t.mem, "b", "tb2", "tb2", { srcs: [`${SRC}/b/src/tb2.cpp`] });
        await t.center.refreshAfterBuildSignal();
        const dirs = t.readDirs();
        assert.strictEqual(dirs.indexOf(`${BUILD}/a`), -1, "未变包零读取");
        assert.ok(dirs.indexOf(`${BUILD}/b`) >= 0);
        assert.deepStrictEqual(t.pkgEvents, [["b"]], "差分广播恰一个包名");
        assert.ok(t.center.find("b", "tb2"), "新目标已进快照");
        t.center.dispose();
    });

    it("全部包变更:增量结果 ≡ 全量重扫(逐包独立性等价性)", async () => {
        const t = gateFixture();
        await t.center.refreshAfterBuildSignal();
        // a、b 全部 rc 重写 + 数据变更
        t.mem.addFile(`${BUILD}/a/colcon_build.rc`, "0\n", 1001);
        addTarget(t.mem, "a", "ta2", "ta2", { srcs: [`${SRC}/a/src/ta2.cpp`] });
        t.mem.addFile(`${BUILD}/b/colcon_build.rc`, "0\n", 1002);
        addTarget(t.mem, "b", "tb2", "tb2", { srcs: [`${SRC}/b/src/tb2.cpp`] });
        await t.center.refreshAfterBuildSignal();
        const incremental = t.center.getState();
        assert.ok(incremental !== null);
        // 同一 fs 状态的权威全量
        const full = await buildBuildMapSnapshot(t.fs, WS, "full");
        assert.strictEqual(fingerprintOfSnapshot(incremental), fingerprintOfSnapshot(full), "增量 ≡ 全量(全局指纹逐字节)");
        assert.deepStrictEqual(
            Array.from(packageFingerprints(incremental).entries()).sort(),
            Array.from(packageFingerprints(full).entries()).sort()
        );
        t.center.dispose();
    });

    it("无 rc 的包保守必重扫(宁可多扫,不可漏新)", async () => {
        const mem = base();
        addCmakePkg(mem, "a");
        addTarget(mem, "a", "ta", "ta", { srcs: [`${SRC}/a/src/ta.cpp`] });
        // c:无 colcon_build.rc(只有 CMakeCache;可收录,CMakeCache 也是判据之一)
        mem.addDir(`${BUILD}/c`);
        mem.addFile(`${BUILD}/c/CMakeCache.txt`, "// cache\n");
        const { readDirs, fs, reset } = counting(mem);
        const center = new BuildMapCenter({ workspaceRoot: WS, fs });
        await center.refreshAfterBuildSignal();
        reset();
        await center.refreshAfterBuildSignal(); // 无任何变化的一轮
        assert.ok(readDirs().indexOf(`${BUILD}/c`) >= 0, "无 rc 包每轮保守重扫");
        assert.strictEqual(readDirs().indexOf(`${BUILD}/a`), -1, "有 rc 且未变的包不重扫");
        center.dispose();
    });

    it("幂等:并发多次构建信号 → 单飞 + 链尾补刷,事件恰一次", async () => {
        const fs = base();
        addCmakePkg(fs, "a");
        addTarget(fs, "a", "ta", "ta", { srcs: [`${SRC}/a/src/ta.cpp`] });
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const builder: BuildMapBuilder = async (f, root, reason, now) => {
            calls++;
            if (calls === 1) {
                await gate; // 第一轮挂起,制造并发窗口
            }
            return buildBuildMapSnapshot(f, root, reason, now);
        };
        const center = new BuildMapCenter({ workspaceRoot: WS, fs, builder });
        let events = 0;
        center.onDidChange(() => events++);
        const p1 = center.refreshAfterBuildSignal();
        const p2 = center.refreshAfterBuildSignal();
        const p3 = center.refreshAfterBuildSignal();
        release();
        await Promise.all([p1, p2, p3]);
        assert.strictEqual(events, 1, "首次就绪恰一次事件");
        // 链尾补刷(合并语义)现在走**增量门**:无变化 → 快速路,连 builder 都不必再调
        // (2026-09-30 前的契约是"链尾补一次全量"= calls===2;门把它降为零扫描)
        assert.strictEqual(calls, 1, "单飞 1 轮全量 + 链尾增量门快速路(零扫描)");
        center.dispose();
    });
});
