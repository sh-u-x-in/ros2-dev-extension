# write/ — 构建文件改写器(01 一键配置起步)

> **⚡ 断电(2026-09-04)**:config 除 gen 外断电。一键配置写回极端受限于插入形式、几乎不可行(用户裁定),消费者已消失——本目录**留档不参与编译**(tsconfig exclude),内容仅供历史参考,不再接线/注册命令。
| 2026-09-04 (接线) | configure-actions 全部 plan 接入定位:CMakeLists 用 cmake.locateCmakeInsert(L1/L2/L3) 定位整文改写(不再 append 文件尾);package.xml 用 xml.insertXmlDepElement 按类插入;活跃判定改用 scanActiveCalls(注释模板不再误判已配置,修正 demo_cpp_deps/interfaces_pkg msg 场景);console_scripts 接入 anchors/python;片段统一带 stamp 生成标志;configure-file 写回保持 replace 整文 |

config 写侧目录。2026-09-03 起 01 一键配置落地(设计:设计/新功能/01 + config 实现方案)。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| configure-actions.ts | 纯动作层:角色识别 + 幂等判定(复用 exe-map/parse)+ 追加/整文改写片段(launch / msg·srv·action / python / shell / cpp)+ **扩展生成标志**(stampComment/stampSnippet,2026-09-04:cmake/setup 行尾 # 注释、package.xml 独立 XML 注释行;仅排障,幂等/归属判定不依赖) | exe-map/parse(纯 TS,可无头测) |
| api.ts | **对外 API 冻结出口**(2026-09-04 13:22):01 计划层(planConfigure/detectRole/stamp + 类型)、02 重命名纯层(validatePackageName/planRenameByFolder)、anchors 命名空间;纯 TS 零 vscode | actions、anchors、naming 符号 |
| configure-file.ts | 编排层:包定位(门面 workspace 域,最长祖先)→ 读构建文件 → planConfigure → 写前确认(总纲约束⑤ modal)→ 写回(append/replace)→ 提示 | vscode、package-core 门面、actions |
| anchors/ | **定位层(2026-09-04 收敛)**:cmake.ts 增量追加定位(L1 活跃尾/L2 注释模板上/L3 兜底,含行/run 辅助)+ xml.ts package.xml 多类插入(lezer)+ python.ts setup.py 定位(configure 已接入);详见 anchors/README.md | 纯 TS,可无头测 |
| rename-actions.ts | 纯层(02):结构定位改写 package.xml <name>/CMake project()/setup.py name(以文件夹名称为准) | 纯 TS |
| package-rename.ts | 编排(02):订阅 executable-map.onNameMismatch → modal(改声明/忽略)→ 整文写回;启动冷却+会话去重 | vscode、exe-map/types、rename-actions |
| index.ts | 出口:registerConfigureFileCommand(命令 ROS2.configureFile,右键菜单已接) | — |

## 对外 API(冻结区,2026-09-04)

- 入口:**`api.ts`**(纯 TS、零 vscode、可无头调用)——01 计划层(`planConfigure`/`detectRole`/stamp 工具 + 全部类型)、02 重命名纯层(`validatePackageName`/`planRenameByFolder`)、定位/改写原语命名空间 `anchors`;
- 状态:**冻结**。用户拍板:一键配置的“内容语义/高级分析”(cpp 依赖、py 意图、msg 类型归属等)不再扩展——本模块作为执行引擎存量资产,以只读 API 形式对外暴露,祈祷有朝一日被更高级的决策层消费;
- 维护边界:仅修缺陷、保持行为面,不改写回语义;vscode 编排仍在 `index.ts`(configure-file/package-rename),不属于本 API;
- 冒烟:test/suite/write-api.test.ts(计划/重命名/anchors 桶三例)。

## 定位先行(2026-09-03 决策)

上层(01/02)的插入都基于**精确位置**完成:setup.py / CMakeLists 括号可跨行且常被字符串/注释包裹,盲插会插坏括号。故先在 anchors/ 建定位与偏移测量层(括号配对/区域分类/锚点插入),上层后续按 `配置动作规格-文件角色×包类型.md §4` 清单逐条接入 anchors,每条带单测;`exe-map/parse` 保持语义提取职责不变。


## 写侧理念与块模型(2026-09-03 定调)

**一句话**:写构建文件的难点不在"生成什么",而在**写到哪里、怎么不写坏**——
插入必须落在精确位置;一次配置常涉及**多处、成组、带顺序**的写入;同一处常同时存在活跃代码与注释模板,
因此单一区间(Span)不够,需要**按块(带标签的区间)处理,并按策略写入**:块内追加 / 整块覆盖 / 取消注释并填充 / 兜底文件尾追加。

**为什么定位先行**:setup.py / CMakeLists 的括号常跨行且被字符串/注释/bracket 参数包裹;package.xml 有根闭合标签约束——
盲插会插坏括号或把内容写到 </package> 之后(XML 非法)。故先建 anchors/(区域分类/括号配对/行·注释 run/kwarg 块/锚点),
契约:-1 = 不可动;再由上层消费。

**分层**:

```
scanner(区域/括号) → lines(行/注释run/横幅) → python(kwarg块) → cmake(命令括号/ament锚点) → xml(根前插入)   ← anchors/
   │ 全部为位置/区间原语(-1=不可动)
   ▼
blocks/(下一步):分块+打标签——自家模板 = 与 create 共享的横幅常量(精确匹配,不用相似度);
                他人文件 = 结构启发 + 弱标签(注释关键词);命中不了 → 自由块,策略退化为就近/文件尾追加
   ▼
upper(configure/rename):按 (块标签, 策略, 内容) 生成计划——支持同一文件多处 op(如 msg 接口 = 依赖段 find_package 组
                        + rosidl 注释模板取消填充 + 安装段);依赖探测等后续在此层扩展
```

**package.xml**:不自造文本处理,写侧一律走真 XML 工具(仓库已有 @lezer/xml 与 languages/shared/xml-utils 或第三方);
自研的块模型聚焦 CMakeLists.txt 与 setup.py 两种。

**实施顺序**:anchors/(已完成,12 用例)→ blocks/ + 共享横幅标签目录(create 模板常量,生成/写共用一份)→
configure-actions/rename 改造为按块策略 → package.xml 操作接入 XML 工具。


## 生成标志(2026-09-04 定调)

所有**新增片段**带人读注释,便于排障:
- cmake/setup:内容行尾追加 `# [rde-ros-2 扩展生成] YYYY-MM-DD HH:mm`(多行按首个命令内容行算;单行直接行尾);
- package.xml:片段后追加独立 `<!-- rde-ros-2 扩展生成 YYYY-MM-DD HH:mm -->` 行。
**仅给人读**:幂等判定、重复排除、归属识别不依赖此标志(走 exe-map/parse/结构);扩展解析时按注释规则天然跳过。

## 定位定调(2026-09-04,替代"完整分块"设想)

- 不做完整分块铺满、不做"取消注释并填充"(难度高,先放);
- 写侧 = **增量追加**,只加不改 → 难点 = "往哪插",做**多区间插入**;
- anchors/cmake.ts 三级(scanActiveCalls + locateCmakeInsert):①该 kind 有活跃命令 → 最后活跃之后;②无活跃、有自家注释模板 run → 模板 run 上方(模板 = create 生成物,天然是惯例位置锚,精确匹配命令名,不用相似度);③皆无 → ament_package() 前/文件尾;
- 对应五种 kind:deps(find_package)/ interfaces(rosidl_generate_interfaces)/ build(add_executable·add_library)/ pyinstall(ament_python_install_package)/ install(install)。

## 写安全(总纲约束⑤)

- 一律先弹 modal 确认(列出逐文件动作与片段概览),确认后才写,不留写后门;
- 追加模式(CMakeLists/package.xml)在文件尾补片段;console_scripts 用整文改写(原位插入);
- 幂等:同一文件重复执行 → 判定已配置直接提示,不重复追加;
- shell 可执行位在非 Windows 尽力 chmod +x;python(ament_python)入口 name=module:func 由用户输入确认。

## 范围与边界(v1)

- 仅包内文件生效(找不到所属参与构建的包 → 提示);ament_python 的 launch 安装(data_files 结构改写)与
  C++ 依赖探测(ament_target_dependencies 自动补依赖)v1 未做(前者提示手动,后者生成骨架占位注释);
- 写回后依赖现有监听(executable-map/event-collector、package-core watcher)自动刷新,不手动触发。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 文档勘误:文件表 configure-actions.ts 重复两行合并为一行(扩展生成标志并入主行);api.ts 补入文件表(原只在「对外 API(冻结区)」节出现);本目录仍为断电留档不参与编译 |
| 2026-09-03 14:29 | 建档(由占位说明改写):01 一键配置落地——configure-actions(纯)+ configure-file(编排)+ index 注册(ROS2.configureFile)+ package.json 右键菜单;纯测 8 用例全过;待定项回填见 设计/新功能/01 |
| 2026-09-03 14:32 | 02 工作包重命名落地:rename-actions(纯)+ package-rename(编排,订阅 executable-map.onNameMismatch)+ extension 接线;纯测 6 用例;决策回填见 设计/新功能/02 §8 |
| 2026-09-03 17:21 | 定位层先行:新建 anchors/(types/scanner/python/cmake/xml + README,9 无头用例);本 README 目录/说明同步;上层(01/02)待按规格 §4 接入 anchors |
| 2026-09-03 17:41 | 记录写侧理念:定位先行 → 块模型(标签+策略:追加/覆盖/取消注释填充/兜底尾追加)→ 多站点计划 → package.xml 外包 XML 工具;实施顺序 anchors→blocks+共享横幅→上层改造 |
| 2026-09-04 | 写侧理念收敛:完整分块/取消注释填充放后 → 增量追加 + 多区间插入;lines.ts 并入 cmake.ts;xml.ts 用 @lezer/xml 重写支持 8 类依赖插入(同类尾部/export 前兜底,注释不误命中);configure-actions 的 console_scripts 接入 anchors/python.ts(删自写括号配对);扩展生成标志并入 configure-actions.ts;文件数净减(lines/cmke-locate/stamp 删除) |
| 2026-09-04(深夜实施) | configure-actions 四 plan 去「一键配置」横幅(仅留扩展生成标注);anchors/cmake 新增 findActiveCallByArgs / cmakeAppendArgToBlock(紧凑→垂直规范形态重排 + 内容区尾部追加,旧行标注保留,幂等按块内含)与 locateCmakeTemplateCodeAnchor(## 说明头不参与匹配);launch=模板码锚下新建 DIRECTORY 块;python/shell=并活跃 PROGRAMS 块(垂直化)或新建垂直块;cpp=add_executable 骨架 + 目标并入 install(TARGETS)(Q2);msg=两处落点(find_package@依赖区 / rosidl 块@接口区,DEPENDENCIES 参照模板)与块内追加;package.xml 三类带短注释(Q3);xml.ts insertXmlDepElement 支持 commentInner、兜底落点取行首;rename/package-rename 未动;作用域单测 61 全绿(全量 tsc 待 rosmsg/message-index 外部并行改动合拢后复跑) |
| 2026-09-04(修复) | §3.3 真修:anchors/python findKwargSpan 允许 kwarg 前有整行注释(真实 setup.py 参数间夹中文注释头)→ console_scripts 列表内插入不再退化到 (c) 重复补 entry_points(此前仅简单文件形态通过;demo_py_launch 端到端揪出);stampSnippet 对已带扩展生成标注的首内容行不再叠加(标注幂等);全量 npm run test-compile + 三 suite 64 用例全绿;demo_py_launch(py_extra/listener 并入同一列表)与 demo_hello_cpp/demo_interfaces_pkg/demo_cpp_deps 四场景 diff 验收 |
| 2026-09-04(定稿) | ① console_scripts 规范尾插:新原语 anchors/python insertListItemCanonical——追加条目行**自带尾逗号 + 行内扩展生成标注**,前一行已是 create 风格则不再改写(纯行追加,反复追加不碰旧行);删整文件 import 行打标;(b)/(c) 兜底保持 parse 兼容;② package.xml 用户推翻「短解说注释」:不做 `<!-- 构建工具: … -->` 独立注释行,每个元素按类单独插入(同类聚堆)且**行尾各带独立 `<!-- rde-ros-2 扩展生成 … -->` 标注**(有迹可循),删组尾/文件尾独立 stamp 与 replace 写回;xml.ts insertXmlDepElement 参数改为行尾内联标注;全量 test-compile + 三 suite 68 用例全绿;.tmp-create-samples 本地生成→写验证复现(demo_cpp msg 两元素行尾标注、demo_py console 纯行追加) |
| 2026-09-04 02:26 | 规范化收敛:write 上层对 anchors 的消费统一改经 anchors/index.ts 桶出口(configure-actions 不再直连 scanner/python/cmake/xml 子模块);anchors/README.md 全量同步——文件清单与接口(含 insertListItemCanonical/findConsoleScriptsList/consoleListHasItem/locateCmakeTemplateCodeAnchor/cmakeAppendArgToBlock/findActiveCallByArgs/行尾内联标注)、删除迁移(locateCmakeTemplateAnchor 删除/lines·cmake-locate 并入)、契约不变量、消费方与下一步;anchors 目录当前 7 文件;与 exe-map/README(02:16/02:19)记录对齐 |
| 2026-09-04 13:02 | 内容语义决策表建档(配置动作规格):把动作矩阵遗留从“机制已通、内容未定”收敛为逐格决策记录,含已拍板引用与待拍板池;下轮主线:msg/.srv/action 类型行反查真实依赖(②) |
| 2026-09-04 13:22 | 冻结为对外 API:新增 config/write/api.ts(纯 TS 出口:01 planConfigure/detectRole/stamp + 类型,02 validatePackageName/planRenameByFolder,anchors 命名空间),README 增「对外 API(冻结区)」;一键语义分析不再扩展,仅维护缺陷;write-api 冒烟 3 例;总盘 95 用例 |
