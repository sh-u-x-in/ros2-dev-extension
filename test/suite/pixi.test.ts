// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

import * as vscode_utils from "../../src/vscode-utils";
import { detectUserShell } from "../../src/ros2/host";
import { getRosSetupScript } from "../../src/ros2/environment/setup-script";

/**
 * 更新配置并等待其生效。
 * 测试宿主(@vscode/test-electron)中 config.update 落盘为异步,扩展宿主内存配置树
 * 刷新时机不确定,await update 后立即 get 可能读到旧值(Global/Workspace 均存在竞态)。
 * 需等待 onDidChangeConfiguration 事件(配置已应用信号)后再读取。
 */
async function updateConfig(
    config: vscode.WorkspaceConfiguration,
    key: string,
    value: any,
    target: vscode.ConfigurationTarget
): Promise<void> {
    const applied = new Promise<void>(resolve => {
        const disposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(`ROS2.${key}`)) {
                disposable.dispose();
                resolve();
            }
        });
        // 兜底:update 值未变化时可能不触发事件,超时放行避免挂起
        setTimeout(() => { disposable.dispose(); resolve(); }, 1000);
    });
    await config.update(key, value, target);
    await applied;
}

describe("ROS Setup Script Configuration Tests", () => {
    
    it("getRosSetupScript returns platform-appropriate default path when setup script and pixiRoot are not configured", async () => {
        const config = vscode_utils.getExtensionConfiguration();
        
        // Clear any existing configuration to test defaults
        const originalRosSetupScript = config.get("env.setupScript");
        const originalPixiRoot = config.get("env.pixiRoot");
        
        try {
            // 未配置 rosSetupScript 且未配置 pixiRoot → Windows 回退 c:\pixi_ws(拼 ros2-windows 子目录);其他平台空串(不做路径推导)
            await updateConfig(config, "env.setupScript", "", vscode.ConfigurationTarget.Workspace);
            await updateConfig(config, "env.pixiRoot", "", vscode.ConfigurationTarget.Workspace);
            
            const setupScriptPath = getRosSetupScript();
            if (process.platform === "win32") {
                const shellInfo = detectUserShell();
                const expected = path.normalize(
                    path.join("c:\\pixi_ws", "ros2-windows", `local_setup${shellInfo.scriptExtension}`)
                );
                assert.strictEqual(setupScriptPath, expected, "Windows 上未配置 pixiRoot 应回退 c:\\pixi_ws 并拼 ros2-windows 子目录");
            } else {
                assert.strictEqual(setupScriptPath, "", "Should return empty when no setup script or pixiRoot is configured");
            }
        } finally {
            // Restore original configuration
            await config.update("env.setupScript", originalRosSetupScript, vscode.ConfigurationTarget.Workspace);
            await config.update("env.pixiRoot", originalPixiRoot, vscode.ConfigurationTarget.Workspace);
        }
    });
    
    it("getRosSetupScript respects custom configuration", async () => {
        const config = vscode_utils.getExtensionConfiguration();
        const originalRosSetupScript = config.get("env.setupScript");
        const customPath = process.platform === "win32" ? "D:\\custom\\ros\\setup.bat" : "/opt/ros/humble/setup.bash";
        
        try {
            await updateConfig(config, "env.setupScript", customPath, vscode.ConfigurationTarget.Workspace);
            
            const setupScriptPath = getRosSetupScript();
            const normalizedCustomPath = path.normalize(customPath);
            
            assert.strictEqual(setupScriptPath, normalizedCustomPath, "Should use custom path");
            
        } finally {
            // Restore original configuration
            await config.update("env.setupScript", originalRosSetupScript, vscode.ConfigurationTarget.Workspace);
        }
    });
    
    it("getRosSetupScript handles workspaceFolder variable substitution", async () => {
        const config = vscode_utils.getExtensionConfiguration();
        const originalRosSetupScript = config.get("env.setupScript");
        const scriptWithVariable = "${workspaceFolder}/install/setup.bash";
        
        try {
            // Use Workspace target to avoid Global/user overrides; await update so value is applied
            await config.update("env.setupScript", scriptWithVariable, vscode.ConfigurationTarget.Workspace);
            
            const setupScriptPath = getRosSetupScript();
            
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length === 1) {
                const expectedPath = path.normalize(
                    scriptWithVariable.replace("${workspaceFolder}", vscode.workspace.workspaceFolders[0].uri.fsPath)
                );
                assert.strictEqual(setupScriptPath, expectedPath, "Should substitute workspaceFolder variable");
                assert.ok(!setupScriptPath.includes("${workspaceFolder}"), "Should not contain unsubstituted variable");
            }
            
        } finally {
            // Restore original configuration, awaiting persistence
            await config.update("env.setupScript", originalRosSetupScript, vscode.ConfigurationTarget.Workspace);
        }
    });
    
    it("detectUserShell returns appropriate shell info", () => {
        const shellInfo = detectUserShell();
        
        assert.ok(shellInfo.name, "Should have shell name");
        assert.ok(shellInfo.executable, "Should have shell executable");
        assert.ok(shellInfo.scriptExtension, "Should have script extension");
        assert.ok(shellInfo.sourceCommand, "Should have source command");
        
        if (process.platform === "win32") {
            assert.strictEqual(shellInfo.name, "cmd", "Should be cmd on Windows");
            assert.strictEqual(shellInfo.scriptExtension, ".bat", "Should use .bat extension on Windows");
            assert.strictEqual(shellInfo.sourceCommand, "call", "Should use call command on Windows");
        } else {
            // Unix-like systems
            assert.ok(["bash", "zsh", "fish", "sh", "csh"].includes(shellInfo.name), "Should be a recognized Unix shell");
            assert.ok(shellInfo.scriptExtension.startsWith("."), "Script extension should start with dot");
            assert.ok(["source", "."].includes(shellInfo.sourceCommand), "Should use appropriate source command");
        }
    });
    
    it("pixiRoot configuration exists and defaults to empty string", () => {
        const config = vscode_utils.getExtensionConfiguration();
        
        // 默认值为空串(跨平台无硬编码默认,对齐 package.json 的 "default": "")
        const pixiRoot = config.get("env.pixiRoot", undefined);
        assert.notStrictEqual(pixiRoot, undefined, "pixiRoot setting should exist");
        assert.strictEqual(config.get("env.pixiRoot"), "", "pixiRoot should default to empty string");
    });

    it("pixiRoot setting can be customized and affects getRosSetupScript", async () => {
        const config = vscode_utils.getExtensionConfiguration();
        const originalRosSetupScript = config.get("env.setupScript");
        const originalPixiRoot = config.get("env.pixiRoot");
        
        try {
            // 清空 setup script,使 pixiRoot 生效路径可被观察
            await updateConfig(config, "env.setupScript", "", vscode.ConfigurationTarget.Workspace);
            
            const customPixiRoot = process.platform === "win32" ? "D:\\custom\\pixi" : "/custom/pixi";
            await updateConfig(config, "env.pixiRoot", customPixiRoot, vscode.ConfigurationTarget.Workspace);
            
            // 通过 getRosSetupScript 观察自定义 pixiRoot 生效
            // (避免直接 get 配置:测试宿主中 update 后 get 读取不可靠,inspect 有值但 get 返回默认)
            const setupScript = getRosSetupScript();
            assert.ok(setupScript.includes(customPixiRoot), "getRosSetupScript 应使用自定义 pixiRoot");
            if (process.platform === "win32") {
                assert.ok(setupScript.includes("ros2-windows"), "Windows 应含 ros2-windows 子目录");
            }
        } finally {
            // Restore original configuration
            await config.update("env.setupScript", originalRosSetupScript, vscode.ConfigurationTarget.Workspace);
            await config.update("env.pixiRoot", originalPixiRoot, vscode.ConfigurationTarget.Workspace);
        }
    });
    
    it("getRosSetupScript respects pixiRoot setting across all platforms", async () => {
        const config = vscode_utils.getExtensionConfiguration();
        const originalRosSetupScript = config.get("env.setupScript");
        const originalPixiRoot = config.get("env.pixiRoot");
        
        try {
            // Clear setup script to test defaults
            await updateConfig(config, "env.setupScript", "", vscode.ConfigurationTarget.Workspace);
            
            // Test with pixiRoot set to custom value
            const customPixiRoot = process.platform === "win32" ? "D:\\custom\\pixi\\workspace" : "/custom/pixi/workspace";
            await updateConfig(config, "env.pixiRoot", customPixiRoot, vscode.ConfigurationTarget.Workspace);
            
            let setupScriptPath = getRosSetupScript();
            
            // Should use pixiRoot on all platforms when set
            assert.ok(setupScriptPath.includes(customPixiRoot), "Should use custom pixiRoot on any platform");
            // ros2-windows 子目录仅 Windows 拼接(Unix 直接用 pixiRoot)
            if (process.platform === "win32") {
                assert.ok(setupScriptPath.includes("ros2-windows"), "Should include ros2-windows subdirectory on Windows");
            }
            
            // Test with pixiRoot cleared
            await updateConfig(config, "env.pixiRoot", "", vscode.ConfigurationTarget.Workspace);
            setupScriptPath = getRosSetupScript();
            
            // Windows:清空后回退 c:\pixi_ws;其他平台:空串(不做推导)
            if (process.platform === "win32") {
                assert.ok(setupScriptPath.includes("c:\\pixi_ws"), "Windows 上清空 pixiRoot 应回退 c:\\pixi_ws");
            } else {
                assert.strictEqual(setupScriptPath, "", "Should return empty when pixiRoot is not configured");
            }
            
        } finally {
            // Restore original configuration
            await config.update("env.setupScript", originalRosSetupScript, vscode.ConfigurationTarget.Workspace);
            await config.update("env.pixiRoot", originalPixiRoot, vscode.ConfigurationTarget.Workspace);
        }
    });
});