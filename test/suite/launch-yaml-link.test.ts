/**
 * Tests for YAML Launch Link Provider(2026-09-06)
 * .launch.yaml 的 `- include:` 块 → file: 值可跳(复用 XML 同一解析 resolveLaunchIncludePath)。
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

describe('Launch YAML Link Provider Test Suite', () => {
    const workspaceRoot = path.resolve(__dirname, '../../..');
    const testLaunchDir = path.join(workspaceRoot, 'samples', 'src', 'launch_examples', 'launch');
    let hasDocLinkCommand = false;

    before(async () => {
        const commands = await vscode.commands.getCommands(true);
        hasDocLinkCommand = commands.includes('vscode.executeDocumentLinkProvider');
    });

    it('Should provide links for include file values in YAML launch files', async () => {
        if (!hasDocLinkCommand) {
            console.warn('Skipping: vscode.executeDocumentLinkProvider not available in test host');
            return;
        }
        const testYamlPath = path.join(testLaunchDir, 'test_include.launch.yaml');
        const targetYamlPath = path.join(testLaunchDir, 'target_child.launch.yaml');
        const targetContent = 'launch:\n  - node:\n      pkg: "demo"\n      exec: "talker"\n';
        fs.writeFileSync(targetYamlPath, targetContent);

        const testContent = `launch:
  - arg:
      name: "use_target"
      default: "true"
  - include:
      file: "target_child.launch.yaml"
`;
        fs.writeFileSync(testYamlPath, testContent);

        try {
            const doc = await vscode.workspace.openTextDocument(testYamlPath);
            await vscode.window.showTextDocument(doc);

            const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
                'vscode.executeDocumentLinkProvider',
                doc.uri
            );

            assert.ok(links, 'Document link provider should return links');
            const include = links.find(l => l.target && path.basename(l.target.fsPath) === 'target_child.launch.yaml');
            assert.ok(include, '应命中 include 的 file 值 → target_child.launch.yaml');
            assert.strictEqual(include!.target!.fsPath, path.normalize(targetYamlPath));
        } finally {
            for (const p of [testYamlPath, targetYamlPath]) {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                }
            }
        }
    });
});
