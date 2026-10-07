// Licensed under the MIT License.

/**
 * @file run-report.ts
 * XML 用例 → `TestItem` 映射与上报（2026-09-24 测试改造 B1，计划 §2.4）。
 *
 * 语义:
 *   - **一条 XML 用例 = 结果真值**;能一一对上树里的项就逐项上报;
 *   - 参数化/类型化实例(gtest `param_macro/0`、pytest `test_p[...]`)**不进树**(§7.1 边界),
 *     按"去参数基名"聚合到父项;
 *   - 聚合规则(计划 §2.4):全 passed → `passed(Σduration)`;含失败 → `failed(汇总消息[实例名:断言])`;
 *     有 skipped 且无失败 → `skipped`。
 */

import { l10n } from 'vscode'; // 2026-10-04 i18n 期2
import * as vscode from "vscode";
import { gtestSuiteOf } from "../semantics/gtest-filter";
import * as path from "path";

import { ParsedCase } from "../parsing/test-results-parser";
import { getLogger } from "../../logger";

const log = getLogger("test-report");

/** 去掉参数段:`test_p[a-b]` → `test_p`、`param_macro/0` 在调用前已切分 */
function stripParams(name: string): string {
    const i = name.indexOf("[");
    return i < 0 ? name : name.slice(0, i);
}

interface Candidate {
    item: vscode.TestItem;
    /** 该候选所属的文件项(用于同名消歧与兜底归属) */
    fileItem: vscode.TestItem;
    /** 文件项 stem(无扩展名 basename),用于与 junit classname 的点分段对齐 */
    fileStem: string;
}

function stemOfFileItem(item: vscode.TestItem): string {
    const p = item.uri === undefined ? item.label : item.uri.fsPath;
    return path.basename(p, path.extname(p));
}

/** 收集候选:文件项下有子项 → 子项;否则文件项自身(用户直接点了用例项/叶子) */
function collectCandidates(fileItems: vscode.TestItem[]): Candidate[] {
    const out: Candidate[] = [];
    for (const f of fileItems) {
        const stem = stemOfFileItem(f);
        if (f.children.size > 0) {
            f.children.forEach((child) => {
                out.push({ item: child, fileItem: f, fileStem: stem });
            });
        } else {
            out.push({ item: f, fileItem: f, fileStem: stem });
        }
    }
    return out;
}

/**
 * 定位一条用例应归属的项。
 * - gtest:`label === "<classname 末段>.<name 去索引>"`(如 `AdderParamTest.param_macro`)
 * - pytest:`label === "<name 去参数>"`;多个文件同名时,优先 classname 点分段里出现的文件 stem
 */
function resolveTarget(c: ParsedCase, kind: "pytest" | "gtest" | "launch", cands: Candidate[]): Candidate | undefined {
    const parts = c.classname.split(".");
    let base = stripParams(c.name);
    let wanted: string;

    if (kind === "gtest") {
        // B14-fix:末段可能是**类型索引**(TYPED_TEST 的 `CubicTest/0`)——不能只取 pop()
        const suite = gtestSuiteOf(c.classname);
        // `param_macro/0` → `param_macro`(索引段去掉)
        const slash = base.indexOf("/");
        if (slash >= 0) {
            base = base.slice(0, slash);
        }
        wanted = `${suite}.${base}`;
    } else {
        wanted = base;
    }

    const exact = cands.filter((x) => x.item.label === wanted);
    if (exact.length === 1) {
        return exact[0];
    }
    if (exact.length > 1) {
        // 同名消歧:classname 的点分段与文件 stem 对齐(如 `test.test_helper` ↔ `test_helper`)
        const byStem = exact.filter((x) => parts.indexOf(x.fileStem) >= 0);
        return byStem.length > 0 ? byStem[0] : exact[0];
    }
    // 二级兜底:gtest 树若以套件名/裸用例名呈现,再试一次裸基名
    const loose = cands.filter((x) => x.item.label === base);
    if (loose.length > 0) {
        return loose[0];
    }
    return undefined;
}

/** 单个目标项的聚合上报 */
function reportAggregated(run: vscode.TestRun, item: vscode.TestItem, cases: ParsedCase[]): void {
    const totalMs = cases.reduce((sum, c) => sum + (c.timeSec === undefined ? 0 : c.timeSec * 1000), 0);
    const failed = cases.filter((c) => c.status === "failed" || c.status === "errored");
    run.started(item);

    if (failed.length > 0) {
        const messages = failed.map((c) => {
            const label = cases.length > 1 ? `${c.name}: ` : "";
            return new vscode.TestMessage(`${label}${c.message === undefined ? l10n.t("Assertion failed") : c.message}`);
        });
        run.failed(item, messages, totalMs);
        return;
    }
    if (cases.some((c) => c.status === "skipped")) {
        run.skipped(item);
        return;
    }
    run.passed(item, totalMs);
}

/**
 * 把一次产物的用例清单映射回树并上报。
 *
 * @param scope 本次运行的 scope:该范围内全部**文件项**(用户点用例项时即该叶子自身)
 */
export function reportCases(
    run: vscode.TestRun,
    scope: { fileItems: vscode.TestItem[] },
    cases: ParsedCase[],
    kind: "pytest" | "gtest" | "launch"
): void {
    const cands = collectCandidates(scope.fileItems);
    const groups = new Map<vscode.TestItem, ParsedCase[]>();
    let unmapped = 0;

    for (const c of cases) {
        const hit = resolveTarget(c, kind, cands);
        if (hit === undefined) {
            unmapped++;
            // 兜底:scope 只有一个文件项时,归属给它(参数化实例/命名差异都落这里)
            const fallback = scope.fileItems[0];
            if (fallback !== undefined) {
                const list = groups.get(fallback) ?? [];
                list.push(c);
                groups.set(fallback, list);
            }
            continue;
        }
        const list = groups.get(hit.item) ?? [];
        list.push(c);
        groups.set(hit.item, list);
    }

    if (unmapped > 0) {
        log.debug(l10n.t("{0} cases did not exactly match tree items; assigned via fallback (scope file items={1})", unmapped, scope.fileItems.length));
    }

    for (const [item, list] of groups) {
        reportAggregated(run, item, list);
    }
    log.debug(l10n.t("Reporting finished (type={0}): {1} cases, {2} target items", kind, cases.length, groups.size));
}
