# build-tool/ — 包数据与构建服务

> 围绕"包"的两层:package-core(权威包数据中心,权威判定 src 侧包)+ package-service(用户服务层:构建/创建/运行/配置)。
> 公共目录遍历工具 `walk/` 供多方消费;历史目录 `packages/` 已整体废弃并于 2026-09-29 物理删除(git 历史可查)。

## 目录

| 目录 | 语义 |
|:--|:--|
| `package-core/` | **权威包数据中心**:package.xml 判定/扫描/缓存/事件时机(见 package-core/README.md) |
| `package-service/` | **包服务层**:构建域 build/、运行与启动域 run/、包创建域 create/、配置域 config/(gen 活跃)、共享层 share/(见 package-service/README.md) |
| `walk/` | 公共目录搜索(双超时/排除/符号跟随,读 `ROS2.search.*` 设置;见 walk/README.md) |

> 历史:`packages/`(2026-08-28 起被 package-core 语义收编的旧实现,整目录注释墓碑)于 2026-09-29 按零引用清理口径物理删除(提交 8afde4a)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):一层导航;补记 packages/ 墓碑物理删除 |
