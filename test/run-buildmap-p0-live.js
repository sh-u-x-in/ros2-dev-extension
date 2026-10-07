#!/usr/bin/env node
/**
 * P0 实测探针:在**真实工作区**上验证三项新能力(build-only,不需要 install 语义知识)。
 *   ① P0-1 按安装侧绝对路径反查(byInstallPath / lookupByPath / normalizeInstallKey)
 *   ② P0-2 Python 三处落点(壳 / site-packages 目录 / 模块文件)
 *   ③ P0-3 编译期源路径集合(compilePaths + 本机可访问性)
 *
 * 用法(在扩展仓库根;需先 `npx tsc -p ./`):
 *   node test/run-buildmap-p0-live.js [工作区根]
 * 典型(VM;roa2_ws 的 build/ 在 VM 本地盘):
 *   ssh ros2-vm 'cd /home/ros2/rde-ros-2 && node test/run-buildmap-p0-live.js /home/ros2/roa2_ws'
 *
 * 结论口径:
 *   · 自洽性 —— 每个条目用自己的 installPath/buildPath 反查,必须回到自己(失败即索引 bug);
 *   · 未命中 —— 对系统路径(如 /opt/ros/.../rviz2)必须得到 path-unknown(而不是 null/异常);
 *   · 落点存在性 —— 清单声明的 install 侧路径在真实机器上应真的存在(打印计数)。
 */
const path = require('path');
const fs = require('fs');

const api = require(path.join(__dirname, '..', 'out', 'src', 'install-truth', 'api.js'));

function existsSync(p) {
    try {
        fs.statSync(p);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const ws = process.argv[2] || process.cwd();
    const snap = await api.buildBuildMapSnapshot(api.nodeFsLike, ws, 'p0-live');
    const index = api.buildExecIndex(snap);

    let total = 0;
    let withInstallPaths = 0;
    let withPython = 0;
    let pyVerified = 0;
    let pyDerived = 0;
    let withCompile = 0;
    const samples = { python: [], compile: [] };
    let selfHit = 0;
    let selfMiss = 0;
    let aliasHit = 0;
    let aliasMiss = 0;
    let declaredExists = 0;
    let declaredMissing = 0;
    let primaryExists = 0;
    let primaryMissing = 0;
    let aliasTotal = 0;
    let aliasExists = 0;

    for (const pkg of Array.from(snap.jumps.keys()).sort()) {
        for (const e of snap.jumps.get(pkg)) {
            total++;
            if ((e.installPaths ?? []).length > 0) {
                withInstallPaths++;
            }
            if (e.pythonInstall !== undefined) {
                withPython++;
                if (e.pythonInstall.verified) {
                    pyVerified++;
                } else {
                    pyDerived++;
                }
                if (samples.python.length < 3) {
                    samples.python.push(`${e.pkg}/${e.name} → ${JSON.stringify(e.pythonInstall)}`);
                }
            }
            if ((e.compilePaths ?? []).length > 0) {
                withCompile++;
                if (samples.compile.length < 2) {
                    samples.compile.push(`${e.pkg}/${e.name}(${e.compilePaths.length} 条) 例:${e.compilePaths[0]}`);
                }
            }
            // 自洽性:用条目自己的 installPath 反查
            if (e.installPath !== '') {
                const r = api.lookupByPath(index, e.installPath);
                if (r.status !== 'path-unknown' && r.pkg === e.pkg && r.name === e.name) {
                    selfHit++;
                } else {
                    selfMiss++;
                    console.log(`  [!] 自洽性失败(installPath):${e.pkg}/${e.name} ← ${e.installPath} → ${r.status}`);
                }
            }
            // 自洽性:build 别名(link.txt 的 -o)
            if (e.buildPath !== undefined) {
                const r = api.lookupByPath(index, e.buildPath);
                if (r.status !== 'path-unknown' && r.pkg === e.pkg && r.name === e.name) {
                    aliasHit++;
                } else {
                    aliasMiss++;
                }
            }
            // 落点存在性(真实机器)
            for (const p of e.installPaths ?? []) {
                if (existsSync(p)) {
                    declaredExists++;
                } else {
                    declaredMissing++;
                }
            }
            // 主落点(Python 壳脚本)必须存在;布局别名只作参考(另一种布局本就不该存在)
            const primary = e.pythonInstall !== undefined ? e.pythonInstall.scriptPath : e.installPath !== '' ? e.installPath : undefined;
            if (primary !== undefined) {
                if (existsSync(primary)) {
                    primaryExists++;
                } else {
                    primaryMissing++;
                    console.log(`  [!] 主落点不存在:${e.pkg}/${e.name} ← ${primary}`);
                }
            }
            if (e.pythonInstall !== undefined && !e.pythonInstall.verified) {
                for (const p of e.installPaths ?? []) {
                    aliasTotal++;
                    if (existsSync(p)) {
                        aliasExists++;
                    }
                }
            }
        }
    }

    const sysMiss = api.lookupByPath(index, '/opt/ros/humble/lib/rviz2/rviz2');
    const variant = api.lookupByPath(index, '/nowhere//x/../x');

    console.log('== 汇总 ==');
    console.log(`  工作区        : ${ws}`);
    console.log(`  包数 / 条目数 : ${snap.packages.size} / ${total}`);
    console.log(`  byInstallPath : ${index.byInstallPath.size} 个键`);
    console.log(`  installPaths  : ${withInstallPaths}/${total} 条有安装落点`);
    console.log(`  pythonInstall : ${withPython} 条(清单核对=${pyVerified} / 推导未核对=${pyDerived})`);
    console.log(`  compilePaths  : ${withCompile} 条(记录原样;本机可访问性由消费方自查)`);
    console.log('== P0-1 自洽性 ==');
    console.log(`  installPath 反查命中/失败 : ${selfHit} / ${selfMiss}`);
    console.log(`  buildPath   别名命中/失败 : ${aliasHit} / ${aliasMiss}`);
    console.log(`  系统路径未命中态          : ${sysMiss.status}(期望 path-unknown)`);
    console.log(`  写法变体未命中态          : ${variant.status}(期望 path-unknown)`);
    console.log('== P0-2/P0-3 落点存在性(真实机器) ==');
    console.log(`  主落点       存在/缺失 : ${primaryExists} / ${primaryMissing}(缺失=0 才算对)`);
    console.log(`  全部落点     存在/缺失 : ${declaredExists} / ${declaredMissing}(含另一种布局的别名,缺失属正常)`);
    console.log(`  推导条目的别名候选 存在/总 : ${aliasExists} / ${aliasTotal}`);
    for (const s of samples.python) {
        console.log(`  py 例:${s}`);
    }
    for (const s of samples.compile) {
        console.log(`  cc 例:${s}`);
    }
    const bad = selfMiss + aliasMiss;
    console.log(bad === 0 ? 'RESULT=OK' : `RESULT=FAIL(selfMiss=${selfMiss},aliasMiss=${aliasMiss})`);
}

main().catch((err) => {
    console.error('探针失败:', err && err.message ? err.message : err);
    process.exit(1);
});
