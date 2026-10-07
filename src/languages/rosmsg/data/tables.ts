// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file tables.ts
 * rosmsg 三张表 + 四个事件 + op 流（`手工重设计/rosmsg-v3.md` 的落地）。
 * 纯 TS、零 vscode 依赖、可无头表驱动测试。
 *
 * ── 写线（IndexWriter）持有三张表 ──
 *   ① 正表  包名 → [[消息名, 消息路径]...]（外层按包名升序；内层按消息名升序）
 *   ② 反表  [消息路径, 包名]（按路径升序；点查 = 二分，前缀扫 = lowerBound + 向扫）
 *   ③ 包表  哈希双键：目录（带尾分隔符）→ 名 / 名 → 目录。
 *            两类键永不碰撞（ROS 包名不含路径分隔符）⇒ 一次哈希、双向 O(1)。
 *
 * ── 读线（IndexReader）持有两张表（正表 + 反表）──
 *   写线那份是权威，读线那份是副本，两者只通过 op 消息同步（见 rosmsg-v3.md §2）。
 *   运行期：事件 → 写线改表 → 一组 op → 读线 apply。
 *   基线装载（初始化/缓存恢复/大重建）：语义上等价于"全量 op 组同步应用一次"，
 *   实现为整表批替换（避免逐条 splice 的 O(N²) 代价）。
 *
 * ── 四个事件（都发生在写线；每处理完一个事件输出一组 op；发送边界 = 单个事件）──
 *   消息删除 / 消息增加 / 删除包（包级继承）/ 新增包（反表前缀扫 + 判子包 + 认领）。
 *
 * ── 归属判定 ──
 *   从文件父目录逐级向上剥，拿每一层目录查包表，第一次命中即停（= 最长匹配）；
 *   全不命中 → 哨兵「非法包」LOOSE_PKG（没有路径、不在包表，导出全部寄存在它的正表行里）。
 *
 * 纪律（v3 §2.4 / §3.4）：
 *   ① 一切目录比较统一走 dirKey()（归一化 + 尾分隔符，同一套口径）；
 *   ② 换包必须先摘后挂（任何瞬间不会出现一个导出同时挂在两个包下）；
 *   ③ 新增包在事件【开始前】进包表、删除包在事件【收尾时】出包表（判定与顺序无关，保持文档纪律）。
 */

import * as path from "path";

/** 归属哨兵：不属于任何包的导出（非法包）。`<` `>` 不在 ROS 包名字符集内，绝不与真实包名碰撞 */
export const LOOSE_PKG = "<loose>";

/** 单条消息（正表二级条目）；路径即身份，name 仅为显示/查询键 */
export interface MsgRow {
    name: string;
    path: string;
}

/** 正表行：包 → 该包条目数组（按消息名升序；同名按路径升序稳定） */
export interface PkgRow {
    pkg: string;
    entries: MsgRow[];
}

/** 反表行：路径 → 当前包名（按路径升序） */
export interface PathRow {
    path: string;
    pkg: string;
}

/** 两张表的值快照（读线/写线之间传递用） */
export interface TablesSnapshot {
    pkgRows: PkgRow[];
    pathRows: PathRow[];
}

/** op：写线发给读线的变更指令（add 挂载 / remove 卸载）。发送边界 = 单个事件 */
export type IndexOp =
    | { kind: "add"; path: string; pkg: string }
    | { kind: "remove"; path: string };

/* ──────────────────────────── 工具 ──────────────────────────── */

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpMsg = (a: MsgRow, b: MsgRow): number => cmpStr(a.name, b.name) || cmpStr(a.path, b.path);

/** 目录键：归一化 + 统一带尾分隔符（包表键、祖先链每层、前缀扫 prefix 的同一口径，纪律①） */
export function dirKey(dir: string): string {
    const n = path.normalize(dir);
    return n.endsWith(path.sep) ? n : n + path.sep;
}

/** 文件路径归一化（比较键统一形态） */
export function normFile(p: string): string {
    return path.normalize(p);
}

/** 二分：返回第一个「不小于目标」的下标（less(item) = item < 目标） */
function lowerBound<T>(arr: readonly T[], less: (item: T) => boolean): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (less(arr[mid])) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/** 找正表行下标（-1 = 无） */
function rowIdx(rows: readonly PkgRow[], pkg: string): number {
    const i = lowerBound(rows, (r) => cmpStr(r.pkg, pkg) < 0);
    return i < rows.length && rows[i].pkg === pkg ? i : -1;
}

/** 找反表行下标（按路径；-1 = 无） */
function pathIdx(rows: readonly PathRow[], p: string): number {
    const i = lowerBound(rows, (r) => cmpStr(r.path, p) < 0);
    return i < rows.length && rows[i].path === p ? i : -1;
}

/** 行内插入条目（按 cmpMsg 有序；调用方保证 path 不重复） */
function insertMsg(entries: MsgRow[], m: MsgRow): void {
    const i = lowerBound(entries, (x) => cmpMsg(x, m) < 0);
    entries.splice(i, 0, m);
}

/** 行内删除条目（同名块内按路径精确匹配,同名多路径也稳定;删空之外由调用方决定是否清行） */
function removeMsg(entries: MsgRow[], m: MsgRow): boolean {
    let i = lowerBound(entries, (x) => cmpStr(x.name, m.name) < 0);
    for (; i < entries.length && entries[i].name === m.name; i++) {
        if (entries[i].path === m.path) {
            entries.splice(i, 1);
            return true;
        }
    }
    return false;
}

/** 两个按 cmpMsg 升序的数组归并（稳定；供删除包的「整条数组一次性交给接住者」用） */
function mergeSorted(a: readonly MsgRow[], b: readonly MsgRow[]): MsgRow[] {
    const out: MsgRow[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (cmpMsg(a[i], b[j]) <= 0) {
            out.push(a[i++]);
        } else {
            out.push(b[j++]);
        }
    }
    while (i < a.length) {
        out.push(a[i++]);
    }
    while (j < b.length) {
        out.push(b[j++]);
    }
    return out;
}

/* ──────────────────────────── 写线：三张表 ──────────────────────────── */

/**
 * 写线（三张表）：正表 + 反表 + 包表。
 * 所有事件处理完，把本事件产生的一组 op 交给 emit（组装方接读线 apply）。
 */
export class IndexWriter {
    private pkgRowsArr: PkgRow[] = [];
    private pathRowsArr: PathRow[] = [];
    /** 包表：目录键 → 名、名 → 目录键（两类键永不碰撞） */
    private readonly pkgTable = new Map<string, string>();

    /** @param emit op 发送口（写线 → 读线；组装方注入） */
    constructor(private readonly emit: (ops: IndexOp[]) => void) { }

    /* ---------- 基线：包表（只在初始化时调用；运行期一律走 add/removePackage 事件） ---------- */

    /** 用工作区全量包目录重置包表（初始化基线；形态与 PackageSource R1 一致）。不重分类存量条目——存量分类由随后的全量重建裁定 */
    setPackages(entries: ReadonlyArray<{ name: string; dir: string }>): void {
        this.pkgTable.clear();
        for (const e of entries) {
            const key = dirKey(e.dir);
            this.pkgTable.set(key, e.name);
            this.pkgTable.set(e.name, key);
        }
    }

    /* ---------- 归属判定（枚举祖先链，最长匹配） ---------- */

    /** 文件路径 → 包名；全不命中 → LOOSE_PKG */
    resolveOwner(filePath: string): string {
        let cur = dirKey(path.dirname(normFile(filePath)));
        for (; ;) {
            const name = this.pkgTable.get(cur);
            if (name !== undefined) {
                return name;
            }
            const parent = path.dirname(cur);
            const parentKey = dirKey(parent);
            if (parentKey === cur) {
                return LOOSE_PKG; // 到根仍未命中（含根自身查过）
            }
            cur = parentKey;
        }
    }

    /* ---------- 四个事件 ---------- */

    /**
     * 消息删除（v3 §4.1）：反表点查 → 未命中 = 迟到删除，天生幂等（no-op）；
     * 命中 → 删正表条目 + 删反表条目（复用同一路径）。
     */
    removeMessage(filePath: string): void {
        const p = normFile(filePath);
        const i = pathIdx(this.pathRowsArr, p);
        if (i < 0) {
            return; // 迟到删除 → no-op
        }
        const old = this.pathRowsArr[i];
        this.detach(p, old.pkg);
        this.emit([{ kind: "remove", path: p }]);
    }

    /**
     * 消息增加（v3 §4.2）：归属判定 → 反表点查：
     *   幂等（同路径同包）→ return；换包 → 先摘后挂（一条 op 组带走）；新增 → 直接挂。
     */
    addMessage(filePath: string): void {
        const p = normFile(filePath);
        const pkg = this.resolveOwner(p);
        const name = path.basename(p, path.extname(p));
        const i = pathIdx(this.pathRowsArr, p);
        if (i >= 0) {
            const old = this.pathRowsArr[i];
            if (old.pkg === pkg) {
                return; // 幂等
            }
            this.detach(p, old.pkg);
            this.attach(p, name, pkg);
            this.emit([{ kind: "remove", path: p }, { kind: "add", path: p, pkg }]);
            return;
        }
        this.attach(p, name, pkg);
        this.emit([{ kind: "add", path: p, pkg }]);
    }

    /**
     * 删除包（v3 §4.3，包级继承）：接住者 = 从 B 的【父目录】往上剥、第一次命中即停
     * （从父目录起剥 ⇒ B 不会被查到，顺序不敏感）；正表整条数组一次归并进接住者；
     * 反表前缀连续段整批改第二列；收尾删包表两键。
     */
    removePackage(pkgName: string, pkgDir: string): void {
        const dirK = dirKey(pkgDir);
        // 幂等判定：该目录当前注册的必须是这个名字（改名后 remove 交错到达 / 重复 remove → 跳过）
        if (this.pkgTable.get(dirK) !== pkgName) {
            return;
        }

        // 接住者：B 的祖先里最深的那个包；全不命中 → 非法包
        let catcher = LOOSE_PKG;
        let cur = dirKey(path.dirname(dirK));
        for (; ;) {
            const nm = this.pkgTable.get(cur);
            if (nm !== undefined) {
                catcher = nm;
                break;
            }
            const parent = path.dirname(cur);
            const parentKey = dirKey(parent);
            if (parentKey === cur) {
                break;
            }
            cur = parentKey;
        }

        // 正表：B 的整条数组一次性归并进接住者（m 条一次搬运，不逐条判定）
        const ri = rowIdx(this.pkgRowsArr, pkgName);
        const moving: readonly MsgRow[] = ri >= 0 ? this.pkgRowsArr[ri].entries : [];
        if (ri >= 0) {
            this.pkgRowsArr.splice(ri, 1);
        }
        if (moving.length > 0) {
            const target = this.ensureRow(catcher);
            target.entries = mergeSorted(target.entries, moving);
        }

        // 反表：路径以 "B路径/" 开头的连续一段 → 整批改第二列（路径序不变）。
        // ⚠️ 边界：段内可能混有【更深嵌套包】（如 B 下有 c 包，c 的条目也以 B/ 开头但挂 c 名下）——
        // 只改"本来就挂在 B 名下"的条目；更深包条目保持不动（其归属不因 B 消失而变）。
        const ops: IndexOp[] = [];
        const lo = lowerBound(this.pathRowsArr, (r) => cmpStr(r.path, dirK) < 0);
        let i = lo;
        while (i < this.pathRowsArr.length && this.pathRowsArr[i].path.startsWith(dirK)) {
            const row = this.pathRowsArr[i];
            if (row.pkg === pkgName) {
                row.pkg = catcher;
                ops.push({ kind: "add", path: row.path, pkg: catcher });
            }
            i++;
        }

        // 收尾：B 出包表（纪律③）
        this.pkgTable.delete(dirK);
        this.pkgTable.delete(pkgName);

        if (ops.length > 0) {
            this.emit(ops);
        }
    }

    /**
     * 新增包（v3 §4.4）：反表前缀扫捞候选（每条自带当前包名）→ 判「当前归属是否比新增包更深」：
     *   更深（当前包是新增包的后代）→ 跳过；哨兵/更浅/未注册 → 认领。
     * 顺序无关（v3 已验证：A、B 同时新增，两种顺序结果一致）。
     */
    addPackage(pkgName: string, pkgDir: string): void {
        const dirK = dirKey(pkgDir);
        // 纪律③：新增包在事件开始前进包表。若该目录已注册别的名字（改名后 add 交错到达，
        // 旧 remove 尚未处理）→ 先清旧名键，防包表里名字→目录的错位残留。
        const oldName = this.pkgTable.get(dirK);
        if (oldName !== undefined && oldName !== pkgName) {
            this.pkgTable.delete(oldName);
        }
        this.pkgTable.set(dirK, pkgName);
        this.pkgTable.set(pkgName, dirK);

        // 前缀扫：先收集候选快照（后续 detach/attach 会改动数组，不能边扫边改）
        const lo = lowerBound(this.pathRowsArr, (r) => cmpStr(r.path, dirK) < 0);
        const candidates: PathRow[] = [];
        for (let i = lo; i < this.pathRowsArr.length && this.pathRowsArr[i].path.startsWith(dirK); i++) {
            candidates.push({ ...this.pathRowsArr[i] });
        }
        if (candidates.length === 0) {
            return;
        }

        const ops: IndexOp[] = [];
        for (const cand of candidates) {
            const cur = cand.pkg;
            let claim = false;
            if (cur === LOOSE_PKG) {
                claim = true;
            } else {
                const curDir = this.pkgTable.get(cur); // 名键 → 目录键
                if (curDir === undefined) {
                    claim = true; // 防御：当前归属包不在包表
                } else if (!(curDir.startsWith(dirK) && curDir !== dirK)) {
                    claim = true; // 当前归属【严格更深】（是新增包的后代）才跳过；同目录/更浅/哨兵 → 认领
                }
                // curDir 以 dirK 开头（当前包是新增包的后代）→ 跳过（该归更深的那个包）
            }
            if (!claim) {
                continue;
            }
            this.detach(cand.path, cur);
            this.attach(cand.path, path.basename(cand.path, path.extname(cand.path)), pkgName);
            ops.push({ kind: "add", path: cand.path, pkg: pkgName });
        }
        if (ops.length > 0) {
            this.emit(ops);
        }
    }

    /**
     * 全量重建（60 秒兜底基线 / 首次构建 / 手动重扫）：
     * 按当前包表对全部文件重算归属，与现有反表做差 → 一组 op；随后写线两张表整体替换。
     * （diff 的 op 数可能较大时，组装方以「整表批替换」承接，语义等价于全量 op 组。）
     */
    rebuild(files: readonly string[]): void {
        const next = new Map<string, string>();
        for (const f of files) {
            const p = normFile(f);
            if (!next.has(p)) {
                next.set(p, this.resolveOwner(p));
            }
        }

        const ops: IndexOp[] = [];
        const oldMap = new Map<string, string>();
        for (const r of this.pathRowsArr) {
            oldMap.set(r.path, r.pkg);
        }
        for (const [p, pkg] of next) {
            const oldPkg = oldMap.get(p);
            if (oldPkg === undefined) {
                ops.push({ kind: "add", path: p, pkg });
            } else if (oldPkg !== pkg) {
                // 归属变化：add 的读线实现自带先摘后挂，单条即可
                ops.push({ kind: "add", path: p, pkg });
            }
        }
        for (const p of oldMap.keys()) {
            if (!next.has(p)) {
                ops.push({ kind: "remove", path: p });
            }
        }

        this.buildTables(next);
        if (ops.length > 0) {
            this.emit(ops);
        }
    }

    /* ---------- 基线装载（磁盘缓存恢复；不产生 op，语义 = 基线全量同步） ---------- */

    /** 直接装载两张表（缓存恢复；不 emit——读线由组装方同步装载同一快照） */
    loadBaseline(tables: TablesSnapshot): void {
        this.pkgRowsArr = tables.pkgRows;
        this.pathRowsArr = tables.pathRows;
    }

    /* ---------- 快照（读线基线装载 / 磁盘缓存） ---------- */

    /** 两张表的值快照（深克隆条目数组；读线与写线各自持有独立数组） */
    snapshotTables(): TablesSnapshot {
        return {
            pkgRows: this.pkgRowsArr.map((r) => ({ pkg: r.pkg, entries: r.entries.map((m) => ({ ...m })) })),
            pathRows: this.pathRowsArr.map((r) => ({ ...r })),
        };
    }

    /** 正表行的浅视图（磁盘缓存序列化用；含哨兵行） */
    get pkgRows(): readonly PkgRow[] {
        return this.pkgRowsArr;
    }

    /* ---------- 内部：挂/摘/行维护 ---------- */

    private ensureRow(pkg: string): PkgRow {
        const i = rowIdx(this.pkgRowsArr, pkg);
        if (i >= 0) {
            return this.pkgRowsArr[i];
        }
        const row: PkgRow = { pkg, entries: [] };
        const at = lowerBound(this.pkgRowsArr, (r) => cmpStr(r.pkg, pkg) < 0);
        this.pkgRowsArr.splice(at, 0, row);
        return row;
    }

    /** 挂载：正表条目 + 反表行（调用方保证该路径当前不在表内） */
    private attach(p: string, name: string, pkg: string): void {
        const row = this.ensureRow(pkg);
        insertMsg(row.entries, { name, path: p });
        const at = lowerBound(this.pathRowsArr, (r) => cmpStr(r.path, p) < 0);
        this.pathRowsArr.splice(at, 0, { path: p, pkg });
    }

    /** 摘除：正表条目 + 反表行；行随最后一条目删除（空行不保留——与读线同策略） */
    private detach(p: string, pkg: string): void {
        const ri = rowIdx(this.pkgRowsArr, pkg);
        if (ri >= 0) {
            const row = this.pkgRowsArr[ri];
            removeMsg(row.entries, { name: path.basename(p, path.extname(p)), path: p });
            if (row.entries.length === 0) {
                this.pkgRowsArr.splice(ri, 1);
            }
        }
        const pi = pathIdx(this.pathRowsArr, p);
        if (pi >= 0) {
            this.pathRowsArr.splice(pi, 1);
        }
    }

    /** 由「路径 → 包名」赋值表整体构建两张表（全量重建用） */
    private buildTables(assign: ReadonlyMap<string, string>): void {
        const byPkg = new Map<string, MsgRow[]>();
        const paths: PathRow[] = [];
        for (const [p, pkg] of assign) {
            let list = byPkg.get(pkg);
            if (!list) {
                list = [];
                byPkg.set(pkg, list);
            }
            list.push({ name: path.basename(p, path.extname(p)), path: p });
            paths.push({ path: p, pkg });
        }
        const rows: PkgRow[] = [];
        for (const [pkg, entries] of byPkg) {
            entries.sort(cmpMsg);
            rows.push({ pkg, entries });
        }
        rows.sort((a, b) => cmpStr(a.pkg, b.pkg));
        paths.sort((a, b) => cmpStr(a.path, b.path));
        this.pkgRowsArr = rows;
        this.pathRowsArr = paths;
    }
}

/** 由正表行（缓存载荷形态）重建两张表（含反表）—— 启动装载用 */
export function tablesFromPkgRows(
    rows: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]>
): TablesSnapshot {
    const pkgRows: PkgRow[] = rows.map(([pkg, entries]) => ({
        pkg,
        entries: entries.map(([name, p]) => ({ name, path: p })).sort(cmpMsg),
    }));
    pkgRows.sort((a, b) => cmpStr(a.pkg, b.pkg));
    const pathRows: PathRow[] = [];
    for (const r of pkgRows) {
        for (const m of r.entries) {
            pathRows.push({ path: m.path, pkg: r.pkg });
        }
    }
    pathRows.sort((a, b) => cmpStr(a.path, b.path));
    return { pkgRows, pathRows };
}

/* ──────────────────────────── 读线：两张表 ──────────────────────────── */

/**
 * 读线（正表 + 反表副本）：一切查询落在这里；变化只来自 op（或基线整表替换）。
 * op 应用同步（v3 §4.5）：读线永远停在某个真实发生过的状态上（只旧不错）。
 */
export class IndexReader {
    private pkgRowsArr: PkgRow[] = [];
    private pathRowsArr: PathRow[] = [];
    private loadedFlag = false;

    /** 是否已装载过基线（未装载 = 冷启动，可整表替换） */
    isLoaded(): boolean {
        return this.loadedFlag;
    }

    /** 基线装载：语义 = 全量 op 组同步应用一次（实现为整表批替换，避免逐条 splice） */
    replaceAll(tables: TablesSnapshot): void {
        this.pkgRowsArr = tables.pkgRows;
        this.pathRowsArr = tables.pathRows;
        this.loadedFlag = true;
    }

    /** 应用一组 op（add 先摘后挂；remove 未命中 no-op；幂等） */
    apply(ops: readonly IndexOp[]): void {
        for (const op of ops) {
            if (op.kind === "add") {
                this.applyAdd(op.path, op.pkg);
            } else {
                this.applyRemove(op.path);
            }
        }
        this.loadedFlag = true;
    }

    private applyAdd(p: string, pkg: string): void {
        const i = pathIdx(this.pathRowsArr, p);
        if (i >= 0) {
            const old = this.pathRowsArr[i];
            if (old.pkg === pkg) {
                return; // 幂等
            }
            this.applyRemove(p); // 先摘
        }
        const name = path.basename(p, path.extname(p));
        let row = this.findRow(pkg);
        if (!row) {
            row = { pkg, entries: [] };
            const at = lowerBound(this.pkgRowsArr, (r) => cmpStr(r.pkg, pkg) < 0);
            this.pkgRowsArr.splice(at, 0, row);
        }
        insertMsg(row.entries, { name, path: p });
        const at2 = lowerBound(this.pathRowsArr, (r) => cmpStr(r.path, p) < 0);
        this.pathRowsArr.splice(at2, 0, { path: p, pkg });
    }

    private applyRemove(p: string): void {
        const i = pathIdx(this.pathRowsArr, p);
        if (i < 0) {
            return; // 迟到删除 → no-op
        }
        const old = this.pathRowsArr[i];
        this.pathRowsArr.splice(i, 1);
        const ri = rowIdx(this.pkgRowsArr, old.pkg);
        if (ri >= 0) {
            const row = this.pkgRowsArr[ri];
            removeMsg(row.entries, { name: path.basename(p, path.extname(p)), path: p });
            if (row.entries.length === 0) {
                this.pkgRowsArr.splice(ri, 1); // 空行不保留（与写线 detach/removePackage 同策略）
            }
        }
    }

    private findRow(pkg: string): PkgRow | undefined {
        const i = rowIdx(this.pkgRowsArr, pkg);
        return i >= 0 ? this.pkgRowsArr[i] : undefined;
    }

    /* ---------- 读侧查询 ---------- */

    /** 某包全部条目（副本视图） */
    entriesOf(pkg: string): readonly MsgRow[] {
        return this.findRow(pkg)?.entries ?? [];
    }

    /** 某包某名（同名取第一条；重名不仲裁、只影响补全与诊断） */
    findMessage(pkg: string, name: string): MsgRow | undefined {
        const row = this.findRow(pkg);
        if (!row) {
            return undefined;
        }
        const i = lowerBound(row.entries, (x) => cmpStr(x.name, name) < 0);
        return i < row.entries.length && row.entries[i].name === name ? row.entries[i] : undefined;
    }

    /** 有消息的包名列表（不含非法包；外层有序，天然升序） */
    packageNamesWithMsg(): string[] {
        const out: string[] = [];
        for (const r of this.pkgRowsArr) {
            if (r.pkg !== LOOSE_PKG) {
                out.push(r.pkg);
            }
        }
        return out;
    }

    /**
     * 限定名前缀查询（补全用）：prefix 含分隔符 → 外层扫包名前缀 + 内层 lowerBound；
     * 不含 → 组合名前缀等价于包名前缀（外层扫，行内全取）。
     * 返回带包名的条目列表。
     */
    entriesByQualifiedPrefix(prefix: string): Array<{ pkg: string; name: string; path: string }> {
        const out: Array<{ pkg: string; name: string; path: string }> = [];
        const slash = prefix.indexOf("/");
        const pkgPrefix = slash >= 0 ? prefix.slice(0, slash) : prefix;
        const namePrefix = slash >= 0 ? prefix.slice(slash + 1) : "";

        let i = lowerBound(this.pkgRowsArr, (r) => cmpStr(r.pkg, pkgPrefix) < 0);
        for (; i < this.pkgRowsArr.length && this.pkgRowsArr[i].pkg.startsWith(pkgPrefix); i++) {
            const row = this.pkgRowsArr[i];
            if (row.pkg === LOOSE_PKG) {
                continue; // 非法包无包名前缀语义（由 looseEntriesByPrefix 提供）
            }
            if (namePrefix.length === 0) {
                for (const m of row.entries) {
                    out.push({ pkg: row.pkg, name: m.name, path: m.path });
                }
                continue;
            }
            let j = lowerBound(row.entries, (x) => cmpStr(x.name, namePrefix) < 0);
            for (; j < row.entries.length && row.entries[j].name.startsWith(namePrefix); j++) {
                out.push({ pkg: row.pkg, name: row.entries[j].name, path: row.entries[j].path });
            }
        }
        return out;
    }

    /** 反表点查：路径 → 包名（undefined = 未登记；LOOSE_PKG = 已登记但无归属） */
    ownerOf(filePath: string): string | undefined {
        const i = pathIdx(this.pathRowsArr, normFile(filePath));
        return i >= 0 ? this.pathRowsArr[i].pkg : undefined;
    }

    /** 非法包行内的名前缀查询（补全 L6 用；行内按名有序 → lowerBound + 向扫） */
    looseEntriesByPrefix(prefix: string): MsgRow[] {
        const row = this.findRow(LOOSE_PKG);
        if (!row) {
            return [];
        }
        const out: MsgRow[] = [];
        let i = lowerBound(row.entries, (x) => cmpStr(x.name, prefix) < 0);
        for (; i < row.entries.length && row.entries[i].name.startsWith(prefix); i++) {
            out.push(row.entries[i]);
        }
        return out;
    }

    /** 两张表快照（测试/诊断用） */
    snapshot(): TablesSnapshot {
        return {
            pkgRows: this.pkgRowsArr.map((r) => ({ pkg: r.pkg, entries: r.entries.map((m) => ({ ...m })) })),
            pathRows: this.pathRowsArr.map((r) => ({ ...r })),
        };
    }
}
