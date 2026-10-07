# src/languages/launch/ — launch 文件语言服务

> 收拢 launch 文件静态编辑能力(不做动态解析/树/执行):.launch.py/XML/YAML include 链接(DocumentLink;py 于 2026-09-08 解冻恢复)+ **三格式(.py/XML/yaml)结构补全与包名值补全(2026-09-05)**。
> 方向基准:设计/新功能/05-launch解析收缩与可执行映射-交接文档.md(收缩为写文件能力)。

## 1. 文件清单(LD-6.5 分层,2026-09-30:10 TS + 7 MD)

> 2026-09-30 起 core/(纯逻辑)/ parse/(py 文本解析)/ ui/(vscode 提供器)三层,注册入口 providers.ts 留根;
> 全部 git mv 迁移(历史不变),各层细则见 core|parse|ui 各自 README.md(格式同本文件)。

| 文件 | 层 | 职责 / 导出 |
|:--|:--|:--|
| providers.ts | 根 | 注册入口 registerLaunchProviders(packages?):共享 PackageMap 复用 + py/XML/YAML include 链接 + 三格式补全/解析跳转/悬浮统一注册(LA-1/2/3、LD-3/LD-5) |
| core/launch-completion-core.ts | core | 补全纯核心(零 vscode,1147 行):结构片段目录(py 14 条/XML/yaml)+ 三格式光标上下文(pyAttrContextAt/xmlCursorAt/yamlCursorAt 等)+ 候选生成;LC-2/3 尾段 $() 判定(substCommandPrefixAt/varArgTypedWordAt,LD-2 值中后续 $() 亦识别);LC-6 kwargs 目录;PY_ATTR_TAIL_RE(LD-2 收编 output/respawn) |
| core/launch-args.ts | core | 参数声明提取(LC-1,215 行):三格式统一 LaunchArgDecl{name, default?, declOffset, declLineText}——py DeclareLaunchArgument 掩码扫描 / xml `<arg>` lezer / yaml `- arg:` 块;declLineText 供悬浮(LD-5 首消费方) |
| parse/launch-py-parser.ts | parse | launch.py 文本扫描(510 行):maskPythonNoise(注释/docstring 等长掩码)、collectSimpleVars(简单赋值变量表)、scanLaunchIncludes(join+语义门[含 AnyLaunchDescriptionSource];**LD-4 呈现范围收窄为末段字面量引号内内容**,全跨度 covered 供字面量去重;解析失败静默过滤)、scanLaunchNodes(死导出遗留)、pyNodeCallAt(LA-3,值 range 不含引号) |
| ui/launch-completion.ts | ui | 三格式补全提供器 + registerLaunchCompletionProviders(730 行):LC-4 include 路径单层(**LD-2 不设 range**,词边界防抹前缀)、LC-5 跨文件传参名(uri+mtime 缓存)、InstallTruthExecSource(LA-2)、**LD-2 词锚 range**(subst-cmd/arg-ref)、LD-6 pkg/exec detail |
| ui/launch-definition-provider.ts | ui | 解析跳转(232 行,LA-3/LD-3):XML node pkg/exec→包目录/install-truth 源、include→目标;py Node 值位/include;**yaml pkg:/exec:/file:(LD-3 补齐)**;落点=文件+line 0;LA-1 域门控 |
| ui/launch-hover-provider.ts | ui | 三格式悬浮(248 行,LD-5):包落点/exec 源/include 目标/$(var N) 声明行+默认值/kwarg·属性·yaml 键 |
| ui/launch-link-provider.ts | ui | XML include 链接(147 行)+ **resolveLaunchIncludePath 共享解析导出**(find-pkg-share 经 PackageMap.resolvePackageDir 懒取,其余经 resolveFileRef);**LD-3 selector 去语言双条件改纯 pattern** |
| ui/launchpy-provider.ts | ui | .launch.py DocumentLink + Hover(82 行;**LD-4 起 range=末段字面量引号内内容**);解析不成功静默 |
| ui/yaml-link-provider.ts | ui | YAML include 链接(124 行;`- include:` 块 file: 值 → 复用 resolveLaunchIncludePath) |
| 01-launch模块审计.md / 02-补全升级.md / 03-补全跳转修缮.md | 根 | 设计文档(审计 / LC 批次 / LD 批次) |
| README.md + core\|parse\|ui/README.md | 根+层 | 本文件与三层 README(LD-6.5 建档) |

## 2. 接线

- extension.ts registerLaunchProviders(xacroPackages),与 xacro 共享 PackageMap(09 设计定稿,消除重复扫描);
- .launch.py include 跳转(**2026-09-08 解冻恢复**,pattern **/*.launch.py):口径 = 文件内静态解析(简单赋值变量可代,外部变量假设不存在),**解析不成功静默**(不给假链接、不弹"目标未解析");XML 链接 {language:xml} + pattern 仍注册;
- XML/YAML include 链接(2026-09-06):xml 与 yaml 共用同一解析 resolveLaunchIncludePath(launch-link-provider.ts 导出)——find-pkg-share 经 PackageMap.resolvePackageDir、其余经 resolveFileRef、existsSync 门;yaml selector 纯 pattern **/*.launch.yaml|yml(免语言绑定盲区);
- 补全(2026-09-05):providers.ts → registerLaunchCompletionProviders(pkg)——py(pattern **/*.launch.py,触发 '"/")、XML(pattern **/*.launch|*.launch.xml,触发 < " ')、yaml(pattern **/*.launch.yaml|yml,触发 ' " : -);包名名单经 PackageMap.getPackageNames(2026-09-05 新增:工作区排序 + 系统名单就绪时并入);
- **静态 snippet 已退役(2026-09-07)**:原 snippets/launch-py.json / launch-xml.json(按 python/xml 语言全量注册)造成"非 launch 文件也列 launch 片段"的补全污染,且描述中英混杂——已从 package.json 移除注册并删除文件;**先全量转制、后删静态(与 xacro"转代码补全后删静态"同款)**:py 12 条保真(含整文件模板/Node 简单与重映射变体/导入块)+ XML 主标签 12 + 附加 9 条(整文件模板/带命名空间·块节点/无默认值 arg/带子 arg include/from YAML param/$(var)/$(env)/$(find-pkg-share) 替换),原 prefix(ros2launch/ros2node/ros2findpkg…)并入 keywords/filterText 保留肌肉记忆;yaml **刻意不建静态 snippet**(yaml 语言含 rviz 等非 launch 文件,静态会全 yaml 污染),其补全由代码提供器按 pattern **/*.launch.yaml|yml 精确承载。
- **补全条目参数约定(2026-09-08,与 xacro 同规)**:① label = `标识符/拉丁(中文)`——同前缀重复片段中文后缀消歧、绝不打头;② **filterText = 插入结构头部主词 + keywords + label 英文词,纯 ASCII**(`headTokens`:去 import/from 引导、${…} 占位、引号值、标点后取前 3 标识符,如 `<env name=…/>` → `env name value`)——中文不进过滤、模糊匹配不受中文干扰;③ **snippet 项 documentation = 完整插入体代码块预览**(detail 页展示结构);④ detail = 中文一句话说明;⑤ sortText 片段=1/值·枚举=2/属性=3;⑥ yaml insert 内 `${0}` 在模板串必须写成 `\${0}`,否则被 JS 插值成字面 "0"。

## 3. 关键问题与遗留(审计 L-* / 05 任务)

| 项 | 状态 |
|:--|:--|
| .launch.py include 跳转 | ✅ **解冻恢复(2026-09-08,用户澄清:冻结对象是"可执行文件跳转",非启动文件 include)**——恢复注册并升级:简单赋值变量表(collectSimpleVars)、语境含 AnyLaunchDescriptionSource、**解析失败静默过滤**;注释/docstring 掩码与语义门保留(误报面不回潮) |
| 05 task1 删 launch 树 | 半做:UI 已清,文件注释保留;scanLaunchNodes/launch.test.ts/dumper 残留待清 |
| 05 task2 IncludeLaunchFile | 未做(L-F3;主流 IncludeLaunchDescription 经 os.path.join 内层部分兜住) |
| 05 task3 XML include 切 PackageMap | ✅ 已做(2026-09-03 23:16:registerLaunchLinkProvider(packages),共享 PackageMap.resolvePackageDir/resolveFileRef) |
| 05 task4 yaml launch | ✅ 已做(2026-09-06 23:44):**yaml 格式支持 include(官方样例不同格式三写验证)**;include 跳转已实现(yaml-link-provider);结构/包名补全已提供 |
| 05 task7 可执行补全 | 未做(依赖已构建产物名单,见本 README「待决」再评估四;v1 值补全只做包名;**可执行跳转 = 09-06 冻结所指对象,维持不做**) |
| 三格式结构/包名补全 | ✅ 已做(2026-09-05 18:00:py/XML/yaml CompletionItemProvider,见 §1/§2) |
| 扫描正确性 | ✅ L-F1/F2 已收窄(2026-09-05 23:52):注释/三引号 docstring 掩码(maskPythonNoise,等长保 offset)+ join 分支加 launch 语义门(末段 .launch.(py|xml|yaml) 且处于 include/DescriptionSource 上下文,2026-09-08 扩 AnyLaunchDescriptionSource);残留 L-F3(IncludeLaunchFile 主流写法)、L-F5(resolveLiteral 与 resolveFileRef 重复,纯冗余非误报) |
| 死面 | L-F4:scanLaunchNodes/LaunchNode 无活跃消费 |

## 4. 测试

test/suite/launch-py-parser.test.ts(**2026-09-08 改口径:静默 + 变量正例/外部变量负例/绝对路径正例**,vscode host)/ launch-link-provider.test.ts / launch-yaml-link.test.ts(2026-09-06,集成:vscode.executeDocumentLinkProvider)/ launch-completion.test.ts(2026-09-05,24 用例纯核心,无头可跑)/ launch.test.ts(dumper 遗留,待删)。缺口:LaunchPy DocumentLink/Hover 集成用例(依赖 vscode host)、补全侧适配层集成用例。

## 待决:系统可执行能力归属(2026-09-03 记录,未实施)

> 需求来源:launch/ 的**可执行文件跳转**(如 .launch.py 中 executable= / Node 可执行引用 → 跳到系统安装包的可执行文件),需要"系统包 → 可执行名/精确路径"。
> 背景:系统包**名单**(package-core system 域)、**目录**(PackageMap.resolvePackageDir,已收拢)、**可执行**(Ros2ServiceApi.pkg_executables)——可执行目前无中心封装,唯一活跃消费者 = deprecated ros-cli(rosrun);exe-map 只覆盖工作区源码包(setup.py/CMakeLists 静态解析),不含系统包(05 task7 缺口原样保留)。
> 定稿(用户,2026-09-03 23:49):**方案二——由 PackageMap 开辟专供 launch 的系统可执行能力**(如 resolveSystemExecutable(pkg, exe):可执行名经 pkg_executables、精确路径拼 prefix 根/lib/<pkg>(非 --share),对齐 2026-08-23《优化-系统包访问统一入口》);**不改 exe-map**(工作区读侧中心保持单一职责)。
> 状态:**仅记录,未实施**;实施时同步本 README / shared/package-map.md / 00-总览。

### 再评估一(2026-09-04 17:46,用户):维持断电、三步路线 —— ⚠️ 已被 2026-09-05 09:11 修正替代,保留作历史

> 起因:launch 可执行跳转是否值得做 → exe-map 是否有必要"通电"(2026-09-04 断电后)重新进入讨论。
> 复核事实:
> - 断电因果自洽:exe-map 消费方(write 01/02)退役 → 生产者断电;代码留档、tsconfig exclude、冻结前五套件 92 用例绿,**断电非质量问题**;
> - 通电拆三件事、难度分层:① exe-map 本体通电(取消 exclude + extension 接线 + 恢复 3 套件)= 便宜;② launch.py 扫描准确率 = 真正难点所在 **launch 侧不在 exe-map 侧**(无注释/字符串剥离,L-F1;Node 参数须字面量门控,动态写法标未解析);③ "跳到哪个文件"的语义待定 = 期望管理根源(consoleScript → 源 module 文件 vs install 启动脚本;cmake → add_executable 首个源文件 vs build 产物,未构建时产物不存在;exe-map ExecutableEntry 现仅 name/kind/dynamic,底层 parse 已含 module/sources 但被裁);
> - 价值排序:可执行名最常见错误是拼错/包未构建(运行时才炸)→ hover/诊断(名→归属)先于跳文件;
> - launch/README 待决的**方案二仍为若实施时的归属定稿**(系统可执行走 PackageMap,不改 exe-map)。
> 终裁(用户):**先不通电,结论落档**——exe-map 维持断电,launch 可执行感知(含系统侧 resolveSystemExecutable)整体延后,待真实使用痛点出现再启动。落档路线(若未来启动,三步可独立停):
>   1. 名级 hover + 包跳转,不依赖 exe-map:复活 scanLaunchNodes(补注释/字符串剥离 + 字面量门控),Node(package=) 包目录跳转(PackageMap 现有),executable= hover 显归属/命中/动态未解析;系统可执行名走方案二;
>   2. exe-map 读侧通电:取消 tsconfig exclude + extension 接线(带 dispose),暴露 executablesOf(name) 供 launch 工作区"可执行名 → 源文件"跳转;ExecutableEntry 增可选 source 提示字段(底层 parse 已有数据);
>   3. 明确不做:write 复活、03 一键启动、XML/yaml 可执行跳转(yaml 连 include 都未做)。
>
> **该路线 ② 步(经 exe-map 通电做工作区跳文件)系概念错位,已被 09-05 再评估二推翻,勿按此实施。**

### 再评估二(2026-09-05 09:11,用户):install 真值路线 —— ⚠️ 方向保留,"fs 扫描"细节已被 2026-09-05 17:33 再评估三修正替代,保留作历史

> 盲点复核(用户提出):**为什么从配置文件解析可执行?而不是从 install 安装目录解析?**——launch `executable=` 的语义是"实际会执行的文件",真值在安装树 `<prefix>/lib/<pkg>/<exe>`,不在 setup.py/CMakeLists 的声明;未编译的包无可执行、无可跳转,是特性语义而非缺陷。→ "通电"与"解析不准"问题都不存在。
> 统一原语(工作区/系统同构,零新 spawn):
> - **prefix 根**:工作区 = `wsRoot/install`(本扩展构建恒 merge/symlink——Windows 恒 merge、Linux 默认 symlink,见 package-service/build/install-type.ts;isolated 布局 `install/<pkg>` 作兜底双查);系统 = PackageMap 已缓存的 `share/<pkg>` 目录**上溯两级**(fetchSystemDir 存的是 `pkg_prefix --share` 返回,pkg_prefix 默认带 --share,见 ros2/commands/ros2_service_api.ts:83-92);
> - **可执行名单与路径**:`prefix 根/lib/<pkg>` 目录 **fs 扫描文件名**——比 09-03 方案二原措辞(pkg_executables CLI 取名)更省,连 `ros2 pkg executables` spawn 都不需要,贴合语言域免 CLI 原则。
> 佐证(库内已有同款坐标):debugger/configuration/resolvers/ros2/launch.ts:280-356(install 路径 → 包名/源码反推)、test-provider/ros-test-runner.ts:548(`wsRoot/install/<pkg>`)、environment/source.ts:262(wsRoot/install = overlay prefix)、package-service/build/install-type.ts(安装方案决策:形态×布局)。
> 修正 17:46 落档:三步路线作废,尤其"② exe-map 通电做工作区跳文件"为误判——**可执行跳转永远不需要配置解析**;exe-map 维持断电无争议(其不可替代消费方仅"意图读写"类 write,仍不存在);09-03 方案二"系统可执行走 PackageMap"方向不变,实施细节升级为 fs 扫描、不再用 pkg_executables。
> 剩余工作量(全部在 launch 模块内,难度小):复活 scanLaunchNodes(前置注释/字符串剥离 + 字面量门控,只认 `Node(package='…', executable='…')`)+ 新增 executable-resolver(纯函数:pkg → prefix 根 → lib/<pkg> 扫描;未构建/拼错统一提示)+ hover/链接复用 xacro pending 语义。边界:① 未构建 = 无可跳,文案中性("安装目录未发现 xxx,包是否已 build?"),拼错与未构建不可区分;② python console_scripts 安装产物是生成 wrapper,跳它即"跳真身",追源 module 可第二跳读 wrapper 文本 import(仍零 setup.py 解析);③ 坐标系注意:PackageMap 对工作区包 $(find-pkg-share) 解析到**源码镜像**(include 跳转语义),可执行 resolver 必须单独拼 install prefix,勿混用。
> 状态:**维持"暂不做"决定**;若启动实施按本路线,同步本 README / exe-map/README / 00-总览。
>
> **"fs 扫描 prefix/lib/<pkg>"一段已被 17:33 再评估三修正——不做目录扫描、不做布局推断,改为统一 CLI 查询(ros2 pkg executables + pkg_prefix,缓存)。方向不变:真值在安装树/环境,与配置解析彻底解耦。**

### 再评估三(2026-09-05 17:33,用户终裁):**统一 CLI 查询路线——不扫描、不区分,问 ros2 自己**

> 用户连问:**为什么要扫描?已编译过,直接命令行取可执行列表不好吗?一定要扫描本地工作区吗?一定要区分(工作区/系统)吗?**
> 复核结论(用户对):`ros2 pkg executables <pkg>` 本身就是"该包现在能跑哪些可执行"的**参考实现**——`ros2 run`/launch 运行时经同一套环境 prefix 链解析;任何自研取数(fs 扫描或配置解析)都是它的重复实现,布局假设(merge/symlink/isolated/custom install-base/多工作区 overlay)会漂移。**不扫目录、不做布局推断、不在特性层区分工作区/系统——环境替你回答(overlay 顺序 = 运行时真用的那个);没 source 环境查不到 = 与运行时同语义(跑不了的东西不假装能跳)。**
> 实现形态(比 fs 版更小):
> - 查询经 **ros2ServiceApi.pkg_executables**(名单,ros2_service_api.ts:95,已存在)+ **pkg_prefix**(不带 --share 取 prefix 根,或复用 PackageMap 已缓存 share 目录上溯两级)拼 `prefix 根/lib/<pkg>/<name>` 落文件;
> - 红线对冲:"语言域免 CLI"禁的是**无记忆逐次 spawn**,不禁查询——按 PackageMap.fetchSystemDir 同款模式:**一次查询 + 单飞 + 缓存 + 环境变化/构建完成事件失效**(extension 已有 env→事件链可挂);
> - 落点:PackageMap(语言域包解析统一入口)增 `executablesOf(pkg)`/`resolveSystemExecutable(pkg, exe)` 缓存查询(回到 09-03 方案二的 PackageMap 归属定稿,实施细节从 pkg_executables 直连升级为带缓存层);launch 模块只复活字面量 Node 扫描 + hover/链接消费;
> - 剩余工作量 = PackageMap 缓存查询门面 + launch 侧复活 scanLaunchNodes(注释/字符串剥离 + 字面量门控);executable-resolver 不再需要(无布局推断可写)。
> 边界(与 fs 版同):未构建/未 source = 查不到,文案中性;python wrapper 跳真身,追源 module 第二跳读 wrapper import;坐标系提醒不再适用(查询全交环境)。
> 状态:**维持"暂不做"决定**;若启动实施按本路线,同步本 README / exe-map/README / 00-总览 / shared/package-map.md。
> **【2026-10-01 LJ-5 翻案(用户裁定)】再评估三的 CLI 路线已复活实施**:`ros2 pkg executables` 工作区/系统通吃且实测 ~0.17s(当年"1s 开销"顾虑不成立),PackageMap.executablesOf(缓存+单飞+acceptSystem 失效)已落地;17:47 的"跳源"定稿**限定工作区域**(install-truth 跳源不变),系统域按新裁定直接跳 CLI `--full-path` 安装路径(不做源码深究)。诊断"未知可执行"对系统包的历史误报随之消除。

>
> **17:47 再评估四修正:名单不必经 CLI——官方算法即"前缀 walk lib/<包> + X_OK",fs 原生可复刻且更准(可加 shebang 候选规避 X_OK 静默过滤坑);跳源另有知识/手册破墙,见下。**

### 再评估四(2026-09-05 17:47,用户终裁):跳源设计定稿并归档 —— **落盘,不执行**

> 触发:用户问"扫/查出来的怕不是编译后的二进制?"——是(ELF/壳),但翻阅 **`知识/install-build静态解析-实体安装/` 与 `../install-build静态解析-符号链接/`** 两册手册后确认:**跳转不落二进制,落点是源码,墙已被手册破掉**。
> 定稿设计(全部摘自手册,零新发明;特性正名 = **"可执行名 → 它的源码"**):
> 1. **名单/归属/校验**:复刻 ros2pkg 官方算法——ament_index 前缀 → `os.walk(prefix/lib/<包>)` + X_OK,名字 = basename;候选判据 X_OK,但 **symlink 下先 lstat/readlink,readlink 后含 shebang 的文本即便 X_OK=False 也视为候选**(规避 ros2pkg / `ros2 pkg executables` 对 PROGRAMS 源无 +x 的静默过滤坑,符号链接手册 §5 坑 6)——fs 原生,不 spawn,且比 CLI 更准;
> 2. **C++ 跳源**(实体手册 §4,硬墙#1 破墙点):install exe →(symlink 模式 readlink | 实体模式 `build/<包>/CMakeFiles/<同名>/link.txt` 的 `-o <同名>` 锚定)→ `src/*.o.d` → **绝对路径 .cpp(+头)**——`.d` 是编译器生成的权威映射,零 CMakeLists 解析;
> 3. **Python 跳源**(实体 §5 / 符号 §2):壳脚本 `EASY-INSTALL` 自描述 → `entry_points.txt`(实体在 install site-packages / symlink 在 `build/<包>/<包>.egg-info/`)→ 模块 → realpath 到 src,或 `SOURCES.txt` join `src/<包>` 根;`.py` PROGRAMS 文件即源;
> 4. **双模式差异**(egg-info 位置 / install.log 消失 / readlink 一步到源 / PROGRAMS 权限坑)按两册手册对照表实施时核对。
> 修正 17:33 再评估三:名单不必经 CLI 查询——官方算法即 fs walk(见上 ①),CLI 仅作可选对照;跳源链全程在 install/build 生成物坐标,与 09:11"真值在生成物"方向一致。
> **终裁(用户,2026-09-05 17:47):落盘定稿,不执行。** 理由:跳转特性已进入边缘情况密集区(双模式 / X_OK 陷阱 / egg-info 位置漂移 / C++ 目标多源文件选择),**边际效应过重**;launch 域后续价值方向转向**"直接的补全"(可执行名/包名列表级:低边缘效应、编辑时直接可见的成果)**,跳转特性维持"暂不做"终态。实施路线 = 本文档 ①-④ + `知识/` 两册手册;exe-map 维持断电(零配置解析成立,彻底)。

## 修改记录

> ⚠️ 约定:修改记录时间必须精确到分钟(YYYY-MM-DD HH:mm),创建/修订/任何改动均记,不得省略分钟。

| 时间(精确到分钟) | 说明 |
|:--|:--|
| 2026-09-03 23:11 | 建档(信息独立):launch 模块结构 README——文件职责、接线、05 任务状态与审计 L-* 问题索引、测试;关联 01-launch模块审计.md |
| 2026-09-03 23:16 | 05 task3 落地:registerLaunchLinkProvider(packages) 接收共享 PackageMap,find-pkg-share 经 resolvePackageDir(懒取等待),其余经 resolveFileRef;删除逐 include spawn ros2 CLI 的 ros2ServiceApi 直连(L-B2/B3 修复) |
| 2026-09-03 23:49 | 决策记录(仅记录未实施):launch 可执行跳转所需"系统包可执行"归属定稿为方案二——PackageMap 开辟专供 launch 的能力(resolveSystemExecutable:可执行名经 pkg_executables、精确路径拼 prefix 根/lib/<pkg>),不改 exe-map;见上方"待决"章节 |
| 2026-09-04 17:46 | 再评估终裁(用户):launch 可执行感知暂不做,exe-map 维持断电——复核断电因果自洽/通电三件事难度分层(本体便宜、launch 扫描准确率是真难点、跳转目标语义待定)/价值排序(hover·诊断先于跳文件);"待决"章节补三步落档路线(① 名级 hover+包跳转不依赖 exe-map;② exe-map 读侧通电做工作区跳文件;③ 明确不做 write/03/XML·yaml),方案二仍为若实施时的归属定稿 |
| 2026-09-05 09:11 | **盲点复核修正(用户):可执行跳转走 install 真值路线,与配置解析彻底解耦**——launch executable= 真值在安装树 prefix/lib/<pkg>(fs 扫描文件名),非 setup.py/CMakeLists 声明;统一原语:工作区 prefix=wsRoot/install(merge/symlink 常态,isolated 兜底)、系统 prefix=PackageMap share 目录上溯两级;佐证 debugger launch.ts / ros-test-runner / environment source / install-type;**17:46 三步路线作废(② exe-map 通电系误判),exe-map 维持断电**;剩余工作量收窄为 launch 模块内(复活 scanLaunchNodes 字面量门控 + executable-resolver);待决章节重写,再评估一保留为历史并标注被替代 |
| 2026-09-05 17:33 | **再修正(用户):统一 CLI 查询路线——不扫描、不区分**——fs 扫描仍是 ros2 pkg executables 的重复实现(布局推断会漂移);改经 ros2ServiceApi.pkg_executables + pkg_prefix 查询(参考实现,运行时同源),PackageMap 增 executablesOf/resolveSystemExecutable 缓存查询(fetchSystemDir 同款单飞+缓存+环境/构建事件失效);executable-resolver 布局推断不再需要;09:11 方向(真值在安装树/环境)保留,fs 细节作废;exe-map 维持断电;待决章节补再评估三 |
| 2026-09-05 17:47 | **终裁归档(用户):跳源设计定稿,落盘不执行**——确认 install 产物是二进制/壳,但跳转落点是**源码**;知识/两册 install-build 静态解析手册破墙:名单=复刻官方 walk lib/<包>+X_OK(symlink 下 readlink+shebang 候选,规避 X_OK 静默过滤坑)、C++ 跳源=link.txt 锚定→.o.d→.cpp、python 跳源=壳 EASY-INSTALL→entry_points→realpath/SOURCES.txt;修正 17:33(名单不必经 CLI);**边缘效应过重,特性维持暂不做,launch 域价值转向"直接补全"(列表级),exe-map 维持断电**;待决章节补再评估四 |
| 2026-09-05 18:00 | **三格式补全落地(py/XML/yaml,用户需求:launch 基本功能完善)**:新增 launch-completion-core.ts(517 行,纯核心:结构目录 + py/XML/yaml 光标上下文 + 候选生成)与 launch-completion.ts(269 行,vscode 适配:LaunchPy/Xml/Yaml 三 Provider + registerLaunchCompletionProviders,触发字符引号/</:-,包名名单经 PackageMap.getPackageNames 2026-09-05 新增);providers.ts 追加注册;test/suite/launch-completion.test.ts 24 用例纯核心全绿(无头 mocha);05 task4 yaml 状态改半做(补全有、include 跳转无);结构数据与 snippets/launch-py|xml.json 同源(静态 snippet 未退役,按 xacro 先例后续可并删);README §1-§4 同步 |
| 2026-09-05 23:45 | **yaml 收口(用户定:yaml 只有可能被包含、自身不会 include——最简格式)→ 只需"可被跳"、不需 include 出边**:05 task4 状态改按需收口;launch-py-parser 字面量后缀 py\|xml 扩为 py\|xml\|yaml(:77,py 跳入 yaml 目标覆盖),补 parser 单测(yaml 字面量目标);05 task2 IncludeLaunchFile 仍未做、扫描误报 L-F1/F2 与 task1 死面清理(scanLaunchNodes/launch.test.ts/dumper)仍列遗留 |
| 2026-09-05 23:52 | **py 扫描误报收窄(L-F1/F2,用户选定只清此项)**:launch-py-parser 新增 maskPythonNoise(注释/三引号 docstring 等长掩码、保留单行字符串与换行,offset 不变)+ joinLooksLikeLaunch 语义门(末段须 .launch.(py|xml|yaml) 且近窗口含 include/DescriptionSource 调用);注释/docstring 里的假 include、非 launch 语义 join(config/params 拼路径)不再成链;parser 单测补 5 护栏用例(掩码等长/docstring 保留单行串/注释/docstring/非 launch join);tsc 0 错误;残留 L-F3/L-F5 与 task1 死面见 §3 |
| 2026-09-06 15:04 | **❄️ .launch.py include 跳转冻结(用户:跳得太烂、不如不跳;后续升级)**:providers.ts 不再注册 LaunchPyDocumentLink/Hover,只保留 XML 链接 + 三格式补全;launchpy-provider.ts 与 launch-py-parser.ts 代码留档(头部加冻结注,parser 现仅测试引用,防升级回归),23:52 掩码/语义门收窄成果随之冻结留档;README §1-§4 同步 |
| 2026-09-06 23:44 | **yaml include 跳转落地 + 23:45 结论撤销**:用户自查后确认"yaml 不会 include"是**猜测**(官方 ros2_documentation humble 不同格式三写样例含 `- include: {file: "$(find-pkg-share …)"}` 与 group 内 include)→ 记录修正、功能补齐:launch-link-provider 将解析提升为共享导出 resolveLaunchIncludePath(xml/yaml 共用);新增 yaml-link-provider.ts(116 行:LaunchYamlLinkProvider + registerLaunchYamlLinkProvider,结构化 `- include:` 块 file: 值,纯 pattern selector);providers.ts 注册 yaml 链接(44 行);test/suite/launch-yaml-link.test.ts 集成用例(executeDocumentLinkProvider);tsc 0 错误;README §1-§4 同步 |
| 2026-09-07 15:58 | **静态 snippet 退役(用户:三问题——① 补全污染:python/xml 语言全量注册致非 launch 文件列 launch 片段;② 描述中英混杂难看;③ yaml 无静态文件)**:launch-py.json / launch-xml.json 从 package.json snippets 贡献移除并删除文件(结构数据已转制进 launch-completion-core,补全只经三格式代码提供器按 pattern 命中);**yaml 刻意不建静态 snippet**(yaml 语言含 rviz 等,静态会全 yaml 污染;其补全由代码提供器按 **/*.launch.yaml|yml 精确承载——问题③的解答即"yaml 补全走代码提供器,与污染治理同源");README §2 同步 |
| 2026-09-07 16:04 | **静态转制全量补正(用户纠正:直接删静态不合理、会丢功能;应效仿 xacro 先全量转动态再删)**:15:58 停用前仅转制子集(紧凑单行)→ 丢失整文件模板/变体/替换项,属执行失误;现全量保真转制——py 12 条(整文件模板、Node/Node(简单)/Node(重映射)、IncludeLaunchDescription(含导入块)、ComposableNodeContainer、LifecycleNode…)+ XML 主标签 12 + 附加 9(整文件模板含 XML 声明、node(带命名空间)/node(块)、arg(无默认值)、include(带子 arg)、param(从 YAML)、$(var)/$(env)/$(find-pkg-share) 替换),原 prefix 并入 keywords/filterText(ros2launch/ros2node/ros2findpkg 等旧肌肉记忆保留);Candidate 增 filter 字段;xml 提供器在 tagName/text 上下文追加附加片段、属性值含 $() 时给替换项;单测 24→29(转制完整性 5 用例)全绿;静态删除保持(内容无损);README §1/§2 同步 |
| 2026-09-08 00:35 | **❄️→✅ .launch.py include 跳转解冻恢复(用户澄清:09-06 冻结对象是"可执行文件跳转"(非启动文件 include),且为误读误冻结;启动文件 include 跳转要保留)**:providers.ts 恢复注册 LaunchPyDocumentLink/Hover(pattern **/*.launch.py);launch-py-parser 升级——collectSimpleVars(简单赋值变量表:字面量/get_package_share_directory/os.path.join/变量引用,外部变量假设不存在)、语境门扩 AnyLaunchDescriptionSource、**解析失败静默过滤(scanLaunchIncludes 只返回已解析记录)**;launchpy-provider hover 移除"目标未解析"分支;parser 单测改口径(静默 + 变量正例/LaunchConfiguration 负例/绝对路径正例);tsc 0 + 纯套件 39 用例绿;README §1-§4 同步;09-06 15:04 冻结行保留为历史(本行替代) |
| 2026-09-08 00:40 | **yaml 补全末尾游离"0"修复(用户实测:插入后 `value: "var_value"0`)**:根因 = YAML_ACTIONS 的 insert 用**反引号模板**拼接,snippet 结束位 `${0}` 被 JS 当作数字 0 **插值**成字面 "0";修复 = 模板内转义为 `\${0}`(模板输出字面 `${0}`,再由 SnippetString 还原为最终光标);已验证 let/node 等 insert 现以 `${0}` 结尾、无游离 0;纯套件 29 用例绿 |
| 2026-09-08 00:52 | **补全条目 UX 收敛(用户三连:detail 页不展示结构 / filterText 含中文 / 中文前缀干扰模糊匹配)+ 范本学习(xacro `前缀(中文)` 消歧)**:① snippet 项 documentation = 完整插入体代码块(详细页可预览结构);② **filterText 改纯 ASCII**——中文只留 label;③ 演进为**结构头部主词优先**:`headTokens` 取 insert 开头(去 import/from 引导、${…} 占位、引号值、标点)前 3 标识符,与 keywords/label 英文词合并成 filter(如 param(from)→ `param from …`);④ 同前缀重复片段 label = `前缀(中文)` 后缀消歧;三 core(launch/py/cpp)统一;测试增"filter 纯 ASCII + 结构头词"断言,43 用例绿;README §2 增补全条目参数约定 |
| 时间 | 说明 |
|:--|:--|
| 2026-09-25 18:10 | LA 批次(用户指令:完成可执行补全与解析跳转):① LA-2 可执行名值补全三格式接线(executable=/exec=/exec:,名单经 install-truth ExecutableResolver(共享 BuildMapCenter,与 run 域同源),pkg 上下文取同调用/标签/动作块内字面量——core 增 pyStringKwargInCall/xmlTagAttrBefore/yamlSiblingKeyValue/execValueCandidates);② LA-3 解析跳转:新建 launch-definition-provider(XML node pkg→package.xml、exec→可执行源文件、include file→目标;py Node 系 package/executable 值→包目录/源文件(launch-py-parser 增 pyNodeCallAt 位置感知,嵌套取内层)+ include 表达式→目标),providers 注册;③ LA-1 域门控:全部 launch provider 对 VS Code 工作区根外文档早退(shared/workspace-domain,xacro XG13 判定上移共享);系统包可执行名单维持四轮终裁不做;13 条新测试 |
| 2026-09-27 21:30 | LC 补全升级批次(LC-0~10,设计见 02-补全升级.md,对标 xacro 补全):LC-1 参数声明提取 launch-args.ts(py DeclareLaunchArgument 掩码扫描/xml lezer <arg>/yaml - arg: 块);LC-2 参数引用补全三格式(py LaunchConfiguration( 首参特判、xml/yaml $(var 参数位,detail=默认值、doc=声明行);LC-3 $() 替换命令目录 8 项(var/env/optenv/find/find-pkg-share/dirname/cwd/eval)+ ( 触发窄门控(xml/yaml);LC-4 include file 路径单层补全(移植 xacro includeFileCandidates:包目录/相对/绝对基准、目录尾 / 自动续层、launch 扩展名过滤、followSymlinks)+ / 触发;LC-5 include 传参名补全跨文件(xml 子 arg name、py launch_arguments 键位,目标 uri+mtime 缓存);LC-6 py kwarg 名目录(10 调用)+ 名位判定;LC-7 枚举扩展(py output/respawn、yaml output/respawn、xml respawn);LC-8 filterText 超集(符号头+词流,移植 snippetHeadLiteral/snippetWordTokens);LC-9 provider 增 context/TriggerKind 窄门控;13 条 core 头测 + 9 条集成测试,全量 1134 测试 0 新增失败 |
| 2026-09-30 02:15 | **LD 修缮批次 + 分层(设计见 03-补全跳转修缮.md;用户六点体验问题,八项实证缺陷)**:LD-2 范围锚定修复(P0——subst-cmd/arg-ref 的 item.range 改词锚、$() 位判定改值内尾段口径、PY_ATTR_TAIL_RE 收编 output/respawn(LC-7 py 枚举死路复活)、LC-4 include 路径项不设 range、name= 值位放行、inPyString 双引号);LD-3 跳转统一(yaml F12 三值位 pkg:/exec:/file:、xml 链接 selector 去 language:'xml' 改纯 pattern、文件级落点语义成文=文件+line 0);LD-4 py include 链接窄化(join 案 range=末段字面量引号内内容,covered 全跨度承接字面量去重);LD-5 悬浮补齐(新 launch-hover-provider 三格式:包落点/exec 源/include 目标/$(var) 声明/kwarg·attr·键);LD-6 pkg/exec 候选 detail(工作区包 · 目录/可执行名 · 包);**LD-6.5 分层**:core/(launch-completion-core + launch-args)/ parse/(launch-py-parser)/ ui/(六 provider)git mv 迁移、providers.ts 留根、三层 README 建档,§1 文件清单改分层表;取证两则(py 双定义=肥 range 与外部 Python 服务重叠;exec 名碎裂=宿主词级建议点分段)见 03 号 §3;集成测试自此断言 range/insert 语义;全量 1189 测试 0 失败 |
| 2026-09-30 16:30 | **RE-3 勘误(LD-3 归因更正)**:LD-3 行中"`.launch` 裸后缀默认无 xml 语言、双条件下链接永不出现"的断言有误——package.json languages 贡献的 xml 条目 `"extensions": ["launch",…]`(**无点**)经 VS Code 源码 `languagesAssociations.ts` 的 `endsWithIgnoreCase(filename, extension)` 匹配,裸 `.launch` 实际一直绑定 xml 语言(高亮有效);LD-3 的纯 pattern 化保留(对无语言绑定场景更稳、口径统一),归因记录作废;补宿主集成测试(languageId==='xml' + 补全命中)实证锁死,详见 03-补全跳转修缮.md RE-3 勘误注记 |
| 2026-09-30 22:44 | **LE 批次(设计 04-全面DocumentLink.md;用户裁定新原则:非精确跳转优先文件级跳转)**:①parse 增 scanLaunchNodeRefs(Node 系四调用全量扫描,pyNodeCallAt 改为其定位包装;死导出 scanLaunchNodes/LaunchNode/offsetToLine 物理删除);②落点共享 resolvePackageTargetUri/resolveExecTargetUri(Definition 薄包装/Hover 同源化/三入口同源);③py/xml/yaml 三格式 pkg/exec 值的 DocumentLink 直达链接(值内容范围;非字面量/未构建不链;providers 传共享 execSource);④yaml-link CRLF 盲区修复(lineStarts 按原文 \n 累计);⑤取证:redhat.vscode-yaml 外来下划线归属已定(用户禁用实验)、机制未明(排除清单见 04 号 §3),共存口径=我方内容范围不变、实测为准;⑥F12 定义保留作辅(用户裁定),Pylance 叠加条目消除靠用户侧 gotoDefinitionInStringLiteral:false;集成测 +3(三格式链接/范围/CRLF),全量 1199 条 0 失败 |
| 2026-10-01 15:41 | **LF 批次(04 号 §7,用户实测:引号内空格毒害兄弟行/quoted==unquoted 等价/转义从未处理)**:①core parseYamlScalarValue + parse parsePyString 双扫描器(引号单双+转义+三引号+多行+裸标量注释/中间空格保留);②yamlSiblingKeyValue/yamlDefinition/yaml-link/declaredArgsPy/pyStringKwargInCall 全部接入(级联失效根因=值类遇引号后空格匹配失败,无条件修复);③grabKwargString 原文代码态游走取代掩码正则;④xml 实体解码 decodeXmlEntities 接入 definition/hover/link;⑤设置 ROS2.launch.yamlNodeMatch(实验性默认 true):yaml Definition 响应范围整节点(含引号)/仅值内容双模式,下划线恒值内容不随设置;头测+集成 16 用例,全量 1215 条 0 失败 |
| 2026-10-01 17:51 | **LG 批次(04 号 §8,用户三项反馈)**:①正确语义:yaml 值原样参与(引号内前导/后导空格真正包含," p10…" 无响应=正确对齐),宽容 trim 全移除;②yaml 定义注册开关 ROS2.launch.yamlDefinitionEnabled(默认 true/重启生效/仅 yaml):关闭=.launch.yaml 完全不注册 DefinitionProvider,规避引号下指示线;③多行 include 链接分段(按行剔空白,多条同目标链接);全量 1216 条 0 失败 |
| 2026-10-01 18:34 | **LH 批次(04 号 §9,用户:全面添加警告下波浪线/设置未找到)**:新 launch-diagnostic-provider——launch 语义诊断 DiagnosticCollection(三格式):格式类(pkg/exec 首尾空白/非法字符)+可解析类(未知包/未知可执行或未构建/include 目标缺失),就绪重算(PackageMap 事件→reanalyzeAll 防抖 1s);设置可见性修复(移除 yamlDefinitionEnabled 弃用标记);全量 1217 条 0 失败 |
| 2026-10-01 19:43 | **LI 批次(用户批准窄口径:相邻纯字面量拼接,修订此前"拼接不做")**:parse 新增 parsePyStringConcatenation——第一个字符串后仅隔空白/注释/续行紧跟另一字符串字面量即继续消费合并(长名拆行写法),非字符串 token 立即停止不做求值,+ 拼接不做;grabKwargString/pyStringKwargInCall/declaredArgsPy(名字+default_value)全接线;头测 5 用例,全量 1223 条 0 失败 |
| 2026-10-01 20:45 | **LJ 批次(用户指令:重点完善补全机构——结构补/包补全/可执行文件补全,什么都来都给;02 号 §6)**:①目录对齐官方 Humble frontend parse(VM 实机实证)——XML node/executable/param/group 属性全集+arg 删非官方 value+新标签 timer/set_parameter/set_remap/set_use_sim_time+node 子 env/param 嵌套/arg 子 choice/group 子 keep;YAML 新动作 5 个+node/execute_process 键全集+group/arg 键;output 枚举三格式统一官方 4 值;②yaml 子列表 listKey/listValue 光标态(remap/param/env/arg/choice/keep 整项片段+子键)+include 子 arg name 跨文件参数名(LC-5 yaml 版)+include file 路径单层(LC-4 yaml 版)+xml param from 路径;/ 触发扩 yaml;③值数据面:exec 候选 doc=源文件路径+包名候选工作区置顶;④py:os.path.join(gpsd(pkg),…) 末段路径补全(P2 移交)+remappings/parameters 列表项 snippet+PY_KWARGS 对齐官方+触发字符 ( / = / /;LJ 头测 29+集成 6,电子宿主 junit 1193 条 0 失败 |
| 2026-10-01 21:12 | **LJ-fix(用户截图裁定:exec 候选信息呈现两处)**:①悬浮文档不显示绝对路径——改包内相对源路径(path.relative 对包目录,失败兜底 basename,展示统一正斜杠);②候选行内 detail=所属包(此前可执行名 · 包 / 泛可执行名)——无 pkg 上下文经 ExecutableResolver.ownersOfName 反查标包(ExecIndex 增 byName 名字→所属包,LaunchExecSource 增可选 ownersOf);电子宿主 junit 1194 条 0 失败 |
| 2026-10-01 21:38 | **LJ-fix2(用户实测:二区行内仍空白)**:detail 的行内右对齐淡显区在建议列表不渲染(顶部折叠栏才出现)——行内标包改走 label.description(CompletionItemLabel,紧跟名字的淡字,确定渲染位);detail 保留包名(顶部栏用);测试 label 对象化后的既有断言全量迁移(typeof 守卫比较);电子宿主 junit 1194 条 0 失败 |
| 2026-10-01 21:58 | **LJ-fix3(用户终裁,信息呈现定稿)**:①exec 候选行内 description=包内相对源路径(无源兜底所属包名);②exec 悬浮文档=完整绝对路径(回改);③包名候选行内 description=工作区包/系统包、悬浮文档=完整包路径(系统包经 get 缓存,未缓存暂无 doc)、detail 同步简化为来源标注;电子宿主 junit 1194 条 0 失败 |
| 2026-10-01 22:18 | **LJ-fix4(用户裁定悬浮文案格式)**:exec 悬浮文档改 `包名包的包内相对路径` 文案(appendText 纯文本,MarkdownString 会转义下划线=渲染正确原始值带 \_);相对化失败兜底 basename;电子宿主 junit 1194 条 0 失败 |
| 2026-10-03 02:30 | **LJ-10 结构补全扩容(用户贴网络结构树为蓝本,官方 Humble 逐项终审:VM grep 替换注册表 + GitHub humble 分支 ctor)**:①替换目录 8→23 全集(新增 anon/command/find-exec/find-pkg-prefix/exec-in-pkg/param/filename/file-content/if/equals/not-equals/not/and/or/any/all/log_dir/launch_log_dir),清除 ROS1 残留 optenv/cwd/find;②py 调用注册表 13→29(事件六件套+Register/UnregisterEventHandler+EmitEvent+OpaqueCoroutine+ExecuteLocal+env/config 栈五件套);③kwarg 目录同步(官方 ctor 终审);④6 条组合骨架:事件链/优雅关闭/生命周期迁移/OpaqueFunction/参数文件组合/条件执行;⑤伪项排除留档:LogWarn/LogError/ForEach/OnAction 官方不存在,lifecycle_node/emit_event 非 Humble frontend 实体,path-join/string-join/string-strip/for-var rolling-only;头测 13+集成 2,电子宿主 junit 1239 条 0 失败 |
| 2026-10-03 01:35 | **LJ-9 回滚命令链接 + resolve 0.5s 驻留门(用户实测链接'确实太绕'回滚;用户方案:到达条目计时 0.5s,还在才加载)**:恢复 LJ-7a resolveCompletionItem 三 provider,新增驻留门——resolve 触发后先等 500ms 再检查 token,宿主在焦点移动时取消前一个 resolve 的 CancellationToken → 醒来见取消即零取数,停留 ≥0.5s 才单次取目录(单飞+缓存);快速浏览的批量触发从'每项一次 CLI'降为'仅驻留项一次';移除 fetchSystemPkgDir 命令与链接文档(LJ-8 实验结论:面板收起不可见/点击不能回显=太绕,方案作废留档);集成断言三路径(取消零取数/驻留满取一次/重复缓存),电子宿主 junit 1229 条 0 失败 |
| 2026-10-03 01:05 | **LJ-8 系统包候选文档改命令链接(用户裁定:'不赌路径,包不一定是系统包'否决根推导;'无法自动刷新无法立即显示,先做出来看一下')**:①系统包候选 provide 阶段文档 = 命令链接'获取安装目录'(零 CLI;命令链接必须 provide 期就位=vscode#184924,isTrusted.enabledCommands 信任声明);②移除 LJ-7a resolveCompletionItem(与点击语义互斥——聚焦自动取会绕过链接);③新命令 ROS2.launch.fetchSystemPkgDir:点击→resolvePackageDir 单飞+缓存单次取→通知呈现+复制按钮(建议面板无法回写文档=宿主硬限制,vscode#140733 渲染边界待真机验);④上下键聚焦零取数(扫列表不再触发任何查询——路径只在点击时取一次);集成断言改链接形态,电子宿主 junit 1229 条 0 失败 |
| 2026-10-02 14:20 | **LJ-7 补全双修复 + 系统包路径懒取文档(A 路径,用户裁定:补全不需要每包精确路径/先出计划批准)**:①去风暴——packageItems 删 packages.get(此前对列表内每个未缓存系统包触发一次 ros2 pkg prefix,VM 实测 275 包 × ~0.2s 无并发上限=首次包名补全高延迟根因),系统包候选 provide 阶段零 CLI,工作区包目录纯内存保留;②resolve 懒取——三 provider 实现 resolveCompletionItem(共用 resolvePkgDocItem,detail='系统包' 常量作跨克隆标记):候选聚焦时单次懒取目录填文档(resolvePackageDir 单飞+缓存),路径获取延后到聚焦或插入后悬浮/F12;③yaml dash 词锚——listKey/action dashTyped 路径 range 只锚已敲词(覆盖 '- ' 会被 VS Code 以 range 文本过滤而全滤空,LD 词锚铁律同族),core action 变体增 dashTyped + insert 剥 '- ' 前缀 + 分隔符兜底('-' 无空格时 insert 前补空格);头测 3 + 集成 4,电子宿主 junit 1229 条 0 失败 |
| 2026-10-02 13:35 | **LJ-6 结构补全 90% 覆盖(用户指令:继续做 yaml/xml/py 结构补全,识别不准确/内容不完整,覆盖所有可能结构;官方事实源=VM Humble 实机 parse)**:①残差动作全集补齐——launch.actions 余量 append_env(name/value/prepend/separator)/unset_env(name)/reset_env(无属性)/log(message)/shutdown(reason)/reset(子 keep)/timer 子=任意动作 + launch_ros 余量 ros_timer/node_container(Node 全集+composable_node 子)/load_composable_node(target)/set_parameters_from_file(filename)/composable_node(pkg/exec/plugin/namespace+param/remap/extra_arg 子)——XML 子标签/属性/片段 + YAML 动作目录 + PY 调用注册表/kwarg 目录/9 条新片段三格式同步;②序无关识别三通道——xmlTagAttrBefore 向后找同标签已闭合属性/yamlSiblingKeyValue 向上遇动作行转向下同缩进兄弟键(块界=缩进变浅)/pyStringKwargInCall 向后扩展至配对右括号——exec 在前 pkg 在后照常拿到上下文;③set_parameters_from_file filename → 参数文件路径值源三格式接线(py / 触发门控放行 filename);头测 +15 + 集成 +4,电子宿主 junit 1222 条 0 失败 |
| 2026-10-01 22:48 | **LJ-5 系统包可执行接电(用户翻案+开工令:CLI 路线复活,查证 `ros2 pkg executables` 工作区/系统通吃实测 ~0.17s)**:①ros2ServiceApi 增 pkg_executables_full(--full-path 每行一个纯路径,官方 verb 源码锁定);②shared/package-map.ts 增 executablesOf(17:33 蓝图:缓存+pendingExecFetches 单飞+失败不缓存可重试+acceptSystem env 回推整体失效,构造器第二注入缝);③InstallTruthExecSource 分流:execNames 工作区未命中→CLI 名单、sourceOf 未命中→CLI 安装路径(系统域跳安装产物=用户新裁定,工作区跳源定稿不变),providers 装配注入 packages;④呈现零改动兜底链自动:系统包行内=包名/悬浮=包名包的basename/跳转=安装路径,诊断"未知可执行"对系统包的历史误报消除;头测 7+集成 2,电子宿主 junit 1203 条 0 失败 |
