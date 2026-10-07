#!/usr/bin/env node
/**
 * 三区解算实测探针:在**真实工作区**上看 install 侧观察 + build 侧对账的结果。
 *
 * 用法(在扩展仓库根;需先 `npx tsc -p .`):
 *   node test/run-buildmap-areas-live.js [工作区根]
 * 典型(VM 共享盘直通):
 *   cd /mnt/hgfs/ros2share/rde-ros-2 && node test/run-buildmap-areas-live.js /home/ros2/roa2_ws
 *
 * 口径(全是**观察**,不是断言应该怎样):
 *   · 每包:前缀 / 布局 / 四区计数 / agreement 三档 / generated 与 library 标记数;
 *   · 全局:四区分布、对账分布、warnings;
 *   · 自洽:每条 installPath 必须落在该包 prefix 之下(否则是归档 bug);
 *   · 抽样:每区给 2 条,带 sourcePath 与 evidence(供人工核对映射对不对)。
 */
const path = require('path');

const api = require(path.join(__dirname, '..', 'out', 'src', 'install-truth', 'api.js'));

async function main() {
    const ws = process.argv[2] || process.cwd();
    const snap = await api.buildBuildMapSnapshot(api.nodeFsLike, ws, 'areas-live');

    const areas = snap.areas;
    const order = ['lib', 'import', 'share', 'include'];
    const totals = { files: 0, lib: 0, import: 0, share: 0, include: 0, generated: 0, library: 0, link: 0, dangling: 0, executable: 0 };
    const agree = { confirmed: 0, observed: 0, 'manifest-only': 0 };
    const evidence = {};
    const linkDomain = {};
    const viaLink = {};
    const danglingList = [];
    let badPrefix = 0;
    const samples = { lib: [], import: [], share: [], include: [] };

    const pkgs = Array.from(areas.keys()).sort();
    for (const pkg of pkgs) {
        const a = areas.get(pkg);
        const c = { lib: 0, import: 0, share: 0, include: 0 };
        let gen = 0;
        let lib = 0;
        for (const f of a.files) {
            totals.files++;
            c[f.area]++;
            totals[f.area]++;
            if (f.generated) { totals.generated++; gen++; }
            if (f.library) { totals.library++; lib++; }
            if (f.link) totals.link++;
            if (f.dangling) { totals.dangling++; if (danglingList.length < 5) danglingList.push(`${f.installPath} -> ${f.linkTarget}`); }
            if (f.executable) totals.executable++;
            if (f.linkDomain) linkDomain[f.linkDomain] = (linkDomain[f.linkDomain] || 0) + 1;
            if (f.viaLinkDomain) viaLink[f.viaLinkDomain] = (viaLink[f.viaLinkDomain] || 0) + 1;
            agree[f.agreement]++;
            if (f.sourceEvidence) {
                evidence[f.sourceEvidence] = (evidence[f.sourceEvidence] || 0) + 1;
            } else if (f.sourcePath === undefined) {
                evidence['(无源)'] = (evidence['(无源)'] || 0) + 1;
            }
            if (!f.installPath.startsWith(a.prefix + '/')) {
                badPrefix++;
                console.log(`  [!] installPath 不在前缀下:${f.installPath} (prefix=${a.prefix})`);
            }
            if (samples[f.area] && samples[f.area].length < 2) {
                samples[f.area].push(
                    `${f.relPath}${f.generated ? ' [gen]' : ''}${f.library ? ' [lib]' : ''} <${f.agreement}>` +
                        (f.sourcePath === undefined ? ' → (无源)' : ` → ${f.sourcePath} (${f.sourceEvidence})`)
                );
            }
        }
        console.log(
            `  ${pkg.padEnd(18)} ${a.layout.padEnd(8)} lib=${String(c.lib).padStart(2)} ` +
                `import=${String(c.import).padStart(2)} share=${String(c.share).padStart(2)} ` +
                `include=${String(c.include).padStart(2)}  gen=${gen} libf=${lib}`
        );
    }

    console.log('');
    console.log('== 全局 ==');
    console.log(`  工作区        : ${ws}`);
    console.log(`  包数 / 文件数 : ${pkgs.length} / ${totals.files}`);
    console.log(`  四区分布      : lib=${totals.lib} import=${totals.import} share=${totals.share} include=${totals.include}`);
    console.log(`  标记          : generated=${totals.generated} library=${totals.library}(都是标记,不过滤)`);
    console.log(`  对账分布      : confirmed=${agree.confirmed} observed=${agree.observed} manifest-only=${agree['manifest-only']}`);
    console.log(`  源落点来源    : ${Object.keys(evidence).sort().map((k) => `${k}=${evidence[k]}`).join('  ')}`);
    console.log(`  形态(甲-1)   : link=${totals.link} dangling=${totals.dangling} executable=${totals.executable}`);
    console.log(`  linkDomain    : ${Object.keys(linkDomain).sort().map((k) => `${k}=${linkDomain[k]}`).join('  ') || '(无)'}`);
    console.log(`  viaLinkDomain : ${Object.keys(viaLink).sort().map((k) => `${k}=${viaLink[k]}`).join('  ') || '(无)'}`);
    for (const d of danglingList) {
        console.log(`  [悬空] ${d}`);
    }
    console.log(`  归档自洽      : prefix 越界 ${badPrefix} 条(应为 0)`);
    console.log('');
    console.log('== 抽样(每区 2 条)==');
    for (const area of order) {
        for (const s of samples[area]) {
            console.log(`  ${area.padEnd(8)} ${s}`);
        }
    }
    console.log('');
    console.log(`== warnings (${snap.warnings.length}) ==`);
    for (const w of snap.warnings.slice(0, 12)) {
        console.log(`  - ${w}`);
    }
    console.log(badPrefix === 0 ? 'RESULT=OK' : `RESULT=FAIL(badPrefix=${badPrefix})`);
}

main().catch((err) => {
    console.error('探针失败:', err && err.message ? err.message : err);
    process.exit(1);
});
