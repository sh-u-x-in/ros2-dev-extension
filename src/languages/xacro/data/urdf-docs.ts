/**
 * urdf-docs — URDF 文档数据表(设计 05)
 *
 * 纯数据 + 查询函数,供 03-Providers(hover, P1)与 04-Completion(补全, P2②③)共用。
 * 来源:rde-urdf urdfXacroCompletion.ts 提取,元素名保留英文,描述/属性说明全汉化。
 * 数据表唯一来源,避免 hover/补全双维护。
 */
import * as vscode from "vscode";

/** 元素文档 */
export interface ElementDoc {
    name: string;           // 元素名(英文,保留)
    signature: string;      // 完整签名
    description: string;    // 中文描述
    attributes: string;     // 中文属性说明(多行,`\n` 分隔)
}

/** 关节类型文档 */
export interface JointTypeDoc {
    name: string;           // 关节类型
    description: string;    // 中文说明(含约束)
}

/** URDF 通用元素 */
export const urdfElements: ElementDoc[] = [
    { name: "robot", signature: '<robot name="...">', description: vscode.l10n.t("Root element; the single robot tag"), attributes: vscode.l10n.t("name: string (required) - unique robot name") },
    { name: "link", signature: '<link name="...">', description: vscode.l10n.t("Rigid body: inertia + visual + collision"), attributes: vscode.l10n.t("name: string (required) - unique link name") },
    { name: "joint", signature: '<joint name="..." type="...">', description: vscode.l10n.t("Connects two links; type determines the motion"), attributes: vscode.l10n.t("name: string (required) - joint name\ntype: enum (required) - joint motion type") },
    { name: "visual", signature: "<visual>", description: vscode.l10n.t("Visual representation (multiple allowed)"), attributes: vscode.l10n.t("name: string (optional) - name when there are multiple visuals") },
    { name: "collision", signature: "<collision>", description: vscode.l10n.t("Collision shape (multiple allowed)"), attributes: vscode.l10n.t("name: string (optional) - name when there are multiple collisions") },
    { name: "inertial", signature: "<inertial>", description: vscode.l10n.t("Mass + inertia tensor"), attributes: vscode.l10n.t("Contains <origin>, <mass> and <inertia> elements") },
    { name: "geometry", signature: "<geometry>", description: vscode.l10n.t("Geometry shape container (box/cylinder/sphere/mesh)"), attributes: vscode.l10n.t("Contains one of <box>/<cylinder>/<sphere>/<mesh>") },
    { name: "origin", signature: '<origin xyz="..." rpy="..."/>', description: vscode.l10n.t("Pose: xyz in meters, rpy in radians"), attributes: vscode.l10n.t('xyz: vector3 (default "0 0 0") - position (m)') + '\n' + vscode.l10n.t('rpy: vector3 (default "0 0 0") - orientation (rad)') },
    { name: "parent", signature: '<parent link="..."/>', description: vscode.l10n.t("Parent link reference"), attributes: vscode.l10n.t("link: string (required) - parent link name") },
    { name: "child", signature: '<child link="..."/>', description: vscode.l10n.t("Child link reference"), attributes: vscode.l10n.t("link: string (required) - child link name") },
    { name: "axis", signature: '<axis xyz="..."/>', description: vscode.l10n.t("Joint rotation/translation axis"), attributes: 'xyz: vector3(默认 "1 0 0") - 轴方向(归一化)' },
    { name: "limit", signature: '<limit lower="..." upper="..." effort="..." velocity="..."/>', description: vscode.l10n.t("Joint limits"), attributes: vscode.l10n.t("lower: float (required) - lower limit (m or rad)\nupper: float (required) - upper limit (m or rad)\neffort: float (required) - max force/torque (N or Nm)\nvelocity: float (required) - max velocity (m/s or rad/s)") },
    { name: "dynamics", signature: '<dynamics damping="..." friction="..."/>', description: vscode.l10n.t("Joint dynamics coefficients"), attributes: vscode.l10n.t("damping: float (default 0) - damping coefficient\nfriction: float (default 0) - friction coefficient") },
    { name: "calibration", signature: '<calibration rising="..." falling="..."/>', description: vscode.l10n.t("Joint calibration reference position"), attributes: vscode.l10n.t("rising: float (optional) - rising-edge position\nfalling: float (optional) - falling-edge position") },
    { name: "safety_controller", signature: '<safety_controller soft_lower_limit="..." soft_upper_limit="..." k_position="..." k_velocity="..."/>', description: vscode.l10n.t("Safety limits and gains"), attributes: vscode.l10n.t("soft_lower_limit: float - soft lower limit\nsoft_upper_limit: float - soft upper limit\nk_position: float - position gain\nk_velocity: float (required) - velocity gain") },
    { name: "mimic", signature: '<mimic joint="..." multiplier="..." offset="..."/>', description: vscode.l10n.t("Mimic another joint"), attributes: vscode.l10n.t("joint: string (required) - mimicked joint\nmultiplier: float (default 1.0) - position multiplier\noffset: float (default 0.0) - position offset") },
    { name: "mass", signature: '<mass value="..."/>', description: vscode.l10n.t("Mass (kg)"), attributes: vscode.l10n.t("value: float (required) - mass (kg)") },
    { name: "inertia", signature: '<inertia ixx="..." ixy="..." ixz="..." iyy="..." iyz="..." izz="..."/>', description: vscode.l10n.t("Inertia tensor (kg·m²)"), attributes: vscode.l10n.t("ixx/iyy/izz: float (required) - diagonal moments of inertia (kg·m²)\nixy/ixz/iyz: float (required) - off-diagonal inertia products (kg·m²)") },
    { name: "material", signature: '<material name="...">', description: vscode.l10n.t("Material definition (reusable)"), attributes: vscode.l10n.t("name: string (required) - material name (for reuse)") },
    { name: "color", signature: '<color rgba="..."/>', description: vscode.l10n.t("RGBA color (0-1)"), attributes: vscode.l10n.t("rgba: vector4 (required) - red/green/blue/alpha (0.0-1.0)") },
    { name: "texture", signature: '<texture filename="..."/>', description: vscode.l10n.t("Texture image"), attributes: vscode.l10n.t("filename: string (required) - texture image path") },
];

/** 几何类型 */
export const geometryTypes: ElementDoc[] = [
    { name: "box", signature: '<box size="x y z"/>', description: vscode.l10n.t("Box: dimensions (meters)"), attributes: 'size: vector3(必需) - 尺寸(米, x y z)' },
    { name: "cylinder", signature: '<cylinder radius="..." length="..."/>', description: vscode.l10n.t("Cylinder: radius + length (Z axis)"), attributes: vscode.l10n.t("radius: float (required) - radius (meters)\nlength: float (required) - length along Z (meters)") },
    { name: "sphere", signature: '<sphere radius="..."/>', description: vscode.l10n.t("Sphere: radius"), attributes: vscode.l10n.t("radius: float (required) - radius (meters)") },
    { name: "mesh", signature: '<mesh filename="..." scale="x y z"/>', description: vscode.l10n.t("Mesh model (STL/DAE/OBJ/GLB/GLTF)"), attributes: 'filename: string(必需) - 网格路径(STL/DAE/OBJ/GLB/GLTF)\nscale: vector3(默认 "1 1 1") - 缩放因子' },
];

/** 材质元素 */
export const materialElements: ElementDoc[] = [
    { name: "material", signature: '<material name="...">', description: vscode.l10n.t("Material definition (color/texture)"), attributes: vscode.l10n.t("name: string (required) - material name (for reuse)") },
    { name: "color", signature: '<color rgba="..."/>', description: vscode.l10n.t("RGBA color"), attributes: vscode.l10n.t("rgba: vector4 (required) - red/green/blue/alpha (0.0-1.0)") },
    { name: "texture", signature: '<texture filename="..."/>', description: vscode.l10n.t("Texture"), attributes: vscode.l10n.t("filename: string (required) - texture image path") },
];

/** 关节类型 */
export const jointTypes: JointTypeDoc[] = [
    { name: "revolute", description: vscode.l10n.t("Revolute: rotation about an axis; **requires `<limit>`**") },
    { name: "continuous", description: vscode.l10n.t("Unlimited continuous rotation (e.g. wheels); no limit") },
    { name: "prismatic", description: vscode.l10n.t("Prismatic: translation along an axis; **requires `<limit>`**") },
    { name: "fixed", description: vscode.l10n.t("Fixed, no DoF") },
    { name: "floating", description: vscode.l10n.t("6 DoF (3 translation + 3 rotation); rare") },
    { name: "planar", description: vscode.l10n.t("Planar motion (2 translation + 1 rotation)") },
];

/** 常见属性(元素 → 属性名列表) */
export const commonAttributes: Record<string, string[]> = {
    link: ["name"],
    joint: ["name", "type"],
    origin: ["xyz", "rpy"],
    geometry: [],
    material: ["name"],
    color: ["rgba"],
    mesh: ["filename", "scale"],
    box: ["size"],
    cylinder: ["radius", "length"],
    sphere: ["radius"],
    limit: ["lower", "upper", "effort", "velocity"],
    axis: ["xyz"]
};

/** 按名查元素文档(URDF + 几何 + 材质),未命中返回 undefined */
export function findElementDoc(name: string): ElementDoc | undefined {
    return (
        urdfElements.find(e => e.name === name) ||
        geometryTypes.find(e => e.name === name) ||
        materialElements.find(e => e.name === name)
    );
}

/** 按名查关节类型文档 */
export function findJointType(name: string): JointTypeDoc | undefined {
    return jointTypes.find(j => j.name === name);
}

/** hover 组装:中文签名 + 描述 + 属性清单(Markdown) */
export function elementDocMarkdown(doc: ElementDoc): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendCodeblock(doc.signature, "xml");
    md.appendMarkdown(`\n\n**${doc.description}**\n`);
    if (doc.attributes) {
        md.appendMarkdown(`\n### 属性\n\`\`\`\n${doc.attributes}\n\`\`\``);
    }
    return md;
}

/** 关节类型文档 Markdown */
export function jointTypeMarkdown(doc: JointTypeDoc): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${doc.name}**\n\n${doc.description}`);
    return md;
}
