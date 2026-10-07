# create 子域 ·「文件名称 / 节点名称」命名范围研究

> 本文档回答一个设计前置问题:**输入框里填的名字,其合法范围到底由什么决定?**
> 该输入在生成时同时充当:文件基名 / ROS 节点名 / Python 模块名 / CMake target 名 / console_scripts 入口名。
> 各命名域的合法范围不同,本文档逐一明确;节点名结论直接来自 ROS 2 官方源码(rmw/rcl/rclpy rolling 分支),非二手资料。
> 建立:2026-09-01 02:13——节点名/文件名称命名范围研究建档;后续改动一律记入文末「修改记录」。

## 1. 结论速览

| 命名域 | 合法范围 | 权威来源 |
|---|---|---|
| ROS 2 节点名 | `^[A-Za-z_][A-Za-z0-9_]*$`,非空、不能数字开头、长度 ≤ 255 | rmw/rclpy rolling 源码 |
| Python 模块文件名 | 合法 Python 标识符(ASCII 子集,同上正则) | Python 语法 / PEP 8 |
| C++ 源文件名 / Python 脚本名 | 仅受 OS 文件系统约束(宽) | 文件系统规范 |
| CMake target 名 | 避免 `/ \ # ;` 与空格,惯例 `[A-Za-z0-9_]` | CMake 策略 CMP0037 |
| console_scripts 入口名 | 可含 `-`(如 pip-compile),等号右侧模块须为标识符 | setuptools 文档 |

关键事实:**节点名规则 ⊂ 合法 Python 标识符规则 ⊂ (一般)合法文件名规则**(ASCII 子集内三者一致)。由此:

- 输入只要满足**节点名规则**,则所有用途都合法 —— 这正是当前代码的策略;但当前还额外限制小写开头(比官方严,官方允许大写和 `_` 开头)。
- 若放宽到**文件名域**(允许 `-`),则只有 C++ 源文件 / Python 脚本可保留原输入,模块文件必须映射。

## 2. 节点名称的命名范围(权威,源码级)

### 2.1 规则

来源:ros2/rmw `rmw/src/validate_node_name.c`(`rmw_validate_node_name_with_size`);
rcl 在 `rcl/src/rcl/node.c:146` 调用同一函数;rclpy 的 `validate_node_name`(`rclpy/rclpy/validate_node_name.py`)只是对同一 C 实现的 Python 包装。rclcpp 经 rcl 走同一条路径。

1. **非空**
2. **仅允许 ASCII 字母/数字/下划线** `[0-9A-Za-z_]`(`rcutils_isalnum_no_locale` 判定,非 ASCII 一律拒绝)
3. **不能以数字开头**(`isdigit(node_name[0])`)
4. **长度 ≤ 255**(`RMW_NODE_NAME_MAX_NAME_LENGTH`,头文件注释 "arbitrary constraint")

**两个易错点**:

- 大写字母**合法**(`MyNode` 可通过官方校验),当前项目正则 `^[a-z][a-z0-9_]*$` 比官方严;
- 以 `_` 开头**合法**(仅数字开头被禁)。

等价正则:`^[A-Za-z_][A-Za-z0-9_]*$`(长度 ≤ 255)。

### 2.2 失败样本(rclpy 测试 `test_validate_node_name.py`)

`''`(空)、`'invalid_node.'`、`'invalid_node?'`、`'/invalid_node'` → 全部拒绝。
即 `.` `?` `/` 等一律非法;`~`、空格同理(源码只放行字母数字下划线)。

### 2.3 对生成代码的影响

生成的 `Node("<node>")`(rclcpp/rclpy)运行期走同一校验:
`Node("my-node")` → 运行即抛错;`Node("my_node")` → 合法。

## 3. 文件名称的命名范围

### 3.1 OS 层(写盘即时约束)

Windows(本扩展运行环境,NTFS):

- 禁止字符:`< > : " / \ | ? *`
- 不能以空格或点结尾;不能是保留设备名:`CON PRN AUX NUL COM1–9 LPT1–9`(带扩展名也禁,如 `con.py`)
- 单组件 ≤ 255 字符;路径默认上限 260(启用长路径后 32767)
- **不区分大小写**:同目录 `my_node.py` 与 `My_Node.py` 冲突

Linux(ROS 部署目标,ext4):

- 仅禁 `/` 与 NUL;组件 ≤ 255 字节;区分大小写

### 3.2 上下文层(ros2 / ament 构建与运行约束)

| 用途 | 文件名位置 | 附加约束 |
|---|---|---|
| C++ 源文件 | `src/<n>.cpp` | 编译不关心文件名,OS 层即可;但 CMake target 名有约束(见下) |
| Python 脚本(cpp-dual,PROGRAMS 安装) | `scripts/<n>.py` | 仅作可执行脚本、不被 import → OS 层即可,`my-node.py` 可正常 `ros2 run` |
| Python 模块(mixed 的 ament_cmake_python、ament_python) | `<pkg>/<n>.py` | **必须为合法 Python 标识符** `^[A-Za-z_][A-Za-z0-9_]*$`: `import pkg.my-node` 语法错误;setup.py 入口 `'x = pkg.my-node:main'` 同样非法 |
| CMake target(`add_executable(<n> src/<n>.cpp)`) | — | 避免 `/ \ # ;` 与空格(CMake 策略 CMP0037,历史版本直接报错);连字符可用但不合惯例,建议 `[A-Za-z0-9_]`;目录内须唯一 |
| console_scripts 入口名(ament_python setup.py) | — | 命令名可含连字符(生态例:pip-compile、py-spy);但等号右侧 `pkg.<module>:main` 的 module 必须为标识符 |
| `ros2 run` 可执行发现 | `lib/<pkg>/` 下文件 | 任意文件名为命令名,原样查找 |

## 4. 交集 → 输入规则设计依据

输入同时作用于五处,合法范围取交集:

| 用途 | 约束 |
|---|---|
| 节点名 | `^[A-Za-z_][A-Za-z0-9_]*$`(≤255) |
| Python 模块文件名 | `^[A-Za-z_][A-Za-z0-9_]*$`(标识符) |
| C++ 源文件 / Python 脚本名 | OS 层(宽) |
| CMake target | 避免 `/ \ # ;` 空格 |
| console_scripts 入口 | 任意(可含 `-`),模块须标识符 |

- **交集(最严,全场景一个名字)**:`^[A-Za-z_][A-Za-z0-9_]*$`。
  当前代码即此策略,但额外限制小写(比官方严,属风格选择而非必要)。
- **放宽到文件名域(允许 `-`)**:映射 `-`→`_` 后
  - C++ 源文件 / Python 脚本:文件保留原输入(`my-node.cpp`),内部节点名用映射(`my_node`) → **可行**;
  - Python 模块(mixed / ament_python):文件必须用映射名(`my_node.py`),原输入无法保留 → "输入即文件名"仅在非模块场景成立。

## 5. 对当前生成器的具体影响

| 包类型 | Python 节点形态 | 文件名可否保留 `-` |
|---|---|---|
| cpp-dual | `scripts/` 脚本 | ✅ 可保留 |
| mixed | `<pkg>/` 模块 | ❌ 必须映射名 |
| ament_python | `<pkg>/` 模块 + setup.py 入口 | ❌ 模块文件必须映射名(入口名可保留 `-`) |

## 6. 参考

- ros2/rmw rolling:`rmw/src/validate_node_name.c`、`rmw/include/rmw/validate_node_name.h`
- ros2/rcl rolling:`rcl/src/rcl/node.c`(L146 调用 rmw 校验)
- ros2/rclpy rolling:`rclpy/rclpy/validate_node_name.py`、`rclpy/test/test_validate_node_name.py`
- CMake 策略 CMP0037(target 名特殊字符)
- setuptools Entry Points 文档(console_scripts 名可含连字符)
- Microsoft Windows 文件命名文档(保留字符 / 设备名)

## 7. 实施决策(2026-09-01, 已落地)

按 §4/§5 结论,输入语义定为「文件基名」,并按包类型分流两条校验/映射路径:

### 7.1 总原则

- **文件基名 = 用户输入,原样写盘**(真实对应,不顺延)。
- **文件层面冲突由输入框校验兜底**(同框重复 / 非法字符 / Windows 保留设备名),校验做不好不是顺延的理由。
- **顺延只发生在节点名层面**:有损映射(宽文件名域 → 节点名域)的结果冲突时,对节点名追加 `_1`/`_2`…,文件基名不动。

### 7.2 两条路径

| 节点形态 | 输入 = | 输入框校验 | 文件 | 节点名 / target | 顺延 |
|---|---|---|---|---|---|
| C++ 节点(三类包) | 文件基名(宽, 如 `my-node`) | `validateFileBaseNamesInput`: `^[A-Za-z_][A-Za-z0-9_-]*$` + 保留名 + 同框去重 + ≤250 | `src/<基名>.cpp` 原样 | `disambiguateNodeNames`: `-`→`_` + 冲突顺延 | ✅ 必须(CMake target 唯一性) |
| Python 脚本(cpp-dual) | 文件基名(宽) | 同上 | `scripts/<基名>.py` 原样 | 同上(仅 `Node("…")` 用) | ✅ 顺带(防图内重名, 不影响构建) |
| Python 模块(mixed / ament_python) | 标识符(`my_node`) | `validateNodeNamesInput`: `^[A-Za-z_][A-Za-z0-9_]*$` + 保留名 + 关键字 + 去重 + ≤250 | `<pkg>/<名>.py` 即输入(文件===模块===节点名) | 恒等, 无映射 | ❌ 不需要(无有损映射) |

### 7.3 关键实现点

- `CppNodeSpec { file, node }`: 生成器按 `file` 写盘、按 `node` 生成 `Node("…")`/CMake target;`add_executable(<node> src/<file>.cpp)`。
- 字符串输入归一化为恒等 spec(`file === node`),模块场景直接传字符串。
- 有损映射仅替换连字符:`toNodeName('my-node') === 'my_node'`(输入规则保证结果必为合法节点名)。
- 节点名长度上限 250(`NAME_MAX_LENGTH`):含扩展名后不超 Windows 组件 255,且不超 rmw 节点名 255。
- 模块文件必须用合法标识符(文件=模块名, `import pkg.my-node` 为语法错误),故 mixed/ament_python 不接受连字符输入。
- 模块名校验含 **Python 3 关键字黑名单**(35 个,如 class/def/import/True):命中即报错——否则会生成 `import pkg.class` 语法错误的包。仅模块路径需要;C++ target 与 scripts 脚本无关键字概念。
- 依赖弹窗 **Esc 与包名/节点一致**:返回 null → 终止整个流程(2026-09-01 起;此前为"当空跳过")。

### 7.4 拆除的旧逻辑

- `validateCppNodes`(报错重输循环)整体移除——输入框实时校验覆盖格式/重复,映射冲突交给顺延,无重输。
- 原「跨语言互斥」注释系过期描述:跨语言(跨目录)同名本就允许,现行为与注释一致。

### 7.5 装配(2026-09-01 起)

- 命令注册经 `create/index.ts` 出口由 **extension 直连**(与 colcon 同模式):`registerCreatePackageCommands(context)` 在 extension.ts 调用,不再经 `commands/index.ts` 转发。

### 7.6 模块地图(2026-09-04 按职能分类完成,全部 git mv 保留历史;等价变换,产物逐字节不变)

| 目录/文件 | 职能 | 内容 |
|:--|:--|:--|
| `index.ts`(根) | 子域出口(extension 直连) | — |
| `kinds.ts`(根) | kind 注册表: 默认节点行 + `KIND_DEFAULT_DEPS`(单一数据源, 兼作 dep 域 DEP_BUILTIN) | — |
| `command/` | 命令注册 + 交互向导(弹窗收集 → 写盘 → ingestPackageCreated) | `create-command.ts` / `create-package-command.ts` |
| `naming/` | 命名/校验/映射**单一来源** + 生成文件模型 + 目录冲突校验 | `names.ts` / `generated-file.ts` / `package-folder.ts` |
| `generate/` | 生成器组装(**公共 API 门面**, 测试与交互层 import 兼容) | `create-cpp-package.ts` / `create-python-package.ts` |
| `templates/` | 模板正文(顶部常量表允许变量替换; Python 节点模板**全库唯一**) | `cmake.ts` / `package-xml.ts` / `py-node.ts` / `cpp-node.ts` / `py-setup.ts` / `meta.ts` |
| `deps/` | 依赖域(候选/解析/合并/分类/来源判定) | `dep-catalog.ts` / `dep-parse.ts` / `dep-merge.ts` / `dep-lang.ts` / `dep-pick.ts` |

依赖方向单向: command → generate/naming/deps;generate → naming/kinds/templates/deps;deps → naming/kinds;templates → deps —— 无反向环。
生成内容与重构前逐字节一致(44 例生成矩阵对照);"文件基名=输入原样写盘、有损映射只发生在节点名层"语义(§4/§7)不因搬移改变。
各子目录均有独立 README 详解文件职责与扩展位:`command/README.md` / `naming/README.md` / `generate/README.md` / `templates/README.md` / `deps/README.md`(2026-09-04 补)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-07 | **向导弹窗标题化 + 弹窗族 i18n 清残(用户拍板「全部弹窗+残余清残」)**:6 弹窗(包名/依赖多选/自定义依赖/C++ 示范节点/Python 示范模块·脚本/Python 包示范节点,含降级输入框)统一标题「流名 - 步骤」(如「生成 C++ 包 - ① 包名」,流名与步骤均 l10n 键);占位符「例如: …」、Python 示范节点 prompt(原裸中文)、「混合」toast 碎片进 l10n;分域细节见 command/deps/naming 三 README 同日行 |
| 2026-09-29 22:34 | **头文件布局按机分派(内容对齐③)**:创建包时按 env.ROS_DISTRO 经 resolveIncludeLayout 选布局文本变体(dashing~galactic 单层/humble~lyrical 双层/未知兜底双层),变体文本版本中立、不引入"约定 A/B"概念;命令链接 environmentFacade,查表事实源在 config/gen/distro-templates;详见 templates/README 修改记录 |
| 2026-09-29 22:09 | **生成注释定稿(范本评审制)**:两份生成范本(CMakeLists/setup.py)先经用户逐行纠(八条裁定 + "别忘了→还应该")再落码——templates/ 注释按「生成注释口径」两条铁律重写(版本中立 + 文风四禁),代码行零改动,公共块断言同步;详见 templates/README 修改记录 |
| 2026-09-29 18:07 | **生成注释版本核对(VD 联动,用户裁定"重点不是能用,是配置文件注释不能版本错位")**:templates/ 生成产物注释逐条过"版本错位"审计——①修 cmake.ts Python 模块段落点注释(原"Humble: lib/python3.x/dist-packages"既把 Humble 专有形态写成通用、又漏 humble 实际的 `local/` 前缀 → 改为机制自解析双形态:Humble = local/…dist-packages;Iron+ = lib/…site-packages,手稿 C2);②py-node.ts 去"Humble 规范"锚定词(rclpy.init() 返回 None 在各现役发行版一致,事实本身版本中立;09-06 14:29 行为历史动因留档);③package-xml.ts / setup.py / setup.cfg / cpp-node.ts / 一键配置写入(configure-actions 仅 install DIRECTORY launch 两行+日期戳)核对为版本中立或正确限定,零错位;细则与口径表见 templates/README「注释版本口径」节 + 手工重设计/12 §11;create-cpp 53 例(含 44 例字节对照)+ create-python 31 例全绿 |
| 2026-09-14 (实施) | 依赖候选来源修订(**工作区叠加反转**): 候选 = `unignored ∪ system`(工作区已确认包**含未构建** + 环境可见包, 按名去重、工作区在前); 理由 ① 工作区侧名称已过 package-core 合法性检查, 与「自定义输入」相比更严, 排除无依据 ② `system` 语义改为"只表示工作空间以外" → 只用 system 会漏包; 新增纯函数 `dep-lang.unionCandidateNames`(+6 单测), `dep-pick.fetchCandidates` 改并集、降级判据改"两侧皆空"; 详见 04 文档 §1/§3/§7 与 deps/README |
| 2026-09-06 14:47 | 依赖"语言/来源"策略(完整版): ①dep-lang.ts 判定——候选(system, 无路径)与**未忽略工作区域取交集**(命中=本工作区包, 用其 buildType 权威判纯 Python; 未命中=已删残留/外部工作区/未知, 不验证不标注; 同名重叠视为本工作区覆盖); ②目录表 KNOWN_PYTHON_ONLY 已知纯 Python 系统包; ③cpp-only 勾纯 Python → 拦截(C++ 不消费 Python); ④cpp-dual/mixed 纯 Python 依赖走 pythonOnlyDeps 通道(仅 <exec_depend>, 不 find_package, CMakeLists 注记); 单测 137 全绿(新增 dep-lang.test 与生成器通道用例); 样例包 p16_dual_py_dep |
| 2026-09-06 14:29 | Python 示范节点模板改 Humble 规范(py-node.ts): 删除新版 ROS2 的 `with rclpy.init()` 写法(Humble 下 init 返回 None —— Pylance 报错且运行必崩) → `init → 建节点 → destroy_node → shutdown`; node 变量实际使用(Ruff F841 消除); 移除 ExternalShutdownException import; 相关单测 83 用例全绿, py_compile 复查 45 文件通过, 15 包整树重生成 |
| 2026-09-05 23:36 | CMakeLists 直观示例代码块回归(用户评审): 真实生效代码 + 完整注释示例块(加节点三行 / rosidl_generate_interfaces+msg·srv·DEPENDENCIES / 头文件与真库公开 4 连 / launch·urdf·include 的 DIRECTORY), 取消注释即用; 单测 130 全绿; 基线 v4 |
| 2026-09-05 18:11 | 生成内容知识修订(依据 知识/ 全批): package.xml 描述/说明按 kind 名实相符(纯 C++/双语言/混合); CMakeLists 改官方默认宏 ament_target_dependencies(去可执行库残影) + 动态头注 + 接口独立成包/DEPENDENCIES/ros2 run 带 .py 用法注释; setup.py 补 package_data=py.typed(Humble 不自动携带) + zip_safe=False + data_files 地图注释; GeneratedFile.exec(PROGRAMS 脚本源 +x, symlink 下 ros2 run 不丢); 单测同步 130 全绿; 基线 v3(.tmp/create-baseline-v3.json) |
| 2026-09-04 17:10 | create/ 按职能分目录(git mv 保留历史): 新建 command/(注册+向导)/ naming/(命名+文件模型+目录冲突)/ generate/(生成器组装, 公共 API)/ deps/(依赖域), kinds.ts 留根, templates/ 原样; 全部 import 与测试路径同步; tsc + 130 用例 + 44 例字节对照全绿; §7.6 落表 |
| 2026-09-04 17:04 | 等价变换结构重构(设计稿: 设计/重构/package-service/create域大改设计方案-2026-09-04-1641.md): 命名/映射/校验下沉 names.ts 单一来源(消除两生成器 validatePackageName/PACKAGE_NAME_RE/GeneratedFile 重复与 py/dep 对 cpp 的反向 import); kind 默认节点行与内置默认依赖入 kinds.ts(取代 kindSpec 三分支 + DEP_BUILTIN 双份); 模板正文收敛 templates/(CMakeLists/package.xml 两种渲染/节点/setup 文件; Python 节点模板三处拷贝合一); PKG_META/CMAKE_* 常量表允许变量替换; 生成器瘦身为组装, 原文件名保留为公共 API 门面(import 兼容); 44 例生成矩阵逐字节对照 + 130 用例全绿 |
| 2026-09-01 15:48 | 模块名校验增加 Python 3 关键字黑名单(35 个, class/def/import 等命中即报错, 防生成 import 语法错误的包);依赖弹窗 Esc 改为终止流程(与包名/节点一致, 此前为当空跳过);§7.2/§7.3 同步 |
| 2026-09-01 18:50 | 装配直连:命令注册经 create/index.ts 由 extension 直连(registerCreatePackageCommands 移出 commands/index.ts,与 colcon 08-31 同模式);§7.5 落表 |
| 2026-09-01 02:40 | 修改记录格式规范化:文末「最后修改」行改为「修改记录」表(时间精确到分钟,新在上) |
| 2026-09-01 02:36 | 补 §7「实施决策」:输入语义定为文件基名;C++/脚本宽范围校验 + 有损映射(-→_) + 节点名顺延,模块恒等无映射;拆除 validateCppNodes 重输循环;标识符规则放宽到官方 rmw 范围(允许大写/下划线开头);新增 validateFileBaseNamesInput / toNodeName / disambiguateNodeNames / CppNodeSpec;三份测试同步(75 用例全过) |
| 2026-09-01 02:13 | 建档:节点名称/文件名称命名范围研究——节点名结论取自 rmw/rcl/rclpy rolling 源码(^[A-Za-z_][A-Za-z0-9_]*$,非空/非数字开头/≤255);文件名称分层(OS 层:Windows 保留字符与设备名;上下文层:Python 模块须标识符、CMake target CMP0037、console_scripts 可含连字符);交集结论支撑 §4 设计依据 |
| 2026-09-01 21:01 | 依赖多选落地:新增 dep-pick.ts(交互壳)/dep-merge.ts(纯函数), dep-parse.ts 加 depAnnotation, inputDeps 变薄委托 pickDeps;数据源走 package-core system 域(null → 现跑 pkg_list, [] → 降级), 详见 04-包创建依赖多选-具体设计方案.md |
| 2026-09-01 21:06 | 依赖多选细化:内置依赖自动隐藏(excludeBuiltin), 元信息标注去 emoji 改纯文本 |

