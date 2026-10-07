const path = require('path');
const Mocha = require('mocha');
require('./vscode-stub.js');
const root = path.resolve(__dirname, '..');
const m = new Mocha({ reporter: 'spec', timeout: 20000 });
m.addFile(path.join(root, 'out/test/suite/monitor-api.test.js'));
m.addFile(path.join(root, 'out/test/suite/ros2-service-api.test.js'));
// 2026-09-22:整套调试链路已移除(理由见 工作交接/已废弃-调试/为什么移除调试-2026-09-22.md)
m.run(f => { console.log('FAILURES=' + f); process.exit(f ? 1 : 0); });