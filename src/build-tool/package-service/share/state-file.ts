// Licensed under the MIT License.

/**
 * @file state-file.ts(2026-08-31 23:55 自 build/state-file.ts git mv 上提:通用文件层不该住在 build 域内——
 *   否则 config/ 域取黑名单要横向 import build/,还得把与构建无关的读写塞进 build/index.ts 公共出口)。
 * 扩展状态文件的【唯一读写入口】,package-service 三域共用的基础设施。
 *
 * ── 落点(2026-10-21 用户裁定「转入地下」)─────────────────────────
 * 状态文件从工作区 `.vscode/ros2-dev-extension-state.json` 迁入**扩展私有存储**
 * (`context.storageUri`,VS Code 按工作区隔离、用户在工作区里不可见,镜像 rosmsg 域
 * workspace-index 的 storageUri 先例):工作区 `.vscode/` 从此只剩给其它工具消费的产物
 * (c_cpp_properties.json / .clangd / settings.json),不再有扩展自己的状态文件。
 * 组合根 activate 时 `setStateStorageRoot()` 装配一次,并进行**一次性迁移**:
 * 旧 `.vscode/` 文件存在且新位置还没有文件 ⇒ 容忍解析读出 → 写入新位置 → 删除旧文件
 * (解析失败 = 空状态照迁 + warn 留痕,无效残留无保留价值);新位置已有文件 ⇒ 跳过(幂等)。
 * 未装配(无头/极端环境)⇒ 读恒空、写静默丢弃(状态记忆本就不应影响业务)。
 *
 * ⚠️ 并发保证(2026-08-31 自废弃 build-env-utils.ts 的 P5/P6 设计恢复,历史见 git):
 *   ① **单写者**:同一状态文件的写操作经 Promise 链串行化,杜绝多写者交错
 *      (A读→B读→A写→B写)导致的字段互相覆盖——本文件从"构建记忆"独占升级为多域共用后必需;
 *   ② **原子覆盖**:先写同目录临时文件再 rename 替换,进程被杀不会留下半截 JSON
 *      (半截 JSON 会被 readStateFile 判为损坏 → 返回 {} → 全部状态静默清零)。
 *   为此不导出整文件覆盖式 write:唯一写入口是 updateStateFile(读-改-写全在锁内)。
 *
 * 📋 字段所有者表(新增字段务必登记,防跨域撞键;详见本目录 README.md):
 *   | buildPackages / knownPackages  | share/build-memory.ts(包选择记忆) |
 *   | selectionMemory                | share/selection-memory.ts(二级参数的选择记忆;形状是 "命令 id → {picked,custom}",
 *   |                               |  同一字段内再按命令分槽 ⇒ 将来 run/launch 复用同一模块时不会互相覆盖) |
 *   (开发期不留历史包袱:不再读写的键只是"没人再读的键",本层不做任何键级迁移代码)
 */

import { l10n } from "vscode";

import { getLogger } from "../../../logger";
import * as fs from "fs";
import * as path from "path";

/** 扩展日志薄封装(带 state-file 模块前缀) */
const log = getLogger("state-file");

/** 状态文件名(扩展私有存储内) */
const STATE_FILE_NAME = "ros2-dev-extension-state.json";

/** 旧落点(2026-10-21 前:工作区 .vscode/ 下;仅一次性迁移读取用) */
const LEGACY_RELATIVE_PATH = path.join(".vscode", STATE_FILE_NAME);

/** 状态文件内容形状:顶层是"字段名 → 各域自有数据"的开放字典(所有者见文件头表) */
export type StateFileData = Record<string, unknown>;

/** 扩展私有存储根(context.storageUri.fsPath;activate 装配一次) */
let stateStorageRoot: string | undefined;

/**
 * 装配状态存储根(组合根 activate 调一次;undefined = 清除,无头测试用)。
 * 未装配 ⇒ 读恒空、写静默丢弃(状态记忆丢失不应影响调用方业务)。
 */
export function setStateStorageRoot(dir: string | undefined): void {
    stateStorageRoot = dir;
}

/** 状态文件解析后路径(未装配 ⇒ 空串) */
export function getStateFilePath(): string {
    return stateStorageRoot ? path.join(stateStorageRoot, STATE_FILE_NAME) : "";
}

/** 装配了吗 */
function isConfigured(): boolean {
    return stateStorageRoot !== undefined;
}

/**
 * 读取状态文件全文(JSON 对象);未装配 / 不存在 / 损坏 / 顶层非对象时一律返回空对象。
 * 只读操作不排队(读不会破坏他人字段),各域应只取自己那几个字段并自行做形状校验。
 */
export async function readStateFile(): Promise<StateFileData> {
    if (!isConfigured()) {
        return {};
    }
    try {
        log.trace(l10n.t("Reading state file: {0}", getStateFilePath()));
        const content = await fs.promises.readFile(getStateFilePath(), "utf-8");
        const parsed: unknown = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            log.debug("State file top level is not an object; treating as empty");
            return {};
        }
        return parsed as StateFileData;
    } catch {
        // 文件不存在或损坏:吞错返回空对象(调用方各自回退默认值)
        log.debug("State file missing or corrupt; returning empty object");
        return {};
    }
}

/**
 * 写者串行化链(key = 解析后的状态文件路径):任何时刻同一文件只有一个写者。
 * 排空后自动清理映射,避免长期驻留(长会话)。
 */
const writeChains = new Map<string, Promise<unknown>>();

/** 把写任务追加到该文件的写队列尾部(前序任务失败不阻断后续)。 */
function enqueueWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const previous = writeChains.get(filePath) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail: Promise<unknown> = run.then(() => undefined, () => undefined);
    writeChains.set(filePath, tail);
    void tail.then(() => {
        if (writeChains.get(filePath) === tail) {
            writeChains.delete(filePath);
        }
    });
    return run;
}

/**
 * 原子写入:同目录临时文件 + rename 替换。
 * rename 在同目录下为原子操作(Windows 由 Node 经 MoveFileEx 覆盖同名文件);
 * 个别远程/网络文件系统不支持 rename 覆盖时回退直写(牺牲原子性保功能)。
 * 写失败静默降级(状态记忆丢失不应影响调用方业务)。
 */
async function writeStateFileAtomic(data: StateFileData): Promise<void> {
    const filePath = getStateFilePath();
    const tempPath = `${filePath}.${process.pid}.tmp`;
    const content = JSON.stringify(data, null, 2);
    try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(tempPath, content, "utf-8");
        await fs.promises.rename(tempPath, filePath);
        log.debug(l10n.t("State file written (atomic): {0}", filePath));
        return;
    } catch (error) {
        log.debug(l10n.t("Atomic write failed; falling back to direct write: {0}", error instanceof Error ? error.message : String(error)));
        // 清理可能残留的临时文件(失败忽略:临时文件残留不影响正确性)
        try {
            await fs.promises.unlink(tempPath);
        } catch {
            // ignore
        }
    }
    try {
        await fs.promises.writeFile(filePath, content, "utf-8");
        log.debug(l10n.t("State file written (direct): {0}", filePath));
    } catch {
        // 写失败降级,不影响调用方
        log.debug("State file write failed; silently degraded");
    }
}

/**
 * 更新状态文件(唯一写入口):在写队列内完成"读 → 改 → 原子写"。
 * mutate 收到的是本次读到的全文草稿,**只应改自己拥有的字段**(所有者见文件头表);
 * 其余字段原样保留,因此多域并发更新互不覆盖。
 * 未装配 ⇒ 静默丢弃;I/O 失败静默降级;mutate 自身抛错会向调用方传播(那是编程错误,不该被吞)。
 */
export async function updateStateFile(mutate: (draft: StateFileData) => void): Promise<void> {
    if (!isConfigured()) {
        log.debug("State storage not configured; write dropped");
        return;
    }
    await enqueueWrite(getStateFilePath(), async () => {
        const draft = await readStateFile();
        mutate(draft);
        await writeStateFileAtomic(draft);
    });
}

/**
 * 一次性迁移(2026-10-21「转入地下」):旧工作区 `.vscode/ros2-dev-extension-state.json`
 * → 扩展私有存储。新位置已有文件 ⇒ 跳过(不覆盖新数据,幂等);旧文件不存在 ⇒ 无操作;
 * 旧文件解析失败 ⇒ 按空状态照迁 + warn 留痕。迁移写入成功后删除旧文件(转入地下的本意;
 * 删除失败只 warn——旧文件残留会被下一次迁移重试清理)。
 */
export async function migrateLegacyStateFile(workspaceRoot: string | undefined): Promise<void> {
    if (!isConfigured() || !workspaceRoot) {
        return;
    }
    const newPath = getStateFilePath();
    const legacyPath = path.join(workspaceRoot, LEGACY_RELATIVE_PATH);
    let legacyRaw: string | undefined;
    try {
        legacyRaw = await fs.promises.readFile(legacyPath, "utf-8");
    } catch {
        return; // 旧文件不存在 ⇒ 无迁移
    }
    let legacyData: StateFileData = {};
    let corrupt = false;
    try {
        const parsed: unknown = JSON.parse(legacyRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            legacyData = parsed as StateFileData;
        } else {
            corrupt = true;
        }
    } catch {
        corrupt = true;
    }
    if (corrupt) {
        log.warn(l10n.t("Legacy state file is corrupt; migrating an empty state: {0}", legacyPath));
    }
    const migrated = await enqueueWrite(newPath, async (): Promise<boolean> => {
        // 双检:迁移排队期间新文件已被写入(首启竞态)⇒ 跳过(不覆盖新数据,旧文件也保留)
        let exists = false;
        try {
            await fs.promises.access(newPath);
            exists = true;
        } catch {
            // ignore
        }
        if (exists) {
            return false;
        }
        await writeStateFileAtomic(legacyData);
        return true;
    });
    if (!migrated) {
        return; // 跳过迁移 ⇒ 旧文件保留(新数据不覆盖的对称承诺)
    }
    try {
        await fs.promises.unlink(legacyPath);
        log.info(l10n.t("State file migrated to extension storage: {0} -> {1}", legacyPath, newPath));
    } catch (error) {
        log.warn(l10n.t("Failed to remove the migrated legacy state file: {0}", error instanceof Error ? error.message : String(error)));
    }
}
