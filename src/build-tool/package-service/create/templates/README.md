# templates/ — 模板正文(常量与段函数)

> create 子域的**产物内容层**:CMakeLists.txt / package.xml / setup.py / setup.cfg / 节点源 / lint 测试文件的全部正文与"可替换常量"都在本目录。
> **后续"生成包内容/注释升级"的调整主入口**——顶部常量表允许变量替换,正文单点维护。
> 内容与重构前逐字节一致(等价红线,由 44 例生成矩阵对照守护)。
> 创建:2026-09-04 17:11(等价变换分类后补各子目录 README)。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `meta.ts` | **共享元数据常量表** `PKG_META`(version=0.0.0 / license=Apache-2.0 / maintainer=you / email)+ `XML_DECL_LINES`(package.xml 声明两行)——package.xml 与 setup.py 共用 | — |
| `package-xml.ts` | 两种 package.xml 渲染:`renderAmentCmakePackageXml`(cpp-only/cpp-dual/mixed)与 `renderAmentPythonPackageXml`(ament_python);**共享段单本**:额外依赖按消费形态展开 `pushExtraDepTags`(buildtool/三标签/exec)+ 接口意图组声明 `pushInterfaceGroup`(member_of_group) | `../deps/dep-catalog`、`./meta` |
| `cmake.ts` | CMakeLists.txt 渲染 `renderCmakeLists(pkg, spec)`(统一模板,分模块激活);常量表:`CMAKE_MIN_VERSION` / `SAMPLE_EXE_NAME` / `SAMPLE_SCRIPT_PATH`;`cm()` 辅助生成 CMake `${VAR}` 文本;**头文件/库示例采用【约定 B】布局**(见"内容约定") | `../deps/dep-catalog`、logger |
| `cpp-node.ts` | C++ 节点源 `cppNodeSource(pkg, node)`(rclcpp 最小示范节点) | logger |
| `py-node.ts` | Python 节点源 `pyNodeSource(pkg, node)`——**全库唯一来源**(历史三处拷贝:cpp-dual 脚本 / mixed 模块 / ament_python 模块合一),差异只在文件落点,由 generate 决定 | logger |
| `py-setup.ts` | ament_python 构建/测试文件:`renderSetupPy`(console_scripts 注册节点入口)/ `renderSetupCfg` / `LINT_TEST_FILES`(5 个官方 lint 测试,固定内容) | `./meta` |

## 边界与依赖方向

- 被依赖方:`../generate`(渲染);`../deps/dep-catalog` 被本目录依赖(消费形态分类,单向);
- 本目录全部为渲染纯函数 + 常量,零 vscode;
- 修改提醒:**改本目录 = 改生成产物**,必须同步 44 例对照与 roundtrip/内容断言,并在修改记录留痕。

## 内容约定(2026-09-07):头文件布局 = 约定 B

模板中"对外提供头文件/库"示例块与安装段 `include/` 示例一律按【约定 B】(Humble+ 官方 / rosidl 双层同款):

| | 约定 A(旧) | 约定 B(现) |
|:--|:--|:--|
| 源码布局 | `include/<pkg>/x.hpp` | 同左(不变) |
| 安装落点 | `include/<pkg>` | `include/<pkg>/<pkg>` |
| 导出根 | `ament_export_include_directories(include)` | `ament_export_include_directories(include/<pkg>)` |
| 库 `INSTALL_INTERFACE` | `include` | `include/<pkg>`(`BUILD_INTERFACE` 仍指源码 include) |

三处(① 安装落点 `DESTINATION` / ② `ament_export_include_directories` / ③ 每个被导出 target 的 `$<INSTALL_INTERFACE:…>`)必须同值 = `include/<pkg>`:漏一处只影响下游找不到头,本包编译不报错(隐形炸弹)。
消费方写法不变(`#include <pkg/x.hpp>`),只是 `-I` 根变为 `<prefix>/include/<pkg>`;源码布局不变,故 `include/<pkg>/` 骨架目录照旧生成。
回归锁定:`test/suite/create-cpp-package.test.ts` 断言三处 B 值并禁止 A 残留。

## 生成注释口径(2026-09-28 立口径;2026-09-29 范本评审修订,用户逐条裁定)

生成配置文件(CMakeLists.txt / package.xml / setup.py / setup.cfg)与节点源中的**注释**是全扩展用户可见字数最多的
文字(用户定位:"相当于门面"),两条铁律:

**① 版本口径:生成文件内一律版本中立**——不出现发行版名(humble/Iron+…)、不写"双版本标注"、不写"本机实测"
(2026-09-29 用户裁定:在 humble 机器上看到 Iron 说明 = 版本错位;此前"双版本标注可用于生成文件"的口径就此废止,
跨版本差异只记在仓库内部文档)。落点类注释只说机制:"由本宏按构建机环境自动解析, 无需手动指定"。

**② 文风口径(2026-09-29 用户裁定)**:
- 禁特殊符号(⚠ 等),用"注意:"起头;
- 禁比喻("隐形炸弹"类),只作技术表述(错误现象/发生位置);
- 禁"官方"引用与"同款"措辞——应用说明为本,必要的原因一句话即可(官方会变,过多引用是埋雷,且有"别人都这样"的胁迫感);
- 应用决策不写过细的版本史/机制链(setuptools 版本号、sysconfig scheme 等),重实践,只保留**严重级别错误**的简要警示
  (如:接口定义与 ament_python_install_package 同包会构建失败;符号安装下 PROGRAMS 源文件须自身有可执行位)。

差异事实源:`手工重设计/gen-静态路径核实-2026-09-15.md`(C1/C2/C7)与 `手工重设计/12-发行版发现与gen模板分派-设计方案.md`。

**③ 内容对齐(2026-09-29 二次裁定,纠正"无需版本分支"的初判)**:文本中立(禁其他版本说明)与内容对齐(随机器版本
生成)是两回事——分派机制按 env.ROS_DISTRO 选文本变体,**选出的文本自身版本中立,且不引入"约定 A/B"概念**
(用户裁定:只提其一必引人追问其二,概念不进用户视野,简因规劝正确使用即可)。create 落点:`generateCppPackageFiles
.includeLayout` ← `resolveIncludeLayout(env.ROS_DISTRO)`(dashing~galactic=single 单层 / humble~lyrical=double 双层 /
未知与 rolling=double 兜底,查表单一事实源 = `config/gen/distro-templates`);cmake.ts 头文件块与 include 安装示例按此分支。
已知边界:EOL 档即使拿到对齐文本,CMAKE_MIN_VERSION=3.20 下限仍使其构建失败(备查档不支持);消费侧(gen 域)对
单层发行版的兼容靠 sys 组"子根枚举 + 末尾补前缀根"的父根行兜底,与 create 域无关。

## 扩展位(后续调整入口)

- 常量即开关:改 `./meta`、`./cmake` 顶部常量 → 全模板联动;
- 注释/结构升级、新节点形态(发布/订阅/服务/动作) = 在本目录加/改渲染函数,generate 层零改动;
- 新增包级文件(launch.py、include 头)可按同样风格在本目录建新渲染模块。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 22:34 | **③内容对齐落地(头文件布局按机分派,纠正 22:21"无需版本分支"初判)**:distro-templates 新增 `DISTRO_INCLUDE_LAYOUT`/`resolveIncludeLayout`(dashing~galactic=single 单层、humble~lyrical=double 双层、未知与 rolling=double 兜底,查表与模板表同覆盖);cmake.ts `CmakeSpec.includeLayout` 可选参 → 头文件块与 include 安装示例 if/else 双变体(single 单层形态:落点/导出根/INSTALL_INTERFACE 同值 include;两变体文本都版本中立、零"约定"概念——用户裁定"只提其一必引人追问其二");命令链 `create-package-command` 经 environmentFacade.getEnv() 注入;CppPackageConfig 透传。测试:distro +1(分派表覆盖与兜底)、create-cpp +1(single 三处同值 include + 无双层残留 + 无"约定"字样),五套 136 例全绿,tsc 干净 |
| 2026-09-29 22:09 | **生成注释定稿(范本评审制,用户逐行纠后落码)**:AI 提案 + 用户八条裁定 → cmake.ts/py-setup.ts 注释全面重写(代码行零改动)——①接口块重设计(重实践:独立成包一句 + "同装同名 Python 模块会构建失败"一条简注,去 ⚠/机制链/官方最佳实践);②头文件块去"约定 B/同款/隐形炸弹"(生成注释不携带版本与约定标签,错配后果改技术表述"错误发生在下游");③Python 模块段落点改纯机制自解析(去 Humble/Iron 双版本标注——生成文件版本中立铁律);④新增 PROGRAMS 符号安装可执行位提示、测试段"①②+test_depend 联动"、colcon test-result、rclpy"构建期校验"说明;⑤py.typed 去版本号考据、zip_safe 一句话化;⑥"别忘了"→"还应该"(用户措辞)。同步:公共块断言'## colcon build 只构建不运行测试';create-cpp 53 + create-python 31 全绿,tsc 干净;口径节改版(见「生成注释口径」) |
| 2026-09-29 18:07 | **注释版本核对(VD 联动)**:①修 cmake.ts Python 模块段注释错位(原"Humble: lib/python3.x/dist-packages"把 Humble 专有形态写成通用且漏 `local/` 前缀 → 机制自解析双形态标注);②py-node.ts 去"Humble 规范"锚定词(事实版本中立);③package-xml/setup/setup.cfg/cpp-node 核对零错位;新增本「注释版本口径」节(四条合法口径表);create-cpp 53 例(含 44 例字节对照)+ create-python 31 例全绿 |
| 2026-09-07 22:54 | 勘误补登:文件清单 `cmake.ts` 行常量表修正(原写 `CMAKE_STANDARDS`/`CMAKE_WARN_FLAGS` 为已不存在的常量,改为实际存在的 `CMAKE_MIN_VERSION`/`SAMPLE_EXE_NAME`/`SAMPLE_SCRIPT_PATH`/`cm()`),并标注"头文件/库示例采用约定 B";修改记录时间戳规范化(精确到分) |
| 2026-09-07 22:09 | 头文件布局统一【约定 B】:cmake.ts「对外提供头文件/库」示例与安装段 include 示例由 A(装 `include/<pkg>` + 导出 `include`)改 B(装 `include/<pkg>/<pkg>` + 导出根 / INSTALL_INTERFACE = `include/<pkg>`,三处同源);新增回归断言锁定 B、禁 A 残留;本 README 补"内容约定"节 |
| 2026-09-04 17:11 | 建档:create/ 分类后补子目录 README——templates/(产物内容层:常量表 + 段函数 + 单本 py 节点模板;后续内容升级主入口) |
