/**
 * 包创建模块 · 结构对照 samples + 往返测试 + 内容正确性（L1 纯逻辑/临时目录）
 *
 * 目标模块：src/build-tool/package-service/create/generate/create-cpp-package.ts、create-python-package.ts、
 *          packages/colcon-utils.ts（isValidPackageXml）、create/dep-parse.ts
 * 层级：L1（纯函数/临时目录）；⚠️ 因 P5–P8 依赖 colcon-utils（require vscode 运行时），
 *      本文件走**集成环境**（npm test）验证；本地无 ROS 也能跑（纯文件操作），远端更佳。
 * 关联测试项：P1–P12（方案 03 §4.1 / §4.2 / §4.3）
 *
 * 策略：生成树 vs samples 真实包结构逐一对应；"生成→落盘→识别"往返测试（防建出的包自己认不出）；
 *       生成内容只验证关键字段（name/depend/build_type），不逐字节比对。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateCppPackageFiles, disambiguateNodeNames } from "../../src/build-tool/package-service/create/generate/create-cpp-package";
import { generatePythonPackageFiles } from "../../src/build-tool/package-service/create/generate/create-python-package";
import { isValidPackageXml, getPackageNameFromXml } from "../../src/build-tool/package-core/api";

/** GeneratedFile 形状（cpp/py 均有 path/content/directory?） */
interface GeneratedFileLike {
    path: string;
    content: string;
    directory?: boolean;
}

/** 将生成的文件清单落盘到临时目录（directory:true 仅建目录） */
function writeGenerated(root: string, files: GeneratedFileLike[]): void {
    for (const f of files) {
        const abs = path.join(root, f.path);
        if (f.directory) {
            fs.mkdirSync(abs, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.content, "utf-8");
        }
    }
}

/** 提取 package.xml 指定标签文本列表 */
function readXmlTags(packageXmlPath: string, tag: string): string[] {
    const content = fs.readFileSync(packageXmlPath, "utf-8");
    const re = new RegExp(`<${tag}\\s*>\\s*([^<]+?)\\s*<\\/${tag}>`, "g");
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        out.push(m[1].trim());
    }
    return out;
}

describe("包创建往返与内容测试(samples 对照)", () => {
    const tmps: string[] = [];

    afterEach(() => {
        for (const t of tmps) {
            try {
                fs.rmSync(t, { recursive: true, force: true });
            } catch { /* 忽略清理失败 */ }
        }
        tmps.length = 0;
    });

    function makeTmp(): string {
        const t = fs.mkdtempSync(path.join(os.tmpdir(), "rde-pkg-"));
        tmps.push(t);
        return t;
    }

    // ---------------- P1 · C++ 包结构对照 samples ----------------
    it("P1 cpp-only 生成树含 package.xml/CMakeLists/include/<pkg>/空目录/src 双节点", () => {
        const files = generateCppPackageFiles({ packageName: "rde_cpp", kind: "cpp-only" });
        const paths = files.map((f) => f.path);
        // 顶层结构逐一对应 samples/src/rde_cpp（标准工作空间）
        assert.ok(paths.includes("package.xml"), "应含 package.xml");
        assert.ok(paths.includes("CMakeLists.txt"), "应含 CMakeLists.txt");
        assert.ok(paths.includes("include/rde_cpp/"), "应含 include/rde_cpp/ 空目录");
        assert.ok(paths.includes("src/cpp_node_1.cpp"), "应含 src/cpp_node_1.cpp");
        assert.ok(paths.includes("src/cpp_node_2.cpp"), "应含 src/cpp_node_2.cpp");
        // include/<pkg>/ 是空目录（生成器不产出 .hpp 头文件）
        const include = files.find((f) => f.path === "include/rde_cpp/");
        assert.strictEqual(include!.directory, true, "include/rde_cpp/ 应为 directory 标记");
    });

    // ---------------- P2 · mixed 包（C++ + Python 模块） ----------------
    it("P2 mixed 生成树同时含 C++ 节点与 Python 模块 x/py_node_1.py + __init__.py", () => {
        const files = generateCppPackageFiles({ packageName: "x", kind: "mixed" });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes("src/cpp_node_1.cpp"), "应含 C++ 节点");
        assert.ok(paths.includes("x/py_node_1.py"), "应含 Python 模块 x/py_node_1.py（默认节点 py_node_1）");
        assert.ok(paths.includes("x/__init__.py"), "应含 x/__init__.py");
    });

    // ---------------- P3 · Python 包结构对照 samples ----------------
    it("P3 ament_python 生成树含 setup.py/setup.cfg/package.xml/resource/rde_py/rde_py/<node>.py", () => {
        const files = generatePythonPackageFiles({
            packageName: "rde_py",
            nodeNames: ["rde_publisher", "rde_subscriber"],
        });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes("setup.py"));
        assert.ok(paths.includes("setup.cfg"));
        assert.ok(paths.includes("package.xml"));
        assert.ok(paths.includes("resource/rde_py"));
        assert.ok(paths.includes("rde_py/rde_publisher.py"));
        assert.ok(paths.includes("rde_py/rde_subscriber.py"));
    });

    // ---------------- P4 · 空节点名 ----------------
    it("P4 空 nodeNames 不生成节点模块文件（仍生成 __init__.py/py.typed/test）", () => {
        const files = generatePythonPackageFiles({ packageName: "x", nodeNames: [] });
        const paths = files.map((f) => f.path);
        // 除 __init__.py / py.typed 外，不应有 x/<小写节点>.py
        assert.ok(!paths.some((p) => /^x\/[a-z][a-z0-9_]*\.py$/.test(p)), "不应生成节点模块文件");
        assert.ok(paths.includes("x/__init__.py"), "仍应生成 __init__.py");
    });

    // ---------------- P5 · C++ 往返：生成→落盘→isValidPackageXml ----------------
    it("P5 生成的 C++ 包落盘后被 isValidPackageXml 判为合法", async () => {
        const tmp = makeTmp();
        const files = generateCppPackageFiles({ packageName: "roundtrip_cpp", kind: "cpp-only" });
        writeGenerated(tmp, files);
        assert.strictEqual(await isValidPackageXml(tmp), true);
    });

    // ---------------- P6 · Python 往返 ----------------
    it("P6 生成的 Python 包落盘后被 isValidPackageXml 判为合法", async () => {
        const tmp = makeTmp();
        const files = generatePythonPackageFiles({ packageName: "roundtrip_py", nodeNames: ["n1"] });
        writeGenerated(tmp, files);
        assert.strictEqual(await isValidPackageXml(tmp), true);
    });

    // ---------------- P7 · 往返：包名读回 ----------------
    it("P7 落盘后 getPackageNameFromXml 返回生成包名（cpp/py）", async () => {
        const tmpCpp = makeTmp();
        writeGenerated(tmpCpp, generateCppPackageFiles({ packageName: "rt_cpp", kind: "cpp-only" }));
        assert.strictEqual(await getPackageNameFromXml(tmpCpp), "rt_cpp");
        const tmpPy = makeTmp();
        writeGenerated(tmpPy, generatePythonPackageFiles({ packageName: "rt_py", nodeNames: [] }));
        assert.strictEqual(await getPackageNameFromXml(tmpPy), "rt_py");
    });

    // ---------------- P8 · 往返：依赖读回 ----------------
    it("P8 落盘后提取 <depend>：cpp 含 rclcpp、py 含 rclpy，无多余", async () => {
        const tmpCpp = makeTmp();
        writeGenerated(tmpCpp, generateCppPackageFiles({ packageName: "rt_cpp", kind: "cpp-only" }));
        const cppDeps = readXmlTags(path.join(tmpCpp, "package.xml"), "depend");
        assert.ok(cppDeps.includes("rclcpp"), "C++ 包 <depend> 应含 rclcpp");
        assert.ok(cppDeps.length <= 1, "默认 cpp-only 无多余运行时依赖");

        const tmpPy = makeTmp();
        writeGenerated(tmpPy, generatePythonPackageFiles({ packageName: "rt_py", nodeNames: [] }));
        const pyDeps = readXmlTags(path.join(tmpPy, "package.xml"), "depend");
        assert.ok(pyDeps.includes("rclpy"), "Python 包 <depend> 应含 rclpy");
    });

    // ---------------- P9 · C++ package.xml 内容 ----------------
    it("P9 生成 package.xml 含 <name>my_pkg</name>/<depend>rclcpp</depend>/<build_type>ament_cmake</build_type>", () => {
        const files = generateCppPackageFiles({ packageName: "my_pkg", kind: "cpp-only" });
        const xml = files.find((f) => f.path === "package.xml")!.content;
        assert.ok(xml.includes("<name>my_pkg</name>"));
        assert.ok(xml.includes("<depend>rclcpp</depend>"));
        assert.ok(xml.includes("<build_type>ament_cmake</build_type>"));
    });

    // ---------------- P10 · CMakeLists 逐节点 add_executable ----------------
    it("P10 覆盖节点名 ['a','b'] → CMakeLists.txt 含两个 add_executable", () => {
        const files = generateCppPackageFiles({ packageName: "my_pkg", kind: "cpp-only", cppNodes: ["a", "b"] });
        const cmake = files.find((f) => f.path === "CMakeLists.txt")!.content;
        assert.ok(cmake.includes("add_executable(a src/a.cpp)"));
        assert.ok(cmake.includes("add_executable(b src/b.cpp)"));
    });

    // ---------------- P11 · Python 内容 ----------------
    it("P11 setup.py 注册 n1、package.xml <build_type>ament_python</build_type>", () => {
        const files = generatePythonPackageFiles({ packageName: "my_py", nodeNames: ["n1"] });
        const setupPy = files.find((f) => f.path === "setup.py")!.content;
        const xml = files.find((f) => f.path === "package.xml")!.content;
        // entry_points 注册 n1（console_scripts 内出现 n1 入口）
        assert.ok(setupPy.includes("n1"), "setup.py 应注册节点 n1");
        assert.ok(xml.includes("<build_type>ament_python</build_type>"));
    });

    // ---------------- P12 · 跨语言同名 + 映射顺延 ----------------
    it("P12 跨语言同名允许 + 有损映射顺延(file 不变, node 顺延)", () => {
        // 跨语言同名: cpp-dual 的 C++ 与脚本同名 → 文件分属 src/ 与 scripts/, 不冲突
        const files = generateCppPackageFiles({
            packageName: "p", kind: "cpp-dual",
            cppNodes: ["node"], pythonNodes: ["node"],
        });
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes("src/node.cpp"), "应含 C++ 源文件 src/node.cpp");
        assert.ok(paths.includes("scripts/node.py"), "应含脚本 scripts/node.py");
        // 有损映射 + 顺延: my-node 与 my_node 文件不同, 节点名顺延为 my_node / my_node_1
        const specs = disambiguateNodeNames(["my-node", "my_node"]);
        assert.deepStrictEqual(specs, [
            { file: "my-node", node: "my_node" },
            { file: "my_node", node: "my_node_1" },
        ]);
    });
});
