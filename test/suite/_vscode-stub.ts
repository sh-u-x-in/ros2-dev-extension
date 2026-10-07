/**
 * 无头 mocha（纯 node）下拦截 require("vscode") 的最小 stub。
 *
 * 用途：L1 纯逻辑测试（如 analyzeDocument 的零误报护栏 R9）在 VS Code 宿主外直接
 *       `npx mocha out/test/suite/<file>.test.js` 运行时，vscode 模块不可用
 *       （MODULE_NOT_FOUND）；此 stub 提供 analyzeDocument 用到的
 *       Diagnostic / Range / DiagnosticSeverity 最小实现，使该类测试可无头跑。
 *
 * 安全：真实集成宿主（npm test，VS Code 扩展进程）里 require("vscode") 可解析，
 *       installVscodeStub 直接返回、不劫持——保证集成测试仍用真 vscode。
 *
 * 注意：文件名以下划线开头、不含 .test 后缀，不会被 test/suite/index.ts 的
 *       glob 收集（只匹配 *.test.js）为测试用例。
 */

import { createRequire } from "module";

const req = createRequire(__filename);

/**
 * 二级弹窗(share/pick-preset)无头测试用的**可编排 window harness**:
 * `vscode.window.showQuickPick / showInputBox` 的返回值从下面两个队列取(队列取空 = undefined = "用户取消"),
 * 并记录调用次数,便于断言"该弹的弹了 / 不该弹的没弹"。
 */
export const vscodeStubWindow = {
    quickPickResponses: [] as unknown[],
    inputBoxResponses: [] as unknown[],
    quickPickCalls: 0,
    inputBoxCalls: 0,
    reset(): void {
        this.quickPickResponses = [];
        this.inputBoxResponses = [];
        this.quickPickCalls = 0;
        this.inputBoxCalls = 0;
    },
};

/**
 * 设置项 stub(供"读设置"的无头测试播种,如 build/share-spec):
 * `vscode.workspace.getConfiguration(...).get/update` 都落到 `vscodeStubConfig.store`,
 * 键 = 传给 get/update 的**原样字符串**(如 `build.shareSpec`);
 * `get(key, defaultValue)` 在没播种时返回 defaultValue(与真 API 一致)。
 */
export const vscodeStubConfig = {
    store: {} as Record<string, unknown>,
    reset(): void {
        this.store = {};
    },
};

/**
 * 注入 vscode stub（幂等）。无头环境 patch Module._load 拦截 "vscode"；
 * 真实环境（能 require("vscode")）直接跳过。
 */
export function installVscodeStub(): void {
    const g = global as unknown as { __vscodeStubInstalled?: boolean };
    if (g.__vscodeStubInstalled) {
        return;
    }

    // 真实 VS Code 集成宿主能解析 vscode → 不劫持
    try {
        req("vscode");
        return;
    } catch {
        // 无头环境：注入 stub
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = req("module") as unknown as {
        _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const originalLoad = Module._load;

    // vscode.DiagnosticSeverity 枚举值（Error=0, Warning=1, Information=2, Hint=3）
    const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

    class Range {
        constructor(
            public startLine: number,
            public startCharacter: number,
            public endLine: number,
            public endCharacter: number,
        ) { }
    }

    class Diagnostic {
        constructor(
            public range: Range,
            public message: string,
            public severity: number,
        ) { }
    }

    class EventEmitter<T = void> {
        private listeners: Array<(e: T) => unknown> = [];

        event = (listener: (e: T) => unknown): { dispose(): void } => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    const index = this.listeners.indexOf(listener);
                    if (index >= 0) {
                        this.listeners.splice(index, 1);
                    }
                },
            };
        };

        fire(data: T): void {
            for (const listener of [...this.listeners]) {
                listener(data);
            }
        }

        dispose(): void {
            this.listeners = [];
        }
    }

    // rosmsg semantic-tokens 顶层 new vscode.SemanticTokensLegend(...) 需要的最小构造
    class SemanticTokensLegend {
        constructor(
            public tokenTypes: string[],
            public tokenModifiers: string[],
        ) { }
    }


    // intellisense-config 渲染测试需要:workspace.getConfiguration(python extraPaths 写入) + ConfigurationTarget
    class WorkspaceConfiguration {
        get<T>(key: string, defaultValue?: T): T {
            const v = vscodeStubConfig.store[key];
            return v !== undefined ? (v as T) : (defaultValue as T);
        }
        update(key: string, value: unknown, _target?: unknown): Promise<void> {
            vscodeStubConfig.store[key] = value;
            return Promise.resolve();
        }
    }

    const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

    const vscodeStub = {
        DiagnosticSeverity, Range, Diagnostic, EventEmitter, SemanticTokensLegend,
        workspace: { getConfiguration: () => new WorkspaceConfiguration() },
        ConfigurationTarget,
        // l10n 透传(2026-10-04 i18n 期0):无头测试里被测代码调 vscode.l10n.t 时返回英文源串本身
        // (等价 locale=en 的回退行为)——测试断言口径由此钉死为源串,与开发者机器显示语言无关。
        // {N} 插值与真实宿主同语义:先查册(无册=原串)再按位置参数替换
        l10n: {
            t: (message: string, ...args: unknown[]): string => {
                if (args.length === 0) { return message; }
                return message.replace(/\{(\d+)\}/g, (raw, i) => {
                    const v = args[Number(i)];
                    return v === undefined ? raw : String(v);
                });
            },
        },
        // 二级弹窗(share/pick-preset)测试:队列驱动的 window(见 vscodeStubWindow)
        window: {
            showQuickPick: async (): Promise<unknown> => {
                vscodeStubWindow.quickPickCalls++;
                return vscodeStubWindow.quickPickResponses.shift();
            },
            showInputBox: async (): Promise<unknown> => {
                vscodeStubWindow.inputBoxCalls++;
                return vscodeStubWindow.inputBoxResponses.shift();
            },
        },
    };

    Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
        if (request === "vscode") {
            return vscodeStub;
        }
        // build-tool 模块（colcon-utils 等）require "../extension" 仅取 extension.env（进程环境变量）；
        // 无头环境不加载整个 extension.ts（依赖大量 vscode API），返回最小 env 即可。
        // 说明：本 stub 仅在无头环境生效（集成宿主 require("vscode") 成功即跳过），不干扰 npm test。
        if (request === "../extension") {
            return { env: process.env };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    g.__vscodeStubInstalled = true;
}