// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * @file py-setup.ts
 * ament_python 构建文件与测试模板(create/templates,2026-09-04 结构重构建立)。
 * 自 create-python-package 迁出: setupPyTemplate / setupCfgTemplate / 5 个 lint 测试常量;
 * 内容与迁移前逐字节一致(结构重构硬约束)。
 *
 * 扩展位(后续"Generated-package content upgrade"调整入口):
 *   - 顶部常量表: 元数据经 ./meta PKG_META 引用(变量替换), lint 测试清单结构化;
 *   - 后续如需调整 setup.py/setup.cfg/test 文件, 只改本文件。
 *
 * 教学注释 L10N(2026-10-12):setup.py/setup.cfg 的教学注释以稳定 ID 查 l10n/templates 表
 * (en 源 + 各语种译文),按 `lang` 出单语生成物;缺省 "en" 时注释为英文源(历史中文由
 * zh-cn 表承载),代码行逐字节不变;5 个官方 lint 测试为上游原文,不译不入表。
 */

import { PKG_META } from './meta';
import { resolvePySetupStrings } from '../../../../../l10n/templates/index';
import type { TemplateCommentLang } from '../../../../../l10n/templates/index';

/** 纯 Python 包描述(仅 setup.py 元数据用; package.xml 描述在 package-xml.ts 各自内联) */
export const SETUP_DESCRIPTION = 'Pure-Python demo package (ament_python)';

/**
 * setup.py(定义 setuptools 打包/安装; console_scripts 注册节点入口)。
 * @param pkg 包名(与 package.xml <name> 及 <pkg>/ 模块目录一致)
 * @param nodes 示范节点模块名列表(空 = 无入口, 保留示例注释)
 */
export function renderSetupPy(pkg: string, nodes: string[], lang: TemplateCommentLang = "en"): string {
    // 教学注释表(按语种; 缺省 en,代码行逐字节不变)
    const T = resolvePySetupStrings(lang, { pkg });
    const entries = nodes.length === 0
        ? '        '
        : nodes.map((n) => `            '${n} = ${pkg}.${n}:main',`).join('\n');
    return `# ============================================================
${T.setupTitle}
${T.setupPurpose}
${T.setupNoCmake}
# ============================================================

from setuptools import find_packages, setup

########################################
${T.secBasic}
########################################

${T.pkgNameComment}
package_name = '${pkg}'

setup(
    name=package_name,
    version='${PKG_META.version}',

    ########################################
    ${T.secCollect}
    ########################################
    ${T.collectComment}
    packages=find_packages(exclude=['test']),

    ########################################
    ${T.secPkgData}
    ########################################
    ${T.pkgDataComment1}
    ${T.pkgDataComment2}
    ${T.pyTypedComment1}
    ${T.pyTypedComment2}
    package_data={
        package_name: ['py.typed'],
    },

    ########################################
    ${T.secDataFiles}
    ########################################
    data_files=[
${T.amentIndexComment}
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
${T.pkgXmlInstallComment}
        ('share/' + package_name, ['package.xml']),
    ],

    ########################################
    ${T.secDeps}
    ########################################
    ${T.installRequiresComment}
    install_requires=['setuptools'],
    ${T.testsRequireComment}
    tests_require=['pytest'],

    ########################################
    ${T.secMeta}
    ########################################
    ${T.zipSafeComment}
    zip_safe=False,
    maintainer='${PKG_META.maintainerName}',
    maintainer_email='${PKG_META.maintainerEmail}',
    description='${SETUP_DESCRIPTION}',
    license='${PKG_META.license}',

    ########################################
    ${T.secEntry}
    ########################################
    ${T.consoleScriptsComment}
    ${T.consoleFormatComment}
    ${T.consoleLibComment}
    entry_points={
        'console_scripts': [
${entries}
        ],
${T.addNodeExample}
        # 'node_name = ${pkg}.node_name:main',
    },
)
`;
}

/** setup.cfg(配合 setup.py 的打包配置; 指定可执行命令安装目录) */
export function renderSetupCfg(pkg: string, lang: TemplateCommentLang = "en"): string {
    // 教学注释表(按语种)
    const T = resolvePySetupStrings(lang, { pkg });
    return `# ============================================================
${T.cfgTitle}
${T.cfgPurpose}
# ============================================================

[develop]
script_dir=$base/lib/${pkg}

[install]
install_scripts=$base/lib/${pkg}
`;
}

/** test/ 目录的 5 个官方 lint 测试(固定内容, 不含包名/Node name) */
const TEST_COPYRIGHT = `# Copyright 2017 Open Source Robotics Foundation, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from ament_copyright.main import main
import pytest


@pytest.mark.copyright
@pytest.mark.linter
def test_copyright():
    rc = main(argv=['.', 'test'])
    assert rc == 0, 'Found errors'
`;

const TEST_FLAKE8 = `# Copyright 2017 Open Source Robotics Foundation, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from ament_flake8.main import main_with_errors
import pytest


@pytest.mark.flake8
@pytest.mark.linter
def test_flake8():
    rc, errors = main_with_errors(argv=[])
    assert rc == 0, \\
        'Found %d errors, %d warnings\\n%s' % (rc, len(errors), '\\n'.join(errors))
`;

const TEST_MYPY = `# Copyright 2025 Open Source Robotics Foundation, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from ament_mypy.main import main
import pytest


@pytest.mark.mypy
@pytest.mark.linter
def test_mypy() -> None:
    rc = main(argv=[])
    assert rc == 0, 'Found type errors!'
`;

const TEST_PEP257 = `# Copyright 2017 Open Source Robotics Foundation, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from ament_pep257.main import main
import pytest


@pytest.mark.linter
@pytest.mark.pep257
def test_pep257():
    rc = main(argv=['.'])
    assert rc == 0, 'Found code style errors / warnings'
`;

const TEST_XMLLINT = `# Copyright 2015 Open Source Robotics Foundation, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from ament_xmllint.main import main
import pytest


@pytest.mark.linter
@pytest.mark.xmllint
def test_xmllint() -> None:
    rc = main(argv=[])
    assert rc == 0, 'Found code style errors / warnings'
`;

/**
 * lint 测试文件清单(路径 + 固定内容; 生成顺序 = 数组序 = 迁移前 push 序)。
 */
export const LINT_TEST_FILES: readonly { path: string; content: string }[] = [
    { path: 'test/test_copyright.py', content: TEST_COPYRIGHT },
    { path: 'test/test_flake8.py', content: TEST_FLAKE8 },
    { path: 'test/test_mypy.py', content: TEST_MYPY },
    { path: 'test/test_pep257.py', content: TEST_PEP257 },
    { path: 'test/test_xmllint.py', content: TEST_XMLLINT },
];
