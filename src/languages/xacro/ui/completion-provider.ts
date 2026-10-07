/**
 * URDF/xacro 结构补全提供器(*.urdf / *.xacro)
 *
 * 由原 snippets/urdf.json 的 50 个静态片段转制(用户决定:全部转代码补全):
 *  - URDF 通用片段(scope=both):.urdf 与 .xacro 都提供
 *  - xacro 专属片段(scope=xacro):仅 .xacro 提供 → .urdf 里不会出现 xacro 结构(互斥)
 *  - 其它 xml 文件(launch xml / srdf 等)不提供 → 避免 URDF 片段污染 xml 语言
 *  - insertText 用 SnippetString,兼得"片段展开"与"动态激活/上下文感知"
 *
 * 注意:片段 body 中 xacro 运行时表达式 ${...} 需转义为 \${...}(SnippetString 解析后还原为字面)
 */

import { l10n } from "vscode";


import * as vscode from "vscode";
import * as path from "path";
import { promises as fsp } from "fs";
import { getLogger } from "../../../logger";
import { readFollowSymlinksSetting } from "../../../vscode-utils";
import { IncludeGraph, SymbolRef } from "../core/include-graph";
import type { PackageMap } from "../../shared/package-map";
import { getCursorContextFromTree } from "../parse/context-locator";
import { jointTypes, commonAttributes } from "../data/urdf-docs";
import { collectMacroParamSpans, enclosingMacroSpan } from "./diagnostic-provider";
import { docModelOf, verbatimCommentInner } from "./provider-utils";
import { collectNsTable } from "./ns-resolve";
import { EVAL_GLOBALS, fixedTagOf } from "../parse/xacro-tags";
import type { XacroDocument } from "../parse/xacro-document";

const log = getLogger("urdf-completion");

/** 单个补全片段定义 */
interface Snippet {
    prefix: string | string[];
    body: string[];
    description: string;
    /** both=URDF/xacro 通用, xacro=xacro 专属 */
    scope: "both" | "xacro";
}

/**
 * 条目消歧短提示(2026-09-08,对齐 launch 补全):同类 prefix 的多个片段在列表里
 * 直接可见中文关键词(如 box(长方体) vs box(几何·长方体)),帮助在条目层区分;
 * 中文永远跟在标识符后、不前置(前置会伤模糊匹配)。detail 仍保留完整 description。
 */
const SNIPPET_HINTS: Record<string, string> = {
    "Insert box": vscode.l10n.t("box"),
    "Insert geometry (box)": vscode.l10n.t("geo·box"),
    "Insert cylinder": vscode.l10n.t("cylinder"),
    "Insert geometry (cylinder)": vscode.l10n.t("geo·cylinder"),
    "Insert sphere": vscode.l10n.t("sphere"),
    "Insert geometry (sphere)": vscode.l10n.t("geo·sphere"),
    "Insert mesh": vscode.l10n.t("mesh"),
    "Insert geometry (mesh)": vscode.l10n.t("geo·mesh"),
    "Insert basic geometry": vscode.l10n.t("basic"),
    "Insert full geometry": vscode.l10n.t("full"),
    "Insert basic inertia": vscode.l10n.t("basic"),
    "Insert full inertia": vscode.l10n.t("full"),
    "Insert basic joint": vscode.l10n.t("basic"),
    "Insert full joint": vscode.l10n.t("full"),
    "Insert basic link": vscode.l10n.t("basic"),
    "Insert full link": vscode.l10n.t("full"),
    "Insert material": vscode.l10n.t("material"),
    "Insert material with color": vscode.l10n.t("color"),
    "Insert material with color and texture": vscode.l10n.t("color·texture"),
    "Insert single-line material tag": vscode.l10n.t("single-line"),
    "Insert basic origin": vscode.l10n.t("basic"),
    "Insert origin with rpy rotation": vscode.l10n.t("rpy"),
    "Insert origin with xyz coordinates": vscode.l10n.t("xyz"),
    "Insert origin with xyz and rpy": vscode.l10n.t("xyz·rpy"),
    "Insert color": vscode.l10n.t("generic"),
    "Insert red": vscode.l10n.t("red"),
    "Insert green": vscode.l10n.t("green"),
    "Insert blue": vscode.l10n.t("blue"),
    "Insert collision": vscode.l10n.t("collision"),
    "Insert collision with origin": vscode.l10n.t("collision·origin"),
    "Insert visual": vscode.l10n.t("visual"),
    "Insert visual with origin": vscode.l10n.t("visual·origin"),
    "Insert basic robot": vscode.l10n.t("basic"),
    "Insert robot with xacro support": vscode.l10n.t("xacro·named"),
    "Insert xacro robot without name": vscode.l10n.t("xacro·unnamed")
};

/**
 * filterText 组装(2026-09-08 修正,保留符号):
 * 旧决策(对齐 launch)"取插入结构前半段主词,如 <env name=… value=…/> → env name"只留裸单词,
 * 若编辑器匹配输入是带符号的片段(如 `<env n`),"<"、空格在 filterText 里不存在 → 永远无法命中。
 * 现改为两段拼接的**超集**:
 *  ① snippetHeadLiteral:保留 `<env name=` 这类带 `<`/`=` 的结构头字面量(纯 ASCII);
 *  ② snippetWordTokens:整段去 ${…} 占位/引号值后的标识符流(标签名 + 属性名,≤8 词,原逻辑)。
 * filterText = 头字面量 + 单词流:纯字母输入命中不变(超集不回退),带符号输入亦可子序列命中;
 * 中文仅留在 label,不进 filterText(避免伤模糊匹配)。
 */
const FILTER_MAX_TOKENS = 8;
const FILTER_HEAD_MAX_CHARS = 48;

/** 结构头字面量:取正文首个非空行,去 ${…}/$n 占位与引号值后**保留符号**的片段(如 `<box size=`)。 */
function snippetHeadLiteral(body: string[]): string {
    for (const raw of body) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        const cleaned = line
            .replace(/\$\{[^}]*\}/g, " ") // ${1:…} 占位 / ${2|a,b|} 选项表
            .replace(/\$\d+/g, " ") // $0 收尾占位
            .replace(/"[^"]*"/g, "") // 引号及其值整体去掉,保留 "="
            .replace(/'[^']*'/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/[^\x20-\x7E]/g, "") // 仅 ASCII(结构符号均在 ASCII 域)
            .trim();
        if (!/[A-Za-z]/.test(cleaned)) {
            continue; // 无字母的残留(如只剩引号)不算结构头
        }
        // 收尾去多余的 "/> " 等,保留结尾 "="(如 `<box size=`)
        return cleaned.slice(0, FILTER_HEAD_MAX_CHARS).replace(/[\s/>]+$/g, "");
    }
    return "";
}

/** filterText 单词流(原 snippetFilterTokens 语义):并入原 prefix、去重限量、纯 ASCII。 */
function snippetWordTokens(prefix: string, body: string[]): string[] {
    const seen = new Set<string>();
    const tokens: string[] = [];
    const add = (w: string): void => {
        if (w && !seen.has(w)) {
            seen.add(w);
            tokens.push(w);
        }
    };
    add(prefix);
    outer:
    for (const line of body) {
        if (tokens.length >= FILTER_MAX_TOKENS) {
            break;
        }
        // ${…} 占位、引号内的值(含 ${} 表达式)、HTML 实体等不参与
        const cleaned = line
            .replace(/\$\{[^}]*\}/g, " ")
            .replace(/"[^"]*"/g, " ")
            .replace(/'[^']*'/g, " ");
        const words = cleaned.match(/[A-Za-z0-9_]+/g);
        if (!words) {
            continue;
        }
        for (const w of words) {
            if (/^[0-9]+$/.test(w)) {
                continue; // 纯数字/占位序号不是主词
            }
            add(w);
            if (tokens.length >= FILTER_MAX_TOKENS) {
                break outer;
            }
        }
    }
    return tokens;
}

/** 片段 → filterText:符号化结构头 + 单词流(超集,见头部注释)。 */
function snippetFilterText(prefix: string, body: string[]): string {
    return [snippetHeadLiteral(body), snippetWordTokens(prefix, body).join(" ")]
        .filter(Boolean)
        .join(" ");
}

/** 全部 URDF/xacro 结构片段(由 snippets/urdf.json 转制) */
const SNIPPETS: Snippet[] = [
    { prefix: "axis", body: ['<axis xyz="${1:0.0} ${2:0.0} ${3:0.0}"/>'], description: l10n.t("Insert axis coordinates"), scope: "both" },
    { prefix: "box", body: ['<box size="${1:0.0} ${2:0.0} ${3:0.0}"/>'], description: vscode.l10n.t("Insert box"), scope: "both" },
    {
        prefix: "collision",
        body: ["<collision>", "\t$0", "</collision>"],
        description: vscode.l10n.t("Insert collision"),
        scope: "both"
    },
    {
        prefix: "collision",
        body: [
            "<collision>",
            "\t<origin xyz=\"${1:0.0} ${2:0.0} ${3:0.0}\" rpy=\"${4:0.0} ${5:0.0} ${6:0.0}\"/>",
            "\t$0",
            "</collision>"
        ],
        description: vscode.l10n.t("Insert collision with origin"),
        scope: "both"
    },
    { prefix: "color", body: ['<color rgba="${1:0.0} ${2:0.0} ${3:0.0} ${4:0.0}"/>'], description: vscode.l10n.t("Insert color"), scope: "both" },
    {
        prefix: ["color", "red"],
        body: ["<color rgba=\"1.0 0.0 0.0 0.0\"/>", "$0"],
        description: vscode.l10n.t("Insert red"),
        scope: "both"
    },
    {
        prefix: ["color", "green"],
        body: ["<color rgba=\"0.0 1.0 0.0 0.0\"/>", "$0"],
        description: vscode.l10n.t("Insert green"),
        scope: "both"
    },
    {
        prefix: ["color", "blue"],
        body: ["<color rgba=\"0.0 0.0 1.0 0.0\"/>", "$0"],
        description: vscode.l10n.t("Insert blue"),
        scope: "both"
    },
    { prefix: "cylinder", body: ['<cylinder radius="${1:0.0}" length="${2:0.0}"/>'], description: vscode.l10n.t("Insert cylinder"), scope: "both" },
    {
        prefix: "geometry",
        body: ["<geometry>", "\t$0", "</geometry>"],
        description: vscode.l10n.t("Insert basic geometry"),
        scope: "both"
    },
    {
        prefix: "box",
        body: ["<geometry>", "\t<box size=\"${1:0.0} ${2:0.0} ${3:0.0}\"/>", "</geometry>$0"],
        description: vscode.l10n.t("Insert geometry (box)"),
        scope: "both"
    },
    {
        prefix: "cylinder",
        body: ["<geometry>", "\t<cylinder radius=\"${1:0.0}\" length=\"${2:0.0}\"/>", "</geometry>$0"],
        description: vscode.l10n.t("Insert geometry (cylinder)"),
        scope: "both"
    },
    {
        prefix: "geometry",
        body: [
            "<geometry>",
            "\t${1|<box size=\"0.0 0.0 0.0\"/>,<cylinder radius=\"0.0\" length=\"0.0\"/>,<sphere radius=\"0.0\"/>,<mesh filename=\"\" scale=\"1.0\"/>|}",
            "</geometry>"
        ],
        description: vscode.l10n.t("Insert full geometry"),
        scope: "both"
    },
    {
        prefix: "mesh",
        body: ["<geometry>", "\t<mesh filename=\"${1:file_path}\" scale=\"${2:1.0}\"/>", "</geometry>$0"],
        description: vscode.l10n.t("Insert geometry (mesh)"),
        scope: "both"
    },
    {
        prefix: "sphere",
        body: ["<geometry>", "\t<sphere radius=\"${1:0.0}\"/>", "</geometry>$0"],
        description: vscode.l10n.t("Insert geometry (sphere)"),
        scope: "both"
    },
    {
        prefix: "inertial",
        body: ["<inertial>", "\t$0", "</inertial>"],
        description: vscode.l10n.t("Insert basic inertia"),
        scope: "both"
    },
    {
        prefix: "inertial",
        body: [
            "<inertial>",
            "\t<origin xyz=\"${1:0.0} ${2:0.0} ${3:0.0}\" rpy=\"${4:0.0} ${5:0.0} ${6:0.0}\"/>",
            "\t<mass value=\"${7:0.0}\"/>",
            "\t<inertia ixx=\"${8:0.0}\" ixy=\"${9:0.0}\" ixz=\"${10:0.0}\" iyy=\"${11:0.0}\" iyz=\"${12:0.0}\" izz=\"${13:0.0}\"/>",
            "</inertial>",
            "$0"
        ],
        description: vscode.l10n.t("Insert full inertia"),
        scope: "both"
    },
    {
        prefix: "inertia matrix",
        body: ['<inertia ixx="${1:0.0}" ixy="${2:0.0}" ixz="${3:0.0}" iyy="${4:0.0}" iyz="${5:0.0}" izz="${6:0.0}"/>'],
        description: l10n.t("Insert inertia matrix"),
        scope: "both"
    },
    {
        prefix: "joint",
        body: [
            "<joint name=\"${1:joint_name}\" type=\"${2|revolute,continuous,prismatic,fixed,floating,planar|}\">",
            "\t$0",
            "</joint>"
        ],
        description: vscode.l10n.t("Insert basic joint"),
        scope: "both"
    },
    {
        prefix: "joint",
        body: [
            "<joint name=\"${1:joint_name}\" type=\"${2|revolute,continuous,prismatic,fixed,floating,planar|}\">",
            "\t<origin xyz=\"${3:0.0} ${4:0.0} ${5:0.0}\" rpy=\"${6:0.0} ${7:0.0} ${8:0.0}\"/>",
            "\t<parent link=\"${9:parent_link}\"/>",
            "\t<child link=\"${10:child_link}\"/>",
            "\t<axis xyz=\"${11:0.0} ${12:0.0} ${13:0.0}\"/>",
            "\t<limit lower=\"${14:0.0}\" upper=\"${15:0.0}\" effort=\"${16:0.0}\" velocity=\"${17:0.0}\"/>",
            "</joint>"
        ],
        description: vscode.l10n.t("Insert full joint"),
        scope: "both"
    },
    {
        prefix: "limit",
        body: ['<limit lower="${1:0.0}" upper="${2:0.0}" effort="${3:0.0}" velocity="${4:0.0}"/>'],
        description: l10n.t("Insert joint limits"),
        scope: "both"
    },
    {
        prefix: "link",
        body: ["<link name=\"${1:link_name}\">", "\t$0", "</link>"],
        description: vscode.l10n.t("Insert basic link"),
        scope: "both"
    },
    {
        prefix: "link",
        body: [
            "<link name=\"${1:link_name}\">",
            "\t<inertial>",
            "\t\t<origin xyz=\"${2:0.0 0.0 0.0}\" rpy=\"${3:0.0 0.0 0.0}\"/>",
            "\t\t<mass value=\"${4:0.0}\"/>",
            "\t\t<inertia ixx=\"0.0\" ixy=\"0.0\" ixz=\"0.0\" iyy=\"0.0\" iyz=\"0.0\" izz=\"0.0\"/>",
            "\t</inertial>",
            "\t<visual name=\"\">",
            "\t\t<origin xyz=\"${5:0.0 0.0 0.0}\" rpy=\"${6:0.0 0.0 0.0}\"/>",
            "\t\t<geometry>",
            "\t\t\t${7|<box size=\"0.0 0.0 0.0\"/>,<cylinder radius=\"0.0\" length=\"0.0\"/>,<sphere radius=\"0.0\"/>,<mesh filename=\"\" scale=\"1.0\"/>|}",
            "\t\t</geometry>",
            "\t\t<material name=\"\">",
            "\t\t\t<color rgba=\"1.0 0.0 0.0 1.0\"/>",
            "\t\t\t<texture filename=\"\"/>",
            "\t\t</material>",
            "\t</visual>",
            "\t<collision>",
            "\t\t<origin xyz=\"${5:0.0 0.0 0.0}\" rpy=\"${6:0.0 0.0 0.0}\"/>",
            "\t\t<geometry>",
            "\t\t\t${7|<box size=\"0.0 0.0 0.0\"/>,<cylinder radius=\"0.0\" length=\"0.0\"/>,<sphere radius=\"0.0\"/>,<mesh filename=\"\" scale=\"1.0\"/>|}",
            "\t\t</geometry>",
            "\t</collision>",
            "</link>"
        ],
        description: vscode.l10n.t("Insert full link"),
        scope: "both"
    },
    {
        prefix: "material",
        body: ["${1|<material>,<material name=\"\">|}", "\t$0", "</material>"],
        description: vscode.l10n.t("Insert material"),
        scope: "both"
    },
    {
        prefix: "material",
        body: [
            "${1|<material>,<material name=\"\">|}",
            "\t<color rgba=\"${2:0.0} ${3:0.0} ${4:0.0} ${5:1.0}\"/>",
            "</material>"
        ],
        description: vscode.l10n.t("Insert material with color"),
        scope: "both"
    },
    {
        prefix: "material",
        body: [
            "${1|<material>,<material name=\"\">|}",
            "\t<color rgba=\"${2:0.0} ${3:0.0} ${4:0.0} ${5:1.0}\"/>",
            "\t<texture filename=\"${6:file_path}\"/>",
            "</material>"
        ],
        description: vscode.l10n.t("Insert material with color and texture"),
        scope: "both"
    },
    {
        prefix: "material",
        body: ["<material name=\"${1:materialName}\"/>"],
        description: vscode.l10n.t("Insert single-line material tag"),
        scope: "both"
    },
    { prefix: "mass", body: ['<mass value="${1:0.0}"/>'], description: l10n.t("Insert mass value"), scope: "both" },
    {
        prefix: "mesh",
        body: ['<mesh filename="${1:file_path}" scale="${2:1.0}"/>'],
        description: vscode.l10n.t("Insert mesh"),
        scope: "both"
    },
    { prefix: "origin", body: ["<origin $0/>"], description: vscode.l10n.t("Insert basic origin"), scope: "both" },
    {
        prefix: "origin",
        body: ['<origin rpy="${1:0.0} ${2:0.0} ${3:0.0}"/>'],
        description: vscode.l10n.t("Insert origin with rpy rotation"),
        scope: "both"
    },
    {
        prefix: "origin",
        body: ['<origin xyz="${1:0.0} ${2:0.0} ${3:0.0}"/>'],
        description: vscode.l10n.t("Insert origin with xyz coordinates"),
        scope: "both"
    },
    {
        prefix: "origin",
        body: ['<origin xyz="${1:0.0} ${2:0.0} ${3:0.0}" rpy="${4:0.0} ${5:0.0} ${6:0.0}"/>'],
        description: vscode.l10n.t("Insert origin with xyz and rpy"),
        scope: "both"
    },
    {
        prefix: ["parent", "child"],
        body: ["<parent link=\"${1:parent_link}\"/>", "<child link=\"${2:child_link}\"/>", "$0"],
        description: l10n.t("Insert parent-child link relation"),
        scope: "both"
    },
    {
        prefix: "robot",
        body: ["<robot name=\"${1:robot_name}\">", "\t$0", "</robot>"],
        description: vscode.l10n.t("Insert basic robot"),
        scope: "both"
    },
    { prefix: "rpy", body: ['rpy="${1:0.0} ${2:0.0} ${3:0.0}"'], description: l10n.t("Insert rpy rotation"), scope: "both" },
    { prefix: "sphere", body: ['<sphere radius="${1:0.0}"/>'], description: vscode.l10n.t("Insert sphere"), scope: "both" },
    {
        prefix: "texture",
        body: ['<texture filename="${1:file_path}"/>'],
        description: l10n.t("Insert texture"),
        scope: "both"
    },
    {
        prefix: "visual",
        body: ["${1|<visual>,<visual name=\"\">|}", "\t$0", "</visual>"],
        description: vscode.l10n.t("Insert visual"),
        scope: "both"
    },
    {
        prefix: "visual",
        body: [
            "${1|<visual>,<visual name=\"\">|}",
            "\t<origin xyz=\"${2:0.0} ${3:0.0} ${4:0.0}\" rpy=\"${5:0.0} ${6:0.0} ${7:0.0}\"/>",
            "\t$0",
            "</visual>"
        ],
        description: vscode.l10n.t("Insert visual with origin"),
        scope: "both"
    },
    {
        prefix: "xml_version",
        body: ["<?xml version=\"${1:1.0}\"?>", "$0"],
        description: l10n.t("Insert XML declaration"),
        scope: "both"
    },
    { prefix: "xyz", body: ['xyz="${1:0.0} ${2:0.0} ${3:0.0}"'], description: l10n.t("Insert xyz coordinates"), scope: "both" },
    {
        prefix: "transmission",
        body: [
            "<transmission name=\"${1:transmission_name}\">",
            "\t<type>${2:transmission_interface/SimpleTransmission}</type>",
            "\t<joint name=\"${3:joint_name}\">",
            "\t\t<hardwareInterface>${4:hardware_interface/PositionJointInterface}</hardwareInterface>",
            "\t</joint>",
            "\t<actuator name=\"${5:actuator_name}\">",
            "\t\t<mechanicalReduction>${6:1.0}</mechanicalReduction>",
            "\t\t<hardwareInterface>${7:hardware_interface/PositionJointInterface}</hardwareInterface>",
            "\t</actuator>",
            "</transmission>"
        ],
        description: l10n.t("Insert full transmission"),
        scope: "both"
    },

    // ---- xacro 专属(仅 .xacro 提供) ----
    {
        prefix: "include",
        body: ['<xacro:include filename="${1:xacroFile}"/>'],
        description: l10n.t("Insert xacro include tag"),
        scope: "xacro"
    },
    {
        prefix: "arg",
        body: ['<xacro:arg name="${1:arg_name}" default="${2:default_value}"/>'],
        description: l10n.t("Insert xacro command-line argument"),
        scope: "xacro"
    },
    {
        prefix: "robot",
        body: [
            '<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="${1:robot_name}">',
            "\t$0",
            "</robot>"
        ],
        description: vscode.l10n.t("Insert robot with xacro support"),
        scope: "xacro"
    },
    {
        prefix: "robot",
        body: ['<robot xmlns:xacro="http://www.ros.org/wiki/xacro">', "\t$0", "</robot>"],
        description: vscode.l10n.t("Insert xacro robot without name"),
        scope: "xacro"
    },
    {
        prefix: "sphere_inertial_matrix",
        body: [
            '<xacro:macro name="sphere_inertial_matrix" params="m r">',
            "\t<inertial>",
            "\t\t<mass value=\"\\${m}\" />",
            "\t\t<inertia",
            "\t\t\tixx=\"\\${2*m*r*r/5}\" ixy=\"0\" ixz=\"0\"",
            "\t\t\tiyy=\"\\${2*m*r*r/5}\" iyz=\"0\"",
            "\t\t\tizz=\"\\${2*m*r*r/5}\"",
            "\t\t/>",
            "\t</inertial>",
            "</xacro:macro>"
        ],
        description: l10n.t("Insert sphere inertia macro (params m r)"),
        scope: "xacro"
    },
    {
        prefix: "cylinder_inertial_matrix",
        body: [
            '<xacro:macro name="cylinder_inertial_matrix" params="m r h">',
            "\t<inertial>",
            "\t\t<mass value=\"\\${m}\" />",
            "\t\t<inertia",
            "\t\t\tixx=\"\\${m*(3*r*r+h*h)/12}\" ixy=\"0\" ixz=\"0\"",
            "\t\t\tiyy=\"\\${m*(3*r*r+h*h)/12}\" iyz=\"0\"",
            "\t\t\tizz=\"\\${m*r*r/2}\"",
            "\t\t/>",
            "\t</inertial>",
            "</xacro:macro>"
        ],
        description: l10n.t("Insert cylinder inertia macro (params m r h)"),
        scope: "xacro"
    },
    {
        prefix: "box_inertial_matrix",
        body: [
            '<xacro:macro name="box_inertial_matrix" params="m x y z">',
            "\t<inertial>",
            "\t\t<mass value=\"\\${m}\" />",
            "\t\t<inertia",
            "\t\t\tixx=\"\\${m*(y*y + z*z)/12}\" ixy=\"0\" ixz=\"0\"",
            "\t\t\tiyy=\"\\${m*(x*x + z*z)/12}\" iyz=\"0\"",
            "\t\t\tizz=\"\\${m*(x*x + y*y)/12}\"",
            "\t\t/>",
            "\t</inertial>",
            "</xacro:macro>"
        ],
        description: l10n.t("Insert box inertia macro (params m x y z)"),
        scope: "xacro"
    },
    {
        prefix: "inertia_macros",
        body: [
            '<xacro:macro name="sphere_inertial_matrix" params="m r">',
            "\t<inertial>",
            "\t\t<mass value=\"\\${m}\" />",
            "\t\t<inertia",
            "\t\t\tixx=\"\\${2*m*r*r/5}\" ixy=\"0\" ixz=\"0\"",
            "\t\t\tiyy=\"\\${2*m*r*r/5}\" iyz=\"0\"",
            "\t\t\tizz=\"\\${2*m*r*r/5}\"",
            "\t\t/>",
            "\t</inertial>",
            "</xacro:macro>",
            "",
            '<xacro:macro name="cylinder_inertial_matrix" params="m r h">',
            "\t<inertial>",
            "\t\t<mass value=\"\\${m}\" />",
            "\t\t<inertia",
            "\t\t\tixx=\"\\${m*(3*r*r+h*h)/12}\" ixy=\"0\" ixz=\"0\"",
            "\t\t\tiyy=\"\\${m*(3*r*r+h*h)/12}\" iyz=\"0\"",
            "\t\t\tizz=\"\\${m*r*r/2}\"",
            "\t\t/>",
            "\t</inertial>",
            "</xacro:macro>",
            "",
            '<xacro:macro name="box_inertial_matrix" params="m x y z">',
            "\t<inertial>",
            "\t\t<mass value=\"\\${m}\" />",
            "\t\t<inertia",
            "\t\t\tixx=\"\\${m*(y*y + z*z)/12}\" ixy=\"0\" ixz=\"0\"",
            "\t\t\tiyy=\"\\${m*(x*x + z*z)/12}\" iyz=\"0\"",
            "\t\t\tizz=\"\\${m*(x*x + y*y)/12}\"",
            "\t\t/>",
            "\t</inertial>",
            "</xacro:macro>",
            "$0"
        ],
        description: l10n.t("Insert all three inertia macros (sphere/cylinder/box)"),
        scope: "xacro"
    }
];

/** URDF/xacro 结构补全提供器(50 静态片段 + ${} 动态补全,04) */
export class UrdfXacroCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private graph?: IncludeGraph, private pkg?: PackageMap) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | undefined> {
        const ext = path.extname(document.uri.fsPath).toLowerCase();
        if (ext !== ".urdf" && ext !== ".xacro") {
            log.trace(l10n.t("Completion: {0} skipped (not urdf/xacro)", ext))
            return undefined;
        }

        const line = document.lineAt(position.line).text;
        const items: vscode.CompletionItem[] = [];
        const docModel = docModelOf(this.graph, document); // XG6:缓存解析模型(${} 分支与上下文共用,修 X-F4)
        const offset = document.offsetAt(position);

        // trigger 字符门控(2026-09-08):窄用途 trigger 只服务其专属上下文——
        // "{" 只服务 ${}(isInDollarBraces)、"(" 只服务 $( (isInDollarParen);
        // 非命中一律不提供,避免它们在任何其它位置全局误弹(如文本里的 "("、"{" 或 "$(a" 之前的形态)。
        const trig =
            context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
                ? context.triggerCharacter
                : undefined;
        if (trig === "{" && !isInDollarBraces(line, position.character)) {
            return undefined;
        }
        if (trig === "(" && !isInDollarParen(line, position.character)) {
            return undefined;
        }

        // ④.0 ns. 点号补全(XG7,2026-09-24):`${ns.` → ns include 目标文件的 property;
        // `<xacro:ns.` → 目标文件的宏(标签名位)。命中即独占本次补全(点号上下文变量/片段皆噪音)。
        // 触发:手动(Ctrl+Space)或既有触发字符;不注册 "." 全局 trigger(宽噪音,违背窄 trigger 决策)。
        if (ext === ".xacro") {
            const nsItems = nsDottedCandidates(this.graph, docModel, document, offset);
            if (nsItems) {
                items.push(...nsItems);
                log.trace(l10n.t("Completion: {0} ns dotted items", nsItems.length))
                return items;
            }
        }

        // ④ ${} 变量/形参补全(04 §2.3,不受 isInsideTag 限制):仅在 ${...} 内(inBraces)。
        // 触发:providers.ts 注册 trigger "{"(2026-09-08 决策)——弹表时刻 = 变量名槽位刚形成的
        // "${" 之后;不用 "$"(敲 "$" 时名字位未出现、且会误弹 "$(find pkg)" 噪音,见 ui/README)。
        // 候选 = ① 光标所在最内层宏的形参(遮蔽优先) + ② 可见 property / arg(同名去重:property 优先,
        //          arg 补位——${} 解析顺序 property→arg,同名并存时只认 property,arg 的消费面是
        //          $(arg …)(⑤),不入 ${} 表;2026-09-08 用户复报"两个同名变量")。
        // 文档:property/arg 项附"定义行 + 定义上方紧邻注释"(与 hover 同构);形参项不附
        //        (params="a b c" 多参数堆叠、无逐参注释,2026-09-08 用户定稿)。
        if (isInDollarBraces(line, position.character)) {
            const formalNames = new Set<string>();
            // ① 宏形参:仅 .xacro;超大文档跳过全文扫描(同诊断/04 降级阈值)
            if (ext === ".xacro" && document.lineCount <= LARGE_DOC_LINE_LIMIT) {
                const span = enclosingMacroSpan(collectMacroParamSpans(docModel.tree, docModel.text), document.offsetAt(position));
                if (span) {
                    for (const p of span.params) {
                        formalNames.add(p);
                        items.push(dollarVarItem(p));
                    }
                }
            }
            // ② 可见 property / arg(同名去重;参数级去重经 property 优先)
            const propByName = new Map<string, SymbolRef>();
            const argByName = new Map<string, SymbolRef>();
            if (this.graph) {
                for (const s of this.graph.visibleSymbols(document.uri, position)) {
                    if (formalNames.has(s.name)) {
                        continue;
                    }
                    if (s.kind === "property") {
                        if (!propByName.has(s.name)) {
                            propByName.set(s.name, s);
                        }
                    } else if (s.kind === "arg") {
                        if (!argByName.has(s.name)) {
                            argByName.set(s.name, s);
                        }
                    }
                }
            }
            for (const s of propByName.values()) {
                items.push(dollarVarItem(s.name, symbolDocMarkdown(this.graph, s)));
            }
            for (const s of argByName.values()) {
                if (!propByName.has(s.name)) {
                    items.push(dollarVarItem(s.name, symbolDocMarkdown(this.graph, s)));
                }
            }
            // ③ 官方求值上下文(XG7,2026-09-24):函数/常量/命名空间(13 §5;仅 .xacro)。
            // 排序在变量之后(用户最常敲的是属性名);detail 带官方语义简注。
            if (ext === ".xacro") {
                for (const [name, info] of EVAL_GLOBALS) {
                    if (formalNames.has(name) || propByName.has(name) || argByName.has(name)) {
                        continue;
                    }
                    const it = new vscode.CompletionItem(
                        name,
                        info.kind === "function" ? vscode.CompletionItemKind.Function
                            : info.kind === "namespace" ? vscode.CompletionItemKind.Module
                                : vscode.CompletionItemKind.Constant
                    );
                    it.insertText = name;
                    it.detail = info.detail;
                    it.sortText = "6_fn";
                    items.push(it);
                }
            }
            log.trace(l10n.t("Completion: {0} dynamic ${{}} items (in braces; formals {1} + variables {2})", items.length, formalNames.size, propByName.size + argByName.size))
        }

        // ⑤ $(...) 替换补全(方向2,2026-09-08):"$(" 后(未敲 ")")提供我们的候选,
        // 取代 VS Code word-based suggestions(整文件相似词扫描)的噪音。
        //   函数名位("$(" 后,未定型/无空格) → find / find-pkg-share / arg(insertText 带尾空格);
        //   参数位(函数名 + 空格后)         → find* → 包名(共享 PackageMap);arg → 可见 arg 名(graph)。
        if (isInDollarParen(line, position.character)) {
            const seg = line.slice(line.lastIndexOf("$(") + 2, position.character);
            const parts = seg.split(/\s+/).filter(p => p.length > 0);
            const fn = (parts[0] ?? "").toLowerCase();
            const hasTrailingSpace = /\s$/.test(seg);
            const knownFn = DOLLAR_PAREN_FUNCS.includes(fn);
            if (!knownFn && parts.length <= 1 && !hasTrailingSpace) {
                // 函数名位(前缀候选;接受后带空格进入参数位)
                for (const f of DOLLAR_PAREN_FUNCS) {
                    if (f.startsWith(fn)) {
                        const it = new vscode.CompletionItem(f, vscode.CompletionItemKind.Function);
                        it.insertText = `${f} `;
                        it.sortText = "6_sub";
                        items.push(it);
                    }
                }
            } else if (fn === "find" || fn === "find-pkg-share") {
                // 包名位:工作区 + 系统(共享 PackageMap,与 launch 补全同源)
                const pkgWord = (parts[1] ?? "").toLowerCase();
                for (const n of this.pkg?.getPackageNames() ?? []) {
                    if (!pkgWord || n.toLowerCase().startsWith(pkgWord)) {
                        const it = new vscode.CompletionItem(n, vscode.CompletionItemKind.Value);
                        it.insertText = n;
                        it.sortText = "6_sub";
                        items.push(it);
                    }
                }
            } else if (fn === "arg") {
                // arg 名位:可见集内 kind=arg(与 ④ 同源,宽松、跨文件)
                const argWord = (parts[1] ?? "").toLowerCase();
                if (this.graph) {
                    for (const s of this.graph.visibleSymbols(document.uri, position)) {
                        if (s.kind === "arg" && (!argWord || s.name.toLowerCase().startsWith(argWord))) {
                            const it = new vscode.CompletionItem(s.name, vscode.CompletionItemKind.Variable);
                            it.insertText = s.name;
                            it.sortText = "6_sub";
                            items.push(it);
                        }
                    }
                }
            }
            log.trace(l10n.t("Completion: {0} $( substitutions ({1} position)", items.length, fn || l10n.t("<function>")))
        }

        // 标签级结构补全(标签外 / 刚输入 < 时,保留 50 片段;注释内/标签内不提供,替代旧 isInsideTag)
        const ctx = getCursorContextFromTree(docModel.tree, docModel.text, document, position);

        // trigger 门控续:窄用途 trigger 之 "/" 与 "\"(兄弟,2026-09-09)——只服务 xacro:include
        // filename 值(层进/路径分隔),其它任何位置一律不提供:避免在文本、URL、`</`、自闭合标签等处
        // 全局误弹(方向3 教训:分隔符在外侧语境大量出现)。
        if (trig === "/" || trig === "\\") {
            const inIncludeFilename = ext === ".xacro"
                && ctx.role === "attrValue"
                && ctx.attrName === "filename"
                && ctx.elementName === "xacro:include";
            if (!inIncludeFilename) {
                return undefined;
            }
        }

        // ② 关节枚举补全(04 §2.1):<joint type="..." 值内
        if (ctx.role === "attrValue" && ctx.attrName === "type" && ctx.elementName === "joint") {
            for (const jt of jointTypes) {
                const item = new vscode.CompletionItem(jt.name, vscode.CompletionItemKind.EnumMember);
                item.documentation = new vscode.MarkdownString(jt.description);
                item.sortText = "4_jointType";
                items.push(item);
            }
            log.trace(l10n.t("URDF/xacro completion: {0} joint enum items", items.length))
            return items;
        }

        // ③ 属性名补全(04 §2.2):标签内属性名/属性区
        if (ctx.role === "attrName" || (ctx.role === "text" && ctx.inTag)) {
            const attrs = commonAttributes[ctx.elementName] ?? [];
            for (const a of attrs) {
                const item = new vscode.CompletionItem(a, vscode.CompletionItemKind.Property);
                item.detail = vscode.l10n.t("{0} attributes", ctx.elementName);
                item.sortText = "3_attr";
                items.push(item);
            }
            log.trace(l10n.t("Completion: {0} attribute names, {1} items", ctx.elementName, attrs.length))
        }

        // ③.5 宏调用点参数补全(XG7,2026-09-24):`<xacro:宏名` 属性区 → 该宏 params 全语法
        // (标量参数;默认值/转发/必填进 detail;*块/**字典参数由子元素填充,不作属性提供)。
        // 已敲过的属性不再重复;宏定义须在调用前可见(官方文档序语义,findSymbol 判定)。
        if (ext === ".xacro"
            && (ctx.role === "attrName" || (ctx.role === "text" && ctx.inTag))
            && fixedTagOf(ctx.elementName) === null
            && ctx.elementName.startsWith("xacro:")
            && ctx.elementName.length > "xacro:".length) {
            const macroName = ctx.elementName.slice("xacro:".length);
            const def = this.graph?.findSymbol(document.uri, position, macroName, "macro");
            if (def?.params?.length) {
                const used = new Set<string>();
                const call = docModel.macroCalls.find(c => c.info.spanFrom <= offset && offset < c.info.spanTo);
                if (call) {
                    for (const a of call.attrs.keys()) {
                        used.add(a);
                    }
                }
                let added = 0;
                for (const p of def.params) {
                    if (p.kind !== "scalar" || used.has(p.name)) {
                        continue;
                    }
                    const item = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
                    item.detail = p.defaultKind === "value" ? `宏参数(默认 ${p.defaultValue})`
                        : p.defaultKind === "forward" ? vscode.l10n.t("Macro parameter (forwards same-named outer attribute ^)")
                            : p.defaultKind === "forward-or-default" ? vscode.l10n.t("Macro parameter (forward ^|{0})", p.defaultValue)
                                : vscode.l10n.t("Macro parameter (required)");
                    item.sortText = "3_attr";
                    items.push(item);
                    added++;
                }
                log.trace(l10n.t("Completion: {0} macro parameters, {1} added ({2} used)", macroName, added, used.size))
            }
        }

        // ⑥ xacro:include filename 单层路径补全(v1 定稿,2026-09-08):只补"当前位置这一层"的
        // 子目录/文件(目录带尾 "/" 可继续下钻),像头文件那样逐层提示;不做深 walk(大树/大列表问题
        // 不存在,递归/深度上限/排除清单均不需要)。
        //   支持:相对路径(根 = 当前文件目录,与 resolveInclude 同口径)/ $(find pkg) / package://pkg;
        //   不介入:值内含 "${…}"(静态不可解析)或未闭合 "$("(那是 ⑤ 的地盘);
        //   跟随符号链接 = 统一 walk 口径(读 ROS2.search.followSymlinks,见 readFollowSymlinksSetting)。
        if (ext === ".xacro"
            && ctx.role === "attrValue"
            && ctx.attrName === "filename"
            && ctx.elementName === "xacro:include") {
            const prefix = attrValuePrefixAt(line, ctx.attrName, position.character);
            if (prefix !== undefined
                && prefix.indexOf("${") < 0
                && prefix.lastIndexOf("$(") <= prefix.lastIndexOf(")")) {
                const fileItems = await includeFileCandidates(this.pkg, document, prefix);
                if (fileItems.length > 0) {
                    items.push(...fileItems);
                    log.trace(l10n.t("Completion: include filename, {0} single-level items", fileItems.length))
                }
            }
        }

        // 静态 50 片段:仅普通上下文(标签外/注释外),且不被窄用途 trigger 独占
        // ("{" → 只出 ${} 变量;"(" → 只出 $( 替换),且不在 ${...}/$(...) 内(避免文本级噪音)。
        if (!ctx.inComment && !ctx.inTag
            && trig !== "{" && trig !== "("
            && !isInDollarBraces(line, position.character)
            && !isInDollarParen(line, position.character)) {
            const isXacro = ext === ".xacro";
            // 用户正在敲一个未闭合标签的标签名(如 "<box")→ 元素片段 insert 去开头 "<",
            // 避免接受后手输 "<" + 片段自带 "<" 变成 "<<box…"(2026-09-08 用户实测)。
            // 去头只影响 insertText/documentation;filterText/label 仍按完整片段(带 "<")计算。
            const stripLt = isTypingTagName(line, position.character);
            for (const s of SNIPPETS) {
                if (!isXacro && s.scope === "xacro") {
                    continue; // .urdf 不提供 xacro 专属片段
                }
                items.push(...this.toCompletionItems(s, stripLt));
            }
        }
        log.trace(l10n.t("URDF/xacro completion: {0} file, {1} items offered", ext, items.length))
        return items;
    }

    /**
     * 片段 → 补全项(prefix 数组每个词各生成一项;label 带简短中文消歧,中文不前置)。
     * @param stripLt 用户已敲未闭合标签的开 "<"(isTypingTagName)→ insertText/documentation 去掉片段首行的 "<",
     *                filterText 仍按原 body(带 "<")计算,保证 "<box" 这类输入片段可命中。
     */
    private toCompletionItems(s: Snippet, stripLt = false): vscode.CompletionItem[] {
        const prefixes = Array.isArray(s.prefix) ? s.prefix : [s.prefix];
        const hint = SNIPPET_HINTS[s.description];
        // 仅当首行是开标签(< 且非 </、<?)才可去头;纯属性片段(如 xyz=…)与 ${…} 选项头不受影响
        let insertBody = s.body;
        if (stripLt && /^\s*<(?![/?])/.test(s.body[0])) {
            insertBody = [s.body[0].replace(/^\s*</, ""), ...s.body.slice(1)];
        }
        const insert = new vscode.SnippetString(insertBody.join("\n"));
        return prefixes.map(p => {
            const label = hint ? `${p}(${hint})` : p;
            const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
            item.insertText = insert;
            item.detail = s.description;
            // filterText = 符号化结构头 + 主词流(纯 ASCII,超集):
            // 如 <box size=…> → "<box size= box size";带符号输入片段(如 `<box s`)亦可命中
            item.filterText = snippetFilterText(p, s.body);
            item.documentation = new vscode.MarkdownString("```xml\n" + insertBody.join("\n") + "\n```");
            return item;
        });
    }
}

/** 超大文档阈值:跳过全文宏形参扫描(同 04/诊断降级) */
const LARGE_DOC_LINE_LIMIT = 10000;

/** 光标是否位于 ${...} 表达式内部(供 ${} 动态补全判断;含刚敲 "${" 的时刻) */
function isInDollarBraces(lineText: string, char: number): boolean {
    const upTo = lineText.slice(0, char);
    const lastOpen = upTo.lastIndexOf("${");
    const lastClose = upTo.lastIndexOf("}");
    return lastOpen >= 0 && lastClose < lastOpen;
}

/**
 * ${} 变量/形参补全条目。
 * insertText = 纯名字(避免 SnippetString 的 ${} 冲突);接受后与已敲的 "${" 合成 ${name}。
 * 触发时刻由 trigger "{" 保证(见 provideCompletionItems ④ 注释),无需 "$" 时刻的补丁插入。
 * @param doc 可选 documentation(property/arg 附"定义行 + 上方注释";形参不传——多参数堆叠无逐参注释)。
 */
function dollarVarItem(name: string, doc?: vscode.MarkdownString): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
    item.insertText = name;
    item.detail = `\${${name}}`;
    item.sortText = "5_var";
    if (doc) {
        item.documentation = doc;
    }
    return item;
}

/**
 * 变量项的补全文档:定义行 + 定义上方紧邻注释(与 hover definitionMarkdown 同构;跨文件经图内文本)。
 * 图内无该文件/取不到 → undefined(不展示)。
 * XG7:graph.getFile 探测式调用——测试 mock(仅 visibleSymbols)不误炸(修存量 ④ 失败)。
 */
function symbolDocMarkdown(graph: IncludeGraph | undefined, def: SymbolRef): vscode.MarkdownString | undefined {
    if (!graph) {
        return undefined;
    }
    const g = graph as IncludeGraph & { getFile?: IncludeGraph["getFile"] };
    const info = typeof g.getFile === "function" ? g.getFile(def.uri) : undefined;
    if (!info) {
        return undefined;
    }
    const md = new vscode.MarkdownString();
    const comment = adjacentCommentAbove(info.text, def.line);
    if (comment) {
        md.appendCodeblock(comment); // RE-2:verbatim 代码块(与 hover 同构,缩进/换行原样)
    }
    const lineText = (info.text.split(/\r?\n/)[def.line] ?? "").trim();
    if (lineText) {
        md.appendCodeblock(lineText, "xml");
    }
    return md;
}

/**
 * 定义上方紧邻的 <!-- … --> 注释(hover extractLeadingComment 的**窗口化**版:只在 defLine 上方
 * 有限行内找"注释结束行 == defLine-1"的块)。补全逐键高频调用,全文 regex 扫描不可取;
 * 语义与 extractLeadingComment 一致:结束行必须是 defLine-1、其上一行不得为空行。
 * RE-2:内文清洗共用 provider-utils.verbatimCommentInner(verbatim,消除双实现)。
 */
function adjacentCommentAbove(text: string, defLine: number, windowLines = 80): string | undefined {
    if (defLine <= 0) {
        return undefined;
    }
    const lines = text.split(/\r?\n/);
    if ((lines[defLine - 1] ?? "").trim() === "") {
        return undefined;
    }
    const start = Math.max(0, defLine - windowLines);
    const slice = lines.slice(start, defLine).join("\n");
    const re = /<!--([\s\S]*?)-->/g;
    let m: RegExpExecArray | null;
    const targetRel = defLine - 1 - start;
    while ((m = re.exec(slice)) !== null) {
        // 注释结束行(窗口内相对行号)
        let relEnd = 0;
        for (let i = 0; i < m.index + m[0].length; i++) {
            if (slice.charCodeAt(i) === 10) {
                relEnd++;
            }
        }
        if (relEnd === targetRel) {
            return verbatimCommentInner(m[1]);
        }
        if (relEnd > targetRel) {
            break;
        }
    }
    return undefined;
}

/** $(...) 替换命令候选(方向2,2026-09-08;XG7 扩至官方全集 + find-pkg-share 宽容,13 §4。
 *  参数位取值:find* → 包名,arg → 可见 arg 名;env/optenv/dirname/eval/cwd 参数位无候选源) */
const DOLLAR_PAREN_FUNCS = ["find", "find-pkg-share", "arg", "env", "optenv", "dirname", "eval", "cwd"];

/** 光标是否处于 $(...) 内(含刚敲 "$(";判据 = 最近 "$(" 在最近 ")" 之后) */
function isInDollarParen(lineText: string, char: number): boolean {
    const upTo = lineText.slice(0, char);
    const lastOpen = upTo.lastIndexOf("$(");
    const lastClose = upTo.lastIndexOf(")");
    return lastOpen >= 0 && lastClose < lastOpen;
}

/**
 * ns 点号补全候选(XG7 引入,XG12 升级 N 级):光标前形如 `链.`(链可多级)且链是 ns include 链:
 *  - `<xacro:kit.` / `<xacro:kit.sub.` 标签名位 → 该表宏 + 子命名空间(补 `sub.` 续链);
 *  - `${kit.` / `${kit.sub.` 表达式位 → 该表属性 + 子命名空间(宏不是值,不入 ${} 表)。
 * 宏/属性含无 ns 嵌套传染(collectNsTable 官方语义)。链走不通 → undefined(回落常规分支)。
 */
function nsDottedCandidates(
    graph: IncludeGraph | undefined,
    docModel: XacroDocument,
    document: vscode.TextDocument,
    offset: number
): vscode.CompletionItem[] | undefined {
    if (!graph) {
        return undefined;
    }
    const before = docModel.text.slice(0, offset);
    // 形态 A:标签名位 <xacro:链(仍无空白,含点)
    const tagM = /<xacro:([A-Za-z0-9_.]+)$/.exec(before);
    const inTag = !!tagM;
    // 形态 B:${链.(未闭合 ${ 后到光标为纯链字符)
    const openBrace = before.lastIndexOf("${");
    let exprChain: string | undefined;
    if (openBrace >= 0 && before.lastIndexOf("}", openBrace) < openBrace) {
        const seg = before.slice(openBrace + 2);
        if (/^[A-Za-z0-9_.]+$/.test(seg) && seg.includes(".")) {
            exprChain = seg;
        }
    }
    const chain = tagM ? tagM[1] : exprChain;
    if (!chain) {
        return undefined;
    }
    const lastDot = chain.lastIndexOf(".");
    if (lastDot < 0) {
        return undefined; // 尚无点:ns 补全不介入(头名可能是普通宏,交常规分支)
    }
    const segs = chain.slice(0, lastDot).split(".");
    const word = chain.slice(lastDot + 1).toLowerCase();
    const table = collectNsTable(graph, docModel, document.uri, segs);
    if (!table) {
        return undefined; // 链走不通(非 ns 名或 include 悬空)→ 回落
    }
    const out: vscode.CompletionItem[] = [];
    for (const ns of table.namespaces) {
        if (word && !ns.toLowerCase().startsWith(word)) {
            continue;
        }
        const it = new vscode.CompletionItem(`${ns}.`, vscode.CompletionItemKind.Module);
        it.insertText = `${ns}.`;
        it.detail = `${segs.concat(ns).join(".")} 子命名空间`;
        it.sortText = "2_nsf";
        // 接受子命名空间后续链
        it.command = { command: "editor.action.triggerSuggest", title: vscode.l10n.t("Continue completion in this namespace") };
        out.push(it);
    }
    if (inTag) {
        for (const m of table.macros) {
            if (word && !m.name.toLowerCase().startsWith(word)) {
                continue;
            }
            const it = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Function);
            it.insertText = m.name;
            it.detail = m.params?.length
                ? `宏(${m.params.map(p => p.name).join(" ")})`
                : vscode.l10n.t("macro");
            it.sortText = "3_ns";
            out.push(it);
        }
    } else {
        for (const p of table.props) {
            if (word && !p.name.toLowerCase().startsWith(word)) {
                continue;
            }
            const it = dollarVarItem(p.name);
            it.detail = `${segs.join(".")}.${p.name}`;
            it.sortText = "3_ns";
            out.push(it);
        }
    }
    log.trace(`补全:ns 链 ${segs.join(".")} ${out.length} 项(宏 ${table.macros.length}/属性 ${table.props.length}/子 ns ${table.namespaces.length})`);
    return out;
}

/**
 * 同行情景下,取光标前某属性值内已输入前缀(如 `<xacro:include filename="sensors/…|"` 的 "sensors/…")。
 * 仅支持属性与值在同一行(include filename 实际均同行);跨行/值内已越过闭合引号 → undefined(静默跳过)。
 */
function attrValuePrefixAt(line: string, attrName: string, char: number): string | undefined {
    const upTo = line.slice(0, char);
    const ai = upTo.lastIndexOf(attrName);
    if (ai < 0) {
        return undefined;
    }
    const pre = ai === 0 ? "" : upTo[ai - 1];
    if (/[A-Za-z0-9_:.\-]/.test(pre)) {
        return undefined; // 前接标识符字符 → 不是独立属性名(如落在某值文本里)
    }
    const rest = line.slice(ai + attrName.length);
    const eqm = rest.match(/^\s*=\s*(['"])/);
    if (!eqm) {
        return undefined;
    }
    const q = ai + attrName.length + eqm[0].length - 1; // 开引号位置
    if (q >= char) {
        return undefined;
    }
    const inner = line.slice(q + 1, char);
    if (inner.includes(eqm[1])) {
        return undefined; // 已越过闭合引号(光标跑到值外)
    }
    return inner;
}

/** 包名 → 根目录(fsPath;工作区/已缓存系统包同步,未缓存系统包 await 懒取) */
async function pkgDirOf(pkg: PackageMap | undefined, name: string): Promise<string | undefined> {
    if (!pkg) {
        return undefined;
    }
    const dir = pkg.get(name) ?? (await pkg.resolvePackageDir(name));
    return dir?.fsPath;
}

/**
 * include filename 单层候选(⑥):
 * 1) 解析"有效目录"根:$(find pkg)/$(find-pkg-share pkg) 或 package://pkg → 包根;相对 → 当前文件目录;
 *    **绝对路径(以 "/" 或盘符开头)直接以系统根为基准**——外部公有/共享资源可绝对引用(与
 *    include-graph.resolveInclude 的相对/绝对均 ok 口径一致);"~" 不展开(工具侧本就不解释);
 * 2) 已输入前缀拆成"目录段 + 当前词",只 readdir 有效目录**这一层**;
 * 3) 目录在前、文件只收 .xacro/.urdf(与统一 walk 的扫描口径一致);符号链接条目跟随
 *    readFollowSymlinksSetting(默认不跟随,与 ts-walk 同口径跳过,防共享目录遍历爆炸)。
 * 返回 [] 表示不提供(目录不存在/无权限/无 pkg 表等),绝不报错。
 */
async function includeFileCandidates(
    pkg: PackageMap | undefined,
    document: vscode.TextDocument,
    prefix: string
): Promise<vscode.CompletionItem[]> {
    const raw = prefix.trim();
    let base: string | undefined;
    let rest = raw;
    const findRe = /^\$\(\s*find(?:\s*-\s*pkg-share)?\s+([A-Za-z0-9_-]+)\s*\)\s*\/?(.*)$/;
    const fm = raw.match(findRe);
    const pm = raw.match(/^package:\/\/([^/]+)\/?(.*)$/);
    if (fm) {
        base = await pkgDirOf(pkg, fm[1]);
        rest = fm[2];
    } else if (pm) {
        base = await pkgDirOf(pkg, pm[1]);
        rest = pm[2];
    } else {
        base = path.dirname(document.uri.fsPath);
        rest = raw;
    }
    if (!base) {
        return [];
    }
    // 3) 目录推导:base(相对/pk 根)+ 已输目录段;支持**绝对路径**(rest 以 "/" 或盘符开头,
    //    如 "/data/ros/share/x.xacro"、"C:/share/…")——外部公有/共享资源常直接绝对引用。
    //    "~" 刻意不展开:xacro/roslaunch 均不解释 ~(与 resolveInclude 一致),视为字面目录即可。
    const lastSep = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\"));
    const word = lastSep >= 0 ? rest.slice(lastSep + 1) : rest;
    const dirPart = lastSep >= 0 ? rest.slice(0, lastSep) : "";
    let eff: string;
    if (/^(?:[A-Za-z]:)?[\\/]/.test(rest)) {
        // 绝对:目录部分直接 resolve;空目录部分(如刚输 "/")= 根
        eff = path.resolve(dirPart || path.parse(rest).root || "/");
    } else {
        eff = dirPart ? path.join(base, dirPart) : base;
    }
    const follow = readFollowSymlinksSetting(); // 统一 walk 口径(默认 false)
    const dirNames: string[] = [];
    const fileNames: string[] = [];
    let entries;
    try {
        entries = await fsp.readdir(eff, { withFileTypes: true });
    } catch {
        return []; // 目录不存在/无权限 → 不提供
    }
    for (const en of entries) {
        if (en.name.startsWith(".")) {
            continue;
        }
        let isDir: boolean;
        if (en.isSymbolicLink()) {
            if (!follow) {
                continue; // 不跟随符号链接:条目整体跳过(ts-walk 同口径)
            }
            try {
                isDir = (await fsp.stat(path.join(eff, en.name))).isDirectory();
            } catch {
                continue;
            }
        } else {
            isDir = en.isDirectory();
        }
        if (isDir) {
            dirNames.push(en.name);
        } else if (/\.(xacro|urdf)$/i.test(en.name)) {
            fileNames.push(en.name);
        }
    }
    dirNames.sort((a, b) => a.localeCompare(b));
    fileNames.sort((a, b) => a.localeCompare(b));
    const lw = word.toLowerCase();
    const out: vscode.CompletionItem[] = [];
    for (const n of dirNames) {
        if (lw && !n.toLowerCase().startsWith(lw)) {
            continue;
        }
        const it = new vscode.CompletionItem(`${n}/`, vscode.CompletionItemKind.Folder);
        it.insertText = `${n}/`;
        it.sortText = "7_file";
        // 接受目录后自动再弹补全,直接续下一层(2026-09-08 用户:层进要连贯,不能断)
        it.command = { command: "editor.action.triggerSuggest", title: vscode.l10n.t("Continue completion in this directory") };
        out.push(it);
    }
    for (const n of fileNames) {
        if (lw && !n.toLowerCase().startsWith(lw)) {
            continue;
        }
        const it = new vscode.CompletionItem(n, vscode.CompletionItemKind.File);
        it.insertText = n;
        it.sortText = "7_file";
        out.push(it);
    }
    return out;
}

/**
 * 光标前是否正在敲一个"未闭合标签的标签名"(如 "<"、`<b`、`<box`)。
 * 判据:自上一个已闭合标签 `>`(或行首)起的片段,去掉首尾空白后形如 `^<[A-Za-z_:][A-Za-z0-9_:.-]*$`(可只有 "<")。
 * 命中 → 元素片段 insertText 需去掉开头 "<",否则手输 "<" + 片段自带 "<" 会变成 "<<box…"。
 * 注:片段只在 !inTag 上下文提供,属性区内(片段已被 inTag 拦截)此判定不影响。
 */
function isTypingTagName(lineText: string, char: number): boolean {
    const before = lineText.slice(0, char);
    const seg = before.slice(before.lastIndexOf(">") + 1).trim();
    return seg === "<" || /^<[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(seg);
}
