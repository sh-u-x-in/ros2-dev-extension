const path = require('path');
const fs = require('fs');
const Mocha = require('mocha');
require('./vscode-stub.js');
const root = path.resolve(__dirname, '..');
const m = new Mocha({ reporter: 'dot', timeout: 20000 });
const dir = path.join(root, 'out/test/suite');
for (const f of fs.readdirSync(dir)) { if (f.endsWith('.test.js')) m.addFile(path.join(dir, f)); }
m.run(f => { console.log('FAILURES=' + f); process.exit(f ? 1 : 0); });