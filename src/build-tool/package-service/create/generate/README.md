# generate/ — 生成器组装(公共 API 门面)

> 两生成器把"用户配置 → 完整文件清单"串起来:解析配置 → 合成差异项(spec)→ 调 `../templates` 渲染 → 拼 `GeneratedFile[]`。
> **对外符号冻结**:本目录两个文件是测试与 `../command` 依赖的**公共 API**(函数签名/导出符号 = 契约),内部结构可继续演进。
> 纯逻辑、零 vscode,可 mocha 无头单测。
> 创建:2026-09-04 17:11(等价变换分类后补各子目录 README)。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `create-cpp-package.ts` | ament_cmake 系(三种 kind:`cpp-only` 纯 C++ / `cpp-dual` 双语言脚本 / `mixed` 混合模块)。入口 `generateCppPackageFiles(config)`;`resolveSpec` = kind 默认行(`../kinds`) + 用户覆盖(节点/依赖)→ 门面转发 naming 校验符号;**pythonOnlyDeps 通道**(2026-09-06):`config.pythonOnlyDeps ∪ 目录表 KNOWN_PYTHON_ONLY` 作纯 Python 运行依赖(仅 `<exec_depend>`) | `../naming/names`、`../kinds`、`../templates/*`、`../naming/generated-file` |
| `create-python-package.ts` | ament_python 系(纯 Python)。入口 `generatePythonPackageFiles(config)`;过滤默认 rclpy → package.xml/setup.py/setup.cfg/节点/5 个 lint 测试 | `../templates/package-xml`、`../templates/py-setup`、`../templates/py-node`、`../naming/generated-file` |

## 公共 API(冻结区)

- `create-cpp-package.ts`:`generateCppPackageFiles` / `CppPackageConfig` + 门面转发(validate/映射/isReservedFileName/NAME_MAX_LENGTH/类型 `CppNodeSpec`/`CppNodeInput`/`CppPackageKind`/`GeneratedFile`);
- `create-python-package.ts`:`generatePythonPackageFiles` / `PythonPackageConfig` + 门面转发(validate/parseNodeNames/validateNodeNamesInput/`GeneratedFile`);
- 维护边界:改函数签名/导出 = 改契约,须同步测试(`test/suite/create-*-package.test.ts`、roundtrip)与 `../command`。

## 等价红线

生成内容与历史版本**逐字节一致**(44 例生成矩阵对照)——本层只做组装;任何产物变化必须先改 `../templates` 并单独说明理由。

## 扩展位(后续调整入口)

- 新包类型/新节点形态 = `../kinds.ts` 加数据行 + `../templates` 加渲染函数,本层 `resolveSpec`/清单拼接小改;
- 新增生成文件类别(launch、include 头等)也在本层拼入清单。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 文档补登:create-cpp-package.ts 行补 pythonOnlyDeps 通道(2026-09-06 加入,当时只记在 create/README 同日行,本目录文档漏登) |
| 2026-09-04 17:11 | 建档:create/ 分类后补子目录 README——generate/(两生成器组装 + 公共 API 冻结区 + 等价红线) |
