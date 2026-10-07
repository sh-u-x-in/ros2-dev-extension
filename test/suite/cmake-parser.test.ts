// cmake-parser install 分组加固单测(2026-09-04)
import * as assert from 'assert';
import { parseCMakeLists } from '../../src/build-tool/package-service/config/exe-map/parse/cmake-parser';

describe('cmake-parser install 分组加固(2026-09-04)', function () {
    function installsOf(text: string): Array<{ kind: string; args: string[] }> {
        const r = parseCMakeLists(text);
        return r.installs.map((i) => ({ kind: i.kind, args: i.args }));
    }

    it('install(TARGETS … RUNTIME DESTINATION … ARCHIVE DESTINATION …):TARGETS 组干净、段头不再混入', () => {
        const ins = installsOf(
            'install(TARGETS talker listener RUNTIME DESTINATION lib/${PROJECT_NAME} ARCHIVE DESTINATION lib/${PROJECT_NAME}_lib)\n',
        );
        const tg = ins.find((i) => i.kind === 'TARGETS');
        assert.ok(tg, '应存在 TARGETS 组');
        assert.deepStrictEqual(tg!.args, ['talker', 'listener'], 'TARGETS 只含目标名,不得含 RUNTIME/ARCHIVE');
        const dests = ins.filter((i) => i.kind === 'DESTINATION').map((i) => i.args[0]);
        assert.ok(dests.includes('lib/${PROJECT_NAME}'), JSON.stringify(ins));
        assert.ok(dests.includes('lib/${PROJECT_NAME}_lib'), JSON.stringify(ins));
    });

    it('install(DIRECTORY … DESTINATION … FILES_MATCHING PATTERN …):DIRECTORY/DESTINATION 不含选项污染', () => {
        const ins = installsOf(
            'install(DIRECTORY config DESTINATION share/${PROJECT_NAME} FILES_MATCHING PATTERN *.yaml)\n',
        );
        const dir = ins.find((i) => i.kind === 'DIRECTORY');
        assert.deepStrictEqual(dir!.args, ['config']);
        const dest = ins.find((i) => i.kind === 'DESTINATION');
        assert.deepStrictEqual(dest!.args, ['share/${PROJECT_NAME}'], 'DESTINATION 不应含 FILES_MATCHING/PATTERN/*.yaml');
    });

    it('PROGRAMS 多文件仍单组;DESTINATION 独立记录;注释/大小写不干扰', () => {
        const ins = installsOf(
            [
                '# 假命令 install(PROGRAMS ghost.py DESTINATION x) 是注释',
                'INSTALL(PROGRAMS scripts/a.py scripts/b.py DESTINATION lib/${PROJECT_NAME})',
                '',
            ].join('\n'),
        );
        const prog = ins.find((i) => i.kind === 'PROGRAMS');
        assert.deepStrictEqual(prog!.args, ['scripts/a.py', 'scripts/b.py']);
        assert.ok(ins.some((i) => i.kind === 'DESTINATION' && i.args[0] === 'lib/${PROJECT_NAME}'));
        assert.ok(!ins.some((i) => i.args.includes('ghost.py')), '注释内假 install 不得解析');
    });

    it('hell 样例冒烟:function 内动态目标标 dynamic、未崩、issues=0', () => {
        const text = [
            '#[==[ bracket: install(TARGETS fake) ( ]==]',
            'set(MY_NODE_NAME talker)',
            'function(helper tgt src)',
            '  add_executable(${tgt} ${src})',
            'endfunction()',
            'helper(my_node src/my_node.cpp)',
            'add_executable(${MY_NODE_NAME} src/${MY_NODE_NAME}.cpp)',
            'install(TARGETS ${MY_NODE_NAME} RUNTIME DESTINATION lib/${PROJECT_NAME})',
            'ament_package()',
            '',
        ].join('\n');
        const r = parseCMakeLists(text);
        assert.strictEqual(r.issues.length, 0);
        assert.ok(r.executables.some((e) => e.name === 'talker'), 'set 展开的目标应解出 talker');
        const dyn = r.executables.find((e) => e.name.includes('${tgt}'));
        assert.ok(dyn && dyn.dynamic, '函数体内未解变量目标应标 dynamic');
        const tg = r.installs.find((i) => i.kind === 'TARGETS');
        assert.deepStrictEqual(tg!.args, ['${MY_NODE_NAME}'], 'TARGETS 组只含目标 token');
    });
});
