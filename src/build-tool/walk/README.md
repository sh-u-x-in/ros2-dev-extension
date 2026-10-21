# walk/ — 公共目录搜索层

> 跨域公共工具:统一出口(超时遍历 + 选项 + 排除 + 超时配置),多方消费(package-core/scan、
> rosmsg 工作区扫描、xacro 兜底等),**不收编进任何一方**(scan/README 惯例)。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `index.ts` | 30 | 统一出口:walkWithTimeout / walkOptions / 排除工具 / 超时配置 re-export |
| `walk-options.ts` | 58 | 二次封装:读 `ROS2.search.followSymlinks` / `ROS2.search.walkTimeout.<type>.<field>`(2026-10-18 平铺批,12 键)+ 默认排除叠加 + `readWalkTimeoutConfig`(package-core 链共用);**本层唯一 vscode 依赖点** |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-10-18 | **平铺批**:①walk-config 删 `WalkTimeoutOverride` 与数组覆盖合并路径(getWalkTimeoutConfig 收敛单参,profiles 表保留作事实源+未知类型兜底,兼作 manifest 12 键 default 的同步锁锚);②readWalkTimeoutConfig 自 vscode-utils **迁入本文件**(12 键逐字段现读,total/branch 下限 1、depth 下限 0,非法回落内置;兑现"读设置仅此处一处"——package 链经 vscode-utils 读属漂移);③base/ts-walk 修**纯 TS 降级符号链接真 bug**(symlink 判定先于 isDirectory:链接 isDirectory 恒 false,原顺序使 followSymlinks=true 永不跟随;链接指文件时 readdir ENOTDIR 静默跳过);④package-core/compose 装配防御(walkTimeouts 缺省 {0,0,0} → getWalkTimeoutConfig("package"));另案:api/settings.ts 死镜像删除。测试:walk-config-sync(manifest↔profiles 同步锁+下限政策+死枚举不复活)/walk-options-read(回落与下限边界)/ts-walk-symlink(真值表;win32 建链失败守卫跳过) |
| 2026-09-29 | 建档(补各文件夹 README 批次):结构自 index.ts 头注与 scan/README 注独立成档;base/ 见 base/README.md |
