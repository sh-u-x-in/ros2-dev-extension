/**
 * 无头跑 build-only 真值域(build-map)单测。
 * 与 run-key-tests.js 同款:纯逻辑套件,不依赖 vscode host。
 *   node test/run-buildmap-tests.js
 */
const path = require('path');
const Mocha = require('mocha');
require('./vscode-stub.js');
const root = path.resolve(__dirname, '..');
const m = new Mocha({ reporter: 'spec', timeout: 20000 });
m.addFile(path.join(root, 'out/test/suite/build-map.test.js'));
m.run(f => { console.log('FAILURES=' + f); process.exit(f ? 1 : 0); });
