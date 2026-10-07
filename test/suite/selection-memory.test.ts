// Licensed under the MIT License.

/**
 * @file selection-memory.test.ts
 * 通用「选择记忆」模块的无头单测(零 vscode;真实读写临时工作区下的 `.vscode/ros2-dev-extension-state.json`)。
 *
 * 无头可跑:`npm run test-compile && npx mocha out/test/suite/selection-memory.test.js`
 *
 * 覆盖:① 只记"选择"(预设下标 + 自定义输入的**完整原文**);② 归一化(非法项/去重/升序/类型容错);
 *      ③ **按命令 id 分槽**(写一条不动另一条);④ 与其它写者字段共存不互相覆盖;⑤ 读不到 → 空记忆。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
    emptySelectionMemory,
    normalizeSelectionMemory,
    readAllSelectionMemory,
    readSelectionMemory,
    SELECTION_MEMORY_FIELD,
    writeSelectionMemory,
} from "../../src/build-tool/package-service/share/selection-memory";
import { getStateFilePath, readStateFile, updateStateFile } from "../../src/build-tool/package-service/share/state-file";

const BUILD_ID = "colcon.build";
const RUN_ID = "ros2.run";

describe("selection-memory:归一化(纯函数)", () => {
    it("非对象 / 数组 / null → 空记忆", () => {
        assert.deepStrictEqual(normalizeSelectionMemory(undefined), emptySelectionMemory());
        assert.deepStrictEqual(normalizeSelectionMemory(null), emptySelectionMemory());
        assert.deepStrictEqual(normalizeSelectionMemory(42), emptySelectionMemory());
        assert.deepStrictEqual(normalizeSelectionMemory("x"), emptySelectionMemory());
        assert.deepStrictEqual(normalizeSelectionMemory([1, 2]), emptySelectionMemory());
    });

    it("picked:丢弃非整数/负数,去重并升序;custom:非字符串 → 空串", () => {
        assert.deepStrictEqual(
            normalizeSelectionMemory({ picked: [2, "x", -1, 0, 2, 1.5, 3], custom: 42 }),
            { picked: [0, 2, 3], custom: "" },
        );
    });

    it("custom 原样保留(不 trim、不截断)", () => {
        const raw = "  --cmake-args -DCMAKE_BUILD_TYPE=Debug  ";
        assert.strictEqual(normalizeSelectionMemory({ picked: [], custom: raw }).custom, raw);
    });

    it("emptySelectionMemory 每次返回新对象(不被就地改坏)", () => {
        const a = emptySelectionMemory();
        a.picked.push(9);
        assert.deepStrictEqual(emptySelectionMemory().picked, []);
    });
});

describe("selection-memory:读写(复用工作区状态文件)", () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rde-selection-memory-"));
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it("无状态文件 → 空记忆(不抛错)", async () => {
        assert.deepStrictEqual(await readSelectionMemory(root, BUILD_ID), { picked: [], custom: "" });
        assert.deepStrictEqual(await readAllSelectionMemory(root), {});
    });

    it("写入后读回一致(往返;自定义输入保持完整原文)", async () => {
        const memory = { picked: [1, 0], custom: '--install-base "/tmp/a b"' };
        await writeSelectionMemory(root, BUILD_ID, memory);
        assert.deepStrictEqual(await readSelectionMemory(root, BUILD_ID), {
            picked: [0, 1],                       // 写入时已归一化(升序)
            custom: '--install-base "/tmp/a b"',
        });
    });

    it("**按命令 id 分槽**:写另一条命令不动本条", async () => {
        await writeSelectionMemory(root, BUILD_ID, { picked: [0], custom: "a" });
        await writeSelectionMemory(root, RUN_ID, { picked: [2], custom: "b" });
        assert.deepStrictEqual(await readSelectionMemory(root, BUILD_ID), { picked: [0], custom: "a" });
        assert.deepStrictEqual(await readSelectionMemory(root, RUN_ID), { picked: [2], custom: "b" });
        assert.deepStrictEqual(await readAllSelectionMemory(root), {
            [BUILD_ID]: { picked: [0], custom: "a" },
            [RUN_ID]: { picked: [2], custom: "b" },
        });
    });

    it("覆盖同一条命令 = 整条替换(旧的 custom 不会残留)", async () => {
        await writeSelectionMemory(root, BUILD_ID, { picked: [0, 1], custom: "old" });
        await writeSelectionMemory(root, BUILD_ID, { picked: [], custom: "" });
        assert.deepStrictEqual(await readSelectionMemory(root, BUILD_ID), { picked: [], custom: "" });
    });

    it("与其它写者字段共存:写记忆不动别人,别人写也不动记忆", async () => {
        await updateStateFile(root, (draft) => { draft.sampleField = { k: 1 }; });
        await writeSelectionMemory(root, BUILD_ID, { picked: [1], custom: "x" });
        let state = await readStateFile(root);
        assert.deepStrictEqual(state.sampleField, { k: 1 });
        assert.deepStrictEqual(state[SELECTION_MEMORY_FIELD], { [BUILD_ID]: { picked: [1], custom: "x" } });

        await updateStateFile(root, (draft) => { draft.otherField = "y"; });
        state = await readStateFile(root);
        assert.strictEqual(state.otherField, "y");
        assert.deepStrictEqual(await readSelectionMemory(root, BUILD_ID), { picked: [1], custom: "x" });
    });

    it("状态文件里的槽是坏形状(字符串/数组/条目非对象)→ 按空/已归一化处理,不抛错", async () => {
        const filePath = getStateFilePath(root);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify({ selectionMemory: "not-an-object" }), "utf-8");
        assert.deepStrictEqual(await readSelectionMemory(root, BUILD_ID), { picked: [], custom: "" });

        await fs.promises.writeFile(
            filePath,
            JSON.stringify({ selectionMemory: { [BUILD_ID]: { picked: [3, "x", -1], custom: 7 }, [RUN_ID]: "bad" } }),
            "utf-8",
        );
        assert.deepStrictEqual(await readSelectionMemory(root, BUILD_ID), { picked: [3], custom: "" });
        assert.deepStrictEqual(await readSelectionMemory(root, RUN_ID), { picked: [], custom: "" });
    });

    it("并发写两条命令 → 两条都在(单写者队列不丢字段)", async () => {
        await Promise.all([
            writeSelectionMemory(root, BUILD_ID, { picked: [0], custom: "a" }),
            writeSelectionMemory(root, RUN_ID, { picked: [1], custom: "b" }),
        ]);
        assert.deepStrictEqual(await readSelectionMemory(root, BUILD_ID), { picked: [0], custom: "a" });
        assert.deepStrictEqual(await readSelectionMemory(root, RUN_ID), { picked: [1], custom: "b" });
    });
});
