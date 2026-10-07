# event/ — 时机引擎(何时刷新,不做取数)

package-core 的"节拍器":只决定"何时去取数"并发出原始事件,不决定"怎么重算"(那是 data/ 的事)。
2026-08-29 自 driver/ 改名(原名易误解为"驱动",实为事件源)。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `contracts.ts` | 契约:DriverEvent(workspace-package-changed / ignore-marker-changed,**带 `dirs: string[]`(2026-09-06)** / timer-tick)+ PackageFetcher 端口;op 折叠:create/modify/delete ≡ path-level changed | 无 |
| `timer.ts` | 定时器(默认 60s,强制刷新节奏的"时机权威";**2026-09-28 增 `setIntervalMs` 运行中重设周期:≤0 停用可再启动**,reconfigure 接线),纯 TS 可无头测试 | 无 |
| `fs-watcher.ts` | fs 监听(package.xml / COLCON_IGNORE)+ **workspace.onDidRenameFiles 补盲(2026-09-09:整目录移动/rename → 懒刷新触发源,秒级;文件级 create/delete 仍走 glob watcher)** + 去抖 + **路径聚合(带 dirs 下发)** + 廉价预过滤(监听范围限定工作区根);回调收 Uri → dir;可注入事件源(无头测) | vscode + contracts + batcher |
| `batcher.ts` | **去抖路径聚合(2026-09-06 新增,纯 TS 可无头测)**:窗口内按 kind × dir 去重聚合 → 单事件带 dirs | 无 |
| `index.ts` | 组装:createPackageFetcher(timer + fs-watcher → PackageFetcher) | contracts + timer + fs-watcher |

## 关键设计

- 只做"廉价预过滤"(该不该反应)+ **收集受影响目录**;权威校验归 scan/(数据层判定);
- 2026-09-09(文件服务层 rename 补盲):`workspace.onDidRenameFiles` 把 **Explorer 整目录拖拽/移动/F2** 转成
  同构原始事件(命中目录 / package.xml / COLCON_IGNORE)→ 懒刷新,目录移动延迟从 ≤30s(定时兜底)降至秒级;
  **终端 `mv` 无通知机制,无法即时,仍由定时权威重建兜底**(收敛结果一致,路径事实原则不受影响);
- 2026-09-06(§12.3):事件 = **path-level changed**,携带 `dirs`(去重,绝对路径);op 折叠(create/modify/delete 统一为"该路径派生状态需重推",判据永远是磁盘终态);聚合逻辑在 batcher.ts;
- 2026-08-28 删 source/(环境源):系统侧取数/环境事件归 ros2/,本目录只管工作区时机;
- data/ 订阅原始事件后决定刷新策略(2026-09-06 双通道路由:池事件 → 懒重建(只 walk);标记事件 → cache.applyMarkerSync 不重建;timer-tick → full 权威)。
  注:2026-09-04(系统/定时解耦)timer-tick 仅强制重建**工作区**——系统包列表刷新已拆出
  为 data.refreshSystem() 独立入口(装配方随 ros2/ env 变化触发),本目录事件不再携带系统刷新。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 补登 2026-09-28(83f7f82,批次4):DriverTimer 增 `setIntervalMs(ms)`——运行中重设周期(与当前值相同 = 空操作;≤0 停用、再设正值重新启动),event/index.ts 透传、compose.ts reconfigure 接线(详见 package-core/README.md 同日行);timer.ts 文件表同步 |
| 2026-09-09 00:08 | **文件服务层 rename 补盲(用户实测:整包移动无事件)**:fs-watcher 订阅 `vscode.workspace.onDidRenameFiles`——目录级移动/拖拽/F2 对 package.xml 内容型 watcher 不可见(此前只靠定时权威重建,≤30s);命中(目标为目录 / package.xml / COLCON_IGNORE)即转同构原始事件(workspace-package-changed / ignore-marker-changed)触发懒刷新,移动延迟降至秒级;单文件重命名不触发(stat 非目录跳过);终端 mv 无通知机制仍由定时兜底;廉价预过滤口径不变(数据层 isDirRelevant 丢弃范围外) |
| 2026-09-06 23:16 | **事件路径化(四项修复 §12.3)**:DriverEvent 两事件补 `dirs: string[]`(窗口内受影响目录,绝对路径去重;create/modify/delete **op 折叠**为 path-level changed);新增 `event/batcher.ts`(去抖 + 按 kind×dir 聚合,纯 TS 可无头测);fs-watcher 六路回调收 `Uri` → `dirname(fsPath)` 收集 dirs(不再抹平路径),新增事件源注入选项供无头测试;index 透传不变 |
| 2026-09-04 15:45 | 同步 timer-tick 语义注释:60s 只强制重建工作区,不携带系统刷新(系统刷新拆出 data.refreshSystem,装配方随 ros2/ env 变化触发) |
| 2026-08-30 18:42 | 创建 event/ README(文件清单/关键设计) |
| 2026-09-03 22:58 | 死代码复核同步(项目结尾):本目录无墓碑/过期注释,文件清单与当前代码核对一致(contracts/timer/fs-watcher/index 全活,数据订阅方 = data/index);详见 package-core/README.md 墓碑登记 |

<!-- 文件末尾修改时间:2026-09-29(补登 09-28 setIntervalMs,详见上表 2026-09-29 行) -->
