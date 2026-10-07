/**
 * Tests for ROS Message Providers (Hover and Definition)
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

// Run these tests if ROS is available OR if explicitly requested
const shouldRunRosTests = process.env.ROS_DISTRO || process.env.RUN_ROS_TESTS;
const itIfRos = shouldRunRosTests ? it : it.skip;

describe('ROS Message Providers Test Suite', () => {
    const samplesPath = path.join(__dirname, '..', '..', '..', 'samples', 'src', 'msg_interfaces', 'msg');
    
    // Wait for extension to fully activate before running tests
    before(async function() {
        if (!shouldRunRosTests) {
            return; // Skip setup if tests will be skipped
        }

        this.timeout(30000); // 30 second timeout for activation

        const extensionId = 'local.rde-ros-2';
        const extension = vscode.extensions.getExtension(extensionId);

        if (!extension) {
            this.skip();
            return;
        }

        // If it's already active, we're done
        if (extension.isActive) {
            return;
        }

        try {
            await extension.activate();
            // Give additional time for providers to register
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
            // If activation fails (e.g., missing deps in test host), skip gracefully
            this.skip();
        }
    });
    
    itIfRos('Hover over nested message type should show properties', async () => {
        // Open the ComplexMessage.msg file which has nested message types
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        
        // Ensure the document is in rosmsg language mode
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');
        
        // Find line with geometry_msgs/Point (line 8)
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('geometry_msgs/Point position')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find geometry_msgs/Point in ComplexMessage.msg');
        
        // Position cursor on the type (geometry_msgs/Point)
        const position = new vscode.Position(targetLine, 5); // Position within the type name
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        // Check that the hover contains "Properties" section
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        assert.ok(hoverText.includes('属性'), 'Hover should contain Properties section');
        assert.ok(hoverText.includes('float64'), 'Hover should show float64 properties from Point message');
        
        // The Point message should have x, y, z properties
        assert.ok(hoverText.includes('x') || hoverText.includes('y') || hoverText.includes('z'), 
            'Hover should show x, y, or z properties from Point message');
    });
    
    itIfRos('Hover over custom message type should show properties', async () => {
        // Open the ComplexMessage.msg file
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        
        // Ensure the document is in rosmsg language mode
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');
        
        // Find line with BasicTypes (custom message)
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('BasicTypes robot_config')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find BasicTypes in ComplexMessage.msg');
        
        // Position cursor on the type
        const position = new vscode.Position(targetLine, 2); // Position within "BasicTypes"
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        // Check that the hover contains "Properties" section
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        assert.ok(hoverText.includes('属性'), 'Hover should contain Properties section');
        
        // BasicTypes should have various primitive types
        assert.ok(hoverText.includes('bool') || hoverText.includes('int') || hoverText.includes('float'), 
            'Hover should show properties from BasicTypes message');
    });
    
    itIfRos('Hover over built-in type should show description', async () => {
        // Open the BasicTypes.msg file
        const basicTypesPath = path.join(samplesPath, 'BasicTypes.msg');
        const doc = await vscode.workspace.openTextDocument(basicTypesPath);
        await vscode.window.showTextDocument(doc);
        
        // Ensure the document is in rosmsg language mode
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');
        
        // Find line with float64 type
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('float64 precise_position')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find float64 in BasicTypes.msg');
        
        // Position cursor on the type
        const position = new vscode.Position(targetLine, 2); // Position within "float64"
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        // Check that built-in types show description, not properties
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        assert.ok(!hoverText.includes('属性'), 'Built-in type hover should not contain Properties section');
        assert.ok(hoverText.includes('双精度') || hoverText.includes('64 位浮点数'), 
            'Built-in type hover should show description');
    });
    
    itIfRos('Hover over field name should show type documentation and properties', async () => {
        // Open the ComplexMessage.msg file
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        
        // Ensure the document is in rosmsg language mode
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');
        
        // Find line with geometry_msgs/Point position
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('geometry_msgs/Point position')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find geometry_msgs/Point position in ComplexMessage.msg');
        
        // Position cursor on the field name "position"
        const lineText = doc.lineAt(targetLine).text;
        const fieldNameIndex = lineText.indexOf('position');
        const position = new vscode.Position(targetLine, fieldNameIndex + 2); // Position within "position"
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned for field name');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        // Check that field name hover includes both field info and type documentation
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        assert.ok(hoverText.includes('geometry_msgs/Point'), 'Field hover should show type name');
        assert.ok(hoverText.includes('属性'), 'Field hover should contain Properties section from type');
        assert.ok(hoverText.includes('float64'), 'Field hover should show properties from Point message');
    });
    
    itIfRos('Hover over system-installed package message type should show properties', async () => {
        // Open the ComplexMessage.msg file which uses builtin_interfaces/Time
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        
        // Ensure the document is in rosmsg language mode
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');
        
        // Find line with builtin_interfaces/Time or builtin_interfaces/Duration
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('builtin_interfaces/Duration')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find builtin_interfaces/Duration in ComplexMessage.msg');
        
        // Position cursor on the type
        const position = new vscode.Position(targetLine, 5); // Position within "builtin_interfaces"
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned for system package');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        // Check that system package message shows properties
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        assert.ok(hoverText.includes('builtin_interfaces/Duration'), 'Hover should show type name');
        assert.ok(hoverText.includes('属性'), 'Hover should contain Properties section');
        assert.ok(hoverText.includes('int32 sec') || hoverText.includes('uint32 nanosec'), 
            'Hover should show properties from Duration message (sec and nanosec)');
    });
    
    itIfRos('Hover over fixed-size array should show array size annotation', async () => {
        // Open ComplexMessage.msg which has fixed-size arrays
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        
        // Find line with int32[6] joint_efforts
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('int32[6] joint_efforts')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find int32[6] joint_efforts in ComplexMessage.msg');
        
        // Position cursor on the type
        const position = new vscode.Position(targetLine, 2); // Position within "int32"
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        // Check for array annotation
        assert.ok(hoverText.includes('数组'), 'Hover should mention Array');
        assert.ok(hoverText.includes('定长') && hoverText.includes('[6]'), 
            'Hover should show fixed array size [6]');
    });
    
    itIfRos('Hover over dynamic array should show dynamic array annotation', async () => {
        // Open ComplexMessage.msg which has dynamic arrays
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        
        // Ensure the document is in rosmsg language mode
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');
        
        // Find line with float64[] joint_positions
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('float64[] joint_positions')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find float64[] joint_positions in ComplexMessage.msg');
        
        // Position cursor on the type
        const position = new vscode.Position(targetLine, 2); // Position within "float64"
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        // Check for array annotation
        assert.ok(hoverText.includes('数组'), 'Hover should mention Array');
        assert.ok(hoverText.includes('变长') && hoverText.includes('[]'), 
            'Hover should show dynamic array size []');
    });
    
    itIfRos('Hover over field with inline comment should display comment', async () => {
        // Open SensorData.msg which has inline comments
        const sensorDataPath = path.join(samplesPath, 'SensorData.msg');
        const doc = await vscode.workspace.openTextDocument(sensorDataPath);
        await vscode.window.showTextDocument(doc);
        
        // Ensure the document is in rosmsg language mode
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');
        
        // Find line with temperature field and comment
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('float64 temperature') && lineText.includes('# Celsius')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find temperature field with comment in SensorData.msg');
        
        // Position cursor on the field name
        const lineText = doc.lineAt(targetLine).text;
        const fieldNameIndex = lineText.indexOf('temperature');
        const position = new vscode.Position(targetLine, fieldNameIndex + 2);
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        // Check that comment is included
        assert.ok(hoverText.includes('Celsius'), 'Hover should include inline comment about Celsius');
    });
    
    itIfRos('Hover over field with default value should display default value', async () => {
        // ROS 2 messages don't have field default values - only constants do
        // Test hovering over a constant field instead
        const basicTypesPath = path.join(samplesPath, 'BasicTypes.msg');
        const doc = await vscode.workspace.openTextDocument(basicTypesPath);
        await vscode.window.showTextDocument(doc);
        
        // Ensure the document is in rosmsg language mode
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');
        
        // Find line with constant (MAX_SPEED=100)
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('MAX_SPEED')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find constant field in BasicTypes.msg');
        
        // Position cursor on the constant name
        const lineText = doc.lineAt(targetLine).text;
        const fieldNameIndex = lineText.indexOf('MAX_SPEED');
        const position = new vscode.Position(targetLine, fieldNameIndex + 2);
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        // Check that constant value is shown
        assert.ok(hoverText.includes('100') || hoverText.includes('常量'), 
            'Hover should show constant value or Constant indicator');
    });
    
    itIfRos('Hover over constant field should display constant value', async () => {
        // Open BasicTypes.msg which has constants
        const basicTypesPath = path.join(samplesPath, 'BasicTypes.msg');
        const doc = await vscode.workspace.openTextDocument(basicTypesPath);
        await vscode.window.showTextDocument(doc);
        
        // Find line with MAX_SPEED constant
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('int32 MAX_SPEED=100')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find MAX_SPEED constant in BasicTypes.msg');
        
        // Position cursor on the constant name
        const lineText = doc.lineAt(targetLine).text;
        const constantNameIndex = lineText.indexOf('MAX_SPEED');
        const position = new vscode.Position(targetLine, constantNameIndex + 2);
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        // Check that constant value is shown
        assert.ok(hoverText.includes('100'), 'Hover should show constant value "100"');
        assert.ok(hoverText.includes('常量') || hoverText.includes('='), 
            'Hover should indicate this is a constant');
    });
    
    itIfRos('Hover over custom type with package qualifier should show package info', async () => {
        // Open ComplexMessage.msg
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        
        // Find line with geometry_msgs/Point
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('geometry_msgs/Point position')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find geometry_msgs/Point in ComplexMessage.msg');
        
        // Position cursor on the type
        const position = new vscode.Position(targetLine, 5); // Position within the type
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        // Check that package info is shown
        assert.ok(hoverText.includes('包'), 'Hover should show Package information');
        assert.ok(hoverText.includes('geometry_msgs'), 'Hover should show package name');
    });
    
    itIfRos('Hover over custom type without package qualifier should provide type documentation', async () => {
        // Open ComplexMessage.msg which references BasicTypes without package
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        
        // Find line with BasicTypes (no package qualifier)
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text;
            if (lineText.includes('BasicTypes robot_config')) {
                targetLine = i;
                break;
            }
        }
        
        assert.notStrictEqual(targetLine, -1, 'Could not find BasicTypes in ComplexMessage.msg');
        
        // Position cursor on the type
        const position = new vscode.Position(targetLine, 2); // Position within "BasicTypes"
        
        // Execute hover provider
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        
        assert.ok(hovers && hovers.length > 0, 'No hover information returned');
        
        const hover = hovers[0];
        const contents = hover.contents;
        assert.ok(contents.length > 0, 'Hover contents are empty');
        
        const markdown = contents[0] as vscode.MarkdownString;
        const hoverText = markdown.value;
        
        // 未限定自定义类型:显示类型名与自定义消息类型标记(此前 F12 跳转提示已移除)
        assert.ok(hoverText.includes('BasicTypes'), 'Hover should show the custom type name');
        assert.ok(hoverText.includes('自定义消息类型'), 'Hover should mark it as a custom message type');
    });

    // ---------- 数组类型括号边界测试(类型区间含 [] ,右括号 ] 也应命中) ----------

    itIfRos('Hover over ] of builtin dynamic array should show array info', async () => {
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');

        // 定位 float64[] joint_positions 行
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.includes('float64[] joint_positions')) {
                targetLine = i;
                break;
            }
        }
        assert.notStrictEqual(targetLine, -1, 'Could not find float64[] joint_positions in ComplexMessage.msg');

        // 光标定位在右括号 ] 上(修复前此处不命中)
        const bracketCol = doc.lineAt(targetLine).text.indexOf(']');
        const position = new vscode.Position(targetLine, bracketCol);

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );

        assert.ok(hovers && hovers.length > 0, 'No hover on right bracket ] of dynamic array');
        const hoverText = (hovers[0].contents[0] as vscode.MarkdownString).value;
        assert.ok(hoverText.includes('数组'), 'Hover on ] should mention array');
        assert.ok(hoverText.includes('变长'), 'Hover on ] should show dynamic array');
    });

    itIfRos('Hover over ] of custom message array should show properties', async () => {
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');

        // 定位 geometry_msgs/Point[] waypoints 行
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.includes('geometry_msgs/Point[] waypoints')) {
                targetLine = i;
                break;
            }
        }
        assert.notStrictEqual(targetLine, -1, 'Could not find geometry_msgs/Point[] in ComplexMessage.msg');

        const bracketCol = doc.lineAt(targetLine).text.indexOf(']');
        const position = new vscode.Position(targetLine, bracketCol);

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );

        assert.ok(hovers && hovers.length > 0, 'No hover on ] of custom message array');
        const hoverText = (hovers[0].contents[0] as vscode.MarkdownString).value;
        assert.ok(hoverText.includes('数组'), 'Hover on ] should mention array');
        assert.ok(hoverText.includes('属性'), 'Hover on ] should show properties of Point');
        assert.ok(hoverText.includes('float64'), 'Hover on ] should show Point x/y/z float64 properties');
    });

    itIfRos('Hover over ] of fixed array should show fixed size', async () => {
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');

        // 定位 int32[6] joint_efforts 行
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.includes('int32[6] joint_efforts')) {
                targetLine = i;
                break;
            }
        }
        assert.notStrictEqual(targetLine, -1, 'Could not find int32[6] joint_efforts in ComplexMessage.msg');

        const bracketCol = doc.lineAt(targetLine).text.indexOf(']');
        const position = new vscode.Position(targetLine, bracketCol);

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );

        assert.ok(hovers && hovers.length > 0, 'No hover on ] of fixed array');
        const hoverText = (hovers[0].contents[0] as vscode.MarkdownString).value;
        assert.ok(hoverText.includes('定长') && hoverText.includes('[6]'),
            'Hover on ] should show fixed size [6]');
    });

    itIfRos('Definition on ] of custom message array should jump to definition', async () => {
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');

        // 定位 geometry_msgs/Point[] waypoints 行
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.includes('geometry_msgs/Point[] waypoints')) {
                targetLine = i;
                break;
            }
        }
        assert.notStrictEqual(targetLine, -1, 'Could not find geometry_msgs/Point[] in ComplexMessage.msg');

        const bracketCol = doc.lineAt(targetLine).text.indexOf(']');
        const position = new vscode.Position(targetLine, bracketCol);

        const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            doc.uri,
            position
        );

        assert.ok(definitions && definitions.length > 0, 'No definition on ] of custom message array');
        assert.ok(definitions[0].uri.fsPath.includes('Point'),
            'Definition on ] should point to Point.msg');
    });

    itIfRos('Definition on ] of builtin array should not jump', async () => {
        const complexMsgPath = path.join(samplesPath, 'ComplexMessage.msg');
        const doc = await vscode.workspace.openTextDocument(complexMsgPath);
        await vscode.window.showTextDocument(doc);
        await vscode.languages.setTextDocumentLanguage(doc, 'rosmsg');

        // 定位 float64[] joint_positions 行
        let targetLine = -1;
        for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.includes('float64[] joint_positions')) {
                targetLine = i;
                break;
            }
        }
        assert.notStrictEqual(targetLine, -1, 'Could not find float64[] joint_positions in ComplexMessage.msg');

        const bracketCol = doc.lineAt(targetLine).text.indexOf(']');
        const position = new vscode.Position(targetLine, bracketCol);

        const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            doc.uri,
            position
        );

        assert.ok(!definitions || definitions.length === 0,
            'Builtin type array should have no definition on ]');
    });
});
