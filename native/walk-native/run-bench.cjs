// walk-native 性能对比基准:TS版(walk-utils.ts) vs Rust 三档实现
// 用法: node run-bench.cjs [--quick]
// 前提: ① npm run compile 已生成 out/; ② walk-native release 已编译
const path = require("path");
const { walkWithTimeout } = require(path.join(__dirname, "..", "out", "src", "build-tool", "walk-utils.js"));
const { execFileSync } = require("child_process");

const root = "d:\\VM虚拟机\\virtual_machine\\ros2study\\ros2share\\rde-ros-2";
const EXCLUDED = new Set([
    "node_modules", "out", "build", "install", "log", "logs", "devel",
    "dist", ".git", ".vscode", "test-results", "vsix",
]);
const NATIVE = path.join(__dirname, "target", "release", "walk-native.exe");
const nativeExists = require("fs").existsSync(NATIVE);

function fmt(n, w) { return String(n).padStart(w); }

async function runTS(ms, depth, exclude, pattern, isRegex) {
    const p = isRegex ? new RegExp(pattern) : pattern;
    return await walkWithTimeout(root, p ?? "package.xml", {
        timeLimitMs: ms,
        maxDepth: depth,
        excludedDirNames: exclude ? EXCLUDED : undefined,
        followSymlinks: false,
    });
}

function runNative(ms, depth, exclude, pattern, isRegex, mode, workers) {
    if (!nativeExists) return null;
    const args = [root, pattern ?? "package.xml", String(ms), String(depth)];
    if (isRegex) args.push("--regex");
    if (exclude) args.push("--exclude", [...EXCLUDED].join(","));
    if (mode === "layer") args.push("--parallel");
    if (mode === "branch") {
        args.push("--branch");
        args.push("--workers", String(workers ?? 8));
    }
    args.push("--json");
    const out = execFileSync(NATIVE, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out.trim().split("\n").pop());
}

// 单栏:每场景 3 轮取最快
async function bestOf(modes, ms, depth, exclude, pattern, isRegex) {
    const best = {};
    for (const m of modes) best[m.key] = null;
    for (let k = 0; k < 3; k++) {
        for (const m of modes) {
            const r = m.key === "TS"
                ? await runTS(ms, depth, exclude, pattern, isRegex)
                : runNative(ms, depth, exclude, pattern, isRegex, m.mode, m.workers);
            if (r && (!best[m.key] || r.elapsedMs < best[m.key].elapsedMs)) best[m.key] = r;
        }
    }
    return best;
}

function col(r) {
    if (!r) return "  -            ";
    return `m=${fmt(r.matches.length, 3)} to=${r.timedOut ? "Y" : "n"} ${fmt(r.elapsedMs, 5)}ms`;
}

const MAIN_MODES = [
    { key: "TS",  head: "TS    ", mode: "ts" },
    { key: "N1",  head: "N1单  ", mode: "single" },
    { key: "LAY", head: "分层  ", mode: "layer" },
    { key: "N8",  head: "节点8 ", mode: "branch", workers: 8 },
];

async function row(label, ms, depth, exclude, pattern, isRegex, modes) {
    const best = await bestOf(modes ?? MAIN_MODES, ms, depth, exclude, pattern, isRegex);
    console.log(
        `${pad(label, 42)} | ` +
        (modes ?? MAIN_MODES).map((m) => `${m.head} ${col(best[m.key])}`).join(" | ")
    );
}

function pad(s, w) { return s.padEnd(w); }

(async () => {
    const quick = process.argv.includes("--quick");
    console.log(`root = ${root}`);
    console.log(`native 存在: ${nativeExists ? NATIVE : "✗ 未编译,先 cargo build --release"}`);
    console.log("注: TS=TypeScript  N1=Rust单线程  LAY=分层BFS  N8=节点级动态队列x8  各 3 轮取最快\n");

    const times = quick ? [50, 200, 1000] : [10, 50, 200, 1000, 5000];

    console.log("== 不排除任何目录(最坏情况:node_modules/out/rde-urdf/vscode-xml 全扫) 搜 package.xml ==");
    for (const ms of times) {
        await row(`不排除  package.xml timeLimit=${ms}`, ms, 20, false, "package.xml", false);
    }

    console.log("\n== 排除产物目录 搜 package.xml ==");
    await row("排除产物 package.xml 1000ms", 1000, 20, true, "package.xml", false);

    console.log("\n== 搜源码 .ts (不排除, 最坏情况) ==");
    await row("不排除  .ts 1000ms", 1000, 20, false, "\\.ts$", true);

    console.log("\n== 深度限制对比(排除产物, timeLimit=200) ==");
    for (const depth of [1, 2, 3]) {
        await row(`depth=${depth} 排除 200ms`, 200, depth, true, "package.xml", false);
    }

    console.log("\n== 节点级 worker 数对比(每档 3 轮取最快) ==");
    for (const w of [2, 4, 6, 8, 12]) {
        await row(`排除产物 1000ms 节点x${w}`, 1000, 20, true, "package.xml", false, [
            { key: `N${w}`, head: `节点${fmt(w, 2)}`, mode: "branch", workers: w },
        ]);
    }
    await row(`不排除 1000ms 节点x12`, 1000, 20, false, "package.xml", false, [
        { key: "N12", head: "节点12", mode: "branch", workers: 12 },
    ]);
})();
