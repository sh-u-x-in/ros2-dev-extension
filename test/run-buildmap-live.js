#!/usr/bin/env node
/**
 * 真实工作区冒烟:用 build-only 真值域扫描真实 ROS 工作区的 build/,
 * 打印"可执行 → 源码"对应关系。
 *
 * 用法(在扩展仓库根):
 *   node test/run-buildmap-live.js [工作区根] [--json] [--pkg 名] [--grep 文本]
 *
 * 说明:roa2_ws 的 build/ 只存在于 VM 本地盘(不在共享盘),故本脚本通常在 VM 上执行:
 *   ssh ros2-vm 'cd /home/ros2/rde-ros-2 && node test/run-buildmap-live.js /home/ros2/roa2_ws'
 *
 * 依赖:仓库已编译产物 out/src/install-truth/api.js(先跑 npx tsc -p ./)。零第三方依赖。
 */

const path = require('path');
const crypto = require('crypto');

const api = require(path.join(__dirname, '..', 'out', 'src', 'install-truth', 'api.js'));

/** 规范化 digest(用于跨象限/跨环境逐字节比较:剔除耗时与时间戳,只留可判定信息) */
function buildDigest(snap) {
    const pkgs = [];
    for (const name of Array.from(snap.packages.keys()).sort()) {
        const p = snap.packages.get(name);
        const t = p.traits;
        const traits = [
            t.cmake ? 'cmake' : '',
            t.amentCmake ? 'ament_cmake' : '',
            t.python ? 'python' : '',
            t.rosidl ? 'rosidl' : '',
            t.colcon ? 'colcon' : '',
        ]
            .filter(Boolean)
            .join('+');
        pkgs.push(`${name}|${p.type}|${traits}`);
    }
    const jumps = [];
    for (const name of Array.from(snap.jumps.keys()).sort()) {
        for (const e of snap.jumps.get(name)) {
            jumps.push(
                [
                    name,
                    e.name,
                    e.kind,
                    e.tier,
                    e.unresolved ? '1' : '0',
                    e.installed ? '1' : '0',
                    e.srcPaths.join(';'),
                ].join('|')
            );
        }
    }
    const body = { packages: pkgs, jumps: jumps };
    const canonical = JSON.stringify(body);
    return {
        digestVersion: 2,
        entryCount: jumps.length,
        packageCount: pkgs.length,
        sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
        packages: pkgs,
        jumps: jumps,
    };
}

/** 取 --key value 形式的参数值 */
function pickArg(argv, key) {
    const i = argv.indexOf(key);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main() {
    const argv = process.argv.slice(2);
    const asJson = argv.includes('--json');
    const asDigest = argv.includes('--digest');
    const pkgFilter = pickArg(argv, '--pkg');
    const grep = pickArg(argv, '--grep');
    const root =
        argv.find((a) => !a.startsWith('--') && a !== pkgFilter && a !== grep) ||
        '/home/ros2/roa2_ws';

    const center = api.createBuildMapCenter({ workspaceRoot: root });
    await center.refresh('live-smoke');
    const failure = center.getLastError();
    if (failure !== undefined) {
        console.error('构建失败: ' + failure);
        process.exit(1);
    }
    const snap = center.getState();

    if (asDigest) {
        console.log(JSON.stringify(buildDigest(snap), null, 2));
        return;
    }

    if (argv.includes('--names')) {
        const lines = [];
        for (const name of Array.from(snap.jumps.keys()).sort()) {
            for (const e of snap.jumps.get(name)) {
                lines.push(name + '/' + e.name);
            }
        }
        console.log(lines.sort().join('\n'));
        return;
    }

    if (asJson) {
        const out = {
            workspaceRoot: snap.workspaceRoot,
            buildRoot: snap.buildRoot,
            srcRoot: snap.srcRoot,
            durationMs: snap.durationMs,
            warnings: snap.warnings,
            packages: {},
            jumps: {},
        };
        for (const [name, pkg] of snap.packages) {
            out.packages[name] = pkg;
        }
        for (const [name, list] of snap.jumps) {
            out.jumps[name] = list;
        }
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    // ---- 头部摘要 ----
    let total = 0;
    let unresolved = 0;
    let withSource = 0;
    for (const list of snap.jumps.values()) {
        for (const e of list) {
            total++;
            if (e.unresolved) {
                unresolved++;
            }
            if (e.srcPaths.length > 0) {
                withSource++;
            }
        }
    }
    console.log('工作区 : ' + snap.workspaceRoot);
    console.log('build  : ' + snap.buildRoot);
    console.log('src    : ' + (snap.srcRoot || '(未发现)'));
    console.log(
        '包数   : ' + snap.packages.size +
        '   可执行条目: ' + total +
        '   有源: ' + withSource +
        '   未解析: ' + unresolved +
        '   耗时: ' + snap.durationMs + 'ms'
    );

    // ---- 包概览 ----
    console.log('');
    console.log('== 包概览 ==');
    for (const name of Array.from(snap.packages.keys()).sort()) {
        const pkg = snap.packages.get(name);
        const t = pkg.traits;
        const traits = [
            t.cmake ? 'cmake' : '',
            t.amentCmake ? 'ament_cmake' : '',
            t.python ? 'python' : '',
            t.rosidl ? 'rosidl' : '',
            t.colcon ? 'colcon' : '',
        ]
            .filter(Boolean)
            .join('+');
        const jumpCount = (snap.jumps.get(name) || []).length;
        console.log(
            '  ' + name.padEnd(22) + pkg.type.padEnd(20) + '[' + traits + ']' + '  条目=' + jumpCount
        );
    }

    // ---- 逐包"可执行 → 源" ----
    const kindLabel = { cpp: 'C++目标', console_script: 'console', script: '脚本' };
    console.log('');
    console.log('== 可执行 → 源码 ==');
    for (const name of Array.from(snap.jumps.keys()).sort()) {
        if (pkgFilter !== undefined && name !== pkgFilter) {
            continue;
        }
        let list = snap.jumps.get(name) || [];
        if (grep !== undefined) {
            list = list.filter(
                (e) => e.name.indexOf(grep) >= 0 || e.srcPaths.join(';').indexOf(grep) >= 0
            );
        }
        if (list.length === 0) {
            continue;
        }
        console.log('');
        console.log('## ' + name + '  (' + list.length + ')');
        for (const e of list) {
            const tag = kindLabel[e.kind] || e.kind;
            const flag = e.unresolved ? '!' : ' ';
            const src = e.srcPaths.length > 0 ? e.srcPaths[0] : '(未解析)';
            console.log('  ' + flag + ' ' + e.name.padEnd(20) + tag.padEnd(9) + e.tier.padEnd(3) + '→ ' + src);
            for (let i = 1; i < Math.min(e.srcPaths.length, 4); i++) {
                console.log('      ' + ' '.repeat(20) + '  ' + e.srcPaths[i]);
            }
            if (e.unresolved) {
                console.log('      ' + ' '.repeat(20) + '  未解析: ' + e.unresolvedReason);
            }
        }
    }

    // ---- 警告 ----
    if (snap.warnings.length > 0) {
        console.log('');
        console.log('== 警告 (' + snap.warnings.length + ') ==');
        for (const w of snap.warnings) {
            console.log('  - ' + w);
        }
    }
}

main().catch((err) => {
    console.error('异常: ' + (err && err.stack ? err.stack : String(err)));
    process.exit(1);
});
