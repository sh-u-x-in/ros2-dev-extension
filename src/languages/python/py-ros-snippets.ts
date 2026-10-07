/**
 * ROS 2 Python 节点代码片段动态提供器(.py,非 *.launch.py)
 *
 * 2026-09-07:替代退役的静态 snippets/python.json(原按 python 语言全量注入,污染 .launch.py 与无关 .py)。
 * 动态注入规则:
 *  - selector 覆盖所有 .py(任意目录层级),但文件名以 .launch.py 结尾一律跳过(launch 补全归 languages/launch);
 *  - 代码位置打字触发(词前缀命中目录)/ '.' 触发列出成员类片段后继续过滤;
 *  - 字符串字面量内不触发;label 中文,filterText = 中文名 + 原 prefix/语义词(ros2pub 等)。
 */

import * as vscode from "vscode";
import { getLogger } from "../../logger";
import { isRosWorkspace } from "../shared/ros-workspace-gate";
import {
    rosPySnippetCandidates,
    RosPyCandidate,
    isLaunchPyPath,
} from "./py-ros-snippets-core";

const log = getLogger("py-ros-snippets");

export class RosPyCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | undefined> {
        // ① 跳过 launch.py(ros2 launch 的补全由 languages/launch 提供)
        if (isLaunchPyPath(document.uri.fsPath)) {
            return undefined;
        }
        // ② 门槛(2026-09-07):非 ROS 工作区不弹 rclpy 片段(防普通 .py 污染)
        if (!isRosWorkspace()) {
            return undefined;
        }
        const text = document.getText();
        const offset = document.offsetAt(position);
        // ③ 字符串字面量内不触发(成员片段粘贴进注释/字符串无意义)
        if (inPyString(text, offset)) {
            return undefined;
        }
        // ④ 词前缀:打字过程自动触发;'.' 触发:成员区(空词)列全量供继续过滤
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        let prefix = "";
        let replace: vscode.Range | undefined;
        if (wordRange) {
            prefix = document.getText(wordRange);
            replace = wordRange;
        } else if (context.triggerCharacter !== ".") {
            return undefined; // 无词且非 '.' 触发:不打扰
        }
        const candidates = rosPySnippetCandidates(prefix);
        if (candidates.length === 0) {
            return undefined;
        }
        log.trace(`py-ros-snippets:${document.uri.fsPath} 提供 ${candidates.length} 项(prefix=${prefix})`);
        return candidates.map(c => toItem(c, replace));
    }
}

function toItem(c: RosPyCandidate, replace?: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind.Snippet);
    item.insertText = new vscode.SnippetString(c.insert);
    item.filterText = c.filter; // 纯 ASCII,中文不进过滤
    // 2026-09-08:详细页展示结构(完整插入体代码块)
    const md = new vscode.MarkdownString();
    md.appendMarkdown("```python\n" + c.insert + "\n```");
    item.documentation = md;
    if (replace) {
        item.range = replace;
    }
    return item;
}

/** 粗略字符串字面量判定(单双引号奇偶,忽略转义;仅防片段误贴) */
function inPyString(text: string, offset: number): boolean {
    let single = false;
    let last = "";
    for (let i = 0; i < offset && i < text.length; i++) {
        const c = text[i];
        if ((c === "'" || c === '"') && last !== "\\") {
            single = !single;
        }
        last = c;
    }
    return single;
}

/** 注册 ROS 2 Python 节点片段提供器(2026-09-07;'.' 触发成员区) */
export function registerRosPythonCompletion(): vscode.Disposable {
    const provider = vscode.languages.registerCompletionItemProvider(
        { scheme: "file", pattern: "**/*.py" },
        new RosPyCompletionProvider(),
        "."
    );
    log.info("ROS 2 Python 片段提供器已注册:普通 .py(launch.py 排除)+ '.' 触发");
    return provider;
}
