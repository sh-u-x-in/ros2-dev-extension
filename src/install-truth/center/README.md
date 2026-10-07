# center/ — 第 2 层:数据中心(有状态)

> **层级定位**:build-only 真值域的**唯一有状态层**。把 `scan/` 的无状态结果攒成一份**快照**,
> 并对外提供"就绪 / 变化 / 失效"三种生命周期能力。
>
> **为什么单独一层**:真值域数据来自**编译产物**,与 package-core 的 src 域天然不同步;
> 必须能整体失效、能原子替换、能在重建期间继续服务旧值 —— 这些是状态问题,不是解析问题。

## 文件

| 文件 | 职责 |
|:--|:--|
| `build-map-center.ts` | `BuildMapCenter`(数据中心)+ `buildBuildMapSnapshot`(一次性无状态构建)+ `fingerprintOfSnapshot`(内容指纹;**含安装落点与路径类字段**)+ `packageFingerprints`(逐包指纹)与 `onPackagesChanged`(包级差分)+ `refreshAfterBuildSignal`(**rc-mtime 增量门**,2026-09-30 构建事件化) |
| `query.ts` | **消费方数据结构**:扁平索引(`pkg/name`→条目、包→名字、全部名字、源→归属、**安装侧路径 →条目**)+ 统一裁决 `lookupExecutable`(四态)+ **`lookupByPath`(按路径,第五态 `path-unknown`)** + `ExecIndexCache` + `ExecutableResolver`(launch/调试门面,含 **`resolveByPath`**);**侧边栏门面(2026-09-21 起)**:SidebarRow/rowsOf/sidebarSnapshot/sidebarView/packageView(五展示区行模型 + sourceRef 源引用,2026-09-26 起) |
| `shared-center.ts` | **按工作区根共享**的 BuildMapCenter 单例(2026-09-24,vscode 依赖故不进 api 桶):侧边栏与测试 runner 共用一份中心(此前各 new 一份,双扫描双缓存)。2026-09-30 **去 watcher 化**:失效源改为环境域构建信号主动刷新(旧 9 组 build 产物 watcher + trigger.ts 整体退役,见 `手工重设计/13`) |

## 契约(消费方只需记这五条)

| 能力 | 语义 |
|:--|:--|
| `getState()` | `null` = **未就绪**(首次构建未完成);快照 = 已就绪(空包表也可区分) |
| `onDidChange(ev)` | **首次就绪通知一次** + **内容指纹变化**才通知(核心值未变不打扰下游) |
| `refresh(reason)` | 单飞 + 合并:重建进行中再调用 → 标脏,链尾以最新状态补刷一次 |
| `invalidate(reason)` | 只标脏,**失效源(2026-09-30 起)**:构建信号主动 `refreshAfterBuildSignal()`、手动刷新、换根重建(build/** watcher 已退役) |
| `refreshAfterBuildSignal()` | 构建信号入口(幂等 = 单飞+合并):未就绪全量首扫;就绪后 **rc-mtime 增量门** —— 逐包 stat `colcon_build.rc` 对比扫描记账,只重扫重写的包;零变化快速路;实测单包构建 ≈69ms 收敛(13 号设计 §3.2) |
| `onPackagesChanged(names)` | **包级差分**(逐包指纹对比,新增/变更/删除非空才发;首扫不发)—— 语义"包真的变了",喂测试域按包重发现(取代旧 onBuildTouch) |
| `getLastError()` | 构建失败 → **保留上次好快照** + 记录原因;订阅方异常不影响数据中心 |

**双缓冲**:先构建 next 再原子替换,替换后才发事件 → 全程无"映射真空期"。
**逐包容错**:单包解析异常只记 warning,不污染其它包。

## 接线层职责(本层不含 vscode / watcher / 定时器)

1. 建 `BuildMapCenter({ workspaceRoot })`(必要时注入 fs / clock / builder);
2. (2026-09-30 构建事件化)订阅环境域 `onBuildSignal` → `refreshAfterBuildSignal()`;watcher/定时器不再由接线层挂;
3. 退出时 `dispose()`(shared-center 由 `extension.deactivate` 统一释放)。

## 修改记录

| 时间 | 说明 |
|:--|:--|
| 2026-09-30 | **构建事件化**:文件表去 trigger.ts(整文件退役,零引用清理);build-map-center 增逐包指纹/包级差分/rc-mtime 增量门;契约表失效源改"构建信号/手动/换根",新增 `refreshAfterBuildSignal` 与 `onPackagesChanged` 两行;shared-center 去 watcher 化。依据 `手工重设计/13`;验证与数字见主 README 2026-09-30 行 |
| 2026-09-29 | 文档补登(2026-09-21 后欠账):①新增 **shared-center.ts**(2026-09-24 dfcd829,B15 接电:共享单例 + watcher 接电,文件表已入);②query.ts 补侧边栏门面行(SidebarRow/rowsOf/sidebarSnapshot/sidebarView/packageView + sourceRef);③trigger.ts 补接电后"只置脏 + 按包刷新广播"语义;细则见 install-truth/README.md 修改记录侧边栏七批各行 |
| 2026-09-13 22:22 | 建档(分层重构配套):`center.ts` 迁入 `center/exec-map-center.ts` |
| 2026-09-13 23:52 | **新增 `query.ts`(消费方数据结构)与 `trigger.ts`(事件触发)**;接线建议:`ExecutableResolver` 给 launch/诊断,`BuildMapTrigger` 由 VS Code 适配层喂 watcher/任务事件(本层仍不含 vscode) |
| 2026-09-13 23:59 | **语义按用户裁定收紧**:① `ensureFresh()` = 见脏即刷(默认不节流),未就绪首次查询即自动构建;② `trigger` 文件事件**只置脏**(不再防抖/轮询),仅结束信号合并 150ms 后刷新;③ colcon 日志**不作为结束依据**(实测 `--log-base /dev/null` 可完全屏蔽) |
| 2026-09-13 23:05 | **build-only 裁切**:`exec-map-center.ts` → `build-map-center.ts`;快照字段改为 `{workspaceRoot, buildRoot, srcRoot?, packages, jumps, warnings, …}`;查询口改为 `jumpsOf`/`find`;失效源改为 `build/**` + 构建结束;契约(单飞/双缓冲/指纹/null 就绪/容错)不变 |
| 2026-09-14 (P0) | **按安装侧路径反查(调试侧运行期入口)**:`ExecIndex` 增 `byInstallPath`(键经 `normalizeInstallKey`:反斜杠/折叠/尾斜杠/Windows 盘符小写;来源 = `installPaths` ∪ `buildPath`,一条路径可多归属并排序取主);新增 `lookupByPath`(未命中 → 新状态 **`path-unknown`**,与"未就绪 → null"严格区分);`ExecutableResolver` 增 `resolveByPath()`;`fingerprintOfSnapshot` 补入 `installed`/`installPath`/`installPaths`/`buildPath`/`compilePaths`/`compilePathsExistLocally`/`pythonInstall`(**此前这些字段变化不会触发事件,是消费方可见的漏发**) |
