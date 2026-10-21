# share/ — 可共享层(命令参数模板机制 + 工作区状态/记忆)

> 定位:`package-service` 的**共享层** —— 与具体命令/业务域无关、可被多处复用的东西都放这里。
> 目前两类:① **命令参数模板机制**(模板 + 预设 + 二级弹窗 + 展开);② **工作区状态文件层与两个记忆模块**。
> 2026-09-22:状态文件层与两个记忆模块按用户要求**统一收进本目录**(原 `state-write/` 目录取消、
> `build/build-memory.ts` 上移),这样"以后的命令也用同一份记忆文件"时只需认识 `share/` 一处。

## 一句话(参数机制)

一套**与具体命令无关**的机制——「**命令模板(存设置)+ 命名动态参数 + 预设参数表 + 二级弹窗**」,由扩展负责展开成真实命令行。
第一份消费者是 `colcon build`,同一份引擎/组件**原样可共享给 `ros2 run` / `ros2 launch` / `ros2 test` / 自定义命令**。

## 文件清单

| 文件 | 作用 |
|---|---|
| `设计-参数列表与命令模板.md` | 设计稿:占位符语义 / §2.2 命名动态参数清单 / 展开算法 / 二级弹窗 / 可共享性 / 边界 / 裁定结果 / 接线 |
| `types.ts` | `CommandSpec`(`template` / `custom` / `argv_list`)、**`ArgSlot`**(一个槽:单条 **或** 一组备选)、`ExpandInput`、`ExpandResult`(纯类型) |
| `expand.ts` | `expandCommand()` 五步展开(**同槽多选只应用"书写顺序第一条"**)+ `flattenArgList()` / `hasArgChoices()`(槽 → 平坦条目;每槽一条时 `index === slot-1`,老记忆兼容)+ `splitShellArgs()` shell 词法 + `quoteShellArg()` + `normalizeSpec()` + **`mergeSpec()`**(按"字段是否给出"合并 ⇒ 显式空数组/空串受尊重,预设可全删)(纯函数) |
| `pick-preset.ts` | 通用二级弹窗,**按 `presetPickPlan()` 三态**:模板无 `${0}` + 无预设 ⇒ **整个第二级不弹**;无预设但有 `${0}` ⇒ **直接跳手动输入框**;其余 ⇒ 多选列表(第 1 项 `自定义输入`;**同组备选全部列出**,`detail` 标注"→ 填入 `${k}`");**Esc 一律 = 取消**;spec 值的显示经 `factoryText()` 门卫(见下) |
| `presets-table.ts` | **预设键值表 ⇄ 内部形状双向适配**(2026-10-17 两拆分;2026-10-18 文法再收敛+查表区收缩):`parsePresetsTable()`(**裸键**(无分隔符)= 0 号——键 = `${0}` 输入框描述、值 = 框内占位提示(customHint,出厂随数据下发经 factoryText 可译),多裸键整组取首;`槽号\|描述`(≥1)= 槽位条目,同槽互斥组、缺号补空组;`\|` 转义在裸键形态下承重)+ `serializePresetsTable()`(反向,同步锁测试与文档示例同源)(纯函数,logger 回退 console) |
| `factory-l10n.ts` | **出厂文案显示本地化门卫**(2026-10-07 方案A+C):`factoryText(值)` = 值相等判定(与 5 条出厂常量逐字节相等才进翻译)+ `factory.*` ID 键查表 + 英文兜底——用户自定义值永不查册(接缝撞库缺陷根治);`factory.*` 键存活由 `scripts/i18n_audit.py` 从本表提取认定(7ee7ce4 曾因变量首参盲区把 5 条出厂键当死键清除) |
| `build/share-spec.ts`(域外接线层) | 读设置 → `mergeSpec` 合并出厂默认 → 装填动态参数 → 展开;**`expandColconBuildWithMemory()`** 供右键单包"不弹窗、直接套用记忆" |
| `selection-memory.ts` | **通用选择记忆**(按**命令 id** 分槽):只记"选择"——勾了哪几条预设 + **自定义输入的完整原文**;存储复用扩展私有存储内的状态文件,`{ "selectionMemory": { "colcon.build": { picked, custom } } }`;`ros2 run` / `ros2 launch` 可直接复用 |
| `build-memory.ts` | **包选择记忆**(仅 build 域使用):上次勾选的包 + 全部包快照(用于"新出现的包默认勾选");文件级读写交给 `state-file.ts` |
| `state-file.ts` | **状态文件层**:**扩展私有存储**(`context.storageUri`,2026-10-21 起转入地下,不再落工作区 `.vscode/`)内状态文件的**唯一读写入口**(单写者队列 + 原子覆盖;不提供整文件覆盖式 write;组合根 `setStateStorageRoot()` 装配 + `migrateLegacyStateFile()` 一次性迁移旧 `.vscode/` 文件) |
| `defaults/colcon-build.ts` | `COLCON_BUILD_COMMAND_ID`(`"colcon.build"`,记忆分槽键)+ `COLCON_BUILD_PRESETS`(2 条 = 详细输出两半)+ `axesFromArgv()` + `COLCON_BUILD_SPEC` 出厂模板 + `colconBuildDynamics()`(5 个动态参数);普通输出时与今天 `toColconBuild` 命令**逐字节等价** |
| `defaults/ros2-run.ts` | `ros2 run` 出厂 spec(`ros2 run ${pkg} ${executable} ${0}`)+ dynamics(`pkg`/`executable`)+ 记忆键 `ros2.run::<pkg>/<exe>`(纯函数;与 package.json default 同步锁) |
| `defaults/ros2-launch.ts` | `ros2 launch` 出厂 spec(`ros2 launch ${pkg} ${launch_file} ${0}`)+ dynamics(`pkg`/`launch_file`/`launch_path`)+ 记忆键 `ros2.launch::<源文件路径>`(纯函数;与 package.json default 同步锁) |

## 状态文件层(`state-file.ts`;2026-10-21 起落扩展私有存储)

> 为什么落盘而不用 `workspaceState`:后者在部分 remote / 无头环境下不可靠、不落盘。落点 = **扩展私有存储**(`context.storageUri`,按工作区隔离,用户在工作区里不可见)——2026-10-21 前写工作区 `.vscode/`(用户可直接查看与删除),现已「转入地下」;跨窗口 / 重连 / Reload 均能保留。activate 时 `setStateStorageRoot()` 装配 + `migrateLegacyStateFile()` 一次性迁移旧文件(新位置已有数据则跳过,旧文件保留)。

| 导出 | 语义 |
|:--|:--|
| `setStateStorageRoot(dir)` | 装配存储根(activate 一次;undefined = 清除,无头测试用) |
| `getStateFilePath()` | 状态文件路径(`<storageUri>/ros2-dev-extension-state.json`;未装配 = 空串) |
| `readStateFile()` | 读全文;未装配 / 不存在 / 损坏 / 顶层非对象 → `{}`(只读不排队) |
| `updateStateFile(mutate)` | **唯一写入口**:队列内"读 → 改 → 原子写";mutate 只应改自己拥有的字段;未装配 = 静默丢弃 |
| `migrateLegacyStateFile(workspaceRoot)` | 一次性迁移旧 `.vscode/ros2-dev-extension-state.json`(新位置已有 ⇒ 跳过且旧文件保留;成功 ⇒ 旧文件删除) |
| `StateFileData` | 顶层开放字典类型(字段名 → 各写者自有数据) |

**并发保证**:① **单写者队列**(per 状态文件路径的 Promise 链)杜绝 `A读→B读→A写→B写` 的字段互相覆盖;
② **原子覆盖**(同目录 `.tmp` + rename)避免"半截 JSON 被读取层判损坏 → 全部状态静默清零";
③ 失败降级(只记 debug;rename 不被远程 FS 支持时回退直写)。

**字段所有者表(新增字段务必登记,防跨写者撞键)**:

| 字段 | 所有者 | 说明 |
|:--|:--|:--|
| `selectionMemory` | `share/selection-memory.ts` | 通用选择记忆;字段内再按**命令 id** 分槽 ⇒ 多条命令不会互相覆盖 |
| `buildPackages` / `knownPackages` | `share/build-memory.ts` | 上次勾选的包 / 全部包快照 |

> 2026-09-22:`buildConfig` 与 build-memory 里的 `pickedPresets`/`customArgs` 随模板机制下线,旧文件残留字段无人再读。
> 2026-09-08:`includeBlacklist`(原 config/gen 的删除黑名单)机制已删,字段不再读写,残留无害。

**多写者纪律(2026-09-22 明确)**:每个写者必须 ① 只经 `updateStateFile`;② **只改自己拥有的键**(别人的字段原样留在 draft 里由本层写回);
③ 自己那一层再分槽时(如 `selectionMemory` 按命令 id),**在 mutate 回调内部**读旧值再合并(不要在锁外先读)。
**已知边界**:队列是**进程内**的 —— 同一工作区开多个窗口时,跨进程仍是"最后写者胜"(既有设计,非本次引入)。

## 依赖方向(设计意图)

```
设置(2026-10-17 两拆分:每命令两键,如 ROS2.build.template + ROS2.build.presets)
        │  读取(presets 键值表经 parsePresetsTable 归一 + mergeSpec 合并该命令的出厂默认)
        ▼
  share/  ←── 纯数据 + 纯函数 + 通用弹窗 + 记忆(与命令无关)
        │
        ├──▶ build/share-spec.ts             接线适配:读设置 + 装填动态参数 + 展开成 argv
        │        └──▶ build/smart-build.ts         二级弹窗(pickPresets)+ 命令展开 + 读写两份记忆
        │        └──▶ build/register-commands.ts   右键单包 Release/Debug 同走模板
        ├──▶ ros2/commands/ros_task_runner.ts **命令定义与执行层**:只收现成 argv/参数
        │       (ColconBuildOptions.argv;不认识模板、预设、记忆 —— 三者是"额外参数",不是命令定义)
        └──▶ (未来)run/launch 的「**参数层**」消费者:复用同一套模板/弹窗/记忆文件,
                而 ros2/commands 里的 run/launch **定义**保持只执行不变
```

> **分层口径(2026-09-22 用户澄清)**:**命令定义/执行**(`ros2/commands/ros_task_runner.ts`:colcon build、ros2 run、ros2 launch 的定义与执行)
> 与**额外参数**(模板 + 预设 + 二级弹窗 + 选择记忆)是**两层**。前者对谁都一样——只收现成参数;后者住在共享层,
> 由上层调用方按命令准备(读设置、装填动态参数、展开、记忆分槽)。所以"将来给 run/launch 用"指的是**参数层复用本目录**,
> 而不是让 `ros2/commands` 去 import 本目录(colcon build 今天也是同一个模式)。

调用方只需要交出两样东西:**自己的 spec** + **自己的命名动态参数**(如 `${packages_select}` / `${executable}` / `${launch_file}`)。

## 边界(改这里必须守住)

- **不绑定任何具体命令**:引擎里不出现 colcon / ros2 run / launch 的名字(示例与默认值除外,默认值放 `defaults/`);
  **预设与用户平级**:出厂预设只是设置的默认值,用户可以全部删掉 —— 引擎不认识任何具体预设;
- **模板 = 一段命令文本**(设置侧字符串,按空格与引号词法切分):顺序 / 位置(可放在 verb 之前)/ 重复 / 省略全由用户决定,甚至可换成别的命令 —— 引擎只做占位符替换,对命令名与参数顺序**没有任何假设**;
- **设置项(2026-10-17 两拆分,用户裁定"简化使用难度,设置页直改不进 settings.json";2026-10-18 文法再收敛)**:每命令两个平级键——
  `ROS2.<域>.template`(string,模板文本框)+ `ROS2.<域>.presets`(object 键值表,设置编辑器原生 Add Item 渲染)。
  presets 键文法:**裸键**(不含分隔符)= 0 号——键 = `${0}` 输入框描述、值 = 框内占位提示(**查表区= ${0} 行**:custom 与 customHint 经 factoryText 可译,槽位标签一律原样;出厂提示随 default 数据下发,空 = 无占位);
  `槽号|描述`(槽号 ≥1)= 槽位条目,同槽互斥组;`\|` 转义(裸键描述含竖线必须转义);`0|…` 显式写零按非法拒绝(只留一条正道);
  逐条容错详见 `presets-table.ts` 头注与双语 nls。**default 预存出厂形状**(presets default = 出厂 spec 经 `serializePresetsTable`
  的产物,与 `defaults/` 由同步锁用例锁定不漂移);旧三键 `shareSpec` 硬切换删除零迁移(孤儿键惰性无害);
  缺键仍按"是否给出"合并(template 缺 = 出厂模板、presets 缺 = 出厂预设、presets 空对象 = 显式无预设);
  **已接线**:扩展发起的 colcon build / ros2 run / ros2 launch 都按它展开,改这项立即生效;
- **只有 `pick-preset.ts`、`factory-l10n.ts` 与 `state-file.ts` 依赖 vscode**(后两者仅 `l10n.t` 日志/文案);`types.ts` / `expand.ts` / `defaults/` / `selection-memory.ts` / `build-memory.ts` 均**零 vscode**(记忆与状态层可直接无头单测,存储根经 `setStateStorageRoot` 注入);
- **记忆只记"选择"**:预设下标 + 自定义输入原文(不 trim、不截断);**不记**命令内容/包列表以外的推导结果;
- **不猜、不校验**:不校验用户参数是否合法、不修正用户写法、**不检查多选是否互相矛盾**(机制只保证"替换正确、预设正确",矛盾交给 colcon 报错);
- **不转义**:展开结果按 **shell 词法**切分成 argv(引号语义保留);用户的设置与手输等价于自己敲终端,扩展不额外加壳;
- 未知占位符(`${x}` 不在约定集合内)**原样保留 + 记日志**,不静默吞掉。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-21 | **出厂模板去 event-handlers 字面量 + 选项 2 改整段旗标 + 出厂预设条目级严格判定(用户定版)**:①`COLCON_BUILD_SPEC.template` 删 `${2}` 前字面量 `--event-handlers console_cohesion+`(不勾 2 号 = 命令里完全没有该旗标),2 号预设 argv 改**整段** `--event-handlers console_cohesion+`、describe 改 "Verbose output 2/2: cohesive console event output"(manifest default 与 zh 册键 `presetLogCommand`→`presetConsoleCohesion` 同步换代);②**presetLabel 升格条目级判定**(用户裁定"Key 逐字段匹配 value 也是如此,0 匹配 0、1 匹配 1"):条目是出厂 ⟺ 出厂规格**同一槽位**存在 argv 与 describe **都逐字节相等**的备选——任一字段细微修改/槽位错放/用户新增 ⇒ 用户配置原样显示(修 0.0.4 测试"只改 Value 仍显中文"案);`PickPresetOptions.factory` 新字段穿线,三调用方各传出厂常量;0 号位标量门卫不变 |
| 2026-10-18(三) | **run/launch 键族迁 tool 层(用户裁定:呈现 = ROS2 › Tool › Run/Launch)**:设置键 `ROS2.run.*`→`ROS2.tool.run.*`、`ROS2.launch.*`→`ROS2.tool.launch.*`(8 键改名,doctor/rosdep 挂 `tool.` 直下,硬切换旧键惰性);出厂 spec/mergeSpec/expand 引擎零改动,接线层键常量与三套件播种随改;manifest 双语 nls/docs 同步 |
| 2026-10-18(二) | **查表区收缩为 ${0} 行 + 占位提示接入查表(用户裁定两连确认)**:①槽位标签(`N\|描述`,N≥1)**退出查表**——makePresetItems 标签处 factoryText 调用删除,`1\|<0号照抄>` 不再显示中文,原 presetDebugLog/presetLogCommand 两条出厂条目与 bundle 键一并退役;②0 号的**值(占位提示)接入查表**——三条调用方硬编码示例升格为出厂数据(defaults 三 spec 增 customHint,manifest 裸键 value 下发,同步锁扩展"裸键 value === factorySpec.customHint"),factory-l10n 池 +3 customHint,pick-preset 两处 placeHolder = factoryText(spec.customHint),`PickOptions.customPlaceholder` 字段删除(升格=移动不复制),空 = 无占位;出厂 customHint 语义修正:mergeSpec 回落链生效(用户删裸键 ⇒ 回出厂提示,非无提示)。测试:factory-l10n 套件重构(6 常量+标签不译钉+提示 zh 查表)+占位符接线用例随新语义 |
| 2026-10-18 | **文法再收敛(用户裁定)**:①去 `0\|` 前缀——**裸键(不含分隔符)= 0 号**,键 = `${0}` 输入框描述;0 号的 value 从"丢弃"改"**输入框占位提示**"(非空覆盖调用方硬编码示例,空回落;`CommandSpec` 增可选 `customHint`,mergeSpec 同口径采纳,显示层 pick-preset 两处 `placeHolder` 接线);槽号校验收紧 `^[1-9][0-9]*$`(与引擎 `${1}..${n}` 正则同款),`0\|…` 显式写零按非法拒绝;②转义规则**保留**(用户裁定"取巧不优雅"——裸键形态下转义真实承重:裸键描述含竖线必须 `\|`,否则被误判槽位条目);serialize 的 custom 改产裸键;测试随改(presets-table 套件 10 例 + pick-preset 占位符优先级 1 例) |
| 2026-10-17 | **两拆分(用户裁定"简化使用难度,设置页直改不进 settings.json")**:三 `shareSpec` 嵌套对象键(argv_list 还要数组套数组,设置编辑器只能进 JSON)→ 每域两平级键 `ROS2.<域>.template`(string 文本框)+ `ROS2.<域>.presets`(object 键值表,原生 Add Item 渲染)。文法:key=`槽号|描述`(首个未转义 `\|` 分隔,`\|`=字面竖线沿用 userIndex 惯例)、value=参数串;槽 0 = `${0}` 描述载体取描述弃 value 多 0 取首;同槽互斥组;槽号显式化顺带修旧数组下标"中间插预设整体移位"缺陷;缺号补空组。新增 `presets-table.ts` 双向适配(parse/serialize 纯函数),适配层改读新两键后仍走 `mergeSpec` 全部回落语义零改动;defaults/factory-l10n/pick-preset/分槽记忆零改动;同步锁升级为"presets default = serialize(出厂 spec) 深相等 + 往返";旧键硬切换零迁移;错误文案三处字面键名换新;顺带修正 share-spec.test.ts "两轴"陈旧断言(与 09-29 三值化政策矛盾,集成宿主播种失效下假绿)。测试 +9(presets-table 套件) |
| 2026-10-07 | **拆除数组兼容层(用户裁定:未分发无存量,不为兼容留代码)**:删 `templateText()`(数组 join 归一,唯一消费者=兼容自身),`usesCustomPlaceholder` 收窄 `(template: string)`,`CommandSpec.template` 收窄为 `string`,mergeSpec/normalizeSpec 非字符串(含数组写法)一律视为未给回落出厂默认;测试改造(删 templateText/双形态等价套件,join 锁改出厂文本直锁,mergeSpec 数组用例翻为回落默认);边界行/defaults 头注/设计档 §2.1 同步去兼容表述 |
| 2026-10-07 | **设置侧 template 表示改回字符串(用户拍板"字符串才方便用户修改,数组显示无消费者")**:三 shareSpec 的 manifest `default.template` 与 `properties.template.type`("array"+items → "string",设置编辑器渲染为文本框)、`defaults/*.ts` 出厂模板、双语 nls 描述与示例同步改写;引擎零改动(09-28 起双形态经 `templateText()` 逐字节等价,存量数组设置照常工作);join 逐字节锁用例自然升级为出厂文本本体锁;类型联合保留不收窄 |
| 2026-10-07 | **出厂文案显示本地化门卫(i18n 方案A+C,用户拍板)**:新增 `factory-l10n.ts`——`custom`/`describe` 是用户可编辑设置值,cdf29de 的"整值查册"有接缝撞库缺陷(用户值撞上册内任意键会被静默翻译显示),且对账工具只认字面量首参 ⇒ 7ee7ce4 死键清账把 5 条出厂键误删,zh-cn 出厂描述退回英文(用户截图实证);修=pick-preset 四处渲染点(自定义项 description/预设 label/两处 prompt)改走 `factoryText()`:值相等门卫(仅出厂常量进翻译)+ `factory.*` ID 键查表(册补 5 条,译文自 cdf29de 恢复)+ 查册返回键名时回落出厂英文(en/无头口径不变);`i18n_audit.py` 增 factory 表源提取防再清;新增 `factory-l10n.test.ts` 5 例(撞库回归用模拟 zh 册锁定 `Copied` 不被翻译);全套 1331 用例 0 失败,册 1440→1445 键 |
| 2026-09-29 | 文档补登:①文件表补 `defaults/ros2-run.ts` / `defaults/ros2-launch.ts` 两行(2026-09-25 建域时漏列,仅记录行提及);②补登 2026-09-28(批次3)——设置键归位:`ROS2.colcon.build.shareSpec`→`ROS2.build.shareSpec`、`ROS2.ros2.run|launch.shareSpec`→`ROS2.run|launch.shareSpec`(正文已随批改键,历史记录行按惯例保留旧键名) |
| 2026-09-28 15:47 | **模板词数组化 + 预存默认(设置优化批次 2)**:template 改命令词数组(引擎 join 归一,兼容裸字符串,自由度不变);三 shareSpec 的 default 预存整份出厂 spec(面板直接可见可改);同步锁 + join 逐字节锁定等 8 例单测 |
| 2026-09-22 | **单包构建吃记忆 + 去兼容包袱**:新增 `expandColconBuildWithMemory()`(右键单包**不弹窗**,直接套用 `selection-memory`;记忆为空 ⇒ 等价于用模板);ros2/ 的 `toColconBuildCommand` 与其单测删除、`ColconBuildOptions` 收成 `{ base_path, argv(必填), packages? }`(无回退路径);同类清理:`stderrText` 兼容字段、monitor-api 的测试用 re-export、preflightWarnings 旧布尔兼容、只剩注释的 `api/ros-terminal.ts`;**222 例全过** |
| 2026-09-22 | **槽内多条备选("组")**:`argv_list` 元素可为**一组备选**共享同一个槽(`[ {…}, {…} ]`);弹窗全部列出并标注填哪个槽;引擎按"**同组多选只应用书写顺序第一条**"展开(一组最多生效一条);空组占位不错位;新增"组"专项单测 11 例 |
| 2026-09-22 | **共享层收拢(用户要求"把这一部分提升出来,放到共享")**:`state-write/state-file.ts` 与 `build/build-memory.ts` **上移进 `share/`**(`state-write/` 子域取消,其 README 并入本 README);新增**通用选择记忆** `selection-memory.ts`(按命令 id 分槽,只记选择 + 自定义输入完整原文);新增「多写者纪律」与字段所有者表;新增 `test/suite/selection-memory.test.ts` 与「多写者共存」3 例;**零 vscode、可全无头** |
| 2026-09-22 | **接线完成**:build 域新增 `share-spec.ts`(读设置 `ROS2.colcon.build.shareSpec` → 与出厂默认按"字段是否给出"合并 → 装填 5 个动态参数 → 展开);`smart-build.ts` 二级弹窗换成 `pickPresets`;`register-commands.ts` 右键单包(Release/Debug)同走模板;`ros2/api` 增 `argv` 直通;原 `makeConfigItems`/`pickBuildConfig` 删除 |
| 2026-09-22 | **Esc 语义统一(用户口径"Esc 都是取消")**:list 分支里自定义输入框 Esc 也返回 `undefined`(取消整个流程),不再"放弃自定义、其余勾选照用"⇒ 三种形态 Esc 语义一致;唯一不取消路径是**输入框空串回车** |
| 2026-09-22 | **两轴回归变量 + 预设改为详细输出两半**:删除 4 条安装交叉预设与 `seedIndexForAxes()`;新增**由设置接管**的 `${install_method}` / `${install_layout}`(Windows 保护与前瞻检查入参问题同时消失);删除 `${log_level}`,详细输出改为预设 `${1}` = `--log-level debug`、`${2}` = `log_command+`(与字面量 `--event-handlers console_cohesion+` 合成);默认模板删除 `${0}`(功能保留) |
| 2026-09-22 | **变量收缩 + 预设降为种子**:变量 = `${base_path}` `${packages_select}` `${clean}`(后经上一条再调整为 5 个);槽名 = 序号本身 `${1}..${n}`;预设去掉元数据(重排/增删不影响逻辑) |
| 2026-09-22 | **"极其开放"落实**:默认模板改为**一段自由文本**(顺序/位置/重复/省略全自由,可换命令);**设置项 `ROS2.colcon.build.shareSpec` 登记进 `package.json`** |
| 2026-09-22 | **二级弹窗三态(预设与用户平级)**:新增 `presetPickPlan()` —— 模板无 `${0}` + 预设被删干净 ⇒ **完全不弹第二级**;无预设但有 `${0}` ⇒ **直接跳手动输入框**;其余 ⇒ 多选列表;`_vscode-stub.ts` 扩为队列驱动的 window harness |
| 2026-09-22 | **裁定 + 引擎落地**:四项裁定(多选 / 全部并入模板与预设 / 整份存设置 / 自定义输入允许多段);落 `types.ts` / `expand.ts` / `pick-preset.ts` / `defaults/colcon-build.ts` + 单测(含与今天命令的逐字节等价性锁定);VM 实测两条约束(`--log-level` 必须在 verb 之前、重复 `nargs='*'` 参数安全) |
| 2026-09-22 | **建档 + 口径订正**:`share/` = **可共享给 run/launch 等命令**的通用「命令模板 + 预设参数 + 二级弹窗」机制(不是 colcon 专属) |
| 2026-09-25 | **run/launch 落地(第二、三位消费者)**:`defaults/ros2-run.ts` / `defaults/ros2-launch.ts`(出厂 spec + dynamics + 记忆键);记忆**按目标分槽**(`ros2.run::<pkg>/<exe>`、`ros2.launch::<源文件路径>`,经 selection-memory 的透明键实现,引擎零改动);弹窗/展开/状态文件原样复用 |
| 2026-08-31 23:55 | (并入本目录的)状态文件层建档:原 `build/state-file.ts` 上提为通用层,补单写者队列 + 原子覆盖,唯一写入口 `updateStateFile`;build 侧只留字段访问器 |
