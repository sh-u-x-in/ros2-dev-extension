# walk/ — 公共目录搜索层

> 跨域公共工具:统一出口(超时遍历 + 选项 + 排除 + 超时配置),多方消费(package-core/scan、
> rosmsg 工作区扫描、xacro 兜底等),**不收编进任何一方**(scan/README 惯例)。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `index.ts` | 30 | 统一出口:walkWithTimeout / walkOptions / 排除工具 / 超时配置 re-export |
| `walk-options.ts` | 58 | 二次封装:读 `ROS2.search.followSymlinks` / `ROS2.search.walkTimeouts` + 默认排除叠加;**本层唯一 vscode 依赖点** |

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):结构自 index.ts 头注与 scan/README 注独立成档;base/ 见 base/README.md |
