/**
 * 自动加载模块 · isValidPackageXml / 包名 / 依赖 用真实 package.xml（L1 纯逻辑）
 *
 * 目标模块：src/build-tool/packages/colcon-utils.ts、src/build-tool/package-service/create/deps/dep-parse.ts
 * 层级：L1（纯函数/临时目录，本地 mocha 直接跑，无需 ROS）
 * 关联测试项：A5–A16（方案 02 §4.2 / §4.3 / §4.4）
 *
 * 策略：输入一律用 samples 真实 package.xml（不复制到测试内、不手写字符串），
 *       验证包合法性/包名/依赖解析与真实包一致。
 * 说明：colcon-utils.ts 依赖 vscode 运行时（依赖链 colcon-utils→vscode-utils→ros/utils→extension），
 *       无法无头 mocha 直跑 → 本文件走**集成环境**（npm test，本地无 ROS 也能跑 isValidPackageXml
 *       等纯文件函数；远端更佳）。dep-parse 纯逻辑同文件内、集成环境同样覆盖。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isValidPackageXml, getPackageNameFromXml } from "../../src/build-tool/package-core/api";
import { parseDepList, validateDepList } from "../../src/build-tool/package-service/create/deps/dep-parse";

/** samples 根目录 */
const SAMPLES = path.resolve(__dirname, "../../../samples");

/** samples 包目录（A5–A8 / A11–A12 输入；标准工作空间 src/ 结构） */
const PKG_CPP = path.join(SAMPLES, "src/rde_cpp");
const PKG_PY = path.join(SAMPLES, "src/rde_py");
const PKG_MSG = path.join(SAMPLES, "src/msg_interfaces");
const PKG_LAUNCH = path.join(SAMPLES, "src/launch_examples");

/** 从 package.xml 提取指定标签的文本列表（如 "<depend>" / "<buildtool_depend>" / "<test_depend>"） */
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

/** 创建临时目录（返回路径；由 afterEach 清理），可选向其中写入文件 */
function makeTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "rde-realxml-"));
}

describe("colcon-utils 真 package.xml 测试(samples)", () => {
    const tmps: string[] = [];

    afterEach(() => {
        for (const t of tmps) {
            try {
                fs.rmSync(t, { recursive: true, force: true });
            } catch { /* 清理失败不影响断言结果 */ }
        }
        tmps.length = 0;
    });

    // ---------------- A5–A8 · isValidPackageXml 用真实包 ----------------
    it("A5 isValidPackageXml(rde_cpp) → true（format=3 + CMakeLists）", async () => {
        assert.strictEqual(await isValidPackageXml(PKG_CPP), true);
    });

    it("A6 isValidPackageXml(rde_py) → true（ament_python + setup.py）", async () => {
        assert.strictEqual(await isValidPackageXml(PKG_PY), true);
    });

    it("A7 isValidPackageXml(msg_interfaces) → true（member_of_group + CMakeLists）", async () => {
        assert.strictEqual(await isValidPackageXml(PKG_MSG), true);
    });

    it("A8 isValidPackageXml(launch_examples) → true", async () => {
        assert.strictEqual(await isValidPackageXml(PKG_LAUNCH), true);
    });

    // ---------------- A9 · 非法 XML（临时目录变体） ----------------
    it("A9 拷贝 rde_cpp/package.xml 删一个 </depend> → false（XML 非法）", async () => {
        const tmp = makeTmp();
        tmps.push(tmp);
        // 拷贝并破坏 XML（删除第一个 </depend>），同时放置构建文件确保失败归因于 XML 而非缺构建文件
        let content = fs.readFileSync(path.join(PKG_CPP, "package.xml"), "utf-8");
        content = content.replace(/<\/depend>/, ""); // 非全局正则 → 只删第一个 </depend>
        fs.writeFileSync(path.join(tmp, "package.xml"), content, "utf-8");
        fs.writeFileSync(path.join(tmp, "CMakeLists.txt"), "", "utf-8");
        assert.strictEqual(await isValidPackageXml(tmp), false);
    });

    // ---------------- A10 · 缺构建文件（临时目录变体） ----------------
    it("A10 拷贝合法 package.xml 但无构建文件 → false", async () => {
        const tmp = makeTmp();
        tmps.push(tmp);
        fs.copyFileSync(path.join(PKG_CPP, "package.xml"), path.join(tmp, "package.xml"));
        assert.strictEqual(await isValidPackageXml(tmp), false);
    });

    // ---------------- A11–A12 · getPackageNameFromXml 用真实包 ----------------
    it("A11 getPackageNameFromXml(rde_cpp) → 'rde_cpp'", async () => {
        assert.strictEqual(await getPackageNameFromXml(PKG_CPP), "rde_cpp");
    });

    it("A12 getPackageNameFromXml(msg_interfaces) → 'msg_interfaces'", async () => {
        assert.strictEqual(await getPackageNameFromXml(PKG_MSG), "msg_interfaces");
    });

    // ---------------- A13 · rde_cpp 依赖 ----------------
    it("A13 rde_cpp/package.xml 的 <depend> → parseDepList → ['rclcpp','std_msgs']", () => {
        const deps = readXmlTags(path.join(PKG_CPP, "package.xml"), "depend");
        assert.deepStrictEqual(parseDepList(deps.join(" ")), ["rclcpp", "std_msgs"]);
    });

    // ---------------- A14 · msg_interfaces 依赖 ----------------
    it("A14 msg_interfaces/package.xml 的 depend 含 4 个消息包、buildtool 含 rosidl_default_generators", () => {
        const xml = path.join(PKG_MSG, "package.xml");
        const deps = readXmlTags(xml, "depend");
        assert.ok(deps.includes("builtin_interfaces"), "应含 builtin_interfaces");
        assert.ok(deps.includes("geometry_msgs"), "应含 geometry_msgs");
        assert.ok(deps.includes("std_msgs"), "应含 std_msgs");
        assert.ok(deps.includes("sensor_msgs"), "应含 sensor_msgs");
        const buildtool = readXmlTags(xml, "buildtool_depend");
        assert.ok(buildtool.includes("rosidl_default_generators"), "buildtool 应含 rosidl_default_generators");
    });

    // ---------------- A15 · rde_py 依赖 ----------------
    it("A15 rde_py/package.xml 的 depend 含 rclpy、test 依赖含 ament_flake8/python3-pytest", () => {
        const xml = path.join(PKG_PY, "package.xml");
        const deps = readXmlTags(xml, "depend");
        assert.ok(deps.includes("rclpy"), "应含 rclpy");
        const tests = readXmlTags(xml, "test_depend");
        assert.ok(tests.includes("ament_flake8"), "test 应含 ament_flake8");
        assert.ok(tests.includes("python3-pytest"), "test 应含 python3-pytest");
    });

    // ---------------- A16 · validateDepList 对真实依赖 → null ----------------
    it("A16 samples 各包真实依赖 + 对应 kind → validateDepList 返回 null", () => {
        // cpp-only：rde_cpp 的 <depend>（rclcpp/std_msgs）
        const cppDeps = parseDepList(readXmlTags(path.join(PKG_CPP, "package.xml"), "depend").join(" "));
        assert.strictEqual(validateDepList(cppDeps.join(" "), "cpp-only"), null);
        // python：rde_py 的 <depend>（rclpy/std_msgs）
        const pyDeps = parseDepList(readXmlTags(path.join(PKG_PY, "package.xml"), "depend").join(" "));
        assert.strictEqual(validateDepList(pyDeps.join(" "), "python"), null);
        // mixed：msg_interfaces 的普通消息依赖与包类型无关，也应合法
        const msgDeps = parseDepList(readXmlTags(path.join(PKG_MSG, "package.xml"), "depend").join(" "));
        assert.strictEqual(validateDepList(msgDeps.join(" "), "mixed"), null);
    });
});
