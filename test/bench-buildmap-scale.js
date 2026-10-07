#!/usr/bin/env node
/**
 * install-truth 扫描规模基准(2026-09-30 立项调研用;只读探针,零第三方依赖)。
 *
 * 目的:给"剔除 build/ watcher 改构建信号主动刷新"的规模决策门提供事实——
 *   轴 A 包数: N 包 × M 文件的合成工作区,全量扫描耗时(N = 20/100/1k/10k)
 *   轴 B 体积: 单个超大包(文件数 5k/50k)
 *   轴 C 边际: 单包成本(= 增量重扫一包的成本上界)+ rc mtime 门成本(N 次 stat)
 *
 * 用法(仓库根;需先 npx tsc -p . 编译出 out/):
 *   node test/bench-buildmap-scale.js --out /tmp/bench-100 --packages 100 --files 42
 *   node test/bench-buildmap-scale.js --ws /home/ros2/roa2_ws
 *   node test/bench-buildmap-scale.js --out /tmp/bench-big --packages 1 --files 50000
 *   node test/bench-buildmap-scale.js --stat-gate /home/ros2/roa2_ws
 *
 * 合成夹具形状(对齐 scan/ 判据:收录=cmake/python/colcon 三选一,本脚本全部走 ament_cmake 重形态):
 *   build/<pkg>/{colcon_build.rc, CMakeCache.txt, ament_cmake_core/,
 *                CMakeFiles/<pkg>.dir/link.txt, CMakeFiles/<pkg>.dir/src/main.cpp.o.d}
 *   install/.colcon_install_layout ("isolated")
 *   install/<pkg>/lib/<pkg>/<pkg>(shebang 脚本)
 *   install/<pkg>/share/<pkg>/{package.xml, res/…( bulk 文件)}
 *   install/<pkg>/include/<pkg>/<pkg>.h
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const api = require(path.join(__dirname, '..', 'out', 'src', 'install-truth', 'api.js'));

/* ── 参数 ── */

function argOf(flag, dflt) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
function hasFlag(flag) {
    return process.argv.indexOf(flag) >= 0;
}

const OUT = argOf('--out', null);
const WS = argOf('--ws', null);
const PACKAGES = parseInt(argOf('--packages', '100'), 10);
const FILES = parseInt(argOf('--files', '42'), 10);
const REPEATS = parseInt(argOf('--repeats', '3'), 10);
const KEEP = hasFlag('--keep');
const STAT_GATE = argOf('--stat-gate', null);

/* ── 合成工作区生成 ── */

function writeFile(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

function pkgName(i) {
    return 'bench_p' + String(i).padStart(6, '0');
}

/**
 * 生成一个 ament_cmake 形态的包;文件数 = 固定骨架(≈6) + share 区 bulk。
 * 返回实际写入文件数(不含目录)。
 */
function generatePkg(root, name) {
    const buildDir = path.join(root, 'build', name);
    const installDir = path.join(root, 'install', name);
    let count = 0;

    writeFile(path.join(buildDir, 'colcon_build.rc'), '0\n'); count++;
    writeFile(path.join(buildDir, 'CMakeCache.txt'),
        'CMAKE_HOME_DIRECTORY:PATH=' + path.join(root, 'src', name) + '\n' +
        'CMAKE_INSTALL_PREFIX:PATH=' + installDir + '\n'); count++;
    fs.mkdirSync(path.join(buildDir, 'ament_cmake_core'), { recursive: true });
    writeFile(path.join(buildDir, 'CMakeFiles', name + '.dir', 'link.txt'),
        '/usr/bin/c++ -O2 CMakeFiles/' + name + '.dir/src/main.cpp.o -o ' +
        path.join(buildDir, name) + '\n'); count++;
    writeFile(path.join(buildDir, 'CMakeFiles', name + '.dir', 'src', 'main.cpp.o.d'),
        'CMakeFiles/' + name + '.dir/src/main.cpp.o: ../src/main.cpp\n'); count++;

    writeFile(path.join(installDir, 'lib', name, name),
        '#!/bin/sh\nexec echo ' + name + '\n'); count++;
    writeFile(path.join(installDir, 'share', name, 'package.xml'),
        '<package format="3"><name>' + name + '</name></package>\n'); count++;
    writeFile(path.join(installDir, 'include', name, name + '.h'),
        '#pragma once\n'); count++;

    // bulk:剩余文件进 share/<pkg>/res/ 与 urdf/(模拟资源型大包)
    const bulk = Math.max(0, FILES - 7);
    const half = Math.ceil(bulk / 2);
    for (let i = 0; i < bulk; i++) {
        const sub = i < half ? path.join('res', 'part' + (i % 8)) : 'urdf';
        writeFile(path.join(installDir, 'share', name, sub, 'f' + String(i).padStart(6, '0') + '.txt'),
            name + ' resource ' + i + '\n');
        count++;
    }
    return count;
}

function generateWorkspace(root, nPkgs, filesPerPkg) {
    const t0 = performance.now();
    let files = 0;
    writeFile(path.join(root, 'install', '.colcon_install_layout'), 'isolated\n');
    for (let i = 0; i < nPkgs; i++) {
        files += generatePkg(root, pkgName(i));
    }
    const genMs = performance.now() - t0;
    return { genMs: Math.round(genMs), files };
}

/* ── 扫描计时 ── */

async function timeScan(root, repeats) {
    const times = [];
    let pkgCount = 0;
    let jumpCount = 0;
    let areaFiles = 0;
    let lastErr = null;
    for (let r = 0; r < repeats; r++) {
        try {
            const snap = await api.buildBuildMapSnapshot(api.nodeFsLike, root, 'bench');
            times.push(snap.durationMs);
            pkgCount = snap.packages.size;
            jumpCount = 0;
            for (const list of snap.jumps.values()) {
                jumpCount += list.length;
            }
            areaFiles = 0;
            for (const areas of snap.areas.values()) {
                areaFiles += areas.files.length;
            }
            lastErr = snap.lastError;
        } catch (err) {
            throw new Error('扫描失败: ' + (err && err.message));
        }
    }
    return { times, pkgCount, jumpCount, areaFiles, lastError: lastErr };
}

function statLine(label, res) {
    const t = res.times;
    const min = Math.min.apply(null, t);
    const all = t.map((x) => x + 'ms').join(', ');
    console.log(
        '[基准] ' + label +
        ' | 包=' + res.pkgCount +
        ' 跳转=' + res.jumpCount +
        ' 区文件=' + res.areaFiles +
        ' | 耗时(min/全部)= ' + min + 'ms / [' + all + ']' +
        (res.lastError ? ' | lastError=' + res.lastError : '')
    );
    return min;
}

/* ── rc mtime 门成本(N 次 stat) ── */

async function statGate(root) {
    const buildDir = path.join(root, 'build');
    const names = (await fs.promises.readdir(buildDir)).filter((n) => !n.startsWith('.'));
    const t0 = performance.now();
    let hit = 0;
    for (const n of names) {
        try {
            const st = await fs.promises.stat(path.join(buildDir, n, 'colcon_build.rc'));
            if (st.mtimeMs > 0) {
                hit++;
            }
        } catch {
            // 无 rc:增量门语义里同样是一次 stat
        }
    }
    console.log('[基准] rc-mtime 门: ' + names.length + ' 包 stat 共 ' +
        Math.round(performance.now() - t0) + 'ms(rc 命中 ' + hit + ')');
}

/* ── 主流程 ── */

async function main() {
    console.log('[基准] install-truth 扫描规模基准 | node ' + process.version +
        ' | 平台 ' + os.platform() + ' | ' + new Date().toISOString());

    if (STAT_GATE) {
        await statGate(STAT_GATE);
        return;
    }

    let root;
    let generated = null;
    if (WS) {
        root = WS;
        console.log('[基准] 目标 = 既有工作区 ' + root);
    } else {
        if (!OUT) {
            console.error('需要 --out <生成目录> 或 --ws <既有工作区>');
            process.exit(2);
        }
        root = path.resolve(OUT);
        if (fs.existsSync(root)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
        generated = generateWorkspace(root, PACKAGES, FILES);
        console.log('[基准] 合成工作区: ' + PACKAGES + ' 包 × ~' + FILES + ' 文件 → ' +
            generated.files + ' 文件,生成 ' + generated.genMs + 'ms,根 = ' + root);
    }

    try {
        const res = await timeScan(root, REPEATS);
        statLine('全量扫描 ' + root, res);
    } finally {
        if (!KEEP && generated) {
            const t0 = performance.now();
            fs.rmSync(root, { recursive: true, force: true });
            console.log('[基准] 清理生成物 ' + Math.round(performance.now() - t0) + 'ms');
        }
    }
}

main().catch((err) => {
    console.error('[基准] 失败: ' + (err && err.stack || err));
    process.exit(1);
});
