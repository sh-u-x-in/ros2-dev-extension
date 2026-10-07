/**
 * state/ 通用状态文件层测试(2026-08-31 随"通用层上提 + 并发/原子写"落地补齐)。
 * 重点回归:多写者并发不互相覆盖(单写者队列)、损坏/缺字段容错、无临时文件残留。
 * 零 vscode 依赖(纯 fs),但仍随扩展宿主 mocha 一并运行。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { getStateFilePath, readStateFile, updateStateFile } from "../../src/build-tool/package-service/share/state-file";
import { readSelectionMemory, writeSelectionMemory } from "../../src/build-tool/package-service/share/selection-memory";
import { readBuildState, writeBuildState } from "../../src/build-tool/package-service/share/build-memory";

describe("state/ state-file(工作区状态文件通用层)", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rde-state-"));
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it("文件不存在 → 返回空对象(不抛)", async () => {
        assert.deepStrictEqual(await readStateFile(root), {});
    });

    it("文件损坏 / 顶层非对象 → 返回空对象", async () => {
        const filePath = getStateFilePath(root);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, "{ 半截 JSON", "utf-8");
        assert.deepStrictEqual(await readStateFile(root), {});
        await fs.promises.writeFile(filePath, "[1,2,3]", "utf-8");
        assert.deepStrictEqual(await readStateFile(root), {});
    });

    it("updateStateFile 只改自己的字段,其它域字段原样保留", async () => {
        await updateStateFile(root, (draft) => { draft.sampleField = { k: 0 }; });
        await updateStateFile(root, (draft) => { draft.otherField = "Debug-详细"; });
        const state = await readStateFile(root);
        assert.deepStrictEqual(state.sampleField, { k: 0 });
        assert.strictEqual(state.otherField, "Debug-详细");
    });

    it("并发写不丢字段(单写者队列:A读→B读→A写→B写 的覆盖场景)", async () => {
        await Promise.all([
            updateStateFile(root, (draft) => { draft.otherField = "Release-默认"; }),
            updateStateFile(root, (draft) => { draft.sampleField = { k: 1 }; }),
            updateStateFile(root, (draft) => { draft.buildPackages = ["pkg_a"]; }),
        ]);
        const state = await readStateFile(root);
        assert.strictEqual(state.otherField, "Release-默认");
        assert.deepStrictEqual(state.buildPackages, ["pkg_a"]);
        assert.deepStrictEqual(state.sampleField, { k: 1 });
    });

    it("并发写后文件仍是合法 JSON 且无 .tmp 残留(原子覆盖)", async () => {
        await Promise.all([
            writeBuildState(root, { buildPackages: ["p1"], knownPackages: ["p1", "p2"] }),
            updateStateFile(root, (draft) => { draft.sampleField = { k: 0 }; }),
        ]);
        const raw = await fs.promises.readFile(getStateFilePath(root), "utf-8");
        assert.doesNotThrow(() => JSON.parse(raw));
        const leftovers = (await fs.promises.readdir(path.join(root, ".vscode"))).filter(f => f.endsWith(".tmp"));
        assert.deepStrictEqual(leftovers, []);
    });
});

describe("build/ build-memory(构建记忆)", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rde-build-memory-"));
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it("无状态文件 → 默认值(空列表;参数选择已归 share/selection-memory)", async () => {
        assert.deepStrictEqual(await readBuildState(root), { buildPackages: [], knownPackages: [] });
    });

    it("写入后读回一致(往返)", async () => {
        const state = { buildPackages: ["a", "b"], knownPackages: ["a", "b", "c"] };
        await writeBuildState(root, state);
        assert.deepStrictEqual(await readBuildState(root), state);
    });

    it("旧状态文件缺 knownPackages / 字段类型不对 → 逐字段归一", async () => {
        const filePath = getStateFilePath(root);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify({ buildConfig: 123, buildPackages: "not-an-array" }), "utf-8");
        assert.deepStrictEqual(await readBuildState(root), { buildPackages: [], knownPackages: [] });
    });

    it("写构建记忆不动其它域字段(字段隔离场景;含选择记忆模块的槽)", async () => {
        await updateStateFile(root, (draft) => {
            draft.sampleField = { k: 9 };
            draft.selectionMemory = { "colcon.build": { picked: [1], custom: "x" } };
        });
        await writeBuildState(root, { buildPackages: [], knownPackages: [] });
        const state = await readStateFile(root);
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
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it("顺序写:包记忆 → 参数记忆(两条命令)→ 三方字段全在", async () => {
        await writeBuildState(root, { buildPackages: ["pkg_a"], knownPackages: ["pkg_a", "pkg_b"] });
        await writeSelectionMemory(root, "colcon.build", { picked: [0], custom: "a" });
        await writeSelectionMemory(root, "ros2.run", { picked: [1], custom: "b" });

        assert.deepStrictEqual(await readBuildState(root), { buildPackages: ["pkg_a"], knownPackages: ["pkg_a", "pkg_b"] });
        assert.deepStrictEqual(await readSelectionMemory(root, "colcon.build"), { picked: [0], custom: "a" });
        assert.deepStrictEqual(await readSelectionMemory(root, "ros2.run"), { picked: [1], custom: "b" });
    });

    it("并发写(三个写者同时发起)→ 谁都不丢(单写者队列)", async () => {
        await Promise.all([
            writeBuildState(root, { buildPackages: ["p1", "p2"], knownPackages: ["p1", "p2"] }),
            writeSelectionMemory(root, "colcon.build", { picked: [0, 1], custom: "--force" }),
            writeSelectionMemory(root, "ros2.launch", { picked: [2], custom: "" }),
        ]);

        assert.deepStrictEqual(await readBuildState(root), { buildPackages: ["p1", "p2"], knownPackages: ["p1", "p2"] });
        assert.deepStrictEqual(await readSelectionMemory(root, "colcon.build"), { picked: [0, 1], custom: "--force" });
        assert.deepStrictEqual(await readSelectionMemory(root, "ros2.launch"), { picked: [2], custom: "" });
    });

    it("反复交叉写(模拟多次交互)→ 两条记忆始终互不干扰", async () => {
        for (let i = 0; i < 3; i++) {
            await writeBuildState(root, { buildPackages: [`pkg_${i}`], knownPackages: [`pkg_${i}`] });
            await writeSelectionMemory(root, "colcon.build", { picked: [i], custom: `run-${i}` });
        }
        assert.deepStrictEqual(await readBuildState(root), { buildPackages: ["pkg_2"], knownPackages: ["pkg_2"] });
        assert.deepStrictEqual(await readSelectionMemory(root, "colcon.build"), { picked: [2], custom: "run-2" });
    });
});
// 修改时间:2026-09-08 23:09(示例字段 includeBlacklist → sampleField,与已移除的黑名单机制解耦)
