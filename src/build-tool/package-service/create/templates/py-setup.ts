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
 */

import { PKG_META } from './meta';

/** 纯 Python 包描述(仅 setup.py 元数据用; package.xml 描述在 package-xml.ts 各自内联) */
export const SETUP_DESCRIPTION = 'Pure-Python demo package (ament_python)';

/**
 * setup.py(定义 setuptools 打包/安装; console_scripts 注册节点入口)。
 * @param pkg 包名(与 package.xml <name> 及 <pkg>/ 模块目录一致)
 * @param nodes 示范节点模块名列表(空 = 无入口, 保留示例注释)
 */
export function renderSetupPy(pkg: string, nodes: string[]): string {
    const entries = nodes.length === 0
        ? '        '
        : nodes.map((n) => `            '${n} = ${pkg}.${n}:main',`).join('\n');
    return `# ============================================================
# ${pkg}/setup.py: 纯 Python 包 (ament_python) 的构建脚本
# 作用: 定义 setuptools 的打包与安装方式
# Note: ament_python 包无 CMakeLists.txt, 构建入口为 setup.py
# ============================================================

from setuptools import find_packages, setup

########################################
## 基础信息 ##
########################################

# 包名 (与 package.xml 的 <name> 一致)
package_name = '${pkg}'

setup(
    name=package_name,
    version='${PKG_META.version}',

    ########################################
    ## 模块收集 ##
    ########################################
    # 收集 ${pkg}/ 目录下的 Python 模块 (排除 test/ 测试目录; 无 __init__.py 的目录本就不算包)
    packages=find_packages(exclude=['test']),

    ########################################
    ## 包内数据文件 (package_data) ##
    ########################################
    # 包内"non-.py"文件(类型标记/模板/json 等)默认不随包分发, 须在此显式声明;
    # 落点 = site-packages/<pkg>/ (与代码同目录, import 体系内, importlib.resources 可读)。
    # py.typed (PEP 561 类型标记): 必须显式声明才会随包安装;
    #   显式声明跨 setuptools 版本无害, 一律显式最稳。
    package_data={
        package_name: ['py.typed'],
    },

    ########################################
    ## 数据文件 ##
    ########################################
    data_files=[
        # 1) ament 索引地图标记 (resource/${pkg} 空文件): 存在 → ros2 工具可定位本包前缀
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        # 2) 安装 package.xml 至 share/<包名>/, 供 ros2 pkg/colcon/rosdep 等按约定路径读取
        ('share/' + package_name, ['package.xml']),
    ],

    ########################################
    ## 依赖 ##
    ########################################
    # Python 安装依赖 (ROS 依赖在 package.xml 声明)
    install_requires=['setuptools'],
    # 测试依赖
    tests_require=['pytest'],

    ########################################
    ## 包元数据 ##
    ########################################
    # zip_safe=False: 包内带数据/二进制/扩展时最稳 (zip 态下按 __file__ 相对定位读文件会失败)
    zip_safe=False,
    maintainer='${PKG_META.maintainerName}',
    maintainer_email='${PKG_META.maintainerEmail}',
    description='${SETUP_DESCRIPTION}',
    license='${PKG_META.license}',

    ########################################
    ## 节点可执行入口 ##
    ########################################
    # console_scripts 定义命令名与模块函数入口的映射
    # 格式: 'command name = module path.function name'
    # 生成的命令装至 lib/${pkg}/ (由 setup.cfg 的 install_scripts 指定落点), 供 ros2 run 定位
    entry_points={
        'console_scripts': [
${entries}
        ],
        # 新增节点示例 (按需追加):
        # 'node_name = ${pkg}.node_name:main',
    },
)
`;
}

/** setup.cfg(配合 setup.py 的打包配置; 指定可执行命令安装目录) */
export function renderSetupCfg(pkg: string): string {
    return `# ============================================================
# ${pkg}/setup.cfg: 配合 setup.py 的打包配置
# 作用: 指定可执行命令的安装目录
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
