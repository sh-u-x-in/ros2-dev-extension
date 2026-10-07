// write/api 纯 TS 出口冒烟(2026-09-04 冻结 API)
import * as assert from 'assert';
import {
    planConfigure,
    detectRole,
    validatePackageName,
    anchors,
} from '../../src/build-tool/package-service/config/write/api';

describe('write/api 冻结出口冒烟(2026-09-04)', function () {
    it('计划层:角色识别 + cpp 计划可产出(add_executable + TARGETS)', () => {
        assert.strictEqual(detectRole('src/x.cpp'), 'cpp');
        const p = planConfigure(
            { name: 'demo', dir: '/ws/demo', buildType: 'ament_cmake' },
            'src/x.cpp',
            {
                cmakeText: 'cmake_minimum_required(VERSION 3.8)\nproject(demo)\n',
                setupPyText: '',
                packageXmlText: "<package format='3'><name>demo</name></package>",
            },
        );
        assert.strictEqual(p.role, 'cpp');
        const w = p.writes.find((x) => x.file === 'CMakeLists.txt');
        assert.ok(w && w.content.includes('add_executable(x src/x.cpp)'), w && w.content);
    });

    it('重命名层:validatePackageName 暴露', () => {
        assert.strictEqual(validatePackageName('good_name'), undefined);
        assert.ok(validatePackageName('Bad-Name') !== undefined);
    });

    it('anchors 桶经 api 暴露(命名空间),块内追加可调用', () => {
        const text = 'install(PROGRAMS scripts/a.py DESTINATION lib/${PROJECT_NAME})\n';
        const call = anchors.findActiveCallByArgs(text, 'install', 'PROGRAMS');
        assert.ok(call);
        const r = anchors.cmakeAppendArgToBlock(text, call!, 'scripts/b.py');
        assert.strictEqual(r.reason, undefined);
        assert.ok(r.text.includes('scripts/b.py'));
    });
});
