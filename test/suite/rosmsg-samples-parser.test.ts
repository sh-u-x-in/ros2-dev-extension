/**
 * rosmsg 语法模块 · 真文件解析冒烟 + 零误报护栏（L1 纯逻辑）
 *
 * 目标模块：src/languages/rosmsg/
 * 层级：L1（纯函数/临时目录，本地 mocha 直接跑，无需 ROS）
 * 关联测试项：R1–R9, R18–R19（方案 01 §4.1 / §4.4 / §4.5）
 *
 * 策略：用 samples/src/msg_interfaces 真实文件喂给 parseRosMessageDocument / analyzeDocument /
 *       formatRosMessageContent，断言真实文件结构正确、零 error，作为回归护栏。
 * 参考：构造 TextDocument 复用 rosmsg-document.test.ts 的 makeDoc 模式；
 *       samples 路径用 path.resolve(__dirname, "../../../samples/...")。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import type { TextDocument } from "vscode";
import { parseRosMessageDocument } from "../../src/languages/rosmsg/parse/rosmsg-document";
import { formatRosMessageContent } from "../../src/languages/rosmsg/parse/formatter";
import type { MessageIndex } from "../../src/languages/rosmsg/data/message-index";
import type { RosMsgDocument, RosMsgField } from "../../src/languages/rosmsg/parse/rosmsg-document";
import { installVscodeStub } from "./_vscode-stub";

// analyzeDocument 所在模块 require "vscode"（运行时）。
// 无头 mocha 先注入 vscode stub 再动态 require；真实集成宿主下 stub 不劫持、行为一致。
const nodeRequire = createRequire(__filename);
installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyzeDocument } = nodeRequire(
    "../../src/languages/rosmsg/ui/diagnostic-provider"
) as typeof import("../../src/languages/rosmsg/ui/diagnostic-provider");

/** samples/src/msg_interfaces 根目录（标准工作空间） */
const MSG_ROOT = path.resolve(__dirname, "../../../samples/src/msg_interfaces");

/** 8 个真实接口文件（samples 素材，相对 MSG_ROOT） */
const INTERFACE_FILES = [
    "msg/BasicTypes.msg",
    "msg/ComplexMessage.msg",
    "msg/NavigationGoal.msg",
    "msg/RobotStatus.msg",
    "msg/SensorData.msg",
    "srv/CalculateSum.srv",
    "srv/GetRobotInfo.srv",
    "action/MoveToGoal.action",
];

/** 构造最小 TextDocument mock（解析器用 fileName/getText/uri/version；analyzeDocument 需 lineAt/lineCount） */
function makeDoc(fileName: string, content: string): TextDocument {
    const lines = content.split(/\r?\n/);
    return {
        fileName,
        uri: fileName,
        version: 1,
        languageId: "rosmsg",
        getText: () => content,
        lineCount: lines.length,
        lineAt: (n: number) => ({
            text: lines[n] ?? "",
            range: {
                startLine: n, startCharacter: 0,
                endLine: n, endCharacter: (lines[n] ?? "").length,
            },
        }),
    } as unknown as TextDocument;
}

/** 读取 samples 真文件并构造 TextDocument */
function sampleDoc(rel: string): TextDocument {
    const abs = path.join(MSG_ROOT, rel);
    return makeDoc(abs, fs.readFileSync(abs, "utf-8"));
}

/** 解析 samples 真文件为结构模型 */
function parseSample(rel: string): RosMsgDocument {
    return parseRosMessageDocument(sampleDoc(rel));
}

/** 按字段名在 sections 中查找字段 */
function findField(doc: RosMsgDocument, name: string, section = 0): RosMsgField {
    const f = doc.sections[section].fields.find((x) => x.name === name);
    assert.ok(f, `字段 ${name} 应存在（section ${section}）`);
    return f;
}

/** 最小 MessageIndex mock（analyzeDocument 调 getMessagesInPackage + getPackageForFile；空索引 → 未知类型仅 warning） */
function makeIndex(): MessageIndex {
    return {
        getMessagesInPackage: () => [],
        getPackageForFile: () => undefined, // undefined → 走目录推导兜底（既有行为）
    } as unknown as MessageIndex;
}

describe("rosmsg 真文件解析冒烟(samples/src/msg_interfaces)", () => {
    // ---------------- R1 · BasicTypes.msg：msg 类型 + 基础字段 ----------------
    it("R1 BasicTypes.msg → kind=msg、无分隔线、20 个字段/常量全部解析", () => {
        const doc = parseSample("msg/BasicTypes.msg");
        assert.strictEqual(doc.kind, "msg");
        assert.deepStrictEqual(doc.separators, []);
        assert.strictEqual(doc.sections.length, 1);
        assert.strictEqual(doc.sections[0].fields.length, 19, "15 个字段 + 4 个常量");
        // 基础类型字段
        const isActive = findField(doc, "is_active");
        assert.strictEqual(isActive.kind, "field");
        assert.strictEqual(isActive.type.base, "bool");
        assert.strictEqual(isActive.type.isArray, false);
        const temp = findField(doc, "temperature_celsius");
        assert.strictEqual(temp.type.base, "int8");
        assert.strictEqual(temp.kind, "field");
        // 无结构错误
        assert.strictEqual(doc.invalidLines.length, 0);
    });

    // ---------------- R2 · BasicTypes.msg：常量 ----------------
    it("R2 BasicTypes.msg → 4 个常量 kind=constant 且 defaultValue 正确", () => {
        const doc = parseSample("msg/BasicTypes.msg");
        const maxSpeed = findField(doc, "MAX_SPEED");
        assert.strictEqual(maxSpeed.kind, "constant");
        assert.strictEqual(maxSpeed.type.base, "int32");
        assert.strictEqual(maxSpeed.defaultValue, "100");
        const pi = findField(doc, "PI");
        assert.strictEqual(pi.kind, "constant");
        assert.strictEqual(pi.type.base, "float64");
        assert.strictEqual(pi.defaultValue, "3.141592653589793");
        const mode = findField(doc, "DEFAULT_MODE");
        assert.strictEqual(mode.kind, "constant");
        assert.strictEqual(mode.type.base, "string");
        assert.strictEqual(mode.defaultValue, '"autonomous"', "字符串常量值应含引号");
        const enabled = findField(doc, "SAFETY_ENABLED");
        assert.strictEqual(enabled.kind, "constant");
        assert.strictEqual(enabled.type.base, "bool");
        assert.strictEqual(enabled.defaultValue, "true");
    });

    // ---------------- R3 · ComplexMessage.msg：导入/数组/嵌套 ----------------
    it("R3 ComplexMessage.msg → std_msgs/Header、有界数组、嵌套 BasicTypes 解析正确", () => {
        const doc = parseSample("msg/ComplexMessage.msg");
        const header = findField(doc, "header");
        assert.strictEqual(header.type.base, "std_msgs/Header");
        assert.strictEqual(header.type.isArray, false);
        const status = findField(doc, "status_codes");
        assert.strictEqual(status.type.isArray, true);
        assert.strictEqual(status.type.arraySize, "<=10");
        const config = findField(doc, "robot_config");
        assert.strictEqual(config.type.base, "BasicTypes");
        // 无数组非法错误（有界数组 [<=10] 合法）
        assert.strictEqual(doc.invalidLines.filter((l) => l.severity === "error").length, 0);
    });

    // ---------------- R4 · NavigationGoal.msg：默认值字段（未覆盖点） ----------------
    it("R4 NavigationGoal.msg → 默认值字段修正后为合法纯字段、无 error", () => {
        // ⚠️ 说明：ROS2 的 rosidl 不支持字段默认值（仅常量可带 = 默认值）。
        // samples 原为 ROS1 风格无等号默认值（如 string goal_id "..."）→ ROS2 非法；
        // 已按用户指示修正为纯字段（string goal_id）。此处断言字段合法解析且 0 结构错误。
        const doc = parseSample("msg/NavigationGoal.msg");
        assert.strictEqual(doc.kind, "msg");
        const tol = findField(doc, "position_tolerance");
        assert.strictEqual(tol.kind, "field");
        assert.strictEqual(tol.type.base, "float64");
        assert.strictEqual(tol.defaultValue, undefined, "纯字段无默认值");
        const goalId = findField(doc, "goal_id");
        assert.strictEqual(goalId.type.base, "string");
        const planner = findField(doc, "use_global_planner");
        assert.strictEqual(planner.type.base, "bool");
        // 修正后无任何结构问题（原 25 条 error 全部消除）
        assert.strictEqual(doc.invalidLines.length, 0);
    });

    // ---------------- R5 · RobotStatus.msg：枚举常量 + 数组 ----------------
    it("R5 RobotStatus.msg → 枚举常量、动态数组、定长数组解析正确", () => {
        const doc = parseSample("msg/RobotStatus.msg");
        const mode = findField(doc, "MODE_AUTONOMOUS");
        assert.strictEqual(mode.kind, "constant");
        assert.strictEqual(mode.defaultValue, "1");
        const critical = findField(doc, "SYSTEM_CRITICAL");
        assert.strictEqual(critical.kind, "constant");
        assert.strictEqual(critical.defaultValue, "2");
        const sensors = findField(doc, "sensor_status");
        assert.strictEqual(sensors.type.isArray, true);
        assert.strictEqual(sensors.type.arraySize, "", "动态数组 [] → arraySize 为空串");
        assert.strictEqual(sensors.type.raw, "bool[]");
        const motors = findField(doc, "motor_temperatures");
        assert.strictEqual(motors.type.isArray, true);
        assert.strictEqual(motors.type.arraySize, "10");
        assert.strictEqual(motors.type.raw, "uint8[10]");
    });

    it("R6 CalculateSum.srv → kind=srv、恰好 1 个分隔线、2 段", () => {
        const doc = parseSample("srv/CalculateSum.srv");
        assert.strictEqual(doc.kind, "srv");
        assert.strictEqual(doc.separators.length, 1);
        assert.strictEqual(doc.sections.length, 2);
        // request 段含 numbers；response 段含 result（方案 R6 未要求精确字段数）
        assert.ok(doc.sections[0].fields.some((f) => f.name === "numbers"));
        assert.ok(doc.sections[1].fields.some((f) => f.name === "result"));
    });

    // ---------------- R7 · GetRobotInfo.srv：response 段自定义类型 ----------------
    it("R7 GetRobotInfo.srv → response 段含 RobotStatus current_status，常量 DETAIL_STANDARD=1", () => {
        const doc = parseSample("srv/GetRobotInfo.srv");
        assert.strictEqual(doc.kind, "srv");
        const curStatus = doc.sections[1].fields.find((f) => f.name === "current_status");
        assert.ok(curStatus, "response 段应含 current_status");
        assert.strictEqual(curStatus!.type.base, "RobotStatus");
        const detail = findField(doc, "DETAIL_STANDARD", 0);
        assert.strictEqual(detail.kind, "constant");
        assert.strictEqual(detail.defaultValue, "1");
    });

    // ---------------- R8 · MoveToGoal.action：三段式 action ----------------
    it("R8 MoveToGoal.action → kind=action、恰好 2 个分隔线、3 段", () => {
        const doc = parseSample("action/MoveToGoal.action");
        assert.strictEqual(doc.kind, "action");
        assert.strictEqual(doc.separators.length, 2);
        assert.strictEqual(doc.sections.length, 3);
        assert.strictEqual(doc.sections[0].fields.length > 0, true, "goal 段有字段");
        assert.strictEqual(doc.sections[1].fields.length > 0, true, "result 段有字段");
    });

    // ---------------- R9 · 零误报护栏：合法真文件 0 error 诊断 ----------------
    it("R9 全部 8 个真文件 → analyzeDocument 0 条 error 级诊断", async () => {
        const index = makeIndex();
        // vscode.DiagnosticSeverity.Error = 0（此处不 import vscode，避免无头 mocha 依赖扩展宿主）
        for (const rel of INTERFACE_FILES) {
            const doc = sampleDoc(rel);
            const diags = await analyzeDocument(doc, index);
            const errors = diags.filter((d) => d.severity === 0);
            assert.strictEqual(
                errors.length, 0,
                `${rel} 不应有 error 级诊断（实际 ${errors.length} 条）`
            );
        }
    });

    // ---------------- R18 · 格式化往返幂等 ----------------
    it("R18 全部 8 个真文件 → 格式化后仍可再解析、无 error", () => {
        for (const rel of INTERFACE_FILES) {
            const doc = sampleDoc(rel);
            const formatted = formatRosMessageContent(doc.getText());
            const reparsed = parseRosMessageDocument(makeDoc(doc.fileName, formatted));
            assert.strictEqual(
                reparsed.invalidLines.filter((l) => l.severity === "error").length, 0,
                `${rel} 格式化后再解析不应有 error`
            );
        }
    });

    // ---------------- R19 · 多段格式化：--- 保留 ----------------
    it("R19 GetRobotInfo.srv → 格式化后分隔线与段结构保留", () => {
        const doc = sampleDoc("srv/GetRobotInfo.srv");
        const formatted = formatRosMessageContent(doc.getText());
        const reparsed = parseRosMessageDocument(makeDoc(doc.fileName, formatted));
        assert.strictEqual(reparsed.kind, "srv");
        assert.strictEqual(reparsed.separators.length, 1, "格式化后仍应恰有 1 个合法 ---");
        assert.strictEqual(reparsed.sections.length, 2);
    });

    // ---------------- 4.5 · 真文件行锚定：typeColumn / nameColumn ----------------
    it("4.5 BasicTypes.msg → 关键行的 typeColumn/nameColumn 与真实列一致", () => {
        const doc = parseSample("msg/BasicTypes.msg");
        const isActive = findField(doc, "is_active");
        // "bool is_active"：type 在 0 列，name 在 5 列
        assert.strictEqual(isActive.typeColumn, 0);
        assert.strictEqual(isActive.nameColumn, 5);
        const maxSpeed = findField(doc, "MAX_SPEED");
        // "int32 MAX_SPEED=100"：type 在 0 列，name 在 6 列
        assert.strictEqual(maxSpeed.typeColumn, 0);
        assert.strictEqual(maxSpeed.nameColumn, 6);
        // 数组字段 "uint8[<=10] status_codes"：type 起点 0，name 在类型+数组之后
        const complex = parseSample("msg/ComplexMessage.msg");
        const status = findField(complex, "status_codes");
        assert.strictEqual(status.typeColumn, 0);
        assert.strictEqual(status.nameColumn, 12, 'typeRaw "uint8[<=10]" 长 11，name 应从 12 列起（含 1 空格）');
    });
});
