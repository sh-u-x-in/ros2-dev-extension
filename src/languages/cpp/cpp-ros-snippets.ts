/**
 * ROS 2 C++ 节点代码片段动态提供器(.cpp/.hpp 等)
 *
 * 2026-09-07:替代退役的静态 snippets/cpp.json(原按 cpp 语言全量注入,污染非 ROS 项目)。
 * 规则:
 *  - selector 覆盖 C++ 常见扩展(.cpp/.cxx/.cc/.hpp/.hh/.h),无 launch 特例;
 *  - **ROS 工作区门槛**(shared/ros-workspace-gate):非 ROS 工作区一律不弹;
 *  - 词前缀命中目录即提供;字符串/注释内不触发;label 中文,filterText = 中文名 + 原 prefix。
 */

import * as vscode from "vscode";
import { getLogger } from "../../logger";
import { isRosWorkspace } from "../shared/ros-workspace-gate";
import {
    rosCppSnippetCandidates,
    RosCppCandidate,
} from "./cpp-ros-snippets-core";

const log = getLogger("cpp-ros-snippets");

export class RosCppCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[] | undefined> {
        // 门槛(2026-09-07):非 ROS 工作区不弹 rclcpp 片段
        if (!isRosWorkspace()) {
            return undefined;
        }
        const text = document.getText();
        const offset = document.offsetAt(position);
        // 字符串/行注释内不触发(成员片段粘贴无意义)
        if (inStringOrComment(text, offset)) {
            return undefined;
        }
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!wordRange) {
            return undefined;
        }
        const prefix = document.getText(wordRange);
        const candidates = rosCppSnippetCandidates(prefix);
        if (candidates.length === 0) {
            return undefined;
        }
        log.trace(`cpp-ros-snippets:${document.uri.fsPath} 提供 ${candidates.length} 项(prefix=${prefix})`);
        return candidates.map(c => toItem(c, wordRange));
    }
}

function toItem(c: RosCppCandidate, replace: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind.Snippet);
    item.insertText = new vscode.SnippetString(c.insert);
    item.filterText = c.filter; // 纯 ASCII,中文不进过滤
    // 2026-09-08:详细页展示结构(完整插入体代码块)
    const md = new vscode.MarkdownString();
    md.appendMarkdown("```cpp\n" + c.insert + "\n```");
    item.documentation = md;
    item.range = replace;
    return item;
}

/** 粗略判定:位于单行注释 // 或字符串字面量内 */
function inStringOrComment(text: string, offset: number): boolean {
    // 只看当前行之前的 // 是否有效(简化:忽略跨行块注释内换行情况,本场景足够)
    let lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
    const line = text.slice(lineStart, offset);
    // 行注释
    const lineComment = line.indexOf("//");
    if (lineComment >= 0) {
        // 排除 http:// 之类(前缀字母数字冒号)
        const before = line.slice(Math.max(0, lineComment - 2), lineComment);
        if (!/[a-zA-Z0-9:]$/.test(before)) {
            return true;
        }
    }
    // 字符串:粗略按引号奇偶(含 " )
    let inStr = false;
    let last = "";
    for (let i = lineStart; i < offset; i++) {
        const c = text[i];
        if (c === '"' && last !== "\\") {
            inStr = !inStr;
        }
        last = c;
    }
    return inStr;
}

/** C++ 常见扩展 */
const CPP_EXT_PATTERNS = ["**/*.cpp", "**/*.cxx", "**/*.cc", "**/*.hpp", "**/*.hh", "**/*.h"];

/** 注册 ROS 2 C++ 片段提供器(2026-09-07;ROS 工作区门槛内) */
export function registerRosCppCompletion(): vscode.Disposable {
    const provider = vscode.languages.registerCompletionItemProvider(
        CPP_EXT_PATTERNS.map(p => ({ scheme: "file" as const, pattern: p })),
        new RosCppCompletionProvider()
    );
    log.info("ROS 2 C++ 片段提供器已注册:ROS 工作区内(静态 snippets/cpp.json 已退役)");
    return provider;
}
