// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file create-package-command.ts
 * 右键生成包命令的交互层:弹窗收集输入 → 校验 → 调用生成器 → 写盘。
 * 依赖 VS Code API(仅在此层使用 vscode;生成器本身保持纯逻辑可测)。
 *
 * 三个入口(右键菜单已固定类型,不再弹窗选择):
 *   生成 C++ 包    -> cpp-dual(C++ + Python 脚本)
 *   生成 Python 包 -> ament_python(纯 Python)
 *   生成混合包    -> mixed(C++ + Python 模块)
 *
 * 名称语义(2026-09-01 起,依据 create/README.md §4/§7):
 *   输入 = 文件基名,真实对应生成的文件名;校验在输入框实时完成(格式/保留名/同框去重),无重输循环。
 *   - C++ 节点 / Python 脚本(cpp-dual): 宽范围基名(可含连字符, 如 my-node),内部做有损映射(- → _)
 *     与节点名顺延(disambiguateNodeNames);文件基名保持原样。
 *   - Python 模块(mixed / ament_python): 输入即标识符(文件 === 模块名 === 节点名),无映射无顺延。
 *
 * 弹窗顺序: 包名 → 依赖(QuickPick 多选 + 可选自定义, 见 dep-pick.ts)→ 示范节点(C++/Python 各一次)。
 */

import { l10n } from "vscode";

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getLogger } from '../../../../logger';
import {
    generateCppPackageFiles, validatePackageName, validateFileBaseNamesInput, parseFileBaseList,
    disambiguateNodeNames, CppNodeSpec,
} from '../generate/create-cpp-package';
import { generatePythonPackageFiles, parseNodeNames, validateNodeNamesInput } from '../generate/create-python-package';
import { validatePackageFolder } from '../naming/package-folder';
import { DepCheckKind } from '../deps/dep-parse';
import { pickDeps } from '../deps/dep-pick';
import type { PickDepsResult } from '../deps/dep-pick';
// 2026-08-28:colconUtils import 移除(包接入切 package-core.ingestPackageCreated)
import { packageCore } from '../../../../extension';
// 头文件布局按机器发行版分派(内容对齐):发行版 → double/single 查表单一事实源在 gen 域
import { environmentFacade } from '../../../../ros2/environment';
import { resolveIncludeLayout } from '../../config/gen/distro-templates';

/** 写扩展日志(经薄封装分级到 ROS 2 输出通道), outputChannel 未就绪时安全跳过 */
const logger = getLogger('create-package');
function log(msg: string): void {
    logger.info(msg);
}

/** 确定目标目录:右键文件夹优先,否则工作区根 */
function targetDir(uri?: vscode.Uri): string | undefined {
    if (uri && uri.fsPath) {
        return uri.fsPath;
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/** 向导流名(已本地化):各弹窗标题 = 「流名 - 步骤」(步骤键自带序号,如 ① Package name → ① 包名);⚠️ l10n.t 首参保持字面量(分支各写),三元合并会让对账工具看不见 */
function flowTitle(kind: 'cpp-dual' | 'mixed' | 'python'): string {
    if (kind === 'cpp-dual') {
        return l10n.t('Generate C++ package');
    }
    if (kind === 'mixed') {
        return l10n.t('Generate hybrid package');
    }
    return l10n.t('Generate Python package');
}

/** 输入包名(实时校验 + 目标目录文件夹名冲突检查;取消返回 null) */
async function inputPackageName(base: string, flow: string): Promise<string | null> {
    // 循环:输入包名直到合法(含文件夹名冲突重输)
    for (; ;) {
        logger.debug('弹窗:输入包名');
        const v = await vscode.window.showInputBox({
            title: `${flow} - ${l10n.t('① Package name')}`,
            prompt: vscode.l10n.t('Enter the package name (starts with a lowercase letter; only lowercase letters/digits/underscores)'),
            placeHolder: l10n.t('e.g. my_pkg'),
            validateInput: (value) => validatePackageName(value) ?? undefined,
        });
        if (v === undefined) {
            return null;
        }
        const pkg = v.trim();
        const conflict = validatePackageFolder(pkg, (n) => fs.existsSync(path.join(base, n)));
        if (conflict) {
            logger.debug(`包名冲突:${conflict}`);
            vscode.window.showErrorMessage(conflict);
            continue; // 文件夹名冲突 → 重输
        }
        return pkg;
    }
}

/** 输入额外依赖:QuickPick 多选 + 可选自定义输入(2026-09-01, 见 04-包创建依赖多选-具体设计方案.md);无候选自动降级纯输入框;取消(Esc)返回 null → 调用方终止 */
async function inputDeps(kind: DepCheckKind, flow: string): Promise<PickDepsResult | null> {
    return pickDeps(kind, flow);
}

/**
 * 输入 C++ 与 Python 示范节点(按语言各弹一次)。
 * 校验在输入框实时完成(格式/保留名/同框去重),无重输循环;任一取消返回 null。
 * kind 决定 Python 框口径:
 *   cpp-dual → 脚本:输入即文件名,生成 scripts/ 目录下的 .py 脚本(节点名由映射顺延得到);
 *   mixed    → 模块:输入须为合法标识符,生成包目录下的 .py 模块(文件 === 模块名 === 节点名)。
 */
async function inputCppAndPythonNodes(
    kind: 'cpp-dual' | 'mixed',
    cppExample: string,
    pyExample: string,
    flow: string,
): Promise<{ cppFiles: string[]; pyNames: string[] } | null> {
    logger.debug('弹窗:输入 C++ 示范节点文件名');
    const cppInput = await vscode.window.showInputBox({
        title: `${flow} - ${l10n.t('③ C++ demo nodes')}`,
        prompt: vscode.l10n.t('Enter C++ demo node file names (space-separated; leave empty to skip). A .cpp source file is generated under src/ for each name'),
        placeHolder: l10n.t('e.g. {0}', cppExample),
        validateInput: (value) => validateFileBaseNamesInput(value),
    });
    if (cppInput === undefined) {
        return null;
    }
    const pyIsModule = kind === 'mixed';
    logger.debug(`弹窗:输入 Python 示范${pyIsModule ? '模块名' : '脚本文件名'}`);
    const pyInput = await vscode.window.showInputBox({
        title: pyIsModule
            ? `${flow} - ${l10n.t('④ Python demo modules')}`
            : `${flow} - ${l10n.t('④ Python demo scripts')}`,
        prompt: pyIsModule
            ? l10n.t('Enter Python demo module names (space-separated; leave empty to skip). A .py module is generated under the package directory for each name; module names must be valid identifiers')
            : l10n.t('Enter Python demo script file names (space-separated; leave empty to skip). A .py script is generated under scripts/ for each name'),
        placeHolder: l10n.t('e.g. {0}', pyExample),
        validateInput: pyIsModule
            ? (value) => validateNodeNamesInput(value)
            : (value) => validateFileBaseNamesInput(value),
    });
    if (pyInput === undefined) {
        return null;
    }
    const cppFiles = parseFileBaseList(cppInput);
    const pyNames = pyIsModule ? parseNodeNames(pyInput).nodeNames : parseFileBaseList(pyInput);
    return { cppFiles, pyNames };
}

/** 写盘(directory 条目仅建空目录；生成器内容为 LF；exec 条目带可执行位, 供 PROGRAMS/symlink 运行) */
function writeFiles(baseDir: string, files: { path: string; content: string; directory?: boolean; exec?: boolean }[]): void {
    // 循环:逐个写入生成的文件
    for (const f of files) {
        const p = path.join(baseDir, f.path);
        if (f.directory) {
            fs.mkdirSync(p, { recursive: true });   // 空目录, 不写文件
            continue;
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, f.content, { encoding: 'utf8', mode: f.exec ? 0o755 : 0o644 });
    }
}

/** C++ 类包公共流程(cpp-dual / mixed) */
async function createCppLike(
    kind: 'cpp-dual' | 'mixed',
    cppExample: string,
    pyExample: string,
    uri?: vscode.Uri,
): Promise<void> {
    const base = targetDir(uri);
    if (!base) {
        log('中止: 未找到目标目录');
        vscode.window.showErrorMessage(vscode.l10n.t('Target directory not found (run inside a workspace or via right-click on a folder)'));
        return;
    }
    const flow = flowTitle(kind);
    const kindLabel = kind === 'mixed' ? l10n.t('Hybrid') : 'C++';
    log(`开始生成 ${kindLabel} 包, 目标目录: ${base}`);
    const pkg = await inputPackageName(base, flow);
    if (pkg === null) {
        log('取消: 未输入包名');
        return; // 取消
    }
    const deps = await inputDeps(kind, flow);
    if (deps === null) {
        log(`取消: 包 ${pkg} 未输入额外依赖`);
        return; // 取消
    }
    const nodes = await inputCppAndPythonNodes(kind, cppExample, pyExample, flow);
    if (nodes === null) {
        log(`取消: 包 ${pkg} 未输入节点`);
        return; // 取消
    }
    // C++/脚本: 有损映射(-→_) + 节点名顺延(文件基名不变); 模块: 恒等(file === node)
    const cppNodes = disambiguateNodeNames(nodes.cppFiles);
    const pythonNodes: CppNodeSpec[] = kind === 'mixed'
        ? nodes.pyNames.map((n) => ({ file: n, node: n }))
        : disambiguateNodeNames(nodes.pyNames);
    // 依赖通道拆分(2026-09-06): pythonOnly 纯 Python 依赖只落 <exec_depend>, 不 find_package
    // 头文件布局按机器发行版分派(内容对齐): 未知/rolling → double 兜底; 生成的文本自身版本中立
    const files = generateCppPackageFiles({
        packageName: pkg, kind, extraDeps: deps.deps, pythonOnlyDeps: deps.pythonOnly, cppNodes, pythonNodes,
        includeLayout: resolveIncludeLayout(environmentFacade.getEnv()?.ROS_DISTRO),
    });
    writeFiles(path.join(base, pkg), files);

    // 【B1 直接通信】创建成功后直接接入 package-core(2026-08-28:取代旧壳 handlePackageXmlChange + flushPackagesSyncNow)
    const packageXmlPath = path.join(base, pkg, "package.xml");
    await packageCore?.ingestPackageCreated(packageXmlPath);

    log(`成功生成 ${kindLabel} 包: ${pkg} (依赖: ${deps.deps.length > 0 ? deps.deps.join(', ') : '无'}, C++ 节点: ${cppNodes.length}, Python 节点: ${pythonNodes.length})`);
    vscode.window.showInformationMessage(vscode.l10n.t('{0} package generated: {1}', kindLabel, pkg));
}

/** 右键「生成 C++ 包」→ 双语言节点包 (cpp-dual) */
export async function createCppPackage(uri?: vscode.Uri): Promise<void> {
    await createCppLike('cpp-dual', 'my-node', 'py-node', uri);
}

/** 右键「生成混合包」→ 混合包 (mixed) */
export async function createMixedPackage(uri?: vscode.Uri): Promise<void> {
    await createCppLike('mixed', 'my-node', 'py_node_1', uri);
}

/** 右键「生成 Python 包」→ 纯 Python 包 (ament_python) */
export async function createPythonPackage(uri?: vscode.Uri): Promise<void> {
    const base = targetDir(uri);
    if (!base) {
        log('中止: 未找到目标目录');
        vscode.window.showErrorMessage(vscode.l10n.t('Target directory not found (run inside a workspace or via right-click on a folder)'));
        return;
    }
    log('开始生成 Python 包, 目标目录: ' + base);
    const flow = flowTitle('python');
    const pkg = await inputPackageName(base, flow);
    if (pkg === null) {
        log('取消: 未输入包名');
        return;
    }
    const deps = await inputDeps('python', flow);
    if (deps === null) {
        log(`取消: 包 ${pkg} 未输入额外依赖`);
        return; // 取消
    }
    logger.debug('弹窗:输入示范节点名(标识符)');
    const nodeInput = await vscode.window.showInputBox({
        title: `${flow} - ${l10n.t('③ Demo node names')}`,
        prompt: vscode.l10n.t('Enter demo node names (space-separated; optional). A .py module is generated in the package directory for each name and registered as a ros2 run executable'),
        placeHolder: l10n.t('e.g. talker listener'),
        validateInput: (value) => validateNodeNamesInput(value),
    });
    if (nodeInput === undefined) {
        log(`取消: 包 ${pkg} 未输入节点名`);
        return;
    }
    const parsed = parseNodeNames(nodeInput);
    if (parsed.error) {
        log(`失败: 包 ${pkg} 节点名非法 (${parsed.error})`);
        vscode.window.showErrorMessage(parsed.error);
        return;
    }
    const files = generatePythonPackageFiles({ packageName: pkg, nodeNames: parsed.nodeNames, extraDeps: deps.deps });
    writeFiles(path.join(base, pkg), files);

    // 【B1 直接通信】创建成功后直接接入 package-core(2026-08-28:取代旧壳 handlePackageXmlChange + flushPackagesSyncNow)
    const packageXmlPath = path.join(base, pkg, "package.xml");
    await packageCore?.ingestPackageCreated(packageXmlPath);

    log(`成功生成 Python 包: ${pkg} (依赖: ${deps.deps.length > 0 ? deps.deps.join(', ') : '无'}, 节点: ${parsed.nodeNames.length})`);
    vscode.window.showInformationMessage(vscode.l10n.t('Python package generated: {0}', pkg));
}
