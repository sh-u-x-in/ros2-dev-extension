/**
 * state/ 通用状态文件层测试(2026-08-31 随"通用层上提 + 并发/原子写"落地补齐;
 * 2026-10-21 状态文件「转入地下」随改:存储根经 setStateStorageRoot 注入,新增一次性迁移组)。
 * 重点回归:多写者并发不互相覆盖(单写者队列)、损坏/缺字段容错、无临时文件残留、旧 .vscode 文件迁移。
 * 无头可单跑(stub 先装;模块 import vscode 的 l10n),也随扩展宿主 mocha 一并运行。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { installVscodeStub } from "./_vscode-stub";

// state-file/记忆模块 import vscode(日志 l10n)→ 无头环境先装 stub 再 require(可单跑;宿主里桩早退不劫持)
installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getStateFilePath, migrateLegacyStateFile, readStateFile, setStateStorageRoot, updateStateFile } = require("../../src/build-tool/package-service/share/state-file");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readSelectionMemory, writeSelectionMemory } = require("../../src/build-tool/package-service/share/selection-memory");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readBuildState, writeBuildState } = require("../../src/build-tool/package-service/share/build-memory");

describe("state/ state-file(扩展私有存储的状态文件通用层)", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rde-state-"));
        setStateStorageRoot(root);
    });

    afterEach(async () => {
        setStateStorageRoot(undefined);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it("文件不存在 → 返回空对象(不抛)", async () => {
        assert.deepStrictEqual(await readStateFile(), {});
    });

    it("文件损坏 / 顶层非对象 → 返回空对象", async () => {
        const filePath = getStateFilePath();
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, "{ 半截 JSON", "utf-8");
        assert.deepStrictEqual(await readStateFile(), {});
        await fs.promises.writeFile(filePath, "[1,2,3]", "utf-8");
        assert.deepStrictEqual(await readStateFile(), {});
    });

    it("未装配存储根 → 读恒空、写静默丢弃", async () => {
        setStateStorageRoot(undefined);
        assert.deepStrictEqual(await readStateFile(), {});
        assert.strictEqual(getStateFilePath(), "");
        await updateStateFile((draft) => { draft.sampleField = { k: 0 }; }); // 不得抛
        assert.deepStrictEqual(await readStateFile(), {});
    });

    it("updateStateFile 只改自己的字段,其它域字段原样保留", async () => {
        await updateStateFile((draft) => { draft.sampleField = { k: 0 }; });
        await updateStateFile((draft) => { draft.otherField = "Debug-详细"; });
        const state = await readStateFile();
        assert.deepStrictEqual(state.sampleField, { k: 0 });
        assert.strictEqual(state.otherField, "Debug-详细");
    });

    it("并发写不丢字段(单写者队列:A读→B读→A写→B写 的覆盖场景)", async () => {
        await Promise.all([
            updateStateFile((draft) => { draft.otherField = "Release-默认"; }),
            updateStateFile((draft) => { draft.sampleField = { k: 1 }; }),
            updateStateFile((draft) => { draft.buildPackages = ["pkg_a"]; }),
        ]);
        const state = await readStateFile();
        assert.strictEqual(state.otherField, "Release-默认");
        assert.deepStrictEqual(state.buildPackages, ["pkg_a"]);
        assert.deepStrictEqual(state.sampleField, { k: 1 });
    });

    it("并发写后文件仍是合法 JSON 且无 .tmp 残留(原子覆盖)", async () => {
        await Promise.all([
            writeBuildState({ buildPackages: ["p1"], knownPackages: ["p1", "p2"] }),
            updateStateFile((draft) => { draft.sampleField = { k: 0 }; }),
        ]);
        const raw = await fs.promises.readFile(getStateFilePath(), "utf-8");
        assert.doesNotThrow(() => JSON.parse(raw));
        const leftovers = (await fs.promises.readdir(root)).filter(f => f.endsWith(".tmp"));
        assert.deepStrictEqual(leftovers, []);
    });
});

describe("state/ 一次性迁移(2026-10-21「转入地下」:工作区 .vscode → 扩展私有存储)", () => {
    let root: string;       // 工作区根(旧文件落 root/.vscode/)
    let storage: string;    // 扩展私有存储根

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rde-mig-ws-"));
        storage = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rde-mig-st-"));
        setStateStorageRoot(storage);
    });

    afterEach(async () => {
        setStateStorageRoot(undefined);
        await fs.promises.rm(root, { recursive: true, force: true });
        await fs.promises.rm(storage, { recursive: true, force: true });
    });

    const legacyPath = (): string => path.join(root, ".vscode", "ros2-dev-extension-state.json");

    it("旧文件有内容 → 写入新位置 + 删除旧文件;新位置读回一致", async () => {
        await fs.promises.mkdir(path.dirname(legacyPath()), { recursive: true });
        await fs.promises.writeFile(legacyPath(), JSON.stringify({
            selectionMemory: { "colcon.build": { picked: [0, 1], custom: "--force" } },
            buildPackages: ["pkg_a"],
        }), "utf-8");
        await migrateLegacyStateFile(root);
        assert.ok(!fs.existsSync(legacyPath()), "旧文件删除(转入地下)");
        assert.deepStrictEqual(await readSelectionMemory("colcon.build"), { picked: [0, 1], custom: "--force" });
        assert.deepStrictEqual((await readBuildState()).buildPackages, ["pkg_a"]);
    });

    it("旧文件损坏 → 按空状态照迁 + 旧文件仍删除(无效残留无保留价值)", async () => {
        await fs.promises.mkdir(path.dirname(legacyPath()), { recursive: true });
        await fs.promises.writeFile(legacyPath(), "{ 半截", "utf-8");
        await migrateLegacyStateFile(root);
        assert.ok(!fs.existsSync(legacyPath()));
        assert.deepStrictEqual(await readStateFile(), {});
    });

    it("新位置已有文件 → 跳过迁移,旧文件不动、新数据不覆盖", async () => {
        await writeSelectionMemory("colcon.build", { picked: [5], custom: "new" });
        await fs.promises.mkdir(path.dirname(legacyPath()), { recursive: true });
        await fs.promises.writeFile(legacyPath(), JSON.stringify({ buildPackages: ["old"] }), "utf-8");
        await migrateLegacyStateFile(root);
        assert.ok(fs.existsSync(legacyPath()), "旧文件保留(不覆盖新数据)");
        assert.deepStrictEqual(await readSelectionMemory("colcon.build"), { picked: [5], custom: "new" });
    });

    it("旧文件不存在 → 幂等无操作;迁移可重复调用", async () => {
        await migrateLegacyStateFile(root);
        await migrateLegacyStateFile(root);
        assert.deepStrictEqual(await readStateFile(), {});
    });
});

describe("build/ build-memory(构建记忆)", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rde-build-memory-"));
        setStateStorageRoot(root);
    });

    afterEach(async () => {
        setStateStorageRoot(undefined);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it("无状态文件 → 默认值(空列表;参数选择已归 share/selection-memory)", async () => {
        assert.deepStrictEqual(await readBuildState(), { buildPackages: [], knownPackages: [] });
    });

    it("写入后读回一致(往返)", async () => {
        const state = { buildPackages: ["a", "b"], knownPackages: ["a", "b", "c"] };
        await writeBuildState(state);
        assert.deepStrictEqual(await readBuildState(), state);
    });

    it("旧状态文件缺 knownPackages / 字段类型不对 → 逐字段归一", async () => {
        const filePath = getStateFilePath();
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify({ buildConfig: 123, buildPackages: "not-an-array" }), "utf-8");
        assert.deepStrictEqual(await readBuildState(), { buildPackages: [], knownPackages: [] });
    });

    it("写构建记忆不动其它域字段(字段隔离场景;含选择记忆模块的槽)", async () => {
        await updateStateFile((draft) => {
            draft.sampleField = { k: 9 };
            draft.selectionMemory = { "colcon.build": { picked: [1], custom: "x" } };
        });
        await writeBuildState({ buildPackages: [], knownPackages: [] });
        const state = await readStateFile();
        assert.deepStrictEqual(state.sampleField, { k: 9 });
        assert.deepStrictEqual(state.selectionMemory, { "colcon.build": { picked: [1], custom: "x" } });
    });
});

/**
 * 多写者共存(2026-09-22 补:用户指出"这个文件本身就有人写"):
 * 本文件是**多域共用**的,当前写者有 build-memory(包选择)与 share/selection-memory(参数选择,按命令 id 分槽),
 * 将来 run/launch 也走后者。下面用真实读写验证"各写各的、谁都不会把谁覆盖掉"。
 */
describe("state/ 多写者共存(同队列 + 只改自己字段)", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rde-state-multiwriter-"));
        setStateStorageRoot(root);
    });

    afterEach(async () => {
        setStateStorageRoot(undefined);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it("顺序写:包记忆 → 参数记忆(两条命令)→ 三方字段全在", async () => {
        await writeBuildState({ buildPackages: ["pkg_a"], knownPackages: ["pkg_a", "pkg_b"] });
        await writeSelectionMemory("colcon.build", { picked: [0], custom: "a" });
        await writeSelectionMemory("ros2.run", { picked: [1], custom: "b" });

        assert.deepStrictEqual(await readBuildState(), { buildPackages: ["pkg_a"], knownPackages: ["pkg_a", "pkg_b"] });
        assert.deepStrictEqual(await readSelectionMemory("colcon.build"), { picked: [0], custom: "a" });
        assert.deepStrictEqual(await readSelectionMemory("ros2.run"), { picked: [1], custom: "b" });
    });

    it("并发写(三个写者同时发起)→ 谁都不丢(单写者队列)", async () => {
        await Promise.all([
            writeBuildState({ buildPackages: ["p1", "p2"], knownPackages: ["p1", "p2"] }),
            writeSelectionMemory("colcon.build", { picked: [0, 1], custom: "--force" }),
            writeSelectionMemory("ros2.launch", { picked: [2], custom: "" }),
        ]);

        assert.deepStrictEqual(await readBuildState(), { buildPackages: ["p1", "p2"], knownPackages: ["p1", "p2"] });
        assert.deepStrictEqual(await readSelectionMemory("colcon.build"), { picked: [0, 1], custom: "--force" });
        assert.deepStrictEqual(await readSelectionMemory("ros2.launch"), { picked: [2], custom: "" });
    });

    it("反复交叉写(模拟多次交互)→ 两条记忆始终互不干扰", async () => {
        for (let i = 0; i < 3; i++) {
            await writeBuildState({ buildPackages: [`pkg_${i}`], knownPackages: [`pkg_${i}`] });
            await writeSelectionMemory("colcon.build", { picked: [i], custom: `run-${i}` });
        }
        assert.deepStrictEqual(await readBuildState(), { buildPackages: ["pkg_2"], knownPackages: ["pkg_2"] });
        assert.deepStrictEqual(await readSelectionMemory("colcon.build"), { picked: [2], custom: "run-2" });
    });
});
// 修改时间:2026-09-08 23:09(示例字段 includeBlacklist → sampleField,与已移除的黑名单机制解耦)
// 修改时间:2026-10-21(状态文件「转入地下」随改:存储根经 setStateStorageRoot 注入/afterEach 清除;
// API 去 workspaceRoot 化;.tmp 残留断言改存储根;+4 迁移用例:有内容/损坏/新位置已存在跳过/幂等)
