/**
 * launch.py 解析器测试(scanLaunchNodes / scanLaunchIncludes)
 *
 * 2026-09-08 口径更新(用户):启动文件 include 跳转恢复;**解析不成功 → 静默失败**
 * (scanLaunchIncludes 只返回已解析到真实文件的记录);支持文件内简单赋值变量(collectSimpleVars)。
 * 原"未解析也返回记录/hover 未解析提示"语义废除。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import {
    scanLaunchNodeRefs,
    scanLaunchIncludes,
    maskPythonNoise,
    parsePyString
} from '../../src/languages/launch/parse/launch-py-parser';
import { PackageMap } from '../../src/languages/shared/package-map';

describe('Launch Py Parser Test Suite', () => {
    const demoLaunchPath = path.join(
        __dirname, '..', '..', '..',
        'samples', 'src', 'rde_py', 'launch', 'rde_demo.launch.py'
    );

    describe('scanLaunchNodeRefs(LE-1:DocumentLink 用)', () => {
        it('should extract Node calls from a real launch.py file', () => {
            const text = fs.readFileSync(demoLaunchPath, 'utf8');
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 2);
            assert.strictEqual(refs[0].package, 'rde_py');
            assert.strictEqual(refs[0].executable, 'rde_publisher');
            assert.strictEqual(refs[1].package, 'rde_py');
            assert.strictEqual(refs[1].executable, 'rde_subscriber');
        });

        it('should extract ComposableNode and Node as separate refs (nested container case)', () => {
            const text = 'ComposableNode(package="a")\nNode(package="b")';
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 2);
            assert.strictEqual(refs[0].kind, 'composable');
            assert.strictEqual(refs[0].package, 'a');
            assert.strictEqual(refs[1].kind, 'node');
            assert.strictEqual(refs[1].package, 'b');
        });

        it('should handle multi-line Node with attributes in any order', () => {
            const text = [
                'Node(',
                "\tname='n1',",
                "\tpackage='p1',",
                "\texecutable='e1',",
                '),'
            ].join('\n');
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 1);
            assert.strictEqual(refs[0].package, 'p1');
            assert.strictEqual(refs[0].executable, 'e1');
        });

        it('should report quote-exclusive value ranges (LE-1 链接范围口径)', () => {
            const text = 'Node(package="p1", executable=\'e1\')';
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 1);
            // 值范围不含引号:packageRange 覆盖 p1,executableRange 覆盖 e1
            assert.strictEqual(text.slice(refs[0].packageRange![0], refs[0].packageRange![1]), 'p1');
            assert.strictEqual(text.slice(refs[0].executableRange![0], refs[0].executableRange![1]), 'e1');
        });

        it('LF-2 转义感知:双引号内 \\" 不截断,值还原', () => {
            const text = 'Node(package="a\\\\b", executable="talker\\\\ng")';
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 1);
            // 运行时双反斜杠按 python 语义还原为单反斜杠(ng 为字面);\n → 换行的还原由 parsePyString 头测覆盖
            assert.strictEqual(refs[0].package, 'a\\b');
            assert.strictEqual(refs[0].executable, 'talker\\ng');
        });

        it('LF-2 三引号值:不再被 docstring 掩码吞掉', () => {
            const text = 'Node(package="""p10""", executable="talker.cpp")';
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 1);
            assert.strictEqual(refs[0].package, 'p10');
            assert.strictEqual(refs[0].executable, 'talker.cpp');
        });

        it('LF-2 注释内的伪 kwarg 不干扰(代码态游走)', () => {
            const text = [
                'Node(',
                '    package="real_pkg",  # package="ghost_pkg"',
                '    executable="real_exec"',
                ')'
            ].join('\n');
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 1);
            assert.strictEqual(refs[0].package, 'real_pkg');
            assert.strictEqual(refs[0].executable, 'real_exec');
        });

        it('should skip Node calls inside comments (masked)', () => {
            const text = '# Node(package="ghost")\nNode(package="real")';
            const refs = scanLaunchNodeRefs(text);
            assert.strictEqual(refs.length, 1);
            assert.strictEqual(refs[0].package, 'real');
        });
    });

    describe('scanLaunchIncludes(2026-09-08:静态+静默)', () => {
        const dummyUri = vscode.Uri.file(path.join(os.tmpdir(), 'dummy.launch.py'));
        let tmpDir: string;

        before(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-launch-parser-'));
        });
        after(() => {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        });

        const write = (rel: string, content: string): string => {
            const p = path.join(tmpDir, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content);
            return p;
        };

        it('变量间接 + AnyLaunchDescriptionSource → 解析成功并返回真实目标', () => {
            const target = write('launch/child.launch.yaml', 'launch:\n  - node:\n      pkg: "x"\n      exec: "y"\n');
            const esc = tmpDir.replace(/\\/g, '\\\\');
            const text = [
                'def generate_launch_description():',
                '    launch_dir = os.path.join("' + esc + '", "launch")',
                '    return LaunchDescription([',
                '        IncludeLaunchDescription(',
                '            AnyLaunchDescriptionSource(',
                '                os.path.join(launch_dir, "child.launch.yaml")',
                '            ),',
                '        ),',
                '    ])'
            ].join('\n');
            const includes = scanLaunchIncludes(text, dummyUri, new PackageMap());
            assert.strictEqual(includes.length, 1, '应解析出 1 条(变量间接 join → 目标存在)');
            // Uri.fsPath 在 Windows 把盘符规范成小写,与 os 层路径仅大小写差异 → 大小写不敏感比较
            assert.strictEqual(includes[0].target!.fsPath.toLowerCase(), path.normalize(target).toLowerCase());
            assert.ok(includes[0].expr.includes('os.path.join(launch_dir'));
        });

        it('外部变量(LaunchConfiguration)参与 join → 解析失败静默 0', () => {
            const text = [
                'IncludeLaunchDescription(',
                '    AnyLaunchDescriptionSource(',
                "        os.path.join(LaunchConfiguration('d'), 'launch', 'x.launch.py')",
                '    ),',
                ')'
            ].join('\n');
            const includes = scanLaunchIncludes(text, dummyUri, new PackageMap());
            assert.strictEqual(includes.length, 0);
        });

        it('字面量绝对路径(目标存在) → 可解析并返回', () => {
            const target = write('abs.launch.py', '# t\n');
            const text = "IncludeLaunchDescription(FileLaunchDescriptionSource('" + target.replace(/\\/g, '/') + "'))";
            const includes = scanLaunchIncludes(text, dummyUri, new PackageMap());
            assert.strictEqual(includes.length, 1);
            // Uri.fsPath 在 Windows 把盘符规范成小写,与 os 层路径仅大小写差异 → 大小写不敏感比较
            assert.strictEqual(includes[0].target!.fsPath.toLowerCase(), path.normalize(target).toLowerCase());
        });

        it('未命中包(空 PackageMap)或目标不存在 → 静默 0,不给假链接', () => {
            const mainStream = [
                'IncludeLaunchDescription(',
                "\tPythonLaunchDescriptionSource(",
                "\t\tos.path.join(",
                "\t\t\tget_package_share_directory('pkg_a'),",
                "\t\t\t'launch',",
                "\t\t\t'foo.launch.py'",
                "\t\t)",
                "\t)",
                '),'
            ].join('\n');
            assert.strictEqual(scanLaunchIncludes(mainStream, dummyUri, new PackageMap()).length, 0);

            const literalMissing = "PythonLaunchDescriptionSource('launch/not_exists.launch.py')";
            assert.strictEqual(scanLaunchIncludes(literalMissing, dummyUri, new PackageMap()).length, 0);
        });

        it('非 launch 语义 join(config/params)即使在 include 内 → 0', () => {
            const text = [
                "IncludeLaunchDescription(PythonLaunchDescriptionSource(",
                "    os.path.join(get_package_share_directory('pkg_a'), 'config', 'params.yaml')",
                "))"
            ].join('\n');
            assert.strictEqual(scanLaunchIncludes(text, dummyUri, new PackageMap()).length, 0);
        });

        // ---- 掩码护栏(2026-09-05,保持) ----

        it('maskPythonNoise:等长掩码注释,保留换行', () => {
            const text = "a = 1  # os.path.join('x', 'y')\nb = 2\n";
            const masked = maskPythonNoise(text);
            assert.strictEqual(masked.length, text.length);
            assert.ok(!masked.includes('os.path.join'));
            assert.strictEqual(masked.split('\n').length, text.split('\n').length);
            assert.strictEqual(masked.slice(0, 6), 'a = 1 ');
        });

        it('maskPythonNoise:三引号 docstring 整体掩码,单行字符串保留', () => {
            const text = '"""doc: os.path.join(\'a\', \'b.launch.py\')"""\nx = "keep.launch.py"\n';
            const masked = maskPythonNoise(text);
            assert.ok(!masked.includes('os.path.join'));
            assert.ok(!masked.includes('b.launch.py'));
            assert.ok(masked.includes('keep.launch.py'), '单行字符串内容应保留');
        });

        it('注释/docstring 中的 include → 0', () => {
            const comment = [
                "# 参考写法: IncludeLaunchDescription(PythonLaunchDescriptionSource(",
                "#   os.path.join(get_package_share_directory('pkg_a'), 'launch', 'foo.launch.py')))"
            ].join('\n');
            assert.strictEqual(scanLaunchIncludes(comment, dummyUri, new PackageMap()).length, 0);

            const doc = [
                '"""用法示例:',
                "os.path.join(get_package_share_directory('pkg_a'), 'launch', 'foo.launch.py')",
                '"""',
                "x = 1"
            ].join('\n');
            assert.strictEqual(scanLaunchIncludes(doc, dummyUri, new PackageMap()).length, 0);
        });
    });
});
