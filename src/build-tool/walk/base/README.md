# base/ — 目录遍历基座(纯 fs,零 vscode)

> walk/ 的实现底座:native 优先、TS 回退的双超时遍历 + 超时/深度 profile + 排除名单。
> 全部零 vscode 依赖、活代码,可无头测试。

## 文件

| 文件 | 行数 | 职责 |
|:--|:--|:--|
| `ts-walk.ts` | 177 | 纯 TS 双超时(分支/总)DFS:分支截断回溯、总超时中止 |
| `walk-utils.ts` | 152 | 转接层:native 优先(walk-native 模块)、失败降级 TS 实现 |
| `walk-config.ts` | 68 | 按搜索类型分组的超时/深度 profile(default/message/test/xacro/package) |
| `excluded-paths.ts` | 34 | 内置排除名单 + EXCLUDE_GLOB 单一来源 |
| `path-exclude.ts` | 57 | resolveExcludeFolders / isPathExcluded 纯 fs 工具(`ROS2.search.excludeFolders` 消费) |

## 关联

- 源码工程:`native/walk-native/`(Rust/napi-rs,产出 `native/*.node` 三平台二进制);验证脚本:`scripts/walk-verify/`;
- 设置:`ROS2.search.followSymlinks` / `walkTimeouts` / `excludeFolders`(walk/walk-options.ts 读)。

## 修改记录

| 时间(精确到分) | 说明 |
|---|---|
| 2026-09-29 | 建档(补各文件夹 README 批次):五文件职责自头注与 index.ts 出口注释独立成档 |
