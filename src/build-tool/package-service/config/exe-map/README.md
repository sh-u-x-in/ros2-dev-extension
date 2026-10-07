# exe-map/ — 可执行映射域(读侧中心,解析归属)

> **⚡ 断电(2026-09-04)**:config 除 gen 外断电。exe-map 的消费方(write 01/02 编排)随 write 一并退役,onDidChange/onNameMismatch 出口零订阅且未来消费方(03 一键启动/补全)已消失——消费者没了,生产者也不必存在。本目录**留档不参与编译**(tsconfig exclude),内容仅供历史参考,不再接线。
> **🔌 再评估一(2026-09-04 17:46,用户):维持断电。** 起因:launch 可执行跳转是否值得做 → exe-map 是否通电重议。结论:launch 可执行感知整体延后(名级 hover 可不依赖本目录;跳文件若做需本目录读侧通电),待真实使用痛点出现再启动;复核与三步路线见 languages/launch/README「待决」章节(2026-09-04 17:46)。
> **🔌 再评估二(2026-09-05 09:11,用户):维持断电,理由补强。** 盲点复核:launch 可执行跳转的真值源 = **install 安装树**(prefix/lib/<pkg> fs 扫描,该实现细节后被 17:33 再评估三改为统一 CLI 查询),与配置解析(setup.py/CMakeLists 声明="意图")彻底解耦——跳文件**永远不需要本目录通电**,exe-map 的不可替代消费方仅"意图读写"类(write),仍不存在;17:46 三步路线中"② exe-map 读侧通电做工作区跳文件"系误判,已作废。详见 languages/launch/README「待决」再评估二(2026-09-05 09:11)。
> **🔌 再评估三(2026-09-05 17:33,用户):维持断电,结论终态。** launch 可执行取数改走**统一 CLI 查询**(ros2 pkg executables + pkg_prefix,运行时参考实现),不扫目录、不做布局推断、不区分工作区/系统——可执行真值属"环境/安装树"坐标系,归 languages/shared PackageMap(缓存查询门面),**与本目录(源码配置解析域)永久无关**;本目录仅服务"意图读写"(write),仍无消费者。详见 languages/launch/README「待决」再评估三。
> **🔌 再评估四(2026-09-05 17:47,用户):维持断电,终档。** launch 可执行跳源设计(名单=官方 walk+X_OK、C++ link.txt/.d 链、python 壳链)经知识/两册手册定稿后**落盘不执行**(边缘效应过重,价值转向列表级补全);零 CMakeLists/setup.py 解析成立——本目录(源码配置解析域)与 launch 可执行能力彻底无关,维持断电留档。详见 languages/launch/README「待决」再评估四。

package-service/config 读侧模块之一(exe-map + gen + write)。
2026-09-03 目录收敛:原 derive/(中心/触发器/类型) 与 parse/(解析器) 归并为 **exe-map/** 单一归属,
parse 保留为子目录 exe-map/parse/。
定位:围绕「包的构建配置与可执行」的 **读侧中心域**——消费 package-core 门面的参与构建名单,
同目录读 setup.py / CMakeLists.txt,按 buildType 分派 parse 解析器,维护
「package.xml name → 可执行入口」内存映射,供 03 一键启动 / 补全 / 02 重命名等下游读取。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| types.ts | 共享类型:ExecutableEntry / PackageExecutables / NameMismatchEvent(「读/写/用」三兄弟共用) | 纯类型 |
| executable-map.ts | 中心节点:可执行映射(数据进 / API 出见下) | package-core/api 类型(门面)、exe-map/parse/ |
| event-collector.ts | 触发器:监听 **/{setup.py,CMakeLists.txt} → 真包过滤 → 800ms 去抖 → updatePackage(dir) | vscode、executable-map |
| parse/setup-parser.ts | setup.py 解析(v5:静态 + 安全展开动态 + 指纹)——供 executable-map 按 buildType 分派 | fs/path(纯 TS) |
| parse/cmake-parser.ts | CMakeLists 聚焦提取(命令扫描器 + 变量表 + dynamic 标记)——同上 | 纯 TS |

## 数据进(输入端口)

```
① package-core 门面 PackageFacadeApi(extension 传 packageCore.ui)
   ├─ getState().unignored ──► 收录名单(「参与构建最佳名单」,条目 {name,dir,buildType})
   └─ onDidChange ── ev.unignored 变化时调度全量重建
      (域签名含 buildType:名单增删 / ignore 翻转 / 类型就绪 / 类型翻转都会发——上游 D1/D2/D4)
② 磁盘构建文件 ── ExecutableMapFs.readText(dir/setup.py|CMakeLists.txt)(默认 node fs,可注入 mock)
③ 触发器事件 ── event-collector(vscode watcher) → isPackageDir 过滤 → updatePackage(dir) 单包增量
```

上游语义承诺(2026-09-02 出口简化后,本模块不再自算):
- unignored 域 = colcon 权威 / walk 兜底;条目**类型就绪才发布**(undefined 不出现);
- null = 域未刷新 → refresh/updatePackage 空操作等事件;colcon 失败不置 ready → 域保持 walk 兜底。

## API 出(对外接口面)

**查询(同步)**:get(name)(未就绪/无包 → undefined)/ **getAll() → ReadonlyMap | null**(null = 未就绪,Map(可能空)= 已就绪——与 core 5 域 null 契约同构)/ executablesOf(name)(未就绪/无包 → [])/ isPackageDir(dir)(域成员判定;域 null 时本地 package.xml+COLCON_IGNORE 探针)。
**事件出口**(订阅返回取消函数):
- onDidChange({ map }) — 映射整体替换后发(map 为完整新视图,读旧值期间不通知);
- onNameMismatch(NameMismatchEvent) — 三方名不一致(目录名/package.xml/配置内名)只出口。
**命令/生命周期**:refresh()(显式全量,单飞合并语义)/ updatePackage(dir)(增量;全量在跑时并入链尾)/ dispose()。

## 内部处理链(一次全量/增量)

```
unignored 域条目 → buildForEntry 按 buildType 分派:
  ament_python → readText(setup.py) → parseSetupPy → consoleScripts{kind:consoleScript}
  ament_cmake/cmake → readText(CMakeLists.txt) → parseCMakeLists → cmakeTarget(dynamic 标记)
                     + ament_export_executables 补充登记{kind:exportExecutable}
  → checkNameMismatch(目录名/package.xml/声明名)→ 不一致 fire onNameMismatch
  → 逐包 try/catch(单包失败仅跳过)→ map.set / removeByDir(覆盖 name 变化)→ 通知
```

## 并发与通知治理(2026-09-02)

- **双缓冲**:全量重建先构建 next 再原子替换——重建期间 get 读到旧值,替换后才 fireChanged,**无 map 真空期**;
- **单飞合并**:任一时刻最多一个重建链;进行中再来事件 → 标脏,链尾以最新状态补刷(串行,无并发无乱序覆盖);
- **no-op 抑制**:重建/增量后内容与现 map 相同 → 不替换不通知(computeFingerprint 指纹比对);
- **null 就绪契约**(2026-09-02 实施):getAll() 未就绪返回 null,就绪返回 Map(可能空)——首次就绪(含空)
  是一次 null→Map 变化 → 通知一次(「就绪宣布」),下游无需 everBuilt 特判即可区分「已就绪但无包」与「未就绪」;
- updatePackage 在全量在跑 **或 map 未就绪(首建前)** 时并入全量链,避免「半就绪视图」。

## 接线与消费方状态

- **已接线**(2026-09-02):extension.ts 实例化 ExecutableMap(packageCore.ui)+ ExecutableChangeCollector;
  extension.executableMap 模块级导出供未来消费方取读侧数据(05 交接文档任务 6);
- **出口零订阅**:onDidChange(03 一键启动/补全数据源)、onNameMismatch(02 重命名入口)均留位待接;
- 测试:test/suite/executable-map.test.ts(6 用例:null 就绪契约/双缓冲读旧值/单飞合并/no-op/增量并入链尾/首建前 updatePackage,无头可跑)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-02 18:13 | 建档:derive/ 目录 README(文件清单/数据进/API 出/处理链/并发治理/接线状态) |
| 2026-09-02 18:22 | 实施 map 视图 null 就绪契约:getAll() 未就绪返回 null、就绪返回 Map(可能空);首次就绪(含空)= null→Map 变化 → 通知一次(就绪宣布),everBuilt 特判退场;updatePackage 在 map 未就绪(首建前)时并入全量链;单测扩至 6 用例 |
| 2026-09-03 14:04 | 目录收敛:derive/ + parse/ 归并为 exe-map/(parse 保留为 exe-map/parse 子目录),本 README 由 derive/ 迁入并更名;引用(exe-map/executable-map.ts 内 ./parse/…、extension、测试)已同步;语义与测试不变 |
| 2026-09-04 02:16 | setup-parser 解析能力补强(不拖后腿):模块级容器变量(多行容器与类型注解)入值表,setup() 标识符实参按字面量继续解析(data_files/install_requires/entry_points 变量引用形态出数据);仅模块级(深度0)行收集,setup() 调用体内 kwarg 不再污染变量表;识别加法式 console_scripts 调用点写法(变量+索引+列表加法),基础与新增合并去脏;新增 parser 单测(容器引用/加法式/内联回归);拷打 blank_py_nodes 高复杂度文件:consoleScripts 9 / installRequires 4 / dataFiles 6 / issues 0 |
| 2026-09-04 02:19 | cmake-parser parseInstall 分组加固(拷打补课):install(TARGETS …) 支持组件段关键字 RUNTIME/LIBRARY/ARCHIVE/OBJECTS/FRAMEWORK/BUNDLE/PRIVATE_HEADER/PUBLIC_HEADER/RESOURCE——段头不再混入 TARGETS 参数,各 DESTINATION 独立成组;DIRECTORY/FILES 选项关键字 FILES_MATCHING/PATTERN/REGEX/EXCLUDE/PERMISSIONS/COMPONENT/OPTIONAL/CONFIGURATIONS/TYPE/NAMELINK_COMPONENT 不再污染 DESTINATION 参数(如 *.yaml 归 PATTERN 组);段/选项关键字仅在有组起始后才生效;新增 test/suite/cmake-parser.test.ts(4 用例:多段 install/选项隔离/注释与大小写/function 动态冒烟);全量 compile+五套件 92 用例绿 |
| 2026-09-04 17:46 | 再评估终裁(用户):**维持断电**——launch 可执行跳转议题复核后整体延后,本目录不恢复编译/接线;复核结论与未来三步路线见 languages/launch/README「待决」章节(2026-09-04 17:46);本页头注同步 🔌 |
| 2026-09-05 09:11 | 再评估二(用户):**维持断电,理由补强**——launch 可执行跳转真值源 = install 安装树(fs 扫描 prefix/lib/<pkg>),与配置解析彻底解耦,跳文件不需要本目录;17:46 三步路线中"② exe-map 通电做工作区跳文件"系误判已作废;本目录不可替代消费方仅"意图读写"类(write),仍不存在;详见 languages/launch/README「待决」再评估二;头注 🔌 同步 |
| 2026-09-05 17:33 | 再评估三(用户):**维持断电,结论终态**——launch 可执行取数改走统一 CLI 查询(ros2 pkg executables + pkg_prefix,运行时参考实现),不扫目录/不区分工作区系统;可执行真值归 languages/shared PackageMap 缓存查询门面,与本目录(源码配置解析域)永久无关;本目录仅服务"意图读写"(write),仍无消费者;详见 languages/launch/README「待决」再评估三;头注 🔌 同步 |
| 2026-09-05 17:47 | 再评估四(用户):**维持断电,终档**——launch 可执行跳源设计(名单=官方 walk+X_OK、C++ link.txt/.d 链、python 壳链)经知识/两册手册定稿后**落盘不执行**(边缘效应过重,价值转向列表级补全);零配置解析成立,本目录与 launch 可执行能力彻底无关;详见 languages/launch/README「待决」再评估四;头注 🔌 同步 |
