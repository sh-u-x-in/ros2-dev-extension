/**
 * urdf-docs 数据表单测(P1,05)
 *
 * 策略:纯数据 + 查询函数,无需 ROS 环境。验证:
 *  - urdfElements / geometryTypes / materialElements / jointTypes / commonAttributes 完整性
 *  - findElementDoc / findJointType 命中与未命中
 *  - elementDocMarkdown / jointTypeMarkdown 组装(非空、含关键内容)
 */

import * as assert from "assert";
import * as vscode from "vscode";

import {
    urdfElements,
    geometryTypes,
    materialElements,
    jointTypes,
    commonAttributes,
    findElementDoc,
    findJointType,
    elementDocMarkdown,
    jointTypeMarkdown
} from "../../src/languages/xacro/data/urdf-docs";

describe("urdf-docs 数据表(P1)", () => {
    it("urdfElements 含 21 个 URDF 通用元素", () => {
        const names = urdfElements.map(e => e.name);
        for (const expected of ["robot", "link", "joint", "visual", "collision", "inertial",
            "geometry", "origin", "parent", "child", "axis", "limit", "dynamics",
            "calibration", "safety_controller", "mimic", "mass", "inertia",
            "material", "color", "texture"]) {
            assert.ok(names.includes(expected), `缺少元素 ${expected}`);
        }
        // 每个元素都有签名 + 描述
        for (const e of urdfElements) {
            assert.ok(e.signature.length > 0, `${e.name} 缺 signature`);
            assert.ok(e.description.length > 0, `${e.name} 缺 description`);
        }
    });

    it("geometryTypes 含 4 种几何类型", () => {
        assert.deepStrictEqual(geometryTypes.map(e => e.name).sort(), ["box", "cylinder", "mesh", "sphere"]);
    });

    it("materialElements 含 3 种材质元素", () => {
        assert.deepStrictEqual(materialElements.map(e => e.name).sort(), ["color", "material", "texture"]);
    });

    it("jointTypes 含 6 种关节类型", () => {
        assert.deepStrictEqual(
            jointTypes.map(j => j.name).sort(),
            ["continuous", "fixed", "floating", "planar", "prismatic", "revolute"]
        );
    });

    it("commonAttributes 属性映射正确", () => {
        assert.deepStrictEqual(commonAttributes.link, ["name"]);
        assert.deepStrictEqual(commonAttributes.joint, ["name", "type"]);
        assert.deepStrictEqual(commonAttributes.origin, ["xyz", "rpy"]);
        assert.deepStrictEqual(commonAttributes.limit, ["lower", "upper", "effort", "velocity"]);
        assert.deepStrictEqual(commonAttributes.mesh, ["filename", "scale"]);
        assert.deepStrictEqual(commonAttributes.geometry, []);
        // 未知元素 → undefined(不抛)
        assert.strictEqual(commonAttributes["nonexistent" as keyof typeof commonAttributes], undefined);
    });

    it("findElementDoc 命中 URDF / 几何 / 材质,未命中返回 undefined", () => {
        assert.strictEqual(findElementDoc("joint")?.name, "joint");
        assert.strictEqual(findElementDoc("mesh")?.name, "mesh");
        assert.strictEqual(findElementDoc("color")?.name, "color");
        assert.strictEqual(findElementDoc("nonexistent"), undefined);
    });

    it("findJointType 命中 / 未命中", () => {
        assert.strictEqual(findJointType("revolute")?.name, "revolute");
        assert.strictEqual(findJointType("nonexistent"), undefined);
    });

    it("elementDocMarkdown 组装签名 + 描述 + 属性", () => {
        const md = elementDocMarkdown(findElementDoc("joint")!);
        const s = md.value;
        assert.ok(s.includes("<joint"), "应含签名");
        assert.ok(s.includes("Connects two links"), "应含中文描述");
        assert.ok(s.includes("type"), "应含属性说明");
    });

    it("jointTypeMarkdown 组装名称 + 说明", () => {
        const md = jointTypeMarkdown(findJointType("revolute")!);
        assert.ok(md.value.includes("revolute"));
        assert.ok(md.value.includes("limit"), "revolute 说明应提及 <limit>");
    });
});
