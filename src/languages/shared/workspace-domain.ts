/**
 * workspace-domain — VS Code 工作区根域判定(languages/shared,2026-09-25 XG13/LA-1)。
 *
 * "解析域"理念的单一事实源:对解析类语言,文件跳出工作区根(系统包 /opt/ros/… 等
 * 经 $(find) 跳入的目标)就没有深入解析/反向检索的必要——各语言域用本判定做门控:
 *  - xacro:兜底反向搜索域门(XG13,include-graph.needFallback/fallback);
 *  - launch:补全/链接/悬浮/跳转对域外文档早退(解析只发生在当前打开文档);
 *  - rosmsg:不受此限——它是"登记域",系统接口恰恰需要越域登记(见 system-index)。
 *
 * 判定口径:文件路径落在任一 workspaceFolders 根内(含根自身);无根 → 域空恒 false;
 * win32 大小写不敏感。
 */
import * as vscode from "vscode";
import * as path from "path";

export function fileInWorkspaceDomain(file: vscode.Uri): boolean {
    const roots = vscode.workspace.workspaceFolders;
    if (!roots || roots.length === 0) {
        return false;
    }
    const norm = (p: string): string => process.platform === "win32" ? p.toLowerCase() : p;
    const fsPath = norm(file.fsPath);
    return roots.some(r => {
        const root = norm(r.uri.fsPath);
        return fsPath === root || fsPath.startsWith(root + path.sep);
    });
}
