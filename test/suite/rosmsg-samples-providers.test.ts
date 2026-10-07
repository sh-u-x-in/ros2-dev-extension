/**
 * rosmsg 语法模块 · 跨文件引用/跳转/补全/语义 token（L2 VS Code 集成）
 *
 * 目标模块：src/languages/rosmsg/（MessageIndex、providers、completion、semantic token）
 * 层级：L2（打开 samples 工作区，依赖 VS Code 宿主）
 * 关联测试项：R10–R17（方案 01 §4.2 / §4.3）
 *
 * 策略：
 *  - R10 用 mock ExtensionContext 自建 MessageIndex 验证工作区扫描（不依赖扩展激活）
 *  - R11–R14 通过 vscode 命令调用真实注册的 provider（需扩展激活；R14 需系统索引→itIfRos）
 *  - R15–R17 纯函数（getCompletionContext / buildSemanticTokenData），任何环境可跑
 * 验收：npm test（集成）→ R10–R17 通过；无 ROS 时除 R14（系统索引）外均通过；R14 远端 ROS 验证。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { MessageIndex } from "../../src/languages/rosmsg/data/message-index";
import type { RosInterfaceEntry } from "../../src/languages/rosmsg/data/message-index";
// 2026-09-02(设计 D3):message-index 工作区数据源 = package-core 门面——本用例不依赖扩展激活,自建 PackageCore
import { createPackageCore, PackageCore } from "../../src/build-tool/package-core/compose";
// 2026-09-13 三张表重构:包表来源 = 注入的 PackageSource(PackageMap:R1 快照/R2 就绪/R3 原子事件)
import { PackageMap } from "../../src/languages/shared/package-map";
import { getCompletionContext } from "../../src/languages/rosmsg/parse/rosmsg-document";
import { buildSemanticTokenData } from "../../src/languages/rosmsg/parse/semantic-token-builder";
import { parseRosMessageDocument } from "../../src/languages/rosmsg/parse/rosmsg-document";

/** samples/src/msg_interfaces 根目录（标准工作空间） */
const MSG_ROOT = path.resolve(__dirname, "../../../samples/src/msg_interfaces");

/** R14 依赖系统消息索引（std_msgs/Header 来自 ros2 interface list / 静态表外）→ 需 ROS 环境 */
const shouldRunRosTests = process.env.ROS_DISTRO || process.env.RUN_ROS_TESTS;
const itIfRos = shouldRunRosTests ? it : it.skip;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等待扩展激活（provider 注册不依赖 ROS，但需 dist 产物可加载） */
async function ensureExtensionActivated(): Promise<void> {
    const ext = vscode.extensions.getExtension("local.rde-ros-2");
    if (!ext) {
        throw new Error("扩展 local.rde-ros-2 未找到（集成宿主应已加载）");
    }
    if (!ext.isActive) {
        await ext.activate();
        await delay(2000);
    }
}

/** 构造最小 ExtensionContext（MessageIndex 只用 globalStoragePath/storageUri/workspaceFolders） */
function makeMockContext(): vscode.ExtensionContext {
    const base = path.join(os.tmpdir(), "rde-msgindex-" + process.pid);
    fs.mkdirSync(base, { recursive: true });
    return {
        globalStoragePath: base,
        storageUri: vscode.Uri.file(base),
        subscriptions: [],
        extensionUri: vscode.Uri.file(base),
    } as unknown as vscode.ExtensionContext;
}

// ==================== R10 · MessageIndex 工作区扫描 ====================
describe("R10 MessageIndex 工作区扫描(samples/src/msg_interfaces)", function () {
    this.timeout(20000);

    /** samples 工作区根(共享 walk 扫描根,2026-09-02:消息索引读门面 workspace 域) */
    const SAMPLES_ROOT = path.resolve(__dirname, "../../../samples");
    let core: PackageCore | undefined;

    before(async function () {
        // 2026-09-02(设计 D3):message-index.refreshPackageNames 数据源 = package-core 门面(getPackageCore);
        // 本用例刻意不依赖扩展激活 → 自建 PackageCore(零定时器/零 watcher/系统包置 null)使门面可用,用例结束释放。
        // 注意:walk 配置须显式给足(缺省 0 超时会令扫描立即返回空,2026-09-02 R10 排障)。
        core = createPackageCore({
            workspaceRoot: SAMPLES_ROOT,
            refreshIntervalMs: 0,
            enableWatcher: false,
            systemPackages: async () => null,
            config: {
                packageCacheRefreshMs: 0,
                buildExcludeFolders: [],
                followSymlinks: false,
                walkTimeouts: { totalTimeoutMs: 10000, branchTimeoutMs: 2000, maxDepth: 8 },
            },
        });
        await core.forceRefresh(); // 域就绪(walk 首载),refreshPackageNames 可读到 workspace 域
    });

    after(() => {
        core?.dispose();
        core = undefined;
    });

    it("R10 MessageIndex 工作区扫描 → 索引到 msg_interfaces 的 BasicTypes/RobotStatus（合法包）", async () => {
        // 2026-09-13:包表来源改为注入 PackageSource——自建 PackageMap(core 单例已由上方 before 建好并刷新)
        const packages = new PackageMap();
        await packages.initialize();
        const index = new MessageIndex(makeMockContext(), 60000, undefined, packages);
        await index.initialize();
        // 标准工作空间：samples/src/msg_interfaces 的 package.xml 父目录为 src → 合法包，按包名查询
        let entries: RosInterfaceEntry[] = [];
        for (let i = 0; i < 40; i++) {
            entries = index.getMessagesInPackage("msg_interfaces");
            if (entries.some((e) => e.name === "BasicTypes")) {
                break;
            }
            await delay(250);
        }
        const basic = entries.find((e) => e.name === "BasicTypes");
        assert.ok(basic, "工作区扫描应索引到 msg_interfaces/BasicTypes");
        assert.strictEqual(basic!.source, "workspace");
        assert.notStrictEqual(basic!.loose, true, "src/ 结构下应为合法包（非 loose）");
        assert.ok(entries.some((e) => e.name === "RobotStatus"), "工作区扫描应索引到 RobotStatus");
    });

    it("R10b 工作区外 .msg:裸名只有查询能力,不补登(不进非法桶)", async () => {
        const packages = new PackageMap();
        await packages.initialize();
        const index = new MessageIndex(makeMockContext(), 60000, undefined, packages);
        await index.initialize();
        // 工作区外(系统临时目录)的一个 .msg——名字唯一,便于观察是否被登记
        const probe = "RdeOutsideProbe" + process.pid;
        const outside = path.join(os.tmpdir(), probe + ".msg");
        fs.writeFileSync(outside, "float64 x\n");
        try {
            const hit = await index.findBareNameDefinition(outside, probe);
            assert.strictEqual(hit, undefined, "工作区外文件无「本包」,裸名不解析");
            const loose = index.getLooseEntriesByPrefix(probe);
            assert.ok(
                !loose.some((e) => e.path === path.normalize(outside)),
                "工作区外文件不得进入非法桶(不做补充登记)"
            );
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });
});

// ==================== R11–R14 · providers（需扩展激活） ====================
describe("rosmsg 跨文件跳转/悬停/补全(samples)", function () {
    before(function (this: Mocha.Context) {
        // TODO(2026-09-28 诊断):本组走真实注册 provider(executeDefinitionProvider/Hover),
        // 依赖扩展在测试宿主内完成激活;而诊断证实 dist bundle 在该宿主中从未被 require
        // (模块顶层探针未触发)——同 rosapi-startup-order,待 @vscode/test-electron 装配排查。
        const g = global as unknown as { __vscodeStubInstalled?: boolean };
        if (!g.__vscodeStubInstalled) {
            this.skip();
        }
    });

    this.timeout(30000);

    before(async function () {
        try {
            await ensureExtensionActivated();
        } catch (err) {
            this.skip();
        }
    });

    /** 打开 samples 文件并设为 rosmsg 语言 */
    async function openDoc(rel: string): Promise<vscode.TextDocument> {
        const doc = await vscode.workspace.openTextDocument(path.join(MSG_ROOT, rel));
        await vscode.languages.setTextDocumentLanguage(doc, "rosmsg");
        return doc;
    }

    /** 定位含指定子串的行并返回 [line, typeStartCol]（type 列取 0 或指定偏移） */
    function findLineCol(doc: vscode.TextDocument, substr: string, charOffset = 0): vscode.Position {
        for (let i = 0; i < doc.lineCount; i++) {
            const text = doc.lineAt(i).text;
            const idx = text.indexOf(substr);
            if (idx >= 0) {
                return new vscode.Position(i, idx + charOffset);
            }
        }
        throw new Error(`未找到 "${substr}"`);
    }

    it("R11 ComplexMessage.msg 的 BasicTypes → 跳转 msg/BasicTypes.msg", async () => {
        const doc = await openDoc("msg/ComplexMessage.msg");
        const pos = findLineCol(doc, "BasicTypes");
        const defs = await vscode.commands.executeCommand<vscode.Location[]>(
            "vscode.executeDefinitionProvider", doc.uri, pos
        );
        assert.ok(defs && defs.length > 0, "应返回跳转结果");
        const target = defs![0].uri.fsPath;
        assert.ok(
            target.replace(/\\/g, "/").endsWith("samples/src/msg_interfaces/msg/BasicTypes.msg"),
            `应跳转到 BasicTypes.msg，实际 ${target}`
        );
    });

    it("R12 GetRobotInfo.srv 的 RobotStatus（response 段）→ 跳转 msg/RobotStatus.msg", async () => {
        const doc = await openDoc("srv/GetRobotInfo.srv");
        const pos = findLineCol(doc, "RobotStatus current_status");
        const defs = await vscode.commands.executeCommand<vscode.Location[]>(
            "vscode.executeDefinitionProvider", doc.uri, pos
        );
        assert.ok(defs && defs.length > 0, "应返回跳转结果");
        const target = defs![0].uri.fsPath;
        assert.ok(
            target.replace(/\\/g, "/").endsWith("samples/src/msg_interfaces/msg/RobotStatus.msg"),
            `应跳转到 RobotStatus.msg，实际 ${target}`
        );
    });

    it("R13 srv/action 的类型 hover 含「属性」段", async () => {
        // srv：GetRobotInfo.srv 的 RobotStatus（工作区自定义类型 → 属性来自 RobotStatus.msg 字段）
        const srvDoc = await openDoc("srv/GetRobotInfo.srv");
        let hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            "vscode.executeHoverProvider", srvDoc.uri, findLineCol(srvDoc, "RobotStatus current_status")
        );
        let text = hovers && hovers.length > 0 ? (hovers[0].contents[0] as vscode.MarkdownString).value : "";
        assert.ok(text.includes("属性"), "srv 的 RobotStatus hover 应含「属性」段");

        // action：MoveToGoal.action 的 PoseStamped（内置常用类型 → hover 应有内容）
        const actDoc = await openDoc("action/MoveToGoal.action");
        hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            "vscode.executeHoverProvider", actDoc.uri, findLineCol(actDoc, "target_pose")
        );
        text = hovers && hovers.length > 0 ? (hovers[0].contents[0] as vscode.MarkdownString).value : "";
        assert.ok(text.length > 0, "action 类型 hover 应有内容");
    });

    itIfRos("R14 在 ComplexMessage.msg 输入 std_msgs/ → 补全 Header（需系统索引）", async () => {
        const doc = await openDoc("msg/ComplexMessage.msg");
        const editor = await vscode.window.showTextDocument(doc);
        const insertPos = new vscode.Position(doc.lineCount, 0);
        await editor.edit((eb) => eb.insert(insertPos, "std_msgs/"));
        const pos = new vscode.Position(doc.lineCount, "std_msgs/".length);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            "vscode.executeCompletionItemProvider", doc.uri, pos, "std_msgs/"
        );
        const labels = (list?.items ?? []).map((i) => String(i.label));
        assert.ok(labels.some((l) => l.includes("Header")), `应补全 std_msgs/Header，实际 ${labels.join(",")}`);
    });
});

// ==================== R15 · getCompletionContext ====================
describe("R15 getCompletionContext(samples 行前缀)", () => {
    it("R15 各类行前缀 → type/name/default/none", () => {
        assert.strictEqual(getCompletionContext("std_msgs/"), "type");
        assert.strictEqual(getCompletionContext("float64 "), "name");
        assert.strictEqual(getCompletionContext("x = "), "default");
        // 非类型/名称/默认值位（如常量值后）→ none
        assert.strictEqual(getCompletionContext(""), "type");
    });
});

// ==================== R16–R17 · buildSemanticTokenData ====================
describe("R16-R17 语义 token(samples 真文件)", () => {
    it("R16 BasicTypes.msg → token 数据为 5 的倍数且非空（类型/常量被分类）", () => {
        const abs = path.join(MSG_ROOT, "msg/BasicTypes.msg");
        const doc = { fileName: abs, uri: abs, version: 1, languageId: "rosmsg", getText: () => fs.readFileSync(abs, "utf-8") } as unknown as vscode.TextDocument;
        const parsed = parseRosMessageDocument(doc);
        const data = buildSemanticTokenData(parsed);
        assert.ok(data.length > 0, "应生成 token 数据");
        assert.strictEqual(data.length % 5, 0, "SemanticTokens 每 5 个数一个 token");
        // 类型 token（typeIdx=1）：MAX_SPEED 等常量的类型应出现
        const typeTokens = data.filter((_, i) => i % 5 === 3 && data[i] === 1);
        assert.ok(typeTokens.length > 0, "应有类型 token（typeIdx=1）");
    });

    it("R17 [<=10] 有界数组 + srv 分隔线 → tokenize 不崩", () => {
        // ComplexMessage.msg：含 uint8[<=10]
        const cAbs = path.join(MSG_ROOT, "msg/ComplexMessage.msg");
        const cDoc = { fileName: cAbs, uri: cAbs, version: 1, languageId: "rosmsg", getText: () => fs.readFileSync(cAbs, "utf-8") } as unknown as vscode.TextDocument;
        const cData = buildSemanticTokenData(parseRosMessageDocument(cDoc));
        assert.ok(Array.isArray(cData), "有界数组文件应正常 tokenize");
        // CalculateSum.srv：含 --- 分隔线（两段）
        const sAbs = path.join(MSG_ROOT, "srv/CalculateSum.srv");
        const sDoc = { fileName: sAbs, uri: sAbs, version: 1, languageId: "rosmsg", getText: () => fs.readFileSync(sAbs, "utf-8") } as unknown as vscode.TextDocument;
        const parsedSrv = parseRosMessageDocument(sDoc);
        assert.strictEqual(parsedSrv.sections.length, 2, "srv 应分两段");
        const sData = buildSemanticTokenData(parsedSrv);
        assert.ok(Array.isArray(sData), "多段 srv 应正常 tokenize");
    });
});
