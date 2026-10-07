/**
 * VS Code Extension Test Runner
 * 
 * This file is the entry point for running VS Code extension tests.
 * It uses @vscode/test-electron to download and run VS Code with the extension loaded.
 */

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        // Passed to `--extensionDevelopmentPath`
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');

        // The path to test runner
        // Passed to --extensionTestsPath
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // Download VS Code, unzip it and run the integration test
        // version 固定 1.133.0:复用 .vscode-test 缓存,避免每次 VS Code 发新版重新下载 ~319MB(2026-08-19)
        await runTests({ 
            extensionDevelopmentPath, 
            extensionTestsPath,
            version: "1.133.0",
            launchArgs: [
                '--disable-extensions', // Disable other extensions during testing
                '--disable-workspace-trust', // Skip workspace trust dialog
                // 钉死测试宿主显示语言为英文(2026-10-04 i18n 期0):l10n.t 恒回英文源串,
                // 断言口径与开发者机器的 VS Code 语言(中文)解耦;将来中文册填满也不影响测试
                '--locale=en',
                // Open the workspace folder so tests can access workspace files
                path.resolve(__dirname, '../../samples')
            ]
        });
    } catch (err) {
        console.error('Failed to run tests');
        process.exit(1);
    }
}

main();
