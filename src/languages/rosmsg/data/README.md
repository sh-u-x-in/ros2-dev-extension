# data/ — rosmsg 索引数据层(三张表 + 三来源)

> 消息索引的事实层:写线/读线分离的三张表 + 工作区/系统/内置三来源。域级总览见 `../README.md`(最详)。

## 文件(5 TS,1749 行)

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `message-index.ts` | 155 | 门面:组装 WorkspaceIndex + SystemIndex,统一查询/生命周期(findMessage/findBareNameDefinition/findMessageWithSystemPath) |
| `workspace-index.ts` | 545 | 工作区索引:写线 IndexWriter(正/反/包表)+ 读线 IndexReader;PackageSource 三来源(R1 快照/R2 就绪/R3 PackageMap 原子事件);.msg watcher 增量 + onDidRenameFiles 补盲;兜底重扫节流三规则 |
| `system-index.ts` | 322 | 系统索引:interface list 有序数组二分 + 惰性重建(ensureSystemFresh)+ 磁盘缓存 v5 + RM-1 触碰时整包 .msg 路径登记(pkgMsgFiles/pkgMsgDirs,按包单飞) |
| `tables.ts` | 661 | rosmsg-v3 三张表(正/反/包表)+ 四事件(消息增删/包增删)+ op 流(纯 TS,写线 → op → 读线) |
| `types.ts` | 69 | 常量(CACHE_VERSION=5 / WORKSPACE_CACHE_VERSION=4)与缓存格式纯函数 |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):五文件职责自头注与根 README §3 独立成档;无死代码 |
