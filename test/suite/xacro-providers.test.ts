/**
 * xacro providers 纯逻辑测试(2026-09-06 起,补 UI 提供器可测纯函数)
 *
 * 覆盖:extractLeadingComment —— hover 文档注释提取(定义行上方紧邻的 <!-- ... --> 块)。
 * 其余 UI 提供器行为(Definition/DocumentLink/Hover 装配)依赖 vscode 事件,仍留集成缺口。
 */

import * as assert from "assert";
import { extractLeadingComment } from "../../src/languages/xacro";

describe("xacro providers 纯函数(2026-09-06)", () => {
    describe("extractLeadingComment(hover 文档注释)", () => {
        it("单行注释紧邻定义 → 返回去壳内文(RE-2 verbatim:首尾空格原样)", () => {
            const text = [
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro">',
                "",
                "    <!-- 车轮宏:圆柱 + 连续旋转关节 -->",
                '    <xacro:macro name="wheel_macro" params="prefix xyz suffix">',
                "    </xacro:macro>",
                "</robot>"
            ].join("\n");
            assert.strictEqual(extractLeadingComment(text, 3), " 车轮宏:圆柱 + 连续旋转关节 ");
        });

        it("多行注释紧邻定义 → verbatim(缩进与换行原样,不再去缩进)", () => {
            const text = [
                "<!-- 演示: xacro 主文件",
                "     property / arg / include",
                "     include 指向 demo10.xacro -->",
                '<?xml version="1.0"?>',
                "",
                '<robot xmlns:xacro="http://www.ros.org/wiki/xacro"/>'
            ].join("\n");
            // 注意:该文本里注释在 XML 声明上方——仅验证提取逻辑,文档合法性另论
            const got = extractLeadingComment(text, 3);
            assert.ok(got, "应提取到注释");
            assert.ok(got!.includes("演示: xacro 主文件"));
            assert.ok(got!.includes("\n     property / arg / include"), "行首缩进应原样保留");
            assert.ok(got!.includes("\n     include 指向 demo10.xacro "));
        });

        it("RE-2 块式注释:外壳放置换行剥掉,内部空行与缩进原样", () => {
            const text = [
                "<!--",
                "  底盘装甲板:",
                "",
                "    - 厚度 thickness",
                "    - 材质 *material*",
                "-->",
                '<xacro:macro name="plate"/>'
            ].join("\n");
            const got = extractLeadingComment(text, 6);
            assert.strictEqual(got, "  底盘装甲板:\n\n    - 厚度 thickness\n    - 材质 *material*");
        });

        it("空行隔开(非紧邻)→ undefined", () => {
            const text = [
                "    <!-- 车轮宏 -->",
                "",
                '    <xacro:macro name="wheel_macro"/>'
            ].join("\n");
            assert.strictEqual(extractLeadingComment(text, 2), undefined);
        });

        it("上方是代码行 → undefined", () => {
            const text = [
                '    <xacro:property name="pi" value="3.14"/>',
                '    <xacro:macro name="wheel_macro"/>'
            ].join("\n");
            assert.strictEqual(extractLeadingComment(text, 1), undefined);
        });

        it("defLine 首行/越界 → undefined", () => {
            const text = "<!-- c -->\n<xacro:macro/>";
            assert.strictEqual(extractLeadingComment(text, 0), undefined);
            assert.strictEqual(extractLeadingComment(text, 99), undefined);
        });

        it("CRLF 行尾同样工作", () => {
            const text = [
                "<!-- 车轮宏说明 -->",
                '<xacro:macro name="wheel_macro"/>'
            ].join("\r\n");
            assert.strictEqual(extractLeadingComment(text, 1), " 车轮宏说明 ");
        });

        it("纯空白注释 → undefined(不渲染)", () => {
            const text = "<!--   -->\n<xacro:macro/>";
            assert.strictEqual(extractLeadingComment(text, 1), undefined);
        });
    });
});
