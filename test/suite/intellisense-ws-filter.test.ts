/**
 * @file intellisense-ws-filter.test.ts
 * 配置生成【本工作区剔除 + 布局感知静态路径】的无头单测(纯函数层,零 vscode 依赖)。
 *
 * 覆盖 2026-09-15 手稿裁定:
 *   ① env 推导的 include/PYTHONPATH 中,本工作区前缀一律剔除(只保留其他工作空间 + 系统);
 *   ② 本工作区 install/build 派生的条目:不在新集合里就删除(旧布局/旧形状残留);
 *   ③ 静态路径**按 .colcon_install_layout 塌缩**:isolated = install/<pkg>/…,merged = install/…(共用一条);
 *   ④ python 落点存在性过滤(只留真装了 python 的包)、develop 目录 build/<pkg>、组序对齐手稿;
 *   ⑤ C++ 安装侧 include 采集(cpptools 列全 / clangd 由消费根存在性决定)。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    amentPythonInstallDir,
    clangdInstallIncludeDir,
    clangdGroupDirs,
    cmakePythonInstallDir,
    collectPythonDirs,
    collectStaticClangdInstallIncludes,
    collectStaticCppIncludes,
    collectStaticPythonDirs,
    collectSystemIncludes,
    DEFAULT_INSTALL_LAYOUT,
    DEFAULT_PATH_TEMPLATE,
    HUMBLE_PATH_TEMPLATE,
    isBuildArtifactEntry,
    isUnderWorkspace,
    orderPythonExtraPaths,
    parseInstallLayout,
    pythonDevelopDir,
    readInstallLayout,
} from "../../src/build-tool/package-service/config/gen/intellisense-utils";

const WS = "/ws";

// 生产代码跟随平台(path.delimiter 切分、path.join 拼装),故断言也按当前平台归一
const P = (s: string): string => path.normalize(s);
const D = path.delimiter;

describe("配置生成 / 本工作区剔除判定", () => {
    it("isUnderWorkspace:工作区内为真、工作区外为假;支持 ${workspaceFolder} 条目形态", () => {
        assert.strictEqual(isUnderWorkspace(`${WS}/install/aaa/include`, WS), true);
        assert.strictEqual(isUnderWorkspace(`${WS}/src/aaa/include`, WS), true);
        assert.strictEqual(isUnderWorkspace("${workspaceFolder}/install/include", WS), true);
        assert.strictEqual(isUnderWorkspace("/opt/ros/humble/include", WS), false);
        assert.strictEqual(isUnderWorkspace("/other_ws/install/aaa/include", WS), false);
        assert.strictEqual(isUnderWorkspace(`${WS}2/install/include`, WS), false, "前缀相同但不同目录不得误判");
    });

    it("isBuildArtifactEntry:只认 install/build 之下(旧布局残留删除规则的作用域)", () => {
        assert.strictEqual(isBuildArtifactEntry(`${WS}/install/aaa/include`, WS), true);
        assert.strictEqual(isBuildArtifactEntry(`${WS}/build/aaa`, WS), true);
        assert.strictEqual(isBuildArtifactEntry("${workspaceFolder}/install/lib/python3.10/site-packages", WS), true);
        assert.strictEqual(isBuildArtifactEntry(`${WS}/src/aaa/include`, WS), false, "src 源码条目不属于构建产物");
        assert.strictEqual(isBuildArtifactEntry("/opt/ros/humble/include", WS), false);
    });
});

describe("配置生成 / env 派生集合剔除本工作区", () => {
    it("collectSystemIncludes:剔除本工作区前缀,保留其他工作空间与系统", () => {
        const env = {
            AMENT_PREFIX_PATH: [`/ws/install/aaa`, `/ws/install/bbb`, `/other_ws/install/ccc`, `/opt/ros/humble`].join(D),
            CMAKE_PREFIX_PATH: `/ws/install`,
            COLCON_PREFIX_PATH: ``,
        };
        const dirs = collectSystemIncludes(env, WS);
        assert.deepStrictEqual(
            dirs.map(P).sort(),
            [P("/opt/ros/humble/include"), P("/other_ws/install/ccc/include")].sort()
        );
    });

    it("collectSystemIncludes:不传 workspaceRoot 时保持原行为(兼容既有调用)", () => {
        const env = { AMENT_PREFIX_PATH: [`/ws/install/aaa`, `/opt/ros/humble`].join(D) };
        assert.deepStrictEqual(
            collectSystemIncludes(env).map(P).sort(),
            [P("/opt/ros/humble/include"), P("/ws/install/aaa/include")].sort()
        );
    });

    it("collectPythonDirs:剔除本工作区条目(install site-packages / build 镜像),保留其他来源", () => {
        const env = {
            PYTHONPATH: [
                "/ws/src/py_pkg",
                "/ws/build/py_pkg",
                "/ws/install/py_pkg/lib/python3.10/site-packages",
                "/other_ws/install/dep/lib/python3.10/site-packages",
                "/opt/ros/humble/lib/python3.10/site-packages",
            ].join(D),
        };
        const dirs = collectPythonDirs(env, WS);
        assert.deepStrictEqual(dirs.map(P), [
            P("/other_ws/install/dep/lib/python3.10/site-packages"),
            P("/opt/ros/humble/lib/python3.10/site-packages"),
        ]);
    });
});

describe("配置生成 / 布局感知静态路径(2026-09-15 手稿)", () => {
    it("默认模板 = Humble;标记内容解析(未知/空 → undefined,默认布局 isolated)", () => {
        assert.strictEqual(DEFAULT_PATH_TEMPLATE, HUMBLE_PATH_TEMPLATE);
        assert.strictEqual(DEFAULT_PATH_TEMPLATE.distro, "humble");
        assert.strictEqual(DEFAULT_PATH_TEMPLATE.pythonAbi, "python3.10");
        assert.strictEqual(DEFAULT_PATH_TEMPLATE.cmakePythonPurelib, "local/lib/python3.10/dist-packages");
        assert.strictEqual(parseInstallLayout("isolated\n"), "isolated");
        assert.strictEqual(parseInstallLayout(" merged \n"), "merged");
        assert.strictEqual(parseInstallLayout(""), undefined);
        assert.strictEqual(parseInstallLayout(undefined), undefined);
        assert.strictEqual(DEFAULT_INSTALL_LAYOUT, "isolated");
    });

    it("readInstallLayout:读标记内容;缺失/非法 → isolated", async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "is-layout-"));
        fs.mkdirSync(path.join(base, "install"));
        assert.strictEqual(await readInstallLayout(base), "isolated", "标记缺失 → 默认 isolated");
        fs.writeFileSync(path.join(base, "install", ".colcon_install_layout"), "merged\n");
        assert.strictEqual(await readInstallLayout(base), "merged");
        fs.writeFileSync(path.join(base, "install", ".colcon_install_layout"), "???\n");
        assert.strictEqual(await readInstallLayout(base), "isolated", "内容非法 → 默认 isolated");
    });

    it("ament_python install 落点随布局塌缩", () => {
        assert.strictEqual(amentPythonInstallDir(WS, "iii", "isolated"), P("/ws/install/iii/lib/python3.10/site-packages"));
        assert.strictEqual(amentPythonInstallDir(WS, "iii", "merged"), P("/ws/install/lib/python3.10/site-packages"));
    });

    it("接口包/ament_cmake install 落点随布局塌缩", () => {
        assert.strictEqual(cmakePythonInstallDir(WS, "p12_msgs", "isolated"), P("/ws/install/p12_msgs/local/lib/python3.10/dist-packages"));
        assert.strictEqual(cmakePythonInstallDir(WS, "p12_msgs", "merged"), P("/ws/install/local/lib/python3.10/dist-packages"));
    });

    it("collectStaticPythonDirs:按包类型分派 + 去重(merged 下两类各一条共用)", () => {
        const pkgs = [
            { name: "iii", isPython: true },
            { name: "ggg", isPython: true },
            { name: "p12_msgs", isPython: false },
            { name: "lll", isPython: false },
        ];
        assert.deepStrictEqual(collectStaticPythonDirs(WS, pkgs, "isolated").map(P), [
            P("/ws/install/iii/lib/python3.10/site-packages"),
            P("/ws/install/ggg/lib/python3.10/site-packages"),
            P("/ws/install/p12_msgs/local/lib/python3.10/dist-packages"),
            P("/ws/install/lll/local/lib/python3.10/dist-packages"),
        ]);
        assert.deepStrictEqual(collectStaticPythonDirs(WS, pkgs, "merged").map(P), [
            P("/ws/install/lib/python3.10/site-packages"),
            P("/ws/install/local/lib/python3.10/dist-packages"),
        ]);
    });

    it("develop 注入目录 = build/<pkg>(egg-link 指向的就是它)", () => {
        assert.strictEqual(pythonDevelopDir(WS, "iii"), P("/ws/build/iii"));
    });

    it("C++ 安装侧 include:isolated 每包一条(子层包名,杜绝双层包名导入)/ merged 一条共用 / python 包不收", () => {
        const pkgs = [
            { name: "fff", isPython: false },
            { name: "p12_msgs", isPython: false },
            { name: "iii", isPython: true },
        ];
        assert.deepStrictEqual(collectStaticCppIncludes(WS, pkgs, "isolated").map(P), [
            P("/ws/install/fff/include/fff"),
            P("/ws/install/p12_msgs/include/p12_msgs"),
        ]);
        assert.deepStrictEqual(collectStaticCppIncludes(WS, pkgs, "merged").map(P), [P("/ws/install/include")]);
    });

    it("静态写死:安装侧消费根不看目录是否存在(clangd 每包一条 / python 按类分派)", async () => {
        const pkgs = [
            { name: "fff", isPython: false },
            { name: "lll", isPython: false },
            { name: "iii", isPython: true },
        ];
        // clangd 侧:isolated 每包 `install/<pkg>/include/<pkg>`;merged 每包 `install/include/<pkg>`(无递归,必须逐包写)
        assert.deepStrictEqual(collectStaticClangdInstallIncludes(WS, pkgs, "isolated").map(P), [
            P("/ws/install/fff/include/fff"),
            P("/ws/install/lll/include/lll"),
        ]);
        assert.deepStrictEqual(collectStaticClangdInstallIncludes(WS, pkgs, "merged").map(P), [
            P("/ws/install/include/fff"),
            P("/ws/install/include/lll"),
        ]);
        assert.strictEqual(clangdInstallIncludeDir(WS, "lll", "isolated"), P("/ws/install/lll/include/lll"));
        // python 侧:纯 C++ 包也静态写 dist-packages(不做存在性过滤)
        assert.deepStrictEqual(collectStaticPythonDirs(WS, [{ name: "lll", isPython: false }], "isolated").map(P), [
            P("/ws/install/lll/local/lib/python3.10/dist-packages"),
        ]);
        // clangdGroupDirs 的 install 组原样收录(不 readdir / 不 stat),即便目录并不存在
        const staticRoot = P("/ws/install/does-not-exist/include/does-not-exist");
        const g = await clangdGroupDirs([], [staticRoot], []);
        assert.deepStrictEqual(g.install.map(P), [staticRoot]);
    });

    it("orderPythonExtraPaths 组序 = src → install/site-packages → build → install/local/dist → /opt/ros", () => {
        const src = P("/ws/src/iii");
        const ordered = orderPythonExtraPaths([
            "/opt/ros/humble/lib/python3.10/site-packages",
            "/opt/ros/humble/local/lib/python3.10/dist-packages",
            P("/ws/install/p12_msgs/local/lib/python3.10/dist-packages"),
            P("/ws/build/iii"),
            P("/ws/install/iii/lib/python3.10/site-packages"),
            src,
        ], [src]).map(P);
        assert.deepStrictEqual(ordered, [
            src,
            P("/ws/install/iii/lib/python3.10/site-packages"),
            P("/ws/build/iii"),
            P("/ws/install/p12_msgs/local/lib/python3.10/dist-packages"),
            P("/opt/ros/humble/lib/python3.10/site-packages"),
            P("/opt/ros/humble/local/lib/python3.10/dist-packages"),
        ]);
    });
});
